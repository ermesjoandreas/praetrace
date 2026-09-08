import type { FastifyInstance, FastifyReply } from 'fastify';
import type { GraphStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import {
  propose,
  tooBigToPropose,
  type AskCategory,
  type AskContext,
  type AskDeltaKind,
  type AskEdge,
  type ProposeContext,
  type ProposedGroup,
  type ProposeFailure,
  type ProposeFile,
} from '../project/ask.js';
import type { MergedGroups } from '../project/groups.js';
import { evidenceFor, fileLinks, type GroupEvidence } from '../view/cluster.js';
import { NO_FILTER } from '../view/filter.js';
import { selectView } from '../view/select.js';
import { isTestFile } from '../view/tests.js';
import type { ViewSpec } from '../view/types.js';
import type { AskConversation } from './session.js';

/**
 * What these routes need of a session, named here rather than as `Session` so
 * this module asks for exactly these and `app.ts` can hand it `host.current()`
 * — the same shape `overview.ts` takes for the same reason.
 */
export interface AskRouteSession {
  readonly root: string;
  readonly store: GraphStore;
  /** Nothing watches `.codemap/`, so the names are asked for on the way in. */
  refreshGroups(): Promise<void>;
  clustersOf(graph: Graph): MergedGroups;
  askConversation(): AskConversation | null;
  askRunning(): boolean;
  startAsk(
    question: string,
    context: AskContext,
    onDelta: (text: string, kind: AskDeltaKind) => void,
    onEnded: (conversation: AskConversation) => void,
  ): AskConversation | null;
  endAsk(): boolean;
}

/** The two frames these routes put on the socket. See `live.ts` for both. */
export interface AskHub {
  askChanged(conversation: AskConversation): void;
  askDelta(conversationId: string, text: string, kind: AskDeltaKind): void;
}

/**
 * A question is typed by a person, and the body is what becomes the prompt —
 * so an uncapped one is an uncapped bill. Long enough for a real paragraph of
 * a question and nowhere near long enough to matter against the categories.
 */
const MAX_QUESTION_CHARS = 2000;

/**
 * The component diagram's own spec: the whole project, no filter, the
 * categories as boxes.
 *
 * Scope and focus are ignored under `components` — a category is a fact about
 * the whole project — so this is the same picture whatever the page happens to
 * be looking at, which is the point: the model is told what the diagram draws
 * and not what one corner of it draws.
 */
const COMPONENT_SPEC: ViewSpec = {
  scope: '',
  focus: null,
  depth: 1,
  filter: NO_FILTER,
  at: null,
  diagram: 'components',
};

/**
 * GET /api/ask — the conversation so far, whether a turn is in flight, and
 * the last proposed grouping.
 * POST /api/ask — ask, propose a grouping, drop one, or end the conversation.
 *
 * Two different jobs behind one panel, and they must not be read as one. A
 * question is a conversation *about* the categories, and a project with none
 * has nothing to talk about — which is the project the second job exists for:
 * `propose` is asked how this project divides, and answers with groups of
 * files, each carrying evidence this code computed from the imports. Neither
 * writes anything.
 *
 * The POST answers **202** and not a word of the answer, exactly as
 * `POST /api/explain` does and for the same reason: the subprocess runs far
 * longer than a browser will hold a fetch open, and a fetch that dies leaves a
 * run nobody is waiting for. The words arrive on the socket as they are
 * written — the first of them in about two seconds — and the whole
 * conversation is readable from the GET either way, so a reload mid-answer
 * loses nothing.
 *
 * Everything this feature does is read. It is told the categories, it answers
 * about them, and nothing it says is written anywhere: decision 4 says nothing
 * in the graph comes from a model, and decision 5 says a model may suggest a
 * name and never decide who belongs. A name it proposes is a sentence on a
 * screen until a person accepts it through `POST /api/clusters`, which is the
 * gesture that already exists.
 */
export function registerAskRoutes(app: FastifyInstance, current: () => AskRouteSession, hub: AskHub): void {
  /**
   * The last proposal run, and the session it was made for.
   *
   * Held here rather than in `session.ts` because it is the only state these
   * routes own, and it is tied to a session all the same: every read checks
   * the session is still the current one, so a project switch drops a
   * grouping of the last project's files instead of showing it under this
   * project's name. A run still in flight when that happens is abandoned the
   * way an ask turn is — the money is spent, the answer is refused.
   */
  let heldProposal: { session: AskRouteSession; run: ProposeRun } | null = null;
  const proposalOf = (session: AskRouteSession): ProposeRun | null =>
    heldProposal !== null && heldProposal.session === session ? heldProposal.run : null;

  app.get('/api/ask', async () => {
    const session = current();
    return {
      conversation: session.askConversation(),
      running: session.askRunning(),
      // No socket frame of its own: a schema answer has nothing to stream —
      // it is a JSON object arriving character by character, not words — and
      // the panel already polls this route every three seconds.
      proposal: proposalOf(session),
    };
  });

  app.post('/api/ask', async (request, reply) => {
    const session = current();
    const body = (request.body ?? {}) as { action?: unknown; question?: unknown };

    if (body.action === 'end') return { ended: session.endAsk() };

    if (body.action === 'drop-proposal') {
      const dropped = proposalOf(session) !== null;
      if (dropped) heldProposal = null;
      return { dropped };
    }

    if (body.action === 'propose') return startProposal(session, reply);

    if (body.action !== 'ask') {
      return reply.code(400).send({ error: "action must be 'ask', 'propose', 'drop-proposal' or 'end'" });
    }

    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (question === '') return reply.code(400).send({ error: 'question must be a non-empty string' });
    if (question.length > MAX_QUESTION_CHARS) {
      return reply.code(400).send({ error: `a question is at most ${MAX_QUESTION_CHARS} characters` });
    }

    await session.refreshGroups();
    const context = askContext(session);
    // Not a failed turn — there is nothing to ask about. A project with no
    // categories is one the clustering found nothing in, and a run would spend
    // money to be told so.
    // The leftover box does not count. `partitionByCategory` always appends
    // "N files in no category" when any file survives the filter, so a project
    // with nothing named still arrives here with one entry — and the refusal
    // never fired. Measured on two of the user's own projects: both had every
    // category rejected, both were told they had one, and both spent money to
    // be answered about a category that does not exist.
    if (context.categories.every((category) => category.uncategorised === true)) {
      return reply.code(400).send({ error: 'this project has no categories to ask about' });
    }

    const conversation = session.startAsk(
      question,
      context,
      (text, kind) => {
        // Read at delta time rather than captured: ending the conversation
        // drops it mid-answer, and a delta then belongs to nothing.
        const held = session.askConversation();
        if (held !== null) hub.askDelta(held.id, text, kind);
      },
      (ended) => hub.askChanged(ended),
    );
    if (conversation === null) {
      return reply.code(409).send({
        error: 'a question is already being answered',
        conversation: session.askConversation(),
      });
    }
    return reply.code(202).send({ conversation });
  });

  /**
   * Ask a model how this project divides, and answer 202 with the run.
   *
   * The four refusals above the spend are the design. Two of them cost
   * nothing and say why — a project with no files to group, and one too big
   * for a single prompt, where a refusal with a reason beats a grouping drawn
   * from a tenth of the graph. The third is a run already in flight. The
   * fourth is decision 5 itself, and it is not enforced here because there is
   * nothing to enforce: this route writes nothing, and never can.
   */
  async function startProposal(session: AskRouteSession, reply: FastifyReply): Promise<unknown> {
    if (proposalOf(session)?.state === 'running') {
      return reply.code(409).send({ error: 'a grouping is already being proposed', proposal: proposalOf(session) });
    }

    // Nothing watches `.codemap/`, so the names are read on the way in — the
    // same reason the ask route refreshes them.
    await session.refreshGroups();
    // Read once: the store swaps its graph on every save, and the files sent,
    // the cohesion counted and the overlap measured must all be one graph's.
    const graph = session.store.graph;
    const groups = session.clustersOf(graph);
    const context = proposeContext(session.root, graph, groups);

    if (context.files.length === 0) {
      return reply.code(400).send({ error: 'this project has no files to group' });
    }
    const refusal = tooBigToPropose(context);
    if (refusal !== null) return reply.code(400).send({ error: refusal });

    const run: ProposeRun = {
      at: Date.now(),
      state: 'running',
      proposals: [],
      note: null,
      dropped: 0,
      sent: { files: context.files.length, links: context.links.length, categories: context.existing.length },
    };
    heldProposal = { session, run };

    void propose(context).then((outcome) => {
      // A run whose project was switched away from, or whose result was
      // dropped, must not write into a panel describing something else.
      if (heldProposal?.run !== run) return;
      run.finishedAt = Date.now();
      if (!outcome.ok) {
        run.state = 'failed';
        run.reason = outcome.reason;
        run.detail = outcome.detail;
        return;
      }
      run.state = 'done';
      run.note = outcome.note;
      run.dropped = outcome.dropped;
      run.costUsd = outcome.costUsd;
      run.ms = outcome.ms;
      // Judged against the graph as it is now rather than the one that was
      // sent: a save during the run changed the imports, and the number a
      // person reads has to be true of the code in front of them.
      run.proposals = judge(session.store.graph, session.clustersOf(session.store.graph), outcome.groups);
    });

    return reply.code(202).send({ proposal: run });
  }
}

/**
 * One grouping the model proposed, with the evidence for it — and the
 * evidence is ours.
 *
 * `group` is what a model said. Everything below it is what the import graph
 * says about those same files, computed by `view/cluster.ts` from the same
 * edges the clustering uses. That order is the whole design: a model that
 * claims eight files are 90% cohesive is guessing, and the number beside its
 * claim on the page was never its to give.
 *
 * Nothing here is stored. A proposal reaches `.codemap/groups.json` only
 * through `POST /api/groups` with `action: 'create'`, which writes it as a
 * group with `origin: 'manual'` — because the person pressing accept is the
 * person drawing that group, and it is marked "by hand" everywhere a
 * hand-drawn group is marked. Decision 5 holds: a model may propose a
 * grouping, and it may never store one.
 */
export interface Proposal {
  name: string;
  /** One sentence: what this group is, in the model's words. */
  sentence: string;
  /** The members, every one a file the graph holds. */
  files: string[];
  /** Paths the answer named that this project has no file for. */
  invented: string[];
  evidence: GroupEvidence;
  /** The accepted categories this covers, and by how much. Empty means it covers unclaimed files. */
  overlaps: ProposalOverlap[];
  /** Members no accepted category holds today. */
  unclaimed: number;
}

/**
 * How much of an existing category a proposal covers.
 *
 * A proposal over files nobody has claimed is a different act from one that
 * re-cuts a category a person already accepted, and the page has to be able
 * to say which. `storedId` is what an editor would address that category by —
 * never the cluster id, which embeds the member count and moves.
 */
export interface ProposalOverlap {
  name: string;
  storedId: string | null;
  /** How many of the proposal's files that category already holds. */
  shared: number;
  /** How many files that category holds in all. */
  size: number;
}

/**
 * A proposal run: one press, one answer.
 *
 * Session state, like a suggest run and a conversation, and for the same
 * reason: nothing a model says is a fact about the project, so nothing here
 * is written to `.codemap/`. It is held against the session it was made for,
 * so a project switch drops it rather than showing a grouping of the last
 * project's files under this one's name.
 *
 * There is nothing to stream — a schema answer is a JSON object arriving
 * character by character, not words — so the page reads this from
 * `GET /api/ask`, which it already polls every three seconds.
 */
export interface ProposeRun {
  at: number;
  state: 'running' | 'done' | 'failed';
  proposals: Proposal[];
  /** The model's own sentence about why the grouping was hard, when it wrote one. */
  note: string | null;
  /** Proposals that named too few real files to be worth judging. */
  dropped: number;
  /** What the model was sent, so the price and the answer can be read against it. */
  sent: { files: number; links: number; categories: number };
  finishedAt?: number;
  costUsd?: number;
  ms?: number;
  reason?: ProposeFailure;
  detail?: string;
}

/**
 * A file in two accepted categories is marked with the smaller one: an outer
 * group and the group inside it both hold it, and the specific name is the
 * one that tells a reader something.
 */
function categoryClaims(groups: MergedGroups): Map<string, string> {
  const claims = new Map<string, string>();
  const accepted = acceptedOf(groups);
  for (const category of [...accepted].sort((a, b) => a.files.length - b.files.length)) {
    for (const file of category.files) if (!claims.has(file)) claims.set(file, category.name);
  }
  return claims;
}

/** The categories that exist: named, accepted, and holding files. */
function acceptedOf(groups: MergedGroups): { name: string; files: readonly string[]; storedId: string | null; origin?: 'manual' }[] {
  return groups.clusters.flatMap((cluster) =>
    cluster.state === 'accepted' && cluster.name !== null
      ? [
          {
            name: cluster.name,
            files: cluster.files,
            storedId: cluster.storedId ?? null,
            ...(cluster.origin === undefined ? {} : { origin: cluster.origin }),
          },
        ]
      : [],
  );
}

/**
 * What the model is sent when it is asked how this project divides.
 *
 * Not the component diagram: that is `askContext` above, and a project with
 * no categories has nothing in it — which is exactly the project this exists
 * for. This is the level underneath, and it is what a person would need to
 * group the project by hand: the files, which category already holds each,
 * and every reference between two files. `fileLinks` is the same rule the
 * clustering measures cohesion with, so the model is reading the graph the
 * evidence will be computed from.
 */
export function proposeContext(root: string, graph: Graph, groups: MergedGroups): ProposeContext {
  const claims = categoryClaims(groups);

  const files: ProposeFile[] = [];
  let testCount = 0;
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file') continue;
    // Tests are left out rather than listed and forbidden: they do not vote in
    // the clustering, `fileLinks` drops their edges, and listing them would
    // invite a group made of them.
    if (isTestFile(node.filePath)) {
      testCount += 1;
      continue;
    }
    files.push({ path: node.filePath, category: claims.get(node.filePath) ?? null });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  return {
    project: root.split('/').filter((part) => part !== '').at(-1) ?? root,
    files,
    // Tests included, deliberately: this is what tells a path the project does
    // not have from one it has and did not offer. Only `files` is sent.
    allPaths: [...graph.nodes.values()].filter((node) => node.kind === 'file').map((node) => node.filePath),
    links: fileLinks(graph).map(({ from, to, weight }) => ({ from, to, weight })),
    existing: acceptedOf(groups).map((category) => ({
      name: category.name,
      files: category.files.length,
      ...(category.origin === undefined ? {} : { origin: category.origin }),
    })),
    fileCount: files.length + testCount,
    testCount,
  };
}

/**
 * The model's list, measured against the imports it never saw.
 *
 * Read off one graph, held once: the store swaps its graph on every save, and
 * a cohesion counted in one graph beside an overlap counted in another would
 * be two answers about two projects.
 */
function judge(graph: Graph, groups: MergedGroups, proposed: readonly ProposedGroup[]): Proposal[] {
  const accepted = acceptedOf(groups);
  const claimed = new Set(accepted.flatMap((category) => [...category.files]));

  return proposed.map((group) => {
    const evidence = evidenceFor(graph, group.files);
    const members = new Set(evidence.files);
    const overlaps: ProposalOverlap[] = [];
    for (const category of accepted) {
      const shared = category.files.filter((file) => members.has(file)).length;
      if (shared > 0) overlaps.push({ name: category.name, storedId: category.storedId, shared, size: category.files.length });
    }
    return {
      name: group.name,
      sentence: group.sentence,
      files: evidence.files,
      invented: group.invented,
      evidence,
      overlaps: overlaps.sort((a, b) => b.shared - a.shared || a.name.localeCompare(b.name)),
      unclaimed: evidence.files.filter((file) => !claimed.has(file)).length,
    };
  });
}

/**
 * What the model is told: the component diagram, turned into words later.
 *
 * Built by running the real thing rather than by re-deriving it — the same
 * `selectView` call the page makes, with the same partition, the same
 * interface for each box and the same weights on the lines. Two answers about
 * one project that disagreed with each other would be worse than either.
 *
 * git and coverage are left out because neither is on the picture this
 * describes: a category is a fact about the imports, and what changed since
 * HEAD is a different question the page already answers.
 */
function askContext(session: AskRouteSession): AskContext {
  // Read once: the store swaps its graph on every save, and the boxes and the
  // categories they stand for must come from the same one.
  const graph = session.store.graph;
  const view = selectView(graph, COMPONENT_SPEC, Date.now(), null, null, session.clustersOf(graph).clusters);

  const categories: AskCategory[] = [];
  for (const node of view.nodes) {
    const facts = node.component;
    if (facts === undefined) continue;
    categories.push({
      id: node.id,
      name: facts.name,
      files: node.files,
      ...(facts.cohesion === undefined ? {} : { cohesion: facts.cohesion }),
      ...(facts.origin === undefined ? {} : { origin: facts.origin }),
      ...(facts.uncategorised === undefined ? {} : { uncategorised: facts.uncategorised }),
      provides: facts.provides.symbols.map(({ name, kind, owner, reachedFrom }) => ({
        name,
        kind,
        owner,
        reachedFrom,
      })),
      providesTotal: facts.provides.total,
    });
  }

  const edges: AskEdge[] = view.edges.map(({ from, to, kind, weight }) => ({ from, to, kind, weight }));

  return {
    // The directory name, and nothing else about the project that is not a
    // fact of the graph. It is what a person calls it, which is what makes an
    // answer read as being about their project rather than about a diagram.
    project: session.root.split('/').filter((part) => part !== '').at(-1) ?? session.root,
    fileCount: view.fileCount,
    categories,
    edges,
  };
}

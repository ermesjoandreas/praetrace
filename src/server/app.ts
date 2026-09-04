import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Coverage } from '../report/types.js';
import type { Graph, GraphNode } from '../graph/types.js';
import type { Session } from './session.js';
import { LANGUAGES } from '../lang/registry.js';
import {
  explainStore,
  fingerprintOf,
  relationsFingerprint,
  type ExplainTarget,
  type Explanation,
} from '../project/explain.js';
import {
  fetchRemote,
  readLog,
  readRemote,
  type Commit,
  type RemoteStatus,
  readBranch,
} from '../project/git.js';
import { changeFromHook, couplingNote, type HookPayload } from '../project/hook.js';
import { portFilePath } from '../project/port-file.js';
import { countUnreadable } from '../project/walk.js';
import {
  applyDecision,
  createManualGroup,
  deleteGroup,
  GROUP_COLORS,
  mergeGroups,
  readGroups,
  updateGroup,
  writeGroups,
  type GroupColor,
  type NamedGroup,
} from '../project/groups.js';
import { installHook, readHookStatus, type HookStatus } from '../project/hook-install.js';
import { describe, describeSymbol, type FileDetail, type SymbolLinks } from '../view/detail.js';
import {
  DEFAULT_EDGE_KINDS,
  parseDuration,
  type ViewFilter,
} from '../view/filter.js';
import { clusterFiles, identify } from '../view/cluster.js';
import { search } from '../view/search.js';
import { projectLanguages, selectView } from '../view/select.js';
import type { LanguageCount, ViewSpec } from '../view/types.js';
import type { LiveHub } from './live.js';
import type { AgentCall, ExplainRun, SessionHost, SuggestResult } from './session.js';

// Vite builds the page into dist/web, beside this module's dist/server.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_DEPTH = 4;

/**
 * The bases worth offering. Not an arbitrary revision string: whatever is picked
 * here reaches `git diff` on the machine, and the three that mean something to
 * someone watching an agent work are "since I last committed", "the commit
 * before that" and "everything on this branch".
 */
const GIT_BASES = ['HEAD', 'HEAD~1', 'branch'] as const;

/**
 * How a stored explanation stands to the code it describes.
 *
 * Two grades of "out of date" because they mean opposite things to a reader:
 * only `stale` should stop you trusting the words. `none` is the vocabulary's
 * fourth answer and is never sent — an id with nothing stored has no entry, and
 * the panel calls that none.
 */
export type ExplainState = 'none' | 'current' | 'drifted' | 'stale' | 'orphaned' | 'unknown';

export interface ExplainedEntry extends Explanation {
  state: ExplainState;
}

/**
 * The most of one target worth reading off disk. A 2000-line file is not a
 * question, it is a bill.
 *
 * The cut is announced inside the text, because this string is both what the
 * model is shown and what the fingerprint is taken over — a fingerprint of the
 * whole file compared against an excerpt would read as stale for ever.
 * `explain.ts` clips again, tighter, for the prompt itself; the effect is that a
 * change past its cut still shows here as stale, which errs towards re-reading
 * rather than towards trusting words nobody checked.
 */
const MAX_SOURCE_LINES = 400;
const MAX_SOURCE_CHARS = 24_000;

/**
 * Relations per direction, and capped per direction: fifty callers must not
 * push out everything the symbol uses, which is the half that says what it is
 * for rather than who wanted it.
 */
const MAX_CONTEXT = 20;

/**
 * The most log a page can ask for at once. The graph is drawn one row per
 * commit, and a thousand rows is taller than anyone scrolls; past that, the
 * question is a search, not a list.
 */
const MAX_LOG = 1000;

/**
 * The most of an agent's note to keep. It is a row in a timeline beside the
 * file changes it explains, so it has to fit on one — and a tool that asks for
 * a sentence and stores a page has asked for the wrong thing.
 */
const MAX_AGENT_NOTE = 200;

/**
 * What the PostToolUse hook gets back.
 *
 * `hookSpecificOutput` is Claude Code's own shape, and the hook script echoes
 * this body to stdout unchanged rather than reassembling it — which is why the
 * server, not a line of shell, decides what the agent is told. It is absent
 * when the graph has nothing worth saying, and then the hook prints a body
 * Claude Code finds nothing in, which is the same as saying nothing.
 *
 * Verified against a real run: `additionalContext` reaches the model wrapped in
 * a system reminder, capped at 10,000 characters, and a PostToolUse hook's
 * plain stdout does not reach it at all.
 */
export interface HookResponse {
  /** Whether the payload named a source file inside the project. */
  accepted: boolean;
  hookSpecificOutput?: { hookEventName: 'PostToolUse'; additionalContext: string };
}

/** What the test suite ran, or null: a project with no report is the ordinary case. */
export interface CoverageResponse {
  coverage: Coverage | null;
}

/** What `git log` answers, plus which commit is checked out. */
export interface LogResponse {
  commits: Commit[];
  /**
   * The sha HEAD is at, so the page can select its row when nothing is frozen.
   * '' when no commit in the log is decorated HEAD — a repository with no
   * commits, or one whose HEAD lies further back than the log was asked for.
   */
  head: string;
  /**
   * What HEAD is on, in words: a branch name, or `detached at 7fe7f88`. Null
   * only for a repository with nothing committed yet, which has no name to
   * give — see `branchOf`. From git, not from the decorations: `%D` spells a
   * detached HEAD sitting on a branch tip the same way it spells the branch
   * once the arrow is split, so the refs alone cannot say which one the row's
   * target badge belongs to.
   */
  branch: string | null;
}

/**
 * Everything the Repository panel shows, in one answer. Composed here from
 * what already exists rather than fetched as four requests, because the panel
 * is a single thing on screen and the parts arriving at four different moments
 * would draw it four times.
 */
export interface RepoInfo {
  /** The repository's own name: the last segment of the root. */
  name: string;
  root: string;
  /** Source files the graph holds. */
  files: number;
  /** null when the project is not a repository, or has no remote. */
  remote: RemoteStatus | null;
  hook: HookStatus;
  /**
   * What has actually arrived at `/api/hook` this session, beside what the
   * settings file claims. See `Session.hookCalls`: "installed" is a claim about
   * a file, and a refusal count is the only thing on the panel that can
   * contradict it.
   */
  hookCalls: { accepted: number; refused: number };
  /** Where the hook finds this server; written only while `.claude/` exists. */
  portFile: string;
  agent: { lastAt: number | null; total: number };
  /**
   * Where the coverage numbers came from and when it was written, or null when
   * nothing was found. Only the provenance: the counts themselves are
   * `/api/coverage`, and shipping a map of every file and symbol twice to
   * render one row would cost more than the read that produced it.
   */
  coverage: { at: number; source: string } | null;
  languages: {
    /** What the project is written in, biggest first. */
    found: LanguageCount[];
    /** Source the tool cannot read, biggest first. */
    unreadable: { extension: string; files: number }[];
  };
}

export interface FetchResponse {
  ok: boolean;
  detail: string;
  /** Re-read after the fetch, so ahead/behind describe what just arrived. */
  remote: RemoteStatus | null;
}

/**
 * What one press of Suggest answers. A failure is in the body and not in a
 * status code, for the same reason an explain run's is: the request was fine,
 * the run was not, and only one of those is an HTTP error. The 400 and 409 are
 * about the request — nothing to name, or a run already spending.
 */
export type SuggestResponse = SuggestResult | { ok: false; reason: string; detail: string };

export interface AppOptions {
  /** Holds the current project. Routes read through it, never around it. */
  host: SessionHost;
  hub: LiveHub;
  /**
   * Called whenever the project changes, or gains a .claude directory, so the
   * port file can follow it. The hook reads that file to find this server.
   */
  onProjectChanged: (root: string) => Promise<void>;
  /**
   * An explain run ended, a minute or more after the request that started it.
   * The graph did not change, so this belongs on the socket as its own message
   * — the same reason `agentActed` is one — and the hub is outside this change,
   * so it arrives as a callback. Unwired, the page learns the outcome from its
   * next GET /api/explain instead of being told.
   */
  onExplainRun?: (run: ExplainRun) => void;
  /** A few characters of an answer, as it is being written. */
  onExplainDelta?: (text: string) => void;
}

export function buildApp({ host, hub, onProjectChanged, onExplainRun, onExplainDelta }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  // The MCP proxy marks its own requests, which is the only way to tell an
  // agent's question from a browser's. One hook, no extra round trip.
  app.addHook('onRequest', async (request) => {
    const tool = request.headers['x-codemap-tool'];
    if (typeof tool !== 'string' || tool === '') return;

    const rawTarget = request.headers['x-codemap-arg'];
    const call = {
      at: Date.now(),
      tool,
      target: typeof rawTarget === 'string' && rawTarget !== '' ? rawTarget : null,
    };
    host.current().recordAgentCall(call);
    hub.agentActed(call);
  });

  app.register(fastifyStatic, { root: WEB_DIR });
  app.register(websocket);

  app.get('/api/view', async (request, reply) => {
    const session = host.current();
    const query = request.query as Record<string, unknown>;

    // A misspelled edge kind is refused rather than dropped. Falling back to
    // the defaults answered a different question under the caller's URL, which
    // is the same silence `?calls=1` used to get.
    const unknown = unknownEdges(query['edges']);
    if (unknown.length > 0) {
      return reply.code(400).send({
        error: `edges= takes ${EDGE_KINDS.join(', ')} — not ${unknown.join(', ')}`,
      });
    }

    const spec = toSpec(query);

    // A commit that cannot be drawn is a 404 and never the live graph: a page
    // showing now under a banner naming a commit is exactly the wrong picture
    // that looks authoritative, and the one thing this feature must not do.
    if (spec.at !== null && !isCommitId(spec.at)) {
      return reply.code(404).send({ error: `not a commit id: ${spec.at}` });
    }
    const graph = await graphFor(session, spec.at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${spec.at}` });

    // A focus or scope the graph has never heard of is a 404 for the same
    // reason. It used to answer the root view, which is a diagram of the whole
    // project under a URL naming one file — the reader has no way to tell that
    // from a file with no imports.
    const missing = missingFrom(graph, spec);
    if (missing !== null) return reply.code(404).send({ error: missing });

    // No git status at a commit: it has no working tree to differ from a base.
    // The cutoff for "changed recently" is computed per request, so a stored
    // spec does not freeze time at the moment it was set.
    const git = spec.at === null ? session.gitStatus() : null;

    // Coverage is refused at a commit for the same reason, and a sharper one.
    // The report on disk describes the working tree, and a commit's graph is
    // built with the ids the live one uses — so the numbers would land on last
    // week's symbols and look entirely at home there. The refresh is three
    // stats, which is what makes a reload after a test run show the new
    // numbers rather than waiting for the next save.
    let coverage: Coverage | null = null;
    if (spec.at === null) {
      await session.refreshCoverage();
      coverage = session.coverage();
    }

    // The view carries the graph's own `fileCount`, so the Repository panel
    // can say the frozen number: "Files 1128" under a commit was the live
    // count, beside a status bar that said 712.
    return { root: session.root, view: selectView(graph, spec, Date.now(), git, coverage) };
  });

  app.get('/api/project', async () => ({ root: host.current().root }));

  /**
   * What the tool reads, and what this project holds that it cannot.
   *
   * The breakdown of what *was* parsed rides on every ViewGraph, because it
   * changes whenever the graph does. This is the other half, and it changes only
   * when the project does: which languages exist at all, and how many files were
   * never offered to one. Walked on request rather than remembered from the boot
   * scan because the scan discards these before anyone counts them — and an
   * answer computed now cannot claim a file the agent has since added is absent.
   */
  app.get('/api/languages', async () => ({
    reads: LANGUAGES.map((language) => language.label),
    unreadable: await countUnreadable(host.current().root),
  }));

  // A box: one file, or a directory. The answer echoes the subject in its own
  // `path`, so a caller never has to trust that the route read the key it meant.
  app.get('/api/detail', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const asked = readSubject(query);
    if (asked === '') {
      return reply.code(400).send({ error: 'ask for one: ?path= or ?id=, a file or a directory' });
    }
    const at = readAt(query['at']);
    const graph = await graphFor(host.current(), at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    const detail = describe(graph, asked);
    if (!detail) {
      return reply.code(404).send({ asked, error: notFound(graph, asked, 'file') });
    }
    return detail;
  });

  // One symbol's relations. Separate from /api/detail because that answers about
  // a box and this answers about a row inside one, and a caller wants exactly one
  // of the two.
  app.get('/api/symbol', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const asked = readSubject(query);
    if (asked === '') {
      return reply.code(400).send({ error: 'ask for one: ?id= or ?path=, as path#Name' });
    }
    const at = readAt(query['at']);
    const graph = await graphFor(host.current(), at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    const links = describeSymbol(graph, asked);
    if (!links) {
      return reply.code(404).send({ asked, error: notFound(graph, asked, 'symbol') });
    }
    return links;
  });

  /**
   * What has been explained, for the ids the panel is showing.
   *
   * It takes ids on purpose. `state` is computed by re-reading each described
   * file off disk, so an unfiltered answer would read every explained file in
   * the project on every render of a panel showing four. With no ids it is the
   * cheap poll instead: how many exist, and what the run is doing.
   */
  app.get('/api/explain', async (request) => {
    const session = host.current();
    const query = request.query as Record<string, unknown>;
    const wanted = new Set(readCsv(query['ids']));
    const stored = session.explanations();

    return {
      explanations: await Promise.all(
        stored
          .filter((entry) => wanted.has(entry.id))
          .map(async (entry) => explained(session.store.graph, session.root, entry)),
      ),
      total: stored.length,
      run: session.explainRun(),
      // What a run would write, and whether writing it would put a directory
      // into this project that is not there. See `explainStore`: the panel can
      // say so before the press, and the press itself is asked either way.
      store: await explainStore(session.root),
    };
  });

  /**
   * Spend the user's quota, stop spending it, or throw an answer away.
   *
   * `run` answers 202 and not a byte of the explanation: the subprocess takes a
   * minute or more, which is longer than a browser will hold a fetch open, and
   * a fetch that dies leaves the run with nobody waiting for it. The answer
   * arrives on the socket, and is readable from the GET above either way.
   */
  app.post('/api/explain', async (request, reply) => {
    const session = host.current();
    const body = (request.body ?? {}) as {
      action?: unknown;
      ids?: unknown;
      id?: unknown;
      force?: unknown;
      createStore?: unknown;
    };

    if (body.action === 'cancel') {
      return { cancelled: session.cancelExplain(), run: session.explainRun() };
    }

    if (body.action === 'forget') {
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') return reply.code(400).send({ error: 'id must be a non-empty string' });
      // An explanation can simply be wrong, and hand-editing a committed file is
      // not an answer to that.
      return { forgotten: await session.forgetExplanation(id) };
    }

    if (body.action !== 'run') {
      return reply.code(400).send({ error: "action must be 'run', 'cancel' or 'forget'" });
    }

    // Asked before a byte is spent, because the answer is a file in somebody
    // else's repository — see `explainStore` for the decision and why it is a
    // question rather than a sentence in the panel. Once the directory exists
    // the question is settled and never asked again.
    const store = await explainStore(session.root);
    if (!store.exists && body.createStore !== true) {
      return reply.code(409).send({
        error: `explaining writes ${store.path}, and this project has no .codemap/ yet — send createStore: true to allow it`,
        needsConsent: true,
        store,
      });
    }

    const force = body.force === true;
    const stored = new Map(session.explanations().map((entry) => [entry.id, entry]));
    const targets: ExplainTarget[] = [];
    const skipped: string[] = [];
    for (const id of readStrings(body.ids)) {
      // A reading that still matches the code it described is not bought
      // twice unless the request says so: "Explain these" re-read a symbol
      // whose panel already said current, and charged for it. The skipped ids
      // are named in the answer so the page can say why the count is smaller.
      const entry = stored.get(id);
      if (!force && entry !== undefined && (await explainState(session.store.graph, session.root, entry)) === 'current') {
        skipped.push(id);
        continue;
      }
      const target = await resolveTarget(session.store.graph, session.root, id);
      if (target) targets.push(target);
    }
    // Not a failed run — nothing was asked. A run that produces no answers is
    // reported as a run; a request naming ids the graph has never heard of, or
    // only ids already current, is a bad request, and telling them apart is
    // what stops a spinner starting.
    if (targets.length === 0) {
      return reply.code(400).send({
        error: skipped.length > 0 ? 'every one of those already has a current reading' : 'none of those ids are in the graph',
        skipped,
      });
    }

    const run = session.startExplain(
      targets,
      (ended) => onExplainRun?.(ended),
      (text) => onExplainDelta?.(text),
    );
    if (!run) {
      return reply.code(409).send({ error: 'a run is already in flight', run: session.explainRun() });
    }
    return reply.code(202).send({ run, skipped });
  });

  // Searches the graph on screen. At a commit that is the commit's graph, or
  // ⌘K finds a symbol the diagram does not have and misses one it shows.
  app.get('/api/search', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const term = typeof query['q'] === 'string' ? query['q'] : '';
    const at = readAt(query['at']);
    const graph = await graphFor(host.current(), at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    return { hits: search(graph, term) };
  });

  app.get('/api/clusters', async (request, reply) => {
    const session = host.current();
    const at = readAt((request.query as Record<string, unknown>)['at']);
    // The graph decides membership; the stored file only supplies names. At a
    // commit it is that commit's graph: a frame on a diagram of last week has
    // to be what last week's imports produced, or it is a tidy lie.
    const graph = await graphFor(session, at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    // `{ clusters, orphans }`: the orphans are stored names that match no
    // cluster any more. They used to be dropped here, so three committed
    // groups were never shown anywhere and nobody could say why.
    return mergeGroups(clusterFiles(graph), await readGroups(session.root));
  });

  app.post('/api/clusters', async (request, reply) => {
    const body = (request.body ?? {}) as {
      files?: unknown;
      name?: unknown;
      state?: unknown;
      id?: unknown;
    };
    const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string') : [];
    const state = body.state === 'rejected' ? 'rejected' : 'accepted';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (files.length === 0) return reply.code(400).send({ error: 'files must be a non-empty array' });
    if (state === 'accepted' && name === '') {
      return reply.code(400).send({ error: 'an accepted group needs a name' });
    }

    const root = host.current().root;
    // Derived rather than demanded: a caller that knows only the file list —
    // the MCP tools, for one — should not have to carry an id as well.
    const id = typeof body.id === 'string' ? body.id : identify([...files].sort());
    await writeGroups(
      root,
      applyDecision(await readGroups(root), files, { name, state, id }),
    );
    // This is the route the MCP proxy's name_group takes, and the browser has
    // no other way to learn a name the agent gave: nothing watches .codemap/.
    hub.groupsChanged();
    return { ok: true };
  });

  app.post('/api/groups', async (request, reply) => {
    const root = host.current().root;

    // The same question explain asks, about the same directory. Naming a group
    // writes .codemap/groups.json, and a project opened to be looked at should
    // not gain a directory for it — see the reason above `explainStore`.
    const body = (request.body ?? {}) as { createStore?: unknown };
    const store = await explainStore(root);
    if (!store.exists && body.createStore !== true) {
      return reply.code(409).send({
        error: `naming a group writes into ${path.dirname(store.path)}, and this project has no .codemap/ yet — send createStore: true to allow it`,
        needsConsent: true,
      });
    }

    let next: NamedGroup[];
    try {
      next = applyGroupAction(await readGroups(root), (request.body ?? {}) as GroupAction);
    } catch (error) {
      // Every helper refuses bad input by throwing, so one catch covers the lot.
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    await writeGroups(root, next);
    hub.groupsChanged();

    // Merged rather than returned raw: `mergeGroups` is what pairs a stored name
    // with the cluster the graph currently finds, and it is the only shape the
    // page has a state setter for. The same `{ clusters, orphans }` as the GET,
    // so a delete of an orphan sees it leave the list it was shown in.
    const session = host.current();
    return mergeGroups(clusterFiles(session.store.graph), next);
  });

  // `running` beside the result: the fetch that started a run is the only
  // thing that used to know one was in flight, so a reload showed
  // "Suggesting…" for ever, or nothing while the money was still being spent.
  app.get('/api/suggest', async () => {
    const session = host.current();
    return { result: session.lastSuggest(), running: session.suggestRunning() };
  });

  /**
   * Ask a model what the unnamed groups are called. Spends the user's money, so
   * only ever on a press; and what comes back is a list of guesses the page
   * holds until someone accepts one — that press goes through POST /api/clusters
   * like any other name, and this route writes nothing.
   *
   * Awaited, unlike explain: one call, a minute at most, which a fetch holds.
   */
  app.post('/api/suggest', async (_request, reply) => {
    const session = host.current();
    const { clusters: groups } = mergeGroups(clusterFiles(session.store.graph), await readGroups(session.root));

    const targets = groups
      .filter((group) => group.state === 'suggested')
      .map(({ id, files, cohesion }) => ({ id, files, cohesion }));
    // The names already given, so the model matches their style and does not
    // hand out one that is taken. A hand-drawn group counts: it is a name in
    // this project whether or not the imports found it.
    const named = groups.flatMap((group) =>
      group.state === 'accepted' && group.name !== null ? [{ name: group.name, files: group.files }] : [],
    );

    // Not a failed run — nothing was asked. Telling that apart from a run that
    // answered nothing is what keeps the button from showing a spinner for it.
    if (targets.length === 0) {
      return reply.code(400).send({ error: 'every category already has a name' });
    }

    const run = session.suggest(targets, named);
    if (run === null) return reply.code(409).send({ error: 'a run is already in flight' });
    return run;
  });

  app.get('/api/git', async () => host.current().gitStatus() ?? { available: false });

  app.post('/api/git-base', async (request, reply) => {
    const body = (request.body ?? {}) as { base?: unknown };
    const base = typeof body.base === 'string' ? body.base : '';
    if (!(GIT_BASES as readonly string[]).includes(base)) {
      return reply.code(400).send({ error: `base must be one of ${GIT_BASES.join(', ')}` });
    }

    const status = await host.current().setGitBase(base);
    // Every view carries the status, so until a fresh one is pushed the badges
    // on screen still describe the base that was just replaced.
    hub.publish([]);
    return status ?? { available: false };
  });

  app.get('/api/log', async (request): Promise<LogResponse> => {
    const query = request.query as Record<string, unknown>;
    const limit = readLimit(query['limit']);
    const root = host.current().root;
    const [commits, branch] = await Promise.all([readLog(root, limit ?? undefined), readBranch(root)]);
    return { commits, head: headOf(commits), branch };
  });

  app.get('/api/repo', async (): Promise<RepoInfo> => {
    const session = host.current();
    const root = session.root;
    const [remote, hook, unreadable] = await Promise.all([
      readRemote(root),
      readHookStatus(root),
      countUnreadable(root),
      session.refreshCoverage(),
    ]);
    // Through the session, so the row naming the report and the boxes drawing
    // its numbers are one answer. Two reads of the same file a moment apart is
    // one read too many, and two chances to disagree.
    const coverage = session.coverage();
    const calls = session.agentCalls();

    return {
      name: path.basename(root),
      root,
      files: session.store.files.size,
      remote,
      hook,
      hookCalls: session.hookCalls(),
      portFile: portFilePath(root),
      agent: { lastAt: calls[calls.length - 1]?.at ?? null, total: calls.length },
      coverage: coverage === null ? null : { at: coverage.at, source: coverage.source },
      languages: { found: projectLanguages(session.store.graph), unreadable },
    };
  });

  // The one thing here that talks to a remote, and the only git verb that is
  // not a read. It touches no working tree — an agent may be editing it.
  app.post('/api/fetch', async (): Promise<FetchResponse> => {
    const root = host.current().root;
    const fetched = await fetchRemote(root);
    return { ...fetched, remote: await readRemote(root) };
  });

  app.get('/api/agent', async () => {
    const calls = [...host.current().agentCalls()].reverse();
    return { calls, lastAt: calls[0]?.at ?? null, total: calls.length };
  });

  app.get('/api/changes', async () => ({ changes: [...host.current().history()].reverse() }));

  app.post('/api/project', async (request, reply) => {
    const body = (request.body ?? {}) as { root?: unknown };
    if (typeof body.root !== 'string' || body.root === '') {
      return reply.code(400).send({ error: 'root must be a non-empty string' });
    }

    try {
      const session = await host.switchTo(body.root);
      await onProjectChanged(session.root);
      // Clients are holding specs that name paths in the old project.
      hub.projectChanged();
      return { root: session.root };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/hook-status', async () => readHookStatus(host.current().root));

  app.post('/api/hook-install', async (_request, reply) => {
    const root = host.current().root;
    try {
      const status = await installHook(root);
      // Installing creates .claude/ when it was missing, which is the condition
      // the port file waits for.
      await onProjectChanged(root);
      return status;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/hook', async (request, reply): Promise<HookResponse> => {
    const session = host.current();
    const change = await changeFromHook((request.body ?? {}) as HookPayload, session.root);
    // Recorded before anything is done with it, so a payload that is refused is
    // counted exactly as loudly as one that lands. That asymmetry is the bug
    // this exists for: a refusal is silent everywhere else, because the hook
    // must never fail the agent's tool call.
    session.recordHookCall(change !== null);
    if (change) session.queue(change);

    // Read from the graph as it stands, which is the file as it was a moment
    // before this edit. The agent's tool call is held open until this answers,
    // so waiting for the re-parse would put the parser's queue on the agent's
    // critical path — and who imports a file does not change because its body
    // did. What is known now is both fast and true.
    const context = change === null ? '' : couplingNote(session.store.graph, change.filePath);

    // A hook must never fail the agent's tool call, so a payload we cannot use
    // is still a success. `accepted` is unchanged, and `hookSpecificOutput` is
    // the part Claude Code reads out of the body the hook echoes: anything else
    // in it, this field included, is ignored by the reader that matters.
    reply.code(200);
    return {
      accepted: change !== null,
      ...(context === ''
        ? {}
        : { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
    };
  });

  /**
   * The agent's own words about what it just did.
   *
   * Its own route rather than a marked request, unlike everything else the MCP
   * server calls: the mark is two headers, and a sentence with an agent's
   * punctuation in it does not belong in an HTTP header. So this records the
   * call itself, and `note_change` is the one tool that does not mark.
   */
  app.post('/api/note', async (request, reply) => {
    const body = (request.body ?? {}) as { files?: unknown; note?: unknown };
    if (typeof body.note !== 'string' || body.note.trim() === '') {
      return reply.code(400).send({ error: 'note must be a non-empty string' });
    }

    const note = body.note.trim();
    const call: AgentCall = {
      at: Date.now(),
      tool: 'note_change',
      target: null,
      // Clipped rather than refused. The tool asks for 200 characters and a
      // few over is not worth a second round trip on the agent's dime — but a
      // paragraph would take over the panel it is a row in.
      note: note.slice(0, MAX_AGENT_NOTE),
      files: readStrings(body.files),
    };

    host.current().recordAgentCall(call);
    hub.agentActed(call);
    return { ok: true, clipped: note.length > MAX_AGENT_NOTE };
  });

  /**
   * What the test suite executed, as the artefact CI already wrote says.
   *
   * The session's copy, stamped on the way in so a run that finished thirty
   * seconds ago is read and one that has not is not. It is the same object the
   * boxes were drawn from, which is the point: this answers "why is that
   * symbol grey", and a second read could answer about a different report.
   * Null is the ordinary case — most projects have no report at all.
   */
  app.get('/api/coverage', async (): Promise<CoverageResponse> => {
    const session = host.current();
    await session.refreshCoverage();
    return { coverage: session.coverage() };
  });

  app.register(async (scoped) => {
    scoped.get('/live', { websocket: true }, (socket) => {
      hub.add(socket, toSpec({}));

      socket.on('message', (raw: Buffer) => {
        // The client tells us which slice it is looking at, so an update can be
        // computed per client rather than broadcast as one shared view.
        try {
          const message = JSON.parse(String(raw)) as { spec?: Record<string, unknown> };
          if (message.spec) hub.setSpec(socket, toSocketSpec(message.spec));
        } catch {
          // A malformed frame is not worth dropping the connection over.
        }
      });

      socket.on('close', () => hub.remove(socket));
    });
  });

  return app;
}

/**
 * One id — a file path or a symbol id — as something worth sending to a model.
 *
 * The source is read from disk rather than carried on the graph, which holds
 * line ranges and no text. Re-reading is also what makes the fingerprint
 * describe the code as it is at the moment of the run.
 */
async function resolveTarget(
  graph: Graph,
  root: string,
  id: string,
): Promise<ExplainTarget | null> {
  const node = graph.nodes.get(id);
  if (!node) return null;

  const source = await readSource(root, node);
  if (source === null) return null;

  const shared = { id, name: node.name, filePath: node.filePath, source };

  if (node.kind === 'file') {
    const detail = describe(graph, node.filePath);
    return {
      ...shared,
      kind: 'file',
      context: detail?.kind === 'file' ? fileContext(detail) : [],
      // The same list explainState will recompute later, so the two agree.
      related: relatedFilesOf(graph, id),
    };
  }

  const links = describeSymbol(graph, id);
  return {
    ...shared,
    kind: 'symbol',
    context: links ? symbolContext(links) : [],
    related: relatedFilesOf(graph, id),
    // The graph's own word on how much of that context it can vouch for. A
    // method's callers are only the typed ones, and the model is told so in
    // the same words the panel uses, not left to read an empty list as none.
    ...(links ? { coverage: links.coverage, coverageNote: links.coverageNote } : {}),
  };
}

/** One stored explanation, told how it now stands to the code it describes. */
async function explained(
  graph: Graph,
  root: string,
  entry: Explanation,
): Promise<ExplainedEntry> {
  return { ...entry, state: await explainState(graph, root, entry) };
}

async function explainState(
  graph: Graph,
  root: string,
  entry: Explanation,
): Promise<ExplainState> {
  const node = graph.nodes.get(entry.id);
  if (!node) return 'orphaned';

  const source = await readSource(root, node);
  // In the graph and not on disk: a delete the parser has not caught up with,
  // which is the same answer one re-parse early.
  if (source === null) return 'orphaned';

  const fresh = fingerprintOf(source);
  // Read the algorithm back rather than assume it. An entry written by a build
  // that hashed differently cannot be compared with this one's, and saying so is
  // the whole difference between 'unknown' and reporting every old entry stale.
  if (algorithmOf(fresh) !== algorithmOf(entry.fingerprint)) return 'unknown';
  if (fresh !== entry.fingerprint) return 'stale';

  return movedAround(graph, entry) ? 'drifted' : 'current';
}

/**
 * Whether the relations this explanation was written against have changed.
 *
 * Compared as a hash of the relations themselves, not as a timestamp. The first
 * attempt asked whether a related file's mtime was newer than `at`, which is
 * true of every file in a fresh clone — so a committed explanation read as
 * drifted for everyone except its author, defeating the reason it is committed.
 *
 * An entry written before relations were recorded has nothing to compare and is
 * left alone: claiming drift we cannot see is the same kind of lie as missing it.
 */
function movedAround(graph: Graph, entry: Explanation): boolean {
  if (entry.relations === undefined) return false;
  return relationsFingerprint(relatedFilesOf(graph, entry.id)) !== entry.relations;
}

function relatedFilesOf(graph: Graph, id: string): string[] {
  if (graph.nodes.get(id)?.kind === 'file') {
    const detail = describe(graph, id);
    return detail?.kind === 'file' ? [...detail.imports, ...detail.importedBy] : [];
  }
  const links = describeSymbol(graph, id);
  return links ? [...links.uses, ...links.usedBy].map((relation) => relation.filePath) : [];
}

/** The label before the colon in a fingerprint, or '' when there is none. */
function algorithmOf(fingerprint: string): string {
  const colon = fingerprint.indexOf(':');
  return colon === -1 ? '' : fingerprint.slice(0, colon);
}

async function readSource(root: string, node: GraphNode): Promise<string | null> {
  const raw = await readFile(path.join(root, node.filePath), 'utf8').catch(() => null);
  if (raw === null) return null;
  // Ranges are 1-based and inclusive, and a file node spans the whole file.
  return clip(raw.split('\n').slice(node.range.startLine - 1, node.range.endLine));
}

function clip(lines: readonly string[]): string {
  const kept = lines.slice(0, MAX_SOURCE_LINES).join('\n');
  const text = kept.slice(0, MAX_SOURCE_CHARS);
  if (text.length === kept.length && lines.length <= MAX_SOURCE_LINES) return text;
  return `${text}\n… truncated; the original is ${lines.length} lines`;
}

function symbolContext(links: SymbolLinks): string[] {
  return [
    ...links.usedBy.slice(0, MAX_CONTEXT).map((r) => `used by ${r.id} (${r.edge})`),
    ...links.uses.slice(0, MAX_CONTEXT).map((r) => `uses ${r.id} (${r.edge})`),
  ];
}

function fileContext(detail: FileDetail): string[] {
  return [
    ...detail.importedBy.slice(0, MAX_CONTEXT).map((from) => `used by ${from}`),
    ...detail.imports.slice(0, MAX_CONTEXT).map((to) => `uses ${to}`),
  ];
}

/** A comma-separated query parameter. No id in the graph contains a comma. */
/**
 * What a request is about, under either name.
 *
 * `/api/detail` took `path` and `/api/symbol` took `id`, and four of five
 * reviewers lost time to that difference. The reward for guessing wrong was
 * `nothing known about `, with the subject empty — which reads as "the graph
 * has never heard of anything" rather than "that is the other route's key".
 * Both names work on both routes now: what separates the two is what they
 * answer, not what they are asked.
 */
function readSubject(query: Record<string, unknown>): string {
  for (const key of ['path', 'id']) {
    const value = query[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}

/**
 * Why a subject the graph holds no answer for came back empty — and, when the
 * graph does hold it, which of the two routes was wanted.
 *
 * The subject is quoted, so a name with a trailing space or an unexpanded
 * `$PWD` in it is visible rather than being read as nothing at all.
 */
function notFound(graph: Graph, asked: string, wanted: 'file' | 'symbol'): string {
  const node = graph.nodes.get(asked);
  if (node !== undefined && (node.kind === 'file') !== (wanted === 'file')) {
    return node.kind === 'file'
      ? `"${asked}" is a file — ask /api/detail?path=${asked}`
      : `"${asked}" is a ${node.kind} — ask /api/symbol?id=${asked}`;
  }
  return `nothing known about "${asked}"`;
}

function readCsv(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return raw.split(',').filter((value) => value !== '');
}

/** Everything here is user input, from a query string or a socket frame. */
function toSpec(raw: Record<string, unknown>): ViewSpec {
  const focus = typeof raw['focus'] === 'string' && raw['focus'] !== '' ? raw['focus'] : null;
  return {
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : '',
    focus,
    depth: readDepth(raw['depth']),
    filter: toFilter(raw),
    at: readAt(raw['at']),
  };
}

/**
 * Kept as given rather than checked here: an `at` that is not a commit must
 * reach the view route and be refused there, because turning it into null
 * would draw the working tree under a URL that names a commit.
 */
function readAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Abbreviated or full, hex only. A ref name would reach `git archive` as an
 * argument, and a name is a moving target no cache keyed on it could be right
 * about after the next commit.
 */
function isCommitId(at: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(at);
}

/**
 * The graph a request is about: the live one, or a commit's when `at` names
 * one. Everything that describes the diagram — a box's detail, a symbol's
 * relations, the groups — goes through here, so a frozen diagram is never
 * described by the graph it is not showing. Null means the commit cannot be
 * drawn; the caller answers 404, never the live graph under a commit's name.
 */
async function graphFor(session: Session, at: string | null): Promise<Graph | null> {
  if (at === null) return session.store.graph;
  if (!isCommitId(at)) return null;
  return session.graphAt(at);
}

/**
 * Why this spec cannot be drawn from this graph, or null when it can.
 *
 * A focus names a file; a scope names a directory with at least one file
 * under it. Checked against the whole graph and not the filtered slice: a
 * file the "changes only" filter hid is still a file, and the filter
 * emptying the view is its own honest answer. The scope is normalised the way
 * `selectView` normalises it, so `src/graph/` and `src/graph` are one question.
 */
function missingFrom(graph: Graph, spec: ViewSpec): string | null {
  if (spec.focus !== null) {
    return graph.nodes.get(spec.focus)?.kind === 'file' ? null : `no such file: ${spec.focus}`;
  }
  const scope = spec.scope.replace(/^\/+|\/+$/g, '');
  if (scope === '') return null;
  const prefix = `${scope}/`;
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' && node.filePath.startsWith(prefix)) return null;
  }
  return `no such directory: ${scope}`;
}

/** The count a page asked for, or null for the log's own default. */
function readLimit(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_LOG);
}

/**
 * The commit HEAD decorates. `%D` writes `HEAD -> main` on a branch and a bare
 * `HEAD` when detached, so the token is looked for either way — the first
 * match is the one, because only one commit is ever HEAD.
 */
function headOf(commits: readonly Commit[]): string {
  const isHead = (ref: string): boolean => ref === 'HEAD' || ref.startsWith('HEAD ->');
  return commits.find((commit) => commit.refs.some(isHead))?.sha ?? '';
}

/**
 * The socket carries a ViewSpec object; the query string carries flat, shorter
 * keys. They are two wire formats for one type, so they get two readers rather
 * than one that guesses — reading a spec object with the query-string reader
 * looked for `changed` and `edges` at the top level, found neither, and handed
 * back the default filter. Every live push then silently widened the diagram
 * back to the whole scope while the URL and the "filtered" chip still said it
 * was narrowed.
 */
function toSocketSpec(raw: Record<string, unknown>): ViewSpec {
  const filter = isRecord(raw['filter']) ? raw['filter'] : {};
  const edges = readMembers(filter['edgeKinds'], EDGE_KINDS);
  const since = filter['sinceMs'];

  return {
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : '',
    focus: typeof raw['focus'] === 'string' && raw['focus'] !== '' ? raw['focus'] : null,
    depth: readDepth(raw['depth']),
    filter: {
      hidePath: typeof filter['hidePath'] === 'string' ? filter['hidePath'] : '',
      onlyPath: typeof filter['onlyPath'] === 'string' ? filter['onlyPath'] : '',
      kinds: readMembers(filter['kinds'], NODE_KINDS),
      edgeKinds: edges.length > 0 ? edges : DEFAULT_EDGE_KINDS,
      sinceMs: typeof since === 'number' && Number.isFinite(since) && since > 0 ? since : 0,
      onlyChanged: filter['onlyChanged'] === true,
      hideTests: filter['hideTests'] === true,
    },
    at: readAt(raw['at']),
  };
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** The socket sends the kind lists as arrays, where a query string sends CSV. */
function readMembers<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((value): value is string => typeof value === 'string'));
  return allowed.filter((value) => wanted.has(value));
}

const NODE_KINDS = ['class', 'function', 'interface', 'type', 'method', 'field'] as const;
const EDGE_KINDS = ['imports', 'extends', 'implements', 'calls', 'associates'] as const;

/**
 * The two opt-in edge kinds, each also spellable as a flag of its own.
 *
 * `?calls=1` is what CLAUDE.md documents and what everyone typed; only
 * `?edges=imports,calls` worked, and the URL that did not was not refused —
 * it came back as the default filter, a diagram with no call edges under a
 * link that asked for them. A silently ignored request is the failure this
 * project cares about most, so the short form is read rather than dropped.
 * A flag adds to what `edges=` asked for; it never takes anything away.
 */
const EDGE_FLAGS = ['calls', 'associates'] as const;

/**
 * Names in `edges=` that are not edge kinds. A typo there used to fall back to
 * the default kinds, which is the same silence `calls=1` had: the caller asked
 * for something and got a diagram that answered a different question. The
 * route refuses instead, and names the keys that work.
 */
function unknownEdges(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return raw.split(',').filter((name) => name !== '' && !(EDGE_KINDS as readonly string[]).includes(name));
}

/** Every field is user input, from a query string or a socket frame. */
function toFilter(raw: Record<string, unknown>): ViewFilter {
  const listed = readList(raw['edges'], EDGE_KINDS);
  const wanted = new Set<string>(listed.length > 0 ? listed : DEFAULT_EDGE_KINDS);
  for (const kind of EDGE_FLAGS) if (raw[kind] === '1') wanted.add(kind);

  return {
    hidePath: typeof raw['hide'] === 'string' ? raw['hide'] : '',
    onlyPath: typeof raw['only'] === 'string' ? raw['only'] : '',
    kinds: readList(raw['kinds'], NODE_KINDS),
    edgeKinds: EDGE_KINDS.filter((kind) => wanted.has(kind)),
    sinceMs: typeof raw['since'] === 'string' ? parseDuration(raw['since']) : 0,
    // A flag and nothing more: which base it compares against belongs to the
    // session, so a URL cannot narrow the view to a base nobody is looking at.
    onlyChanged: raw['changed'] === '1',
    // `tests=0`, the way a URL says "without": the default shows them, and the
    // key names what is being turned off.
    hideTests: raw['tests'] === '0',
  };
}

function readList<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (typeof raw !== 'string' || raw === '') return [];
  const wanted = new Set(raw.split(','));
  return allowed.filter((value) => wanted.has(value));
}

function readDepth(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DEPTH);
}

/** The wire shape of a group edit. Every field is user input. */
interface GroupAction {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  files?: unknown;
  color?: unknown;
  padding?: unknown;
  geometry?: unknown;
  locked?: unknown;
}

/**
 * One body, three verbs, and one place that decides what each of them means.
 * The helpers in `groups.ts` are pure and throw on anything they will not
 * store, so all that is left here is turning an unknown body into what they
 * take — and a throw is a 400 either way.
 */
function applyGroupAction(stored: readonly NamedGroup[], body: GroupAction): NamedGroup[] {
  const color = readColor(body.color);

  switch (body.action) {
    case 'create':
      return createManualGroup(stored, {
        name: typeof body.name === 'string' ? body.name : '',
        files: readStrings(body.files),
        ...(color === undefined ? {} : { color }),
      });

    case 'update': {
      const name = typeof body.name === 'string' ? body.name.trim() : undefined;
      // A rename to nothing leaves a frame with no label and no way to say which
      // one to rename back.
      if (name === '') throw new Error('a group needs a name');
      const padding = readPadding(body.padding);
      const geometry = readGeometry(body.geometry);
      if (body.locked !== undefined && typeof body.locked !== 'boolean') {
        throw new Error('locked must be a boolean');
      }
      const files = body.files === undefined ? undefined : readStrings(body.files);

      return updateGroup(stored, readId(body.id), {
        ...(name === undefined ? {} : { name }),
        ...(color === undefined ? {} : { color }),
        ...(padding === undefined ? {} : { padding }),
        ...(geometry === undefined ? {} : { geometry }),
        ...(body.locked === undefined ? {} : { locked: body.locked as boolean }),
        ...(files === undefined ? {} : { files }),
      });
    }

    case 'delete':
      return deleteGroup(stored, readId(body.id));

    default:
      throw new Error("action must be 'create', 'update' or 'delete'");
  }
}

function readId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw new Error('id must be a non-empty string');
  return raw;
}

function readStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value: unknown): value is string => typeof value === 'string');
}

/**
 * An unknown colour is refused rather than dropped: silently keeping the old one
 * looks to whoever asked like the request worked and the palette is broken.
 */
function readColor(raw: unknown): GroupColor | undefined {
  if (raw === undefined) return undefined;
  // A readonly GroupColor[] has no includes(string) overload, hence the widening.
  if (typeof raw !== 'string' || !(GROUP_COLORS as readonly string[]).includes(raw)) {
    throw new Error(`colour must be one of ${GROUP_COLORS.join(', ')}`);
  }
  return raw as GroupColor;
}

/** A hand-placed frame, in graph coordinates. Same NaN trap as the padding. */
function readGeometry(
  raw: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (raw === undefined) return undefined;
  const { x, y, width, height } = (raw ?? {}) as Record<string, unknown>;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) {
    throw new Error('geometry must be { x, y, width, height } in graph units');
  }
  // A frame with no area cannot be grabbed again to undo it.
  if (width < 40 || height < 30) throw new Error('a frame needs some size to it');
  return { x, y, width, height };
}

function readPadding(raw: unknown): { x: number; y: number } | undefined {
  if (raw === undefined) return undefined;
  const { x, y } = (raw ?? {}) as { x?: unknown; y?: unknown };
  // NaN passes a typeof check and then poisons every frame the layout draws.
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('padding must be { x, y } in pixels');
  }
  return { x, y };
}

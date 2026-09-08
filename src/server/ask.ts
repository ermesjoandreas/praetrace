import type { FastifyInstance } from 'fastify';
import type { GraphStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { AskCategory, AskContext, AskDeltaKind, AskEdge } from '../project/ask.js';
import type { MergedGroups } from '../project/groups.js';
import { NO_FILTER } from '../view/filter.js';
import { selectView } from '../view/select.js';
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
 * GET /api/ask — the conversation so far, and whether a turn is in flight.
 * POST /api/ask — ask, or end it.
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
  app.get('/api/ask', async () => {
    const session = current();
    return { conversation: session.askConversation(), running: session.askRunning() };
  });

  app.post('/api/ask', async (request, reply) => {
    const session = current();
    const body = (request.body ?? {}) as { action?: unknown; question?: unknown };

    if (body.action === 'end') return { ended: session.endAsk() };
    if (body.action !== 'ask') {
      return reply.code(400).send({ error: "action must be 'ask' or 'end'" });
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
    if (context.categories.length === 0) {
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

import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { GraphStore } from '../graph/store.js';
import type { FlowGraph } from '../parser/flow.js';
import type { ParserPool } from '../parser/pool.js';

/**
 * What the route needs of a session: the graph, to know the symbol; the root,
 * to find its file; the pool, because the flow is a parse and a parse never
 * runs on the main thread. Named here rather than as `Session` so this module
 * asks for exactly the three and `app.ts` can hand it `host.current()`.
 */
export interface FlowSession {
  readonly root: string;
  readonly store: GraphStore;
  readonly pool: ParserPool;
}

/**
 * The activity diagram of one symbol, or why there is none.
 *
 * `boxes` is on the answer so the page can warn before it draws: `derive` in
 * the graph store is 536 lines and over a hundred boxes, and a diagram that
 * size wants a word first. It counts every node, start and end included.
 */
export interface FlowReply {
  id: string;
  flow: FlowGraph | null;
  /** Why `flow` is null: a language without a table, a symbol without a body. */
  reason: string | null;
  boxes: number;
}

/**
 * GET /api/flow?id=<symbol id>
 *
 * A detail about one symbol, like /api/symbol, and not graph structure: the
 * graph holds that a function exists and what it reaches, never its branches.
 * The flow is read off the file as it is on disk right now, which is why there
 * is no `?at=` — a commit's files are unpacked, scanned and removed by
 * `project/history.ts`, so there is nothing on disk to read them from, and a
 * live flow under a commit's name would be the wrong picture that looks right.
 *
 * 404 for an id the graph has not got; 200 with `flow: null` and a reason for
 * one it has but cannot draw. The difference is the page's: one is a bad link,
 * the other is a sentence to print.
 */
export function registerFlowRoute(app: FastifyInstance, current: () => FlowSession): void {
  app.get('/api/flow', async (request, reply): Promise<FlowReply | { error: string }> => {
    const query = request.query as Record<string, unknown>;
    const id = typeof query['id'] === 'string' ? query['id'] : '';
    if (id === '') {
      return reply.code(400).send({ error: 'ask for one: ?id=, as path#Name or path#Class.method' });
    }
    if (typeof query['at'] === 'string' && query['at'].trim() !== '') {
      return reply.code(400).send({ error: 'flow is read from the working tree; a commit has no files on disk to read it from' });
    }

    const session = current();
    const node = session.store.graph.nodes.get(id);
    if (!node) return reply.code(404).send({ error: `nothing known about "${id}"` });

    // A class, an interface, a type or a file has no body of statements. A
    // field is let through for Java and C#, where `Runnable r = () -> {…}` is
    // listed as a field; TypeScript and JavaScript list that as a method, so
    // for them a field reaching here holds no function of its own. Either way
    // the worker answers only for a function that IS the symbol — never for a
    // callback inside its initialiser — and says so when there is none.
    if (node.kind === 'file' || node.kind === 'class' || node.kind === 'interface' || node.kind === 'type') {
      const hint = node.kind === 'class' ? ' — ask for one of its methods' : '';
      const article = node.kind === 'interface' ? 'an' : 'a';
      return { id, flow: null, reason: `${article} ${node.kind} has no flow${hint}`, boxes: 0 };
    }

    const answer = await session.pool.flow(node.filePath, path.join(session.root, node.filePath), node.range);
    if (answer.flow === null) return { id, flow: null, reason: answer.reason, boxes: 0 };
    return { id, flow: answer.flow, reason: null, boxes: answer.flow.nodes.length };
  });
}

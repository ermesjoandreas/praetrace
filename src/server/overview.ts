import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { GitStatus } from '../git/types.js';
import type { GraphStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { MergedGroups } from '../project/groups.js';
import { countUnreadable } from '../project/walk.js';
import { overviewOf, type Overview } from '../view/overview.js';
import type { AgentCall } from './session.js';

/**
 * What the route needs of a session, named here rather than as `Session` so
 * this module asks for exactly these and `app.ts` can hand it `host.current()`.
 * The store carries both the graph and the facts the scan gathered; the
 * groups are asked for on the way in, because nothing watches `.codemap/`.
 */
export interface OverviewSession {
  readonly root: string;
  readonly store: GraphStore;
  gitStatus(): GitStatus | null;
  agentCalls(): readonly AgentCall[];
  refreshGroups(): Promise<void>;
  clustersOf(graph: Graph): MergedGroups;
}

/** The front page, with the project it describes named on it. */
export interface OverviewReply extends Overview {
  root: string;
  name: string;
}

/**
 * GET /api/overview
 *
 * The front page in one fetch: what the project is, where it starts, what it
 * is made of, what changed and what the agent is doing — see view/overview.ts
 * for why that is a list and not a diagram.
 *
 * Live only. `?at=` is refused rather than answered from the wrong facts: a
 * commit's graph comes back from `Session.graphAt` without the `ProjectFacts`
 * that `project/history.ts` gathered beside it, and the manifest entry points
 * live in those facts. Answering with today's facts filtered to the commit's
 * files would be right for every page that existed then and still does, and
 * silently wrong for one deleted since — the mostly-right picture this tool
 * refuses to draw. The commit's own facts are one session change away, and
 * then this is a three-line branch.
 *
 * The unreadable census walks the tree on every request, as `/api/repo` does,
 * because the boot scan discards those files before anything counts them and
 * a remembered answer could not claim a file the agent has since added.
 */
export function registerOverviewRoute(app: FastifyInstance, current: () => OverviewSession): void {
  app.get('/api/overview', async (request, reply): Promise<OverviewReply | { error: string }> => {
    const query = request.query as Record<string, unknown>;
    if (typeof query['at'] === 'string' && query['at'].trim() !== '') {
      return reply.code(400).send({
        error: 'the front page is live only: a commit’s graph is served without the facts its entry points are read from',
      });
    }

    const session = current();
    const [unreadable] = await Promise.all([countUnreadable(session.root), session.refreshGroups()]);

    // Read once, after the awaits: the store swaps its graph on every save, and
    // the roots and the categories must be computed from the same one.
    const graph = session.store.graph;
    const overview = overviewOf(
      graph,
      session.store.facts,
      session.clustersOf(graph),
      session.gitStatus(),
      session.agentCalls(),
      unreadable,
    );
    return { root: session.root, name: path.basename(session.root), ...overview };
  });
}

import type { Coverage } from '../report/types.js';
import type { GitStatus } from '../git/types.js';
import type { GraphStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { MergedGroups } from '../project/groups.js';
import type { AgentCall, ExplainRun } from './session.js';
import { NO_FILTER } from '../view/filter.js';
import { selectView } from '../view/select.js';
import type { ViewSpec } from '../view/types.js';

/** The socket surface this hub needs, so it does not depend on the ws types. */
export interface LiveSocket {
  send(payload: string): void;
  readyState: number;
}

const OPEN = 1;

/** What a client is shown when it connects, and after a project switch. */
export const ROOT_SPEC: ViewSpec = {
  scope: '',
  focus: null,
  depth: 1,
  filter: NO_FILTER,
  at: null,
  diagram: 'classes',
};

export interface LiveHub {
  add(socket: LiveSocket, spec: ViewSpec): void;
  setSpec(socket: LiveSocket, spec: ViewSpec): void;
  remove(socket: LiveSocket): void;
  /**
   * Push a fresh view to every client. Each gets its own slice: a client looking
   * at one directory should not be handed another's.
   *
   * A client viewing a past commit is not pushed to at all. Nothing that
   * happens in the working tree changes what that commit looked like, and a
   * view recomputed from the live graph would quietly replace the commit with
   * now while the page still said otherwise. A frozen view is frozen.
   */
  publish(changedFiles: readonly string[]): void;
  /**
   * Announce a new project. Every stored spec names paths in the previous one,
   * so they are reset rather than carried over into a graph where they mean
   * nothing.
   */
  projectChanged(): void;
  /**
   * An agent asked something. The graph did not change, so this is its own
   * message rather than a view update nobody needs.
   *
   * The whole call, not the three fields a lookup has: a note carries what the
   * agent said and which files it said it about, the page reads both off this
   * frame, and a narrower type here described a wire that was already sending
   * them.
   */
  agentActed(call: AgentCall): void;
  /**
   * An explain run ended. It starts a minute or so after the request that asked
   * for it, so the page has no reply left open to learn the outcome on — and the
   * graph did not change, so this is its own message rather than a view update.
   */
  explainChanged(run: ExplainRun): void;
  /**
   * A few characters of an answer as it is written.
   *
   * Its own message rather than a run update: these arrive dozens of times a
   * second and carry no state, and putting them through the run would make
   * every client re-render its whole panel for three letters.
   */
  explainDelta(runId: string, text: string): void;
  /**
   * groups.json was written — by the page, or by the agent through MCP, which
   * is the one the page could not see: nothing watches `.codemap/`, so a name
   * given over MCP stood in the list unchanged until the next file save.
   *
   * Sent to every client, frozen ones included. A name lives outside the
   * commit — `/api/clusters?at=` pairs that commit's clusters with the names
   * as they are now — so a frame on last week's diagram wears the name it was
   * given today. Its own message rather than a view update: the graph did not
   * change, and the page refetches the clusters itself.
   *
   * With one exception: a component box wears the category's name, so a
   * client drawing components is pushed a fresh view as well, or an accepted
   * name would sit in the panel while the box beside it still read "8 files
   * together" until the next save. Not a frozen one — a frozen view is frozen,
   * and the page refuses `update` frames there.
   */
  groupsChanged(): void;
  clientCount(): number;
}

export function createLiveHub(
  getSession: () => {
    root: string;
    store: GraphStore;
    gitStatus(): GitStatus | null;
    coverage(): Coverage | null;
    clustersOf(graph: Graph): MergedGroups;
  },
): LiveHub {
  const clients = new Map<LiveSocket, ViewSpec>();

  const push = (
    socket: LiveSocket,
    spec: ViewSpec,
    changedFiles: readonly string[],
    type: 'update' | 'project',
  ): void => {
    if (socket.readyState !== OPEN) return;
    const session = getSession();
    const graph = session.store.graph;
    socket.send(
      JSON.stringify({
        type,
        root: session.root,
        // Recomputed per push, so a "changed in the last 5 minutes" filter keeps
        // meaning five minutes from now rather than five minutes from when it was set.
        // Coverage is taken, not read: this is synchronous by design, and the
        // session has already stamped the report on its way to publishing.
        // The categories the same way, and only for a client that reads them:
        // one drawing them as boxes, or one scoped to one of them.
        view: selectView(
          graph,
          spec,
          Date.now(),
          session.gitStatus(),
          session.coverage(),
          readsCategories(spec) ? session.clustersOf(graph).clusters : [],
        ),
        changedFiles,
      }),
    );
  };

  return {
    add(socket, spec) {
      clients.set(socket, spec);
    },

    setSpec(socket, spec) {
      if (!clients.has(socket)) return;
      clients.set(socket, spec);
    },

    remove(socket) {
      clients.delete(socket);
    },

    publish(changedFiles) {
      for (const [socket, spec] of clients) {
        if (spec.at !== null) continue;
        push(socket, spec, changedFiles, 'update');
      }
    },

    projectChanged() {
      for (const socket of [...clients.keys()]) clients.set(socket, ROOT_SPEC);
      for (const [socket, spec] of clients) push(socket, spec, [], 'project');
    },

    agentActed(call) {
      const payload = JSON.stringify({ type: 'agent', call });
      for (const socket of clients.keys()) {
        if (socket.readyState === OPEN) socket.send(payload);
      }
    },

    explainChanged(run) {
      const payload = JSON.stringify({ type: 'explain', run });
      for (const socket of clients.keys()) {
        if (socket.readyState === OPEN) socket.send(payload);
      }
    },

    explainDelta(runId, text) {
      const payload = JSON.stringify({ type: 'explain-delta', runId, text });
      for (const socket of clients.keys()) {
        if (socket.readyState === OPEN) socket.send(payload);
      }
    },

    groupsChanged() {
      const payload = JSON.stringify({ type: 'groups' });
      for (const socket of clients.keys()) {
        if (socket.readyState === OPEN) socket.send(payload);
      }
      for (const [socket, spec] of clients) {
        if (readsCategories(spec) && spec.at === null) push(socket, spec, [], 'update');
      }
    },

    clientCount() {
      return clients.size;
    },
  };
}

/**
 * Whether a view is built from the categories at all — drawn as boxes, or
 * scoped to one — and so must be handed them, and pushed again when the
 * names change: a category's membership can move on a groups.json write
 * as much as its name can, and a scope drawn from it is then a different
 * set of boxes.
 */
function readsCategories(spec: ViewSpec): boolean {
  return spec.diagram === 'components' || spec.category !== undefined;
}

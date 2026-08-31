import type { GraphStore } from '../graph/store.js';
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
export const ROOT_SPEC: ViewSpec = { scope: '', focus: null, depth: 1, filter: NO_FILTER };

export interface LiveHub {
  add(socket: LiveSocket, spec: ViewSpec): void;
  setSpec(socket: LiveSocket, spec: ViewSpec): void;
  remove(socket: LiveSocket): void;
  /**
   * Push a fresh view to every client. Each gets its own slice: a client looking
   * at one directory should not be handed another's.
   */
  publish(changedFiles: readonly string[]): void;
  /**
   * Announce a new project. Every stored spec names paths in the previous one,
   * so they are reset rather than carried over into a graph where they mean
   * nothing.
   */
  projectChanged(): void;
  clientCount(): number;
}

export function createLiveHub(getSession: () => { root: string; store: GraphStore }): LiveHub {
  const clients = new Map<LiveSocket, ViewSpec>();

  const push = (
    socket: LiveSocket,
    spec: ViewSpec,
    changedFiles: readonly string[],
    type: 'update' | 'project',
  ): void => {
    if (socket.readyState !== OPEN) return;
    const session = getSession();
    socket.send(
      JSON.stringify({
        type,
        root: session.root,
        // Recomputed per push, so a "changed in the last 5 minutes" filter keeps
        // meaning five minutes from now rather than five minutes from when it was set.
        view: selectView(session.store.graph, spec, Date.now()),
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
      for (const [socket, spec] of clients) push(socket, spec, changedFiles, 'update');
    },

    projectChanged() {
      for (const socket of [...clients.keys()]) clients.set(socket, ROOT_SPEC);
      for (const [socket, spec] of clients) push(socket, spec, [], 'project');
    },

    clientCount() {
      return clients.size;
    },
  };
}

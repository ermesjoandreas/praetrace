import type { GraphStore } from '../graph/store.js';
import { selectView } from '../view/select.js';
import type { ViewSpec } from '../view/types.js';

/** The socket surface this hub needs, so it does not depend on the ws types. */
export interface LiveSocket {
  send(payload: string): void;
  readyState: number;
}

const OPEN = 1;

export interface LiveHub {
  add(socket: LiveSocket, spec: ViewSpec): void;
  setSpec(socket: LiveSocket, spec: ViewSpec): void;
  remove(socket: LiveSocket): void;
  /**
   * Push a fresh view to every client. Each gets its own slice: a client looking
   * at one directory should not be handed another's.
   */
  publish(changedFiles: readonly string[]): void;
  clientCount(): number;
}

export function createLiveHub(store: GraphStore): LiveHub {
  const clients = new Map<LiveSocket, ViewSpec>();

  const push = (socket: LiveSocket, spec: ViewSpec, changedFiles: readonly string[]): void => {
    if (socket.readyState !== OPEN) return;
    socket.send(
      JSON.stringify({
        type: 'update',
        view: selectView(store.graph, spec),
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
      for (const [socket, spec] of clients) push(socket, spec, changedFiles);
    },

    clientCount() {
      return clients.size;
    },
  };
}

import type { GitStatus } from '../git/types.js';
import type { GraphStore } from '../graph/store.js';
import type { ExplainRun } from './session.js';
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
export const ROOT_SPEC: ViewSpec = { scope: '', focus: null, depth: 1, filter: NO_FILTER, at: null };

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
   */
  agentActed(call: { at: number; tool: string; target: string | null }): void;
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
  clientCount(): number;
}

export function createLiveHub(
  getSession: () => { root: string; store: GraphStore; gitStatus(): GitStatus | null },
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
    socket.send(
      JSON.stringify({
        type,
        root: session.root,
        // Recomputed per push, so a "changed in the last 5 minutes" filter keeps
        // meaning five minutes from now rather than five minutes from when it was set.
        view: selectView(session.store.graph, spec, Date.now(), session.gitStatus()),
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

    clientCount() {
      return clients.size;
    },
  };
}

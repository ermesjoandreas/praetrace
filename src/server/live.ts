import type { Coverage } from '../report/types.js';
import type { GitStatus } from '../git/types.js';
import type { GraphStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { MergedGroups } from '../project/groups.js';
import type { Attribution } from '../project/hook.js';
import type { AskDeltaKind } from '../project/ask.js';
import type { AgentCall, AskConversation, ExplainRun } from './session.js';
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
   *
   * A client drawing the structural diff is told, and handed no view. The
   * hub holds one graph and a diff is of two: the other is a commit's, built
   * through git and the session's cache, asynchronously, and answered by
   * `/api/view?diff=` together with the two ends the page reads a ghost's
   * panel from. A push is synchronous by design, and it used to compute the
   * whole root view for such a client — a slice with no `diff` in its echo,
   * which the page threw away and fetched the diff for. So the frame is the
   * signal and the files, and the page fetches from the one route that can
   * resolve both ends.
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
   * A turn of the categories conversation ended. The graph did not change, so
   * this is its own message, and the whole conversation rather than the turn:
   * a page that connected mid-answer has no transcript to append to, and the
   * cost so far lives on the conversation rather than on any one turn.
   */
  askChanged(conversation: AskConversation): void;
  /**
   * A few characters as they are written. Its own message for the reason
   * `explainDelta` is one: these arrive dozens of times a second and carry no
   * state, and putting them through the conversation would make every client
   * re-render the whole transcript for three letters.
   *
   * `kind` says whether they are the answer or the model still thinking, and
   * the page must draw the two apart — see `AskDeltaKind`. It is on the wire
   * rather than filtered here because the wait it covers is twelve seconds,
   * and a page with nothing to show for twelve seconds looks broken.
   */
  askDelta(conversationId: string, text: string, kind: AskDeltaKind): void;
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
    writtenBy(filePath: string): Attribution | null;
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
        // Who wrote them, for the ones anything said. Read off the session
        // rather than handed down through `main.ts`, so the wire from the
        // updater to the hub stays the one line it is; the session answers
        // about the file, which is the question a marked box asks.
        //
        // Only the files in this frame, and only the named ones: a client is
        // told who wrote what it is being asked to redraw, not handed a
        // register of the session. A path missing from it was written by
        // nobody we can name — see `Attribution`, where that absence is the
        // whole of what says so.
        by: attributionsFor(session, changedFiles),
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
        if (spec.diff !== undefined) {
          // The signal and the files, and no view — see `publish` above.
          if (socket.readyState === OPEN) {
            // The same `by` the `update` frame carries: a diff client draws the
            // same files and asks the same question of them.
            const session = getSession();
            socket.send(
              JSON.stringify({
                type: 'changed',
                root: session.root,
                changedFiles,
                by: attributionsFor(session, changedFiles),
              }),
            );
          }
          continue;
        }
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

    askChanged(conversation) {
      const payload = JSON.stringify({ type: 'ask', conversation });
      for (const socket of clients.keys()) {
        if (socket.readyState === OPEN) socket.send(payload);
      }
    },

    askDelta(conversationId, text, kind) {
      const payload = JSON.stringify({ type: 'ask-delta', conversationId, text, kind });
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
 * The named writers among these files, keyed by path, or undefined when
 * nothing named any of them.
 *
 * Undefined rather than `{}` so that "nobody said" costs no bytes on the wire
 * and reads as absent on the page, which is what it is. Every push a watcher
 * caused looks exactly like this.
 */
function attributionsFor(
  session: { writtenBy(filePath: string): Attribution | null },
  changedFiles: readonly string[],
): Record<string, Attribution> | undefined {
  const by: Record<string, Attribution> = {};
  let any = false;
  for (const filePath of changedFiles) {
    const source = session.writtenBy(filePath);
    if (source !== null) {
      by[filePath] = source;
      any = true;
    }
  }
  return any ? by : undefined;
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

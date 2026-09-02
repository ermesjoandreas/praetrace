import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitStatus } from '../git/types.js';
import { applyBatch, createStore, setProjectFacts, type GraphStore } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
import { readGitStatus } from '../project/git.js';
import { scanProject } from '../project/scan.js';
import { createUpdater } from '../project/updater.js';
import { watchProject, type FileChange } from '../project/watch.js';

/**
 * One thing the agent asked codemap. Kept beside the change log because the
 * order between them is the interesting part: an agent looks a file up, then
 * edits it, and seeing the lookup explains the edit.
 */
export interface AgentCall {
  at: number;
  tool: string;
  /** What it asked about — a path, a query — when the tool had one. */
  target: string | null;
}

/** One batch of files that changed together, newest last. */
export interface ChangeEntry {
  at: number;
  files: string[];
}

/**
 * Deliberately in memory and deliberately short. This answers "what has the
 * agent been doing while I was away", which is the whole premise; it is not
 * session history. That is VISION.md phase 1, and it gets a schema designed for
 * it rather than a ring buffer promoted into one.
 */
const MAX_HISTORY = 200;

/**
 * A commit changes the status of every file without touching one, and the
 * watcher cannot see it happen: `walk.ts` ignores every dotted directory, so
 * `.git` is never watched. A poll is the only way to notice, and three seconds
 * is well under the time it takes to look back at the window.
 */
const GIT_POLL_MS = 3000;

/**
 * Everything scoped to one project root: the graph, the workers that build it,
 * and the watcher feeding it.
 *
 * Switching projects opens a new session and closes the old one, rather than
 * resetting the pieces in place. Nothing is shared, so nothing can leak — the
 * store, the pool and the watcher are all discarded together, and a stale parse
 * has nowhere to write.
 */
export interface Session {
  readonly root: string;
  readonly store: GraphStore;
  /** Queue a change from any source. The hook endpoint uses this. */
  queue(change: FileChange): void;
  /** What has changed since this project was opened, newest last. */
  history(): readonly ChangeEntry[];
  /** What the agent has asked, newest last. */
  agentCalls(): readonly AgentCall[];
  recordAgentCall(call: AgentCall): void;
  /** The working tree against the base, or null when this is not a repository. */
  gitStatus(): GitStatus | null;
  /** What was asked for, which is not always what git could resolve. */
  gitBase(): string;
  setGitBase(base: string): Promise<GitStatus | null>;
  /** Re-reads git; true when the answer differs from the one being served. */
  refreshGit(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SessionHandlers {
  onApplied: (changedFiles: string[]) => void;
  onError: (message: string) => void;
  /** Something outside the working tree moved — a commit, a checkout, a stash. */
  onGitChanged: () => void;
}

async function openSession(root: string, handlers: SessionHandlers): Promise<Session> {
  const pool = createParserPool();
  const store = createStore();

  const scan = await scanProject(pool, root);
  // Before the files, not after: an alias table arriving second is a second
  // derivation of the whole graph for the same answer.
  setProjectFacts(store, scan.facts);
  applyBatch(store, scan.parsed, []);
  for (const failure of scan.failures) handlers.onError(failure);

  const history: ChangeEntry[] = [];
  const agent: AgentCall[] = [];

  // Read here rather than on the first request: the first view a client is sent
  // should already know what differs from the base. A project that is not a
  // repository answers null, which is an ordinary answer and not a failure to
  // open — a scratch directory is exactly as valid a project as this one.
  let requested = 'HEAD';
  let status = await readGitStatus(root, requested);
  let key = statusKey(status);
  let closed = false;

  /**
   * Reads are queued behind one another rather than sharing the one in flight:
   * `setGitBase` changes the question being asked, so handing it the answer
   * already on its way would report the old base under the new name.
   */
  let reading: Promise<boolean> = Promise.resolve(false);

  function refreshGit(): Promise<boolean> {
    reading = reading.then(readGit);
    return reading;
  }

  async function readGit(): Promise<boolean> {
    const next = await readGitStatus(root, requested);
    // The session can be closed while git is answering — a project switch tears
    // it down mid read — and a status nobody will serve is not a change.
    if (closed) return false;

    const nextKey = statusKey(next);
    if (nextKey === key) return false;
    status = next;
    key = nextKey;
    return true;
  }

  const poll = setInterval(() => {
    void refreshGit().then((changed) => {
      if (changed && !closed) handlers.onGitChanged();
    });
  }, GIT_POLL_MS);
  // Nothing about a poll is worth keeping the process alive for: the CLI has to
  // exit on ^C and the sidecar has to go away when the shell closes its stdin.
  poll.unref();

  const updater = createUpdater({
    store,
    pool,
    onApplied: (changedFiles) => {
      // Recorded before anything is published, so a client that reloads mid
      // burst still sees the change it just missed.
      history.push({ at: Date.now(), files: changedFiles });
      if (history.length > MAX_HISTORY) history.shift();
      // git is re-read before the publish, not after it: the view about to be
      // sent carries each file's status, and one computed from the previous
      // read would show the edit without showing that it is now a change.
      void refreshGit().then(() => {
        // The updater refuses to publish after close, but the await above
        // reopens that window.
        if (!closed) handlers.onApplied(changedFiles);
      });
    },
    onError: handlers.onError,
  });
  const watcher = watchProject({ root, onChange: (change) => updater.queue(change) });

  return {
    root,
    store,
    queue: (change) => updater.queue(change),
    history: () => history,
    agentCalls: () => agent,
    recordAgentCall: (call) => {
      agent.push(call);
      if (agent.length > MAX_HISTORY) agent.shift();
    },
    gitStatus: () => status,
    gitBase: () => requested,
    async setGitBase(base) {
      requested = base;
      await refreshGit();
      return status;
    },
    refreshGit,
    async close() {
      closed = true;
      clearInterval(poll);
      updater.close();
      await Promise.allSettled([watcher.close(), pool.close()]);
    },
  };
}

/**
 * Whether two reads say the same thing. Identity cannot answer that — every read
 * builds a fresh object — and without an answer the poll would push a view to
 * every client every three seconds.
 *
 * The entries are sorted because their order is git's output order, which is not
 * something git promises; a reordering is not a change anyone made.
 */
function statusKey(status: GitStatus | null): string {
  if (!status) return '';
  const files = Object.entries(status.files).sort(([a], [b]) => (a < b ? -1 : 1));
  return JSON.stringify([status.base, status.requested, status.branch, files]);
}

export interface SessionHost {
  current(): Session;
  switchTo(root: string): Promise<Session>;
  close(): Promise<void>;
}

export function createSessionHost(initial: Session, handlers: SessionHandlers): SessionHost {
  let session = initial;
  /** Serialises switches, so two rapid picks cannot interleave their teardown. */
  let pending: Promise<Session> = Promise.resolve(initial);

  return {
    current: () => session,

    async switchTo(root) {
      const resolved = await resolveProjectRoot(root);

      pending = pending.then(async () => {
        if (resolved === session.root) return session;

        // The new session is built before the old one is torn down, so a failure
        // to open leaves the previous project intact and serving.
        const next = await openSession(resolved, handlers);
        const previous = session;
        session = next;
        await previous.close();
        return next;
      });

      return pending;
    },

    async close() {
      await pending.catch(() => undefined);
      await session.close();
    },
  };
}

export async function startSessionHost(root: string, handlers: SessionHandlers): Promise<SessionHost> {
  const resolved = await resolveProjectRoot(root);
  return createSessionHost(await openSession(resolved, handlers), handlers);
}

/** A project root is user input, from a CLI argument or a folder picker. */
export async function resolveProjectRoot(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const stats = await stat(resolved).catch(() => null);
  if (!stats) throw new Error(`no such directory: ${resolved}`);
  if (!stats.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}

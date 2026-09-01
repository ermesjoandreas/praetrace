import { stat } from 'node:fs/promises';
import path from 'node:path';
import { applyBatch, createStore, type GraphStore } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
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
  close(): Promise<void>;
}

export interface SessionHandlers {
  onApplied: (changedFiles: string[]) => void;
  onError: (message: string) => void;
}

async function openSession(root: string, handlers: SessionHandlers): Promise<Session> {
  const pool = createParserPool();
  const store = createStore();

  const scan = await scanProject(pool, root);
  applyBatch(store, scan.parsed, []);
  for (const failure of scan.failures) handlers.onError(failure);

  const history: ChangeEntry[] = [];
  const agent: AgentCall[] = [];

  const updater = createUpdater({
    store,
    pool,
    onApplied: (changedFiles) => {
      // Recorded before anything is published, so a client that reloads mid
      // burst still sees the change it just missed.
      history.push({ at: Date.now(), files: changedFiles });
      if (history.length > MAX_HISTORY) history.shift();
      handlers.onApplied(changedFiles);
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
    async close() {
      updater.close();
      await Promise.allSettled([watcher.close(), pool.close()]);
    },
  };
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

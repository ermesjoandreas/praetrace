import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { GitStatus } from '../git/types.js';
import { applyBatch, createStore, setProjectFacts, type GraphStore } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
import {
  explain,
  readExplanations,
  writeExplanations,
  type ExplainOutcome,
  type ExplainTarget,
  type Explanation,
} from '../project/explain.js';
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

/** Why a run ended with no answers, in the words `explain()` reports them. */
/**
 * Every way a run can end badly. 'unsaved' is the one the explainer itself
 * cannot report: the answers arrived and were paid for, and then the project
 * would not take them.
 */
export type ExplainFailure = Extract<ExplainOutcome, { ok: false }>['reason'] | 'unsaved';

/**
 * One press of the explain button.
 *
 * A run is a minute or more of subprocess, which is far longer than a browser
 * will hold a fetch open, so it outlives the request that started it: the POST
 * answers with this and the same object is pushed again when it ends. That is
 * also why a failure lives *in* it rather than in a status code — the request
 * was fine, the run was not, and only one of those is an HTTP error.
 *
 * Nothing here is stored. A run belongs to the session, like the change feed;
 * the answers it produced are what gets written to the project.
 */
export interface ExplainRun {
  id: string;
  at: number;
  /** What was asked about, so the panel can mark exactly those rows running. */
  ids: string[];
  state: 'running' | 'done' | 'failed' | 'cancelled';
  finishedAt?: number;
  /** What it cost the user. Present only on a run that produced answers. */
  costUsd?: number;
  ms?: number;
  reason?: ExplainFailure;
  detail?: string;
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
  /** Everything this project has had explained, as last read or written. */
  explanations(): readonly Explanation[];
  /** The run in flight, or the last one to end. Null until the first press. */
  explainRun(): ExplainRun | null;
  /**
   * Start one, or refuse: one press, one subprocess. `onEnded` fires once, with
   * the same run object this returned, and not at all once the session is closed.
   */
  startExplain(
    targets: ExplainTarget[],
    onEnded: (run: ExplainRun) => void,
    onDelta?: (text: string) => void,
  ): ExplainRun | null;
  /** Abandon the run in flight. True when there was one. */
  cancelExplain(): boolean;
  /** Drop one stored explanation. True when it was there to drop. */
  forgetExplanation(id: string): Promise<boolean>;
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

  // Read with the project for the same reason git is: the panel asks on its
  // first render, and a project that has been explained before should not have
  // to spend a run to say so. A missing or unparseable file is an empty list,
  // never a failure to open.
  let explanations = await readExplanations(root);
  let run: ExplainRun | null = null;

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

  /**
   * Record what a finished run produced, and put it where it survives a restart.
   *
   * The answers are held in memory before they are written, and a write that
   * fails is reported rather than raised: the user has already paid for these
   * words, so a read-only project loses the file, not the answers.
   */
  async function settle(finished: ExplainRun, outcome: ExplainOutcome): Promise<void> {
    finished.finishedAt = Date.now();

    if (!outcome.ok) {
      finished.state = 'failed';
      finished.reason = outcome.reason;
      finished.detail = outcome.detail;
      return;
    }

    const merged = mergeExplanations(explanations, outcome.explanations);
    finished.costUsd = outcome.costUsd;
    finished.ms = outcome.ms;

    try {
      await writeExplanations(root, merged);
      explanations = merged;
      finished.state = 'done';
    } catch (error) {
      // The words arrived and the money is spent, but they are not on disk — so
      // they will be gone at the next restart. Reporting 'done' here would show
      // the reader a paid-for answer the project never kept. The answers are
      // still held in memory so nothing is thrown away in the meantime.
      explanations = merged;
      finished.state = 'failed';
      finished.reason = 'unsaved';
      finished.detail = error instanceof Error ? error.message : String(error);
      handlers.onError(`could not write .codemap/explain.json: ${finished.detail}`);
    }
  }

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

    explanations: () => explanations,
    explainRun: () => run,

    startExplain(targets, onEnded, onDelta) {
      if (run?.state === 'running') return null;

      const started: ExplainRun = {
        id: `run-${Date.now().toString(36)}`,
        at: Date.now(),
        ids: targets.map((target) => target.id),
        state: 'running',
      };
      run = started;

      void explain(targets, {
        // Forwarded only while this run is still the one in flight: a cancelled
        // run's words arriving in the panel would be a ghost typing.
        ...(onDelta === undefined
          ? {}
          : { onDelta: (text: string) => { if (!closed && started.state === 'running') onDelta(text); } }),
      }).then(async (outcome) => {
        // A cancelled run, or one whose project has been switched away from,
        // must not write: its answers describe a project nobody is looking at,
        // and `.codemap/explain.json` would gain them behind the user's back.
        if (closed || started.state !== 'running') return;
        await settle(started, outcome);
        if (!closed) onEnded(started);
      });

      return started;
    },

    cancelExplain() {
      // The subprocess is abandoned rather than killed — `explain` takes no
      // signal — so this stops the answer being used, not the money being spent.
      if (run?.state !== 'running') return false;
      run.state = 'cancelled';
      run.finishedAt = Date.now();
      return true;
    },

    async forgetExplanation(id) {
      const next = explanations.filter((entry) => entry.id !== id);
      if (next.length === explanations.length) return false;
      explanations = next;
      await writeExplanations(root, next);
      return true;
    },

    async close() {
      closed = true;
      // What aborting a run amounts to here: the answer is refused, and the run
      // says so rather than being left reading 'running' for ever.
      if (run?.state === 'running') {
        run.state = 'cancelled';
        run.finishedAt = Date.now();
      }
      clearInterval(poll);
      updater.close();
      await Promise.allSettled([watcher.close(), pool.close()]);
    },
  };
}

/**
 * The stored list with a run's answers folded in, newest wins.
 *
 * Sorted by id so a file that is committed does not reorder itself according to
 * which symbols happened to be explained together, which would put a diff in
 * front of a reviewer for a run that added one line.
 */
function mergeExplanations(
  stored: readonly Explanation[],
  fresh: readonly Explanation[],
): Explanation[] {
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  for (const entry of fresh) byId.set(entry.id, entry);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
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

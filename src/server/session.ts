import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Coverage } from '../report/types.js';
import type { GitStatus } from '../git/types.js';
import { applyBatch, createStore, setProjectFacts, type GraphStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import { createParserPool, type ParserPool } from '../parser/pool.js';
import type { Attribution } from '../project/hook.js';
import { ask, type AskContext, type AskDeltaKind, type AskFailure } from '../project/ask.js';
import { coverageStamp, readCoverage } from '../project/coverage.js';
import {
  explain,
  readExplanations,
  writeExplanations,
  type ExplainOutcome,
  type ExplainTarget,
  type Explanation,
} from '../project/explain.js';
import { readGitStatus, resolveCommit } from '../project/git.js';
import { mergeGroups, readGroups, type MergedGroups, type NamedGroup } from '../project/groups.js';
import { graphAt as buildGraphAt } from '../project/history.js';
import { scanProject } from '../project/scan.js';
import {
  suggestNames,
  type SuggestOutcome,
  type SuggestTarget,
  type Suggestion,
} from '../project/suggest.js';
import { createUpdater } from '../project/updater.js';
import { watchProject, type FileChange } from '../project/watch.js';
import { clusterFiles } from '../view/cluster.js';

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
  /**
   * Which agent asked, when the MCP client named itself at initialize —
   * `claude-code`, `cursor-vscode`, whatever it calls itself. Absent when it
   * did not, and never inferred: this is the client's own `clientInfo.name`
   * passed straight through, the same standing as a hook payload's declared
   * `agent`. See `Attribution`.
   */
  agent?: string;
  /**
   * The agent's own words about what it just changed, when it left any.
   *
   * Every other entry here is a question codemap answered; this is the one the
   * agent volunteered, through `note_change`. It rides the same ring because
   * the order is the point — a note belongs between the lookups that led to an
   * edit and the edit itself, not in a list of its own.
   *
   * Session memory, and deliberately. A note is an event, not a decision: it
   * says what happened at 14:12, and nothing about the project is different
   * because of it. Persisted session history is VISION.md phase 1 and gets a
   * schema designed for it rather than this ring promoted into one.
   */
  note?: string;
  /** Which files the note is about, when it is a note. */
  files?: string[];
}

/** One batch of files that changed together, newest last. */
export interface ChangeEntry {
  at: number;
  files: string[];
  /**
   * Who claimed the files in this batch anybody claimed, keyed by path. A file
   * in `files` and not in here was written by nobody we can name — see
   * `Attribution`, and the absence is deliberately the whole of what says so.
   *
   * Per file rather than per batch because a batch can hold both: the hook
   * names one file while the watcher is the only thing that saw another, and
   * one name over the pair would be wrong about half of it.
   *
   * A plain object rather than a Map: this is served as JSON by
   * `GET /api/changes`, and a Map serialises to `{}`.
   */
  by?: Record<string, Attribution>;
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
 * What the last press of Suggest produced, when it produced anything.
 *
 * Session state and nothing more. A suggestion is a model's guess at what a
 * group is called, and decision 5 says it stays a guess until a person accepts
 * it — accepting is what writes groups.json, and nothing here does. It is kept
 * at all so a reload, or a second tab, is shown the list that was paid for
 * rather than asked to pay again; it goes with the session, never to disk.
 */
export interface SuggestResult {
  ok: true;
  /** When the button was pressed, as `ExplainRun.at` is. */
  at: number;
  suggestions: Suggestion[];
  costUsd: number;
  ms: number;
}

/**
 * One question and the answer to it.
 *
 * `answer` grows as the words arrive rather than being set at the end: the
 * deltas go to the socket for the page that is watching, and this is what a
 * page that reloaded halfway through reads instead. A turn that failed keeps
 * whatever words it got — the money is spent either way, and half an answer
 * is worth more than the sentence that replaced it.
 */
export interface AskTurn {
  at: number;
  question: string;
  answer: string;
  /**
   * What the model is working through, while it is working through it.
   *
   * Kept only while the turn runs and dropped the moment the answer lands:
   * measured, haiku thinks for about twelve seconds before it writes a word,
   * and a page with nothing to draw for twelve seconds is the unmoving
   * spinner this feature streams to avoid. It is never the answer and is
   * never stored as one — see `AskDeltaKind`.
   */
  thinking?: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  finishedAt?: number;
  /** What this turn cost. Present once it has ended and produced words. */
  costUsd?: number;
  ms?: number;
  /**
   * Wall clock from the press to the first characters on screen, and to the
   * first character of the answer itself.
   *
   * Reported apart from `ms` because they are the numbers a person actually
   * experiences: a whole answer takes as long as explain's does, and whether
   * this feels fast is decided entirely by these two.
   */
  firstTokenMs?: number;
  firstAnswerMs?: number;
  reason?: AskFailure;
  detail?: string;
}

/**
 * A conversation about the categories, held for this session and no longer.
 *
 * Session state, like a suggest run and for the same reason: nothing a model
 * says is a fact about the project, so nothing here is written to
 * `.codemap/`. A project switch opens a new session, which has no
 * conversation — a follow-up about the previous project would be answered
 * against the wrong categories, and that is exactly the confidently wrong
 * answer this tool exists not to give.
 *
 * `sessionId` is the CLI's, and it is the whole of what makes a follow-up a
 * follow-up: the transcript lives in the CLI's own store, so resuming costs a
 * question rather than the categories again — measured on eleven categories,
 * $0.0112 against $0.0257.
 *
 * It is recorded only from a turn that answered. A turn that timed out or was
 * killed carries no session out with it, even though the CLI named one on its
 * first line, so the next question sends the categories again and starts a
 * fresh conversation on the CLI's side. That costs a first turn's price and
 * loses what was said before it — the alternative is resuming a session whose
 * last exchange is half an answer, and paying to be confused.
 */
export interface AskConversation {
  id: string;
  at: number;
  sessionId: string | null;
  turns: AskTurn[];
  /** Every turn added up: what this conversation has cost so far. */
  costUsd: number;
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
 * How many past commits' graphs to keep. A build costs an archive, a scan and a
 * derivation — around a tenth of a second here, seconds on a big repository —
 * so stepping back and forth through the log must not pay it twice. Sixteen
 * covers a session of clicking around the graph; a whole history would not fit.
 */
const MAX_PAST_GRAPHS = 16;

/**
 * How long a name survives an unattributed change to the same file.
 *
 * One edit reaches this tool twice — the hook says so and the watcher sees it —
 * and which arrives first is not decidable. Measured against a real Claude Code
 * payload on this machine: the file was written, chokidar fired 46 ms later,
 * the 80 ms debounce flushed that as its own batch, and the hook's POST landed
 * at 84 ms and became a second one. Two batches 112 ms apart for one edit, in
 * either order depending on how busy the tree is.
 *
 * So a change naming nobody, arriving within this of a change that named
 * somebody, is treated as the second sighting of that one edit rather than as
 * evidence that the name is now wrong. It is a rule about pairing events, not
 * about who wrote the file: it can never invent a name, only decline to forget
 * one for a moment.
 *
 * A second is nine times the measured spread and still two orders of magnitude
 * short of a person opening an editor, which is the case it must not swallow —
 * a hand edit seconds after the agent's correctly drops the agent's name. The
 * cost, stated plainly: a human save inside the same second as an agent's, on
 * the same file, keeps the agent's name.
 */
const ATTRIBUTION_GRACE_MS = 1000;

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
  /**
   * The parser workers, exposed so the flow of one function — a parse — runs
   * off the main thread like every other parse, through the same queue.
   */
  readonly pool: ParserPool;
  /**
   * Queue a change from any source. The hook endpoint uses this, and it is the
   * only caller that can pass `by`: see `Attribution`.
   */
  queue(change: FileChange, by?: Attribution | null): void;
  /** What has changed since this project was opened, newest last. */
  history(): readonly ChangeEntry[];
  /**
   * Who wrote this file, as of the last change that landed on it — null when
   * that change named nobody, and null for a file nothing has touched this
   * session.
   *
   * This is what the live push reads, so a box can be marked with a name
   * without the socket frame having to be handed one through `main.ts`. It
   * answers about the file rather than about the batch, which is the question
   * a box on the canvas asks.
   */
  writtenBy(filePath: string): Attribution | null;
  /** What the agent has asked, newest last. */
  agentCalls(): readonly AgentCall[];
  recordAgentCall(call: AgentCall): void;
  /**
   * How many hook payloads this session answered, and how many named nothing
   * it could use.
   *
   * Counted because "installed" is a claim about a settings file and not about
   * anything having arrived. A review ran end to end with the Repository panel
   * reading "Hook ✓ installed" while all five calls answered
   * `{"accepted":false}` — the root was one symlink off, so every path landed
   * outside the project. `changeFromHook` no longer makes that particular
   * mistake; this is what shows the next one, whatever its cause.
   *
   * Session-scoped, like the change feed: a switch opens a new project, and a
   * count of what the previous root refused says nothing about this one.
   */
  hookCalls(): { accepted: number; refused: number };
  recordHookCall(accepted: boolean): void;
  /** The working tree against the base, or null when this is not a repository. */
  gitStatus(): GitStatus | null;
  /** What was asked for, which is not always what git could resolve. */
  gitBase(): string;
  setGitBase(base: string): Promise<GitStatus | null>;
  /** Re-reads git; true when the answer differs from the one being served. */
  refreshGit(): Promise<boolean>;
  /** What the test report says the suite ran, or null when the project has none. */
  coverage(): Coverage | null;
  /**
   * Re-read the report, if it has been rewritten since the last read.
   *
   * Three stats, and the 4.7 ms read only when one of them moved. Awaited
   * before a view is built rather than after, so the numbers a client is sent
   * are the ones this just checked.
   */
  refreshCoverage(): Promise<void>;
  /**
   * The project's graph as of one commit, or null when the sha is not one this
   * repository knows. Built on demand and remembered; two asks for the same
   * commit while it is being built share the one build.
   */
  graphAt(sha: string): Promise<Graph | null>;
  /** The names in .codemap/groups.json, as last read or written. */
  groups(): readonly NamedGroup[];
  /**
   * Re-read them. Nothing watches `.codemap/`, so a name given over MCP or by
   * hand is invisible until something asks; the routes that write the file ask
   * on the way out, and a view that draws the names asks on the way in.
   */
  refreshGroups(): Promise<void>;
  /**
   * What `/api/clusters` answers for a graph: its clusters, wearing the stored
   * names. Synchronous, because the live push is, and it is the push that
   * redraws a component diagram after a save. The graph is an argument rather
   * than assumed live, so a frozen diagram gets its commit's clusters.
   */
  clustersOf(graph: Graph): MergedGroups;
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
  /** The last suggest run that produced names. Null until one does. */
  lastSuggest(): SuggestResult | null;
  /**
   * Whether a suggest run is in flight. The page could not ask this before,
   * so a tab that lost the held fetch — a reload, a second window — showed
   * "Suggesting…" until it was reloaded, or nothing while money was being spent.
   */
  suggestRunning(): boolean;
  /**
   * Ask a model what the unnamed groups are called, or refuse: one press, one
   * subprocess, so null while a run is in flight. Awaited rather than reported
   * later, unlike explain — a single call fits inside a held fetch, and the
   * outcome is the answer to the request that asked.
   */
  suggest(
    targets: SuggestTarget[],
    named: { name: string; files: string[] }[],
  ): Promise<SuggestResult | Extract<SuggestOutcome, { ok: false }>> | null;
  /** The conversation this session is holding, or null before the first question. */
  askConversation(): AskConversation | null;
  /** Whether a turn is in flight. One press, one subprocess, as everywhere here. */
  askRunning(): boolean;
  /**
   * Ask a question about the categories, or refuse while a turn is in flight.
   *
   * The context is handed in on every turn and used only when there is no CLI
   * session to resume: whether this is a first turn or a follow-up is the
   * session's fact and not the caller's, and a first turn that failed before
   * the CLI named a session must still be able to send the categories again.
   *
   * Answers immediately with the conversation carrying the running turn. The
   * answer itself takes far longer than a browser holds a fetch open, so it
   * arrives through `onDelta` as it is written and `onEnded` when it is done —
   * neither fires once the session is closed.
   */
  startAsk(
    question: string,
    context: AskContext,
    onDelta: (text: string, kind: AskDeltaKind) => void,
    onEnded: (conversation: AskConversation) => void,
  ): AskConversation | null;
  /** Throw the conversation away. True when there was one. */
  endAsk(): boolean;
  close(): Promise<void>;
}

export interface SessionHandlers {
  /**
   * Deliberately not widened to carry the attribution. `main.ts` wires this
   * straight into `hub.publish`, and the hub already reads the session — so the
   * name reaches the socket through `writtenBy`, and this stays the one-line
   * wire it is.
   */
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

  /**
   * Who last wrote each file, for the files anything named — and when.
   *
   * Unbounded on purpose, and it costs nothing: it can only ever hold one entry
   * per file the project has, and `store.files` is already holding every one of
   * those.
   */
  const writers = new Map<string, { by: Attribution; at: number }>();

  // Two numbers rather than a log: nothing on screen asks which payload was
  // refused, only whether any were. See Session.hookCalls.
  const hook = { accepted: 0, refused: 0 };

  // Read here rather than on the first request: the first view a client is sent
  // should already know what differs from the base. A project that is not a
  // repository answers null, which is an ordinary answer and not a failure to
  // open — a scratch directory is exactly as valid a project as this one.
  let requested = 'HEAD';
  let status = await readGitStatus(root, requested);
  let key = statusKey(status);
  let closed = false;

  // Held rather than read per view, because the live push happens on every
  // save and 4.7 ms of lcov is time the pulse does not have. Noticed by stamp
  // rather than by the watcher: `coverage/` is an ignored directory, so a
  // finished test run is as invisible here as a commit is — the same blindness
  // that makes git a poll.
  //
  // What holding it costs: between two stamps the numbers describe the file as
  // the suite found it, so a symbol added since reads as unmeasured and one
  // that moved keeps the answer joined at the line it used to be on. Both are
  // the report being older than the code, not the cache being older than the
  // report, and re-joining would only pin yesterday's counts to today's line
  // numbers — the same staleness wearing a fresher look.
  //
  // Stamped before it is read, so a report written between the two is caught
  // by the next stamp rather than held under a stamp that says it is current.
  let coverageStampValue = await coverageStamp(root);
  let coverage = await readCoverage(root, store.graph);

  // Read with the project for the same reason git is: the panel asks on its
  // first render, and a project that has been explained before should not have
  // to spend a run to say so. A missing or unparseable file is an empty list,
  // never a failure to open.
  let explanations = await readExplanations(root);
  let run: ExplainRun | null = null;

  // Held for the same reason coverage is: a component diagram is pushed on
  // every save, and the push is synchronous. A missing or unparseable file is
  // an empty list, as it is everywhere else.
  let groups = await readGroups(root);

  let lastSuggest: SuggestResult | null = null;
  let suggesting = false;

  // Held for exactly as long as the project is open. See `AskConversation`.
  let conversation: AskConversation | null = null;

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

  /**
   * Queued behind one another like the git reads, and for a sharper reason: the
   * stamp and the numbers it stands for are one pair, and two reads landing out
   * of order would file the older report under the newer stamp and keep it
   * there until the next run.
   */
  let readingCoverage: Promise<void> = Promise.resolve();

  function refreshCoverage(): Promise<void> {
    readingCoverage = readingCoverage.then(readCoverageIfWritten);
    return readingCoverage;
  }

  async function readCoverageIfWritten(): Promise<void> {
    const stamp = await coverageStamp(root);
    if (stamp === coverageStampValue || closed) return;

    const next = await readCoverage(root, store.graph);
    // The session can be closed while the report is being read, exactly as it
    // can while git is answering, and numbers nobody will serve are not news.
    if (closed) return;
    coverageStampValue = stamp;
    coverage = next;
  }

  /**
   * Queued like the other two reads, and the write routes await one before
   * they announce: two reads landing out of order across a write would keep
   * the older names under the newer announcement.
   */
  let readingGroups: Promise<void> = Promise.resolve();

  function refreshGroups(): Promise<void> {
    readingGroups = readingGroups.then(async () => {
      const next = await readGroups(root);
      if (!closed) groups = next;
    });
    return readingGroups;
  }

  /**
   * Computed per call and not cached: label propagation over this
   * repository's 139 files and 3 905 edges measures 0.73 ms, and the merge
   * 0.10 ms, so a push to every component-diagram client after a save costs
   * less than the view it draws. A cache keyed on the graph would be correct —
   * `store.graph` is a fresh object per derivation — and would be paying for
   * a cost nobody has measured.
   */
  function clustersOf(graph: Graph): MergedGroups {
    return mergeGroups(clusterFiles(graph), groups);
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
    root,
    onApplied: (changedFiles, by) => {
      const at = Date.now();

      // Who wrote each file now, before the entry is built from it. A change
      // that named nobody clears the previous name rather than leaving it
      // standing — a hand edit to a file the agent wrote last is not the
      // agent's, and a stale name is the one failure here that is a lie rather
      // than a gap. `ATTRIBUTION_GRACE_MS` is the single exception, and it says
      // why.
      for (const filePath of changedFiles) {
        const named = by.get(filePath);
        if (named !== undefined) writers.set(filePath, { by: named, at });
        else if (at - (writers.get(filePath)?.at ?? 0) > ATTRIBUTION_GRACE_MS) {
          writers.delete(filePath);
        }
      }

      // Recorded before anything is published, so a client that reloads mid
      // burst still sees the change it just missed. The names are the batch's
      // own, not the map's: the feed is a record of what happened at 14:12, so
      // a later edit by someone else must not rewrite who did this one.
      const named = Object.fromEntries(by);
      history.push({
        at,
        files: changedFiles,
        ...(Object.keys(named).length > 0 ? { by: named } : {}),
      });
      if (history.length > MAX_HISTORY) history.shift();
      // git is re-read before the publish, not after it: the view about to be
      // sent carries each file's status, and one computed from the previous
      // read would show the edit without showing that it is now a change. The
      // report is stamped in the same breath and for the same reason — it is
      // three stats unless the suite has run, and the push is the only moment
      // an idle window learns that it has.
      void Promise.all([refreshGit(), refreshCoverage()]).then(() => {
        // The updater refuses to publish after close, but the await above
        // reopens that window.
        if (!closed) handlers.onApplied(changedFiles);
      });
    },
    onError: handlers.onError,
  });
  const watcher = watchProject({ root, onChange: (change) => updater.queue(change) });

  /**
   * Past commits' graphs, least recently asked for first — a Map keeps
   * insertion order, and re-inserting on a hit is what makes it an LRU.
   *
   * A commit's graph never changes, so nothing here can go stale; the only
   * reason to drop one is room. The pool is shared with the live updater, so a
   * build queues behind whatever the agent just saved rather than racing it.
   */
  const past = new Map<string, Graph>();
  const building = new Map<string, Promise<Graph | null>>();
  /** Every spelling asked for -> the full sha, so `7fe7f88` and the whole sha share one slot. */
  const spelled = new Map<string, string>();

  async function graphAt(sha: string): Promise<Graph | null> {
    const full = spelled.get(sha) ?? (await resolveCommit(root, sha));
    if (full === null || closed) return null;
    spelled.set(sha, full);

    const remembered = past.get(full);
    if (remembered !== undefined) {
      past.delete(full);
      past.set(full, remembered);
      return remembered;
    }

    const inFlight = building.get(full);
    if (inFlight !== undefined) return inFlight;

    const build = buildGraphAt(root, full, pool).then((built) => {
      building.delete(full);
      // A session torn down mid build has closed the pool this parsed with,
      // and a graph with half its files missing is worse than no answer.
      if (built === null || closed) return null;
      past.set(full, built.graph);
      for (const oldest of past.keys()) {
        if (past.size <= MAX_PAST_GRAPHS) break;
        past.delete(oldest);
      }
      return built.graph;
    });
    building.set(full, build);
    return build;
  }

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
    pool,
    queue: (change, by) => updater.queue(change, by),
    history: () => history,
    writtenBy: (filePath) => writers.get(filePath)?.by ?? null,
    agentCalls: () => agent,
    recordAgentCall: (call) => {
      agent.push(call);
      if (agent.length > MAX_HISTORY) agent.shift();
    },
    hookCalls: () => ({ ...hook }),
    recordHookCall: (accepted) => {
      if (accepted) hook.accepted += 1;
      else hook.refused += 1;
    },
    gitStatus: () => status,
    gitBase: () => requested,
    async setGitBase(base) {
      requested = base;
      await refreshGit();
      return status;
    },
    refreshGit,
    coverage: () => coverage,
    refreshCoverage,
    graphAt,
    groups: () => groups,
    refreshGroups,
    clustersOf,

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

    lastSuggest: () => lastSuggest,
    suggestRunning: () => suggesting,

    suggest(targets, named) {
      if (suggesting) return null;
      suggesting = true;
      const at = Date.now();

      return suggestNames(targets, named).then((outcome) => {
        suggesting = false;
        // The project was switched while the model was thinking. The names
        // describe clusters nobody is looking at, and a held fetch that
        // answered them would land them in the next project's section.
        if (closed) return { ok: false, reason: 'failed', detail: 'the project was switched during the run' };
        if (!outcome.ok) return outcome;

        const result: SuggestResult = {
          ok: true,
          at,
          suggestions: outcome.suggestions,
          costUsd: outcome.costUsd,
          ms: outcome.ms,
        };
        lastSuggest = result;
        return result;
      });
    },

    askConversation: () => conversation,
    askRunning: () => conversation?.turns.at(-1)?.state === 'running',

    startAsk(question, context, onDelta, onEnded) {
      if (conversation?.turns.at(-1)?.state === 'running') return null;

      const held: AskConversation = conversation ?? {
        id: `ask-${Date.now().toString(36)}`,
        at: Date.now(),
        sessionId: null,
        turns: [],
        costUsd: 0,
      };
      conversation = held;

      const turn: AskTurn = { at: Date.now(), question, answer: '', state: 'running' };
      held.turns.push(turn);

      void ask(
        {
          question,
          // The categories only when there is no session to resume — which is
          // the first turn, and a later one whose predecessor never got far
          // enough for the CLI to name a session.
          context: held.sessionId === null ? context : null,
          resume: held.sessionId,
        },
        {
          onDelta: (text, kind) => {
            // A turn the user ended, or a project switched away from, must not
            // keep typing into a panel: the money is spent, the words are not
            // wanted. Kept on the turn as well as pushed, so a page that
            // reloads mid-answer reads what has arrived so far.
            if (closed || turn.state !== 'running') return;
            if (kind === 'thinking') turn.thinking = (turn.thinking ?? '') + text;
            else turn.answer += text;
            onDelta(text, kind);
          },
        },
      ).then((outcome) => {
        if (closed || turn.state !== 'running') return;
        turn.finishedAt = Date.now();
        // Working notes, not an answer, and the turn is over. Dropped whether
        // it ended well or badly: keeping them would put the model's reasoning
        // in a transcript beside its reply, where a reader would take the two
        // for one thing.
        delete turn.thinking;

        if (!outcome.ok) {
          turn.state = 'failed';
          turn.reason = outcome.reason;
          turn.detail = outcome.detail;
        } else {
          turn.state = 'done';
          // The whole answer replaces the accumulated deltas: they are the
          // same words, but a dropped chunk would leave a hole nobody could
          // see, and this is the CLI's own copy of what it said.
          turn.answer = outcome.text;
          turn.costUsd = outcome.costUsd;
          turn.ms = outcome.ms;
          if (outcome.firstTokenMs !== null) turn.firstTokenMs = outcome.firstTokenMs;
          if (outcome.firstAnswerMs !== null) turn.firstAnswerMs = outcome.firstAnswerMs;
          // A floor, and not the whole bill: the price rides on the CLI's
          // closing line, which a turn that timed out or was killed never
          // printed. That turn spent money this cannot see, so the total under
          // the transcript is what the answers that arrived cost, and a failed
          // turn adds nothing to it rather than a number that was guessed.
          held.costUsd += outcome.costUsd;
          if (outcome.sessionId !== null) held.sessionId = outcome.sessionId;
        }

        onEnded(held);
      });

      return held;
    },

    endAsk() {
      if (conversation === null) return false;
      // A turn still in flight is abandoned rather than killed, as explain's
      // is: this stops the answer being used, not the money being spent.
      const last = conversation.turns.at(-1);
      if (last?.state === 'running') {
        last.state = 'cancelled';
        last.finishedAt = Date.now();
      }
      conversation = null;
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
      // The names describe the project being switched away from. A run still
      // in flight is abandoned rather than killed, as explain's is, and its
      // answer is refused by the `closed` check where it would have been kept.
      lastSuggest = null;
      suggesting = false;
      // The conversation is about the categories of the project being switched
      // away from. Answering a follow-up about it against the next project's
      // graph is the confidently wrong answer this tool exists not to give, so
      // it goes with the session; a turn in flight is abandoned like explain's.
      const asking = conversation?.turns.at(-1);
      if (asking?.state === 'running') {
        asking.state = 'cancelled';
        asking.finishedAt = Date.now();
      }
      conversation = null;
      clearInterval(poll);
      // A build still running settles into nothing: `closed` is checked before
      // it stores, so clearing here cannot be undone by a late arrival.
      past.clear();
      building.clear();
      spelled.clear();
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

import { invoke, isTauri } from '@tauri-apps/api/core';
import type { GitFileStatus, GitStatus } from '../../src/git/types.js';
import type { LanguageId } from '../../src/lang/types.js';
import type { Suggestion } from '../../src/project/suggest.js';
import type { Commit, RemoteStatus } from '../../src/project/git.js';
import type { GroupColor } from '../../src/project/groups.js';
import type {
  ExplainState,
  ExplainedEntry,
  FetchResponse,
  LogResponse,
  RepoInfo,
  SuggestResponse,
} from '../../src/server/app.js';
import type { ExplainFailure, ExplainRun } from '../../src/server/session.js';
import type { Tracking, ViewGraph } from '../../src/view/types.js';

// Types only. `groups.ts` reaches for node:fs and `git.ts` for child_process,
// so nothing may import a value from either here — the import disappears at
// compile time, the module never does.
export type { Commit, GitFileStatus, GitStatus, GroupColor, LanguageId, RemoteStatus, Tracking, ViewGraph };
export type ViewNode = ViewGraph['nodes'][number];
export type ViewMember = ViewNode['members'][number];

/**
 * References that landed nowhere, always both halves — never `{ imports: 0,
 * calls: 0 }`, which is spelled as no object at all.
 */
export type Unresolved = NonNullable<ViewNode['unresolved']>;

/**
 * What a box, the status bar and the panel say about references that landed
 * nowhere. One function because three surfaces say it, and three wordings for
 * one fact is how the page starts disagreeing with itself.
 *
 * A clause and not a sentence: each caller finishes it with the scope it is
 * speaking about — this file, these boxes — because the count is the easy half
 * and *what it was counted over* is the half that decides whether it is true.
 */
export function describeUnresolved(counts: Unresolved): string {
  const parts: string[] = [];
  if (counts.imports > 0) {
    parts.push(counts.imports === 1 ? '1 import' : `${counts.imports} imports`);
  }
  if (counts.calls > 0) parts.push(counts.calls === 1 ? '1 call' : `${counts.calls} calls`);
  return parts.join(' and ');
}

/**
 * Every reference the drawn boxes could not follow, or null when they followed
 * all of them.
 *
 * The project's own count, not the slice's. It stands in the status bar beside
 * "N files with syntax errors", which selectView measures over the whole graph;
 * summing the drawn boxes instead made one of the two quietly about whatever
 * was on screen, so scoping into a directory shrank one number and not the
 * other. The mark on a box is still that box's own.
 */
export function totalUnresolved(view: ViewGraph): Unresolved | null {
  // The slice's, not the project's: it stands beside the syntax-error count in
  // the status bar, and two numbers side by side must be over the same files.
  const { imports, calls } = view.scoped.unresolved;
  return imports === 0 && calls === 0 ? null : { imports, calls };
}

export interface ViewResponse {
  root: string;
  view: ViewGraph;
}

/**
 * Where the server is.
 *
 * Under the desktop shell the OS assigned the port, so Rust has to be asked for
 * it — nothing may hard-code one. Served directly by Fastify (the CLI, or
 * `npm run dev:web`) the page is already on the right origin, and an empty base
 * leaves every request relative, exactly as before.
 *
 * Resolved once and reused: the port cannot change while the page is loaded.
 */
let origin: Promise<string> | null = null;

export function serverOrigin(): Promise<string> {
  origin ??= resolveOrigin();
  return origin;
}

function resolveOrigin(): Promise<string> {
  if (!isTauri()) return Promise.resolve('');

  return invoke<number>('get_server_port')
    .then((port) => `http://127.0.0.1:${port}`)
    .catch((cause: unknown) => {
      // A cached rejection would disable every request for the life of the page.
      // The sidecar can still be starting, so the next caller gets a fresh try.
      origin = null;
      throw cause;
    });
}

export async function fetchView(search: string): Promise<ViewResponse> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/view${search}`);
  if (!response.ok) {
    // The server's own words — `no such file: …`, `unknown commit …` — are
    // the banner; a status code alone left the page guessing what was refused.
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `view request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as ViewResponse;
}

/**
 * How many directories one hunt for broken files may open before it gives up.
 *
 * A bound rather than a guess at the shape of the tree: the walk below only
 * descends where the mark is, so a project with five broken files opens about
 * five directories, and one whose every directory holds one would otherwise
 * open all of them a request at a time.
 */
const PARSE_WALK_LIMIT = 40;

/**
 * Which files would not fully parse, and whether that list is all of them.
 *
 * The count rides on every view; the list does not, and no route answers for
 * it — so it is walked the way a reader would walk it. `/api/view` is the only
 * thing that says which box carries the warning, and a folder box carries it
 * when any file under it does, so descending only into the marked folders
 * visits about one directory per broken file rather than the whole tree.
 *
 * `complete` is false when the walk ran out of its budget with directories
 * still queued. It is carried rather than dropped because a short list nobody
 * is told is short is the exact failure the warning itself exists to prevent.
 */
export async function fetchParseErrors(
  at: string | null = null,
): Promise<{ files: string[]; complete: boolean }> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [''];

  while (queue.length > 0 && seen.size < PARSE_WALK_LIMIT) {
    const scope = queue.shift() ?? '';
    if (seen.has(scope)) continue;
    seen.add(scope);

    const { view } = await fetchView(
      `?scope=${encodeURIComponent(scope)}${at === null ? '' : `&at=${encodeURIComponent(at)}`}`,
    );
    for (const node of view.nodes) {
      if (!node.parseError) continue;
      // A folder is a place to look inside — including the dimmed ones, which
      // is how a scope that auto-descended into `src` is left with any way at
      // all to reach a broken file under `web`. A bundle belongs to a focus
      // view and cannot appear here.
      if (node.kind === 'file') found.add(node.id);
      else if (node.kind === 'folder') queue.push(node.id);
    }
  }

  return { files: [...found].sort(), complete: queue.length === 0 };
}

/** The websocket has to reach the same server the view came from. */
export async function liveUrl(): Promise<URL> {
  const base = await serverOrigin();
  const url = new URL('/live', base === '' ? window.location.href : base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}

/** The desktop shell adds a folder picker; a browser tab has no equivalent. */
export const isDesktop = isTauri();

export async function switchProject(root: string): Promise<{ root: string }> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/project`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  const body = (await response.json()) as { root?: string; error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return { root: body.root ?? root };
}

export function pickProject(): Promise<string | null> {
  return invoke<string | null>('pick_project');
}

export function recentProjects(): Promise<string[]> {
  return invoke<string[]>('recent_projects');
}

export function rememberProject(path: string): Promise<string[]> {
  return invoke<string[]>('remember_project', { path });
}

export interface HookStatus {
  settingsPath: string;
  installed: boolean;
  /** A settings file exists but cannot be parsed, so merging is refused. */
  unreadable: boolean;
  /** Exactly what would be written, shown before anything is. */
  preview: string;
}

export async function fetchHookStatus(): Promise<HookStatus> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/hook-status`);
  if (!response.ok) throw new Error(`hook status failed: HTTP ${response.status}`);
  return (await response.json()) as HookStatus;
}

export async function installHook(): Promise<HookStatus> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/hook-install`, { method: 'POST' });
  const body = (await response.json()) as HookStatus & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body;
}

/**
 * Which editor a project opens in. Stored per project and resolved once per
 * root; `vscode` unless the project says otherwise. Rust allowlists the same
 * two schemes, so an unrecognised value falls back rather than being refused.
 */
const SCHEMES = ['vscode', 'cursor'] as const;

let cachedScheme: { root: string; scheme: string } | null = null;

async function editorScheme(root: string): Promise<string> {
  if (!isDesktop) return 'vscode';
  if (cachedScheme?.root === root) return cachedScheme.scheme;

  const settings = await invoke<{ editor?: unknown }>('project_settings', { path: root }).catch(
    () => ({}) as { editor?: unknown },
  );
  const scheme = SCHEMES.find((known) => known === settings.editor) ?? 'vscode';
  cachedScheme = { root, scheme };
  return scheme;
}

/**
 * Deep-links into the editor. The line comes from the graph, so a symbol opens
 * on its own declaration rather than at the top of the file.
 */
export async function openInEditor(root: string, filePath: string, line: number): Promise<void> {
  const scheme = await editorScheme(root);
  // Per segment, because encodeURI deliberately preserves the URI-reserved set —
  // and `#` and `?` are both legal in a filename, where either would truncate
  // the path or turn the rest of it into a fragment.
  const encoded = `${root}/${filePath}`.split('/').map(encodeURIComponent).join('/');
  const url = `${scheme}://file${encoded}:${line}`;

  if (isDesktop) {
    await invoke('open_in_editor', { url });
    return;
  }
  // A browser hands a custom scheme to the OS itself, usually after a prompt.
  window.open(url, '_self');
}

/**
 * What the tool can read, and what this project holds that it cannot. The
 * breakdown of what *was* read comes with the view; this is the other half, and
 * it is the one that has to be said out loud — a project half of whose source
 * was never parsed draws a graph that looks like code with no coupling.
 */
export interface LanguageReport {
  /** Every language the tool understands, for saying what is missing against. */
  reads: string[];
  unreadable: { extension: string; files: number }[];
}

export async function fetchLanguages(): Promise<LanguageReport> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/languages`);
  if (!response.ok) throw new Error(`language report failed: HTTP ${response.status}`);
  return (await response.json()) as LanguageReport;
}

export interface SymbolDetail {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';
  line: number;
  endLine: number;
  /**
   * The sibling this row is another name for, when one body was bound to
   * several names. Absent on the body itself, and on everything a language
   * cannot spell that way. What counts symbols counts the rows without it.
   */
  aliasOf?: string;
}

export type Detail =
  | {
      kind: 'file';
      path: string;
      lineCount: number;
      symbols: SymbolDetail[];
      imports: string[];
      importedBy: string[];
      /**
       * How the graph arrived at that list, never how complete it is — the
       * count is a floor either way, and `importedByNote` is what says by how
       * much. Carried because it is the wire shape and an agent reading
       * `describe_file` branches on it; the page does not, because the mark it
       * would draw is on every one of these counts already.
       */
      importedByCoverage: Tracking;
      /**
       * The graph's own sentence about what the count leaves out, printed
       * beside it in both states — "Used by (5)" reads as a census either way,
       * and the reader about to change a signature is the one who cannot
       * afford to read it that way.
       */
      importedByNote: string;
      /**
       * Files this one calls into from a statement belonging to no symbol.
       *
       * Listed apart from `imports` because the two claims differ in strength:
       * an import says this file mentions that one, a call says it runs
       * something in it. The same path under both headings is the ordinary
       * case, and it is honest twice.
       */
      calls: string[];
    }
  | {
      kind: 'folder';
      path: string;
      files: string[];
      imports: string[];
      importedBy: string[];
      /** The same qualification a file's count carries, over the pile. */
      importedByCoverage: Tracking;
      importedByNote: string;
    };

/** `at` is the commit on screen, so the answer is about the diagram being looked at. */
function atParam(at: string | null): string {
  return at === null ? '' : `&at=${encodeURIComponent(at)}`;
}

export async function fetchDetail(target: string, at: string | null = null): Promise<Detail | null> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/detail?path=${encodeURIComponent(target)}${atParam(at)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`detail failed: HTTP ${response.status}`);
  return (await response.json()) as Detail;
}

export interface SymbolRelation {
  id: string;
  name: string;
  /**
   * `'file'` on a caller, and only there: a call written outside every symbol
   * belongs to the file, so a row can name a box rather than a symbol. Its
   * `name` is the basename and its `line` is 1, which is where such a call
   * sits. Nothing in the graph *uses* a file, so it never appears under `uses`.
   */
  kind: 'file' | 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';
  filePath: string;
  line: number;
  edge: 'calls' | 'extends' | 'implements' | 'associates';
}

export interface SymbolLinks {
  id: string;
  name: string;
  kind: SymbolRelation['kind'];
  filePath: string;
  uses: SymbolRelation[];
  usedBy: SymbolRelation[];
  /**
   * Whether an empty `usedBy` means none, or means the graph cannot tell.
   *
   * Neither word claims completeness, and that is the whole of the change:
   * `tracked` says every reference *by name* was followed, which is not the
   * same as every reference — a class re-exported through a barrel or handed
   * over as a value is used in ways no name in the graph spells out, which is
   * how QueryObserver read "used by 16" against 26 real sites. `partial` is
   * the weaker of the two and the one that changes what the page may say, so
   * every surface below tests for it rather than for its opposite.
   */
  coverage: Tracking;
  /** The graph's own sentence about that, shown wherever the count is drawn. */
  coverageNote: string;
  /** Why the `uses` list is in no order the source would recognise. */
  usesNote: string;
}

/**
 * The mark every count of dependents or callers wears.
 *
 * One character, and text rather than an icon, the way the `+` and `−` of a
 * diff are: a count that is short by ten is not wrong in any way a reader can
 * see, so the shape of the number itself has to say so. Every surface that
 * draws such a count uses this, so the three of them cannot drift into three
 * different hedges.
 *
 * Unconditional, and not only where `Tracking` says `partial`. Both states are
 * floors — a `tracked` count still misses a class handed to a function as a
 * value — and a number printed bare beside a note ending "the count is a
 * floor" would contradict the sentence under it. What the two states change is
 * *what* is missing, which is what the note says.
 */
export const FLOOR = '≥';

/** What one symbol reaches and what reaches it. 404 means it left the graph. */
export async function fetchSymbol(id: string, at: string | null = null): Promise<SymbolLinks | null> {
  const server = await serverOrigin();
  const response = await fetch(`${server}/api/symbol?id=${encodeURIComponent(id)}${atParam(at)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`symbol failed: HTTP ${response.status}`);
  return (await response.json()) as SymbolLinks;
}

export interface ChangeEntry {
  at: number;
  files: string[];
}

export async function fetchChanges(): Promise<ChangeEntry[]> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/changes`);
  if (!response.ok) throw new Error(`changes failed: HTTP ${response.status}`);
  return ((await response.json()) as { changes: ChangeEntry[] }).changes;
}

export interface SearchHit {
  kind: 'file' | 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';
  name: string;
  path: string;
  line: number;
}

/**
 * Subsequence search over the whole graph — the one on screen. At a commit
 * that is the commit's graph, so ⌘K cannot find a symbol the frozen diagram
 * does not have, or miss one it shows. 404 is an unknown commit, in the
 * server's words.
 */
export async function fetchSearch(query: string, at: string | null = null): Promise<SearchHit[]> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/search?q=${encodeURIComponent(query)}${atParam(at)}`);
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `search failed: HTTP ${response.status}`);
  }
  return ((await response.json()) as { hits: SearchHit[] }).hits;
}

/**
 * What the working tree looks like against the base ref. A project that is not
 * a git work tree is the ordinary case, not a failure, so it answers null
 * rather than throwing: the page simply has no git to show.
 */
export async function fetchGit(): Promise<GitStatus | null> {
  const server = await serverOrigin();
  const response = await fetch(`${server}/api/git`);
  if (!response.ok) throw new Error(`git status failed: HTTP ${response.status}`);
  const body = (await response.json()) as GitStatus & { available?: false };
  return body.available === false ? null : body;
}

/** Which commit the working tree is compared against: HEAD, HEAD~1 or branch. */
export async function setGitBase(base: string): Promise<GitStatus | null> {
  const server = await serverOrigin();
  const response = await fetch(`${server}/api/git-base`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ base }),
  });
  const body = (await response.json()) as GitStatus & { available?: false; error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return body.available === false ? null : body;
}

export interface GroupSuggestion {
  id: string;
  files: string[];
  cohesion: number;
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  /** 0 is an outer group; 1 sits inside one. */
  depth: number;
  parent: string | null;
  /** The id this group is recorded under. See src/project/groups.ts. */
  storedId?: string;
  /** Absent means the graph found this group; 'manual' means a person drew it. */
  origin?: 'manual';
  /** A palette key, not a CSS colour. Absent means the depth default. */
  color?: GroupColor;
  /** Frame slack in px around the members. Absent means the layout default. */
  padding?: { x: number; y: number };
  /** A hand-placed frame. Only honoured while locked. */
  geometry?: { x: number; y: number; width: number; height: number };
  /** Keep that geometry through a relayout. */
  locked?: boolean;
}

/**
 * A name in .codemap/groups.json that no group the graph finds now answers to.
 *
 * Shown rather than dropped: three of this repository's own committed names
 * were in this state and appeared nowhere, so nobody could say why. The page
 * lists them under the categories with a way to delete each — by `storedId`,
 * which is the only id an orphan has.
 */
export interface OrphanGroup {
  storedId: string;
  name: string;
  files: string[];
}

/** What the server answers about groups, whichever route was asked. */
export interface Groups {
  clusters: GroupSuggestion[];
  orphans: OrphanGroup[];
}

export async function fetchClusters(at: string | null = null): Promise<Groups> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/clusters${at === null ? '' : `?at=${encodeURIComponent(at)}`}`);
  if (!response.ok) throw new Error(`clusters failed: HTTP ${response.status}`);
  const body = (await response.json()) as Partial<Groups>;
  return { clusters: body.clusters ?? [], orphans: body.orphans ?? [] };
}

/**
 * Accept or reject one group by its membership. `ids` says which stored entry
 * the decision replaces: without `storedId`, renaming a group whose members
 * had drifted appended a second entry under the new cluster id and the file
 * held the same name twice.
 */
export async function decideCluster(
  files: string[],
  name: string,
  state: 'accepted' | 'rejected',
  ids: { id?: string; storedId?: string } = {},
): Promise<void> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/clusters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files, name, state, ...ids }),
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
}

/**
 * Create, patch or drop one group. The server answers with the whole freshly
 * merged list rather than the one entry that changed, because a hand-drawn
 * group can displace a derived one — so the page replaces its list wholesale
 * instead of trying to reconcile a single row against a shape it no longer has.
 */
export async function groupAction(body: unknown): Promise<Groups> {
  const server = await serverOrigin();
  const response = await fetch(`${server}/api/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Partial<Groups> & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  // Both halves, or deleting an orphan would leave it in the list it was shown in.
  return { clusters: result.clusters ?? [], orphans: result.orphans ?? [] };
}

/**
 * A name a model proposed for a group, and what one press of Suggest came back
 * with. Decision 5: the model suggests, a person accepts, and accepting goes
 * through `decideCluster` like any other name — nothing here writes.
 */
export type { SuggestResponse, Suggestion };

/** A price the way both tooltips say it: three decimals under a dollar, two above. */
export function money(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/**
 * Ask a model what the unnamed categories are called. Spends the user's money,
 * so only ever from a press, and the fetch is held for the whole run — a
 * minute, sometimes more. A run that failed is an ordinary 200 with `ok: false`
 * and its reason in words; only a request that could not start is thrown:
 * nothing unnamed (400), or a run already spending (409).
 */
export async function requestSuggestions(): Promise<SuggestResponse> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/suggest`, { method: 'POST' });
  const body = (await response.json()) as SuggestResponse | { error?: string };
  if (!response.ok) {
    throw new Error(('error' in body && body.error) || `HTTP ${response.status}`);
  }
  return body as SuggestResponse;
}

/**
 * The last run that produced names, if this session has had one, and whether
 * one is spending right now. Both survive a reload: the fetch that started a
 * run used to be the only thing that knew it was in flight, so a reload showed
 * "Suggesting…" for ever, or nothing while the money was still going out.
 */
export async function fetchSuggestions(): Promise<{ result: SuggestResponse | null; running: boolean }> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/suggest`);
  if (!response.ok) throw new Error(`suggestions failed: HTTP ${response.status}`);
  const body = (await response.json()) as { result: SuggestResponse | null; running?: boolean };
  return { result: body.result, running: body.running === true };
}

export interface AgentCall {
  at: number;
  tool: string;
  target: string | null;
  /**
   * The agent's own words about what it just changed, through `note_change`.
   * Absent on every other entry, and its presence is what makes a row a note —
   * `tool` is the literal `note_change` and `target` is null, so neither can
   * tell one apart on its own.
   */
  note?: string;
  /**
   * Which files the note is about. Whatever the agent passed, and never checked
   * against the graph: it may name a file that does not exist, or none at all.
   * A hint for the tooltip, so nothing is drawn from it.
   */
  files?: string[];
}

export async function fetchAgentCalls(): Promise<{ calls: AgentCall[]; lastAt: number | null }> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/agent`);
  if (!response.ok) throw new Error(`agent log failed: HTTP ${response.status}`);
  return (await response.json()) as { calls: AgentCall[]; lastAt: number | null };
}

/**
 * Reading, not deciding. The app spawns `claude -p` to say what a followed
 * symbol is *for*; it may never let a model decide anything — a group's name
 * stays the user's. See CLAUDE.md, and the run itself in src/project/explain.ts.
 */
export type { ExplainRun, ExplainFailure, ExplainState };

/**
 * A stored explanation, told how it now stands to the code it describes. The
 * server calls this an ExplainedEntry; from the page it is what is stored.
 */
export type StoredExplanation = ExplainedEntry;

export interface ExplainSummary {
  explanations: StoredExplanation[];
  /** How many the project holds, including ones these ids did not ask for. */
  total: number;
  /** The run in flight, or the last one to end. Null until the first press. */
  run: ExplainRun | null;
}

/**
 * What has been explained, for the ids the panel is showing.
 *
 * The ids are not a convenience. `state` is computed by re-reading each
 * described file off disk, so an unfiltered answer would read every explained
 * file in the project every time the panel renders.
 */
export async function fetchExplanations(ids: string[]): Promise<ExplainSummary> {
  const base = await serverOrigin();
  const query = ids.length === 0 ? '' : `?ids=${encodeURIComponent(ids.join(','))}`;
  const response = await fetch(`${base}/api/explain${query}`);
  if (!response.ok) throw new Error(`explanations failed: HTTP ${response.status}`);
  return (await response.json()) as ExplainSummary;
}

export interface ExplainResult {
  /** The run now in flight — the one just started, or one already going. */
  run: ExplainRun | null;
  /**
   * Ids left out because their reading is still current. Named, so the panel
   * can say why the count shrank rather than leaving a row that never starts.
   */
  skipped: string[];
  /**
   * The server's words when nothing was asked at all: every id was current, or
   * none is in the graph. Not a failure — no run happened and no money moved —
   * so it is an answer here rather than a thrown error, and the page shows the
   * sentence instead of a spinner. Null whenever a run started or was going.
   */
  refused: string | null;
  /**
   * Where the reading would be written, when the server refused because the
   * project has no `.codemap/` yet and nobody has said it may make one.
   *
   * Its own field and not a `refused` sentence, because this is the one
   * refusal a press can answer: the caller asks, and sends the press again
   * with consent. Null on every other outcome.
   */
  needsConsent: string | null;
}

/**
 * Spend the user's quota on these ids, and return the moment it has started.
 *
 * A run is a minute of subprocess — far longer than a browser will hold a fetch
 * open — so the answer is not here. It arrives in the run, which the caller
 * reads back until it ends. 409 is that same non-failure from the other side:
 * something is already spending the quota, so follow it rather than report it.
 */
/** Stop the run in flight. The server answers with whatever state it ended in. */
export async function cancelExplanations(): Promise<{ run: ExplainRun | null }> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'cancel' }),
  });
  const body = (await response.json()) as { run?: ExplainRun };
  return { run: body.run ?? null };
}

/**
 * Drop one stored reading. A reading can simply be wrong, and .codemap/explain.json
 * is committed — so there has to be a way to take one back that is not editing the
 * file by hand.
 */
export async function forgetExplanation(id: string): Promise<void> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'forget', id }),
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: string };
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
}

/**
 * `force` re-reads ids whose reading is current. Without it the server skips
 * them and names them back: "Explain these" used to buy a second reading of a
 * symbol whose panel already said current, at the same price as the first.
 *
 * `createStore` answers the server's one question — may it make a `.codemap/`
 * in a project that has none. Sent only when a person has said so.
 */
export async function requestExplanations(
  ids: string[],
  force = false,
  createStore = false,
): Promise<ExplainResult> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'run',
      ids,
      ...(force ? { force: true } : {}),
      ...(createStore ? { createStore: true } : {}),
    }),
  });
  const body = (await response.json()) as {
    run?: ExplainRun;
    skipped?: string[];
    error?: string;
    needsConsent?: boolean;
    store?: { path?: string };
  };
  const skipped = body.skipped ?? [];
  if (response.status === 409) {
    // Two different 409s share the code. One means a run is already spending
    // the quota, which is not a failure and is followed rather than reported;
    // the other means the server is asking permission to create a file. Told
    // apart by `needsConsent`, because reading both as the first made the
    // press a silent no-op — nothing ran, and nothing said why.
    if (body.needsConsent === true) {
      return { run: null, skipped, refused: null, needsConsent: body.store?.path ?? '.codemap/explain.json' };
    }
    return { run: body.run ?? null, skipped, refused: null, needsConsent: null };
  }
  if (response.status === 400) {
    return { run: null, skipped, refused: body.error ?? 'nothing was asked', needsConsent: null };
  }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return { run: body.run ?? null, skipped, refused: null, needsConsent: null };
}

/**
 * Read-only history. The page shows what git knows and never writes to it —
 * an agent may be editing the working tree this very moment — so the three
 * verbs here are log, repo and fetch, and `fetch` is the only one that is not
 * a pure read, and it still touches no working tree.
 */
export type { LogResponse, RepoInfo, FetchResponse };

/** The most recent commits on every ref, newest first, and which one is HEAD. */
export async function fetchLog(limit?: number): Promise<LogResponse> {
  const base = await serverOrigin();
  const query = limit === undefined ? '' : `?limit=${limit}`;
  const response = await fetch(`${base}/api/log${query}`);
  if (!response.ok) throw new Error(`log failed: HTTP ${response.status}`);
  return (await response.json()) as LogResponse;
}

/** Everything the Repository panel shows, in one answer. */
export async function fetchRepo(): Promise<RepoInfo> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/repo`);
  if (!response.ok) throw new Error(`repo failed: HTTP ${response.status}`);
  return (await response.json()) as RepoInfo;
}

/**
 * `git fetch`. The server answers with a sentence either way — a remote that
 * refused is an ordinary outcome the panel shows, not a thrown error — and it
 * can take up to thirty seconds, so the button that calls this needs a pending
 * state. Re-read the log afterwards: commits may have arrived.
 */
export async function requestFetch(): Promise<FetchResponse> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/fetch`, { method: 'POST' });
  if (!response.ok) throw new Error(`fetch failed: HTTP ${response.status}`);
  return (await response.json()) as FetchResponse;
}

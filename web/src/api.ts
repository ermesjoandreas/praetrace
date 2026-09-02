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
import type { ViewGraph } from '../../src/view/types.js';

// Types only. `groups.ts` reaches for node:fs and `git.ts` for child_process,
// so nothing may import a value from either here — the import disappears at
// compile time, the module never does.
export type { Commit, GitFileStatus, GitStatus, GroupColor, LanguageId, RemoteStatus, ViewGraph };
export type ViewMember = ViewGraph['nodes'][number]['members'][number];

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
  if (!response.ok) throw new Error(`view request failed: HTTP ${response.status}`);
  return (await response.json()) as ViewResponse;
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
}

export type Detail =
  | {
      kind: 'file';
      path: string;
      lineCount: number;
      symbols: SymbolDetail[];
      imports: string[];
      importedBy: string[];
    }
  | { kind: 'folder'; path: string; files: string[]; imports: string[]; importedBy: string[] };

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
  kind: 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';
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
}

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

export async function searchGraph(query: string): Promise<SearchHit[]> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/search?q=${encodeURIComponent(query)}`);
  if (!response.ok) throw new Error(`search failed: HTTP ${response.status}`);
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

export async function fetchClusters(at: string | null = null): Promise<GroupSuggestion[]> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/clusters${at === null ? '' : `?at=${encodeURIComponent(at)}`}`);
  if (!response.ok) throw new Error(`clusters failed: HTTP ${response.status}`);
  return ((await response.json()) as { clusters: GroupSuggestion[] }).clusters;
}

export async function decideCluster(
  files: string[],
  name: string,
  state: 'accepted' | 'rejected',
): Promise<void> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/clusters`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ files, name, state }),
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
export async function groupAction(body: unknown): Promise<GroupSuggestion[]> {
  const server = await serverOrigin();
  const response = await fetch(`${server}/api/groups`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as { clusters?: GroupSuggestion[]; error?: string };
  if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`);
  return result.clusters ?? [];
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

/** The last run that produced names, if this session has had one. Survives a reload. */
export async function fetchSuggestions(): Promise<SuggestResponse | null> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/suggest`);
  if (!response.ok) throw new Error(`suggestions failed: HTTP ${response.status}`);
  return ((await response.json()) as { result: SuggestResponse | null }).result;
}

export interface AgentCall {
  at: number;
  tool: string;
  target: string | null;
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
export async function cancelExplanations(): Promise<ExplainResult> {
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

export async function requestExplanations(ids: string[]): Promise<ExplainResult> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/explain`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'run', ids }),
  });
  const body = (await response.json()) as { run?: ExplainRun; error?: string };
  if (response.status === 409) return { run: body.run ?? null };
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return { run: body.run ?? null };
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

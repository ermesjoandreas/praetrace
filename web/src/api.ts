import { invoke, isTauri } from '@tauri-apps/api/core';
import type { GitFileStatus, GitStatus } from '../../src/git/types.js';
import type { LanguageId } from '../../src/lang/types.js';
import type { GroupColor } from '../../src/project/groups.js';
import type { ViewGraph } from '../../src/view/types.js';

// Types only. `groups.ts` reaches for node:fs, so nothing may import a value
// from it here — the import disappears at compile time, the module never does.
export type { GitFileStatus, GitStatus, GroupColor, LanguageId, ViewGraph };
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

export async function fetchDetail(target: string): Promise<Detail | null> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/detail?path=${encodeURIComponent(target)}`);
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
export async function fetchSymbol(id: string): Promise<SymbolLinks | null> {
  const server = await serverOrigin();
  const response = await fetch(`${server}/api/symbol?id=${encodeURIComponent(id)}`);
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

export async function fetchClusters(): Promise<GroupSuggestion[]> {
  const base = await serverOrigin();
  const response = await fetch(`${base}/api/clusters`);
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

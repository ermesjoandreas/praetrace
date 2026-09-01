import { invoke, isTauri } from '@tauri-apps/api/core';
import type { ViewGraph } from '../../src/view/types.js';

export type { ViewGraph };
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

export interface SymbolDetail {
  name: string;
  kind: 'class' | 'function' | 'interface' | 'type';
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
  kind: 'file' | 'class' | 'function' | 'interface' | 'type';
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

export interface GroupSuggestion {
  id: string;
  files: string[];
  cohesion: number;
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  /** 0 is an outer group; 1 sits inside one. */
  depth: number;
  parent: string | null;
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

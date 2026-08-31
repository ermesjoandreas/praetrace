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
  origin ??= isTauri()
    ? invoke<number>('get_server_port').then((port) => `http://127.0.0.1:${port}`)
    : Promise.resolve('');
  return origin;
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

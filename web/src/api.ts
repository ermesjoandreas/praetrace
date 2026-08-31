import type { ViewGraph } from '../../src/view/types.js';

export type { ViewGraph };
export type ViewMember = ViewGraph['nodes'][number]['members'][number];

export interface ViewResponse {
  root: string;
  view: ViewGraph;
}

export async function fetchView(search: string): Promise<ViewResponse> {
  const response = await fetch(`/api/view${search}`);
  if (!response.ok) throw new Error(`view request failed: HTTP ${response.status}`);
  return (await response.json()) as ViewResponse;
}

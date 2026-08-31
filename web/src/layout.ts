import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_WIDTH = 240;
export const MAX_MEMBERS = 8;

const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 17;
const DEFAULT_HEIGHT = 80;

/**
 * Boxes are measured before layout rather than after render, because dagre
 * needs dimensions up front and React Flow would otherwise lay out on stale
 * sizes for a frame.
 */
export function boxHeight(memberCount: number, isFolder: boolean): number {
  if (isFolder) return HEADER_HEIGHT + ROW_HEIGHT + 8;
  const shown = Math.min(memberCount, MAX_MEMBERS);
  const overflowRow = memberCount > MAX_MEMBERS ? 1 : 0;
  return HEADER_HEIGHT + (shown + overflowRow) * ROW_HEIGHT + 10;
}

export interface ClusterInput {
  id: string;
  files: string[];
}

export interface ClusterBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Cluster ids are file paths, which are also node ids; dagre needs them apart. */
const CLUSTER_PREFIX = 'cluster:';

/**
 * Lays out the boxes, and — when clusters are given — asks dagre to keep each
 * group's members together and hands back the frame each one occupies.
 */
export function layoutNodes<T extends Node>(
  nodes: T[],
  edges: Edge[],
  clusters: readonly ClusterInput[] = [],
): { nodes: T[]; clusters: ClusterBounds[] } {
  const graph = new dagre.graphlib.Graph({ compound: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 120, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.width ?? NODE_WIDTH,
      height: node.height ?? DEFAULT_HEIGHT,
    });
  }

  const present = new Set(nodes.map((node) => node.id));
  const drawn: string[] = [];

  for (const cluster of clusters) {
    // Only the members actually on screen; a frame around one box says nothing.
    const members = cluster.files.filter((file) => present.has(file));
    if (members.length < 2) continue;

    const key = CLUSTER_PREFIX + cluster.id;
    graph.setNode(key, {});
    for (const member of members) graph.setParent(member, key);
    drawn.push(cluster.id);
  }

  for (const edge of edges) graph.setEdge(edge.source, edge.target);

  dagre.layout(graph);

  const placed = nodes.map((node) => {
    const positioned = graph.node(node.id);
    if (!positioned) return node;
    // dagre positions by centre, React Flow by top-left corner.
    return {
      ...node,
      position: {
        x: positioned.x - (node.width ?? NODE_WIDTH) / 2,
        y: positioned.y - (node.height ?? DEFAULT_HEIGHT) / 2,
      },
    };
  });

  const bounds: ClusterBounds[] = [];
  for (const id of drawn) {
    const box = graph.node(CLUSTER_PREFIX + id) as
      | { x: number; y: number; width: number; height: number }
      | undefined;
    if (!box || !Number.isFinite(box.x)) continue;

    // Room for the label above the boxes it encloses.
    const padding = 14;
    bounds.push({
      id,
      x: box.x - box.width / 2 - padding,
      y: box.y - box.height / 2 - padding - 18,
      width: box.width + padding * 2,
      height: box.height + padding * 2 + 18,
    });
  }

  return { nodes: placed, clusters: bounds };
}

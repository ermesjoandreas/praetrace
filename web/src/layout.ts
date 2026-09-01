import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_WIDTH = 240;
export const MAX_MEMBERS = 8;

const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 17;
const DEFAULT_HEIGHT = 80;
const LABEL_HEIGHT = 18;

/** Two frames sharing more than this much of the smaller one read as one mess. */
const MAX_OVERLAP = 0.25;

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
  /** Used to decide which frame survives when two would overlap. */
  cohesion: number;
  /** 0 is an outer group; 1 sits inside one. */
  depth: number;
  parent: string | null;
}

/**
 * Frames that overlap badly say less than one frame would. The tighter, more
 * cohesive group keeps its frame; the other is dropped from the drawing — it is
 * still listed in the panel, so nothing is lost, only untangled.
 */
function withoutOverlaps(
  candidates: (ClusterBounds & { cohesion: number; area: number })[],
): ClusterBounds[] {
  const ranked = [...candidates].sort((a, b) => b.cohesion - a.cohesion || a.area - b.area);
  const kept: (ClusterBounds & { area: number })[] = [];

  for (const candidate of ranked) {
    // An outer frame is meant to contain the inner ones, so only frames at the
    // same level can be said to clash.
    const clashes = kept.some((other) => {
      if (other.depth !== candidate.depth) return false;
      const width = Math.min(candidate.x + candidate.width, other.x + other.width) - Math.max(candidate.x, other.x);
      const height = Math.min(candidate.y + candidate.height, other.y + other.height) - Math.max(candidate.y, other.y);
      if (width <= 0 || height <= 0) return false;
      return (width * height) / Math.min(candidate.area, other.area) > MAX_OVERLAP;
    });
    if (!clashes) kept.push(candidate);
  }

  return kept.map(({ id, x, y, width, height, depth }) => ({ id, x, y, width, height, depth }));
}

export interface ClusterBounds {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
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
  const drawn: { id: string; files: string[]; cohesion: number; depth: number }[] = [];
  const registered = new Set<string>();

  // Outer groups first, so an inner one can be parented to a node that exists.
  for (const cluster of [...clusters].sort((a, b) => a.depth - b.depth)) {
    // Only the members actually on screen; a frame around one box says nothing.
    const members = cluster.files.filter((file) => present.has(file));
    if (members.length < 2) continue;

    const key = CLUSTER_PREFIX + cluster.id;
    graph.setNode(key, {});
    registered.add(cluster.id);

    // A file belongs to its innermost group; the nesting is expressed by that
    // group's own parent, which is what makes dagre keep both levels together.
    for (const member of members) graph.setParent(member, key);
    if (cluster.parent !== null && registered.has(cluster.parent)) {
      graph.setParent(key, CLUSTER_PREFIX + cluster.parent);
    }

    drawn.push({ id: cluster.id, files: members, cohesion: cluster.cohesion, depth: cluster.depth });
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

  // dagre's own parent box spans every rank its children touch, including the
  // space other clusters occupy in between. A box drawn tight around where the
  // members actually landed is far smaller and overlaps far less.
  const byId = new Map(placed.map((node) => [node.id, node]));
  const candidates: (ClusterBounds & { cohesion: number; area: number })[] = [];

  for (const cluster of drawn) {
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;

    for (const file of cluster.files) {
      const node = byId.get(file);
      if (!node) continue;
      left = Math.min(left, node.position.x);
      top = Math.min(top, node.position.y);
      right = Math.max(right, node.position.x + (node.width ?? NODE_WIDTH));
      bottom = Math.max(bottom, node.position.y + (node.height ?? DEFAULT_HEIGHT));
    }
    if (!Number.isFinite(left)) continue;

    // An outer frame needs room for its own label to clear the inner frame
    // that starts at the same height, which is the common case.
    const padding = cluster.depth === 0 ? 38 : 12;
    const box = {
      id: cluster.id,
      depth: cluster.depth,
      x: left - padding,
      y: top - padding - LABEL_HEIGHT,
      width: right - left + padding * 2,
      height: bottom - top + padding * 2 + LABEL_HEIGHT,
    };
    candidates.push({ ...box, cohesion: cluster.cohesion, area: box.width * box.height });
  }

  return { nodes: placed, clusters: withoutOverlaps(candidates) };
}

import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_WIDTH = 240;
export const MAX_MEMBERS = 12;

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
export function boxHeight(memberCount: number, isFolder: boolean, expanded = false): number {
  if (isFolder) return HEADER_HEIGHT + ROW_HEIGHT + 8;
  // Expanding is a layout change, not a CSS reveal. dagre places boxes from
  // these numbers and every group frame is drawn around where they land, so a
  // box that grew without saying so would sit outside its own frame.
  const shown = expanded ? memberCount : Math.min(memberCount, MAX_MEMBERS);
  // The row is still there when expanded — it is how you fold the box back up.
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
  /** Frame slack the group carries itself, from someone dragging its corner. */
  padding?: { x: number; y: number };
  /** 'manual' means a person drew this group; it changes who wins an overlap. */
  origin?: 'manual';
  /** A hand-placed frame, used verbatim while locked. */
  geometry?: { x: number; y: number; width: number; height: number };
  /** Locked frames are placed by hand and never recomputed. */
  locked?: boolean;
}

/**
 * The slack between the members and the frame drawn around them, when the group
 * does not carry its own. An outer frame needs room for its own label to clear
 * the inner frame that starts at the same height, which is the common case.
 */
export function defaultPadding(depth: number): { x: number; y: number } {
  return depth === 0 ? { x: 38, y: 38 } : { x: 12, y: 12 };
}

/** A frame flush against its members stops reading as a container; one with
 * acres of slack swallows its neighbours. Both ends of a drag are bounded. */
export const MIN_PADDING = 4;
export const MAX_PADDING = 120;

/**
 * Frames that overlap badly say less than one frame would. The tighter, more
 * cohesive group keeps its frame; the other is dropped from the drawing — it is
 * still listed in the panel, so nothing is lost, only untangled.
 *
 * A hand-drawn group is ranked ahead of every derived one, whatever its
 * cohesion. It arrives from `mergeGroups` with a cohesion of 0 — honestly, the
 * import graph never claimed to find it — and ranking on that alone would drop
 * a frame somebody deliberately drew in favour of one the algorithm guessed at.
 * It still takes part in the contest rather than bypassing it, so the promise
 * that two frames never overlap badly survives; only who wins changes.
 */
function withoutOverlaps(
  candidates: (ClusterBounds & { cohesion: number; area: number; manual: boolean; locked: boolean })[],
): ClusterBounds[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.locked) - Number(a.locked) ||
      Number(b.manual) - Number(a.manual) ||
      b.cohesion - a.cohesion ||
      a.area - b.area,
  );
  const kept: (ClusterBounds & { area: number })[] = [];

  for (const candidate of ranked) {
    // A frame someone locked is never dropped for overlapping. They put it
    // there looking at the thing it overlaps.
    if (candidate.locked) {
      kept.push(candidate);
      continue;
    }
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

  return { nodes: placed, clusters: frameClusters(placed, clusters) };
}

/**
 * The frame each group occupies, drawn tight around where its members actually
 * landed — not dagre's own parent box, which spans every rank its children
 * touch, including the space other clusters occupy in between, and is far
 * larger and overlaps far more.
 *
 * On its own so a frame can be redrawn without a layout: a colour, a lock or a
 * hand-placed geometry changes nothing dagre reads, and running it again for
 * those moved every box for a click that meant "hold this one still".
 */
export function frameClusters<T extends Node>(
  placed: readonly T[],
  clusters: readonly ClusterInput[],
): ClusterBounds[] {
  const byId = new Map(placed.map((node) => [node.id, node]));
  const candidates: (ClusterBounds & {
    cohesion: number;
    area: number;
    manual: boolean;
    locked: boolean;
  })[] = [];

  for (const cluster of clusters) {
    // The same rule the layout applies: a frame around one box says nothing.
    const members = cluster.files.filter((file) => byId.has(file));
    if (members.length < 2) continue;

    // A locked frame is where someone put it. Recomputing it from the members
    // would undo the act of locking on the very next edit, which is the one
    // thing a lock is for.
    if (cluster.locked === true && cluster.geometry !== undefined) {
      candidates.push({
        ...cluster.geometry,
        id: cluster.id,
        depth: cluster.depth,
        cohesion: cluster.cohesion,
        area: cluster.geometry.width * cluster.geometry.height,
        manual: cluster.origin === 'manual',
        locked: true,
      });
      continue;
    }

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const file of members) {
      const node = byId.get(file);
      if (!node) continue;
      left = Math.min(left, node.position.x);
      top = Math.min(top, node.position.y);
      right = Math.max(right, node.position.x + (node.width ?? NODE_WIDTH));
      bottom = Math.max(bottom, node.position.y + (node.height ?? DEFAULT_HEIGHT));
    }
    if (!Number.isFinite(left)) continue;

    const padding = cluster.padding ?? defaultPadding(cluster.depth);
    const box = {
      id: cluster.id,
      depth: cluster.depth,
      x: left - padding.x,
      y: top - padding.y - LABEL_HEIGHT,
      width: right - left + padding.x * 2,
      height: bottom - top + padding.y * 2 + LABEL_HEIGHT,
    };
    candidates.push({
      ...box,
      cohesion: cluster.cohesion,
      area: box.width * box.height,
      manual: cluster.origin === 'manual',
      locked: false,
    });
  }

  return withoutOverlaps(candidates);
}

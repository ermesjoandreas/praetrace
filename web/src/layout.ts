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

/** A box where it stands: React Flow's top-left corner and the size dagre was given. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** An edge as the view reports it, with the weight the aggregated ones carry. */
export interface Link {
  from: string;
  to: string;
  weight: number;
}

/**
 * The grid a new box is placed on, and the gap it keeps from its neighbour.
 * Also how far to the right of the neighbour to look before giving up and
 * going below it: past four boxes' worth the new one is no longer beside
 * anything.
 */
export const GRID = 40;
const REACH = 4 * (NODE_WIDTH + GRID);
/** Two boxes closer than this read as touching. */
const CLEARANCE = 20;

const snap = (value: number): number => Math.round(value / GRID) * GRID;

/**
 * Mark, do not move. A save that adds a file used to run dagre again, and dagre
 * has no memory: every box was placed afresh and the whole diagram shuffled for
 * one new box. So the boxes that were there keep the position they had, and
 * each new one is put beside the box it is most connected to — to its right,
 * in the first free slot on a 40px grid, and below it when the right is full.
 * A box connected to nothing goes on a new row under the diagram.
 *
 * A box that changed height — expanded to show every member, or folded back —
 * stays put too, and the boxes under it in its column move by the difference,
 * or the taller box would cover its neighbour. That is the one case in which
 * an existing box moves, and it moves by exactly what the user asked for.
 *
 * Pure: the previous rectangles come in, the new positions go out, and nothing
 * here knows about React Flow.
 */
export function keepLayout<T extends { id: string; width?: number; height?: number }>(
  previous: ReadonlyMap<string, Rect>,
  boxes: readonly T[],
  links: readonly Link[],
): (T & { position: { x: number; y: number } })[] {
  const placed = new Map<string, Rect>();
  const arriving: T[] = [];

  for (const box of boxes) {
    const was = previous.get(box.id);
    if (was === undefined) {
      arriving.push(box);
      continue;
    }
    placed.set(box.id, {
      x: was.x,
      y: was.y,
      width: box.width ?? NODE_WIDTH,
      height: box.height ?? DEFAULT_HEIGHT,
    });
  }

  // Growth pushes the column below it down; shrinking pulls it back up by the
  // same amount, so a fold undoes exactly what the expand did.
  for (const [id, rect] of placed) {
    const was = previous.get(id);
    if (was === undefined) continue;
    const delta = rect.height - was.height;
    if (delta === 0) continue;
    for (const [otherId, other] of placed) {
      if (otherId === id || other.y <= rect.y) continue;
      if (other.x < rect.x + rect.width && rect.x < other.x + other.width) other.y += delta;
    }
  }

  // Where a new row starts, fixed before anything is added so unconnected
  // boxes line up along it instead of stacking under one another.
  let floor = -Infinity;
  let left = Infinity;
  for (const rect of placed.values()) {
    floor = Math.max(floor, rect.y + rect.height);
    left = Math.min(left, rect.x);
  }
  if (!Number.isFinite(floor)) {
    floor = 0;
    left = 0;
  }
  const newRow = { x: snap(left), y: snap(floor + GRID) };

  const free = (candidate: Rect): boolean => {
    for (const other of placed.values()) {
      const apart =
        candidate.x + candidate.width + CLEARANCE <= other.x ||
        other.x + other.width + CLEARANCE <= candidate.x ||
        candidate.y + candidate.height + CLEARANCE <= other.y ||
        other.y + other.height + CLEARANCE <= candidate.y;
      if (!apart) return false;
    }
    return true;
  };

  const slotBeside = (neighbour: Rect, width: number, height: number): Rect => {
    // To the right first, along the neighbour's own row.
    const startX = snap(neighbour.x + neighbour.width + GRID);
    const rowY = snap(neighbour.y);
    for (let x = startX; x <= startX + REACH; x += GRID) {
      const candidate = { x, y: rowY, width, height };
      if (free(candidate)) return candidate;
    }
    // Then below it. Under the whole diagram is always free, so this ends.
    const columnX = snap(neighbour.x);
    for (let y = snap(neighbour.y + neighbour.height + GRID); ; y += GRID) {
      const candidate = { x: columnX, y, width, height };
      if (free(candidate)) return candidate;
    }
  };

  const slotOnNewRow = (width: number, height: number): Rect => {
    for (let x = newRow.x; ; x += GRID) {
      const candidate = { x, y: newRow.y, width, height };
      if (free(candidate)) return candidate;
    }
  };

  /** The placed box this one shares the most edges with, if any. */
  const neighbourOf = (id: string): { id: string; weight: number } | null => {
    const weights = new Map<string, number>();
    for (const link of links) {
      const other = link.from === id ? link.to : link.to === id ? link.from : null;
      if (other === null || other === id || !placed.has(other)) continue;
      weights.set(other, (weights.get(other) ?? 0) + link.weight);
    }
    let best: { id: string; weight: number } | null = null;
    for (const [other, weight] of weights) {
      if (best === null || weight > best.weight) best = { id: other, weight };
    }
    return best;
  };

  // Best-connected first, so a new box whose only link is to another new box
  // finds that one already placed rather than landing on the bottom row.
  while (arriving.length > 0) {
    let pick = 0;
    let best: { id: string; weight: number } | null = null;
    for (let index = 0; index < arriving.length; index++) {
      const candidate = arriving[index];
      if (candidate === undefined) continue;
      const neighbour = neighbourOf(candidate.id);
      if (neighbour !== null && (best === null || neighbour.weight > best.weight)) {
        pick = index;
        best = neighbour;
      }
    }
    const [box] = arriving.splice(pick, 1);
    if (box === undefined) break;
    const width = box.width ?? NODE_WIDTH;
    const height = box.height ?? DEFAULT_HEIGHT;
    const beside = best === null ? undefined : placed.get(best.id);
    placed.set(box.id, beside === undefined ? slotOnNewRow(width, height) : slotBeside(beside, width, height));
  }

  return boxes.map((box) => {
    const rect = placed.get(box.id);
    return { ...box, position: rect === undefined ? { x: 0, y: 0 } : { x: rect.x, y: rect.y } };
  });
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

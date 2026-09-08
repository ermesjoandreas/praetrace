import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_WIDTH = 240;
export const MAX_MEMBERS = 12;

const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 17;
const DEFAULT_HEIGHT = 80;
const LABEL_HEIGHT = 18;

/** The gap dagre leaves between two boxes in one rank, and the one a wrapped
 * column keeps. */
const NODE_SEP = 26;
/**
 * How far apart the columns of one wrapped rank stand. Half of `ranksep`, so a
 * rank that had to fold still reads as one rank rather than as several: the
 * eye is told these boxes are peers by standing closer together than any two
 * real ranks do.
 */
const WRAP_GAP = 60;

/** Two frames sharing more than this much of the smaller one read as one mess. */
const MAX_OVERLAP = 0.25;

/**
 * Boxes are measured before layout rather than after render, because dagre
 * needs dimensions up front and React Flow would otherwise lay out on stale
 * sizes for a frame.
 */
export function boxHeight(memberCount: number, manyFiles: boolean, expanded = false): number {
  // A box standing for many files — a directory, or a bundle of neighbours —
  // draws a count where a file draws its symbols, so it is two lines whatever
  // it holds. Measuring a bundle as a file with no members would give it less
  // room than its own label needs.
  if (manyFiles) return HEADER_HEIGHT + ROW_HEIGHT + 8;
  // Expanding is a layout change, not a CSS reveal. dagre places boxes from
  // these numbers and every group frame is drawn around where they land, so a
  // box that grew without saying so would sit outside its own frame.
  const shown = expanded ? memberCount : Math.min(memberCount, MAX_MEMBERS);
  // The row is still there when expanded — it is how you fold the box back up.
  const overflowRow = memberCount > MAX_MEMBERS ? 1 : 0;
  return HEADER_HEIGHT + (shown + overflowRow) * ROW_HEIGHT + 10;
}

/**
 * The count line under a component's name: 5 + 17 + 5, with the line-height
 * pinned in `.box-component .box-meta` so nothing above it can move the number.
 */
const META_HEIGHT = 27;

/**
 * A component box: the header, the count line, then a compartment of what it
 * provides. The server has already cut that list at a box's worth and says
 * how many it held, so the "+N more" row is counted here rather than found by
 * comparing two lengths — the page never holds the rest.
 *
 * `provided` is the rows drawn, never zero: a component nothing outside
 * reaches draws one row saying so, or the compartment would be an empty band
 * under the header that reads as a box left half-rendered. The trailing 5 is
 * the list's bottom padding and the box's bottom border; the list's top
 * padding is inside HEADER_HEIGHT, as it is for a file box. Measured: 291px
 * for thirteen rows, 87 for one.
 */
export function componentHeight(provided: number, more: boolean): number {
  const rows = Math.max(provided, 1) + (more ? 1 : 0);
  return HEADER_HEIGHT + META_HEIGHT + rows * ROW_HEIGHT + 5;
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
  /**
   * This frame is a **directory**, not a cluster — `view/folders.ts`'s
   * `ViewFolder` handed over as a frame.
   *
   * One field rather than a second frame function, because the geometry is the
   * same geometry: bounds around where the members landed, a locked one used
   * verbatim, a re-hug after a hand placement. Duplicating that to draw a
   * rectangle of a different provenance would give the two ways of drawing a
   * frame two ways of being wrong. What the flag changes is four rules, and
   * each is here because a category and a folder are different *claims*:
   *
   * 1. **A frame around one box is still drawn.** A cluster of one is an
   *    artefact of label propagation and says nothing; a folder of one file is
   *    a statement a developer made. It is 4 of the 12 frames at webapp-h26's
   *    root, `Controllers` and `Models` among them — the wall the folder
   *    arrangement was argued from.
   * 2. **The slack is the inner slack at every depth** (`FOLDER_PADDING`),
   *    never `defaultPadding(0)`'s 38.
   * 3. **The bounds enclose the child frames**, not only the member boxes, so
   *    an outer label clears an inner frame however deep the tree goes.
   * 4. **It is never dropped for overlapping.** A category frame that is not
   *    drawn is a suggestion not shown, and the panel still lists it. A folder
   *    frame that is not drawn is a directory that is not there — a picture
   *    that lies about the tree, which is the one failure this project cares
   *    most about. It is a guarantee rather than a fix: measured over
   *    webapp-h26, astrup and this repository, 190 folder frames across 31
   *    scopes, not one pair reaches `MAX_OVERLAP` under rules 2 and 3. At the
   *    38 of rule 2 four of astrup's pairs do.
   */
  folder?: true;
}

/**
 * The slack between the members and the frame drawn around them, when the group
 * does not carry its own. An outer frame needs room for its own label to clear
 * the inner frame that starts at the same height, which is the common case.
 */
export function defaultPadding(depth: number): { x: number; y: number } {
  return depth === 0 ? { x: 38, y: 38 } : { x: 12, y: 12 };
}

/**
 * A folder frame's slack, at every depth.
 *
 * The same 12 an inner category frame takes, and it is the inner number rather
 * than the outer one for two reasons that agree. A folder frame already
 * encloses its child frames (`boundsOf` below), so the room an outer label
 * needs is inside the union and not in the padding — which is what
 * `defaultPadding`'s 38 buys a category, one level down, by hand. And the
 * slack is what makes sibling frames collide: dagre leaves `NODE_SEP` (26)
 * between two boxes in a rank, so two folders side by side have 24px of
 * padding between them at 12 and 76px at 38. Measured over webapp-h26, astrup
 * and this repository — 190 folder frames across 31 scopes — no pair of
 * sibling frames overlaps past `MAX_OVERLAP` at 12, and four of astrup's do
 * at 38.
 */
const FOLDER_PADDING = { x: 12, y: 12 };

/** The slack a frame is drawn with: its own if it carries one, else by what it is. */
function paddingFor(cluster: ClusterInput): { x: number; y: number } {
  if (cluster.padding !== undefined) return cluster.padding;
  return cluster.folder === true ? FOLDER_PADDING : defaultPadding(cluster.depth);
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
 *
 * A folder frame is not in the contest at all — see `ClusterInput.folder`. It
 * is ranked with the locked ones so that where the two systems are ever drawn
 * together the directory, which is a fact, is the obstacle and the category,
 * which is a reading of the imports, is the one that gives way.
 */
function withoutOverlaps(
  candidates: (ClusterBounds & {
    cohesion: number;
    area: number;
    manual: boolean;
    locked: boolean;
    folder: boolean;
  })[],
): ClusterBounds[] {
  const ranked = [...candidates].sort(
    (a, b) =>
      Number(b.locked) - Number(a.locked) ||
      Number(b.folder) - Number(a.folder) ||
      Number(b.manual) - Number(a.manual) ||
      b.cohesion - a.cohesion ||
      a.area - b.area,
  );
  const kept: (ClusterBounds & { area: number })[] = [];

  for (const candidate of ranked) {
    // A frame someone locked is never dropped for overlapping. They put it
    // there looking at the thing it overlaps. Neither is a folder: a directory
    // the drawing leaves out is a picture that lies about the tree.
    if (candidate.locked || candidate.folder) {
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
 *
 * `windowHeight` is the canvas the diagram will be read in, and it is an input
 * to the layout rather than something the camera sorts out afterwards: a rank
 * taller than the window folds into further columns. 0, or anything not
 * finite, means the window is not known yet and nothing folds.
 */
export function layoutNodes<T extends Node>(
  nodes: T[],
  edges: Edge[],
  clusters: readonly ClusterInput[] = [],
  windowHeight = 0,
): { nodes: T[]; clusters: ClusterBounds[] } {
  const graph = new dagre.graphlib.Graph({ compound: true });
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: NODE_SEP, ranksep: 120, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.width ?? NODE_WIDTH,
      height: node.height ?? DEFAULT_HEIGHT,
    });
  }

  const present = new Set(nodes.map((node) => node.id));
  const registered = new Set<string>();

  // Outer groups first, so an inner one can be parented to a node that exists —
  // and so a box in a nested folder is re-parented inward as the walk goes
  // down, ending on the innermost frame that claimed it. A folder carries every
  // box beneath it in `files`, which is what makes both levels hold together.
  for (const cluster of [...clusters].sort((a, b) => a.depth - b.depth)) {
    // Only the members actually on screen; a frame around one box says nothing
    // — unless it is a folder, which says what a developer wrote down.
    const members = cluster.files.filter((file) => present.has(file));
    if (members.length < (cluster.folder === true ? 1 : 2)) continue;

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

  // **A folder arrangement does not fold.** `wrapTallRanks` moves a box into
  // another column by its rank and its height, and knows nothing about frames:
  // dagre's own border nodes are what keep two clusters apart, and a fold
  // re-spaces the column at `NODE_SEP` without them, so a folder's boxes end up
  // split across columns and the frame drawn round them afterwards stretches
  // over boxes that are not its own. Measured on astrup, every scope that draws
  // as a diagram, in a 900px window: 28 frames were drawn over a box from
  // another folder, and 3 670 on the whole project laid out ungrouped. With the
  // fold off it is 0 in both — dagre nests correctly on its own. So a tall
  // folder diagram is tall, and the camera answers for it; folding whole frames
  // rather than whole ranks is the fix and is not built.
  const folded = wrapTallRanks(placed, clusters.some((cluster) => cluster.folder === true) ? 0 : windowHeight);
  return { nodes: folded, clusters: frameClusters(folded, clusters) };
}

/**
 * A rank taller than the window is not a diagram, it is a list you scroll.
 * 110 of TanStack/query's `packages` boxes land in one dagre rank, 9 558px of
 * it, and fitView answers by zooming to 6% — a picture in which nothing can be
 * read and nothing can be told apart.
 *
 * So the window is an input to the layout, the way it was in Sourcetrail: a
 * rank that outgrows it starts another column, and every rank to its right
 * moves over by what the fold took. Order survives — the rank still reads top
 * to bottom and then left to right — so the boxes a rank put beside each other
 * are still neighbours, only folded.
 *
 * Once anything has folded, every rank is stacked from the same top, folded or
 * not. dagre placed the short ranks where it did to sit level with a 9 558px
 * wall, and that wall is now 686px: leaving them centred against it strands
 * three boxes four thousand pixels below the diagram they belong to, and the
 * picture is no shorter than before. Nothing folds, nothing moves — this
 * touches only the views that were unreadable to begin with.
 *
 * Pure, and it runs inside a first layout only, so nothing here can move a box
 * a save would otherwise have left alone.
 */
function wrapTallRanks<T extends Node>(placed: readonly T[], windowHeight: number): T[] {
  if (!Number.isFinite(windowHeight) || windowHeight <= 0) return [...placed];

  // A rank of an LR layout is a column: dagre gives every box in it the same
  // centre, and these boxes are all one width, so the left edge names the rank.
  const ranks = new Map<number, T[]>();
  for (const node of placed) {
    const x = Math.round(node.position.x);
    const rank = ranks.get(x);
    if (rank === undefined) ranks.set(x, [node]);
    else rank.push(node);
  }

  const heightOf = (node: T): number => node.height ?? DEFAULT_HEIGHT;
  const extentOf = (column: readonly T[]): number =>
    Math.max(...column.map((node) => node.position.y + heightOf(node))) -
    Math.min(...column.map((node) => node.position.y));
  if (![...ranks.values()].some((column) => extentOf(column) > windowHeight)) return [...placed];

  const top = Math.min(...placed.map((node) => node.position.y));
  const moved = new Map<string, { x: number; y: number }>();
  /** What the folds so far have added to the width, carried to the ranks right of them. */
  let shift = 0;

  for (const x of [...ranks.keys()].sort((a, b) => a - b)) {
    const column = [...(ranks.get(x) ?? [])].sort((a, b) => a.position.y - b.position.y);
    const width = Math.max(...column.map((node) => node.width ?? NODE_WIDTH));
    let folds = 0;
    let y = top;
    for (const node of column) {
      const height = heightOf(node);
      // A box taller than the whole window still gets a column of its own
      // rather than none: `y > top` is what makes the first one unconditional.
      if (y > top && y + height - top > windowHeight) {
        folds += 1;
        y = top;
      }
      moved.set(node.id, { x: x + shift + folds * (width + WRAP_GAP), y });
      y += height + NODE_SEP;
    }
    shift += folds * (width + WRAP_GAP);
  }

  return placed.map((node) => {
    const position = moved.get(node.id);
    return position === undefined ? node : { ...node, position };
  });
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
 * **`frames` is what makes a save honest under the folder arrangement.** Where
 * frames are given, an arriving box is placed *inside the frame it belongs
 * to*: its neighbour is looked for among the boxes already in that frame, it
 * falls back to the frame's own bottom-most box rather than to the row under
 * the whole diagram, and no slot is taken that sits inside a frame the box is
 * not in. Without that a new `Views/Home` file whose one import is a model
 * lands next to the model, inside `Models` — and the frame drawn around it
 * afterwards is a `Views/Home` rectangle with a `Models` file in it, which is
 * the folder view saying something false about the tree it exists to draw.
 * The caller decides what to hand over: folder frames want this, and a
 * category frame — which spans directories by definition — does not.
 *
 * Pure: the previous rectangles come in, the new positions go out, and nothing
 * here knows about React Flow.
 */
export function keepLayout<T extends { id: string; width?: number; height?: number }>(
  previous: ReadonlyMap<string, Rect>,
  boxes: readonly T[],
  links: readonly Link[],
  frames: readonly ClusterInput[] = [],
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

  // Which frame each box is innermost in, and the chain of frames it is inside
  // — its own and every one above it. A box in none is in the scope itself,
  // which is the canvas rather than a frame, so every frame is foreign to it.
  const byFrame = new Map<string, ClusterInput>(frames.map((frame) => [frame.id, frame]));
  const homeOf = new Map<string, string>();
  for (const frame of [...frames].sort((a, b) => a.depth - b.depth)) {
    for (const file of frame.files) homeOf.set(file, frame.id);
  }
  const chainOf = (id: string): Set<string> => {
    const chain = new Set<string>();
    let at = homeOf.get(id);
    while (at !== undefined && !chain.has(at)) {
      chain.add(at);
      at = byFrame.get(at)?.parent ?? undefined;
    }
    return chain;
  };

  /** Where a frame stands: around the boxes of it that are placed, plus one
   * more if the box arriving belongs to it. Recomputed for every candidate,
   * because the box placed a moment ago may have grown it. */
  const boundsOf = (frame: ClusterInput, extra?: Rect): Rect | null => {
    let x = Infinity;
    let y = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    const rects = frame.files.map((file) => placed.get(file));
    if (extra !== undefined) rects.push(extra);
    for (const rect of rects) {
      if (rect === undefined) continue;
      x = Math.min(x, rect.x);
      y = Math.min(y, rect.y);
      right = Math.max(right, rect.x + rect.width);
      bottom = Math.max(bottom, rect.y + rect.height);
    }
    return Number.isFinite(x) ? { x, y, width: right - x, height: bottom - y } : null;
  };

  const overlaps = (a: Rect, b: Rect): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  /** The second half on its own: the box is not inside a frame it is not in.
   * It is what the search falls back to, because it can always be satisfied —
   * every frame is a bounding box of boxes, and under the diagram is outside
   * all of them. */
  const outsideTheRest = (id: string, candidate: Rect): boolean => {
    if (frames.length === 0) return true;
    const chain = chainOf(id);
    for (const frame of frames) {
      if (chain.has(frame.id)) continue;
      const rect = boundsOf(frame);
      if (rect !== null && overlaps(rect, candidate)) return false;
    }
    return true;
  };

  /**
   * **Every frame holds only its own boxes.** That is the whole of what a
   * folder frame claims, and the one thing a save can break: the frame drawn
   * afterwards is the bounding box of wherever its members ended up, so a new
   * `Views/Home` file parked on the far side of `Models` does not merely sit
   * in the wrong place — it stretches the `Views/Home` rectangle across
   * `Models`, and the picture then says a file is in a folder it is not in.
   *
   * Two halves, and the second is what a box in no folder at all is held to:
   * a frame this box belongs to must not grow over a stranger, and a frame it
   * does not belong to must not end up with it inside.
   */
  const holdsOnlyItsOwn = (id: string, candidate: Rect): boolean => {
    if (frames.length === 0) return true;
    const chain = chainOf(id);
    for (const frameId of chain) {
      const frame = byFrame.get(frameId);
      if (frame === undefined) continue;
      const grown = boundsOf(frame, candidate);
      if (grown === null) continue;
      const own = new Set(frame.files);
      for (const [otherId, rect] of placed) {
        if (own.has(otherId)) continue;
        if (overlaps(grown, rect)) return false;
      }
    }
    return outsideTheRest(id, candidate);
  };

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

  /**
   * The first free slot beside a box: to its right along its own row, then
   * below it in its column. `ok` is what else the slot has to be, and `reach`
   * how far down to look before giving up — `Infinity` for the pass that must
   * answer, a bounded look for the pass that may be refused.
   */
  const slotBeside = (
    neighbour: Rect,
    width: number,
    height: number,
    ok: (candidate: Rect) => boolean,
    reach: number,
  ): Rect | null => {
    const startX = snap(neighbour.x + neighbour.width + GRID);
    const rowY = snap(neighbour.y);
    for (let x = startX; x <= startX + REACH; x += GRID) {
      const candidate = { x, y: rowY, width, height };
      if (free(candidate) && ok(candidate)) return candidate;
    }
    const columnX = snap(neighbour.x);
    const startY = snap(neighbour.y + neighbour.height + GRID);
    for (let y = startY; y <= startY + reach; y += GRID) {
      const candidate = { x: columnX, y, width, height };
      if (free(candidate) && ok(candidate)) return candidate;
    }
    return null;
  };

  const slotOnNewRow = (id: string, width: number, height: number): Rect => {
    // Under the whole diagram is always free, so this ends.
    for (let x = newRow.x; ; x += GRID) {
      const candidate = { x, y: newRow.y, width, height };
      if (free(candidate) && outsideTheRest(id, candidate)) return candidate;
    }
  };

  /**
   * The placed box this one shares the most edges with, if any — and, where the
   * box is in a frame, only from inside that frame. A neighbour outside it is
   * not somewhere this box may go.
   */
  const neighbourOf = (id: string): { id: string; weight: number } | null => {
    const home = homeOf.get(id);
    const weights = new Map<string, number>();
    for (const link of links) {
      const other = link.from === id ? link.to : link.to === id ? link.from : null;
      if (other === null || other === id || !placed.has(other)) continue;
      if (home !== undefined && !chainOf(other).has(home)) continue;
      weights.set(other, (weights.get(other) ?? 0) + link.weight);
    }
    let best: { id: string; weight: number } | null = null;
    for (const [other, weight] of weights) {
      if (best === null || weight > best.weight) best = { id: other, weight };
    }
    return best;
  };

  /**
   * The box to hang a new one off when nothing in its frame is connected to it:
   * the bottom-most box already inside that frame. A new file in a folder
   * belongs in that folder whether or not it imports anything there — and the
   * row under the whole diagram, which is where an unconnected box goes
   * otherwise, is outside every frame there is.
   */
  const anchorInHome = (id: string): string | null => {
    const home = homeOf.get(id);
    if (home === undefined) return null;
    let best: { id: string; y: number; x: number } | null = null;
    for (const file of byFrame.get(home)?.files ?? []) {
      const rect = placed.get(file);
      if (rect === undefined) continue;
      const y = rect.y + rect.height;
      if (best === null || y > best.y || (y === best.y && rect.x > best.x)) best = { id: file, y, x: rect.x };
    }
    return best === null ? null : best.id;
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
    const anchor = best === null ? anchorInHome(box.id) : best.id;
    const beside = anchor === null ? undefined : placed.get(anchor);
    // Two passes where there are frames, and only the first can be refused.
    // A folder boxed in on every side — dagre packs a rank 26px apart — has no
    // slot that keeps every frame pure, and looking for one for ever is not an
    // answer, so the strict pass gives up after `REACH`. What the loose pass
    // still guarantees is that the box is not drawn inside somebody else's
    // folder; what it cannot guarantee is that this box's own frame, stretched
    // to reach it, covers nothing of theirs. That case is a picture that lies,
    // and the only honest fix is to move a box that was already placed, which
    // is the one thing this function exists not to do. How often it fires on a
    // real save is not measured: the folder arrangement is not on a page yet.
    const slot =
      beside === undefined
        ? null
        : (slotBeside(beside, width, height, (rect) => holdsOnlyItsOwn(box.id, rect), REACH) ??
          slotBeside(beside, width, height, (rect) => outsideTheRest(box.id, rect), Infinity));
    placed.set(box.id, slot ?? slotOnNewRow(box.id, width, height));
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
 *
 * **Deepest first, and a folder frame encloses the frames inside it.** A
 * category nests one level and `defaultPadding(0)`'s 38 is enough room for the
 * outer label to clear the inner frame's top edge — 12 of slack and 18 of
 * label, with 8 to spare. Folders nest to four on real trees, so counting that
 * room out in padding would need it to grow at every level, which is the
 * direction that makes sibling frames collide. Instead the union below carries
 * it: an outer folder's bounds cover its children's *frames*, which already
 * hold their own label bands, so one slack at every depth draws a tree that
 * nests visibly however deep it goes. A category is untouched by this — it
 * takes the bounds of its member boxes, exactly as before.
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
    folder: boolean;
  })[] = [];
  /** The frame each cluster got, for its parent to enclose. */
  const drawn = new Map<string, Rect>();
  const childrenOf = new Map<string, string[]>();
  for (const cluster of clusters) {
    if (cluster.parent !== null) pushTo(childrenOf, cluster.parent, cluster.id);
  }

  // Deepest first, so a frame's children have their bounds before it asks for
  // them. The order candidates are pushed in says nothing: `withoutOverlaps`
  // ranks them itself.
  for (const cluster of [...clusters].sort((a, b) => b.depth - a.depth)) {
    // The same rule the layout applies: a frame around one box says nothing,
    // and a folder is the exception for the reason `ClusterInput.folder` gives.
    const members = cluster.files.filter((file) => byId.has(file));
    if (members.length < (cluster.folder === true ? 1 : 2)) continue;

    // A locked frame is where someone put it. Recomputing it from the members
    // would undo the act of locking on the very next edit, which is the one
    // thing a lock is for.
    if (cluster.locked === true && cluster.geometry !== undefined) {
      drawn.set(cluster.id, cluster.geometry);
      candidates.push({
        ...cluster.geometry,
        id: cluster.id,
        depth: cluster.depth,
        cohesion: cluster.cohesion,
        area: cluster.geometry.width * cluster.geometry.height,
        manual: cluster.origin === 'manual',
        locked: true,
        folder: cluster.folder === true,
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
    if (cluster.folder === true) {
      for (const child of childrenOf.get(cluster.id) ?? []) {
        const rect = drawn.get(child);
        if (rect === undefined) continue;
        left = Math.min(left, rect.x);
        top = Math.min(top, rect.y);
        right = Math.max(right, rect.x + rect.width);
        bottom = Math.max(bottom, rect.y + rect.height);
      }
    }
    if (!Number.isFinite(left)) continue;

    const padding = paddingFor(cluster);
    const box = {
      id: cluster.id,
      depth: cluster.depth,
      x: left - padding.x,
      y: top - padding.y - LABEL_HEIGHT,
      width: right - left + padding.x * 2,
      height: bottom - top + padding.y * 2 + LABEL_HEIGHT,
    };
    drawn.set(cluster.id, box);
    candidates.push({
      ...box,
      cohesion: cluster.cohesion,
      area: box.width * box.height,
      manual: cluster.origin === 'manual',
      locked: false,
      folder: cluster.folder === true,
    });
  }

  return withoutOverlaps(candidates);
}

function pushTo(map: Map<string, string[]>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}

// --- the activity diagram ----------------------------------------------------

/**
 * A box on the flow of one function, sized by the page before dagre places it
 * — the same order the class diagram keeps, and for the same reason: dagre
 * needs the dimensions up front, and the cull rectangle is computed from them.
 */
export interface FlowBox {
  id: string;
  width: number;
  height: number;
}

export interface FlowLink {
  from: string;
  to: string;
}

/**
 * How wide a character of the label is, in the 11px monospace the boxes are
 * set in. Menlo at 11px measures 6.6px a glyph; a label longer than the widest
 * box is cut with an ellipsis, and the line range on the box says where the
 * rest is.
 */
const FLOW_CHAR = 6.6;
/** The room a diamond's corners take from its label, either side. */
const DIAMOND_SLACK = 56;
/** One line of a box: the label, or the `+N more` / note line under it. */
const FLOW_LINE = 14;

/**
 * The size of one box, by what it is. The two circles are UML's own — a
 * filled dot for start and a bullseye for end — and a decision wants a
 * diamond, which is why it is wider and taller than the text it holds: the
 * label sits in the diamond's middle band, and the corners need room past it.
 */
export function flowBoxSize(
  kind: 'start' | 'end' | 'action' | 'decision' | 'loop' | 'try' | 'exit',
  label: string,
  extraLines = 0,
): { width: number; height: number } {
  const text = Math.ceil(label.length * FLOW_CHAR);
  switch (kind) {
    case 'start':
      return { width: 20, height: 20 };
    case 'end':
      return { width: 24, height: 24 };
    case 'decision':
    case 'loop':
      return { width: Math.min(340, Math.max(128, text + DIAMOND_SLACK)), height: 56 + extraLines * FLOW_LINE };
    case 'try':
      return { width: Math.min(200, Math.max(72, text + 24)), height: 28 };
    case 'exit':
      return { width: Math.min(320, Math.max(72, text + 24)), height: 24 };
    default:
      return { width: Math.min(320, Math.max(96, text + 24)), height: 28 + extraLines * FLOW_LINE };
  }
}

/**
 * Where every box of a flow stands, top to bottom, and which links run back
 * up — a loop's way round, a `continue` — so the page can draw those round the
 * side of the body rather than through it.
 *
 * Top to bottom because that is how an activity diagram reads and how the
 * source reads: the first statement at the top, the end at the bottom. dagre
 * breaks the cycles a loop makes on its own; what it does not say is which
 * edge it reversed, and the answer the page wants is the geometric one anyway:
 * a link whose target sits at or above its source is drawn as a return.
 *
 * `backward` is aligned with `links` by index rather than keyed by the pair,
 * because two cases of a switch can run from the same decision to the same
 * box under different labels, and a key would fold them into one.
 */
export function layoutFlow(
  boxes: readonly FlowBox[],
  links: readonly FlowLink[],
): { positions: Map<string, { x: number; y: number }>; backward: boolean[] } {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'TB', nodesep: 32, ranksep: 36, marginx: 24, marginy: 24 });
  for (const box of boxes) graph.setNode(box.id, { width: box.width, height: box.height });
  const known = new Set(boxes.map((box) => box.id));
  for (const link of links) {
    if (known.has(link.from) && known.has(link.to)) graph.setEdge(link.from, link.to);
  }
  dagre.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const box of boxes) {
    const placed = graph.node(box.id);
    if (!placed) continue;
    // dagre positions by centre, React Flow by top-left corner.
    positions.set(box.id, { x: placed.x - box.width / 2, y: placed.y - box.height / 2 });
  }
  const backward = links.map((link) => {
    const from = positions.get(link.from);
    const to = positions.get(link.to);
    return from !== undefined && to !== undefined && to.y <= from.y;
  });
  return { positions, backward };
}

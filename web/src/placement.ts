import type { Presentation, ViewGraph } from './api';

/**
 * Where a person put a box, and how wide they made it — the arithmetic half of
 * arranging a diagram by hand. Pure: it reads nothing off the page and draws
 * nothing, so every rule below is a function `placement.test.ts` can call. The
 * canvas owns the gestures (React Flow's `nodesDraggable`, the `NodeResizer`
 * the frames already use, the context menu item that drops one); this module
 * owns what a placement *is*, which view it belongs to, how it survives a
 * reload, and when it is thrown away.
 *
 * **A placement is not the project's.** A frame's geometry goes in
 * `.codemap/groups.json`, in the repository, committed, because a category is
 * a piece of architecture and belongs beside the code. A box position is not
 * that. It is one person's arrangement of one view on one screen — worth
 * nothing to anybody else, and writing it into a repository somebody opened
 * only to read would put a file there for a drag. That is the objection the
 * `.codemap/` consent gate already exists for, and a drag is a worse reason to
 * trip it than naming a category was. So placements live in the browser,
 * keyed by project root and by view, and never in a file. `panes.ts` is the
 * shape followed here, down to the version key and the two try/catches.
 *
 * **A placement is kept until it is dropped, never until it is unused.** The
 * store is written by exactly two things: a drag or a resize, and one of the
 * two ways back (`withoutPlacement`, `withoutView`). Which boxes a view
 * happens to draw never touches it. So hiding tests, filtering to changes,
 * navigating away, an agent deleting a file, a diff redrawing — none of them
 * costs a placement, and a box that comes back after a filter is turned off is
 * where it was left. The alternative, dropping what is not on screen, would
 * make `?tests=0` a destructive gesture and turning it back off a shuffle,
 * which is the thing the whole live-update rule exists to prevent.
 *
 * **Mark, do not move, made to a person instead of to an algorithm.**
 * `keepLayout` promises a save will not move a box; this promises nothing will.
 * `applyPlacements` therefore runs *last*, after dagre or after `keepLayout`,
 * and after the growth push a box that expanded gives the column under it: a
 * hand-placed box does not move because its neighbour grew into it. It is
 * where you put it, and something now overlaps it, which is a picture you made
 * and can see.
 */

/** The whole spec, as `api.ts` re-exports it. The key below reads six of its fields. */
type ViewSpec = ViewGraph['spec'];

/**
 * One box, placed by hand.
 *
 * `x` and `y` are React Flow's, the top-left corner in flow coordinates — the
 * same numbers `layout.ts` deals in, so a stored placement and a computed
 * position are directly interchangeable and nothing has to convert.
 *
 * **There is no height, deliberately.** A box's height is what it holds:
 * `boxHeight` is a header plus a row per member, so a tall box means many
 * symbols. Stretching one would make it say something untrue about the file —
 * an empty band reading as forty methods — and this project's whole rule is
 * that a wrong picture which looks authoritative is worse than no picture.
 * Width says nothing about content, so width can be anything, and it buys
 * something real: a long path and a long symbol name are ellipsised in a
 * 240px box. Somebody who wants a taller box wants more members, and the
 * product already has that gesture — `MAX_MEMBERS` caps the list and Expand
 * lifts the cap.
 */
export interface Placement {
  x: number;
  y: number;
  /** Absent means the box is its ordinary width; nothing here is a default. */
  width?: number;
}

/** Every hand placement in one view: box id -> where it was put. */
export type Placements = ReadonlyMap<string, Placement>;

/**
 * Every project's every view. Three maps deep, and each level is one of the
 * three caps below.
 *
 * Insertion order is the recency, at every level: a `Map` keeps it, and
 * `withPlacement` deletes before it sets so re-placing a box moves it to the
 * end. That is what makes the caps an LRU with no timestamps to store — the
 * order is already there, and a timestamp per placement would roughly double
 * the bytes to say something only eviction ever asks.
 */
export type Store = Map<string, Map<string, Map<string, Placement>>>;

/**
 * Below this a box cannot show its own name: the header is an icon, an
 * ellipsised label and the badges, and there is no width at which showing
 * three characters of a path is worth having.
 */
export const MIN_BOX_WIDTH = 160;

/**
 * Three times the default 240. Wider than this a box stops being one box among
 * boxes and becomes a banner, and every path it exists to show fits long
 * before it. Both bounds are exported because the `NodeResizer` on the canvas
 * has to be given them and this module has to clamp what is stored: one home,
 * two readers, so a handle that stops at one number and a store that accepts
 * another can never disagree.
 */
export const MAX_BOX_WIDTH = 720;

/**
 * How many boxes one view may hold placements for.
 *
 * A view past `LIST_ABOVE` is a list and stores nothing at all, so the only
 * way to reach this is `?as=diagram` or a focus on a densely coupled file —
 * where a person really could arrange hundreds of boxes. Two hundred of them,
 * at roughly 45 bytes a path, is about 9KB: enough that nobody arranging a
 * diagram by hand will meet it, small enough that the worst case below stays
 * inside a browser's budget. Past it the least recently placed box is dropped
 * and goes back to where the layout wanted it. Dropping is the rude answer and
 * refusing the drag is the ruder one: a gesture that silently does nothing is
 * worse than one that costs the oldest of two hundred.
 */
export const MAX_PLACEMENTS = 200;

/** How many views of one project keep an arrangement. A person works in a
 * handful of scopes and focuses; twenty-four is far past that, and the least
 * recently arranged one goes first. */
export const MAX_VIEWS = 24;

/** How many projects keep any. Six, and the worst case above it — six times
 * twenty-four times nine kilobytes — is about 1.3MB against a 5MB origin
 * budget, and it takes 28 800 drags to build. */
export const MAX_PROJECTS = 6;

// --- the view key ------------------------------------------------------------

/**
 * Which view a placement belongs to, or `null` for a view that has no
 * positions at all.
 *
 * **A list has no positions**, so a list gets no key, and every reader and
 * writer below answers a `null` key with nothing. That is the enforcement
 * rather than a rule somebody has to remember: a project that opens as a list
 * cannot silently store anything, because there is no key to store it under.
 *
 * **In the key: the place.** `diagram`, because a component box is a category
 * and a class box is a file, and an arrangement of one says nothing about the
 * other. `focus`, `category` and `scope`, because those are the three ways of
 * saying which part of the project is on screen. And whether a `diff` is on,
 * because a diff drops scope, focus and category from the echoed spec — so
 * without it a diff of the whole project and the root diagram would share one
 * key, and opening a diff would scatter boxes nobody moved.
 *
 * **And whether the folders are frames**, for the same reason as `diff` and
 * with the same sharpness: the folder arrangement and the flat one draw the
 * same box ids of the same scope in different places, so one shared key means
 * a box moved in one jumps in the other and jumps back on the way out. Its
 * value stays out because it has none — `folders` is `true` or absent, one
 * spelling per answer.
 *
 * **Out of the key: everything that changes which boxes are drawn rather than
 * where the drawn ones belong.**
 *
 * - `filter` — hiding tests or filtering to changes takes boxes away and puts
 *   them back. That is the case the "kept, never dropped" rule above is for,
 *   and keying on the filter would defeat it in the other direction: the same
 *   box would have one position with tests shown and another without.
 * - `depth` — a focus at depth 2 is the same centre as at depth 1 with more
 *   neighbours around it. Same argument as a filter.
 * - `at` — the commit's graph is scanned exactly as the working tree is and
 *   its ids match, so last week's diagram lines up with this week's, which is
 *   the whole reason to freeze one beside the other. Keying on it would also
 *   mint a key per commit anybody looked at and eat `MAX_VIEWS` in an
 *   afternoon.
 * - `diff`'s *value*, for both of those reasons at once: `diff=base` resolves
 *   to a different sha every time somebody commits, and `diff=<sha>` is a new
 *   key per commit compared.
 * - `as` — forcing a big scope to a diagram and finding it a diagram by the
 *   threshold are the same picture, so they share the arrangement. The
 *   presentation argument above is what decides whether there is one at all.
 *
 * The key is JSON rather than a joined string because a path may legally hold
 * whatever separator was picked, and two views quietly sharing a key is
 * placements landing on boxes nobody placed.
 */
export function viewKeyOf(spec: ViewSpec, presentation: Presentation): string | null {
  if (presentation === 'list') return null;
  const key: (string | number)[] = [
    spec.diagram,
    spec.focus ?? '',
    spec.category ?? '',
    spec.scope,
    spec.diff === undefined ? 0 : 1,
  ];
  // Appended only when it is on, so every key written before the folder
  // arrangement existed is still the key the flat view asks for. Bumping
  // `PLACEMENT_VERSION` instead would have been the tidy answer and would have
  // thrown away every arrangement in every project to add a view nobody had
  // used yet.
  if (spec.folders !== undefined) key.push(1);
  return JSON.stringify(key);
}

// --- the merge ---------------------------------------------------------------

/** What `applyPlacements` needs of a box: React Flow's node, narrowed to the
 * three fields a placement touches. */
export interface Placeable {
  id: string;
  position: { x: number; y: number };
  width?: number;
}

/**
 * A computed layout with the hand placements laid over it.
 *
 * Runs last — after `layoutNodes` or `keepLayout`, before `frameClusters` — and
 * that order is the whole contract. After the layout, because a placement wins
 * over anything computed. Before the frames, because a frame is drawn tight
 * around where its members actually landed, so moving a member has to re-hug
 * the frame; a locked frame is a placement of its own and wins over that, which
 * `frameClusters` already decides.
 *
 * A placement for a box this view is not drawing applies to nothing and is
 * left alone in the store. Two boxes placed on top of each other stay on top
 * of each other: somebody put them there, and inventing avoidance would move a
 * box a person placed, which is the one thing this file exists to stop.
 */
export function applyPlacements<T extends Placeable>(boxes: readonly T[], placements: Placements): T[] {
  if (placements.size === 0) return [...boxes];
  return boxes.map((box) => {
    const held = placements.get(box.id);
    if (held === undefined) return box;
    return {
      ...box,
      position: { x: held.x, y: held.y },
      // Spread rather than assigned, because `exactOptionalPropertyTypes` is on
      // and an absent width is absent, not `undefined`.
      ...(held.width === undefined ? {} : { width: held.width }),
    };
  });
}

// --- the store, as arithmetic ------------------------------------------------

/** The most recent `max` entries, in order. A `Map` carries its own recency,
 * so the oldest are simply the ones the walk skips. */
function trimTo<V>(entries: Map<string, V>, max: number): Map<string, V> {
  if (entries.size <= max) return entries;
  const kept = new Map<string, V>();
  let skip = entries.size - max;
  for (const [key, value] of entries) {
    if (skip > 0) {
      skip -= 1;
      continue;
    }
    kept.set(key, value);
  }
  return kept;
}

/** Every cap applied, top down. Run on read as well as on write, so a store
 * left by another version of this file cannot be over its bounds while this
 * one holds it. */
function capped(store: Store): Store {
  const projects = trimTo(store, MAX_PROJECTS);
  const next: Store = new Map();
  for (const [root, views] of projects) {
    const kept = new Map<string, Map<string, Placement>>();
    for (const [key, boxes] of trimTo(views, MAX_VIEWS)) kept.set(key, trimTo(boxes, MAX_PLACEMENTS));
    next.set(root, kept);
  }
  return next;
}

/** The placements of one view, or an empty map. Never null: a caller asking
 * where the boxes go has an answer either way, and "nothing has been placed"
 * is an answer. */
export function readView(store: Store, root: string, key: string | null): Placements {
  if (key === null) return new Map();
  return store.get(root)?.get(key) ?? new Map();
}

/** A width the handle should have stopped at anyway, in case it did not — a
 * stored number from another version, or a resize the canvas forgot to bound. */
function clampWidth(width: number): number {
  return Math.round(Math.min(MAX_BOX_WIDTH, Math.max(MIN_BOX_WIDTH, width)));
}

/**
 * One box placed, in a new store that shares everything it did not touch.
 *
 * The project, the view and the box are each deleted before they are set, so
 * all three move to the end of their level and the caps evict what has been
 * left alone longest. A placement whose numbers are not finite is refused
 * outright rather than stored and filtered later: a NaN reaching dagre or a
 * frame's bounds is an unreadable diagram, not a wrong pixel.
 */
export function withPlacement(store: Store, root: string, key: string | null, id: string, placement: Placement): Store {
  if (key === null) return store;
  if (!Number.isFinite(placement.x) || !Number.isFinite(placement.y)) return store;

  const next: Store = new Map(store);
  const views = new Map(next.get(root) ?? []);
  const boxes = new Map(views.get(key) ?? []);

  boxes.delete(id);
  boxes.set(id, {
    x: Math.round(placement.x),
    y: Math.round(placement.y),
    ...(placement.width === undefined || !Number.isFinite(placement.width)
      ? {}
      : { width: clampWidth(placement.width) }),
  });

  views.delete(key);
  views.set(key, boxes);
  next.delete(root);
  next.set(root, views);
  return capped(next);
}

/**
 * One box put back where the layout wants it. The view and the project are
 * left in place even when the last box leaves them — an empty view weighs a
 * key and holds a slot that the next drag in it wanted anyway, and dropping
 * levels here would mean this function and `withoutView` do different things
 * for the same reason.
 */
export function withoutPlacement(store: Store, root: string, key: string | null, id: string): Store {
  if (key === null) return store;
  const views = store.get(root);
  const boxes = views?.get(key);
  if (views === undefined || boxes === undefined || !boxes.has(id)) return store;

  const next: Store = new Map(store);
  const kept = new Map(boxes);
  kept.delete(id);
  const nextViews = new Map(views);
  nextViews.set(key, kept);
  next.set(root, nextViews);
  return next;
}

/**
 * Every placement in one view, dropped — what View › Re-layout does before it
 * runs dagre again. The whole view and not only the boxes on screen: a
 * placement is kept while its box is filtered out, so re-laying out the drawn
 * half and leaving the hidden half placed would put the arrangement back the
 * moment the filter came off. The menu item says the number, which is
 * `placements.size`.
 */
export function withoutView(store: Store, root: string, key: string | null): Store {
  if (key === null) return store;
  const views = store.get(root);
  if (views === undefined || !views.has(key)) return store;
  const next: Store = new Map(store);
  const kept = new Map(views);
  kept.delete(key);
  next.set(root, kept);
  return next;
}

// --- the wire format ---------------------------------------------------------

export const STORAGE_KEY = 'codemap.placements';

/**
 * Bumped whenever the shape below changes meaning. A store under any other
 * version is dropped for an empty one, the way `panes.ts` drops a layout: the
 * cost of losing an arrangement once is an arrangement to make again, and the
 * cost of misreading one is boxes in places nobody put them.
 *
 * `codemap.` and not `codemaps.`: the key in a browser's storage is a contract
 * with every window that already has one, the same as `.codemap/` on disk.
 */
export const PLACEMENT_VERSION = 1;

/**
 * A placement on the wire is `[x, y]`, or `[x, y, width]` when there is one.
 * Two numbers rather than `{"x":…,"y":…}` because this is the level with a
 * cap on it, and the pair is what a placement is.
 */
type StoredPlacement = [number, number] | [number, number, number];

interface StoredStore {
  version: number;
  /** project root -> view key -> box id -> placement, in recency order. */
  projects: Record<string, Record<string, Record<string, StoredPlacement>>>;
}

/**
 * The store as JSON, recency and all: object keys keep their insertion order
 * for every key that is not an array index, and a project root, a view key
 * (which starts with `[`) and a box id — a path, a `bundle:in:1`, a cluster id
 * — are none of them that. A box id that was a bare integer would be hoisted
 * to the front by `JSON.parse` and evicted early; it would still be drawn
 * exactly where it was put, because order decides only what the caps throw
 * away.
 */
export function serializeStore(store: Store): string {
  const projects: StoredStore['projects'] = {};
  for (const [root, views] of store) {
    const stored: Record<string, Record<string, StoredPlacement>> = {};
    for (const [key, boxes] of views) {
      const placed: Record<string, StoredPlacement> = {};
      for (const [id, placement] of boxes) {
        placed[id] =
          placement.width === undefined
            ? [placement.x, placement.y]
            : [placement.x, placement.y, placement.width];
      }
      stored[key] = placed;
    }
    projects[root] = stored;
  }
  return JSON.stringify({ version: PLACEMENT_VERSION, projects } satisfies StoredStore);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One entry, or null when it is not a placement. A bad entry costs itself and
 * not the view it sits in: a single unreadable pair should not scatter the
 * nineteen boxes beside it. */
function readPlacement(value: unknown): Placement | null {
  if (!Array.isArray(value)) return null;
  const x = finite(value[0]);
  const y = finite(value[1]);
  if (x === null || y === null) return null;
  const width = finite(value[2]);
  return width === null ? { x: Math.round(x), y: Math.round(y) } : { x: Math.round(x), y: Math.round(y), width: clampWidth(width) };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Whatever was in storage, read as a store. Every failure is an empty store
 * and none of them is an error: the string can be absent, somebody else's,
 * half-written, or written by a version of this file that meant something
 * different by it, and none of those is worth showing a person who only opened
 * a window.
 */
export function parseStore(raw: string | null): Store {
  const empty: Store = new Map();
  if (raw === null || raw === '') return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  // `unknown` rather than a cast: the whole point of this function is that the
  // thing in storage may be nothing of the sort.
  const top = record(parsed);
  if (top === null || top.version !== PLACEMENT_VERSION) return empty;
  const projects = record(top.projects);
  if (projects === null) return empty;

  const store: Store = new Map();
  for (const [root, rawViews] of Object.entries(projects)) {
    const views = record(rawViews);
    if (views === null) continue;
    const kept = new Map<string, Map<string, Placement>>();
    for (const [key, rawBoxes] of Object.entries(views)) {
      const boxes = record(rawBoxes);
      if (boxes === null) continue;
      const placed = new Map<string, Placement>();
      for (const [id, value] of Object.entries(boxes)) {
        const placement = readPlacement(value);
        if (placement !== null) placed.set(id, placement);
      }
      kept.set(key, placed);
    }
    store.set(root, kept);
  }
  return capped(store);
}

// --- storage -----------------------------------------------------------------

/**
 * `localStorage` is reached through a try/catch twice over — once for the
 * accessor and once for the call — because a private window, a browser told to
 * block site data, and a full quota each throw from a different one of them.
 * There is no fallback to arrange: a person who cannot store an arrangement
 * gets the computed layout every time, which is the layout this app had until
 * today, and never an error about it.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function load(): Store {
  const store = storage();
  if (store === null) return new Map();
  try {
    return parseStore(store.getItem(STORAGE_KEY));
  } catch {
    return new Map();
  }
}

function save(next: Store): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, serializeStore(next));
  } catch {
    // Nothing to do and nothing to say: the diagram is arranged either way,
    // and it is only the next reload that will not remember.
  }
}

/**
 * One change, written only if it changed something. Every function above hands
 * back the store it was given when it had nothing to do — a null key, a
 * placement that is not two finite numbers, a box that was never placed — so
 * identity is the whole test, and a gesture that stored nothing leaves storage
 * untouched. Without that, a drag on a list wrote an empty envelope: nothing
 * was in it, and it was still a write to a browser for a view that has no
 * positions.
 */
function change(root: string, key: string | null, edit: (store: Store) => Store): Placements {
  const current = load();
  const next = edit(current);
  if (next !== current) save(next);
  return readView(next, root, key);
}

/**
 * The four calls the page makes. Each reads storage, does one thing to it, and
 * hands back the placements for the view asked about — so the page holds one
 * `Placements` in state and every gesture is `setPlacements(placeBox(…))`.
 *
 * Read-modify-write on every drag rather than a store held in memory, because
 * two windows on the same project are two windows, and the one that saved last
 * should not lose what the other one placed in a different view.
 */
export function loadPlacements(root: string, key: string | null): Placements {
  return readView(load(), root, key);
}

export function placeBox(root: string, key: string | null, id: string, placement: Placement): Placements {
  return change(root, key, (store) => withPlacement(store, root, key, id, placement));
}

export function dropBox(root: string, key: string | null, id: string): Placements {
  return change(root, key, (store) => withoutPlacement(store, root, key, id));
}

export function dropView(root: string, key: string | null): Placements {
  return change(root, key, (store) => withoutView(store, root, key));
}

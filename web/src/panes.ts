/**
 * The arithmetic behind the sashes: where a border may stand, what a drag does
 * to the two panes on either side of it, and what a layout saved yesterday
 * means in today's window. Pure — it reads nothing off the page and writes
 * nothing to it, so every rule below is a function `panes.test.ts` can call.
 * The DOM half (the 4px hit areas, the pointer capture, the inline styles) is
 * the component's; this module never sees an element.
 *
 * **One layout for the app, not one per project.** The sizes describe the
 * window somebody arranged — how much room the repository column is worth on
 * *their* screen — and a window does not become a different window because the
 * canvas is now showing another repository. Keying the layout by project root
 * would rearrange the furniture on every switch, which is the one thing an
 * arrangement is supposed to survive; it would also mean the first look at a
 * new project is the layout of a window nobody has arranged. So there is one
 * key, and switching projects moves nothing.
 *
 * Sizes are pixels, not shares. A share survives a window resize for free, but
 * it cannot say "collapsed" or "folded" — 0 and 22px are absolute facts about
 * a pane, not fractions of anything — and it turns every drag into a division.
 * Pixels are what the pointer gives, so pixels are what is stored, and
 * `clampLayout` is the price: a stored layout is fitted to the window it is
 * being restored into, never restored off-screen.
 */

export type BarId = 'leftbar' | 'sidebar';

export type SectionId =
  | 'repository'
  | 'sourceControl'
  | 'categories'
  | 'activity'
  | 'followed'
  | 'detail';

export type PaneId = BarId | SectionId;

/**
 * The stacking order in each bar, top to bottom. It is also the order the
 * sashes come in: sash `i` sits under section `i`, so a bar of four sections
 * has three of them and the bottom of the last section is the status bar.
 *
 * The ids are the model's, not the stylesheet's — `sourceControl` is
 * `.source-control` and `detail` is `.panel`, which is the one name that does
 * not read across.
 */
export const SECTIONS: Record<BarId, readonly SectionId[]> = {
  leftbar: ['repository', 'sourceControl', 'categories', 'activity'],
  sidebar: ['followed', 'detail'],
};

/** Which bar a section stands in. The mapping lives here rather than in six
 * places that each know one half of it. */
export function barOf(section: SectionId): BarId {
  return SECTIONS.leftbar.includes(section) ? 'leftbar' : 'sidebar';
}

export function isBar(pane: PaneId): pane is BarId {
  return pane === 'leftbar' || pane === 'sidebar';
}

/** Today's widths, so a first run looks exactly as it did before there were
 * sashes. 300px is VS Code's own side bar; 330 is what Detail needs for a
 * path and a symbol row on one line. */
export const DEFAULT_WIDTH: Record<BarId, number> = { leftbar: 300, sidebar: 330 };

/**
 * Today's shares, the ones written up in `styles.css` against a 1083px screen:
 * Repository 45%, Categories 15%, Activity 20%, and Source Control whatever is
 * left because it is the one list that is always long. The side bar is
 * Following 45% and Detail the rest. They are only consulted when a pane is
 * reset — while a bar's stack is `null` the stylesheet is still in charge and
 * these numbers are not applied to anything.
 */
const DEFAULT_SHARE: Record<SectionId, number> = {
  repository: 0.45,
  sourceControl: 0.2,
  categories: 0.15,
  activity: 0.2,
  followed: 0.45,
  detail: 0.55,
};

/** VS Code's own minimum side bar width. Below it the bar stops being a bar:
 * "Source Control" no longer fits beside its count. */
export const MIN_WIDTH = 170;

/**
 * A canvas narrower than this can never show one box whole — `NODE_WIDTH` is
 * 240 and dagre keeps a 40px margin on each side — so the diagram would be a
 * strip of clipped rectangles. The canvas wins every tie for that reason: a
 * bar dragged wider stops here rather than squeezing the thing the app is for.
 */
export const MIN_CANVAS = 320;

/** A folded section is its header and nothing else — the same 22px the chevron
 * already produces, so a sash dragged shut and a chevron clicked shut land in
 * the same state. */
export const SECTION_HEADER = 22;

/** A header and two rows. A section that cannot show a row is not a section,
 * it is a header, and there is no reason to be able to stop between the two. */
export const MIN_SECTION = SECTION_HEADER + 2 * 22;

/**
 * How far past its minimum a bar must be pulled before it collapses to
 * nothing. Half the minimum, so an overshoot of a few pixels rests at the stop
 * — which is what a person dragging *to* the minimum means — and only a
 * deliberate shove closes the bar. It closes to 0 rather than disappearing:
 * the sash stays where it is and drags the bar back out, which is what stops
 * anyone losing a panel in VS Code.
 */
const COLLAPSE_BELOW = MIN_WIDTH / 2;

export interface Viewport {
  /** A bar the page is not drawing right now, so it reserves no width. */
  hidden?: BarId;
  /** `window.innerWidth`. The canvas is what is left of it after both bars. */
  width: number;
  /**
   * The height a bar has for its sections. One number for both, because they
   * are the same row of the window — between the breadcrumb and the status bar
   * — and a model that let them differ would be describing a page that cannot
   * exist.
   */
  barHeight: number;
}

export interface Layout {
  width: Record<BarId, number>;
  /**
   * Section heights in pixels, top to bottom, summing to `barHeight`.
   *
   * `null` means nobody has touched this bar's sashes and the stylesheet still
   * owns the stack — which is how a first run looks exactly as it does today,
   * caps and content heights and all, rather than approximately. The component
   * adopts measured heights (`adoptStack`) on the first drag, so the border
   * starts moving from where it actually was rather than jumping to an
   * idealised share, and "Reset layout" hands the stack back to the
   * stylesheet by setting this to `null` again.
   *
   * The array describes the bar's whole complement, and it is only worth
   * applying while all of it is on screen — see `stackApplies`.
   */
  stack: Record<BarId, number[] | null>;
}

/**
 * Whether a stored stack describes the bar as it is currently drawn.
 *
 * The side bar's Following section renders nothing at all when nothing is
 * being followed — measured in the page: `.sidebar` has one child there, not
 * two — so the side bar is usually one section, with no internal border and
 * nothing to arrange. Heights are held back until Following comes back, and
 * the pair somebody set is waiting for it when it does; a stack applied to a
 * bar missing a section would leave Detail at 55% of a side bar that is all
 * Detail, and 45% of it empty.
 */
export function stackApplies(bar: BarId, rendered: number): boolean {
  return rendered === SECTIONS[bar].length;
}

export function defaultLayout(): Layout {
  return {
    width: { leftbar: DEFAULT_WIDTH.leftbar, sidebar: DEFAULT_WIDTH.sidebar },
    stack: { leftbar: null, sidebar: null },
  };
}

/** Nothing has been moved, so "Reset layout" has nothing to do and says so. */
export function isDefaultLayout(layout: Layout): boolean {
  return (
    layout.width.leftbar === DEFAULT_WIDTH.leftbar &&
    layout.width.sidebar === DEFAULT_WIDTH.sidebar &&
    layout.stack.leftbar === null &&
    layout.stack.sidebar === null
  );
}

/**
 * Zero is a width a bar really can be drawn at, and it still leaves its own
 * 1px edge: the bars are `box-sizing: border-box`, so a width of 0 is used as
 * the border and `offsetWidth` measures 1 (checked in the page). The sash has
 * a line to straddle at every width, including this one, which is what stops a
 * collapsed bar from being a bar nobody can find again.
 */
export function isCollapsed(width: number): boolean {
  return width <= 0;
}

export function isFolded(height: number): boolean {
  return height <= SECTION_HEADER;
}

// --- widths ------------------------------------------------------------------

/**
 * Both bars against the room the canvas will leave them. When they do not fit,
 * the overflow comes off the wider one first and off both equally after that:
 * the bar with the most to give gives it, and a narrow bar is not shaved to
 * nothing to keep a wide one whole.
 */
/**
 * What a stored layout is fitted to, kept beside the fitted value so widening
 * the window can undo it. Fitting used to overwrite the stored number, and
 * `fitWidths` only ever shrinks, so one moment in a 640px split view took both
 * bars to 160 and no amount of widening brought them back.
 */
function fitWidths(width: Record<BarId, number>, windowWidth: number): Record<BarId, number> {
  const left = Math.max(0, Math.round(width.leftbar));
  const right = Math.max(0, Math.round(width.sidebar));
  const room = Math.max(0, Math.round(windowWidth) - MIN_CANVAS);
  if (left + right <= room) return { leftbar: left, sidebar: right };
  const smaller = Math.min(left, right);
  const cap = smaller * 2 >= room ? Math.floor(room / 2) : room - smaller;
  return { leftbar: Math.min(left, cap), sidebar: Math.min(right, cap) };
}

/**
 * A drag of the sash between a bar and the canvas. `requested` is where the
 * pointer says the border is — an absolute width, not a delta, because a delta
 * accumulated across a drag that spent time clamped at a stop comes back out
 * of the stop in the wrong place.
 */
export function resizeBar(layout: Layout, bar: BarId, requested: number, viewport: Viewport): Layout {
  // A bar that is not on the page takes no room. Hiding the side panel with ⌘B
  // used to leave its 330px reserved, so the left bar stopped 330px short of a
  // canvas that had the space to give.
  const other = viewport.hidden === (bar === 'leftbar' ? 'sidebar' : 'leftbar')
    ? 0
    : layout.width[bar === 'leftbar' ? 'sidebar' : 'leftbar'];
  const most = Math.max(0, Math.round(viewport.width) - other - MIN_CANVAS);
  const want = Math.round(requested);
  // Past the collapse threshold the bar closes; anywhere short of it the bar
  // rests at its minimum, and the canvas caps it from the other side.
  const next = want < COLLAPSE_BELOW ? 0 : Math.min(Math.max(want, MIN_WIDTH), most);
  return { ...layout, width: { ...layout.width, [bar]: next } };
}

// --- section stacks ----------------------------------------------------------

/**
 * A stack fitted to the height it has. Folded sections keep their header and
 * take no part in it; the rest share what is left in proportion to the slack
 * they were carrying above their own header, so a pane that was twice another
 * stays twice it. Rounding lands on the tallest open pane, which is the one
 * place a pixel does not show.
 */
export function fitStack(sizes: readonly number[], available: number): number[] {
  if (sizes.length === 0) return [];
  const height = Math.round(available);
  if (!Number.isFinite(height) || height <= 0) return sizes.map((size) => Math.max(SECTION_HEADER, Math.round(size)));

  interface Pane {
    folded: boolean;
    /** What this section was carrying above its own header — the part of it
     * that is negotiable, and so the part the scaling is proportional to. */
    carried: number;
    height: number;
  }
  const panes: Pane[] = sizes.map((size) => ({
    folded: isFolded(size),
    carried: isFolded(size) ? 0 : size - SECTION_HEADER,
    height: SECTION_HEADER,
  }));
  const open = panes.filter((pane) => !pane.folded);

  const room = height - (panes.length - open.length) * SECTION_HEADER;
  // Not even a header each: everything folds and the bar clips, which is what
  // `overflow: hidden` on the bar already does with a window this short.
  if (open.length === 0 || room < open.length * SECTION_HEADER) return panes.map(() => SECTION_HEADER);

  const slack = room - open.length * SECTION_HEADER;
  const carried = open.reduce((total, pane) => total + pane.carried, 0);
  for (const pane of open) {
    const share = carried > 0 ? pane.carried / carried : 1 / open.length;
    pane.height = SECTION_HEADER + Math.round(slack * share);
  }

  // The rounding residual lands on the tallest open pane, which is the one
  // place a pixel does not show — and never on a folded one, which would
  // unfold a section nobody asked to open.
  let tallest: Pane | null = null;
  for (const pane of open) if (tallest === null || pane.height > tallest.height) tallest = pane;
  if (tallest !== null) tallest.height += height - panes.reduce((total, pane) => total + pane.height, 0);
  return panes.map((pane) => pane.height);
}

/** The stack today's stylesheet describes, in pixels. Used when a pane is
 * reset and when something outside needs a number for a stack nobody has
 * touched — never to render one, which would lose the content-height sizing
 * the caps produce and make a first run subtly not today's. */
export function defaultStack(bar: BarId, available: number): number[] {
  const ids = SECTIONS[bar];
  return fitStack(
    ids.map((id) => Math.max(MIN_SECTION, DEFAULT_SHARE[id] * Math.max(0, available))),
    available,
  );
}

/** What the component reads for `aria-valuenow`, and what every rule below
 * works on: the stored stack, or the stylesheet's if there is none yet. */
export function stackOf(layout: Layout, bar: BarId, viewport: Viewport): number[] {
  const stored = layout.stack[bar];
  return stored === null ? defaultStack(bar, viewport.barHeight) : fitStack(stored, viewport.barHeight);
}

/**
 * Take the stack over from the stylesheet at the sizes it currently has. The
 * component calls this on the first pointer-down in a bar, with each section's
 * `offsetHeight`, so the border begins moving from under the cursor.
 */
export function adoptStack(layout: Layout, bar: BarId, measured: readonly number[], viewport: Viewport): Layout {
  if (measured.length !== SECTIONS[bar].length) return layout;
  return { ...layout, stack: { ...layout.stack, [bar]: fitStack(measured, viewport.barHeight) } };
}

/**
 * The two panes a sash separates share a fixed total, and the drag divides it.
 * Pairwise on purpose: pushing the third and fourth pane along behind the one
 * being dragged means a person cannot see where the border they let go of will
 * end up, and the stack it leaves behind is not the one they arranged. When a
 * neighbour has nothing left to give, the border stops.
 */
function splitPair(above: number, below: number, requestedAbove: number): [number, number] {
  const total = above + below;
  if (total <= 2 * SECTION_HEADER) return [Math.round(total / 2), total - Math.round(total / 2)];

  let top = Math.round(requestedAbove);
  // Below its own minimum a pane folds to its header rather than resting at
  // some height that shows half a row: the same state the chevron produces.
  if (top < MIN_SECTION) top = SECTION_HEADER;
  if (total - top < MIN_SECTION) top = total - SECTION_HEADER;
  top = Math.max(SECTION_HEADER, Math.min(top, total - SECTION_HEADER));
  return [top, total - top];
}

/**
 * A drag of the sash under section `index`. `requested` is the height the
 * pointer asks of the section above it — absolute, for the reason `resizeBar`
 * gives.
 */
export function resizeSection(layout: Layout, bar: BarId, index: number, requested: number, viewport: Viewport): Layout {
  const sizes = stackOf(layout, bar, viewport);
  const over = sizes[index];
  const under = sizes[index + 1];
  // No section under it means no sash: the bottom of the last one is the
  // status bar, which is not a border anybody may move.
  if (over === undefined || under === undefined) return layout;
  const [above, below] = splitPair(over, under, requested);
  const next = [...sizes];
  next[index] = above;
  next[index + 1] = below;
  return { ...layout, stack: { ...layout.stack, [bar]: next } };
}

/**
 * Give one section a height, through whichever of its own two sashes exists.
 * A section is resized against its neighbour below; the last one in a stack
 * has none, so it is resized through the sash above instead — the same border,
 * addressed from the other side.
 */
function sizeSection(layout: Layout, section: SectionId, want: number, viewport: Viewport): Layout {
  const bar = barOf(section);
  const ids = SECTIONS[bar];
  const index = ids.indexOf(section);
  if (index < ids.length - 1) return resizeSection(layout, bar, index, want, viewport);
  const sizes = stackOf(layout, bar, viewport);
  const above = sizes[index - 1];
  const here = sizes[index];
  if (above === undefined || here === undefined) return layout;
  return resizeSection(layout, bar, index - 1, above + here - want, viewport);
}

/**
 * The chevron, in the size model's terms — so that folding a section by
 * clicking its chevron and folding it by shoving its sash shut leave the stack
 * in the same state, which is the whole point of a fold being 22px rather than
 * some other kind of hidden. Unfolding hands the section its default share
 * back, because the height it had before it folded is not something a stack of
 * pixels remembers, and its own share is the honest guess.
 *
 * A bar the stylesheet still owns is left alone: the `:has([aria-expanded])`
 * rules in `styles.css` already fold a section there, and adopting the stack
 * behind a chevron click would freeze every *other* section's height as a side
 * effect of collapsing one.
 */
export function setFolded(layout: Layout, section: SectionId, folded: boolean, viewport: Viewport): Layout {
  const bar = barOf(section);
  if (layout.stack[bar] === null) return layout;
  const index = SECTIONS[bar].indexOf(section);
  const height = stackOf(layout, bar, viewport)[index];
  if (height === undefined || isFolded(height) === folded) return layout;
  const want = folded ? SECTION_HEADER : defaultStack(bar, viewport.barHeight)[index];
  return want === undefined ? layout : sizeSection(layout, section, want, viewport);
}

// --- resetting ---------------------------------------------------------------

/**
 * Double-clicking a sash resets the pane it names. A bar goes back to its own
 * width; a section goes back to its share of the bar, and its neighbour
 * absorbs the difference, so the panes further away stay where they were put.
 */
export function resetPane(layout: Layout, pane: PaneId, viewport: Viewport): Layout {
  if (isBar(pane)) {
    return resizeBar(layout, pane, DEFAULT_WIDTH[pane], viewport);
  }
  const bar = barOf(pane);
  // Untouched: the stylesheet is already drawing the default.
  if (layout.stack[bar] === null) return layout;
  const want = defaultStack(bar, viewport.barHeight)[SECTIONS[bar].indexOf(pane)];
  return want === undefined ? layout : sizeSection(layout, pane, want, viewport);
}

/**
 * Every stored size against the window it is being drawn in. Bar widths are
 * fitted around the canvas's minimum; a stack is refitted to the bar's height.
 * A layout saved on a wider or taller screen arrives clamped, never off-screen
 * and never wider than the window.
 */
export function clampLayout(layout: Layout, viewport: Viewport): Layout {
  return {
    width: fitWidths(layout.width, viewport.width),
    stack: {
      leftbar: layout.stack.leftbar === null ? null : fitStack(layout.stack.leftbar, viewport.barHeight),
      sidebar: layout.stack.sidebar === null ? null : fitStack(layout.stack.sidebar, viewport.barHeight),
    },
  };
}

// --- storage -----------------------------------------------------------------

export const STORAGE_KEY = 'codemap.layout';

/** Bumped whenever the shape below changes meaning. A stored layout under any
 * other version is dropped for the default rather than read optimistically:
 * the cost of losing an arrangement once is a window to rearrange, and the
 * cost of misreading one is a window that cannot be. */
export const LAYOUT_VERSION = 1;

interface StoredLayout {
  version: number;
  width: Record<BarId, number>;
  stack: Record<BarId, number[] | null>;
}

export function serializeLayout(layout: Layout): string {
  const stored: StoredLayout = { version: LAYOUT_VERSION, width: layout.width, stack: layout.stack };
  return JSON.stringify(stored);
}

function readWidth(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function readStack(value: unknown, bar: BarId): number[] | null {
  if (!Array.isArray(value) || value.length !== SECTIONS[bar].length) return null;
  const sizes: number[] = [];
  for (const size of value) {
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    sizes.push(Math.round(size));
  }
  return sizes;
}

/**
 * Whatever was in storage, read as a layout. Every failure is the default
 * layout and none of them is an error: a stored string can be absent, someone
 * else's, half-written, or written by a version of this file that meant
 * something different by it, and none of those is worth showing a person who
 * only opened a window. A bad width falls back on its own, so one unreadable
 * number does not cost the other bar its size.
 */
export function parseLayout(raw: string | null, viewport: Viewport): Layout {
  const fallback = defaultLayout();
  if (raw === null || raw === '') return fallback;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;

  // `unknown` rather than a cast to StoredLayout: the whole point of this
  // function is that the thing on disk may be nothing of the sort.
  const record = parsed as Record<string, unknown>;
  if (record.version !== LAYOUT_VERSION) return fallback;

  const width = typeof record.width === 'object' && record.width !== null ? (record.width as Record<string, unknown>) : {};
  const stack = typeof record.stack === 'object' && record.stack !== null ? (record.stack as Record<string, unknown>) : {};

  return clampLayout(
    {
      width: {
        leftbar: readWidth(width.leftbar, DEFAULT_WIDTH.leftbar),
        sidebar: readWidth(width.sidebar, DEFAULT_WIDTH.sidebar),
      },
      stack: { leftbar: readStack(stack.leftbar, 'leftbar'), sidebar: readStack(stack.sidebar, 'sidebar') },
    },
    viewport,
  );
}

/**
 * `localStorage` is reached through a try/catch twice over — once for the
 * accessor and once for the call — because a private window, a browser told to
 * block site data, and a quota that is already full each throw from a
 * different one of them. There is no fallback to arrange: a person who cannot
 * store a layout gets the default layout every time, which is the layout this
 * app had until today, and never an error about it.
 */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadLayout(viewport: Viewport): Layout {
  const store = storage();
  if (store === null) return defaultLayout();
  try {
    return parseLayout(store.getItem(STORAGE_KEY), viewport);
  } catch {
    return defaultLayout();
  }
}

export function saveLayout(layout: Layout): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(STORAGE_KEY, serializeLayout(layout));
  } catch {
    // Nothing to do and nothing to say: the window is arranged either way,
    // and it is only the next launch that will not remember.
  }
}

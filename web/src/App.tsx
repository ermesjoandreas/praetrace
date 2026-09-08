import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Edge,
  type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import {
  FLOOR,
  decideCluster,
  fetchChanges,
  fetchClusters,
  fetchExplanations,
  cancelExplanations,
  fetchGit,
  fetchSuggestions,
  fetchSymbol,
  forgetExplanation,
  fetchAgentCalls,
  fetchLanguages,
  fetchLog,
  fetchRepo,
  fetchView,
  groupAction,
  installHook,
  isDesktop,
  liveUrl,
  pickProject,
  openInEditor,
  rememberProject,
  requestExplanations,
  requestSuggestions,
  setGitBase,
  switchProject,
  totalUnresolved,
  type AgentCall,
  type GroupColor,
  type ChangeEntry,
  type ExplainFailure,
  type ExplainRun,
  type FetchResponse,
  type GitStatus,
  type HookStatus,
  type LogResponse,
  type RepoInfo,
  type StoredExplanation,
  type Suggestion,
  type SymbolLinks,
  type GroupSuggestion,
  type LanguageReport,
  type OrphanGroup,
  type SearchHit,
  type ViewCrumb,
  type ViewGraph,
  type ViewNode,
  type ViewResponse,
  type FlowTarget,
  type Presentation,
  type OverviewReply,
  LIST_ABOVE,
  fetchOverview,
  fetchDiff,
  flowBlocked as flowBlockedBy,
} from './api';
// The one thing the conversation about the categories needs of this file: the
// socket's two ask frames, handed to the panel that draws them. See
// `web/src/ask.ts` for why it is a hand-off rather than a prop.
import { publishAsk, type AskFrame } from './ask';
import { MenuBar, type Menu, type MenuItem } from './MenuBar';
import { Flow } from './Flow';
import { ListView } from './ListView';
import { Overview } from './Overview';
import { homeSearch, isFrontPage, rootDiagramSearch } from './frontpage';
import { presentationChip } from './listrows';
import { GIT_BASES, StatusBar } from './StatusBar';
import { ProjectMenu } from './ProjectMenu';
import { Welcome } from './Welcome';
import { SearchPalette } from './SearchPalette';
import { DetailPanel, Sidebar, symbolKey, type ComponentLink, type ComponentSelection } from './Sidebar';
import { Categories, type GroupEditor } from './Categories';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { RelationEdge, type RelationData } from './RelationEdge';
import { ComponentNode, type ComponentNodeType } from './ComponentNode';
import { GroupNode, type GroupNodeType } from './GroupNode';
import { Activity } from './Activity';
import { Repository } from './Repository';
import { findCommit, relativeTime, shortSha } from './GitGraph';
import { SourceControl, type DiffRow } from './SourceControl';
import { ContextMenu } from './ContextMenu';
import { Sash } from './Sash';
import { SectionPanes, type SectionPane } from './Section';
import {
  MIN_CANVAS,
  SECTIONS,
  SECTION_HEADER,
  adoptStack,
  barOf,
  clampLayout,
  defaultLayout,
  isDefaultLayout,
  isFolded,
  loadLayout,
  resetPane,
  resizeBar,
  resizeSection,
  saveLayout,
  setFolded,
  stackApplies,
  stackOf,
  type BarId,
  type Layout,
  type SectionId,
  type Viewport,
} from './panes';
import {
  ASKED,
  PULSE_MAX,
  WRITTEN,
  addMarks,
  bandOf,
  liveMarks,
  nextChange,
  shownMarks,
  type Band,
  type Mark,
  type Shown,
} from './marks';
/* A type-only import of `src/project/`, erased by Vite the way `api.ts`'s own
   are: none of that module's `node:fs` reaches the bundle. The wire shape is
   imported rather than restated so the page cannot drift from the server. */
import type { Attribution } from '../../src/project/hook.js';
import {
  frameClusters,
  keepLayout,
  MAX_MEMBERS,
  NODE_WIDTH,
  boxHeight,
  componentHeight,
  layoutNodes,
  type ClusterBounds,
  type ClusterInput,
  type Rect,
} from './layout';
// The folder arrangement: the engine says which folders are frames and what
// each is called, this file draws them, and `fold.ts` is what a shut one does
// to the boxes and the lines.
import { FolderNode, type FolderNodeType } from './FolderNode';
import { foldFolders } from './fold';
import {
  applyPlacements,
  dropBox,
  dropView,
  loadPlacements,
  placeBox,
  viewKeyOf,
  type Placement,
  type Placements,
} from './placement';
import { matchedAt } from './commands';
import { CommandPalette } from './CommandPalette';
import { FindBar } from './FindBar';

const nodeTypes = { box: BoxNode, frame: GroupNode, component: ComponentNode, folder: FolderNode };
/** Every line is one component: what a kind adds is a mark at an end. */
const edgeTypes = { relation: RelationEdge };

type FlowNode = BoxNodeType | GroupNodeType | ComponentNodeType | FolderNodeType;

/** What every component box's id begins with; the rest is the category's id. */
const COMPONENT_PREFIX = 'component:';

const BARS: readonly BarId[] = ['leftbar', 'sidebar'];

/**
 * The class a resizable section is placed with, and the model's name for it.
 * A section that is not here — the two inside Source Control — keeps the fold
 * it has always had and gets no sash: they divide a section, not a bar.
 */
const SECTION_OF_CLASS: Record<string, SectionId> = {
  repository: 'repository',
  'source-control': 'sourceControl',
  categories: 'categories',
  activity: 'activity',
  followed: 'followed',
  // The one name that does not read across: Detail is placed as `.panel`.
  panel: 'detail',
};

const CLASS_OF_SECTION: Record<SectionId, string> = {
  repository: 'repository',
  sourceControl: 'source-control',
  categories: 'categories',
  activity: 'activity',
  followed: 'followed',
  detail: 'panel',
};

/** What a sash says it is moving, for someone who cannot see which edge it is on. */
const SECTION_TITLE: Record<SectionId, string> = {
  repository: 'Repository',
  sourceControl: 'Source Control',
  categories: 'Categories',
  activity: 'Activity',
  followed: 'Following',
  detail: 'Detail',
};

/**
 * The window the layout has to fit into. `main` is exactly it — the row
 * between the breadcrumb and the status bar — so both numbers come off the one
 * element rather than off `window` minus a list of bar heights that would go
 * stale the first time one of them changed.
 *
 * Before it is mounted there is still a layout to load, and the estimate is
 * the three chrome bars DESIGN.md fixes: 35px title, 22px breadcrumb, 22px
 * status. It is only ever a seed — the measured pass clamps again before the
 * first paint — and it errs high, which clamps nothing that should have stood.
 */
function viewportOf(main: HTMLElement | null): Viewport {
  if (main === null) {
    return { width: window.innerWidth, barHeight: Math.max(0, window.innerHeight - 35 - 22 - 22) };
  }
  return { width: main.clientWidth, barHeight: main.clientHeight };
}

/**
 * Where a bar's section borders actually are, in the window as drawn.
 *
 * While the stylesheet still owns a stack the model has only its shares to
 * offer, and they differ from what is on screen wherever a cap or a content
 * height decided the size instead: Source Control is the slack in the column
 * and Activity is as tall as its own words, so their shares are 130px each
 * where the page draws 194 and 66. A gesture anchored on the share would move
 * the border to it on the first pixel, which is the one thing a drag must not
 * do — so the sash asks the page and not the model until the model is the one
 * deciding.
 *
 * A section that is not on screen — Following, until something is being
 * followed — leaves nothing to take over, and then there is no measurement
 * here to trust at all.
 */
function sameSizes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((size, index) => size === b[index]);
}

function measureStack(main: HTMLElement | null, bar: BarId): number[] {
  const root = main?.querySelector(`.${bar}`);
  if (!(root instanceof HTMLElement)) return [];
  const sizes = SECTIONS[bar].map((id) => {
    const section = root.querySelector(`:scope > .${CLASS_OF_SECTION[id]}`);
    return section instanceof HTMLElement ? section.offsetHeight : 0;
  });
  return sizes.some((height) => height <= 0) ? [] : sizes;
}

/**
 * Hand React Flow the size the layout already decided, rather than waiting for
 * it to measure one.
 *
 * React Flow holds the `fitView` prop until every node has been measured, and
 * `onlyRenderVisibleElements` means a box outside the camera is never in the
 * DOM, so its observer never fires. On any diagram wider than the window that
 * is never — so a view opened wide never fitted at all, which is worse than a
 * fit that does a poor job: the diagram it refuses to move is by definition
 * the one the reader cannot see. Measured on ripgrep's `crates/core`: 27
 * boxes spanning 4 336px sat in a 579px canvas at scale 1.
 *
 * This is the fit that happens on its own, when a view opens. The one a person
 * asks for is a separate mechanism and had a separate bug; see `fitToScreen`.
 *
 * Nothing is guessed here. dagre placed these boxes from exactly these
 * numbers — `boxHeight` gives a box its height, and a frame is the rectangle
 * around where its members landed — so this reports the size the layout has
 * already committed to. The observer still corrects it for any box that does
 * come on screen and renders taller.
 */
function withMeasured(node: FlowNode): FlowNode {
  const { width, height } = node;
  // Every box and frame is built with both, which is also what the cull
  // rectangle is computed from, so this narrows a type rather than guarding
  // against a case that happens.
  if (width === undefined || height === undefined) return node;
  return { ...node, measured: { width, height } };
}

const MAX_DEPTH = 4;
/**
 * How long the attention pulse runs — the animation, not the mark.
 *
 * This used to be the whole life of both signals, and that was the reported
 * bug: a mark that is gone in two and a half seconds is gone before a person
 * looks up from their terminal. The pulse is for the reader who is watching
 * right now and stays short; how long the *mark* stands is `marks.ts`.
 */
const PULSE_MS = 2500;

/**
 * When a mark says it landed. A wall clock and not an age, because an age is
 * true only for the second it was rendered — see `describeMark`. Seconds are
 * in it: two files written eight seconds apart is exactly the distinction a
 * person coming back is trying to make.
 */
const MARK_CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
/**
 * The edge kinds a URL asks for. Structure is always drawn; calls,
 * associations and dependencies are opted into, and each is spelled out in
 * the CSV rather than enumerated as a combination — two flags are four
 * strings, and three are eight.
 */
const BASE_EDGES = ['imports', 'extends', 'implements'] as const;

/** The three opt-in kinds, each also a `?calls=1`-style flag the server reads. */
const OPT_IN_EDGES = ['calls', 'associates', 'depends'] as const;

function edgeParam(calls: boolean, associates: boolean, depends: boolean): string | null {
  const extra = [calls ? 'calls' : '', associates ? 'associates' : '', depends ? 'depends' : ''].filter(Boolean);
  return extra.length === 0 ? null : [...BASE_EDGES, ...extra].join(',');
}

/** What a frozen page shows under its categories: a name is for the live ones. */
const NO_SUGGESTIONS: ReadonlyMap<string, Suggestion> = new Map();

/** How often to ask a run in flight whether it has finished. */
const RUN_POLL_MS = 3000;

/**
 * Above this many boxes the page itself is what is slow: dagre and the React
 * Flow mount both run on the main thread, and at depth 2 on a coupled project
 * that is two seconds with nothing on screen to say why. The server answered
 * in three milliseconds. So the page says so, with the way back beside it.
 */
const MANY_BOXES = 150;

/**
 * Which way a bundle's arrow runs, read off the id the view gave it —
 * `bundle:dependents:1`.
 *
 * Read from the id rather than from the label, because the label is exactly
 * the string that has to stop being the only thing said: "260 dependents"
 * beside a symbol someone is following reads as that symbol's fan-in, and it
 * is the file's. Both surfaces that draw a bundle ask this, so they cannot
 * disagree about which way it points.
 */
function bundleDirection(id: string): 'dependents' | 'dependencies' | null {
  if (id.startsWith('bundle:dependents')) return 'dependents';
  if (id.startsWith('bundle:dependencies')) return 'dependencies';
  return null;
}

/**
 * What one followed symbol reaches, when that is known. A symbol the graph has
 * lost reaches nothing, and neither does one nobody has asked about yet — the
 * difference between those two is a row in the panel, never a lit edge.
 */
function linksOf(entry: SymbolLinks | 'gone' | undefined): SymbolLinks | null {
  return entry === undefined || entry === 'gone' ? null : entry;
}

/**
 * The ring on a box that is part of the selection. It sits on the node wrapper
 * rather than on the box, because the box surface already carries three signals
 * of its own — just written, just asked about, and its git badge — and being
 * picked is the one of them the user is holding themselves. An outline, not a
 * shadow: nothing that does not float casts one, and the radius has to be the
 * box's own or the ring shows a different corner from the thing it rings.
 */
const PICKED_STYLE: CSSProperties = {
  outline: '2px solid var(--vsc-accent)',
  borderRadius: 'var(--vsc-radius)',
};

interface AgentMessage {
  type: 'agent';
  call: AgentCall;
}

/** A few characters of an answer as it is written. See live.ts for why it is
 *  its own message and not a run update. */
interface ExplainDeltaMessage {
  type: 'explain-delta';
  runId: string;
  text: string;
}

/**
 * Names were written, by anybody — a press here, or the agent through MCP.
 * Carries nothing: the page refetches the clusters, which is the only reader
 * that knows how to merge a name with the cluster it now belongs to. Sent to
 * every socket, frozen ones too, because a name lives outside the commit.
 */
interface GroupsMessage {
  type: 'groups';
}

interface ExplainMessage {
  type: 'explain';
  run: ExplainRun;
}

interface LiveMessage {
  /** `project` means the server switched roots; every path on screen is stale. */
  type: 'update' | 'project';
  root: string;
  view: ViewGraph;
  changedFiles: string[];
  /**
   * Who claimed each of those files, for the files anybody claimed. Absent
   * whole when nobody did, and a path missing from it was written by nobody we
   * can name — the watcher sees a file change and cannot tell an agent from a
   * build script from a person in an editor. See `src/project/hook.ts`.
   */
  by?: Record<string, Attribution>;
}

/**
 * The working tree changed and the hub drew nothing for it: this socket's
 * spec names a structural diff, which is of two graphs, and the hub holds
 * one. The files are the pulse; the view is fetched from `/api/view?diff=`.
 */
interface ChangedMessage {
  type: 'changed';
  root: string;
  changedFiles: string[];
  by?: Record<string, Attribution>;
}

export function App() {
  const [search, setSearch] = useState(() => window.location.search);
  const [data, setData] = useState<ViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * The URL asks for a view the server refused — a focus or scope the graph
   * has not got, a sha that is not a commit. `data` still holds the previous
   * view, because the chrome around the canvas reads from it and has to stay
   * up so there is a way out; the canvas itself goes blank, because drawing
   * the previous graph under a URL that names something else is the silent
   * fallback the server just stopped making.
   */
  const [viewMissing, setViewMissing] = useState(false);
  /**
   * The front page's answer, and why there is none. Kept across refetches
   * so a save re-reads the page under the reader without blanking it; the
   * page itself holds its rows' order (mark, do not move). Read only while
   * `frontOn`, and only shown for the project on screen.
   */
  const [overview, setOverview] = useState<OverviewReply | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  /** Bumped to refetch the current view without changing the URL. */
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * Every file written recently enough to still be marked on the diagram, with
   * when, whether it is new here, and who claimed it. Two minutes each — see
   * `marks.ts` for why that number and not the two and a half seconds this
   * used to be.
   */
  const [marks, setMarks] = useState<ReadonlyMap<string, Mark>>(() => new Map());
  /**
   * The clock the marks are read against.
   *
   * State and not `Date.now()` at render, because a mark weakening and a mark
   * going out are the two moments the diagram has to be redrawn at and nothing
   * else moves in between. A periodic tick would do it too, and would re-render
   * the canvas once a second for two minutes after every save; this moves
   * exactly twice per mark. `marks.ts` works out when.
   */
  const [markNow, setMarkNow] = useState(() => Date.now());
  /** Files touched by the most recent batch, for the pulse. */
  const [pulsing, setPulsing] = useState<readonly string[]>([]);
  /** Changes that landed outside the current view and have not been looked at. */
  const [missed, setMissed] = useState<string[]>([]);
  /** The box being inspected. Selecting is not navigating. */
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The boxes React Flow has picked out, which is a different question from
   * which one is being inspected: one box is described in the panel, several
   * are what a group gets drawn around.
   */
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  /**
   * The frame whose editor is open. A frame renders at a negative z-index —
   * behind the boxes, which is the whole point of a frame — so its popover
   * went behind them too. Only the canvas can lift a node, so the node says
   * when it needs lifting and this holds the answer.
   */
  const [editingFrame, setEditingFrame] = useState<string | null>(null);
  /**
   * Where a frame was dragged to, until the server's own geometry catches up.
   *
   * The canvas is controlled, so React Flow moves a node during the drag and
   * then hands the position back for the page to keep — and the page kept only
   * selection. The frame snapped back on release and jumped again a round trip
   * later when groups.json had been written and re-read: the hiccup this
   * exists to remove. Cleared when the clusters arrive, because by then the
   * stored geometry says the same thing.
   */
  const [dragged, setDragged] = useState<ReadonlyMap<string, { x: number; y: number }>>(() => new Map());
  /** The name field for a category about to be drawn, in the Categories section. */
  const [creating, setCreating] = useState(false);
  /**
   * The server's standing question about drawing one — it writes
   * .codemap/groups.json, and this project has none yet — held with the press
   * that raised it, so saying yes is the same press with consent; the same
   * shape as `consent` below, which asks it for Explain. And the refusal a
   * press got otherwise, in the server's words. Both are shown in the section
   * the press was made in, not in the banner over the canvas: the banner
   * used to hold the refusal, and held it still after the category had been
   * drawn, because nothing ever cleared it.
   */
  /**
   * The server's question about `.codemap/`, held until a person answers it.
   * Either a category being drawn — the name and the files, so the press that
   * answers sends what was asked about rather than whatever is picked by then
   * — or any other write to the same file, kept as the body to send again.
   */
  const [groupConsent, setGroupConsent] = useState<
    { name: string; files: string[] } | { pending: unknown } | null
  >(null);
  const [createRefusal, setCreateRefusal] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  /**
   * ⌘⇧P. The other half of VS Code's split: ⌘K finds a thing, this runs one.
   * It holds nothing of its own — every command it lists is a `MenuItem` the
   * menu bar is already built from — so opening it is the whole of its state.
   */
  const [commandsOpen, setCommandsOpen] = useState(false);
  /**
   * ⌘F, and what has been typed into it. Not a view: a highlight says where
   * something already on the canvas is, so it rides no URL and survives no
   * reload, the same way the selection does not.
   *
   * `null` is closed. An open bar with an empty query is `''`, which is a
   * different state: the bar is up and waiting, and nothing is dimmed yet.
   */
  const [findQuery, setFindQuery] = useState<string | null>(null);
  /**
   * Which match Enter is standing on, as an index into `found.boxes`, and −1
   * for "not stepped yet". Two different things, and the bar says so: with
   * nothing stepped it reads "17 matches", and only once the camera has been
   * somewhere does it read "3 of 17". A find that claimed to be on match 1
   * before it had moved would be describing a camera that had not gone there.
   */
  const [findAt, setFindAt] = useState(-1);
  /**
   * Bumped by ⌘F. The bar takes it as "select what is in the box": a second
   * ⌘F in an editor means "search for something else", not "put the caret
   * wherever the mouse left it".
   */
  const [findFocus, setFindFocus] = useState(0);
  /** Where the right-click menu is, and what was under the cursor: a box, and a member row inside it. */
  const [contextAt, setContextAt] = useState<{ x: number; y: number; node: string | null; member: string | null } | null>(null);
  /**
   * Lifted out of the panel that used to own it: two panels read this now, and
   * the left one is the reason the data exists.
   */
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  /**
   * The whole git status, not the summary on the view. The line counts are
   * per file and there can be a thousand of them, which is more than a view of
   * six boxes has any business carrying.
   */
  const [gitLines, setGitLines] = useState<GitStatus | null>(null);
  /**
   * The symbol being followed, and what the server said about it.
   *
   * Symbol-level edges have always been in the graph — every drawing collapses
   * them onto the files that hold them — so this asks the question the diagram
   * cannot: not which two boxes are coupled, but which two rows made them so.
   */
  /** Boxes showing every member rather than the first twelve. */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const toggleExpanded = useCallback((id: string, open: boolean) => {
    setExpanded((was) => {
      const next = new Set(was);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /**
   * Folder frames shut back into a folder box, under the folder arrangement.
   *
   * Page state and not a URL key, unlike the arrangement itself: which folders
   * a reader has shut is where they are in reading a picture, not which
   * picture it is — the same reason `expanded` above is not in the URL. It is
   * dropped whenever the view changes, because a folder path means nothing in
   * the next scope and a stale one would shut a folder nobody shut.
   */
  const [foldedFolders, setFoldedFolders] = useState<ReadonlySet<string>>(() => new Set());

  const toggleFolded = useCallback((id: string, shut: boolean) => {
    setFoldedFolders((was) => {
      const next = new Set(was);
      if (shut) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const [following, setFollowing] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Whole files being held on to, to be explained. A second set rather than
   * more entries in `following`, and it has to stay that way.
   *
   * `following` is a lens: every id in it drives `relatedIds` and
   * `relatedFiles`, which is what dims the rest of the diagram, and what the
   * chip counts when it says "N in, N out". A file joins the explain list
   * without dimming anything, so putting it in that set would make one gesture
   * mean two things and turn the chip's counts into a lie. Nothing here ever
   * feeds `relatedIds` or `relatedFiles`.
   *
   * Two sets is also how a file path and a symbol id are told apart at all.
   * Neither shape can be read off the string — `#` is legal in a filename, as
   * `openInEditor` already has to allow for — so membership is the answer and
   * no code has to guess.
   */
  const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * One entry per followed symbol: its links, or 'gone' once the server has
   * said it knows nothing about that id. An id nobody has asked about yet, and
   * one whose request never arrived, are both simply absent — see the effect
   * below for why the second of those must not be recorded as an answer.
   */
  const [links, setLinks] = useState<ReadonlyMap<string, SymbolLinks | 'gone'>>(() => new Map());

  const toggleFollowing = useCallback((id: string, on: boolean) => {
    setFollowing((was) => {
      const next = new Set(was);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleReading = useCallback((filePath: string, on: boolean) => {
    setReading((was) => {
      const next = new Set(was);
      if (on) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  }, []);

  /**
   * Dropping addresses an id and looks for it in both sets. Not a guess about
   * which kind it is: a symbol id is never in `reading` and a path is never in
   * `following`, so the removal it does not apply to is a no-op.
   */
  const dropFollowed = useCallback((id: string) => {
    setFollowing((was) => {
      if (!was.has(id)) return was;
      const next = new Set(was);
      next.delete(id);
      return next;
    });
    setReading((was) => {
      if (!was.has(id)) return was;
      const next = new Set(was);
      next.delete(id);
      return next;
    });
  }, []);

  /** What the project has had explained, by id, for the ids on show. */
  /**
   * The answer as it is being written, before it is parsed into entries.
   *
   * Shown raw and unstructured on purpose: the wait is twelve seconds before the
   * first character and the whole point of showing it is that something is
   * happening. Cleared when a run starts so the last one's words do not sit
   * under the next one's spinner.
   */
  const [streamed, setStreamed] = useState('');

  const [explanations, setExplanations] = useState<ReadonlyMap<string, StoredExplanation>>(
    () => new Map(),
  );
  /** The run in flight, or the last one to end. */
  const [run, setRun] = useState<ExplainRun | null>(null);
  /**
   * The last run that produced answers, kept across the next one.
   *
   * `run` alone would drop the price the moment a new run started, which is
   * exactly when someone is deciding whether to spend it again.
   */
  const [lastRun, setLastRun] = useState<{ costUsd: number; ms: number } | null>(null);
  /**
   * A press that never became a run. `refused` is the server declining to
   * spend: every id already had a current reading, or none is in the graph —
   * no money moved, so it is not worded as a failure. `failed` is no server.
   */
  const [explainError, setExplainError] = useState<{ reason: ExplainFailure | 'refused'; detail: string } | null>(null);
  /**
   * The server's standing question, and the press that raised it: explaining
   * writes a file into a project that has none, and a project opened to be read
   * must not be left with one uninvited. Null whenever there is nothing to ask.
   */
  const [consent, setConsent] = useState<{ path: string; ids: string[]; force: boolean } | null>(null);

  const takeRun = useCallback((next: ExplainRun | null) => {
    setRun(next);
    if (next?.state === 'done' && next.costUsd !== undefined) {
      setLastRun({ costUsd: next.costUsd, ms: next.ms ?? 0 });
    }
  }, []);

  /** Bumped whenever the graph changes, so the panel refetches rather than lie. */
  const [revision, setRevision] = useState(0);
  /**
   * What the repository is — remote, hook, port file, counts — for the
   * Repository panel. One answer for one panel; null until it has arrived.
   */
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  /** The commit log, for the Graph and for naming the commit on screen. */
  const [log, setLog] = useState<LogResponse | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  /**
   * The project a switch is on its way to, or null. Opening one is a whole boot
   * scan on the server — measured at 9 min 13 s for a 3 039-file tree — and
   * until this existed the page said nothing for all of it: the picker closed,
   * the old project stayed on screen looking finished, and the only honest
   * reading was that the click had been ignored.
   */
  const [opening, setOpening] = useState<string | null>(null);
  /**
   * The symbol whose control flow is drawn over the canvas, or null. Nothing
   * is fetched for it until it is set: the flow is a parse, and a page that
   * parsed every function it looked at would violate the spirit of decision 1.
   */
  const [flowTarget, setFlowTarget] = useState<FlowTarget | null>(null);
  /**
   * The symbol the panel has open, reported by the panel, so the View menu
   * can call it the selection. A box is a file and a file has no flow; the
   * panel's Declares list is where a function is picked.
   */
  const [panelSymbol, setPanelSymbol] = useState<(FlowTarget & { kind: string }) | null>(null);
  const [agentCalls, setAgentCalls] = useState<AgentCall[]>([]);
  /** What the tool cannot read here. Null until the census has come back. */
  const [languageReport, setLanguageReport] = useState<LanguageReport | null>(null);
  /**
   * Files the agent asked codemaps about, and when — the second signal, in
   * blue. A minute each rather than the write's two: a question is attention,
   * and attention has moved on by then. See `ASKED` in `marks.ts`.
   */
  const [agentAsked, setAgentAsked] = useState<ReadonlyMap<string, number>>(() => new Map());
  /** The one it asked about just now, for the pulse. */
  const [agentLooking, setAgentLooking] = useState<readonly string[]>([]);
  const flow = useReactFlow();
  const [clusters, setClusters] = useState<GroupSuggestion[]>([]);
  /**
   * Stored names that match no group the graph finds now. Listed rather than
   * lost: three committed names were never shown anywhere before this, and
   * the only way to learn a name had gone was to open groups.json.
   */
  const [orphans, setOrphans] = useState<OrphanGroup[]>([]);
  /**
   * Which project and commit the clusters on hand were fetched for. The
   * groups arrive from their own request, after the view, and dagre is what
   * keeps a group's members together — so the layout that runs once those
   * groups have arrived still counts as the view's first. Anything after it
   * keeps every box where it stands. Compared with the view rather than reset
   * with it: the clusters of one view are the project's, and are usually
   * right for the next.
   */
  const [clustersFor, setClustersFor] = useState<string | null>(null);
  /**
   * Bumped by View › Re-layout, the one gesture other than opening a view that
   * runs dagre. Everything else — a save, a new file, a new import — keeps
   * every box where it stands and puts the new one beside its neighbour.
   */
  const [relayoutToken, setRelayoutToken] = useState(0);
  /**
   * Bumped when the server says groups.json changed under it — the agent named
   * a category through MCP, or another tab did. Its own counter rather than
   * `revision`: a name moves no file the graph reads, so nothing else on the
   * page has to be re-read for it, and it arrives while frozen too, because a
   * name lives outside the commit.
   */
  const [groupsRevision, setGroupsRevision] = useState(0);
  /**
   * What a model guessed the unnamed categories are called, by cluster id.
   *
   * Session state on both sides. Decision 5: nothing here reaches groups.json
   * until a person presses accept, which goes through `decide` like a name
   * typed by hand. A cluster id embeds its member count, so a guess simply
   * stops matching anything the moment membership drifts — which is right,
   * because it was a guess about a different set of files.
   */
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, Suggestion>>(() => new Map());
  /** A run is in flight. It is a minute of subprocess, so it is said out loud. */
  const [suggesting, setSuggesting] = useState(false);
  /** Why the last press produced no names, in the server's own wording. */
  const [suggestError, setSuggestError] = useState<string | null>(null);
  /** What the last run that produced names cost. Shown in the lightbulb's tooltip, not on the section. */
  const [suggestCost, setSuggestCost] = useState<{ costUsd: number; ms: number } | null>(null);

  const socketRef = useRef<WebSocket | null>(null);
  /** Files the view covered before the update now being processed. */
  const coveredRef = useRef(new Set<string>());
  /** The spec of the view on screen, so a push computed for an older one is refused. */
  const specRef = useRef<string | null>(null);
  /**
   * Whether the view on screen is a past commit's. A ref because the socket
   * handler is registered once and would otherwise close over the first render.
   */
  const frozenRef = useRef(false);
  /**
   * Whether the view on screen is a structural diff, for the same handler.
   * The hub cannot compute a diff for a push — it holds one graph — so a push
   * under a diff is the signal that the diff changed, and the page refetches.
   */
  const diffRef = useRef(false);
  /**
   * The structural diff's numbers, keyed by what they are between so a stale
   * answer is never printed under a base that has since moved. Null until
   * the first answer; the row reads as "comparing…" meanwhile.
   */
  const [diffRow, setDiffRow] = useState<{ key: string; row: DiffRow } | null>(null);

  // The view lives in the URL, so the back button is the navigation history.
  useEffect(() => {
    const onPopState = () => setSearch(window.location.search);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMissed([]);
    fetchView(search).then(
      (result) => {
        if (cancelled) return;
        coveredRef.current = new Set(result.view.nodes.flatMap((node) => node.files));
        specRef.current = JSON.stringify(result.view.spec);
        setData(result);
        setError(null);
        setViewMissing(false);
        setRevision((n) => n + 1);
      },
      (cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // A 404 is the server refusing to draw what the URL asked for — a
        // commit it has not got, or a focus or scope the graph has never
        // heard of — and never the root view under that name. The banner
        // carries the server's own words for a file or directory. A commit is
        // reworded because the chip with the way out stays on screen for it,
        // so the banner says which.
        const wanted = new URLSearchParams(search).get('at');
        setViewMissing(true);
        setError(
          wanted !== null && /404|commit/.test(message)
            ? `No commit ${wanted.slice(0, 7)} in this repository`
            : message,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [search, reloadToken]);

  /**
   * A page opened straight onto a URL the server refuses has no view at all,
   * and everything around the canvas — the left bar, the breadcrumb, the
   * counts — reads from one. The root view stands the chrome up so there is a
   * project on screen and a crumb to click; the canvas stays blank under the
   * banner, because the root is not what the URL asked for.
   */
  useEffect(() => {
    if (!viewMissing || data !== null) return;
    let cancelled = false;
    fetchView('').then(
      (result) => {
        if (cancelled) return;
        coveredRef.current = new Set(result.view.nodes.flatMap((node) => node.files));
        specRef.current = JSON.stringify(result.view.spec);
        setData(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [viewMissing, data]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let attempt = 0;
    let disposed = false;

    const scheduleRetry = (): void => {
      if (disposed) return;
      const delay = Math.min(500 * 2 ** attempt, 10_000);
      attempt += 1;
      retry = window.setTimeout(() => void connect(), delay);
    };

    const connect = async (): Promise<void> => {
      if (disposed) return;

      let url: URL;
      try {
        url = await liveUrl();
      } catch {
        // Resolving the port can fail while the sidecar is still doing its boot
        // scan. Giving up here would kill the reconnect loop before it ever had
        // a socket to reconnect, leaving the page permanently dead.
        scheduleRetry();
        return;
      }
      if (disposed) return;

      socket = new WebSocket(url);
      socketRef.current = socket;

      socket.onopen = () => {
        // Anything that changed while the socket was down was never pushed, so
        // a reconnect has to refetch rather than trust the graph on screen.
        if (attempt > 0) setReloadToken((token) => token + 1);
        attempt = 0;
        setLive(true);
      };

      socket.onclose = () => {
        setLive(false);
        // Restarting the server is routine in a dev loop; the page must come
        // back on its own rather than needing a reload.
        scheduleRetry();
      };

      /**
       * One batch of writes, on the diagram. Every file gets a mark that
       * outlasts a glance; the same files get the short attention pulse, for
       * the reader who is watching right now. `born` is the files this view
       * had no box for a moment ago, which is the only honest way the page can
       * know that a file is new — the graph does not carry it.
       */
      const landed = (
        files: readonly string[],
        born: ReadonlySet<string>,
        by: Record<string, Attribution> | undefined,
      ) => {
        if (files.length === 0) return;
        const now = Date.now();
        setMarks((was) => addMarks(was, files, now, born, by));
        // The clock the bands are read against moves with the batch. Without
        // this it stayed at whatever it was when the last one expired, and
        // every mark read as fresh for as long as it stood.
        setMarkNow(now);
        setPulsing(files);
      };
      const NOTHING_NEW: ReadonlySet<string> = new Set();

      socket.onmessage = (event: MessageEvent<string>) => {
        const parsed = JSON.parse(event.data) as
          | LiveMessage
          | ChangedMessage
          | AgentMessage
          | ExplainMessage
          | ExplainDeltaMessage
          | GroupsMessage
          | AskFrame;

        // Names were written, by whoever. The clusters effect below re-reads
        // them for the commit on screen; nothing else needs to move.
        if (parsed.type === 'groups') {
          setGroupsRevision((n) => n + 1);
          return;
        }

        // The run that ended is the one the poll below would have found three
        // seconds later; the poll stays, because it is the only thing that
        // notices a run another tab started.
        // The conversation about the categories. Handed straight over: this
        // file owns the socket, the Categories panel owns the transcript, and
        // a delta lands every few characters.
        if (parsed.type === 'ask' || parsed.type === 'ask-delta') {
          publishAsk(parsed);
          return;
        }

        if (parsed.type === 'explain-delta') {
          setStreamed((was) => was + parsed.text);
          return;
        }

        if (parsed.type === 'explain') {
          takeRun(parsed.run);
          return;
        }

        if (parsed.type === 'agent') {
          setAgentCalls((previous) => [parsed.call, ...previous].slice(0, 200));
          // Naming changes what is on screen, but this message arrives before
          // the name is written; the `groups` message above is the one that
          // arrives after, so nothing is refetched here.
          // A path target is a box on screen; a search term is not.
          const about = parsed.call.target;
          if (about !== null && about !== undefined && about.includes('/')) {
            setAgentLooking([about]);
            setAgentAsked((was) => new Map(was).set(about, parsed.call.at));
            setMarkNow(Date.now());
          }
          return;
        }

        const message = parsed;

        if (message.type === 'project') {
          // The URL names a scope or a file in the project we just left.
          window.history.replaceState(null, '', window.location.pathname);
          setSearch('');
          setMissed([]);
          setPulsing([]);
          // A path from the project just left names nothing here, and a mark
          // standing over a box of the same name in another repository would
          // be a lie about work that never happened.
          setMarks(new Map());
          setAgentAsked(new Map());
          coveredRef.current = new Set(message.view.nodes.flatMap((node) => node.files));
          specRef.current = JSON.stringify(message.view.spec);
          setData({ root: message.root, view: message.view });
          setError(null);
          // The project asked for has arrived — including one another tab or
          // the menu bar asked for, which this client never started.
          setOpening(null);
          // A path from the previous project means nothing here.
          setSelected(null);
          // Nor does a name guessed for one of its clusters. The effect keyed
          // on the root asks the new session for its own, which is none.
          setSuggestions(new Map());
          setSuggestError(null);
          setSuggestCost(null);
          setRevision((n) => n + 1);
          return;
        }

        // A frozen view is frozen. The server already skips a socket whose spec
        // names a commit, but a push computed for the spec this client held a
        // moment before freezing can still be in flight, and nothing that
        // happens in the working tree changes what that commit looked like.
        if (message.type === 'changed') {
          if (frozenRef.current) return;
          // The working tree changed under a structural diff, and the hub —
          // which holds one graph — drew nothing: the diff is fetched again
          // from the route that resolves both ends. The marks are kept,
          // because the files they name did change. Nothing here can say
          // which of them is new — the diff's own A letter says that, and it
          // is the better answer while a diff is on.
          landed(message.changedFiles, NOTHING_NEW, message.by);
          setReloadToken((token) => token + 1);
          return;
        }

        if (message.type !== 'update') return;
        if (frozenRef.current) return;

        // An `update` under a diff is the hub's lag: the push was computed for
        // the spec this socket held before the diff was turned on, and its
        // view is the ordinary slice with no `diff` in its echo. The same
        // answer as to `changed` — the diff route draws it, the marks stay.
        if (diffRef.current) {
          landed(message.changedFiles, NOTHING_NEW, message.by);
          setReloadToken((token) => token + 1);
          return;
        }

        // The server computes each push from the spec it currently holds for this
        // socket, and that lags a navigation until the new spec has been sent.
        // Applying such a frame would silently revert the view, so it is refused
        // and a refetch takes its place rather than losing the update.
        const incoming = JSON.stringify(message.view.spec);
        if (specRef.current !== null && incoming !== specRef.current) {
          // The view this frame describes is not the one on screen, so its
          // node list cannot say what is new here — but the files did change,
          // and a mark dropped because a navigation was in flight is exactly
          // the change a person comes back and cannot find.
          landed(message.changedFiles, NOTHING_NEW, message.by);
          setReloadToken((token) => token + 1);
          return;
        }

        const after = new Set(message.view.nodes.flatMap((node) => node.files));
        // A file the view held a moment ago counts as in-view even when the
        // update removed it, or every deletion would report itself as elsewhere.
        const before = coveredRef.current;
        const outside = message.changedFiles.filter((file) => !after.has(file) && !before.has(file));
        coveredRef.current = after;

        setData((current) => (current ? { ...current, view: message.view } : current));
        // A file the diagram now has a box for and had none for a moment ago
        // is new here, and says so on the box. Nothing else on the client can
        // tell an added file from an edited one: the graph carries no birthday
        // and git's A is against a base, not against a minute ago.
        landed(
          message.changedFiles,
          new Set(message.changedFiles.filter((file) => after.has(file) && !before.has(file))),
          message.by,
        );
        setRevision((n) => n + 1);
        if (outside.length > 0) {
          setMissed((previous) => [...new Set([...previous, ...outside])]);
        }
      };
    };

    void connect();

    return () => {
      disposed = true;
      if (retry !== null) window.clearTimeout(retry);
      socketRef.current = null;
      socket?.close();
    };
  }, []);

  // Per revision rather than per project: the hook can be installed, the agent
  // can ask, and a commit can land, all without the project changing.
  useEffect(() => {
    let cancelled = false;
    fetchRepo().then(
      (info) => {
        if (!cancelled) setRepo(info);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, data?.root]);

  // The log is what the Graph draws, and a commit is invisible to the watcher:
  // the git poll notices the status change and publishes, which bumps the
  // revision, which is what re-reads the log.
  useEffect(() => {
    let cancelled = false;
    fetchLog().then(
      (result) => {
        if (!cancelled) setLog(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, data?.root]);

  /** The hook's state rides on the repo answer; nothing asks for it on its own. */
  const hookInstalled = repo?.hook.installed ?? null;

  /**
   * A fetch finished: take its remote, then re-read the log — the point of
   * fetching is that commits may have arrived. The panel ran the fetch; this
   * is where its answer meets the two things outside the panel that read it.
   */
  const handleFetched = useCallback((result: FetchResponse) => {
    setRepo((was) => (was === null ? was : { ...was, remote: result.remote }));
    fetchLog().then(setLog, () => undefined);
  }, []);

  /** The hook was written. What the server now says about it is the whole update. */
  const handleHookInstalled = useCallback((status: HookStatus) => {
    setRepo((was) => (was === null ? was : { ...was, hook: status }));
  }, []);

  // Per project, not per revision: this walks the tree, and what a repository is
  // written in does not change because a file was saved. A language that arrives
  // mid-session is missed until the project is reopened, which is the price of
  // not re-walking on every edit.
  useEffect(() => {
    let cancelled = false;
    fetchLanguages().then(
      (report) => {
        if (!cancelled) setLanguageReport(report);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [data?.root]);

  const decide = useCallback(
    (group: GroupSuggestion, name: string, state: 'accepted' | 'rejected') => {
      // Both ids, so a rename of a group whose members drifted replaces the
      // entry it was recorded under rather than appending a second one.
      decideCluster(group.files, name, state, {
        id: group.id,
        ...(group.storedId === undefined ? {} : { storedId: group.storedId }),
      }).then(
        () => {
          setRevision((n) => n + 1);
          // A decision is what a guess was waiting for, and either way it is
          // spent: accepted, the name is the user's now; rejected, the row is
          // gone. Left in the map it would come back if the group were ever
          // un-rejected, as advice about a decision already made.
          setSuggestions((was) => {
            if (!was.has(group.id)) return was;
            const next = new Map(was);
            next.delete(group.id);
            return next;
          });
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [],
  );

  /**
   * Which id addresses a stored group. A cluster id embeds its member count, so
   * it changes the moment a file joins or leaves — while the group it describes
   * survives, re-matched by overlap under the id it was recorded with. Editing
   * by the cluster id therefore fails on exactly the groups the overlap
   * matching exists to keep alive.
   */
  const addressOf = (group: GroupSuggestion): string => group.storedId ?? group.id;

  /**
   * Every group edit is answered with the whole freshly merged list, so the
   * page replaces what it holds rather than patching one row: a hand-drawn
   * group can displace a derived one, and the reply is the only place that
   * knows which.
   */
  const editGroup = useCallback((body: unknown) => {
    groupAction(body).then(
      (next) => {
        setClusters(next.clusters);
        setOrphans(next.orphans);
        // The write landed, so whatever the last one said about it is stale.
        setError(null);
      },
      (cause: unknown) => {
        // Renaming, recolouring or dragging a frame writes the same file a
        // new category does, so the same question can come back — and it is
        // held to be answered rather than printed. `pending` is the body to
        // send again once it is.
        if (cause instanceof Error && 'needsConsent' in cause) setGroupConsent({ pending: body });
        else setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, []);

  /**
   * Naming a suggestion is what accepts it, and acceptance finds its cluster
   * again through membership. A hand-drawn group has no cluster to be found in,
   * so it is patched by the id it was born with — which is also what lets it be
   * renamed without becoming a different group.
   */
  const renameGroup = useCallback(
    (group: GroupSuggestion, name: string) => {
      if (group.origin === 'manual') editGroup({ action: 'update', id: addressOf(group), name });
      else decide(group, name, 'accepted');
    },
    [decide, editGroup],
  );

  /** What the picked boxes stand for. A folder box is many files, so a group
   * drawn around one has to take the files, never the box's own id. */
  const selection = useMemo(() => {
    const chosen = (data?.view.nodes ?? []).filter((node) => picked.has(node.id));
    // A bundle is left out of what a group is drawn from. A folder box was
    // chosen for what it is — a directory somebody pointed at — but a bundle
    // is whatever a hop happened to sweep up, so shift-clicking one would
    // propose a category of 258 files nobody looked at, under a name they
    // meant for three boxes. Counted from the view rather than from `picked`,
    // which can still name a box the last update removed.
    //
    // A component too: it already is a category, and a category drawn by hand
    // over two found ones would be no box at all on the component diagram —
    // the found ones claim its files first — so the gesture would write a
    // group and draw nothing.
    const boxes = chosen.filter((node) => node.kind !== 'bundle' && node.kind !== 'component');
    return { boxes: boxes.length, files: [...new Set(boxes.flatMap((node) => node.files))] };
  }, [data?.view, picked]);

  /**
   * The files are an argument rather than read off the selection, because the
   * press that answers the server's question comes after the selection may
   * have moved on: the answer sends what was asked about, not what is picked.
   */
  const createGroup = useCallback((name: string, files: string[], createStore = false) => {
    setGroupConsent(null);
    setCreateRefusal(null);
    groupAction({ action: 'create', name, files, ...(createStore ? { createStore: true } : {}) }).then(
      (next) => {
        setClusters(next.clusters);
        setOrphans(next.orphans);
        setCreating(false);
      },
      (cause: unknown) => {
        // A rejection carrying `needsConsent` is the server's question about
        // .codemap/ — the one refusal a press can answer — and is held rather
        // than printed. Every other refusal is printed where the press was.
        if (cause instanceof Error && 'needsConsent' in cause) setGroupConsent({ name, files });
        else setCreateRefusal(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, []);

  const view = data?.view;
  const depth = view?.spec.depth ?? 1;
  const focus = view?.spec.focus ?? null;
  // The calls button is one case of the edge filter, not a flag of its own.
  const showCalls = view?.spec.filter.edgeKinds.includes('calls') ?? false;
  const showAssoc = view?.spec.filter.edgeKinds.includes('associates') ?? false;
  const showDepends = view?.spec.filter.edgeKinds.includes('depends') ?? false;
  const onlyChanged = view?.spec.filter.onlyChanged ?? false;
  /**
   * Tests, fixtures and stories left out. Carried through every navigation
   * the way "changes only" is: it says what is worth drawing wherever you
   * are, and a click that quietly brought eighty test files back would be
   * answering a question nobody asked.
   */
  const hideTests = view?.spec.filter.hideTests ?? false;
  /**
   * The commit on screen, or null for now. Threaded through every navigation
   * the way the calls and changed flags are: a helper that rebuilt the URL
   * without it would snap the user back to the present on the first click.
   */
  const at = view?.spec.at ?? null;
  const frozen = at !== null;
  /**
   * The structural diff: what the URL asked to compare against — `base`, or
   * a commit — and whether the view on screen is one. `?diff=` is a view
   * like `at`, and it rides the URL; what it is against, in words, is
   * `diffSince`, which the boxes, the chip and the status bar all print.
   */
  const diffAsked = view?.spec.diff;
  const diffOn = diffAsked !== undefined;
  /**
   * The front page: `/` with nothing asked for, or only a commit. Read off
   * the URL and not the view, because the view under it is the root view
   * either way — the page still fetches it, so the socket, the counts and
   * the crumb have a project to describe, and "Draw the whole project" can
   * say how many boxes it is. What the URL says is the front page; what the
   * engine drew underneath is covered.
   */
  const frontOn = isFrontPage(search);
  /**
   * The categories as boxes, rather than files. A view, carried in the URL as
   * `diagram=components`; the filters and the commit apply to it as to any
   * other, and every helper that rebuilds the URL from the live one keeps it.
   * The ones that build a URL afresh — a focus, a scope — drop it on purpose:
   * a place in the project is the class diagram's to draw.
   */
  const componentsOn = view?.spec.diagram === 'components';
  /**
   * The folders as frames around the boxes, nested — a second arrangement of
   * the same boxes, carried in the URL as `folders=1`.
   *
   * Read off the **echo** and never off the URL, like every other view flag,
   * and here it is load-bearing rather than tidy: the engine refuses the
   * arrangement where a folder is already a box (above the grouping
   * threshold), where a category is the box (the component diagram, a
   * category scope), where the boxes are a neighbourhood rather than a place
   * (a focus) and where there are no frames at all (a list). It drops the key
   * from the echo each time, so this is false exactly when no frame is drawn.
   */
  const foldersOn = view?.spec.folders === true;
  /**
   * Rows or boxes. The engine's decision, read and never re-derived: the
   * threshold lives in `presentationOf`, and a page that counted boxes for
   * itself is how a live push would redraw a list as a diagram. `asked` is
   * what the URL said, for the chip and the checked menu item; `listOn` is
   * what is on screen.
   */
  const presentation: Presentation = view?.presentation ?? 'diagram';
  const listOn = presentation === 'list';
  const asked = view?.spec.as;
  /** The stored id of the category this view is a scope of, or undefined. */
  const categoryScope = view?.spec.category;
  /**
   * Faint lines: in a scope diagram every line is drawn at a quarter until a
   * box is under the cursor or picked, and then only its own lines are drawn
   * whole — so a 25-box scope reads as boxes with lines on demand rather
   * than as a net. Never in a focus, where the lines are the answer, and
   * never in a diff, where every line drawn is one that changed.
   */
  const faintOn = view !== undefined && !listOn && focus === null && view.spec.diff === undefined;

  useEffect(() => {
    let cancelled = false;
    const root = data?.root ?? null;
    fetchClusters(at).then(
      (found) => {
        if (cancelled) return;
        setClusters(found.clusters);
        setOrphans(found.orphans);
        setClustersFor(`${root ?? ''}\n${at ?? ''}`);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, groupsRevision, data?.root, at]);

  /**
   * The front page, re-read whenever anything on it could have moved: a
   * save or a commit (`revision` — the socket push, and the server's git
   * poll publishing when the status changed), a name given (`groupsRevision`),
   * the agent asking (`agentCalls`), or the project switching. Nothing is
   * read while the page is not up. The commit rides the URL, and the server
   * says in its own words why a frozen front page is refused; the page
   * prints that sentence rather than a status code.
   */
  const lastAgentAt = agentCalls[0]?.at ?? null;
  useEffect(() => {
    if (!frontOn) return;
    let cancelled = false;
    fetchOverview(new URLSearchParams(search).get('at')).then(
      (result) => {
        if (cancelled) return;
        setOverview(result);
        setOverviewError(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setOverview(null);
        setOverviewError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [frontOn, search, revision, groupsRevision, lastAgentAt, data?.root]);

  // Per project: the server keeps the last run's names with the session, so a
  // reload — or a second tab — is shown what was already paid for rather than
  // asked to pay again. A fresh session answers null, which empties the list.
  useEffect(() => {
    let cancelled = false;
    fetchSuggestions().then(
      ({ result, running }) => {
        if (cancelled) return;
        setSuggestions(new Map(result?.ok ? result.suggestions.map((s) => [s.id, s]) : []));
        setSuggestCost(result?.ok ? { costUsd: result.costUsd, ms: result.ms } : null);
        // A run another tab started, or this one before a reload, is still
        // spending; the section says so, and the poll below sees it end.
        setSuggesting(running);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [data?.root]);

  /**
   * While a run is in flight, ask every few seconds whether it has ended. The
   * fetch that started it is the first to hear, but only if this page holds
   * it: a run seen from a reload or a second tab has no fetch to answer, and
   * one run sat on "Suggesting…" until the page was reloaded because of that.
   */
  useEffect(() => {
    if (!suggesting) return;
    const timer = window.setInterval(() => {
      fetchSuggestions().then(
        ({ result, running }) => {
          if (running) return;
          setSuggesting(false);
          if (result?.ok) {
            setSuggestions(new Map(result.suggestions.map((s) => [s.id, s])));
            setSuggestCost({ costUsd: result.costUsd, ms: result.ms });
          } else if (result !== null) {
            setSuggestError(result.detail === '' ? result.reason : result.detail);
          }
        },
        () => undefined,
      );
    }, RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [suggesting]);

  /** How many categories a press would name. Counted from what is on screen. */
  const unnamed = useMemo(
    () => clusters.filter((group) => group.state === 'suggested').length,
    [clusters],
  );

  /**
   * Why a press would do nothing, or null when it would run. One answer for
   * the section's button and the menu item, so the two never disagree about
   * whether the user may spend the money.
   */
  const suggestBlocked = suggesting
    ? 'A run is in flight. It takes a minute, sometimes several.'
    : frozen
      ? 'Leave the commit first: names are suggested for the live categories'
      : clusters.length === 0
        ? 'No categories found yet'
        : unnamed === 0
          ? 'Every category already has a name'
          : null;

  // The root the page shows, readable from inside a promise that outlives a
  // project switch: the fetch is held for the whole run, and the old
  // project's names must not land in the new project's section.
  const rootRef = useRef<string | null>(null);
  rootRef.current = data?.root ?? null;

  /**
   * Spend the user's money, on exactly the categories without a name. Nothing
   * is ever suggested automatically; this only ever happens on a press. The
   * fetch is held for the whole run, and a run that failed answers 200 with
   * its reason in words, which is what the section shows verbatim.
   */
  const suggest = useCallback(() => {
    if (suggestBlocked !== null) return;
    setSuggesting(true);
    setSuggestError(null);
    const pressedFor = rootRef.current;
    requestSuggestions()
      .then(
        (result) => {
          if (rootRef.current !== pressedFor) return;
          if (result.ok) {
            setSuggestions(new Map(result.suggestions.map((s) => [s.id, s])));
            setSuggestCost({ costUsd: result.costUsd, ms: result.ms });
          } else {
            setSuggestError(result.detail === '' ? result.reason : result.detail);
          }
        },
        (cause: unknown) => setSuggestError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setSuggesting(false));
  }, [suggestBlocked]);

  /** Off the page, and nowhere else: a guess was never anywhere else. */
  const dismissSuggestion = useCallback((id: string) => {
    setSuggestions((was) => {
      const next = new Map(was);
      next.delete(id);
      return next;
    });
  }, []);

  /**
   * null when the project is not a git work tree, which is normal, not a fault.
   *
   * A frozen view carries no git — a past commit has no working-tree status —
   * but the status bar and the Changes list describe *now* whatever is drawn,
   * so while frozen the same shape is rebuilt from the status fetched on its
   * own. The count matches the view's: every path git reports.
   */
  const git = useMemo(
    () =>
      view?.git ??
      (gitLines === null
        ? null
        : {
            base: gitLines.base,
            requested: gitLines.requested,
            branch: gitLines.branch,
            changed: Object.keys(gitLines.files).length,
          }),
    [view?.git, gitLines],
  );
  // What the row calls the base. The resolved one is a merge-base sha for
  // 'branch', which says nothing to anybody, so it stays in the tooltip.
  const baseLabel = GIT_BASES.find((base) => base.value === git?.requested)?.label ?? git?.base ?? '';
  const viewKey = view ? JSON.stringify(view.spec) : 'loading';

  /**
   * Boxes a person put somewhere, for the view on screen.
   *
   * The arithmetic is all in `web/src/placement.ts`, including which view a
   * placement belongs to and why a list gets no key at all — this is the
   * wiring. Two things about it are load-bearing here:
   *
   * The key is built from the **echoed** spec and the server's presentation,
   * never from the URL: the server clears scope and focus under
   * `?diagram=components` and drops scope, focus and category under `?diff=`,
   * and a key that did not see what was actually drawn would put one view's
   * boxes on another's. No project root is no key either — a placement is
   * stored under the project it belongs to or not at all.
   *
   * Held in state as well as in storage because a resize is a hundred frames
   * and the canvas is controlled: React Flow reports a size and applies
   * nothing, so the map on screen is written on every frame and the browser is
   * written once, when the edge is let go.
   */
  const placementRoot = data?.root ?? '';
  const placementKey =
    view === undefined || placementRoot === '' ? null : viewKeyOf(view.spec, view.presentation);
  const [placements, setPlacements] = useState<Placements>(() => new Map());
  useEffect(() => {
    setPlacements(loadPlacements(placementRoot, placementKey));
  }, [placementRoot, placementKey]);
  /**
   * A different picture is a different set of folders, so nothing stays shut
   * across one. The placement key is what "a different picture" means here —
   * it is built from the echoed spec, and it already tells the folder
   * arrangement from the flat one.
   */
  useEffect(() => {
    setFoldedFolders(new Set());
  }, [placementRoot, placementKey]);
  /**
   * Whether saying what a box is written in adds anything. In a project of one
   * language the same tag on every box is noise the header already covers, so
   * there is no tag at all; the moment there are two, every box says which.
   */
  const mixedProject = (view?.languages.length ?? 0) > 1;
  /**
   * Every file the view on screen stands for — under the front page the root
   * view, which is the whole project, folders and all. What the front page
   * asks before it links the agent's target: a `describe_file` on a
   * directory is a path with no file box, and a link to `?focus=` on it was
   * a link to a 404.
   */
  const viewFiles = useMemo(() => new Set(view?.nodes.flatMap((node) => node.files) ?? []), [view]);

  useEffect(() => {
    frozenRef.current = frozen;
  }, [frozen]);
  useEffect(() => {
    diffRef.current = diffOn;
  }, [diffOn]);

  /**
   * What a diff would be against from here: the git base while the diagram
   * is now, and the commit's first parent while it is frozen — a commit's
   * diff is against what came before it, and its parent is what the log
   * says came before. Null with the reason when nothing can be compared.
   */
  const diffTarget = useMemo((): { from: string; since: string } | { why: string } => {
    if (git === null) return { why: 'This project is not a git work tree, so there is no base to compare against' };
    if (at === null) return { from: 'base', since: baseLabel };
    if (log === null) return { why: 'Reading the log…' };
    const commit = findCommit(log.commits, at);
    if (commit === null) return { why: `${shortSha(at)} is further back than the log holds, so its parent is not known` };
    const parent = commit.parents[0];
    if (parent === undefined) return { why: `${shortSha(at)} is a root commit: nothing came before it to compare against` };
    return { from: parent, since: shortSha(parent) };
  }, [git, at, log, baseLabel]);
  /** What the diff on screen is against, in words — `HEAD`, `merge base`, a short sha. */
  const diffSince = diffAsked === undefined ? null : diffAsked === 'base' ? baseLabel : shortSha(diffAsked);

  /**
   * The diff's numbers for the Source Control row and the front page, read
   * whenever the graph moves (`revision`), the base changes or the commit on
   * screen does. The first answer for a base builds that commit's graph
   * through the parser pool — seconds on a project this size — and every
   * answer after is a comparison of two graphs already in hand. Keyed so an
   * answer for a base since left is never printed under the new one.
   */
  useEffect(() => {
    if ('why' in diffTarget) return;
    const from = diffTarget.from;
    const to = at ?? 'live';
    const key = `${data?.root ?? ''}\n${from}\n${to}\n${git?.base ?? ''}`;
    let cancelled = false;
    fetchDiff(from, to).then(
      (reply) => {
        if (!cancelled) {
          setDiffRow({ key, row: { state: 'ready', since: diffTarget.since, counts: reply.counts, caveat: reply.caveat } });
        }
      },
      (cause: unknown) => {
        if (!cancelled) setDiffRow({ key, row: { state: 'blocked', why: cause instanceof Error ? cause.message : String(cause) } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [diffTarget, at, revision, data?.root, git?.base]);
  /**
   * The diff on screen, counted over boxes: what came, what went — the
   * ghosts — what changed shape, and the far ends drawn as context. What
   * the status bar prints under a diff instead of "N boxes · N files".
   */
  const diffCounts = useMemo(() => {
    const counts = { added: 0, removed: 0, touched: 0, context: 0 };
    for (const node of view?.nodes ?? []) {
      if (node.change === undefined) counts.context += 1;
      else counts[node.change] += 1;
    }
    return counts;
  }, [view]);
  /**
   * The commit a selected ghost is read from, or null: a removed file is in
   * no live graph, so its panel asks the graph the diff compared against —
   * the resolved sha, because `base` is a word the detail route does not take.
   */
  const ghostAt = useMemo(() => {
    if (selected === null || data?.diff === undefined) return null;
    const box = view?.nodes.find((node) => node.id === selected);
    return box?.change === 'removed' ? data.diff.from.sha : null;
  }, [selected, data, view]);
  /** The row as it stands: blocked with the reason, read once, or reading. */
  const diffRowNow: DiffRow =
    'why' in diffTarget
      ? { state: 'blocked', why: diffTarget.why }
      : diffRow !== null &&
          diffRow.key === `${data?.root ?? ''}\n${diffTarget.from}\n${at ?? 'live'}\n${git?.base ?? ''}`
        ? diffRow.row
        : { state: 'reading', since: diffTarget.since };

  /**
   * While frozen the server pushes nothing to this client — nothing in the
   * working tree changes what a commit looked like — and the socket push is
   * also what bumped `revision`, which is what re-read the change feed, the
   * status and the log. The left column has to keep describing now, so while
   * the diagram is stopped those three are polled instead: the same three
   * seconds the server's own git poll runs at, and nothing else.
   */
  useEffect(() => {
    if (!frozen) return;
    const tick = (): void => {
      fetchChanges().then(setChanges, () => undefined);
      fetchGit().then(setGitLines, () => undefined);
      fetchLog().then(setLog, () => undefined);
    };
    const timer = window.setInterval(tick, 3000);
    return () => window.clearInterval(timer);
  }, [frozen]);

  // Re-read whenever the graph moves: the server polls git every 3 seconds and
  // publishes when it changes, and that push is what bumps the revision.
  // A re-parse can give a symbol a new id or drop it, so nothing cached survives it.
  useEffect(() => {
    setLinks(new Map());
  }, [revision, at]);

  /**
   * Ask about everything followed that has no answer yet.
   *
   * A 404 and a failed request must not collapse into the same nothing. A 404
   * is the graph saying that id is gone — a rename, or a file that would not
   * parse this cycle — and it is recorded, because a gone symbol still needs a
   * row with a ✕: without one it sits in the chip's count and can be removed
   * nowhere, which is the defect this replaces. A failed request says nothing
   * about the graph, so it is not recorded at all, and the effect above empties
   * this map on the next revision so the symbol is asked about again.
   *
   * Nothing is dropped from `following` either way. A file saved mid-edit does
   * not parse for a cycle and every symbol in it answers 404; pruning on that
   * would silently unfollow the lot, permanently, exactly while the agent works.
   */
  useEffect(() => {
    const missing = [...following].filter((id) => !links.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map((id) =>
        fetchSymbol(id, at).then(
          (found) => found ?? ('gone' as const),
          () => null,
        ),
      ),
    ).then((results) => {
      if (cancelled) return;
      // Recording nothing must re-render nothing. A map that only looks the same
      // is still a new object, and would restart this effect into a retry loop.
      if (results.every((result) => result === null)) return;
      setLinks((was) => {
        const next = new Map(was);
        missing.forEach((id, index) => {
          const result = results[index];
          if (result != null) next.set(id, result);
        });
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [following, links, at]);

  /**
   * The union of what every followed symbol touches, not the intersection.
   *
   * Union answers "what do I reach if I take hold of these", which is the
   * question someone about to change three things has. Intersection answers a
   * different one — whether they share anything — and would need its own mode
   * rather than quietly changing what the same gesture means.
   */
  const relatedIds = useMemo(() => {
    const found = new Set<string>();
    for (const id of following) {
      const entry = linksOf(links.get(id));
      if (entry === null) continue;
      for (const relation of [...entry.uses, ...entry.usedBy]) found.add(relation.id);
    }
    return found;
  }, [following, links]);

  /**
   * The boxes any of it lands in — the followed symbol's own file and every file
   * holding something it reaches or that reaches it.
   *
   * Fading the rows inside a box was not enough on its own: a box holding
   * nothing relevant still read as fully present, and so did every edge on the
   * canvas, so the thing being followed had nothing to stand out against.
   */
  /**
   * What the chip says. Whether the answers have ARRIVED matters as much as the
   * counts: before they do, zero means "not asked yet"; after, it means "nothing
   * links to this" — and the diagram looks identical either way.
   */
  const reach = useMemo(() => {
    const ids = [...following];
    const settled = ids.every((id) => links.has(id));
    const found = ids
      .map((id) => linksOf(links.get(id)))
      .filter((entry): entry is SymbolLinks => entry !== null);
    // Followed, and no longer in the graph. The panel lists these rather than
    // the page forgetting them, so there is something left to press ✕ on.
    const gone = ids.filter((id) => links.get(id) === 'gone');
    const uses = found.reduce((total, entry) => total + entry.uses.length, 0);
    const usedBy = found.reduce((total, entry) => total + entry.usedBy.length, 0);
    const only = found.length === 1 ? found[0] : undefined;
    // A method or a field is reached through a receiver, and a receiver whose
    // type is not written down is not followed — so its "in" count is what is
    // known, never what there is. `partial` is kept apart from the note below
    // because it is the one thing on the chip that is a *claim*: only where the
    // graph looked everywhere by name may the grey "nothing links to this"
    // reading be drawn.
    const partial = found.find((entry) => entry.coverage === 'partial') ?? null;
    // The sentence the tooltip carries, whatever the state — every one of these
    // counts is a floor, so the chip's ≥ needs an explanation on every one of
    // them. A weaker state is preferred when several are followed: it is the
    // one that says the most about what is missing.
    const note = (partial ?? found[0])?.coverageNote ?? null;
    return {
      settled,
      uses,
      usedBy,
      total: uses + usedBy,
      label: only === undefined ? ids.length + ' symbols' : only.name,
      partial: partial === null ? null : partial.coverageNote,
      note,
      found,
      gone,
    };
  }, [following, links]);

  const relatedFiles = useMemo(() => {
    if (following.size === 0) return null;
    const found = new Set<string>();
    for (const id of following) {
      const entry = linksOf(links.get(id));
      if (entry === null) continue;
      found.add(entry.filePath);
      for (const relation of [...entry.uses, ...entry.usedBy]) found.add(relation.filePath);
    }
    return found;
  }, [following, links]);

  /**
   * What ⌘F found, in the slice that is drawn. Null when the bar is shut, and
   * null while it is open with nothing typed — an empty query is not a search
   * and must dim nothing.
   *
   * ⌘K and this ask different questions and the answers come from different
   * places on purpose. ⌘K asks the server about the whole graph and takes you
   * somewhere; this walks the boxes already on screen and takes you nowhere.
   * So it is a memo over `view` rather than a fetch, and it is spelled with
   * `matchedAt` — the matcher both palettes use — so `gst` finds `GraphStore`
   * here too.
   *
   * Matched against what the box actually draws: its label and its members'
   * names. Not the id, which on a bundle is `bundle:dependents:1` and would
   * answer to letters nobody can see on the canvas.
   *
   * A box holding a matching member is itself a match — that is where the
   * symbol *is*, and where the camera has to go to show it. Which row inside
   * it matched is not recorded here, because there is nowhere to put it: a
   * box draws what `BoxData` carries, and the field for it does not exist
   * yet. Until it does the box lights and the row does not, which is a
   * smaller answer than the one intended but not a wrong one.
   *
   * `boxes` is a list and not a set because Enter walks it, and the order it
   * walks has to be the view's own rather than whatever a set iterated in.
   */
  const found = useMemo(() => {
    const needle = (findQuery ?? '').trim().toLowerCase();
    if (needle === '' || view === undefined) return null;
    const boxes = view.nodes
      .filter(
        (node) =>
          matchedAt(node.label, needle).length > 0 ||
          node.members.some((member) => matchedAt(member.name, needle).length > 0) ||
          // A component's rows are what it provides, and they are drawn.
          (node.component?.provides.symbols ?? []).some(
            (symbol) => matchedAt(symbol.name, needle).length > 0,
          ),
      )
      .map((node) => node.id);
    return { boxes, on: new Set(boxes) };
  }, [findQuery, view]);

  /**
   * A different set of matches is a different search, so the step resets with
   * it. Typing already resets; this is the other way the set can change —
   * navigating, filtering, or an agent's save landing under the bar. Without
   * it the bar went on reading "2 of 11" over a diagram whose 20 matches the
   * camera had never visited.
   *
   * Keyed on the matches and not on the view, so a save that changes nothing
   * the query matches leaves the reader standing where they were.
   */
  const foundKey = found === null ? '' : found.boxes.join('\u0000');
  useEffect(() => {
    setFindAt(-1);
  }, [foundKey]);

  /**
   * The boxes the two lenses dim, as ids, for the list — which has no box
   * data to carry `aside` on. The same two rules the canvas applies in its
   * memo, in the same order: ⌘F wins while it has something typed, and the
   * following lens is what is underneath.
   */
  const asideIds = useMemo(() => {
    if (view === undefined) return new Set<string>();
    if (found !== null) return new Set(view.nodes.filter((node) => !found.on.has(node.id)).map((node) => node.id));
    if (relatedFiles === null) return new Set<string>();
    return new Set(
      view.nodes.filter((node) => !node.files.some((file) => relatedFiles.has(file))).map((node) => node.id),
    );
  }, [view, found, relatedFiles]);

  /** The box the selection names, or null when the diagram is not drawing one. */
  const selectedBox = useMemo(
    () => view?.nodes.find((node) => node.id === selected) ?? null,
    [view, selected],
  );

  /**
   * The graph id of every symbol the selected file declares, by name and line.
   *
   * The panel's symbol list comes from `/api/detail`, which names a symbol and
   * never says which id the graph filed it under — and the id is not derivable
   * from the name: a method is `path#Class.method`, and a second symbol of the
   * same name in one file wears a `~2`. The view carries the id on every
   * member, so the two are joined here, where both are in hand, rather than
   * rebuilt by a rule the panel would have to keep in step with `store.ts`.
   *
   * Empty when the selected file has no box of its own — collapsed into a
   * folder, or reached from a path row — and the panel then shows no Explain
   * on those rows, which is the honest answer: it has no id to ask about. The
   * file itself can still be read, from the panel's own header.
   */
  const selectedSymbolIds = useMemo(() => {
    const ids = new Map<string, string>();
    if (selectedBox === null || selectedBox.kind !== 'file') return ids;
    for (const member of selectedBox.members) ids.set(symbolKey(member.name, member.line), member.id);
    return ids;
  }, [selectedBox]);

  /**
   * The selection when it is one file, which is what Explain can be handed.
   *
   * Written as "not a pile" rather than "is a file box": a path row in the panel
   * selects a file the diagram may not be drawing at all — an importer outside
   * the scope — and that file is every bit as explainable as one with a box.
   * Only a folder and a bundle stand for many paths, and reading a pile one
   * file at a time is a different act from the one being offered, and a far
   * more expensive one.
   */
  const selectedFile =
    selected === null ||
    selectedBox?.kind === 'folder' ||
    selectedBox?.kind === 'bundle' ||
    selectedBox?.kind === 'component'
      ? null
      : selected;

  /**
   * The category a component box was drawn from, by the id it was keyed on —
   * the stored id for a named one, so the join survives membership drift the
   * way a frame's name does. Null for the no-category box, whose id names
   * nothing in the list, and for anything that is not a component.
   */
  const categoryOf = (boxId: string): GroupSuggestion | null => {
    if (!boxId.startsWith(COMPONENT_PREFIX)) return null;
    const key = boxId.slice(COMPONENT_PREFIX.length);
    return clusters.find((group) => (group.storedId ?? group.id) === key) ?? null;
  };

  /**
   * The selected component, with the lines that touch it, for the panel.
   * Read off the view's own edges, so what the panel lists under "Imported
   * by" is exactly the arrows on the canvas; null whenever the selection is
   * anything else. Heaviest line first, which is the one worth reading.
   */
  const componentSelection = useMemo((): ComponentSelection | null => {
    if (view === undefined || selectedBox === null || selectedBox.component === undefined) return null;
    const labelOf = new Map(view.nodes.map((node) => [node.id, node.label]));
    const link = (edge: ViewGraph['edges'][number], other: string): ComponentLink => ({
      id: other,
      label: labelOf.get(other) ?? other,
      kind: edge.kind,
      weight: edge.weight,
      ...(edge.guessed === true ? { guessed: true as const } : {}),
    });
    const heaviest = (a: ComponentLink, b: ComponentLink) => b.weight - a.weight || a.label.localeCompare(b.label);
    return {
      id: selectedBox.id,
      label: selectedBox.label,
      facts: selectedBox.component,
      files: selectedBox.files,
      importedBy: view.edges
        .filter((edge) => edge.to === selectedBox.id)
        .map((edge) => link(edge, edge.from))
        .sort(heaviest),
      imports: view.edges
        .filter((edge) => edge.from === selectedBox.id)
        .map((edge) => link(edge, edge.to))
        .sort(heaviest),
    };
  }, [view, selectedBox]);

  /** The held files as rows. The path is also the id they are explained under. */
  const readingFiles = useMemo(
    () => [...reading].map((path) => ({ path, name: path.split('/').pop() ?? path })),
    [reading],
  );

  /**
   * Everything the button would explain, as one list of ids.
   *
   * Which set an id came from stops mattering here: the server resolves each
   * against the graph, and a file node's id *is* its path. So the two are kept
   * apart for what they mean on the diagram, and joined for what they mean to
   * the model.
   */
  const explainIds = useMemo(() => [...following, ...reading], [following, reading]);

  /**
   * What is stored for those ids, and how a run is getting on.
   *
   * A run is a minute of subprocess and outlives the request that started it,
   * so its outcome is fetched rather than returned; while one is in flight this
   * asks again on a timer. `revision` is a dependency because an explanation's
   * state is computed against the file on disk — the same save that redraws a
   * box is what can turn a reading false.
   */
  useEffect(() => {
    if (explainIds.length === 0 && run === null) return;
    let cancelled = false;
    let timer = 0;

    const ask = (): void => {
      fetchExplanations(explainIds).then(
        (summary) => {
          if (cancelled) return;
          setExplanations(new Map(summary.explanations.map((entry) => [entry.id, entry])));
          takeRun(summary.run);
          if (summary.run?.state === 'running') timer = window.setTimeout(ask, RUN_POLL_MS);
        },
        // Leave on screen what is on screen: a poll that did not arrive is not
        // an answer that changed, and blanking the panel would claim it was.
        () => undefined,
      );
    };
    ask();

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [explainIds, revision, data?.root, run?.id, run?.state, takeRun]);

  /**
   * Ask for a run, and put what comes back where the panel reads it.
   *
   * Shared by the section's button and by the one-press Explain on a box, a
   * panel row and the menu. The interesting half is what a failure is: a
   * refusal arrives as the server's own words inside a 400 body, a broken
   * request as a rejection, and the two say different things to the reader.
   * One copy, so the four presses cannot come to disagree about that.
   */
  const sendExplain = useCallback(
    (ids: string[], force = false, createStore = false) => {
      setExplainError(null);
      setConsent(null);
      setStreamed('');
      requestExplanations(ids, force, createStore).then(
        (result) => {
          // The one refusal a press can answer, so it is held rather than
          // printed: what was asked for is kept beside the question, and
          // saying yes sends the same press again with consent.
          if (result.needsConsent !== null) setConsent({ path: result.needsConsent, ids, force });
          if (result.refused !== null) setExplainError({ reason: 'refused', detail: result.refused });
          takeRun(result.run);
        },
        (cause: unknown) =>
          setExplainError({ reason: 'failed', detail: cause instanceof Error ? cause.message : String(cause) }),
      );
    },
    [takeRun],
  );

  /** Say yes to the question above, and run the press that raised it. */
  const acceptStore = useCallback(() => {
    if (consent === null) return;
    sendExplain(consent.ids, consent.force, true);
  }, [consent, sendExplain]);

  /**
   * Spend the user's quota, on exactly what the list already holds. Nothing is
   * ever explained automatically; this only ever happens on a press.
   */
  const explainFollowed = useCallback(
    (force: boolean) => {
      // Only what has no current reading, unless told otherwise: a plain press
      // used to buy a second reading of a symbol the panel already called
      // current, at the same price as the first. The server skips those too;
      // not sending them is what keeps the run's own id list honest.
      const ids = force
        ? explainIds
        : explainIds.filter((id) => explanations.get(id)?.state !== 'current');
      if (ids.length === 0) return;
      sendExplain(ids, force);
    },
    [explainIds, explanations, sendExplain],
  );

  /**
   * Explain one thing, from wherever it was found.
   *
   * The readings have always rendered inside the Following section, and that
   * section is null until something is already being followed — so the paid
   * feature had no way in that anyone could see: three of seven readers walked
   * every menu, the whole Detail panel and ⌘K without the word Explain ever
   * appearing on screen. This is the gesture that fixes it, and it is one
   * gesture on purpose. A control that only put the row on the list would leave
   * the second half of the act to be discovered as well, in the same section
   * that was not findable.
   *
   * A symbol goes on `following`, which dims the diagram down to what it
   * touches; a file goes on `reading`, which dims nothing. That is the
   * existing distinction between the two sets and this does not blur it.
   */
  const explainOne = useCallback(
    (id: string, kind: 'symbol' | 'file') => {
      // The answer lands in the side bar, so pressing this with the panel shut
      // would spend money into a room nobody is in.
      setShowSidebar(true);
      const add = (was: ReadonlySet<string>): ReadonlySet<string> =>
        was.has(id) ? was : new Set([...was, id]);
      if (kind === 'file') setReading(add);
      else setFollowing(add);
      sendExplain([id]);
    },
    [sendExplain],
  );

  // Bound once each, because the box data is rebuilt from a memo and a fresh
  // arrow on every render would rebuild every box with it.
  const explainFile = useCallback((path: string) => explainOne(path, 'file'), [explainOne]);
  const explainSymbol = useCallback((id: string) => explainOne(id, 'symbol'), [explainOne]);

  /**
   * Draw the control flow of one symbol over the canvas. This is the only
   * thing that fetches a flow, and it runs on a press and nothing else.
   */
  const openFlow = useCallback((target: FlowTarget) => {
    // The two cover the same ground; the welcome has no close of its own when
    // the project is empty, and there is no flow to draw of an empty project.
    setShowWelcome(false);
    setFlowTarget(target);
  }, []);

  /**
   * Why a flow cannot be asked for a symbol in a file, or null. The language
   * is the file box's, when the diagram is drawing one; a file collapsed into
   * a folder has no box to read it off, and then the engine answers instead.
   */
  const flowBlocked = useCallback(
    (kind: string, filePath: string): string | null => {
      const box = view?.nodes.find((node) => node.kind === 'file' && node.id === filePath);
      return flowBlockedBy(kind, box?.language ?? null);
    },
    [view],
  );

  /**
   * What "the selection" is when its flow is asked for: the symbol open in
   * the panel, else the one symbol being followed. A box is a file, and a
   * file has no flow, so `selected` on its own is never it — the sentence in
   * `blocked` is the one the menu greys with, and it says where to pick one.
   */
  const flowSelection: { target: FlowTarget; kind: string } | { blocked: string } = (() => {
    if (panelSymbol !== null) return { target: panelSymbol, kind: panelSymbol.kind };
    const one = reach.found.length === 1 ? reach.found[0] : undefined;
    if (one !== undefined) {
      return { target: { id: one.id, name: one.name, filePath: one.filePath }, kind: one.kind };
    }
    if (following.size > 1) return { blocked: 'Several symbols are followed — open one in the panel to pick it' };
    // A component box is a category and a folder box a pile: neither is a
    // file, and telling the reader to look for a Declares list the panel does
    // not show sends them to a row that is not there.
    const box = view?.nodes.find((node) => node.id === selected);
    return {
      blocked:
        selected === null
          ? 'Nothing selected — open a function or method in the panel, or follow one'
          : box?.kind === 'component'
            ? 'A component is a category; pick a function or method from its Provides list in the panel'
            : box !== undefined && box.kind !== 'file'
              ? 'A box standing for several files lists no symbols — open one of its files first'
              : 'A box is a file; pick a function or method from the Declares list in the panel',
    };
  })();
  const flowItem: MenuItem = {
    label: 'Control flow of the selection…',
    ...('blocked' in flowSelection
      ? { disabledBecause: flowSelection.blocked }
      : (() => {
          const why = flowBlocked(flowSelection.kind, flowSelection.target.filePath);
          const { target } = flowSelection;
          return why === null ? { run: () => openFlow(target) } : { disabledBecause: why };
        })()),
  };

  // Navigating closes it. A link means "show me this", and the overlay would
  // hide exactly that; a project switch clears the URL and lands here too, so
  // a flow never outlives the project whose file it was read from.
  useEffect(() => {
    setFlowTarget(null);
  }, [search]);

  const cancelExplain = useCallback(() => {
    cancelExplanations().then(
      (result) => takeRun(result.run),
      () => undefined,
    );
  }, [takeRun]);

  /**
   * Forgetting is not unfollowing. The ✕ takes a row off the list; this takes the
   * words out of a file that is committed to the project, which is a different
   * act and needs its own control — the same reason groups have both a reject
   * and a delete.
   */
  const forgetOne = useCallback((id: string) => {
    forgetExplanation(id).then(
      () =>
        setExplanations((was) => {
          const next = new Map(was);
          next.delete(id);
          return next;
        }),
      (cause: unknown) =>
        setExplainError({ reason: 'failed', detail: cause instanceof Error ? cause.message : String(cause) }),
    );
  }, []);

  /**
   * Why the last press produced no words. A request that never became a run is
   * reported the same way, in the server's own wording — the useful half of a
   * failure is always the detail, not the label.
   */
  const explainFailure = useMemo((): { reason: ExplainFailure | 'refused'; detail: string } | null => {
    if (explainError !== null) return explainError;
    if (run?.state !== 'failed') return null;
    return { reason: run.reason ?? ('failed' as ExplainFailure), detail: run.detail ?? '' };
  }, [explainError, run]);

  useEffect(() => {
    let cancelled = false;
    fetchGit().then(
      (result) => {
        if (!cancelled) setGitLines(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
    // Not keyed on the base: changing it publishes a fresh view, and that push
    // bumps the revision. Keying on the view's git would stop this refetching
    // while frozen, when it is the only status the page has.
  }, [revision, data?.root]);

  useEffect(() => {
    let cancelled = false;
    fetchChanges().then(
      (result) => {
        if (!cancelled) setChanges(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, data?.root]);

  // Tell the server which slice this client is looking at, so its updates are
  // computed for this view rather than broadcast as one shared one.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !view || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ spec: view.spec }));
    // Keyed on the whole spec, filter included. Listing scope, focus and depth
    // by hand meant switching a filter on never reached the server, so it kept
    // computing this client's pushes for the view it had stopped looking at.
  }, [viewKey, live]);

  useEffect(() => {
    if (pulsing.length === 0) return;
    const timer = window.setTimeout(() => setPulsing([]), PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [pulsing]);

  useEffect(() => {
    if (agentLooking.length === 0) return;
    const timer = window.setTimeout(() => setAgentLooking([]), PULSE_MS);
    return () => window.clearTimeout(timer);
  }, [agentLooking]);

  useEffect(() => {
    // `Date.now()` and not `markNow`: the render clock is where the bands are
    // read, and the wait has to be measured from the real one or a mark that
    // landed after the last tick is timed from before it existed.
    const wait = nextChange(marks, Date.now(), WRITTEN);
    if (wait === null) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setMarks((was) => liveMarks(was, now, WRITTEN));
      setMarkNow(now);
      // A floor, so a `wait` of 0 — a mark already past its moment when the
      // effect ran — cannot spin the timer inside one frame.
    }, Math.max(wait, 16));
    return () => window.clearTimeout(timer);
  }, [marks, markNow]);

  useEffect(() => {
    const wait = nextChange(
      // `agentAsked` holds a time and no more; the shape `nextChange` reads
      // wants a mark, and the band is all either of them is asked for.
      new Map([...agentAsked].map(([file, at]) => [file, { at, born: false, by: null }])),
      Date.now(),
      ASKED,
    );
    if (wait === null) return;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setAgentAsked((was) => {
        const next = new Map([...was].filter(([, at]) => now - at < ASKED.gone));
        return next.size === was.size ? was : next;
      });
      setMarkNow(now);
    }, Math.max(wait, 16));
    return () => window.clearTimeout(timer);
  }, [agentAsked, markNow]);

  // The log is fetched once per project; the socket keeps it current after that.
  useEffect(() => {
    let cancelled = false;
    fetchAgentCalls().then(
      (result) => {
        if (!cancelled) setAgentCalls(result.calls);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [data?.root]);

  /**
   * Where a drag put things, once it is let go — a frame, a box, or the
   * several boxes a multi-selection drags at once.
   *
   * A **frame** keeps where it was put by being locked, because a frame that
   * is not locked is recomputed around its members on the next edit and the
   * drag would be undone. A **box** keeps where it was put by being stored:
   * `placeBox` hands back the view's placements at once, and the layout memo
   * lays them over whatever dagre or `keepLayout` computed. No holding map
   * like the frames' `dragged` is needed for a box — there is no round trip to
   * the server to wait out.
   *
   * `moved` and not just `node`: React Flow drags every selected node when one
   * of them is grabbed, which is the gesture people expect and is also how
   * several boxes get arranged at once. It does not fight the category
   * gesture — the selection is what both read, and a drag changes it exactly
   * as a click does.
   */
  const handleNodeDragStop = useCallback(
    (
      _: unknown,
      node: { id: string; position: { x: number; y: number }; width?: number | null; height?: number | null },
      moved: readonly { id: string; position: { x: number; y: number } }[],
    ) => {
      if (node.id.startsWith('group:')) {
        const group = clusters.find((candidate) => `group:${candidate.id}` === node.id);
        if (!group || node.width == null || node.height == null) return;
        editGroup({
          action: 'update',
          id: group.storedId ?? group.id,
          geometry: { x: node.position.x, y: node.position.y, width: node.width, height: node.height },
          locked: true,
        });
        return;
      }
      let next = placements;
      for (const box of moved) {
        if (box.id.startsWith('group:')) continue;
        // A click is a drag of no distance. d3 fires its start and its end for
        // a press that never moved — `nodeClickDistance` suppresses the click
        // event, not the drag — so without this every box somebody clicked to
        // inspect was pinned where it already stood. Measured: five boxes in
        // the store after five clicks, and Re-layout offering to drop them.
        // `rects` is where each box is actually drawn, which is the thing the
        // drag is being compared with.
        const drawn = layoutRef.current.rects.get(box.id);
        if (
          drawn !== undefined &&
          Math.round(box.position.x) === Math.round(drawn.x) &&
          Math.round(box.position.y) === Math.round(drawn.y)
        ) {
          continue;
        }
        // A drag changes where the box is and nothing else, so a width somebody
        // pulled earlier is carried over rather than dropped or re-measured.
        const held = placements.get(box.id);
        next = placeBox(placementRoot, placementKey, box.id, {
          x: box.position.x,
          y: box.position.y,
          ...(held?.width === undefined ? {} : { width: held.width }),
        });
      }
      if (next !== placements) setPlacements(next);
      // The gesture is over, so the stored placement is the answer and the live
      // one has nothing left to say. Cleared per id rather than wholesale: a
      // frame's entry is dropped when groups.json agrees, on its own schedule.
      setDragged((was) => {
        if (was.size === 0) return was;
        const rest = new Map(was);
        for (const box of moved) rest.delete(box.id);
        return rest.size === was.size ? was : rest;
      });
    },
    [clusters, editGroup, placements, placementRoot, placementKey],
  );

  /**
   * A box being pulled wider, and then let go.
   *
   * Live while it is being pulled, because the canvas is controlled: React
   * Flow works out the new width, reports it and applies nothing, so a box
   * that only heard about the end would sit still under the pointer and then
   * jump. The live half writes the map only; the browser is written once,
   * when `done` says the edge was let go.
   *
   * A resize pins the position too, and honestly so: there is one record per
   * box, and the left edge moves the box while it sizes it. "You sized it
   * there" is what the record says, and Re-layout drops both together.
   */
  const resizeBox = useCallback(
    (id: string, box: Placement, done: boolean) => {
      if (!done) {
        setPlacements((was) => new Map(was).set(id, box));
        return;
      }
      setPlacements(placeBox(placementRoot, placementKey, id, box));
    },
    [placementRoot, placementKey],
  );

  /**
   * One box put back where the layout wants it.
   *
   * The stored placement goes, and so does the box's rectangle in the layout
   * cache — or `keepLayout`, whose whole job is to hand every box back the
   * position it had, would hand back the hand-placed one it has been
   * preserving and nothing would move. Forgotten, the box is one that has just
   * arrived, and `keepLayout` places an arriving box beside the box it is most
   * connected to. That is the layout's own answer for where a box goes, which
   * is the most this can honestly mean short of re-laying out the whole view —
   * and that is the other item.
   */
  /**
   * The box the last "Put this box back" moved, until the camera has been told
   * about it. The effect that reads it sits under the layout memo, because it
   * needs the positions that memo works out.
   */
  const [putBack, setPutBack] = useState<string | null>(null);
  const unplaceBox = useCallback(
    (id: string) => {
      layoutRef.current.rects.delete(id);
      setPlacements(dropBox(placementRoot, placementKey, id));
      setPutBack(id);
    },
    [placementRoot, placementKey],
  );

  /**
   * The marks as the things that draw them want them: a band, whether the file
   * is new here, and the sentence to say when hovered. Keyed by file, because
   * that is what the front page's rows are.
   */
  const markedFiles = useMemo(() => shownMarks(marks, markNow, MARK_CLOCK), [marks, markNow]);

  /** The second signal, by file: how lately the agent asked about it. */
  const askedFiles = useMemo(() => {
    const bands = new Map<string, Band>();
    for (const [file, at] of agentAsked) {
      const band = bandOf(at, markNow, ASKED);
      if (band !== null) bands.set(file, band);
    }
    return bands;
  }, [agentAsked, markNow]);

  /**
   * The same two, by box. A box standing for a directory holds many files, and
   * takes the strongest mark among them: a folder with one file written this
   * second and eleven written a minute ago is somewhere something is happening
   * now, and saying "a minute ago" over it would send the reader elsewhere.
   */
  const markedBoxes = useMemo(() => {
    if (!view || markedFiles.size === 0) return new Map<string, Shown>();
    const boxes = new Map<string, Shown>();
    for (const node of view.nodes) {
      let best: Shown | null = null;
      for (const file of node.files) {
        const shown = markedFiles.get(file);
        if (shown === undefined) continue;
        if (best === null || (best.band === 'cooled' && shown.band === 'fresh')) best = shown;
        if (shown.born) best = { ...best, born: true };
      }
      if (best !== null) boxes.set(node.id, best);
    }
    return boxes;
  }, [view, markedFiles]);

  const askedBoxes = useMemo(() => {
    if (!view || askedFiles.size === 0) return new Map<string, Band>();
    const boxes = new Map<string, Band>();
    for (const node of view.nodes) {
      for (const file of node.files) {
        const band = askedFiles.get(file);
        if (band === undefined) continue;
        if (band === 'fresh' || !boxes.has(node.id)) boxes.set(node.id, band);
      }
    }
    return boxes;
  }, [view, askedFiles]);

  /**
   * Which boxes actually animate.
   *
   * The pulse is for the person watching right now, and no eye follows forty
   * things at once: past `PULSE_MAX` the batch is marked and not announced —
   * the amber is a heat map and reads fine at any size, and the count of what
   * arrived is Activity's job, which is a list and can hold forty rows. A
   * `git checkout` or a codemod is the case this is for.
   */
  const pulsingBoxIds = useMemo(() => {
    if (!view || pulsing.length === 0) return new Set<string>();
    const touched = new Set(pulsing);
    const ids = new Set(
      view.nodes.filter((node) => node.files.some((file) => touched.has(file))).map((n) => n.id),
    );
    return ids.size > PULSE_MAX ? new Set<string>() : ids;
  }, [view, pulsing]);

  /** The agent's question, announced the same way and under the same cap. */
  const askPulsingBoxIds = useMemo(() => {
    if (!view || agentLooking.length === 0) return new Set<string>();
    const looking = new Set(agentLooking);
    const ids = new Set(
      view.nodes.filter((node) => node.files.some((file) => looking.has(file))).map((n) => n.id),
    );
    return ids.size > PULSE_MAX ? new Set<string>() : ids;
  }, [view, agentLooking]);

  /** The same rule for the front page, whose rows are files and not boxes. */
  const pulsingFiles = useMemo(
    () => (pulsing.length > PULSE_MAX ? new Set<string>() : new Set(pulsing)),
    [pulsing],
  );
  const queriedFiles = useMemo(() => new Set(agentLooking), [agentLooking]);

  /**
   * The canvas the diagram is drawn in, read when a layout runs.
   *
   * Deliberately a ref and not state: the window size is an input to the
   * layout, not a reason to run one. Held as state it would re-run this memo
   * on every pixel of a drag on the window edge, and a resize is not a request
   * to move the boxes — the layout that comes after it is.
   */
  const canvasRef = useRef<HTMLDivElement | null>(null);
  /** The row the bars and the canvas share, which is the window the sashes divide. */
  const mainRef = useRef<HTMLElement | null>(null);

  /**
   * Each box's position in the view, as the token its lines wear: `edge-end-7`
   * on every line that touches the seventh box. It is how a hover finds the
   * lines to draw whole without React rendering anything — the page toggles
   * one class on the lines carrying the hovered box's token, and that is the
   * whole of it. An index and not the path, because a path is not a class
   * name and a hash of one could collide.
   */
  const boxIndex = useMemo(() => {
    // The folders after the boxes, because a shut folder frame *is* a box and
    // the lines that ran to its files run to it. Without a token of its own a
    // shut folder's lines would be the only ones on the canvas that never
    // light up under the cursor.
    const ids = [...(view?.nodes ?? []).map((node) => node.id), ...(view?.folders ?? []).map((folder) => folder.id)];
    return new Map(ids.map((id, index) => [id, index]));
  }, [view]);

  // Positions survive live updates: a box must not jump because the agent saved.
  const layoutRef = useRef<{
    /** Where every box stands and how big it is, for placing the next one beside it. */
    rects: Map<string, Rect>;
    clusters: ClusterBounds[];
    /** Everything the cached frames were drawn from. */
    clusterKey: string;
    /**
     * Which view these positions belong to, and which run of dagre. A new
     * value is a first layout and runs dagre; the same value keeps every box
     * where it stands whatever else changed.
     */
    layoutKey: string;
  }>({ rects: new Map(), clusters: [], clusterKey: '', layoutKey: '' });

  /**
   * The boxes, the lines and the frames as they are actually drawn: the view,
   * with whatever folder frames the reader has shut folded back into a folder
   * box and the lines re-pointed at it.
   *
   * Out here rather than inside the layout below, because the status bar has
   * to count what is on screen: a fold takes seven boxes away and puts one
   * back, and a count of `view.nodes` would go on saying eighteen.
   *
   * On a flat view these *are* `view`'s own arrays — `foldFolders` hands them
   * straight back when nothing is shut, which is every view this page drew
   * before this arrangement existed.
   */
  const arranged = useMemo(
    () => (view === undefined ? null : foldFolders(view, foldedFolders)),
    [view, foldedFolders],
  );
  /** How many boxes are drawn, a shut folder counting as the one it becomes. */
  const drawnBoxes = arranged === null ? 0 : arranged.nodes.length + arranged.boxes.length;

  const { nodes, edges } = useMemo(() => {
    if (!view || arranged === null) return { nodes: [] as FlowNode[], edges: [] as Edge[] };
    // A list places nothing: dagre over 106 boxes is exactly the cost the
    // list exists to skip, and the rows read `view` for themselves. The
    // cached layout is left as it was, so a scope that flips back under the
    // same key — a save that took it under the threshold — keeps its places.
    if (view.presentation === 'list') return { nodes: [] as FlowNode[], edges: [] as Edge[] };

    const indexOf = boxIndex;

    /** A box counts as involved when any file behind it is. */
    const involved = (id: string): boolean => {
      if (relatedFiles === null) return true;
      const node = arranged.nodes.find((candidate) => candidate.id === id);
      return node !== undefined && node.files.some((file) => relatedFiles.has(file));
    };

    /**
     * Which boxes are dimmed, and by whom. Two lenses can be on at once — a
     * followed symbol and a find — and both dim by the same means, so one of
     * them has to be in charge or a box would stay lit only where the two
     * agreed, which is the answer to neither question.
     *
     * ⌘F wins while it has something typed. It is the transient one: a
     * keystroke opens it and a keystroke closes it, and the following lens is
     * exactly as it was underneath when it does. It also asked last, which is
     * usually what a person means.
     */
    const lit = (id: string): boolean => {
      if (found !== null) return found.on.has(id);
      return involved(id);
    };
    const dimming = found !== null || relatedFiles !== null;

    const builtEdges: Edge[] = arranged.edges.map((edge) => ({
      id: `${edge.from}|${edge.kind}|${edge.to}`,
      type: 'relation',
      source: edge.from,
      target: edge.to,
      // What the marks at either end are drawn from, and nothing the view did
      // not say: the roles and the diamond arrive decided — see RelationEdge.
      data: {
        kind: edge.kind,
        ...(edge.roles === undefined ? {} : { roles: edge.roles }),
        ...(edge.ownership === undefined ? {} : { ownership: edge.ownership }),
      } satisfies RelationData,
      // An edge stays lit only when both ends are in it. One end is not a
      // relationship the followed symbol has any part in.
      //
      // `edge-guessed` draws it dotted — every reference behind the line was
      // resolved by a name match nothing in the referring file asked for. It
      // is a fact about how the line was found, so it is added to whatever the
      // kind already says rather than replacing it.
      // `edge-removed` draws a diff's gone line dashed and dimmed in its own
      // hue; an added line is drawn as its kind is, and the class only names it.
      className: `edge-${edge.kind}${edge.guessed === true ? ' edge-guessed' : ''}${
        edge.change === undefined ? '' : ` edge-${edge.change}`
      }${
        dimming && !(lit(edge.from) && lit(edge.to)) ? ' edge-aside' : ''
      } edge-end-${indexOf.get(edge.from) ?? -1} edge-end-${indexOf.get(edge.to) ?? -1}`,
      // A weight of one is the common case and labelling it is just noise.
      ...(edge.weight > 1 ? { label: String(edge.weight) } : {}),
    }));

    /** A class box is a file, a folder or a bundle; a component is a node type of its own. */
    const isClassBox = (node: ViewNode): node is ViewNode & { kind: 'file' | 'folder' | 'bundle' } =>
      node.kind !== 'component';

    const boxes: BoxNodeType[] = arranged.nodes.filter(isClassBox).map((node) => ({
      id: node.id,
      type: 'box',
      // Grabbed by its title bar, the way a window moves and the way a frame
      // moves by its label. Not the whole box: every member row is a control
      // already — a click follows the symbol, a double-click opens the editor
      // — and a drag beginning on one would fight the press.
      dragHandle: '.box-title',
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      // A bundle stands for a pile of files and draws a count, exactly as a
      // folder does, so it is measured as one — `!== 'file'` rather than
      // `=== 'folder'`, or a bundle would be given the height of a file with
      // no symbols and be shorter than its own label.
      height: boxHeight(node.members.length, node.kind !== 'file', expanded.has(node.id)),
      // The selection is held here, not inside React Flow: it re-reads the
      // nodes prop on every update, so a selection it kept to itself would be
      // wiped the moment the agent saved a file.
      selected: picked.has(node.id),
      ...(picked.has(node.id) ? { style: PICKED_STYLE } : {}),
      data: {
        label: node.label,
        kind: node.kind,
        bundleOf: bundleDirection(node.id),
        members: node.members,
        files: node.files,
        external: node.external,
        focused: node.focused,
        mark: markedBoxes.get(node.id) ?? null,
        asked: askedBoxes.get(node.id) ?? null,
        pulsing: pulsingBoxIds.has(node.id),
        pulsingAsk: askPulsingBoxIds.has(node.id),
        gitStatus: node.gitStatus,
        gitChanged: node.gitChanged,
        // Under a diff: what happened to this file, and what the diff is
        // against, for the letter and its title. Absent everywhere else.
        ...(node.change === undefined ? {} : { change: node.change }),
        since: diffSince,
        language: node.language,
        showLanguage: mixedProject,
        test: node.test,
        parseError: node.parseError,
        // Undefined on a folder box and on any file the report has no entry
        // for, which is most of them. Passed through as it came: absent means
        // unknown, and the box must never turn that into a zero.
        coverage: node.coverage,
        // Passed through as it came, for the same reason and with the opposite
        // meaning: every box has a number here, so absent is a measured zero
        // and the box draws no mark. It is what separates a box with no arrows
        // because the code leans on nothing from one with no arrows because the
        // references went somewhere we could not follow.
        unresolved: node.unresolved,
        root: data?.root ?? '',
        following,
        related: relatedIds,
        onFollow: toggleFollowing,
        // Fed from `reading`, never from `following`: holding a file adds it to
        // the explain list and dims nothing. Only a file box shows the control,
        // and the path it hands back is files[0] — the one `.box-open` opens.
        followed: node.kind === 'file' && reading.has(node.files[0] ?? ''),
        onFollowFile: toggleReading,
        onExplain: explainFile,
        onResize: (box: Placement, done: boolean) => resizeBox(node.id, box, done),
        expanded: expanded.has(node.id),
        onExpand: toggleExpanded,
        aside: dimming && !lit(node.id),
        // Why a dimmed box is not proof. Dimming is the diagram's own drawing
        // of "nothing here takes part in this", and it is built from the same
        // caller list the panel prints a count of — so where that list is a
        // floor, so is the dimming, and the box was the one surface saying it
        // without saying so.
        //
        // Null while ⌘F owns the dimming: there the sentence would be
        // qualifying a claim the box is no longer making. A find dims what
        // does not match the letters typed, and that is not a floor — it is
        // exactly what was asked for.
        asideNote: found === null ? reach.note : null,
      },
    }));

    // The categories as boxes, under `?diagram=components`. Measured from what
    // the box draws — a count line and a compartment of what it provides —
    // the way a file box is measured from its members, so dagre places it at
    // the size it renders. The colour is the category's own, joined off the
    // rows the Categories section lists; the box has no way to carry one. A
    // named category that chose none wears slate, as its frame does; a
    // category nobody has named, and the no-category box, wear nothing.
    const components: ComponentNodeType[] = arranged.nodes.flatMap((node): ComponentNodeType[] => {
      if (node.kind !== 'component' || node.component === undefined) return [];
      const { symbols, total } = node.component.provides;
      const color = categoryOf(node.id)?.color ?? (node.component.name === null ? null : 'slate');
      return [
        {
          id: node.id,
          type: 'component',
          dragHandle: '.box-title',
          position: { x: 0, y: 0 },
          width: NODE_WIDTH,
          height: componentHeight(symbols.length, total > symbols.length),
          selected: picked.has(node.id),
          ...(picked.has(node.id) ? { style: PICKED_STYLE } : {}),
          data: {
            label: node.label,
            facts: node.component,
            files: node.files,
            color,
            // A component box carries the two signals as booleans, which is
            // all `ComponentNode` reads: the amber and the blue stand for the
            // whole window, and the band, the `new` tag and the pulse are a
            // file box's, where they have a file to be about.
            changed: markedBoxes.has(node.id),
            queried: askedBoxes.has(node.id),
            gitChanged: node.gitChanged,
            language: node.language,
            showLanguage: mixedProject,
            test: node.test,
            parseError: node.parseError,
            unresolved: node.unresolved,
            aside: dimming && !lit(node.id),
            asideNote: found === null ? reach.note : null,
            following,
            related: relatedIds,
            onFollow: toggleFollowing,
            onResize: (box: Placement, done: boolean) => resizeBox(node.id, box, done),
          },
        },
      ];
    });

    /**
     * A folder the reader has shut: one box standing for its files, drawn by
     * `FolderNode` in the box's own chrome. It is measured as a folder box is
     * — a title and a count, whatever it holds — because that is what it is.
     */
    const shut: FolderNodeType[] = arranged.boxes.map((folder) => ({
      id: folder.id,
      type: 'folder' as const,
      dragHandle: '.box-title',
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: boxHeight(0, true),
      data: {
        id: folder.id,
        label: folder.label,
        fileCount: folder.fileCount,
        depth: folder.depth,
        folded: true,
        ghost: false,
        // A fold must not hide a change: the box says something inside it
        // moved, and how many files moved is already the count's job.
        marked: folder.files.some((file) => markedFiles.has(file)),
        onFold: (shutNow: boolean) => toggleFolded(folder.id, shutNow),
      },
    }));

    /** Every box dagre places and keepLayout keeps, whichever diagram this is. */
    const placed: (BoxNodeType | ComponentNodeType | FolderNodeType)[] = [...boxes, ...components, ...shut];

    /**
     * The folder frames, in the shape `layoutNodes` and `frameClusters`
     * already take for a category frame — `folder: true` is what tells them
     * the frame is a directory rather than a cluster, and it is what buys the
     * four rules a folder needs: a frame around one box is still drawn, the
     * slack is the inner slack at every depth, the bounds enclose the child
     * frames, and it is never dropped for overlapping.
     *
     * `cohesion: 0` because a folder has none to claim: nobody measured how
     * much of these files' coupling stays inside, and a folder frame never
     * enters the overlap contest where the number would be read.
     */
    const folderFrames: ClusterInput[] = arranged.folders.map((folder) => ({
      id: folder.id,
      files: folder.files,
      cohesion: 0,
      depth: folder.depth,
      parent: folder.parent,
      folder: true as const,
    }));

    const shown = clusters.filter((group) => group.state !== 'rejected');
    // No frames on the component diagram: a category is a box there, and a
    // frame's members are file paths that name no box on it. Passing them
    // through would draw nothing either way; leaving them out says so.
    //
    // And one frame system at a time. Under the folder arrangement the frames
    // are the folders and the categories are not drawn: measured over three
    // projects, every category spans more than one directory and more than one
    // top-level directory, so a category frame that respected a folder wall
    // would be the whole project — drawn over a folder layout, three of
    // astrup's eleven survive and one of them is an 8544px rectangle around
    // 172 boxes of which 167 are not in it. `?category=` is how a category is
    // seen whole, and the Categories panel still lists every one of them.
    const frameable = componentsOn ? [] : foldersOn ? folderFrames : shown;
    // Everything a frame is drawn from, not just which groups exist. Dragging a
    // corner or taking a file out of a hand-drawn group changes no id, so a key
    // of ids alone would hand back the cached bounds and the frame would never
    // move.
    const shapeKey = shown
      .map((group) => {
        const pad = group.padding;
        const slack = pad === undefined ? '' : `${pad.x}x${pad.y}`;
        // Geometry and the lock decide the frame's shape as much as membership
        // does, so a key without them reuses the cached bounds and a resize
        // simply never appears.
        const box = group.geometry;
        const placed = box === undefined ? '' : `${box.x},${box.y},${box.width},${box.height}`;
        return `${group.id}~${group.files.join(',')}~${group.color ?? ''}~${slack}~${placed}~${group.locked === true ? 'L' : ''}`;
      })
      .join('|')
      // A box that expanded is taller and nothing about its id says so, which is
      // the same trap a group's colour and padding fell into: the cached bounds
      // come back and the growth never appears.
      .concat('#', [...expanded].sort().join(','))
      // And which folders are frames right now. They are recomputed by the
      // engine for every view, and a fold takes one away, so a key that did
      // not see them would hand back the bounds of a frame that is gone.
      .concat('#', folderFrames.map((frame) => `${frame.id}~${frame.files.length}`).join(','));
    const previous = layoutRef.current;

    // Mark, do not move. dagre has no memory, so running it again for a save
    // that added one file placed every box afresh and the whole diagram
    // shuffled — which is exactly what makes a change impossible to follow.
    // It runs for a view's first layout and for an explicit Re-layout, and
    // for nothing else. The first layout is the one that has the groups: they
    // arrive from their own request, after the view, and dagre is what keeps
    // a group's members together, so a layout without them does not count.
    // Shutting a folder is the third thing that lays a view out afresh, and it
    // is not the exception the rule forbids: that rule is about a *save*, and
    // five reviewers named the shuffle-on-save as what broke "mark, do not
    // move". A fold is a person pressing a chevron while looking at the
    // picture, the box set changes because they asked it to, and the boxes
    // they placed by hand still win — placements are applied over whatever
    // dagre answers. Keeping the old places instead would leave the folder
    // that opened scattered beside its neighbours and its frame stretched
    // across the ones it does not hold.
    const foldKey = [...foldedFolders].sort().join(',');
    const clustersReady = clustersFor === `${data?.root ?? ''}\n${view.at ?? ''}`;
    const layoutKey = `${data?.root ?? ''}\n${viewKey}\n${clustersReady ? 'grouped' : 'plain'}\n${relayoutToken}\n${foldKey}`;
    const fresh = layoutKey !== previous.layoutKey;

    // Every box already placed, at the same size it had.
    const sameBoxes =
      !fresh &&
      placed.length === previous.rects.size &&
      placed.every((box) => previous.rects.get(box.id)?.height === box.height);
    const sameShape = sameBoxes && shapeKey === previous.clusterKey;

    // Only the contents changed: every box and frame stays exactly where it was.
    // Only a frame changed — a colour, a lock, a drag: every box stays, and the
    // frames are redrawn around where the boxes already are. Running dagre
    // again for that moved every box, and a frame locked to where it stood was
    // left standing where the boxes used to be.
    // A box came or went, or grew: the ones that were there keep their place,
    // the new one goes beside its most connected neighbour, and the frames
    // are redrawn around where everything now is.
    // A width somebody pulled goes in before the layout, not after: dagre
    // places from the sizes it is given, `keepLayout` measures the gap a new
    // box has to fit in, and a frame is drawn around the box's real edges. A
    // position set here is overwritten by both and re-applied below.
    const sized = applyPlacements(placed, placements);

    // A save has to land a new box *inside its own folder*, or the frame drawn
    // around it afterwards stretches across somebody else's — a picture that
    // says a file is in a folder it is not in. `keepLayout` does that when it
    // is handed the frames; a category frame spans directories by definition
    // and wants none of it, so the flat arrangement hands over nothing and
    // places exactly as it always has.
    const homes = foldersOn ? folderFrames : [];

    const laid = fresh
      ? layoutNodes(sized, builtEdges, frameable, canvasRef.current?.clientHeight ?? 0)
      : sameShape
        ? { nodes: keepLayout(previous.rects, sized, [], homes), clusters: previous.clusters }
        : (() => {
            const kept = keepLayout(previous.rects, sized, arranged.edges, homes);
            return { nodes: kept, clusters: frameClusters(kept, frameable) };
          })();

    // Mark, do not move — the promise made to a person rather than to dagre.
    // A hand placement wins over everything computed, the growth push a box
    // that expanded gives the column under it included: a box somebody put
    // somewhere does not move because its neighbour grew into it.
    // The stored arrangement first, then wherever a pointer is holding a box
    // right now. `dragged` is emptied when the gesture ends, so this is the
    // live half of a placement and never outlives one.
    const positioned = applyPlacements(laid.nodes, placements).map((box) => {
      const held = dragged.get(box.id);
      return held === undefined ? box : { ...box, position: held };
    });
    // And the frames are drawn around where the boxes ended up, or a member
    // dragged out of its frame would leave the frame behind. A locked frame is
    // a placement of its own and still wins, inside `frameClusters`.
    const framed = placements.size === 0 ? laid.clusters : frameClusters(positioned, frameable);
    const laidOut = { nodes: positioned, clusters: framed };

    layoutRef.current = {
      // The applied positions and the applied widths, not the computed ones:
      // `keepLayout` reads this to put the next new box beside its neighbour
      // and to push the column under a box that grew, and both have to be told
      // where the boxes actually are.
      rects: new Map(
        laidOut.nodes.map((box) => [
          box.id,
          { x: box.position.x, y: box.position.y, width: box.width ?? NODE_WIDTH, height: box.height ?? 0 },
        ]),
      ),
      clusters: laidOut.clusters,
      clusterKey: shapeKey,
      layoutKey,
    };

    const byId = new Map(shown.map((group) => [group.id, group]));
    /** Where every box actually landed, for asking what a locked frame missed. */
    const landed = new Map(laidOut.nodes.map((box) => [box.id, box]));
    laidOut.clusters.sort((a, b) => a.depth - b.depth);

    /**
     * The folder frames, drawn where the layout put them.
     *
     * A directory, not a category, and nothing on it can be renamed, coloured,
     * deleted or dragged — none of those is something you can do to a folder
     * from a diagram, and a frame that offered them would be claiming to be
     * the other kind. Its one gesture is the fold.
     */
    const folderById = new Map(arranged.folders.map((folder) => [folder.id, folder]));
    const changeOf = new Map(arranged.nodes.map((node) => [node.id, node.change]));
    const folderFrameNodes: FolderNodeType[] = foldersOn
      ? laidOut.clusters.flatMap((bounds): FolderNodeType[] => {
          const folder = folderById.get(bounds.id);
          if (folder === undefined) return [];
          return [
            {
              id: `folder:${bounds.id}`,
              type: 'folder' as const,
              position: { x: bounds.x, y: bounds.y },
              width: bounds.width,
              height: bounds.height,
              // Behind the boxes, and an outer frame behind the inner ones it
              // contains — the same two levels a category frame uses.
              zIndex: bounds.depth === 0 ? -2 : -1,
              selectable: false,
              draggable: false,
              data: {
                id: folder.id,
                label: folder.label,
                fileCount: folder.fileCount,
                depth: folder.depth,
                folded: false,
                // A folder every box in which is a ghost: the directory is
                // gone, and the frame is the only thing left saying it was
                // ever there. Derived here rather than carried by the engine
                // — it is exactly "every box in it is a ghost", and a second
                // place deciding that is a second place to be wrong.
                ghost: folder.files.length > 0 && folder.files.every((file) => changeOf.get(file) === 'removed'),
                marked: false,
                onFold: (shutNow: boolean) => toggleFolded(folder.id, shutNow),
              },
            },
          ];
        })
      : [];

    // Frames first, so they render behind the boxes they enclose.
    const frames: GroupNodeType[] = laidOut.clusters.flatMap((bounds) => {
      const group = byId.get(bounds.id);
      if (!group) return [];
      return [
        {
          id: `group:${bounds.id}`,
          type: 'frame' as const,
          // Where it was just dragged to, until groups.json says the same.
          position: dragged.get(`group:${bounds.id}`) ?? { x: bounds.x, y: bounds.y },
          width: bounds.width,
          height: bounds.height,
          // Outer frames sit behind the inner ones they contain — and a frame
          // with its editor open comes to the front, because the popover is
          // taller than the padding strip it sits in and would otherwise be
          // drawn behind the very boxes the frame encloses.
          zIndex:
            editingFrame === `group:${bounds.id}` ? 20 : bounds.depth === 0 ? -2 : -1,
          selectable: false,
          // Dragged by its label, the way a window moves by its title bar. The
          // frame body cannot be the handle: it is drawn behind the boxes it
          // encloses and would swallow every drag meant for the canvas. Any
          // frame can be moved, and moving it is what locks it, the way pulling
          // a corner does — the lock is never a step before the gesture.
          draggable: true,
          dragHandle: '.group-label',
          data: {
            id: group.id,
            name: group.name,
            fileCount: group.files.length,
            cohesion: group.cohesion,
            accepted: group.state === 'accepted',
            depth: group.depth,
            origin: group.origin ?? null,
            color: group.color ?? null,
            padding: group.padding ?? null,
            locked: group.locked === true,
            outside:
              group.locked === true
                ? group.files.filter((file) => {
                    const box = landed.get(file);
                    if (!box) return false;
                    return (
                      box.position.x < bounds.x ||
                      box.position.y < bounds.y ||
                      box.position.x + (box.width ?? 0) > bounds.x + bounds.width ||
                      box.position.y + (box.height ?? 0) > bounds.y + bounds.height
                    );
                  }).length
                : 0,
            onAccept: (name: string) => decide(group, name, 'accepted'),
            onReject: () => decide(group, group.name ?? '', 'rejected'),
            onRename: (name: string) => renameGroup(group, name),
            onColor: (color: GroupColor) => editGroup({ action: 'update', id: addressOf(group), color }),
            onDelete: () => editGroup({ action: 'delete', id: addressOf(group) }),
            onGeometry: (geometry: { x: number; y: number; width: number; height: number }) =>
              editGroup({ action: 'update', id: addressOf(group), geometry, locked: true }),
            onEditing: (open: boolean) =>
              setEditingFrame((was) =>
                open ? `group:${bounds.id}` : was === `group:${bounds.id}` ? null : was,
              ),
            onLock: (locked: boolean) =>
              editGroup({
                action: 'update',
                id: addressOf(group),
                locked,
                // Locking with no frame of its own holds it exactly where it is
                // drawn right now, which is the only sane reading of the click.
                ...(locked && group.geometry === undefined
                  ? { geometry: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } }
                  : {}),
              }),
          },
        },
      ];
    });

    return {
      // Both kinds of frame first, so they render behind the boxes. Only one
      // of the two lists is ever non-empty: two frame systems on one canvas
      // was refused on evidence — see `frameable` above.
      nodes: ([...frames, ...folderFrameNodes, ...laidOut.nodes] as FlowNode[]).map(withMeasured),
      edges: builtEdges,
    };
  }, [
    view,
    boxIndex,
    markedBoxes,
    askedBoxes,
    pulsingBoxIds,
    askPulsingBoxIds,
    following,
    toggleFollowing,
    reading,
    toggleReading,
    explainFile,
    reach.note,
    relatedIds,
    relatedFiles,
    found,
    expanded,
    toggleExpanded,
    picked,
    mixedProject,
    data?.root,
    clusters,
    clustersFor,
    relayoutToken,
    componentsOn,
    foldersOn,
    arranged,
    foldedFolders,
    toggleFolded,
    markedFiles,
    diffSince,
    decide,
    editGroup,
    renameGroup,
    dragged,
    editingFrame,
    placements,
    resizeBox,
  ]);

  // A local placement is dropped only once the stored geometry says the same
  // thing — never on the clusters merely arriving. The list is refetched every
  // few seconds and after every groups.json write, and a blanket clear would
  // land mid-drag and snap the frame out from under the pointer, which is the
  // hiccup this whole placement exists to remove.
  useEffect(() => {
    setDragged((was) => {
      if (was.size === 0) return was;
      const next = new Map(was);
      for (const group of clusters) {
        const geometry = group.geometry;
        const held = next.get(`group:${group.id}`);
        if (!geometry || !held) continue;
        if (Math.abs(geometry.x - held.x) < 0.5 && Math.abs(geometry.y - held.y) < 0.5) {
          next.delete(`group:${group.id}`);
        }
      }
      return next.size === was.size ? was : next;
    });
  }, [clusters]);

  /**
   * A box just put back, shown when the layout's slot for it is off screen.
   *
   * `keepLayout` places an arriving box beside its most connected neighbour,
   * and on a wide diagram that is regularly outside the camera — measured:
   * `cert-snapshot.ts`, put back, landed at x 2440 with the camera looking at
   * 0–1500, and simply vanished. A box that disappears is not an answer to
   * "put this back". Only when it is off screen: panning for a box already in
   * front of you would move the whole diagram for nothing, which is the thing
   * the live-update rule spends its whole length avoiding.
   */
  useEffect(() => {
    if (putBack === null) return;
    setPutBack(null);
    const box = nodes.find((node) => node.id === putBack);
    const canvas = canvasRef.current?.getBoundingClientRect();
    if (box === undefined || canvas === undefined) return;
    const width = box.width ?? NODE_WIDTH;
    const height = box.height ?? 0;
    const view = flow.getViewport();
    const left = -view.x / view.zoom;
    const top = -view.y / view.zoom;
    const onScreen =
      box.position.x + width > left &&
      box.position.x < left + canvas.width / view.zoom &&
      box.position.y + height > top &&
      box.position.y < top + canvas.height / view.zoom;
    if (onScreen) return;
    // No `duration`, for the reason `step` gives where it moves the camera: a
    // transition this render interrupts never settles and the camera stays.
    void flow.setCenter(box.position.x + width / 2, box.position.y + height / 2, { zoom: view.zoom });
  }, [putBack, nodes, flow]);

  /** The box under the cursor. A ref, because a hover must not render. */
  const hoveredRef = useRef<string | null>(null);

  /**
   * Draw whole the lines that touch the hovered box, the inspected one and
   * every picked one; leave the rest at the quarter `.canvas-faint` gives
   * them. Straight to the DOM: the lines are React Flow's `<g>` elements,
   * each wearing the `edge-end-N` tokens of its two boxes, and one class
   * toggled on each is the entire cost — no state, no render, no layout.
   */
  const applyNear = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const tokens = new Set<string>();
    const mark = (id: string | null): void => {
      if (id === null) return;
      const index = boxIndex.get(id);
      if (index !== undefined) tokens.add(`edge-end-${index}`);
    };
    mark(hoveredRef.current);
    mark(selected);
    for (const id of picked) mark(id);
    for (const line of canvas.querySelectorAll<SVGGElement>('.react-flow__edge')) {
      let near = false;
      for (const token of tokens) {
        if (line.classList.contains(token)) {
          near = true;
          break;
        }
      }
      line.classList.toggle('edge-near', near);
    }
  }, [boxIndex, selected, picked]);

  const handleNodeEnter = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      // Neither kind of frame: both are drawn behind the boxes and cover most
      // of the canvas, so a hover on one is a hover on nothing in particular.
      // A folder that is shut is a box, and it hovers like one.
      if (node.type === 'frame' || (node.type === 'folder' && !node.data.folded)) return;
      hoveredRef.current = node.id;
      applyNear();
    },
    [applyNear],
  );

  const handleNodeLeave = useCallback(() => {
    hoveredRef.current = null;
    applyNear();
  }, [applyNear]);

  // Re-marked whenever the lines themselves change hands: a save rebuilds
  // them, a pan mounts the ones that scrolled in (`onlyRenderVisibleElements`
  // keeps the rest out of the DOM), and a fresh `<g>` wears no `edge-near`.
  // The observer watches for mounts; the toggles it triggers are attribute
  // changes, which it does not listen for, so it cannot feed itself.
  useEffect(() => {
    if (!faintOn) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;
    applyNear();
    const observer = new MutationObserver(applyNear);
    observer.observe(canvas, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [faintOn, applyNear, edges]);

  /**
   * Enter walks the matches, and takes the camera with it.
   *
   * Only Enter. Typing moves nothing: a find that panned on every keystroke
   * would be a navigation, and this one is a highlight — "show me where it
   * is" said without disturbing what is being looked at until it is asked
   * for. It is also why the camera keeps the zoom it was at: the reader chose
   * that, and a fit here would answer a question nobody asked.
   *
   * It wraps, the way an editor's find does, so ⇧Enter on the first match is
   * the last one rather than a dead key.
   */
  const stepFind = useCallback(
    (delta: number) => {
      const hits = found?.boxes ?? [];
      if (hits.length === 0) return;
      // Nothing stepped yet is −1, and it has to answer differently in each
      // direction: Enter means the first match and ⇧Enter means the last, so
      // the walk starts from just before the list going forwards and from the
      // top of it going back.
      const from = findAt < 0 ? (delta > 0 ? -1 : 0) : findAt;
      const next = (((from + delta) % hits.length) + hits.length) % hits.length;
      setFindAt(next);
      // On a list the step is a scroll, and the list does it for itself.
      if (listOn) return;
      const box = nodes.find((node) => node.id === hits[next]);
      if (box === undefined) return;
      // No `duration`, and that is not a taste. With one, React Flow runs the
      // move as a d3 transition on the pane, and the state update this handler
      // has already queued re-renders the flow underneath it: the transition
      // is interrupted before its first frame, its promise never settles, and
      // the camera stays exactly where it was. Measured — ⌘F, Enter, and the
      // viewport transform unchanged to the decimal, three presses running.
      // Without one it is the same arithmetic applied at once, which is how
      // `fitToScreen` above had to be written, for a cousin of this reason.
      void flow.setCenter(
        box.position.x + (box.width ?? NODE_WIDTH) / 2,
        box.position.y + (box.height ?? 0) / 2,
        { zoom: flow.getZoom() },
      );
    },
    [found, findAt, nodes, flow, listOn],
  );

  const navigate = useCallback((params: URLSearchParams) => {
    const query = params.toString();
    const next = query ? `?${query}` : '';
    window.history.pushState(null, '', next || window.location.pathname);
    setSearch(next);
  }, []);

  // Click inspects, double-click moves. A single click used to teleport the
  // view, which made every glance at a box a navigation you had to undo.
  /**
   * Right-click opens the menu, and left-click does not: a left click already
   * inspects a box, and taking that over would make every glance a decision.
   */
  const openContext = useCallback((event: MouseEvent, node: FlowNode | null) => {
    event.preventDefault();
    // A frame is a node too, and it covers most of the canvas. Falling through
    // to the pane menu rather than returning is what stops a right-click inside
    // a group from being a click that does nothing at all.
    const box = node !== null && (node.type === 'box' || node.type === 'component') ? node : null;
    if (box !== null) setSelected((current) => (current === box.id ? current : box.id));
    // The member row the click landed on, read off the row itself: the box
    // stamps `data-member-id` on each one, and React Flow hands this the box,
    // not the row. A right-click on the title, or on a folder, names none.
    const row = event.target instanceof Element ? event.target.closest('[data-member-id]') : null;
    const member = box !== null && box.type === 'box' ? (row?.getAttribute('data-member-id') ?? null) : null;
    setContextAt({ x: event.clientX, y: event.clientY, node: box?.id ?? null, member });
  }, []);

  const handleNodeClick = useCallback((_event: MouseEvent, node: FlowNode) => {
    // A folder is not a symbol and the panel has nothing to say about one:
    // its own gestures are the chevron, which folds it, and a double click,
    // which goes inside. A frame is behind the boxes and is not clicked at all.
    if (node.type === 'frame' || node.type === 'folder') return;
    setSelected(node.id);
    setShowSidebar(true);
  }, []);

  /**
   * Selection is the only node change this canvas has any use for: positions
   * come from the layout and nothing else about a box is editable here. It has
   * to be handled all the same — React Flow works out the changes and then
   * drops them when the nodes are controlled and nobody is listening, so
   * without this there is no selection to pick a group out of.
   */
  const handleNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    // Whatever is being dragged: keep where it is being put, or the controlled
    // canvas throws the position away. A frame sprang back under the pointer;
    // a box stood still through the whole gesture and teleported to the drop
    // point on release, which was measured and is what this fixes. The comment
    // that used to sit here claimed a box moves itself through React Flow's own
    // store — it does not, because the node list is controlled and React Flow
    // reports the change rather than applying it.
    const moves = changes.flatMap((change) =>
      change.type === 'position' && change.position !== undefined
        ? [{ id: change.id, position: change.position }]
        : [],
    );
    if (moves.length > 0) {
      setDragged((was) => {
        const next = new Map(was);
        for (const move of moves) next.set(move.id, move.position);
        return next;
      });
    }
    if (!changes.some((change) => change.type === 'select')) return;
    setPicked((was) => {
      const next = new Set(was);
      for (const change of changes) {
        if (change.type !== 'select') continue;
        if (change.selected) next.add(change.id);
        else next.delete(change.id);
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelected(null);
    setPicked(new Set());
    setCreating(false);
    // Escape ends the whole gesture, the question it raised included.
    setGroupConsent(null);
    setCreateRefusal(null);
  }, []);

  const goTo = useCallback(
    (target: string, kind: ViewNode['kind']) => {
      // A bundle stands for a pile of neighbours and is not a place in the
      // project: there is no scope to look inside and no file to focus on, so
      // a double click on one does nothing rather than navigating to an id
      // that names no path. Nor is a component: a category has no scope to
      // look inside — its files span directories — and no file to focus on,
      // so a double click on one is not bound at all, and this refuses the
      // id for the same reason should anything else hand it one.
      if (kind === 'bundle' || kind === 'component') return;
      const params = new URLSearchParams();
      if (kind === 'folder') {
        params.set('scope', target);
      } else {
        params.set('focus', target);
        if (depth !== 1) params.set('depth', String(depth));
      }
      const edges = edgeParam(showCalls, showAssoc, showDepends);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (hideTests) params.set('tests', '0');
      // Carried the way the breadcrumb carries it. Double-clicking a shut
      // folder is this arrangement's own gesture, and dropping the key on it
      // flattened the next scope — a click into a folder that quietly
      // un-folders the picture is answering a question nobody asked.
      if (foldersOn) params.set('folders', '1');
      if (at !== null) params.set('at', at);
      navigate(params);
    },
    [navigate, depth, showCalls, showAssoc, showDepends, onlyChanged, hideTests, foldersOn, at],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      // A shut folder is the same box the engine draws above the grouping
      // threshold, so it opens the same way: a double click looks inside it.
      // An open frame is not double-clicked — you are already inside it.
      if (node.type === 'folder') {
        if (node.data.folded) goTo(node.data.id, 'folder');
        return;
      }
      if (node.type !== 'box') return;
      goTo(node.id, node.data.kind);
    },
    [goTo],
  );

  /**
   * A row is a box. A click inspects it and makes it the selection, as a
   * click on a box does through React Flow; shift, ⌘ or ctrl adds it to the
   * picked rows instead, which is the canvas's own gesture — so "Create
   * category from selection" and the panel cannot tell a row from a box.
   */
  const handleRowSelect = useCallback((id: string, additive: boolean) => {
    setSelected(id);
    setShowSidebar(true);
    setPicked((was) => {
      if (!additive) return new Set([id]);
      const next = new Set(was);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /** The same menu a box gets, from a row; the ground's from the list's ground. */
  const handleRowContext = useCallback((event: MouseEvent, id: string | null) => {
    event.preventDefault();
    if (id !== null) setSelected((current) => (current === id ? current : id));
    setContextAt({ x: event.clientX, y: event.clientY, node: id, member: null });
  }, []);

  /**
   * Put one named file on the diagram and open it in the panel.
   *
   * Every filter is dropped on the way. This is what the status bar's count of
   * unparseable files leads to, and such a file can perfectly well be a test,
   * or be unchanged since the git base — so a jump that kept the filters would
   * answer "Nothing to show here", which is a worse dead end than the count it
   * was meant to open.
   */
  const openFile = useCallback(
    (path: string) => {
      const params = new URLSearchParams();
      params.set('focus', path);
      if (at !== null) params.set('at', at);
      navigate(params);
      setSelected(path);
    },
    [navigate, at],
  );

  const goToScope = useCallback(
    (scope: string) => {
      const params = new URLSearchParams();
      // The root too, as `?scope=`: the key is what says diagram now that a
      // bare URL is the front page. See `goHome` for the other answer.
      params.set('scope', scope);
      const edges = edgeParam(showCalls, showAssoc, showDepends);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (hideTests) params.set('tests', '0');
      // Carried the way the filters are: which arrangement the boxes are in is
      // an answer about how to read a directory, not about which one this is,
      // and a click into the next one that quietly flattened the picture would
      // be answering a question nobody asked. The engine refuses it again
      // wherever it does not apply, so carrying it is never a claim.
      if (foldersOn) params.set('folders', '1');
      if (at !== null) params.set('at', at);
      navigate(params);
    },
    [navigate, showCalls, showAssoc, showDepends, onlyChanged, hideTests, foldersOn, at],
  );

  const changeDepth = useCallback(
    (next: number) => {
      if (focus === null) return;
      const params = new URLSearchParams();
      params.set('focus', focus);
      if (next !== 1) params.set('depth', String(next));
      const edges = edgeParam(showCalls, showAssoc, showDepends);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (hideTests) params.set('tests', '0');
      if (at !== null) params.set('at', at);
      // The same place, one hop wider: a focus asked to be rows stays rows.
      // The helpers that go somewhere new — a scope, a file — drop `as` on
      // purpose: the override was about the slice it was made on, and a
      // person who drew 106 boxes anyway has not asked the next directory
      // to be drawn whatever its size.
      if (asked !== undefined) params.set('as', asked);
      navigate(params);
    },
    [focus, navigate, showCalls, showAssoc, showDepends, onlyChanged, hideTests, at, asked],
  );

  const handleSwitchProject = useCallback((root: string) => {
    // The server pushes a 'project' message on success, which is what clears the
    // URL and swaps the graph; this only has to start it and record the choice.
    setOpening(root);
    switchProject(root).then(
      (result) => {
        // Cleared here as well as on the 'project' message: the POST resolves
        // only once the new session has finished its boot scan, and a socket
        // that dropped in the meantime would otherwise leave "Opening…" up for
        // a project that is already on screen.
        setOpening(null);
        void rememberProject(result.root).catch(() => undefined);
      },
      (cause: unknown) => {
        setOpening(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, []);

  /** Built from the live URL so every other part of the view survives the flip. */
  const toggleEdgeKind = useCallback(
    (calls: boolean, associates: boolean, depends: boolean) => {
      const params = new URLSearchParams(window.location.search);
      const edges = edgeParam(calls, associates, depends);
      if (edges === null) params.delete('edges');
      else params.set('edges', edges);
      // The server reads `?calls=1` as well and adds it to whatever `edges=`
      // said, so a flag left in the URL would put back the kind just taken out.
      for (const kind of OPT_IN_EDGES) params.delete(kind);
      navigate(params);
    },
    [navigate],
  );

  const toggleCalls = useCallback(
    () => toggleEdgeKind(!showCalls, showAssoc, showDepends),
    [toggleEdgeKind, showCalls, showAssoc, showDepends],
  );
  const toggleAssoc = useCallback(
    () => toggleEdgeKind(showCalls, !showAssoc, showDepends),
    [toggleEdgeKind, showCalls, showAssoc, showDepends],
  );
  const toggleDepends = useCallback(
    () => toggleEdgeKind(showCalls, showAssoc, !showDepends),
    [toggleEdgeKind, showCalls, showAssoc, showDepends],
  );

  const toggleChanged = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('changed') === '1') params.delete('changed');
    else params.set('changed', '1');
    navigate(params);
  }, [navigate]);

  /**
   * The structural diff on and off. Built from the live URL so the commit,
   * the filters and the edge kinds survive, and the place — a scope, a
   * focus — is kept in the URL too: the engine draws the whole diff whatever
   * it says and echoes none of it, so turning the diff off lands back where
   * it was turned on. What it is against is `diffTarget`'s to say: the base
   * now, the commit's parent while frozen. The component diagram is dropped,
   * because a diff is boxes and lines and a URL naming both would describe
   * a picture that is not on screen.
   */
  const toggleDiff = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('diff')) {
      params.delete('diff');
    } else {
      if ('why' in diffTarget) return;
      params.set('diff', diffTarget.from);
      params.delete('diagram');
    }
    navigate(params);
  }, [navigate, diffTarget]);

  /**
   * Flip between the class diagram and the component diagram. Built from the
   * live URL so every filter, the edge kinds and the commit survive the flip;
   * scope, focus and depth do not, because a component diagram is the whole
   * project and a URL still naming a directory would describe a picture that
   * is not on screen. The way back lands at the root, and the crumb says so.
   */
  const setDiagram = useCallback(
    (components: boolean) => {
      const params = new URLSearchParams(window.location.search);
      // A category scope is a place too, and a component diagram is every
      // category at once: the engine drops it from the echo, so the URL does.
      for (const key of ['scope', 'focus', 'depth', 'category']) params.delete(key);
      if (components) params.set('diagram', 'components');
      else params.delete('diagram');
      navigate(params);
    },
    [navigate],
  );

  /**
   * A category as a scope: its files wherever they sit, the way `goToScope`
   * shows a directory's. "Show me the Data Pipeline" is the question the
   * categories exist to answer, and the crumb is where it is asked. Built
   * fresh like a scope, carrying the filters, the edge kinds and the commit,
   * and never `scope`: the engine ignores it under `category`, and a URL
   * naming both would describe a picture that is not on screen.
   */
  const goToCategory = useCallback(
    (storedId: string) => {
      const params = new URLSearchParams();
      params.set('category', storedId);
      const edges = edgeParam(showCalls, showAssoc, showDepends);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (hideTests) params.set('tests', '0');
      if (at !== null) params.set('at', at);
      navigate(params);
    },
    [navigate, showCalls, showAssoc, showDepends, onlyChanged, hideTests, at],
  );

  /**
   * The front page. The commit is kept — a page frozen at a commit stays
   * frozen — and every filter is dropped, because there is no diagram here
   * for one to filter; see `homeSearch`. Where the "root" crumb, Go › Whole
   * project and "Up one level" from a top-level directory all land.
   */
  const goHome = useCallback(() => navigate(new URLSearchParams(homeSearch(at))), [navigate, at]);

  /**
   * The root as a diagram, whatever its size — the one row that asks for the
   * big graph on purpose. `?scope=&as=diagram`, see `rootDiagramSearch`.
   */
  const drawRoot = useCallback(() => navigate(new URLSearchParams(rootDiagramSearch(at))), [navigate, at]);

  /** One level up the trail: a directory's parent, or the front page above the top ones. */
  const goUp = useCallback(
    (parent: string) => {
      if (parent === '') goHome();
      else goToScope(parent);
    },
    [goHome, goToScope],
  );

  /**
   * Only what differs from the base, as the root diagram under the
   * changes-only filter. Built fresh: the front page carries no filters to
   * keep, and `changed` is what the row asked for.
   */
  const goToChanges = useCallback(() => {
    const params = new URLSearchParams();
    params.set('changed', '1');
    navigate(params);
  }, [navigate]);

  /**
   * The Categories section, where a name is given: unfolded if it was
   * folded, and given the focus so the first row is one Tab away. Reached
   * the way a click reaches it — the fold is the section's own state, held
   * as a height once a sash has moved, and the chevron is the one control
   * that changes it either way.
   */
  const revealCategories = useCallback(() => {
    const title = document.querySelector<HTMLButtonElement>('.leftbar > .categories > .section-head > .section-title');
    if (title === null) return;
    if (title.getAttribute('aria-expanded') === 'false') title.click();
    title.focus();
  }, []);

  /**
   * Rows or boxes, said outright. Built from the live URL so the place, the
   * filters and the commit survive; only `as` changes. Written whichever way
   * the threshold would have gone, because the press is a person overriding
   * the count and the chip is where the override is read and taken off.
   */
  const setPresentation = useCallback(
    (as: Presentation) => {
      const params = new URLSearchParams(window.location.search);
      params.set('as', as);
      navigate(params);
    },
    [navigate],
  );

  /**
   * The folders as frames, or the flat arrangement. Built from the live URL so
   * the place, the filters and the commit all survive the flip: this is where
   * the boxes are put, not which boxes there are — the same reason it sits
   * beside `as` in the spec rather than beside `diagram`.
   *
   * The flat arrangement stays the default and the absent key is what says so.
   */
  const toggleFolders = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.has('folders')) params.delete('folders');
    else params.set('folders', '1');
    navigate(params);
  }, [navigate]);

  /** Let the count decide again. */
  const dropPresentation = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete('as');
    navigate(params);
  }, [navigate]);

  /**
   * Changing the base publishes a fresh view to every connected client, so a
   * live page needs nothing more. The refetch is for the one whose socket is
   * down: it would otherwise keep badging files against the base just left.
   */
  const changeBase = useCallback((base: string) => {
    setGitBase(base).then(
      () => setReloadToken((n) => n + 1),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  const handlePick = useCallback(
    (hit: SearchHit, inEditor: boolean) => {
      setSearchOpen(false);
      if (inEditor) {
        if (data) void openInEditor(data.root, hit.path, hit.line);
        return;
      }
      setSelected(hit.path);
      setShowSidebar(true);
      goTo(hit.path, 'file');
    },
    [data, goTo],
  );

  // Every shortcut the page has, in one listener, registered once. ⌘K is the
  // primary and ⌘P is the muscle memory, so the browser's print dialog has to
  // be told no; so does ⌘F, whose own find would search a DOM this page culls.
  // Escape is the long one, and the comment on its branch says why.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;

      // ⌘⇧P first, or ⌘⇧P would be read as ⌘P and open the wrong palette.
      // The letter is upper case while Shift is down, hence the fold.
      if (command && event.shiftKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        openCommands();
      } else if (command && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        openSearch();
      } else if (command && event.key === 'f') {
        // The browser's own find would search the DOM, which on this page is
        // whatever React Flow happens to have mounted — it culls everything
        // off screen, so the browser's answer would be a lie about the graph.
        event.preventDefault();
        openFind();
      } else if (command && event.key === 'b') {
        event.preventDefault();
        setShowSidebar((was) => !was);
      } else if (command && event.key === 'o') {
        event.preventDefault();
        openProjectRef.current?.();
      } else if (command && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitRef.current?.();
      } else if (command && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        relayoutRef.current?.();
      } else if (event.key === 'Escape') {
        // Escape closes one layer, the topmost, and stops there. See
        // `closeTopLayerRef` for what the layers are and why they are in that
        // order.
        //
        // Two of them say so before this listener runs. A menu and the find
        // bar take the key by preventing the default — a menu listens on
        // `document`, which bubbles before `window`, and the bar's handler is
        // React's, which runs earlier still.
        //
        // A palette says so by where the press came from, and it has to,
        // because by now the page cannot be asked. React flushes a discrete
        // event's state updates as soon as its own dispatch is over, which is
        // before this listener is reached at all: the palette has already
        // closed itself and re-rendered, so a layer stack read here would
        // report the state from *after* the press and go on to shut the find
        // bar underneath it. Measured: one ⎋ closed ⌘K and the find bar
        // together. The event still knows where it started.
        if (event.defaultPrevented) return;
        const target = event.target;
        const inside = target instanceof HTMLElement ? target : null;
        if (inside?.closest('.palette') != null) return;
        if (closeTopLayerRef.current?.() === true) return;

        clearSelection();
        // The lens, and not the list. `reading` survives on purpose: a keystroke
        // that means "stop dimming things" must not also empty a list the user
        // built deliberately and may already have paid to have explained.
        setFollowing(new Set());
        setShowWelcome(false);
        // A frozen view is the one state on the page that hides the present,
        // so the key that means "get me out of this" ends it too — unless the
        // key was meant for a field, where it cancels an edit, not a view.
        const inField = inside !== null && (inside.tagName === 'INPUT' || inside.tagName === 'TEXTAREA');
        if (!inField) backToNowRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openProjectRef = useRef<(() => void) | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const relayoutRef = useRef<(() => void) | null>(null);
  const backToNowRef = useRef<(() => void) | null>(null);
  const closeTopLayerRef = useRef<(() => boolean) | null>(null);
  const findableRef = useRef(false);

  /**
   * The two palettes are one layer, and only one of them is ever up. Both are
   * an input that swallows every keystroke, so two of them stacked is two
   * lists arguing over Enter — and there is no reading of ⌘K pressed inside
   * ⌘⇧P that means "keep both". Opening either closes the other, wherever it
   * is opened from, which is why nothing calls the setters directly.
   */
  const openSearch = useCallback(() => {
    setCommandsOpen(false);
    setSearchOpen(true);
  }, []);

  const openCommands = useCallback(() => {
    setSearchOpen(false);
    setCommandsOpen(true);
  }, []);

  /**
   * ⌘F. A search over what is drawn, and nothing else: it moves no camera on
   * its own, changes no view, and touches no URL, so opening it costs the
   * reader nothing to undo. Re-pressing it while it is open re-selects the
   * text rather than clearing it, which the bar does for itself.
   */
  const openFind = useCallback(() => {
    // Greyed in the menu bar and in the palette when there is nothing drawn,
    // so the shortcut must not be the one door left open onto a search that
    // can only ever answer "No results".
    if (findableRef.current !== true) return;
    // A palette is modal and paints over the bar. Focus was about to move into
    // something the reader cannot see, and every keystroke after it would have
    // gone to the wrong box.
    setSearchOpen(false);
    setCommandsOpen(false);
    setFindQuery((was) => was ?? '');
    setFindFocus((token) => token + 1);
  }, []);

  const closeFind = useCallback(() => {
    setFindQuery(null);
    setFindAt(-1);
  }, []);

  /** A different query is a different search, so the camera is nowhere in it yet. */
  const typeFind = useCallback((query: string) => {
    setFindQuery(query);
    setFindAt(-1);
  }, []);

  const openProject = useCallback(() => {
    void pickProject().then((picked) => {
      if (picked !== null) handleSwitchProject(picked);
    });
  }, [handleSwitchProject]);

  /**
   * Fit the camera to the diagram, now, rather than the next time the graph
   * changes.
   *
   * `flow.fitView()` does not move the camera itself. It raises
   * `fitViewQueued` and pushes a no-op onto React Flow's node queue, and the
   * fit only runs when `setNodes` next reaches the store — which in a fully
   * controlled flow means the `nodes` prop being rebuilt. This page rebuilds
   * it when the graph changes and `onNodesChange` only records a selection,
   * so nothing a menu item does gets there. Measured on ripgrep's
   * `crates/core`, zoomed out to 0.10 with the diagram spilling out of the
   * canvas on both sides: ⇧⌘F, the View menu item and React Flow's own fit
   * button each moved the camera 0px — and then it jumped to a fit on its own
   * the moment an unrelated file was saved, which is the worse half. A
   * command that does nothing is a bug; a command that does its work later,
   * on top of whatever the reader was looking at by then, is a surprise.
   *
   * `fitBounds` is the same arithmetic the queued fit would have done —
   * `getViewportForBounds` over the same nodes at the same padding — handed
   * straight to the pan/zoom, so it happens when it is asked for.
   */
  const fitToScreen = useCallback(() => {
    // Empty is the `viewMissing` case, where React Flow holds no nodes and the
    // bounds would be a point at the origin. The front page covers the root
    // view it stands on, and a camera moved under it is a surprise saved up
    // for the next diagram.
    if (nodes.length === 0 || frontOn) return;
    void flow.fitBounds(flow.getNodesBounds(nodes), { padding: 0.15 });
  }, [flow, nodes, frontOn]);

  // The key handler is registered once; these keep it pointed at the current
  // callbacks without tearing the listener down on every render.
  openProjectRef.current = openProject;
  fitRef.current = fitToScreen;
  /**
   * Place everything afresh. The only way, other than opening a view, to
   * make dagre run: every save since the first layout put its new boxes
   * beside their neighbours and moved nothing, and after enough of them the
   * diagram is worth tidying — on request, never on a save.
   *
   * It is also the way back out of an arrangement, so it drops every hand
   * placement in this view first. The whole view and not only the boxes on
   * screen: a placement is kept while a filter hides its box, so re-laying out
   * the drawn half would put the arrangement back the moment the filter came
   * off. The item says the number before it is pressed.
   */
  const relayout = useCallback(() => {
    setPlacements(dropView(placementRoot, placementKey));
    setRelayoutToken((n) => n + 1);
  }, [placementRoot, placementKey]);
  relayoutRef.current = relayout;

  /**
   * What Escape closes, and in what order. Three overlays and a page under
   * them, and until now no rule about which one a press belonged to: ⎋ with
   * ⌘K open both closed the palette *and* cleared the selection, stopped the
   * following and left a frozen view, all from one keystroke.
   *
   * The layers, topmost first:
   *
   *   1. A menu — the bar's drop, or the canvas's right-click menu. Each one
   *      already takes the key by preventing the default, and it listens on
   *      `document`, which bubbles before the `window` handler above.
   *   2. A palette — ⌘K or ⌘⇧P. They are one layer because only one of them
   *      is ever open: both are an input that swallows every keystroke, and
   *      two of those stacked is two lists arguing over Enter. Opening either
   *      closes the other.
   *   3. The flow overlay and the welcome screen. Above the find bar, because
   *      they paint over it: both cover the canvas at z-index 20 and the bar
   *      is 6, so closing the bar first would spend the press on something
   *      the reader cannot see. The two are never up together — opening a
   *      flow closes the welcome — so between them there is no order.
   *   4. The find bar. *Under* the palettes rather than above them, because
   *      it is the one overlay that is not modal — it has no backdrop, the
   *      canvas stays live behind it, and a palette opened and shut over it
   *      leaves it exactly where it was. That is VS Code's behaviour too.
   *   5. The page itself: the selection, the following lens, and a view
   *      frozen at a commit.
   *
   * Returning true means the press was spent here, and layer 5 never sees it.
   * Layers 1 to 4 each close themselves when the key was pressed inside them,
   * which is the usual case; this is what answers when the focus had wandered
   * off — a click on the canvas with the find bar still up, say — and the key
   * would otherwise fall straight through to the page.
   */
  closeTopLayerRef.current = () => {
    if (searchOpen) {
      setSearchOpen(false);
      return true;
    }
    if (commandsOpen) {
      setCommandsOpen(false);
      return true;
    }
    // Above the find bar, because they paint over it: `.flow` and `.welcome`
    // are z-index 20 and `.findbar` is 6, so closing the bar first spends the
    // press on something the reader cannot see and reads as ⎋ doing nothing.
    if (flowTarget !== null) {
      setFlowTarget(null);
      return true;
    }
    if (showWelcome) {
      setShowWelcome(false);
      return true;
    }
    if (findQuery !== null) {
      closeFind();
      return true;
    }
    return false;
  };

  /**
   * Whether there is anything to find in. Held in a ref because the ⌘F
   * listener is bound once and must not be rebound on every view.
   */
  // Not on the front page: the boxes it stands on are covered, and a find
  // that lit them would light nothing the reader can see.
  findableRef.current = view !== undefined && view.nodes.length > 0 && !frontOn;

  // --- the sashes ------------------------------------------------------------

  /**
   * How wide the bars are and how the sections divide them. `panes.ts` does the
   * arithmetic; this holds the answer and puts it on the page.
   *
   * The seed is whatever was stored, clamped against an estimated window; the
   * effect below measures the real one and clamps again before the first
   * paint, so a layout arranged on a wider screen arrives fitted rather than
   * off it.
   */
  const [viewport, setViewport] = useState<Viewport>(() => viewportOf(null));
  const [layout, setLayout] = useState<Layout>(() => loadLayout(viewportOf(null)));

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    const measure = () =>
      setViewport((was) => {
        const now = viewportOf(main);
        return was.width === now.width && was.barHeight === now.barHeight ? was : now;
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(main);
    return () => observer.disconnect();
  }, []);

  /**
   * What is drawn: the stored arrangement, fitted to the window it is being
   * drawn in. Derived and never written back — `layout` stays what the person
   * arranged, and this is what fits on the screen they have right now.
   *
   * It used to be an effect that clamped into state, and `fitWidths` only ever
   * shrinks: one moment in a 640px split view took both bars to their minimum
   * and widening the window never brought them back, because the clamped value
   * had become the arrangement. A window narrower than 300 + 330 + 320 is an
   * ordinary macOS split view, so that was not a corner.
   */
  const shown = useMemo(() => clampLayout(layout, viewport), [layout, viewport]);

  /**
   * The sizes on the page, as custom properties the stylesheet reads. A bar
   * nobody has touched has no properties at all: `stack === null` means the
   * shares in `styles.css` are still in charge, and writing pixels over them
   * would make a first run subtly not the run it has always been.
   */
  const applyPanes = useCallback((next: Layout, port: Viewport) => {
    const root = document.documentElement.style;
    root.setProperty('--pane-leftbar', `${next.width.leftbar}px`);
    root.setProperty('--pane-sidebar', `${next.width.sidebar}px`);
    for (const bar of BARS) {
      const ids = SECTIONS[bar];
      if (next.stack[bar] === null) {
        for (const id of ids) root.removeProperty(`--pane-${id}`);
        continue;
      }
      const sizes = stackOf(next, bar, port);
      ids.forEach((id, index) => root.setProperty(`--pane-${id}`, `${sizes[index]}px`));
    }
  }, []);

  useLayoutEffect(() => applyPanes(shown, viewport), [applyPanes, shown, viewport]);

  /**
   * The layout a drag is building, held in a ref and not in state on purpose.
   *
   * What runs on every pointer move is two `setProperty` calls. What runs at
   * the end of the gesture is one React render and one write to storage. The
   * reason is *mark, do not move*: a render here rebuilds the node and edge
   * arrays and re-enters the layout memo, and a person dragging a border has
   * asked for one region to be bigger, not for the diagram to be reshuffled
   * under it. So dagre never runs — every box keeps the position it was placed
   * at, and Re-layout (⇧⌘L) stays the only thing that moves them.
   *
   * What the canvas does instead is camera work, which is what it should be.
   * React Flow's own observer sees its container change size and re-culls for
   * `onlyRenderVisibleElements`; that is a question about where the viewport
   * is, not about where the boxes are. And the one input `layoutNodes` takes
   * from the window is its *height*, for folding a rank taller than the
   * screen — which no sash on this page changes: the bar sashes move a
   * vertical border, and the section sashes are inside a bar the canvas does
   * not share a row with.
   */
  const dragging = useRef<Layout | null>(null);

  const drag = useCallback(
    (next: Layout) => {
      dragging.current = next;
      applyPanes(next, viewport);
    },
    [applyPanes, viewport],
  );

  const commit = useCallback((next: Layout) => {
    dragging.current = null;
    setLayout(next);
    saveLayout(next);
  }, []);

  /**
   * The section heights as the page last drew them, refreshed after every
   * commit and read from a ref rather than measured during a render: this page
   * re-renders whenever the agent saves, and a forced reflow per section per
   * render is a real cost for a number that only changes when the window or
   * the content does. Once a bar's stack has been taken over the model is the
   * one deciding, and nothing here is measured for it again.
   */
  const [drawn, setDrawn] = useState<Record<BarId, number[]>>({ leftbar: [], sidebar: [] });
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (main === null) return;
    const measure = () =>
      setDrawn((was) => {
        const next: Record<BarId, number[]> = {
          leftbar: shown.stack.leftbar === null ? measureStack(main, 'leftbar') : [],
          sidebar: shown.stack.sidebar === null ? measureStack(main, 'sidebar') : [],
        };
        // Only when it actually moved. Measuring settles — a sash takes no room
        // in the stack it measures — so this stops after one extra pass rather
        // than turning every change into two.
        return BARS.every((bar) => sameSizes(was[bar], next[bar])) ? was : next;
      });
    measure();
    // Watched rather than measured on App's own render, because folding a
    // section with its chevron re-renders that Section and nothing else: the
    // sashes went on reporting the heights from before the fold, and the next
    // drag adopted them and silently re-opened what had just been folded.
    //
    // Two observers, because a fold is two different events. The size one sees
    // a section grow or shrink; the mutation one sees `.section-body` leave the
    // tree, which is how a fold is actually spelled — React removes the body
    // rather than sizing it to nothing, and a size observer on a node whose
    // child was removed does not always report before the next paint.
    const sizes = new ResizeObserver(measure);
    for (const bar of BARS) {
      const element = main.querySelector(`.${bar}`);
      if (!(element instanceof HTMLElement)) continue;
      sizes.observe(element);
      for (const section of element.children) sizes.observe(section);
    }
    const changes = new MutationObserver(measure);
    changes.observe(main, { childList: true, subtree: true });
    return () => {
      sizes.disconnect();
      changes.disconnect();
    };
  }, [shown.stack.leftbar, shown.stack.sidebar, showSidebar, data?.root]);

  /** What the sashes in a bar are dividing: the model's stack, or the drawn one. */
  const stackNow = useCallback(
    (bar: BarId): number[] => {
      const sizes = drawn[bar];
      if (shown.stack[bar] === null && stackApplies(bar, sizes.length)) return sizes;
      return stackOf(shown, bar, viewport);
    },
    [drawn, shown, viewport],
  );

  /**
   * Take a bar's stack over from the stylesheet, at the heights it is drawn
   * with. The first gesture on a sash in that bar does this, so the border
   * begins moving from under the cursor. With nothing measured there is
   * nothing to take over and the shares stand for one more gesture.
   */
  const adopt = useCallback(
    (bar: BarId): Layout => {
      const sizes = drawn[bar];
      if (shown.stack[bar] !== null || !stackApplies(bar, sizes.length)) return shown;
      return adoptStack(shown, bar, sizes, viewport);
    },
    [drawn, shown, viewport],
  );

  /** The sash between a bar and the canvas. */
  const barSash = (bar: BarId, governs: 'before' | 'after') => {
    // A bar the page is not drawing reserves nothing: hiding the panel with ⌘B
    // used to leave its width in the canvas's budget.
    const other = bar === 'leftbar' && !showSidebar ? 0 : shown.width[bar === 'leftbar' ? 'sidebar' : 'leftbar'];
    const port = showSidebar ? viewport : { ...viewport, hidden: 'sidebar' as const };
    const move = (requested: number) => resizeBar(dragging.current ?? shown, bar, requested, port);
    return (
      <Sash
        orientation="vertical"
        governs={governs}
        label={bar === 'leftbar' ? 'Left bar width' : 'Side bar width'}
        value={shown.width[bar]}
        // Zero, because that is a size this sash can actually reach: past its
        // minimum the bar closes rather than sticking, and the sash stays put
        // to drag it back out.
        min={0}
        max={Math.max(0, viewport.width - other - MIN_CANVAS)}
        onDrag={(requested) => drag(move(requested))}
        onCommit={(requested) => commit(move(requested))}
        onReset={() => commit(resetPane(shown, bar, port))}
      />
    );
  };

  /**
   * What a section needs to know about the sashes around it: whether it is
   * folded, how to fold it, and the sash on its own top edge. Handed down
   * through a context because the side bar builds its own two sections and
   * nothing outside can place an element between them.
   */
  const paneOf = useCallback(
    (className: string): SectionPane | null => {
      const id = SECTION_OF_CLASS[className];
      if (id === undefined) return null;
      const bar = barOf(id);
      const ids = SECTIONS[bar];
      const index = ids.indexOf(id);
      const stacked = shown.stack[bar] !== null;
      const sizes = stackNow(bar);
      const here = sizes[index];
      if (here === undefined) return null;

      const above = index - 1;
      const before = sizes[above];
      const previous = ids[above];
      const move = (requested: number) =>
        resizeSection(dragging.current ?? adopt(bar), bar, above, requested, viewport);
      return {
        // Until a sash in this bar has been touched the fold is still the
        // section's own, and the stylesheet's shares are what draw it.
        folded: stacked ? isFolded(here) : null,
        // The model's own fold, so the chevron and a sash shoved shut leave
        // the same stack — `panes.test.ts` says they do. A bar the stylesheet
        // still owns is left to the `:has([aria-expanded])` rules, which is
        // what it answers with an unchanged layout.
        setFolded: (folded) => {
          if (!stacked) return;
          commit(setFolded(shown, id, folded, viewport));
        },
        sash:
          before === undefined || previous === undefined ? null : (
            <Sash
              orientation="horizontal"
              // The sash names the section above it, which is the one whose
              // size it reports and the one it is felt to be moving.
              label={`${SECTION_TITLE[previous]} height`}
              value={before}
              min={SECTION_HEADER}
              max={before + here - SECTION_HEADER}
              // The stylesheet has to hand the stack over before a pointer move
              // can move anything: the sizes a drag writes are read by rules
              // that only apply once `main` says this bar is stacked, and that
              // class is React's. Without this the first drag in a bar wrote
              // pixels nothing was reading and moved nothing until release.
              onStart={() => {
                const taken = adopt(bar);
                dragging.current = taken;
                setLayout(taken);
              }}
              onDrag={(requested) => drag(move(requested))}
              onCommit={(requested) => commit(move(requested))}
              onReset={() => commit(resetPane(adopt(bar), previous, viewport))}
            />
          ),
      };
    },
    [adopt, commit, drag, shown, stackNow, viewport],
  );

  const setFilter = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(window.location.search);
      if (value === null) params.delete(key);
      else params.set(key, value);
      navigate(params);
    },
    [navigate],
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    for (const key of ['hide', 'only', 'kinds', 'since', 'changed', 'tests']) params.delete(key);
    navigate(params);
  }, [navigate]);

  /**
   * Freezing is a view, not a mode: the sha goes in the URL beside scope and
   * focus, so it is shareable, and the back button is one way out of it. Built
   * from the live URL so the scope, focus and edge kinds on screen survive —
   * the question is "how did *this* look then".
   */
  const viewCommit = useCallback(
    (sha: string) => {
      // The front page is live only — a commit's graph is served without the
      // facts its entry points are read from — so from there a commit opens as
      // that commit's whole-project diagram, the same place the front page's
      // own "Draw the whole project" row goes. Keeping `/` and setting `at`
      // landed on a refusal and one row.
      if (isFrontPage(window.location.search)) {
        navigate(new URLSearchParams(rootDiagramSearch(sha)));
        return;
      }
      const params = new URLSearchParams(window.location.search);
      // Two filters need a working tree — "changed" against the base, "since"
      // against the clock — and a commit has neither, so carrying them would
      // freeze an empty diagram and leave the chip to explain why.
      params.delete('changed');
      params.delete('since');
      params.set('at', sha);
      navigate(params);
    },
    [navigate],
  );
  const backToNow = useCallback(() => setFilter('at', null), [setFilter]);
  // Escape reaches this through the ref, like ⌘O does; null when there is
  // nothing to go back from, so the key does not push a no-op history entry.
  backToNowRef.current = frozen ? backToNow : null;

  /**
   * Whether a crumb is the one being stood on. A category's is, when the
   * view is that category's; a directory's is, when no category is and the
   * scope matches — the root crumb and a category crumb both say scope '',
   * and only one of them can be here.
   */
  const isHere = (step: ViewCrumb): boolean =>
    step.category !== undefined
      ? categoryScope === step.category
      : categoryScope === undefined && step.scope === view?.spec.scope;

  const groupOfSelection = useMemo(() => {
    if (selected === null) return null;
    // A component box is a category: the row it was drawn from is the answer,
    // and looking for its id among the members would find nothing.
    if (selectedBox?.kind === 'component') return categoryOf(selected);
    return clusters.find((group) => group.files.includes(selected)) ?? null;
    // `categoryOf` reads `clusters` and nothing else, and `clusters` is listed.
  }, [clusters, selected, selectedBox]);

  const goToMissed = useCallback(() => {
    const latest = missed.at(-1);
    if (latest === undefined) return;
    // Cleared, because it has now been looked at. It was not, and the badge
    // went on claiming a change was waiting somewhere else while the reader
    // was standing on it — a signpost pointing at the place you are is worse
    // than no signpost, because it hides the next real one behind a count
    // that never comes down.
    setMissed([]);
    const params = new URLSearchParams();
    params.set('focus', latest);
    navigate(params);
  }, [missed, navigate]);

  const params = new URLSearchParams(search);

  /**
   * One chip per active filter, each saying what it does and removing only
   * itself. A single "filtered" chip named the state without naming the cause,
   * so the only way to find out what had been narrowed was to clear everything
   * and watch what came back.
   */
  const activeFilters: { key: string; label: string; title?: string }[] = [
    params.has('changed') ? { key: 'changed', label: 'changes only' } : null,
    // The opt-in edge kinds are filters too — `edgeKinds` lives in the
    // filter — and read off the view's echo rather than the URL, because the
    // server also honours `?calls=1`. Each chip takes away its own kind.
    showCalls ? { key: 'calls', label: 'call edges', title: 'Stop drawing call edges' } : null,
    showAssoc ? { key: 'associates', label: 'associations', title: 'Stop drawing association edges' } : null,
    showDepends ? { key: 'depends', label: 'dependencies', title: 'Stop drawing dependency edges' } : null,
    params.get('only') ? { key: 'only', label: `only ${params.get('only') ?? ''}` } : null,
    params.get('hide') ? { key: 'hide', label: `hiding ${params.get('hide') ?? ''}` } : null,
    params.get('kinds')
      ? { key: 'kinds', label: (params.get('kinds') ?? '').split(',').join(' + ') }
      : null,
    params.get('since') ? { key: 'since', label: `last ${params.get('since') ?? ''}` } : null,
    // The count is the whole project's, from the view: the chip says what the
    // filter took away, not what this directory happens to hold.
    params.get('tests') === '0'
      ? { key: 'tests', label: `${view?.hiddenTests ?? 0} tests hidden` }
      : null,
  ].filter((chip): chip is { key: string; label: string; title?: string } => chip !== null);

  /**
   * Too many boxes for the page to be quick about, and one hop fewer is the
   * usual answer. The server is not the cost — it answered in milliseconds;
   * the page laying out and mounting 287 boxes is — so the chip lives on the
   * page and names the remedy rather than the symptom.
   */
  const manyBoxes =
    view !== undefined && focus !== null && depth > 1 && view.nodes.length > MANY_BOXES
      ? view.nodes.length
      : null;

  /**
   * How the slice is shown, when that is worth a chip: the threshold made a
   * list, or the URL overrode it either way. The click is the way out — draw
   * it anyway, or let the count decide again — the way every chip on this
   * row removes what it names.
   */
  const listChip = view === undefined ? null : presentationChip(asked, view.presentation, view.nodes.length, LIST_ABOVE);

  /**
   * What the diagram is a slice of, for saying so on the diagram.
   *
   * The page has always known this and only ever said it in the status bar and
   * three scrolls down the panel: focus on one of TanStack/query's files draws
   * 14 boxes out of 289 files, and every reader took the 14 for the answer.
   * The count of *files* rather than of boxes, because a box may stand for a
   * directory or for a pile of neighbours, and it is files the reader is
   * comparing against.
   *
   * Boxes standing for what the scope does not hold are left out: at a scope
   * they collapse the whole rest of the project into a handful of dimmed
   * folders, which would make the two numbers meet and the line disappear
   * exactly where it is most needed.
   */
  const slice = useMemo(() => {
    if (view === undefined) return null;
    const drawn = new Set<string>();
    for (const node of view.nodes) {
      if (node.external) continue;
      for (const file of node.files) drawn.add(file);
    }
    // The denominator is what this part of the project holds, and a file a
    // filter took off is still in it — so `tests=0` at the root read "82 of
    // 107" and blamed the scope for what the chip did. Hidden tests come back
    // out of the total, and the filter chips already say they are gone.
    const total = view.fileCount - view.hiddenTests;
    if (drawn.size === 0 || drawn.size >= total) return null;
    return { drawn: drawn.size, total };
  }, [view]);

  const isFiltered = activeFilters.length > 0;

  /**
   * "TypeScript 479 · JavaScript 31" — what the project turned out to be, in the
   * order that says which one it mostly is. Nobody declares a language when
   * opening a project: a real repository is several at once, so this reports
   * what was found instead of asking. Information, not a control, so it is not
   * a button.
   */
  const languageSummary = (view?.languages ?? [])
    .map((language) => `${language.label} ${language.files}`)
    .join(' · ');

  /**
   * Files in a language nothing here reads, said out loud rather than left to be
   * inferred from a thin diagram. That inference never happens: a graph missing
   * a fifth of its source does not look broken, it looks like code with no
   * coupling, which is exactly the picture this all exists to stop drawing.
   */
  const unreadable = languageReport?.unreadable ?? [];
  const unreadableFiles = unreadable.reduce((total, kind) => total + kind.files, 0);
  const unreadableDetail = unreadable.map((kind) => `${kind.files} ${kind.extension}`);
  /** One shape for the two places that say it: the status bar and the welcome. */
  const unreadableReport =
    unreadableFiles > 0
      ? { files: unreadableFiles, kinds: unreadableDetail, reads: languageReport?.reads ?? [] }
      : null;

  const dropFilter = (key: string) => {
    // An edge kind is one name inside `edges=`, not a key of its own.
    if (key === 'calls' || key === 'associates' || key === 'depends') {
      toggleEdgeKind(showCalls && key !== 'calls', showAssoc && key !== 'associates', showDepends && key !== 'depends');
      return;
    }
    const next = new URLSearchParams(window.location.search);
    next.delete(key);
    navigate(next);
  };

  /**
   * The commit on screen, as the chip names it: the short sha and roughly
   * when. The URL's sha rather than the view's, so the chip — and its way out —
   * is there while the commit is still loading, and when it turned out not to
   * exist and the view on screen is still the previous one.
   */
  const urlAt = params.get('at');
  const frozenCommit = log === null ? null : findCommit(log.commits, urlAt);
  const frozenLabel =
    urlAt === null
      ? ''
      : `Viewing ${urlAt.slice(0, 7)}${frozenCommit === null ? '' : ` · ${relativeTime(frozenCommit.at, Date.now())}`}`;
  const empty = view !== undefined && view.nodes.length === 0;
  /**
   * Nothing to draw is the moment to say what the app is for — unless a filter
   * is what emptied it. The welcome screen covers the viewport and only carries
   * a close button when it was opened deliberately, so showing it here buried
   * the menu bar and the "filtered" chip that were the only ways back out.
   */
  const emptyProject = empty && !isFiltered;

  /**
   * The section edits every group, including the ones whose frames the overlap
   * rule dropped. Passed as one object because it is one feature with one
   * caller, and nine more props on `Categories` would say less about it.
   */
  const groupEditor: GroupEditor = {
    selection,
    creating,
    onCreating: setCreating,
    onCreate: (name) => createGroup(name, selection.files),
    // Accepting a proposed grouping, and it is deliberately the same call: a
    // proposal a person accepts is a category that person drew, so it takes
    // the write that says so — `origin: 'manual'`, marked "by hand" wherever
    // it is shown. Nothing a model said reaches groups.json by any other way.
    onCreateFrom: (name, files) => createGroup(name, files),
    consent:
      groupConsent === null
        ? null
        : 'pending' in groupConsent
          ? { name: null, files: 0 }
          : { name: groupConsent.name, files: groupConsent.files.length },
    onAcceptStore: () => {
      if (groupConsent === null) return;
      if ('pending' in groupConsent) {
        const body = groupConsent.pending;
        setGroupConsent(null);
        editGroup({ ...(typeof body === 'object' && body !== null ? body : {}), createStore: true });
        return;
      }
      createGroup(groupConsent.name, groupConsent.files, true);
    },
    refusal: createRefusal,
    onRename: renameGroup,
    onColor: (group, color) => editGroup({ action: 'update', id: addressOf(group), color }),
    onMembers: (group, files) => editGroup({ action: 'update', id: addressOf(group), files }),
    // By stored id, because an orphan has no group to hand over — only the
    // entry in groups.json it came from, which is also what a delete removes.
    onDelete: (storedId) => editGroup({ action: 'delete', id: storedId }),
  };

  /**
   * The boxes with more symbols than a box draws, and whether any is open.
   * Read by the View menu and by the canvas menu, which offer the same command
   * — so it is computed once here rather than twice in two places that could
   * drift.
   */
  const expandable = (view?.nodes ?? [])
    .filter((node) => node.members.length > MAX_MEMBERS)
    .map((node) => node.id);
  const anyExpanded = expandable.some((id) => expanded.has(id));

  /**
   * The component diagram, as one item for every place it is offered — the
   * View menu, the canvas menu, a component box's own menu, and the palette
   * through the first — so they cannot disagree about its name or whether it
   * is on. Never greyed: with no categories the engine still draws one box
   * saying so, which is an answer.
   */
  const diagramItem: MenuItem = {
    label: 'Components',
    checked: componentsOn,
    run: () => setDiagram(!componentsOn),
  };
  /**
   * Rows or boxes, as one item for the View menu, the canvas menu and the
   * palette through the first. Checked when rows are on screen, whichever
   * decided it — the threshold or the URL; a press writes the other answer
   * into the URL outright, and the chip in the breadcrumb row is where an
   * override is read and taken off again.
   */
  const listItem: MenuItem = {
    label: 'Show as list',
    checked: listOn,
    ...(view === undefined
      ? { disabledBecause: 'Nothing is loaded yet' }
      : frontOn
        ? { disabledBecause: 'The front page is already a list — open a place on it first' }
        : diffOn && !listOn
          ? { disabledBecause: 'A diff is small by construction and is drawn; its rows are on the boxes' }
          : { run: () => setPresentation(listOn ? 'diagram' : 'list') }),
  };
  /**
   * The folder arrangement, as one item for the View menu, the canvas menu and
   * the palette through the first — so the three cannot disagree about its
   * name or whether it is on.
   *
   * Greyed with the reason wherever the engine refuses it, rather than left to
   * be pressed for nothing. Each reason is a measurement: a category spans
   * directories by definition (every one measured spans several, and the
   * lowest common ancestor folder of each of astrup's eleven is the project
   * root); above the grouping threshold the folder is already the box; a list
   * has no frames; and a focus is a neighbourhood rather than a place in the
   * tree, whose bundles stand for files from many folders at once.
   */
  const foldersItem: MenuItem = {
    label: 'Folders as frames',
    checked: foldersOn,
    ...(foldersOn
      ? { run: toggleFolders }
      : view === undefined
        ? { disabledBecause: 'Nothing is loaded yet' }
        : frontOn
          ? { disabledBecause: 'The front page is a list — open a place on it first' }
          : componentsOn
            ? { disabledBecause: 'A category is not in a folder — every one measured spans several' }
            : categoryScope !== undefined
              ? { disabledBecause: 'A category cuts across directories: that is what makes it one' }
              : view.spec.focus !== null
                ? { disabledBecause: "A focus draws one file's neighbours, wherever in the tree they live" }
                : listOn
                  ? { disabledBecause: 'Shown as a list — a list has rows, not frames' }
                  : view.grouped
                    ? {
                        disabledBecause:
                          'These boxes already stand for folders — open one to draw the files in it',
                      }
                    : { run: toggleFolders }),
  };
  /**
   * The structural diff, as one item for the View menu, the canvas menu and
   * the palette through the first: which symbols and lines differ from the
   * base — or from the commit's parent, while frozen — drawn as added boxes
   * and ghosts. Checked while the diagram is one; greyed with the reason
   * where nothing can be compared.
   */
  const diffItem: MenuItem = {
    label: 'Structural diff',
    checked: diffOn,
    ...(diffOn
      ? { run: toggleDiff }
      : 'why' in diffTarget
        ? { disabledBecause: diffTarget.why }
        : { run: toggleDiff }),
  };
  /**
   * What the camera and the layout cannot do to a list, or to the front
   * page. Greyed with the way out rather than left to run against a canvas
   * that is not there — or, on the front page, one that is covered.
   */
  const canvasBlocked = frontOn
    ? { disabledBecause: 'The front page is a list — "Draw the whole project" on it, or any row, opens a diagram' }
    : listOn
      ? { disabledBecause: 'Shown as a list — View › Show as list draws it' }
      : null;
  /**
   * Whether anything on screen could carry a has-a or a dependency line: a
   * file box listing a class or an interface, or a box standing for a pile —
   * a folder, a bundle, a component — whose classes it does not list and so
   * cannot be said to lack. Nothing loaded yet is not "no class" either.
   */
  const classifiersInView =
    view === undefined ||
    view.nodes.some(
      (node) =>
        node.kind !== 'file' ||
        node.members.some((member) => member.kind === 'class' || member.kind === 'interface'),
    );
  /**
   * The two class-diagram lines, each greyed with the reason when there is
   * no classifier to draw one from — unless it is already on, when the item
   * is the way back off. A field's declared type is the has-a UML exists to
   * show, and an import edge cannot say it: an import means this file
   * mentions that one. A dependency is weaker still: a type named only in a
   * signature, dashed with an open head.
   */
  const noClassifier = { disabledBecause: 'No class or interface in view to draw one from' };
  const assocItem: MenuItem = {
    label: 'Association edges (has-a)',
    checked: showAssoc,
    ...(showAssoc || classifiersInView ? { run: toggleAssoc } : noClassifier),
  };
  const dependsItem: MenuItem = {
    label: 'Dependency edges (named in a signature)',
    checked: showDepends,
    ...(showDepends || classifiersInView ? { run: toggleDepends } : noClassifier),
  };
  /**
   * Re-layout, in one place because three menus offer it and the count on it
   * must be the same number in all three.
   *
   * The label says what it drops before it is pressed. Nothing here is a
   * silent discard: dagre placing everything afresh is also every hand
   * placement in this view being thrown away, and a person who arranged
   * fourteen boxes deserves to read the fourteen rather than to find out.
   */
  const relayoutItem: MenuItem = {
    label:
      placements.size === 0
        ? 'Re-layout'
        : `Re-layout · drops ${placements.size} placed ${placements.size === 1 ? 'box' : 'boxes'}`,
    shortcut: '⇧⌘L',
    ...(canvasBlocked ??
      (view === undefined || view.nodes.length === 0
        ? { disabledBecause: 'Nothing on the canvas to lay out' }
        : { run: relayout })),
  };

  /**
   * One box back where the layout wants it, for the menu the box itself
   * opens. Greyed with the reason when the box has not been moved, which is
   * the rule every item here follows.
   */
  const putBackItem = (id: string): MenuItem => ({
    label: 'Put this box back',
    ...(placements.has(id)
      ? { run: () => unplaceBox(id) }
      : { disabledBecause: 'This box is where the layout put it' }),
  });

  /** A component is a category, not a place, and three items need to say so. */
  const selectedComponent = selectedBox?.kind === 'component';
  /**
   * Why "Create category from selection…" cannot run. On the component
   * diagram the reason is not that too few boxes are picked — a component is
   * never in the selection a category is drawn from, see `selection` — so the
   * usual sentence would send the reader shift-clicking boxes that do not count.
   */
  const createBlocked = componentsOn
    ? 'A category is drawn from files; pick boxes on the class diagram'
    : 'Shift-click two or more boxes first';

  const menus: Menu[] = [
    {
      title: 'File',
      items: [
        {
          label: 'Open folder…',
          shortcut: '⌘O',
          run: openProject,
          ...(isDesktop ? {} : { disabledBecause: 'The folder picker is only in the desktop app' }),
        },
        {
          label: hookInstalled === false ? 'Install Claude Code hook' : 'Claude Code hook installed',
          separatorBefore: true,
          ...(hookInstalled === false
            ? { run: () => void installHook().then(handleHookInstalled, () => undefined) }
            : { disabledBecause: 'Already installed for this project' }),
        },
        { label: 'Reload graph', run: () => setReloadToken((n) => n + 1) },
      ],
    },
    {
      title: 'Edit',
      items: [
        {
          label: 'Copy path',
          shortcut: '⌘C',
          ...(selected === null
            ? { disabledBecause: 'Nothing selected' }
            : selectedComponent
              ? { disabledBecause: 'A component has no path; its files are listed in the panel' }
              : { run: () => void navigator.clipboard.writeText(selected) }),
        },
        {
          label: 'Open in editor',
          ...(selected === null || data === null
            ? { disabledBecause: 'Nothing selected' }
            : selectedComponent
              ? { disabledBecause: 'A component is many files; pick one of them in the panel' }
              : { run: () => void openInEditor(data.root, selected, 1) }),
        },
        {
          label: 'Reject this category',
          separatorBefore: true,
          ...(groupOfSelection === null
            ? {
                disabledBecause:
                  selectedBox?.component?.uncategorised === true
                    ? 'These files are in no category'
                    : 'The selection is not in a category',
              }
            : { run: () => decide(groupOfSelection, groupOfSelection.name ?? '', 'rejected') }),
        },
        {
          // The same press as the lightbulb in the Categories section, and
          // greyed for the same reasons: it spends money, so a menu must not
          // offer it when the section would refuse it.
          label: 'Suggest category names',
          ...(suggestBlocked === null ? { run: suggest } : { disabledBecause: suggestBlocked }),
        },
      ],
    },
    {
      title: 'Selection',
      items: [
        {
          label: 'Focus the selection',
          ...(selected === null
            ? { disabledBecause: 'Nothing selected' }
            : selectedComponent
              ? { disabledBecause: 'A component is a category, not a place; focus one of its files from the panel' }
              : { run: () => goTo(selected, 'file') }),
        },
        {
          // The third way in, and the one the readers who found none went
          // looking through: three of seven walked every menu here before
          // concluding the feature did not exist. The cost is in the label
          // because a menu item carries a tooltip only while it is greyed —
          // and a press that spends must not be able to happen unannounced.
          label: 'Explain the selection — spends your Claude quota',
          ...(selectedFile === null
            ? {
                disabledBecause:
                  selected === null
                    ? 'Nothing selected'
                    : 'This box stands for many files; select one of them to explain it',
              }
            : { run: () => explainFile(selectedFile) }),
        },
        {
          label: 'Create category from selection…',
          separatorBefore: true,
          // The name is asked for in the Categories section, where the files
          // it would cover are listed: a category is worth seeing before it is
          // worth naming. The section unfolds itself for the form.
          ...(selection.boxes < 2
            ? { disabledBecause: createBlocked }
            : { run: () => setCreating(true) }),
        },
        { label: 'Clear selection', shortcut: '⎋', separatorBefore: true, run: clearSelection },
      ],
    },
    {
      title: 'View',
      items: [
        {
          // First, and in this menu rather than in Go, because it is where VS
          // Code keeps it and because it goes nowhere: it runs a thing. The
          // list it shows is built from this bar, so it can never offer an
          // action a menu does not.
          label: 'Command palette…',
          shortcut: '⇧⌘P',
          run: openCommands,
        },
        {
          label: 'Panel',
          shortcut: '⌘B',
          separatorBefore: true,
          checked: showSidebar,
          run: () => setShowSidebar((was) => !was),
        },
        {
          // Every pane at once. Double-clicking a sash does the one it is on;
          // this is the way back when several have been moved and the window
          // is no longer the window anybody meant to arrange.
          label: 'Reset layout',
          ...(isDefaultLayout(layout)
            ? { disabledBecause: 'Every panel is already at its default size' }
            : { run: () => commit(defaultLayout()) }),
        },
        // Which diagram, before what is drawn on it. A checked item, so the
        // palette offers "View: Components" for free.
        { ...diagramItem, separatorBefore: true },
        // And whether it is drawn at all, or listed: the same kind of fact.
        listItem,
        // And where the boxes are put: the folders drawn as frames around
        // them, or flat. A second arrangement of one diagram, so it sits with
        // the other things a view is rather than with the filters below.
        foldersItem,
        // And whether it is the diff: what came, went and moved since the
        // base, and nothing else. A checked item, so the palette offers it.
        diffItem,
        // The third diagram, of one function rather than of the project, and
        // the one place it can be typed: the palette is built from this bar.
        flowItem,
        { label: 'Call edges', separatorBefore: true, checked: showCalls, run: toggleCalls },
        assocItem,
        dependsItem,
        {
          label: 'Hide type-only files',
          separatorBefore: true,
          checked: params.get('kinds') === 'class,function',
          run: () => setFilter('kinds', params.get('kinds') === 'class,function' ? null : 'class,function'),
        },
        {
          label: 'Only changed in the last 10 minutes',
          checked: params.get('since') === '10m',
          // A commit's files are stamped with its time, so at a past commit
          // "recent" would mean "committed within ten minutes of now".
          ...(frozen
            ? { disabledBecause: 'A past commit has no last ten minutes' }
            : { run: () => setFilter('since', params.get('since') === '10m' ? null : '10m') }),
        },
        {
          label: 'Changes only',
          checked: onlyChanged,
          // Without git there is nothing to differ from, so the filter would
          // empty the diagram rather than narrow it. Likewise at a past commit,
          // which has no working tree to have changes in.
          ...(git === null
            ? { disabledBecause: 'This project is not a git work tree' }
            : frozen
              ? { disabledBecause: 'A past commit has no working-tree changes' }
              : { run: toggleChanged }),
        },
        {
          // Tests are still in the graph and still on screen by default; this
          // takes them off the canvas, and the status bar says how many.
          label: 'Hide tests',
          checked: hideTests,
          run: () => setFilter('tests', hideTests ? null : '0'),
        },
        { label: 'Clear filters', run: clearFilters },
        ...GIT_BASES.map(
          (base, index): MenuItem => ({
            label: base.menu,
            checked: git?.requested === base.value,
            ...(index === 0 ? { separatorBefore: true } : {}),
            ...(git === null
              ? { disabledBecause: 'This project is not a git work tree' }
              : { run: () => changeBase(base.value) }),
          }),
        ),
        { label: 'Zoom in', separatorBefore: true, ...(canvasBlocked ?? { run: () => void flow.zoomIn() }) },
        { label: 'Zoom out', ...(canvasBlocked ?? { run: () => void flow.zoomOut() }) },
        { label: 'Fit to screen', shortcut: '⇧⌘F', ...(canvasBlocked ?? { run: fitToScreen }) },
        // A save never moves a box, and neither does a hand placement; this is
        // the one thing that does, and it is asked for by name.
        relayoutItem,
        {
          // Here as well as on the canvas, and that is the point: a command
          // that lives only behind a right-click cannot be typed, and this
          // round exists so that everything can be.
          label: anyExpanded ? 'Collapse every box' : 'Expand every box',
          ...(canvasBlocked ??
            (expandable.length === 0
              ? { disabledBecause: `No box here holds more than ${MAX_MEMBERS} symbols` }
              : { run: () => setExpanded(anyExpanded ? new Set() : new Set(expandable)) })),
        },
        {
          label: 'Copy link to this view',
          separatorBefore: true,
          run: () => void navigator.clipboard.writeText(window.location.href),
        },
      ],
    },
    {
      title: 'Go',
      items: [
        { label: 'Find a file or symbol…', shortcut: '⌘K', run: openSearch },
        {
          // The other half of the pair, and the difference is the whole reason
          // both exist: ⌘K searches the project and takes you somewhere, this
          // searches what is drawn and takes you nowhere.
          label: 'Find in the diagram…',
          shortcut: '⌘F',
          ...(view === undefined || view.nodes.length === 0 || frontOn
            ? { disabledBecause: frontOn ? 'Nothing is drawn on the front page — ⌘K finds a file or symbol' : 'Nothing is drawn to find anything in' }
            : { run: openFind }),
        },
        { label: 'Back', shortcut: '⌘[', separatorBefore: true, run: () => window.history.back() },
        { label: 'Forward', shortcut: '⌘]', run: () => window.history.forward() },
        {
          label: 'Back to now',
          shortcut: '⎋',
          separatorBefore: true,
          ...(frozen
            ? { run: backToNow }
            : { disabledBecause: 'Already viewing the working tree — pick a commit in the Graph to go back' }),
        },
        // The front page is the whole project now — a list of what it is,
        // where it starts and what changed — and the diagram of it is the
        // row under, asked for by name because it is the big graph.
        {
          label: 'Whole project',
          separatorBefore: true,
          ...(frontOn ? { disabledBecause: 'Already on the front page' } : { run: goHome }),
        },
        { label: 'Draw the whole project', run: drawRoot },
        {
          label: 'Up one level',
          ...(view && view.trail.length > 1 && !frontOn
            ? { run: () => goUp(view.trail[view.trail.length - 2]?.scope ?? '') }
            : { disabledBecause: 'Already at the top' }),
        },
      ],
    },
    {
      title: 'Help',
      items: [
        { label: 'Keyboard shortcuts', run: () => setShowWelcome(true) },
        { label: 'What this is', run: () => setShowWelcome(true) },
      ],
    },
  ];

  /**
   * What the right-click menu offers, decided by what was under the cursor.
   *
   * Contextual rather than one fixed list: a menu that offers "open in editor"
   * over empty canvas has to grey half of itself out every time, and a menu that
   * is mostly grey teaches you to stop opening it.
   */
  const contextItems: MenuItem[] = (() => {
    const target = contextAt?.node ?? null;
    const box = target === null ? undefined : view?.nodes.find((node) => node.id === target);

    /**
     * A component box. Not the file menu greyed five times over — a menu
     * that is mostly grey teaches you to stop opening it — but what a category
     * can be asked: to be taken out of the architecture, and the way back to
     * the class diagram. Nothing here opens an editor or a scope, because a
     * category is neither a file nor a directory.
     */
    if (box !== undefined && box.kind === 'component') {
      const group = categoryOf(box.id);
      const none = box.component?.uncategorised === true;
      return [
        {
          label: group?.origin === 'manual' ? 'Delete this category' : 'Reject this category',
          ...(group === null
            ? { disabledBecause: none ? 'These files are in no category' : 'This category is not in the list on hand' }
            : group.origin === 'manual'
              ? { run: () => editGroup({ action: 'delete', id: addressOf(group) }) }
              : { run: () => decide(group, group.name ?? '', 'rejected') }),
        },
        { ...diagramItem, separatorBefore: true },
        { label: 'Fit to screen', shortcut: '⇧⌘F', run: fitToScreen },
        putBackItem(box.id),
        relayoutItem,
        {
          label: 'Copy link to this view',
          separatorBefore: true,
          run: () => void navigator.clipboard.writeText(window.location.href),
        },
      ];
    }

    if (box !== undefined) {
      // A bundle is a count of neighbours, not a place: its id names no path,
      // so nothing that takes one may run on it. Greyed with the reason, which
      // is the rule for every item here — an item that quietly did nothing
      // would be the decoration this menu does not have.
      const bundle = box.kind === 'bundle';
      // The row the click landed on, when it was a member row of a file box.
      // Its flow is the first item, because a right-click on a function is
      // about that function; on the title it is about the file, and this
      // row is left out rather than greyed as "no row here".
      const member =
        contextAt?.member === null || contextAt?.member === undefined || box.kind !== 'file'
          ? undefined
          : box.members.find((row) => row.id === contextAt.member);
      const flowOfMember: MenuItem[] =
        member === undefined
          ? []
          : [
              (() => {
                const why = flowBlockedBy(member.kind, box.language);
                return {
                  label: `Show control flow of ${member.name}`,
                  ...(why === null
                    ? { run: () => openFlow({ id: member.id, name: member.name, filePath: box.id }) }
                    : { disabledBecause: why }),
                };
              })(),
            ];
      return [
        ...flowOfMember,
        {
          label: box.kind === 'file' ? 'Go here' : 'Look inside',
          ...(bundle
            ? { disabledBecause: 'A bundle stands for many files and is not a place to go' }
            : { run: () => goTo(box.id, box.kind) }),
        },
        {
          label: 'Open in editor',
          ...(data === null || box.kind !== 'file'
            ? { disabledBecause: 'Only a file opens in an editor' }
            : { run: () => void openInEditor(data.root, box.id, 1) }),
        },
        {
          label: 'Copy path',
          shortcut: '⌘C',
          ...(bundle
            ? { disabledBecause: 'A bundle has no path of its own' }
            : { run: () => void navigator.clipboard.writeText(box.id) }),
        },
        {
          label: `Create category from selection…`,
          separatorBefore: true,
          ...(selection.boxes < 2
            ? { disabledBecause: createBlocked }
            : { run: () => setCreating(true) }),
        },
        {
          label: 'Only this folder',
          // The path a bundle would be asked for is `bundle:dependents:1`,
          // whose directory is the empty string — the root, silently, which is
          // the opposite of narrowing.
          ...(bundle
            ? { disabledBecause: 'A bundle is not in one folder' }
            : {
                run: () =>
                  goToScope(box.kind === 'folder' ? box.id : box.id.split('/').slice(0, -1).join('/')),
              }),
        },
        // Where a box goes is a fact about this box, so the way back to the
        // layout's answer for it is on this menu; the whole view's way back is
        // Re-layout, on the menu the canvas opens.
        { ...putBackItem(box.id), separatorBefore: true },
      ];
    }

    /**
     * Empty canvas. The menu the diagram itself offers, grouped the way the
     * View menu is: the selection, then how the drawing is laid out, then what
     * is drawn in it, then where you are, then the link to it.
     *
     * Every view control a person reaches for used to be somewhere else — the
     * View menu is three hundred pixels away from the thing being looked at,
     * and reaching it means leaving the diagram. Nothing here is new; it is
     * the same `MenuItem` the bar builds, so an item greyed there is greyed
     * here with the same words.
     *
     * Two blocks are present only in the state that gives them meaning: depth
     * needs a focus, "back to now" needs a freeze. That is not the greying
     * rule being dodged — a greyed item teaches you why an action cannot run
     * *here*, while "Depth 2" outside a focus names a control that does not
     * exist to be run. The other rule this obeys is length: a context menu
     * that scrolls is one nobody reads, so ⌘K and "Clear filters" moved out.
     * Both are already one press away on the row above the canvas — ⌘K is a
     * labelled button there, and every filter is a chip that removes itself.
     */
    return [
      {
        label:
          selection.boxes < 2
            ? 'Create category from selection…'
            : `Create category from ${selection.boxes} boxes…`,
        ...(selection.boxes < 2
          ? { disabledBecause: createBlocked }
          : { run: () => setCreating(true) }),
      },
      {
        label: 'Clear selection',
        shortcut: '⎋',
        ...(selection.boxes === 0
          ? { disabledBecause: 'Nothing selected' }
          : { run: clearSelection }),
      },
      {
        label: 'Fit to screen',
        shortcut: '⇧⌘F',
        separatorBefore: true,
        ...(canvasBlocked ?? { run: fitToScreen }),
      },
      relayoutItem,
      {
        // One item and not two, because "every box" is a state and not two
        // actions: with some boxes open and some shut, pressing it twice —
        // collapse, then expand — is what reaches "all of them open", and a
        // second greyed row would say less than that.
        label: anyExpanded ? 'Collapse every box' : 'Expand every box',
        ...(canvasBlocked ??
          (expandable.length === 0
            ? { disabledBecause: `No box here holds more than ${MAX_MEMBERS} symbols` }
            : { run: () => setExpanded(anyExpanded ? new Set() : new Set(expandable)) })),
      },
      { ...diagramItem, separatorBefore: true },
      listItem,
      // Where the boxes are put, on the menu the canvas opens: it is a
      // decision about the drawing being looked at, which is the whole reason
      // this menu exists.
      foldersItem,
      { label: 'Call edges', separatorBefore: true, checked: showCalls, run: toggleCalls },
      assocItem,
      dependsItem,
      {
        label: 'Changes only',
        checked: onlyChanged,
        ...(git === null
          ? { disabledBecause: 'This project is not a git work tree' }
          : frozen
            ? { disabledBecause: 'A past commit has no working-tree changes' }
            : { run: toggleChanged }),
      },
      diffItem,
      { label: 'Hide tests', checked: hideTests, run: () => setFilter('tests', hideTests ? null : '0') },
      // The breadcrumb's ± walks one hop at a time; this is the jump, and it
      // is on the canvas because deciding how far to look is something you do
      // while looking. Absent without a focus, where depth means nothing.
      ...(focus === null
        ? []
        : [1, 2, 3].map(
            (hops, index): MenuItem => ({
              label: `Depth ${hops}`,
              checked: depth === hops,
              ...(index === 0 ? { separatorBefore: true } : {}),
              ...(depth === hops
                ? { disabledBecause: `Already ${hops === 1 ? '1 hop' : `${hops} hops`} out` }
                : { run: () => changeDepth(hops) }),
            }),
          )),
      // A focus has no trail to walk up — it is a file and its neighbours, not
      // a place in the directory tree — so the row is left out there rather
      // than greyed, the same reading as the depth block above it. In a scope
      // it stays, greyed at the top, because there it is a real place to go
      // and being told you are already at it is the answer.
      ...(focus === null
        ? [
            {
              label: 'Up one level',
              separatorBefore: true,
              ...(view && view.trail.length > 1
                ? { run: () => goUp(view.trail[view.trail.length - 2]?.scope ?? '') }
                : { disabledBecause: 'Already at the top' }),
            },
          ]
        : []),
      { label: 'Whole project', ...(focus === null ? {} : { separatorBefore: true }), run: goHome },
      // Only while frozen, for the same reason as the depth block: with no
      // commit on screen there is no "now" to come back from.
      ...(frozen ? [{ label: 'Back to now', shortcut: '⎋', run: backToNow }] : []),
      {
        // The view is the URL — that is why scope, focus, depth and the commit
        // all live in it — so the link to what is on screen is the address bar,
        // and this is the one gesture that says so out loud.
        label: 'Copy link to this view',
        separatorBefore: true,
        run: () => void navigator.clipboard.writeText(window.location.href),
      },
    ];
  })();

  return (
    // `app-frozen` is the one hook for anything that has to read differently
    // while the diagram is a past commit's — the badges say now, the boxes then.
    <div className={frozen ? 'app app-frozen' : 'app'}>
      {/* The menu bar is the title bar, and the project is its title. What the
          project *is* — branch, connection, languages, who is looking — is
          status, and reads at the bottom of the page the way it does in an
          editor. */}
      <MenuBar
        menus={menus}
        trailing={<ProjectMenu root={data?.root ?? '…'} opening={opening} onSwitch={handleSwitchProject} />}
      />

      <nav className="breadcrumb">
        {focus === null ? (
          <span className="trail">
            {view?.trail.map((step, index) => (
              <span key={step.category ?? step.scope}>
                {index > 0 && <i className="codicon codicon-chevron-right sep" aria-hidden="true" />}
                {/* A category's crumb links by its stored id, never by path:
                    it is a scope by membership, and its `scope` is ''. The
                    root crumb is the one you stand on only when no category
                    is — both say scope '', and only one of them is here. */}
                {/* The root crumb is the front page: where the whole project
                    is read as a list. It is stood on only there, so from the
                    root diagram it is the way back. */}
                <button
                  type="button"
                  onClick={() =>
                    step.category !== undefined
                      ? goToCategory(step.category)
                      : step.scope === ''
                        ? goHome()
                        : goToScope(step.scope)
                  }
                  disabled={step.category === undefined && step.scope === '' ? frontOn : isHere(step)}
                  title={
                    step.category !== undefined
                      ? 'A category: its files wherever they sit, not a directory'
                      : step.scope === ''
                        ? 'The front page: what the project is, where it starts, what changed'
                        : undefined
                  }
                >
                  {step.category !== undefined && <i className="codicon codicon-package crumb-kind" aria-hidden="true" />}
                  {step.label}
                </button>
              </span>
            ))}
          </span>
        ) : (
          <span className="trail">
            <span className="focus-label">focus</span>
            <code>{focus}</code>
            <span className="depth">
              <button
                type="button"
                onClick={() => changeDepth(depth - 1)}
                disabled={depth <= 1}
                title="One hop fewer"
                aria-label="One hop fewer"
              >
                <i className="codicon codicon-remove" aria-hidden="true" />
              </button>
              <span>
                {depth} hop{depth === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => changeDepth(depth + 1)}
                disabled={depth >= MAX_DEPTH}
                title="One hop more"
                aria-label="One hop more"
              >
                <i className="codicon codicon-add" aria-hidden="true" />
              </button>
            </span>
            <button type="button" className="clear" onClick={() => goToScope('')}>
              clear
            </button>
          </span>
        )}

        {/* Which diagram. At the end of the trail because it is a fact about
            where you are: the component diagram is the whole project seen one
            level up, and pressing this from inside a directory goes there.
            Pressed, it is a mode and holds the accent, the way the Changes
            count does while its filter is on. */}
        {view !== undefined && (
          <button
            type="button"
            className="diagram-toggle"
            aria-pressed={componentsOn}
            onClick={() => setDiagram(!componentsOn)}
            title={
              componentsOn
                ? 'Back to the class diagram, at the root'
                : 'Draw the categories as components: what each provides, and the imports between them summed onto one line per pair'
            }
          >
            <i className="codicon codicon-package" aria-hidden="true" />
            Components
          </button>
        )}

        {/* What is being followed, and — the part that matters — whether the
            answer is "nothing uses this" or "nothing could be resolved". Those
            look identical on the diagram and mean opposite things. */}
        {following.size > 0 && (
          <button
            type="button"
            // The grey "nothing links to this" reading is a claim, and the
            // graph may only make it where it looked everywhere: a member's
            // zero is unknown, not none, and keeps the accent.
            className={
              reach.total === 0 && reach.settled && reach.partial === null
                ? 'symbol-chip symbol-chip-empty'
                : 'symbol-chip'
            }
            onClick={() => setFollowing(new Set())}
            // The chip has no room for prose, so the ≥ on its count is the
            // whole of what it can say on its face and the note has to be one
            // hover away. It is carried whatever the state: `tracked` is a
            // floor too, and the tooltip that said only "Click to stop
            // following" was sitting on the counts most likely to be believed.
            title={
              !reach.settled
                ? 'Looking up what these are connected to'
                : `${
                    reach.total === 0 && reach.partial === null
                      ? 'Nothing in this project references them by name, and nothing they reference resolved. '
                      : ''
                  }${reach.note === null ? '' : `${reach.note} `}Click to stop following.`
            }
          >
            {/* A ≥ on the count rather than the word "known" after it: the
                number is the thing that gets read at a glance and quoted
                afterwards, so the number is what has to say it is a floor.
                The graph's own sentence about why is in the title. */}
            {!reach.settled
              ? 'following…'
              : `${reach.label} — ${FLOOR}${reach.usedBy} in, ${reach.uses} out`}
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        )}

        {/* Too many boxes, and the way back. Only at depth: a scope above
            forty files is already drawn as directories. */}
        {manyBoxes !== null && (
          <button
            type="button"
            className="depth-chip"
            onClick={() => changeDepth(1)}
            title={`${manyBoxes} boxes take the page seconds to lay out and mount — the server answered at once. Click for depth 1.`}
          >
            <i className="codicon codicon-warning" aria-hidden="true" />
            {manyBoxes} boxes — depth 1 is quicker
          </button>
        )}

        {/* Rows rather than boxes, and why. The threshold's chip is badge
            grey like a filter — a list is not a fault — and its click draws
            the diagram anyway; a diagram forced past the threshold wears the
            warning the flow overlay wears for a big flow, because that one
            is the page telling on itself, and its ✕ takes the override off. */}
        {listChip !== null && (
          <button
            type="button"
            className={listChip.warning ? 'depth-chip' : 'filter-chip'}
            onClick={() => (listChip.action === 'draw' ? setPresentation('diagram') : dropPresentation())}
            title={listChip.title}
          >
            <i className={`codicon codicon-${listChip.warning ? 'warning' : 'list-flat'}`} aria-hidden="true" />
            {listChip.label}
            {listChip.action === 'drop' && <i className="codicon codicon-close" aria-hidden="true" />}
          </button>
        )}

        {/* Which commit is drawn, and the way back. A chip like the filters
            because it narrows the same way — everything else in the row still
            applies, just to the project as it was then. */}
        {urlAt !== null && (
          <button
            type="button"
            className="frozen-chip"
            onClick={backToNow}
            title={`The diagram is the project as of commit ${urlAt}${
              frozenCommit === null ? '' : ` — ${frozenCommit.subject}`
            }. Click to go back to now (⎋)`}
          >
            <i className="codicon codicon-history" aria-hidden="true" />
            {frozenLabel}
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        )}

        {/* Which diff is drawn, and the way back. The URL's key rather than
            the view's, like the commit above, so the chip is there while the
            diff is still being built and when it was refused. */}
        {params.has('diff') && (
          <button
            type="button"
            className="diff-chip"
            onClick={toggleDiff}
            title={`Only what differs in the shape since ${
              params.get('diff') === 'base' ? baseLabel || 'the base' : shortSha(params.get('diff') ?? '')
            }: added boxes, ghosts for what was removed, changed lines. A file whose declarations and references did not move is not drawn. Click to leave the diff`}
          >
            <i className="codicon codicon-git-compare" aria-hidden="true" />
            Structural diff since {params.get('diff') === 'base' ? baseLabel || 'base' : shortSha(params.get('diff') ?? '')}
            <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        )}

        {activeFilters.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="filter-chip"
            onClick={() => dropFilter(chip.key)}
            title={chip.title ?? `Stop filtering by ${chip.label}`}
          >
            {chip.label} <i className="codicon codicon-close" aria-hidden="true" />
          </button>
        ))}

        {activeFilters.length > 1 && (
          <button type="button" className="filter-clear" onClick={clearFilters} title="Clear every filter">
            clear all
          </button>
        )}

        {/* Not while frozen: the badge counts what is happening now, and
            clicking it goes to now — it would be the one link on the row that
            silently left the commit. It is back the moment the freeze ends. */}
        {missed.length > 0 && !frozen && (
          <button
            type="button"
            className="missed"
            // What is out there, by name, and who wrote it. The badge is the
            // one arrow to work happening off the diagram, and a bare count
            // says only that some exists — which is exactly the "nothing
            // appeared" complaint one step removed. The minimap is the other
            // arrow, and it is for work inside the diagram but off screen.
            title={`Not on this diagram — the most recent is focused on a click:\n${missed
              .slice(-12)
              .reverse()
              .map((file) => {
                const mark = markedFiles.get(file);
                return `· ${file}${mark === undefined ? '' : ` — ${mark.title}`}`;
              })
              .join('\n')}${missed.length > 12 ? `\n· …and ${missed.length - 12} more` : ''}`}
            onClick={goToMissed}
          >
            {missed.length} change{missed.length === 1 ? '' : 's'} outside
          </button>
        )}

        <button
          type="button"
          className="search-open"
          onClick={openSearch}
          title="Find a file or symbol (⌘K)"
        >
          Search <kbd>⌘K</kbd>
        </button>

        <button
          type="button"
          className="panel-toggle"
          onClick={() => setShowSidebar((was) => !was)}
          title={showSidebar ? 'Hide panel (⌘B)' : 'Show panel (⌘B)'}
          aria-label={showSidebar ? 'Hide panel' : 'Show panel'}
        >
          <i
            className={
              showSidebar
                ? 'codicon codicon-layout-sidebar-right'
                : 'codicon codicon-layout-sidebar-right-off'
            }
            aria-hidden="true"
          />
        </button>
      </nav>

      {searchOpen && <SearchPalette at={at} onPick={handlePick} onClose={() => setSearchOpen(false)} />}

      {/* The other palette. It is handed the bar itself rather than a list
          built for it, so an action cannot exist in one and not the other. */}
      {commandsOpen && <CommandPalette menus={menus} onClose={() => setCommandsOpen(false)} />}

      {contextAt !== null && (
        <ContextMenu
          x={contextAt.x}
          y={contextAt.y}
          items={contextItems}
          onClose={() => setContextAt(null)}
        />
      )}


      <main
        ref={mainRef}
        // Which bars have had a sash dragged. While a bar is absent from this
        // list the shares in styles.css still draw its sections; once it is
        // here the stack is the model's, in pixels.
        className={[
          shown.stack.leftbar === null ? '' : 'stacked-leftbar',
          shown.stack.sidebar === null ? '' : 'stacked-sidebar',
        ]
          .filter((name) => name !== '')
          .join(' ')}
      >
        <SectionPanes.Provider value={paneOf}>
        {/* Left is time, right is structure: what the repository is and what
            the agent is doing to it, beside what you are looking at. They were
            one panel, which meant watching the agent cost you the detail of
            the thing it was touching.

            Everything in this column describes NOW. The Changes list is the
            working tree's, the Activity table is this session's, and neither
            changes because the diagram is showing a past commit: that is what
            the frozen chip in the breadcrumb row is for, and the Graph's
            selected row is the one place the column says which commit. */}
        {data !== null && (
          <aside className={frozen ? 'leftbar leftbar-frozen' : 'leftbar'}>
            {repo !== null && (
              <Repository
                repo={repo}
                // None on the front page: the root view under it is covered,
                // and "On screen 12" beside a list was the covered count.
                boxes={frontOn ? 0 : (view?.nodes.length ?? 0)}
                // The commit's own count: /api/repo counts the working tree,
                // and "Files 1128" beside a frozen "712 files" was that.
                frozen={view !== undefined && view.at !== null ? { at: view.at, files: view.fileCount } : null}
                onSwitchProject={handleSwitchProject}
                onFetched={handleFetched}
                onHookInstalled={handleHookInstalled}
              />
            )}
            <SourceControl
              git={gitLines}
              base={git?.requested ?? null}
              onChangeBase={changeBase}
              onlyChanged={onlyChanged}
              onToggleChanged={toggleChanged}
              diff={diffRowNow}
              diffOn={diffOn}
              onToggleDiff={toggleDiff}
              log={log}
              at={at}
              onViewCommit={viewCommit}
              onBackToNow={backToNow}
              onSelect={setSelected}
              onFocus={goTo}
            />
            {/* The architecture, on the same footing as the repository and its
                history. Names are the user's; the lightbulb only asks for
                guesses, and a guess stays on this page until accepted. */}
            <Categories
              groups={clusters}
              orphans={orphans}
              onDecide={decide}
              groupEditor={groupEditor}
              onSelect={setSelected}
              suggestBlocked={suggestBlocked}
              // A commit's cluster can share an id with today's, and an Accept
              // under it would write the commit's file list. The lightbulb is
              // already greyed while frozen; the rows follow it.
              suggestions={frozen ? NO_SUGGESTIONS : suggestions}
              suggesting={suggesting}
              suggestError={suggestError}
              lastRun={suggestCost}
              onSuggest={suggest}
              onDismissSuggestion={dismissSuggestion}
              // A box or a row to shift-click: not on the front page, not
              // under a URL the server refused, not over nothing.
              boxesOnScreen={!frontOn && !viewMissing && !empty}
              onDrawAll={drawRoot}
              fileCount={view?.fileCount ?? 0}
            />
            {/* Detail, at the bottom of this column and no longer in the
                right bar. Everything above it is something you go and look at
                — the repository, its history, its parts — and so is this. What
                the right bar holds now is what is happening, which is the
                thing you glance at rather than open. */}
            <DetailPanel
              root={data.root}
              selected={selected}
              bundle={
                selected === null
                  ? null
                  : (() => {
                      const box = view?.nodes.find((node) => node.id === selected);
                      return box === undefined || box.kind !== 'bundle'
                        ? null
                        : { label: box.label, files: box.files, of: bundleDirection(box.id) };
                    })()
              }
              component={componentSelection}
              revision={revision}
              at={ghostAt ?? at}
              ghost={ghostAt !== null}
              onSelect={setSelected}
              onFocus={goTo}
              symbolIds={selectedSymbolIds}
              onExplainSymbol={explainSymbol}
              onExplainFile={explainFile}
              onFlow={openFlow}
              flowBlocked={flowBlocked}
              onOpenSymbol={setPanelSymbol}
            />
          </aside>
        )}
        {/* The border between the left bar and the canvas, and the one on the
            other side. Both stand where they always did; what is new is that
            they can be taken hold of. */}
        {data !== null && barSash('leftbar', 'before')}

        {/* `canvas-faint` is what draws every line at a quarter; the lines a
            hover or the selection draws whole wear `edge-near`, toggled on
            them directly by `applyNear`. */}
        <div className={faintOn ? 'canvas canvas-faint' : 'canvas'} ref={canvasRef}>
        {/* On the canvas and not over the window, the way the welcome screen
            is: it marks what is drawn, so it belongs to the region that draws
            it, and the chrome around it stays reachable while it is up. */}
        {findQuery !== null && (
          <FindBar
            query={findQuery}
            onQuery={typeFind}
            matches={found?.boxes.length ?? 0}
            current={findAt}
            onStep={stepFind}
            onClose={closeFind}
            focusToken={findFocus}
          />
        )}
        {/* Over the canvas, like the welcome: the chrome stays reachable. */}
        {flowTarget !== null && data !== null && (
          <Flow
            target={flowTarget}
            root={data.root}
            at={at}
            revision={revision}
            onClose={() => setFlowTarget(null)}
          />
        )}
        {(showWelcome || emptyProject) && (
          <Welcome
            onOpen={(path) => {
              setShowWelcome(false);
              handleSwitchProject(path);
            }}
            onSearch={() => {
              setShowWelcome(false);
              openSearch();
            }}
            onClose={showWelcome ? () => setShowWelcome(false) : null}
            unreadable={unreadableReport}
            empty={emptyProject}
            reads={languageReport?.reads ?? []}
            opening={opening}
          />
        )}
        {/* The front page, over the root view it stands on and under the
            welcome, so Help still opens on top of it. Not for an empty
            project — the welcome is what that shows — and not under a URL the
            server refused, where the banner is the answer. A page fetched for
            the project just left is not shown for this one. */}
        {frontOn && !emptyProject && !viewMissing && data !== null && (
          <Overview
            overview={overview !== null && overview.root === data.root ? overview : null}
            error={overviewError}
            at={urlAt}
            rootBoxes={
              view !== undefined && focus === null && categoryScope === undefined && !componentsOn && view.spec.scope === ''
                ? view.nodes.length
                : null
            }
            baseLabel={baseLabel}
            marks={markedFiles}
            asked={askedFiles}
            pulsing={pulsingFiles}
            pulsingAsk={queriedFiles}
            onFocus={(file) => goTo(file, 'file')}
            inGraph={(path) => viewFiles.has(path)}
            onCategory={goToCategory}
            onCategories={revealCategories}
            onChanges={goToChanges}
            diff={diffRowNow}
            onDiff={toggleDiff}
            onDrawAll={drawRoot}
          />
        )}
        {error !== null && <div className="error">{error}</div>}
        {error === null && view?.nodes.length === 0 && !frontOn && (
          <div className="empty">Nothing to show here.</div>
        )}
        {/* Rows where the engine said rows: the same footprint as the canvas,
            no minimap and no controls, because there is no camera. Blank
            under a URL the server refused, for the reason the canvas is. */}
        {listOn && !viewMissing && view !== undefined ? (
          <ListView
            view={view}
            viewKey={viewKey}
            selected={selected}
            picked={picked}
            marks={markedBoxes}
            asked={askedBoxes}
            pulsing={pulsingBoxIds}
            pulsingAsk={askPulsingBoxIds}
            aside={asideIds}
            asideNote={found === null ? reach.note : null}
            showLanguage={mixedProject}
            reveal={found !== null && findAt >= 0 ? (found.boxes[findAt] ?? null) : null}
            slice={slice}
            onSelect={handleRowSelect}
            onOpen={goTo}
            onContextMenu={handleRowContext}
          />
        ) : (
        <ReactFlow<FlowNode, Edge>
          // Keyed on the LOADED view, not on the URL. Keying on the URL remounts
          // the instant a link is clicked, while `nodes` still holds the previous
          // slice, so fitView fits the old graph and the new one arrives with no
          // refit at all. A live update keeps the same spec, so the camera holds.
          key={viewKey}
          // Blank under a URL the server refused: the previous graph drawn
          // there would be the root view under another name, which is the
          // silent fallback the 404 exists to stop.
          nodes={viewMissing ? [] : nodes}
          edges={viewMissing ? [] : edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onPaneContextMenu={(event) => openContext(event as MouseEvent, null)}
          onNodeContextMenu={openContext}
          onNodeDragStop={handleNodeDragStop}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          // The faint lines: a hover marks the lines it touches and renders
          // nothing. Bound whatever the view, and inert outside a scope
          // diagram, where `applyNear` finds no `.canvas-faint` to act under.
          onNodeMouseEnter={handleNodeEnter}
          onNodeMouseLeave={handleNodeLeave}
          onNodesChange={handleNodesChange}
          // Shift is both halves of the gesture: shift-click adds a box, and
          // shift-drag rubber-bands over several. ⌘ and Ctrl keep adding one
          // too — React Flow starts the rubber band on the first pixel of a
          // shift-drag, so a shift-click that twitches lands as an empty
          // marquee, and the modifier every other canvas uses does not.
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          // Boxes move by hand, and a placement is kept — see `placement.ts`.
          // Frames say `draggable` for themselves and are unaffected; a box is
          // dragged by its title bar, which is `dragHandle` on the node.
          nodesDraggable
          nodesConnectable={false}
          // Off, or d3-zoom handles the double click on the pane and stops it
          // bubbling before React sees it — onNodeDoubleClick then never fires
          // and the view silently zooms instead of navigating.
          zoomOnDoubleClick={false}
          // Only what is on screen is in the DOM. A diagram is read zoomed in
          // — at the zoom that fits query's 127 `packages` boxes nothing can be
          // read at all — and off screen a box still costs a mount, a re-render
          // on every save and its share of the heap. Measured on that view: 127
          // node elements and 214 edge elements at every zoom, 2 161 elements
          // inside the flow viewport, against 28 and 107 and 824 at the zoom a
          // box can be read at. Every box and every frame carries an explicit
          // width and height, which is what the cull rectangle is computed
          // from; a node sized only by what it renders would be culled against
          // a rectangle of nothing.
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          maxZoom={2}
        >
          <Background gap={22} size={1} />
          {/* The fit button runs `fitToScreen` as well as React Flow's own
              queued fit, because on its own it is the same no-op the menu item
              was: measured on ripgrep's `crates/core`, zoomed out to 0.09, this
              button moved the camera 0px. React Flow calls both, and once ours
              has fitted, the queued one lands on the same place. */}
          <Controls showInteractive={false} onFitView={fitToScreen} />
          <MiniMap
            pannable
            zoomable
            // Where the heat is. This is the answer to "the agent is working
            // off screen and I have no arrow to it": the minimap is already
            // here, already pannable, and a click on it already moves the
            // camera — it only needed to be told what just happened. A second
            // mechanism beside it would be one more thing to find.
            //
            // A frame is the size of everything it encloses, so in the minimap it
            // would be a solid block over the boxes it is meant to sit behind.
            // A token, not a hex: React Flow paints this as an inline fill, so
            // the page's own rule for minimap nodes cannot reach it.
            nodeColor={(node) =>
              // Both kinds of frame, and for the same reason. A folder that is
              // shut is a box and is drawn as one.
              node.type === 'frame' || (node.type === 'folder' && !node.data.folded)
                ? 'transparent'
                : markedBoxes.has(node.id)
                  ? 'var(--vsc-git-modified)'
                  : askedBoxes.has(node.id)
                    ? 'var(--vsc-info)'
                    : 'var(--vsc-border-input)'
            }
            // …and a click on it goes there. `pannable` alone only moves the
            // camera by dragging the viewport rectangle, so the heat could be
            // seen and not reached — which is half an arrow. The camera moving
            // here does not break "mark, do not move": a click is a person
            // asking, and the zoom they chose is kept, exactly as ⌘F's step
            // does it.
            onNodeClick={(_, node) => {
              void flow.setCenter(
                node.position.x + (node.width ?? NODE_WIDTH) / 2,
                node.position.y + (node.height ?? 0) / 2,
                { zoom: flow.getZoom() },
              );
            }}
          />
        </ReactFlow>
        )}

        {/* The bottom line, on the canvas.

            It said the same thing in the status bar and in the panel, and in
            both places it was read after the diagram had already been believed.
            A reader who focuses one file and counts fourteen boxes concludes
            that fourteen things touch it; the honest sentence — fourteen of two
            hundred and eighty-nine files, and a floor at that — was three
            scrolls away under a list of fifty-one symbols.

            Information, not a control: it is the diagram's caption, and it sits
            on the canvas the way a box's own badges do. Everything that acts on
            the slice is a chip in the breadcrumb row above it. */}
        {slice !== null && !showWelcome && !emptyProject && !listOn && !frontOn && !diffOn && (
          <div
            className="canvas-slice"
            title={
              focus === null
                ? `The diagram draws the ${slice.drawn} files in this part of the project. It has ${slice.total}; the rest are not on it.`
                : `The diagram draws the ${slice.drawn} of this project's ${slice.total} files that the graph could follow within ${
                    depth === 1 ? '1 hop' : `${depth} hops`
                  } of ${focus}. It is a floor, not a census: a reference the graph could not follow is not drawn, and there is no line to nothing.`
            }
          >
            {/* The ≥ only where the number is a claim about what relates to
                something. A scope draws the files a directory holds, and that
                is a complete answer to the question it was asked. */}
            {focus === null ? '' : FLOOR}
            {slice.drawn} of {slice.total} files
          </div>
        )}
        </div>

        {showSidebar && data !== null && barSash('sidebar', 'after')}
        {showSidebar && data !== null && (
          <Sidebar
            following={{
              links: reach.found,
              gone: reach.gone,
              // The reading list reaches the panel as its own field, so nothing
              // there has to work out from the string which of the two kinds of
              // id it is holding.
              files: readingFiles,
              settled: reach.settled,
              explanations,
              running: run?.state === 'running',
              // Only the ids this run asked about; the rest of the section is
              // not waiting on anything.
              runningIds: new Set(run?.state === 'running' ? run.ids : []),
              lastRun,
              failure: explainFailure,
              consent: consent === null ? null : consent.path,
              onAcceptStore: acceptStore,
              onExplain: explainFollowed,
              onDrop: dropFollowed,
              streamed,
              onCancel: cancelExplain,
              onForget: forgetOne,
            }}
            onSelect={setSelected}
            onFocus={goTo}
            onFlow={openFlow}
            flowBlocked={flowBlocked}
          >
            {/* Activity, where Detail used to be. It describes NOW even while
                the diagram is frozen: the agent is still working in the
                working tree, and the diagram is the thing that stopped. */}
            <Activity
              changes={changes}
              agentCalls={agentCalls}
              lines={gitLines?.lines ?? null}
              onSelect={setSelected}
              onFocus={goTo}
            />
          </Sidebar>
        )}
        </SectionPanes.Provider>
      </main>

      <StatusBar
        git={git}
        baseLabel={baseLabel}
        remote={repo?.remote ?? null}
        onlyChanged={onlyChanged}
        onToggleChanged={toggleChanged}
        onChangeBase={changeBase}
        frozen={frozen}
        live={live}
        counts={
          view
            ? frontOn
              // The boxes under the front page are covered, and a count of
              // them would be a count of nothing on screen.
              ? `${view.totalFiles} files`
              : diffOn
                // The diff's own three numbers, over boxes: what came, what
                // went — the ghosts — and what changed shape, since what.
                ? `+${diffCounts.added} −${diffCounts.removed} ~${diffCounts.touched} since ${diffSince ?? 'base'}`
                // What is drawn, not what the view holds: a shut folder is one
                // box standing for the seven that are no longer on the canvas.
                : `${listOn ? view.nodes.length : drawnBoxes} ${listOn ? 'rows' : 'boxes'} · ${view.totalFiles} files${view.grouped ? ' · grouped' : ''}`
            : ''
        }
        {...(diffOn
          ? {
              countsTitle: `${diffCounts.added} files added, ${diffCounts.removed} removed (drawn as ghosts) and ${diffCounts.touched} changed in shape since ${
                diffSince ?? 'the base'
              }${diffCounts.context > 0 ? `, with ${diffCounts.context} unchanged files drawn dimmed as the far ends of changed lines` : ''}. A file whose declarations and resolved references did not move is not here — git is the tool for that edit.${diffRowNow.state === 'ready' ? ` ${diffRowNow.caveat}` : ''}`,
            }
          : {})}
        languages={languageSummary}
        unreadable={unreadableReport}
        hiddenTests={hideTests ? (view?.hiddenTests ?? 0) : 0}
        onShowTests={() => setFilter('tests', null)}
        parseErrors={view?.scoped.parseErrors ?? 0}
        at={at}
        onOpenFile={openFile}
        unresolved={view ? totalUnresolved(view) : null}
        // Both counts are the slice's, so two numbers standing side by side
        // are measured over the same files. A clean directory used to show
        // the project's broken ones.
        agentLast={agentCalls[0] ?? null}
        agentTotal={agentCalls.length}
      />
    </div>
  );
}

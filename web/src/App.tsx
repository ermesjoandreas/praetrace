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
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import {
  decideCluster,
  fetchChanges,
  fetchClusters,
  fetchExplanations,
  cancelExplanations,
  fetchGit,
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
  setGitBase,
  switchProject,
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
  type SymbolLinks,
  type GroupSuggestion,
  type LanguageReport,
  type SearchHit,
  type ViewGraph,
  type ViewResponse,
} from './api';
import { MenuBar, type Menu, type MenuItem } from './MenuBar';
import { GIT_BASES, StatusBar } from './StatusBar';
import { ProjectMenu } from './ProjectMenu';
import { Welcome } from './Welcome';
import { SearchPalette } from './SearchPalette';
import { Sidebar, type GroupEditor } from './Sidebar';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { GroupNode, type GroupNodeType } from './GroupNode';
import { Activity } from './Activity';
import { Repository } from './Repository';
import { findCommit, relativeTime } from './GitGraph';
import { SourceControl } from './SourceControl';
import { ContextMenu } from './ContextMenu';
import { frameClusters, NODE_WIDTH, boxHeight, layoutNodes, type ClusterBounds } from './layout';

const nodeTypes = { box: BoxNode, frame: GroupNode };

type FlowNode = BoxNodeType | GroupNodeType;
const MAX_DEPTH = 4;
const PULSE_MS = 2500;
/** The default edge kinds plus calls; the button is a shortcut for this set. */
/**
 * The edge kinds a URL asks for. Structure is always drawn; calls and
 * associations are opted into, and each is spelled out in the CSV rather than
 * enumerated as a combination — two flags are four strings, and the next one
 * would be eight.
 */
const BASE_EDGES = ['imports', 'extends', 'implements'] as const;

function edgeParam(calls: boolean, associates: boolean): string | null {
  const extra = [calls ? 'calls' : '', associates ? 'associates' : ''].filter(Boolean);
  return extra.length === 0 ? null : [...BASE_EDGES, ...extra].join(',');
}

/** How often to ask a run in flight whether it has finished. */
const EXPLAIN_POLL_MS = 3000;

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
}

export function App() {
  const [search, setSearch] = useState(() => window.location.search);
  const [data, setData] = useState<ViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  /** Bumped to refetch the current view without changing the URL. */
  const [reloadToken, setReloadToken] = useState(0);
  /** Files touched by the most recent batch, for the pulse. */
  const [pulsing, setPulsing] = useState<string[]>([]);
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
  /** The name field for a group about to be drawn, in the panel. */
  const [creating, setCreating] = useState(false);
  const [showSidebar, setShowSidebar] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  /** Where the right-click menu is, and what was under the cursor. */
  const [contextAt, setContextAt] = useState<{ x: number; y: number; node: string | null } | null>(null);
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
  /** A press that never became a run — no ids the graph knows, or no server. */
  const [explainError, setExplainError] = useState<string | null>(null);

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
  const [agentCalls, setAgentCalls] = useState<AgentCall[]>([]);
  /** What the tool cannot read here. Null until the census has come back. */
  const [languageReport, setLanguageReport] = useState<LanguageReport | null>(null);
  /** Files the agent asked about just now, for a pulse of their own. */
  const [agentLooking, setAgentLooking] = useState<string[]>([]);
  const flow = useReactFlow();
  const [clusters, setClusters] = useState<GroupSuggestion[]>([]);

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
        setRevision((n) => n + 1);
      },
      (cause: unknown) => {
        if (cancelled) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        // The one 404 a view can answer is "no such commit", and the chip with
        // the way out stays on screen, so the banner only has to say which.
        const wanted = new URLSearchParams(search).get('at');
        setError(
          wanted !== null && message.includes('404')
            ? `No commit ${wanted.slice(0, 7)} in this repository`
            : message,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [search, reloadToken]);

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

      socket.onmessage = (event: MessageEvent<string>) => {
        const parsed = JSON.parse(event.data) as
          | LiveMessage
          | AgentMessage
          | ExplainMessage
          | ExplainDeltaMessage;

        // The run that ended is the one the poll below would have found three
        // seconds later; the poll stays, because it is the only thing that
        // notices a run another tab started.
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
          // Naming changes what is on screen; the other tools only read.
          if (parsed.call.tool === 'name_group') setRevision((n) => n + 1);
          // A path target is a box on screen; a search term is not.
          if (parsed.call.target?.includes('/')) setAgentLooking([parsed.call.target]);
          return;
        }

        const message = parsed;

        if (message.type === 'project') {
          // The URL names a scope or a file in the project we just left.
          window.history.replaceState(null, '', window.location.pathname);
          setSearch('');
          setMissed([]);
          setPulsing([]);
          coveredRef.current = new Set(message.view.nodes.flatMap((node) => node.files));
          specRef.current = JSON.stringify(message.view.spec);
          setData({ root: message.root, view: message.view });
          setError(null);
          // A path from the previous project means nothing here.
          setSelected(null);
          setRevision((n) => n + 1);
          return;
        }

        if (message.type !== 'update') return;

        // A frozen view is frozen. The server already skips a socket whose spec
        // names a commit, but a push computed for the spec this client held a
        // moment before freezing can still be in flight, and nothing that
        // happens in the working tree changes what that commit looked like.
        if (frozenRef.current) return;

        // The server computes each push from the spec it currently holds for this
        // socket, and that lags a navigation until the new spec has been sent.
        // Applying such a frame would silently revert the view, so it is refused
        // and a refetch takes its place rather than losing the update.
        const incoming = JSON.stringify(message.view.spec);
        if (specRef.current !== null && incoming !== specRef.current) {
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
        setPulsing(message.changedFiles);
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
      decideCluster(group.files, name, state).then(
        () => setRevision((n) => n + 1),
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
    groupAction(body).then(setClusters, (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
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
    // Counted from the view rather than from `picked`, which can still name a
    // box that the last update removed.
    return { boxes: chosen.length, files: [...new Set(chosen.flatMap((node) => node.files))] };
  }, [data?.view, picked]);

  const createGroup = useCallback(
    (name: string) => {
      groupAction({ action: 'create', name, files: selection.files }).then(
        (next) => {
          setClusters(next);
          setCreating(false);
        },
        (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [selection.files],
  );

  const view = data?.view;
  const depth = view?.spec.depth ?? 1;
  const focus = view?.spec.focus ?? null;
  // The calls button is one case of the edge filter, not a flag of its own.
  const showCalls = view?.spec.filter.edgeKinds.includes('calls') ?? false;
  const showAssoc = view?.spec.filter.edgeKinds.includes('associates') ?? false;
  const onlyChanged = view?.spec.filter.onlyChanged ?? false;
  /**
   * The commit on screen, or null for now. Threaded through every navigation
   * the way the calls and changed flags are: a helper that rebuilt the URL
   * without it would snap the user back to the present on the first click.
   */
  const at = view?.spec.at ?? null;
  const frozen = at !== null;

  useEffect(() => {
    let cancelled = false;
    fetchClusters(at).then(
      (found) => {
        if (!cancelled) setClusters(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, data?.root, at]);

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
   * Whether saying what a box is written in adds anything. In a project of one
   * language the same tag on every box is noise the header already covers, so
   * there is no tag at all; the moment there are two, every box says which.
   */
  const mixedProject = (view?.languages.length ?? 0) > 1;

  useEffect(() => {
    frozenRef.current = frozen;
  }, [frozen]);

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
    return {
      settled,
      uses,
      usedBy,
      total: uses + usedBy,
      label: only === undefined ? ids.length + ' symbols' : only.name,
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
          if (summary.run?.state === 'running') timer = window.setTimeout(ask, EXPLAIN_POLL_MS);
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
   * Spend the user's quota, on exactly what the list already holds. Nothing is
   * ever explained automatically; this only ever happens on a press.
   */
  const explainFollowed = useCallback(() => {
    if (explainIds.length === 0) return;
    setExplainError(null);
    setStreamed('');
    requestExplanations(explainIds).then(
      (result) => takeRun(result.run),
      (cause: unknown) => setExplainError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [explainIds, takeRun]);

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
      (cause: unknown) => setExplainError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  /**
   * Why the last press produced no words. A request that never became a run is
   * reported the same way, in the server's own wording — the useful half of a
   * failure is always the detail, not the label.
   */
  const explainFailure = useMemo(() => {
    if (explainError !== null) return { reason: 'failed' as ExplainFailure, detail: explainError };
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
   * A frame that was dragged keeps where it was put. Only frames are draggable,
   * so anything arriving here is a deliberate placement — and a placement is a
   * lock, or the next relayout would quietly undo it.
   */
  const handleFrameDragStop = useCallback(
    (_: unknown, node: { id: string; position: { x: number; y: number }; width?: number | null; height?: number | null }) => {
      if (!node.id.startsWith('group:')) return;
      const group = clusters.find((candidate) => `group:${candidate.id}` === node.id);
      if (!group || node.width == null || node.height == null) return;
      editGroup({
        action: 'update',
        id: group.storedId ?? group.id,
        geometry: { x: node.position.x, y: node.position.y, width: node.width, height: node.height },
        locked: true,
      });
    },
    [clusters, editGroup],
  );

  const queriedBoxIds = useMemo(() => {
    if (!view || agentLooking.length === 0) return new Set<string>();
    const asked = new Set(agentLooking);
    return new Set(
      view.nodes.filter((node) => node.files.some((file) => asked.has(file))).map((n) => n.id),
    );
  }, [view, agentLooking]);

  const changedBoxIds = useMemo(() => {
    if (!view || pulsing.length === 0) return new Set<string>();
    const touched = new Set(pulsing);
    return new Set(
      view.nodes.filter((node) => node.files.some((file) => touched.has(file))).map((n) => n.id),
    );
  }, [view, pulsing]);

  // Positions survive live updates: a box must not jump because the agent saved.
  const layoutRef = useRef<{
    positions: Map<string, { x: number; y: number }>;
    clusters: ClusterBounds[];
    /** Everything the cached frames were drawn from. */
    clusterKey: string;
    /** Only what dagre read to place the boxes. */
    placementKey: string;
  }>({ positions: new Map(), clusters: [], clusterKey: '', placementKey: '' });

  const { nodes, edges } = useMemo(() => {
    if (!view) return { nodes: [] as FlowNode[], edges: [] as Edge[] };

    /** A box counts as involved when any file behind it is. */
    const involved = (id: string): boolean => {
      if (relatedFiles === null) return true;
      const node = view.nodes.find((candidate) => candidate.id === id);
      return node !== undefined && node.files.some((file) => relatedFiles.has(file));
    };

    const builtEdges: Edge[] = view.edges.map((edge) => ({
      id: `${edge.from}|${edge.kind}|${edge.to}`,
      source: edge.from,
      target: edge.to,
      // An edge stays lit only when both ends are in it. One end is not a
      // relationship the followed symbol has any part in.
      className: `edge-${edge.kind}${
        relatedFiles !== null && !(involved(edge.from) && involved(edge.to)) ? ' edge-aside' : ''
      }`,
      // A weight of one is the common case and labelling it is just noise.
      ...(edge.weight > 1 ? { label: String(edge.weight) } : {}),
    }));

    const boxes: BoxNodeType[] = view.nodes.map((node) => ({
      id: node.id,
      type: 'box',
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: boxHeight(node.members.length, node.kind === 'folder', expanded.has(node.id)),
      // The selection is held here, not inside React Flow: it re-reads the
      // nodes prop on every update, so a selection it kept to itself would be
      // wiped the moment the agent saved a file.
      selected: picked.has(node.id),
      ...(picked.has(node.id) ? { style: PICKED_STYLE } : {}),
      data: {
        label: node.label,
        kind: node.kind,
        members: node.members,
        files: node.files,
        external: node.external,
        focused: node.focused,
        changed: changedBoxIds.has(node.id),
        queried: queriedBoxIds.has(node.id),
        gitStatus: node.gitStatus,
        gitChanged: node.gitChanged,
        language: node.language,
        showLanguage: mixedProject,
        root: data?.root ?? '',
        following,
        related: relatedIds,
        onFollow: toggleFollowing,
        // Fed from `reading`, never from `following`: holding a file adds it to
        // the explain list and dims nothing. Only a file box shows the control,
        // and the path it hands back is files[0] — the one `.box-open` opens.
        followed: node.kind === 'file' && reading.has(node.files[0] ?? ''),
        onFollowFile: toggleReading,
        expanded: expanded.has(node.id),
        onExpand: toggleExpanded,
        aside: relatedFiles !== null && !node.files.some((file) => relatedFiles.has(file)),
      },
    }));

    const shown = clusters.filter((group) => group.state !== 'rejected');
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
      .concat('#', [...expanded].sort().join(','));
    // What dagre reads, and nothing more: which boxes, how tall, and which
    // group each belongs to. A frame's colour, slack, lock or hand-placed
    // geometry is left out on purpose — see below.
    const placementKey = shown
      .map((group) => `${group.id}~${group.files.join(',')}~${group.parent ?? ''}`)
      .join('|')
      .concat('#', [...expanded].sort().join(','));
    const previous = layoutRef.current;

    // The groups arrive from their own request, after the first layout. Without
    // comparing them too, that first cluster-less layout would be reused for
    // ever and no frame would ever appear.
    const samePlacement =
      placementKey === previous.placementKey &&
      boxes.length === previous.positions.size &&
      boxes.every((box) => previous.positions.has(box.id));
    const sameShape = samePlacement && shapeKey === previous.clusterKey;

    const kept = boxes.map((box) => ({
      ...box,
      position: previous.positions.get(box.id) ?? box.position,
    }));
    // Only the contents changed: every box and frame stays exactly where it was.
    // Only a frame changed — a colour, a lock, a drag: every box stays, and the
    // frames are redrawn around where the boxes already are. Running dagre
    // again for that moved every box, and a frame locked to where it stood was
    // left standing where the boxes used to be.
    const laid = sameShape
      ? { nodes: kept, clusters: previous.clusters }
      : samePlacement
        ? { nodes: kept, clusters: frameClusters(kept, shown) }
        : layoutNodes(boxes, builtEdges, shown);

    layoutRef.current = {
      positions: new Map(laid.nodes.map((box) => [box.id, box.position])),
      clusters: laid.clusters,
      clusterKey: shapeKey,
      placementKey,
    };

    const byId = new Map(shown.map((group) => [group.id, group]));
    /** Where every box actually landed, for asking what a locked frame missed. */
    const placed = new Map(laid.nodes.map((box) => [box.id, box]));
    laid.clusters.sort((a, b) => a.depth - b.depth);
    // Frames first, so they render behind the boxes they enclose.
    const frames: GroupNodeType[] = laid.clusters.flatMap((bounds) => {
      const group = byId.get(bounds.id);
      if (!group) return [];
      return [
        {
          id: `group:${bounds.id}`,
          type: 'frame' as const,
          position: { x: bounds.x, y: bounds.y },
          width: bounds.width,
          height: bounds.height,
          // Outer frames sit behind the inner ones they contain.
          zIndex: bounds.depth === 0 ? -2 : -1,
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
                    const box = placed.get(file);
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

    return { nodes: [...frames, ...laid.nodes] as FlowNode[], edges: builtEdges };
  }, [
    view,
    changedBoxIds,
    queriedBoxIds,
    following,
    toggleFollowing,
    reading,
    toggleReading,
    relatedIds,
    relatedFiles,
    expanded,
    toggleExpanded,
    picked,
    mixedProject,
    data?.root,
    clusters,
    decide,
    editGroup,
    renameGroup,
  ]);

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
    const box = node !== null && node.type === 'box' ? node : null;
    if (box !== null) setSelected((current) => (current === box.id ? current : box.id));
    setContextAt({ x: event.clientX, y: event.clientY, node: box?.id ?? null });
  }, []);

  const handleNodeClick = useCallback((_event: MouseEvent, node: FlowNode) => {
    if (node.type !== 'box') return;
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
  }, []);

  const goTo = useCallback(
    (target: string, kind: 'file' | 'folder') => {
      const params = new URLSearchParams();
      if (kind === 'folder') {
        params.set('scope', target);
      } else {
        params.set('focus', target);
        if (depth !== 1) params.set('depth', String(depth));
      }
      const edges = edgeParam(showCalls, showAssoc);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (at !== null) params.set('at', at);
      navigate(params);
    },
    [navigate, depth, showCalls, showAssoc, onlyChanged, at],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: MouseEvent, node: FlowNode) => {
      if (node.type !== 'box') return;
      goTo(node.id, node.data.kind);
    },
    [goTo],
  );

  const goToScope = useCallback(
    (scope: string) => {
      const params = new URLSearchParams();
      if (scope !== '') params.set('scope', scope);
      const edges = edgeParam(showCalls, showAssoc);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (at !== null) params.set('at', at);
      navigate(params);
    },
    [navigate, showCalls, showAssoc, onlyChanged, at],
  );

  const changeDepth = useCallback(
    (next: number) => {
      if (focus === null) return;
      const params = new URLSearchParams();
      params.set('focus', focus);
      if (next !== 1) params.set('depth', String(next));
      const edges = edgeParam(showCalls, showAssoc);
      if (edges !== null) params.set('edges', edges);
      if (onlyChanged) params.set('changed', '1');
      if (at !== null) params.set('at', at);
      navigate(params);
    },
    [focus, navigate, showCalls, showAssoc, onlyChanged, at],
  );

  const handleSwitchProject = useCallback((root: string) => {
    // The server pushes a 'project' message on success, which is what clears the
    // URL and swaps the graph; this only has to start it and record the choice.
    switchProject(root).then(
      (result) => void rememberProject(result.root).catch(() => undefined),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  /** Built from the live URL so every other part of the view survives the flip. */
  const toggleEdgeKind = useCallback(
    (calls: boolean, associates: boolean) => {
      const params = new URLSearchParams(window.location.search);
      const edges = edgeParam(calls, associates);
      if (edges === null) params.delete('edges');
      else params.set('edges', edges);
      navigate(params);
    },
    [navigate],
  );

  const toggleCalls = useCallback(
    () => toggleEdgeKind(!showCalls, showAssoc),
    [toggleEdgeKind, showCalls, showAssoc],
  );
  const toggleAssoc = useCallback(
    () => toggleEdgeKind(showCalls, !showAssoc),
    [toggleEdgeKind, showCalls, showAssoc],
  );

  const toggleChanged = useCallback(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('changed') === '1') params.delete('changed');
    else params.set('changed', '1');
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

  // Cmd-K is the primary; Cmd-P is the muscle memory, and the browser's print
  // dialog has to be told no.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      const command = event.metaKey || event.ctrlKey;

      if (command && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (command && event.key === 'b') {
        event.preventDefault();
        setShowSidebar((was) => !was);
      } else if (command && event.key === 'o') {
        event.preventDefault();
        openProjectRef.current?.();
      } else if (command && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitRef.current?.();
      } else if (event.key === 'Escape') {
        clearSelection();
        // The lens, and not the list. `reading` survives on purpose: a keystroke
        // that means "stop dimming things" must not also empty a list the user
        // built deliberately and may already have paid to have explained.
        setFollowing(new Set());
        setShowWelcome(false);
        // A frozen view is the one state on the page that hides the present,
        // so the key that means "get me out of this" ends it too — unless the
        // key was meant for a field, where it cancels an edit, not a view.
        const target = event.target;
        const inField = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
        // Nor when a menu already took the key to close itself: a press that
        // dismissed the File menu did not mean "back to now".
        if (!inField && !event.defaultPrevented) backToNowRef.current?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openProjectRef = useRef<(() => void) | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const backToNowRef = useRef<(() => void) | null>(null);

  const openProject = useCallback(() => {
    void pickProject().then((picked) => {
      if (picked !== null) handleSwitchProject(picked);
    });
  }, [handleSwitchProject]);

  // The key handler is registered once; these keep it pointed at the current
  // callbacks without tearing the listener down on every render.
  openProjectRef.current = openProject;
  fitRef.current = () => void flow.fitView({ padding: 0.15 });

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
    for (const key of ['hide', 'only', 'kinds', 'since', 'changed']) params.delete(key);
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

  const groupOfSelection = useMemo(
    () => (selected === null ? null : clusters.find((group) => group.files.includes(selected)) ?? null),
    [clusters, selected],
  );

  const goToMissed = useCallback(() => {
    const latest = missed.at(-1);
    if (latest === undefined) return;
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
  const activeFilters: { key: string; label: string }[] = [
    params.has('changed') ? { key: 'changed', label: 'changes only' } : null,
    params.get('only') ? { key: 'only', label: `only ${params.get('only') ?? ''}` } : null,
    params.get('hide') ? { key: 'hide', label: `hiding ${params.get('hide') ?? ''}` } : null,
    params.get('kinds')
      ? { key: 'kinds', label: (params.get('kinds') ?? '').split(',').join(' + ') }
      : null,
    params.get('since') ? { key: 'since', label: `last ${params.get('since') ?? ''}` } : null,
  ].filter((chip): chip is { key: string; label: string } => chip !== null);

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
   * The panel edits every group, including the ones whose frames the overlap
   * rule dropped. Passed as one object because it is one feature with one
   * caller, and nine more props on `Sidebar` would say less about it.
   */
  const groupEditor: GroupEditor = {
    selection,
    creating,
    onCreating: setCreating,
    onCreate: createGroup,
    onRename: renameGroup,
    onColor: (group, color) => editGroup({ action: 'update', id: addressOf(group), color }),
    onMembers: (group, files) => editGroup({ action: 'update', id: addressOf(group), files }),
    onDelete: (group) => editGroup({ action: 'delete', id: addressOf(group) }),
  };

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
            : { run: () => void navigator.clipboard.writeText(selected) }),
        },
        {
          label: 'Open in editor',
          ...(selected === null || data === null
            ? { disabledBecause: 'Nothing selected' }
            : { run: () => void openInEditor(data.root, selected, 1) }),
        },
        {
          label: 'Reject this group',
          separatorBefore: true,
          ...(groupOfSelection === null
            ? { disabledBecause: 'The selection is not in a group' }
            : { run: () => decide(groupOfSelection, groupOfSelection.name ?? '', 'rejected') }),
        },
      ],
    },
    {
      title: 'Selection',
      items: [
        {
          label: 'Focus the selection',
          ...(selected === null ? { disabledBecause: 'Nothing selected' } : { run: () => goTo(selected, 'file') }),
        },
        {
          label: 'Show its group in the panel',
          ...(groupOfSelection === null
            ? { disabledBecause: 'The selection is not in a group' }
            : { run: () => setShowSidebar(true) }),
        },
        {
          label: 'Create group from selection…',
          separatorBefore: true,
          // The name is asked for in the panel, where the files it would cover
          // are listed: a group is worth seeing before it is worth naming.
          ...(selection.boxes < 2
            ? { disabledBecause: 'Shift-click two or more boxes first' }
            : {
                run: () => {
                  setShowSidebar(true);
                  setCreating(true);
                },
              }),
        },
        { label: 'Clear selection', shortcut: '⎋', separatorBefore: true, run: clearSelection },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Panel', shortcut: '⌘B', checked: showSidebar, run: () => setShowSidebar((was) => !was) },
        { label: 'Call edges', checked: showCalls, run: toggleCalls },
        // A field's declared type is the has-a UML exists to show, and an import
        // edge cannot say it: an import means this file mentions that one.
        { label: 'Association edges (has-a)', checked: showAssoc, run: toggleAssoc },
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
        { label: 'Zoom in', separatorBefore: true, run: () => void flow.zoomIn() },
        { label: 'Zoom out', run: () => void flow.zoomOut() },
        { label: 'Fit to screen', shortcut: '⇧⌘F', run: () => void flow.fitView({ padding: 0.15 }) },
      ],
    },
    {
      title: 'Go',
      items: [
        { label: 'Find a file or symbol…', shortcut: '⌘K', run: () => setSearchOpen(true) },
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
        { label: 'Whole project', separatorBefore: true, run: () => goToScope('') },
        {
          label: 'Up one level',
          ...(view && view.trail.length > 1
            ? { run: () => goToScope(view.trail[view.trail.length - 2]?.scope ?? '') }
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

    if (box !== undefined) {
      return [
        { label: box.kind === 'folder' ? 'Look inside' : 'Go here', run: () => goTo(box.id, box.kind) },
        {
          label: 'Open in editor',
          ...(data === null || box.kind === 'folder'
            ? { disabledBecause: 'Only a file opens in an editor' }
            : { run: () => void openInEditor(data.root, box.id, 1) }),
        },
        { label: 'Copy path', shortcut: '⌘C', run: () => void navigator.clipboard.writeText(box.id) },
        {
          label: `Create group from selection…`,
          separatorBefore: true,
          ...(selection.boxes < 2
            ? { disabledBecause: 'Shift-click two or more boxes first' }
            : {
                run: () => {
                  setShowSidebar(true);
                  setCreating(true);
                },
              }),
        },
        {
          label: 'Show its group in the panel',
          ...(groupOfSelection === null
            ? { disabledBecause: 'This is not in a group' }
            : { run: () => setShowSidebar(true) }),
        },
        {
          label: 'Only this folder',
          run: () => goToScope(box.kind === 'folder' ? box.id : box.id.split('/').slice(0, -1).join('/')),
        },
      ];
    }

    return [
      {
        label:
          selection.boxes < 2
            ? 'Create group from selection…'
            : `Create group from ${selection.boxes} boxes…`,
        ...(selection.boxes < 2
          ? { disabledBecause: 'Shift-click two or more boxes first' }
          : {
              run: () => {
                setShowSidebar(true);
                setCreating(true);
              },
            }),
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
        run: () => void flow.fitView({ padding: 0.15 }),
      },
      {
        label: 'Up one level',
        ...(view && view.trail.length > 1
          ? { run: () => goToScope(view.trail[view.trail.length - 2]?.scope ?? '') }
          : { disabledBecause: 'Already at the top' }),
      },
      { label: 'Whole project', run: () => goToScope('') },
      {
        label: 'Find a file or symbol…',
        shortcut: '⌘K',
        separatorBefore: true,
        run: () => setSearchOpen(true),
      },
      {
        label: 'Clear filters',
        ...(isFiltered ? { run: clearFilters } : { disabledBecause: 'Nothing is filtered' }),
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
        trailing={<ProjectMenu root={data?.root ?? '…'} onSwitch={handleSwitchProject} />}
      />

      <nav className="breadcrumb">
        {focus === null ? (
          <span className="trail">
            {view?.trail.map((step, index) => (
              <span key={step.scope}>
                {index > 0 && <i className="codicon codicon-chevron-right sep" aria-hidden="true" />}
                <button
                  type="button"
                  onClick={() => goToScope(step.scope)}
                  disabled={step.scope === view.spec.scope}
                >
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

        {/* What is being followed, and — the part that matters — whether the
            answer is "nothing uses this" or "nothing could be resolved". Those
            look identical on the diagram and mean opposite things. */}
        {following.size > 0 && (
          <button
            type="button"
            className={reach.total === 0 && reach.settled ? 'symbol-chip symbol-chip-empty' : 'symbol-chip'}
            onClick={() => setFollowing(new Set())}
            title={
              !reach.settled
                ? 'Looking up what these are connected to'
                : reach.total === 0
                  ? 'Nothing in this project references them, and nothing they reference resolved. Method calls in particular are under-reported on purpose — see CLAUDE.md.'
                  : 'Click to stop following'
            }
          >
            {!reach.settled
              ? 'following…'
              : `${reach.label} — ${reach.usedBy} in, ${reach.uses} out`}
            <i className="codicon codicon-close" aria-hidden="true" />
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

        {activeFilters.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="filter-chip"
            onClick={() => dropFilter(chip.key)}
            title={`Stop filtering by ${chip.label}`}
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
          <button type="button" className="missed" onClick={goToMissed}>
            {missed.length} change{missed.length === 1 ? '' : 's'} outside
          </button>
        )}

        <button
          type="button"
          className="search-open"
          onClick={() => setSearchOpen(true)}
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

      {searchOpen && <SearchPalette onPick={handlePick} onClose={() => setSearchOpen(false)} />}

      {contextAt !== null && (
        <ContextMenu
          x={contextAt.x}
          y={contextAt.y}
          items={contextItems}
          onClose={() => setContextAt(null)}
        />
      )}


      <main>
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
                boxes={view?.nodes.length ?? 0}
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
              log={log}
              at={at}
              onViewCommit={viewCommit}
              onBackToNow={backToNow}
              onSelect={setSelected}
              onFocus={goTo}
            />
            <Activity
              changes={changes}
              agentCalls={agentCalls}
              lines={gitLines?.lines ?? null}
              onSelect={setSelected}
              onFocus={goTo}
            />
          </aside>
        )}

        <div className="canvas">
        {(showWelcome || emptyProject) && (
          <Welcome
            onOpen={(path) => {
              setShowWelcome(false);
              handleSwitchProject(path);
            }}
            onSearch={() => {
              setShowWelcome(false);
              setSearchOpen(true);
            }}
            onClose={showWelcome ? () => setShowWelcome(false) : null}
            unreadable={unreadableReport}
          />
        )}
        {error !== null && <div className="error">{error}</div>}
        {error === null && view?.nodes.length === 0 && (
          <div className="empty">Nothing to show here.</div>
        )}
        <ReactFlow<FlowNode, Edge>
          // Keyed on the LOADED view, not on the URL. Keying on the URL remounts
          // the instant a link is clicked, while `nodes` still holds the previous
          // slice, so fitView fits the old graph and the new one arrives with no
          // refit at all. A live update keeps the same spec, so the camera holds.
          key={viewKey}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onPaneContextMenu={(event) => openContext(event as MouseEvent, null)}
          onNodeContextMenu={openContext}
          onNodeDragStop={handleFrameDragStop}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onNodesChange={handleNodesChange}
          // Shift is both halves of the gesture: shift-click adds a box, and
          // shift-drag rubber-bands over several. ⌘ and Ctrl keep adding one
          // too — React Flow starts the rubber band on the first pixel of a
          // shift-drag, so a shift-click that twitches lands as an empty
          // marquee, and the modifier every other canvas uses does not.
          multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
          nodesDraggable={false}
          nodesConnectable={false}
          // Off, or d3-zoom handles the double click on the pane and stops it
          // bubbling before React sees it — onNodeDoubleClick then never fires
          // and the view silently zooms instead of navigating.
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          maxZoom={2}
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            // A frame is the size of everything it encloses, so in the minimap it
            // would be a solid block over the boxes it is meant to sit behind.
            // A token, not a hex: React Flow paints this as an inline fill, so
            // the page's own rule for minimap nodes cannot reach it.
            nodeColor={(node) => (node.type === 'frame' ? 'transparent' : 'var(--vsc-border-input)')}
          />
        </ReactFlow>
        </div>

        {showSidebar && data !== null && (
          <Sidebar
            root={data.root}
            selected={selected}
            revision={revision}
            at={at}
            onSelect={setSelected}
            onFocus={goTo}
            groups={clusters}
            onDecide={decide}
            groupEditor={groupEditor}
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
              onExplain: explainFollowed,
              onDrop: dropFollowed,
              streamed,
              onCancel: cancelExplain,
              onForget: forgetOne,
            }}
          />
        )}
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
            ? `${view.nodes.length} boxes · ${view.totalFiles} files${view.grouped ? ' · grouped' : ''}`
            : ''
        }
        languages={languageSummary}
        unreadable={unreadableReport}
        agentLast={agentCalls[0] ?? null}
        agentTotal={agentCalls.length}
      />
    </div>
  );
}

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
  fetchAgentCalls,
  fetchHookStatus,
  fetchView,
  groupAction,
  installHook,
  isDesktop,
  liveUrl,
  pickProject,
  openInEditor,
  rememberProject,
  setGitBase,
  switchProject,
  type AgentCall,
  type GroupColor,
  type ChangeEntry,
  type GroupSuggestion,
  type SearchHit,
  type ViewGraph,
  type ViewResponse,
} from './api';
import { HookBanner } from './HookBanner';
import { AgentStatus } from './AgentStatus';
import { MenuBar, type Menu, type MenuItem } from './MenuBar';
import { ProjectMenu } from './ProjectMenu';
import { Welcome } from './Welcome';
import { SearchPalette } from './SearchPalette';
import { Sidebar, type GroupEditor } from './Sidebar';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { GroupNode, type GroupNodeType } from './GroupNode';
import { Activity } from './Activity';
import { NODE_WIDTH, boxHeight, layoutNodes, type ClusterBounds } from './layout';

const nodeTypes = { box: BoxNode, frame: GroupNode };

type FlowNode = BoxNodeType | GroupNodeType;
const MAX_DEPTH = 4;
const PULSE_MS = 2500;
/** The default edge kinds plus calls; the button is a shortcut for this set. */
const CALL_EDGES = 'imports,extends,implements,calls';

/**
 * The three bases the server accepts, and the words each one gets. One list
 * because three things read it — the picker, the chip and the View menu — and
 * they must never disagree about what a base is called or which is in force.
 */
const GIT_BASES = [
  { value: 'HEAD', option: 'uncommitted', chip: 'HEAD', menu: 'Compare against uncommitted changes' },
  { value: 'HEAD~1', option: '+ last commit', chip: 'HEAD~1', menu: 'Compare against the last commit too' },
  { value: 'branch', option: 'whole branch', chip: 'the branch', menu: 'Compare against the whole branch' },
] as const;

/**
 * The ring on a box that is part of the selection. It sits on the node wrapper
 * rather than on the box, because the box surface already carries three signals
 * of its own — just written, just asked about, and its git badge — and being
 * picked is the one of them the user is holding themselves.
 */
const PICKED_STYLE: CSSProperties = { boxShadow: '0 0 0 2px var(--accent)', borderRadius: '7px' };

/**
 * GitHub's own git-branch glyph. Drawn rather than written because every tool a
 * developer already uses draws this one, and a control that says "git" without
 * it reads as a text field rather than as the thing they know.
 */
function BranchIcon() {
  return (
    <svg className="git-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"
      />
    </svg>
  );
}

interface AgentMessage {
  type: 'agent';
  call: AgentCall;
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
  const [baseOpen, setBaseOpen] = useState(false);
  /**
   * Lifted out of the panel that used to own it: two panels read this now, and
   * the left one is the reason the data exists.
   */
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const baseMenu = useRef<HTMLDivElement>(null);
  /** Bumped whenever the graph changes, so the panel refetches rather than lie. */
  const [revision, setRevision] = useState(0);
  const [hookInstalled, setHookInstalled] = useState<boolean | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);
  const [agentCalls, setAgentCalls] = useState<AgentCall[]>([]);
  /** Files the agent asked about just now, for a pulse of their own. */
  const [agentLooking, setAgentLooking] = useState<string[]>([]);
  const flow = useReactFlow();
  const [clusters, setClusters] = useState<GroupSuggestion[]>([]);

  const socketRef = useRef<WebSocket | null>(null);
  /** Files the view covered before the update now being processed. */
  const coveredRef = useRef(new Set<string>());
  /** The spec of the view on screen, so a push computed for an older one is refused. */
  const specRef = useRef<string | null>(null);

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
        setError(cause instanceof Error ? cause.message : String(cause));
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
        const parsed = JSON.parse(event.data) as LiveMessage | AgentMessage;

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

  useEffect(() => {
    let cancelled = false;
    fetchHookStatus().then(
      (status) => {
        if (!cancelled) setHookInstalled(status.installed);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, data?.root]);

  useEffect(() => {
    let cancelled = false;
    fetchClusters().then(
      (found) => {
        if (!cancelled) setClusters(found);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [revision, data?.root]);

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
  const onlyChanged = view?.spec.filter.onlyChanged ?? false;
  /** null when the project is not a git work tree, which is normal, not a fault. */
  const git = view?.git ?? null;
  // What the row calls the base. The resolved one is a merge-base sha for
  // 'branch', which says nothing to anybody, so it stays in the tooltip.
  const baseLabel = GIT_BASES.find((base) => base.value === git?.requested)?.chip ?? git?.base ?? '';
  const viewKey = view ? JSON.stringify(view.spec) : 'loading';

  useEffect(() => {
    if (!baseOpen) return;
    const away = (event: globalThis.MouseEvent) => {
      if (!baseMenu.current?.contains(event.target as Node)) setBaseOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setBaseOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', escape);
    };
  }, [baseOpen]);

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
    /** Which groups the cached layout was computed for. */
    clusterKey: string;
  }>({ positions: new Map(), clusters: [], clusterKey: '' });

  const { nodes, edges } = useMemo(() => {
    if (!view) return { nodes: [] as FlowNode[], edges: [] as Edge[] };

    const builtEdges: Edge[] = view.edges.map((edge) => ({
      id: `${edge.from}|${edge.kind}|${edge.to}`,
      source: edge.from,
      target: edge.to,
      className: `edge-${edge.kind}`,
      // A weight of one is the common case and labelling it is just noise.
      ...(edge.weight > 1 ? { label: String(edge.weight) } : {}),
    }));

    const boxes: BoxNodeType[] = view.nodes.map((node) => ({
      id: node.id,
      type: 'box',
      position: { x: 0, y: 0 },
      width: NODE_WIDTH,
      height: boxHeight(node.members.length, node.kind === 'folder'),
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
        root: data?.root ?? '',
      },
    }));

    const shown = clusters.filter((group) => group.state !== 'rejected');
    // Everything a frame is drawn from, not just which groups exist. Dragging a
    // corner or taking a file out of a hand-drawn group changes no id, so a key
    // of ids alone would hand back the cached bounds and the frame would never
    // move.
    const clusterKey = shown
      .map((group) => {
        const pad = group.padding;
        const slack = pad === undefined ? '' : `${pad.x}x${pad.y}`;
        return `${group.id}~${group.files.join(',')}~${group.color ?? ''}~${slack}`;
      })
      .join('|');
    const previous = layoutRef.current;

    // The groups arrive from their own request, after the first layout. Without
    // comparing them too, that first cluster-less layout would be reused for
    // ever and no frame would ever appear.
    const sameShape =
      clusterKey === previous.clusterKey &&
      boxes.length === previous.positions.size &&
      boxes.every((box) => previous.positions.has(box.id));

    // Only the contents changed, so keep every box and frame exactly where it was.
    const laid = sameShape
      ? {
          nodes: boxes.map((box) => ({
            ...box,
            position: previous.positions.get(box.id) ?? box.position,
          })),
          clusters: previous.clusters,
        }
      : layoutNodes(boxes, builtEdges, shown);

    layoutRef.current = {
      positions: new Map(laid.nodes.map((box) => [box.id, box.position])),
      clusters: laid.clusters,
      clusterKey,
    };

    const byId = new Map(shown.map((group) => [group.id, group]));
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
          draggable: false,
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
            onAccept: (name: string) => decide(group, name, 'accepted'),
            onReject: () => decide(group, group.name ?? '', 'rejected'),
            onRename: (name: string) => renameGroup(group, name),
            onColor: (color: GroupColor) => editGroup({ action: 'update', id: addressOf(group), color }),
            onPadding: (padding: { x: number; y: number }) =>
              editGroup({ action: 'update', id: addressOf(group), padding }),
            onDelete: () => editGroup({ action: 'delete', id: addressOf(group) }),
          },
        },
      ];
    });

    return { nodes: [...frames, ...laid.nodes] as FlowNode[], edges: builtEdges };
  }, [view, changedBoxIds, queriedBoxIds, picked, data?.root, clusters, decide, editGroup, renameGroup]);

  const navigate = useCallback((params: URLSearchParams) => {
    const query = params.toString();
    const next = query ? `?${query}` : '';
    window.history.pushState(null, '', next || window.location.pathname);
    setSearch(next);
  }, []);

  // Click inspects, double-click moves. A single click used to teleport the
  // view, which made every glance at a box a navigation you had to undo.
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
      if (showCalls) params.set('edges', CALL_EDGES);
      if (onlyChanged) params.set('changed', '1');
      navigate(params);
    },
    [navigate, depth, showCalls, onlyChanged],
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
      if (showCalls) params.set('edges', CALL_EDGES);
      if (onlyChanged) params.set('changed', '1');
      navigate(params);
    },
    [navigate, showCalls, onlyChanged],
  );

  const changeDepth = useCallback(
    (next: number) => {
      if (focus === null) return;
      const params = new URLSearchParams();
      params.set('focus', focus);
      if (next !== 1) params.set('depth', String(next));
      if (showCalls) params.set('edges', CALL_EDGES);
      if (onlyChanged) params.set('changed', '1');
      navigate(params);
    },
    [focus, navigate, showCalls, onlyChanged],
  );

  const handleSwitchProject = useCallback((root: string) => {
    // The server pushes a 'project' message on success, which is what clears the
    // URL and swaps the graph; this only has to start it and record the choice.
    switchProject(root).then(
      (result) => void rememberProject(result.root).catch(() => undefined),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, []);

  const toggleCalls = useCallback(() => {
    // Built from the live URL so every other part of the view survives the flip.
    const params = new URLSearchParams(window.location.search);
    if (params.get('edges') === CALL_EDGES) params.delete('edges');
    else params.set('edges', CALL_EDGES);
    navigate(params);
  }, [navigate]);

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
        setShowWelcome(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openProjectRef = useRef<(() => void) | null>(null);
  const fitRef = useRef<(() => void) | null>(null);

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
  const isFiltered = ['hide', 'only', 'kinds', 'since', 'changed'].some((key) => params.has(key));
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
            ? { run: () => void installHook().then(() => setRevision((n) => n + 1)) }
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
        {
          label: 'Hide type-only files',
          separatorBefore: true,
          checked: params.get('kinds') === 'class,function',
          run: () => setFilter('kinds', params.get('kinds') === 'class,function' ? null : 'class,function'),
        },
        {
          label: 'Only changed in the last 10 minutes',
          checked: params.get('since') === '10m',
          run: () => setFilter('since', params.get('since') === '10m' ? null : '10m'),
        },
        {
          label: 'Only changed vs git',
          checked: onlyChanged,
          // Without git there is nothing to differ from, so the filter would
          // empty the diagram rather than narrow it.
          ...(git === null
            ? { disabledBecause: 'This project is not a git work tree' }
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

  return (
    <div className="app">
      <MenuBar
        menus={menus}
        trailing={
          <>
            <AgentStatus last={agentCalls[0] ?? null} total={agentCalls.length} />
            <span className={live ? 'live live-on' : 'live'} title={live ? 'watching' : 'disconnected'} />
            <ProjectMenu root={data?.root ?? '…'} onSwitch={handleSwitchProject} />
            <span className="counts">
              {view
                ? `${view.nodes.length} boxes · ${view.totalFiles} files${view.grouped ? ' · grouped' : ''}`
                : ''}
            </span>
          </>
        }
      />

      <nav className="breadcrumb">
        {focus === null ? (
          <span className="trail">
            {view?.trail.map((step, index) => (
              <span key={step.scope}>
                {index > 0 && <span className="sep">/</span>}
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
              <button type="button" onClick={() => changeDepth(depth - 1)} disabled={depth <= 1}>
                −
              </button>
              <span>
                {depth} hop{depth === 1 ? '' : 's'}
              </span>
              <button type="button" onClick={() => changeDepth(depth + 1)} disabled={depth >= MAX_DEPTH}>
                +
              </button>
            </span>
            <button type="button" className="clear" onClick={() => goToScope('')}>
              clear
            </button>
          </span>
        )}

        {git !== null && (
          // One control, two segments: what the tree is compared against, and
          // how much differs. The shape is VS Code's status bar and GitHub's
          // branch button, because a developer can already read it — and the
          // dropdown is this app's own menu, so one gesture does not get two
          // visual languages.
          <div className="git" ref={baseMenu}>
            <button
              type="button"
              className={baseOpen ? 'git-base git-base-open' : 'git-base'}
              aria-expanded={baseOpen}
              onClick={() => setBaseOpen((was) => !was)}
              title={`Comparing against ${git.base}${git.branch === null ? '' : ` on ${git.branch}`}`}
            >
              <BranchIcon />
              <span className="git-base-name">{git.branch ?? baseLabel}</span>
              <span className="git-caret" aria-hidden="true">▾</span>
            </button>

            <button
              type="button"
              className="git-count"
              aria-pressed={onlyChanged}
              onClick={toggleChanged}
              // The count is git's, not the diagram's: it includes deleted files
              // that have no box and untracked files the graph never parses.
              title={
                onlyChanged
                  ? `Showing only what differs from ${git.base} — click to show every file`
                  : `${git.changed === 1 ? '1 path differs' : `${git.changed} paths differ`} from ${
                      git.base
                    } — click to show only those`
              }
            >
              <span className="git-count-n">{git.changed}</span>
              <span className="git-count-word">changed vs {baseLabel}</span>
            </button>

            {/* The base is a session setting, not a view. One server watches one
                project and runs git against one base, so a base carried in the
                URL would promise a per-tab comparison nothing can honour — the
                same reason the project root is not in the URL either. */}
            {baseOpen && (
              <div className="menu-drop git-drop">
                <div className="git-drop-head">Compare against</div>
                {GIT_BASES.map((base) => (
                  <button
                    key={base.value}
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setBaseOpen(false);
                      changeBase(base.value);
                    }}
                  >
                    <span className="menu-check">{git.requested === base.value ? '✓' : ''}</span>
                    <span className="menu-label">{base.option}</span>
                    <kbd>{base.chip}</kbd>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isFiltered && (
          <button type="button" className="filter-chip" onClick={clearFilters} title="Clear all filters">
            filtered ✕
          </button>
        )}

        {missed.length > 0 && (
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
        >
          {showSidebar ? '⇥' : '⇤'}
        </button>
      </nav>

      {data !== null && <HookBanner root={data.root} />}

      {searchOpen && <SearchPalette onPick={handlePick} onClose={() => setSearchOpen(false)} />}

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
          hookInstalled={hookInstalled}
          onInstallHook={() => void installHook().then(() => setRevision((n) => n + 1))}
          onClose={showWelcome ? () => setShowWelcome(false) : null}
        />
      )}

      <main>
        {/* Left is time, right is structure: what the agent is doing, beside
            what you are looking at. They were one panel, which meant watching
            the agent cost you the detail of the thing it was touching. */}
        {data !== null && (
          <Activity changes={changes} agentCalls={agentCalls} onSelect={setSelected} onFocus={goTo} />
        )}

        <div className="canvas">
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
            nodeColor={(node) => (node.type === 'frame' ? 'transparent' : '#3a414d')}
          />
        </ReactFlow>
        </div>

        {showSidebar && data !== null && (
          <Sidebar
            root={data.root}
            selected={selected}
            revision={revision}
            onSelect={setSelected}
            onFocus={goTo}
            groups={clusters}
            onDecide={decide}
            groupEditor={groupEditor}
          />
        )}
      </main>
    </div>
  );
}

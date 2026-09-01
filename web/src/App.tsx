import { Background, Controls, MiniMap, ReactFlow, useReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  decideCluster,
  fetchClusters,
  fetchAgentCalls,
  fetchHookStatus,
  fetchView,
  installHook,
  isDesktop,
  liveUrl,
  pickProject,
  openInEditor,
  rememberProject,
  switchProject,
  type AgentCall,
  type GroupSuggestion,
  type SearchHit,
  type ViewGraph,
  type ViewResponse,
} from './api';
import { HookBanner } from './HookBanner';
import { AgentStatus } from './AgentStatus';
import { MenuBar, type Menu } from './MenuBar';
import { ProjectMenu } from './ProjectMenu';
import { Welcome } from './Welcome';
import { SearchPalette } from './SearchPalette';
import { Sidebar } from './Sidebar';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { GroupNode, type GroupNodeType } from './GroupNode';
import { NODE_WIDTH, boxHeight, layoutNodes, type ClusterBounds } from './layout';

const nodeTypes = { box: BoxNode, frame: GroupNode };

type FlowNode = BoxNodeType | GroupNodeType;
const MAX_DEPTH = 4;
const PULSE_MS = 2500;
/** The default edge kinds plus calls; the button is a shortcut for this set. */
const CALL_EDGES = 'imports,extends,implements,calls';

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
  const [showSidebar, setShowSidebar] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
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

  const view = data?.view;
  const depth = view?.spec.depth ?? 1;
  const focus = view?.spec.focus ?? null;
  // The calls button is one case of the edge filter, not a flag of its own.
  const showCalls = view?.spec.filter.edgeKinds.includes('calls') ?? false;
  const viewKey = view ? JSON.stringify(view.spec) : 'loading';

  // Tell the server which slice this client is looking at, so its updates are
  // computed for this view rather than broadcast as one shared one.
  useEffect(() => {
    const socket = socketRef.current;
    if (!socket || !view || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ spec: view.spec }));
  }, [view?.spec.scope, view?.spec.focus, view?.spec.depth, live]);

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
      data: {
        label: node.label,
        kind: node.kind,
        members: node.members,
        files: node.files,
        external: node.external,
        focused: node.focused,
        changed: changedBoxIds.has(node.id),
        queried: queriedBoxIds.has(node.id),
        root: data?.root ?? '',
      },
    }));

    const shown = clusters.filter((group) => group.state !== 'rejected');
    const clusterKey = shown.map((group) => group.id).join('|');
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
            name: group.name,
            fileCount: group.files.length,
            cohesion: group.cohesion,
            accepted: group.state === 'accepted',
            depth: group.depth,
            onAccept: (name: string) => decide(group, name, 'accepted'),
            onReject: () => decide(group, group.name ?? '', 'rejected'),
          },
        },
      ];
    });

    return { nodes: [...frames, ...laid.nodes] as FlowNode[], edges: builtEdges };
  }, [view, changedBoxIds, queriedBoxIds, data?.root, clusters, decide]);

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
      navigate(params);
    },
    [navigate, depth, showCalls],
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
      navigate(params);
    },
    [navigate, showCalls],
  );

  const changeDepth = useCallback(
    (next: number) => {
      if (focus === null) return;
      const params = new URLSearchParams();
      params.set('focus', focus);
      if (next !== 1) params.set('depth', String(next));
      if (showCalls) params.set('edges', CALL_EDGES);
      navigate(params);
    },
    [focus, navigate, showCalls],
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
        setSelected(null);
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
    for (const key of ['hide', 'only', 'kinds', 'since']) params.delete(key);
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
  const isFiltered = ['hide', 'only', 'kinds', 'since'].some((key) => params.has(key));
  // Nothing to draw is the moment to say what the app is for.
  const empty = view !== undefined && view.nodes.length === 0;

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
        { label: 'Clear selection', shortcut: '⎋', separatorBefore: true, run: () => setSelected(null) },
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
        { label: 'Clear filters', run: clearFilters },
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

      {(showWelcome || empty) && (
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
            agentCalls={agentCalls}
          />
        )}
      </main>
    </div>
  );
}

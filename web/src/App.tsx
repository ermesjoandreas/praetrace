import { Background, Controls, MiniMap, ReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import {
  fetchView,
  liveUrl,
  openInEditor,
  rememberProject,
  switchProject,
  type SearchHit,
  type ViewGraph,
  type ViewResponse,
} from './api';
import { HookBanner } from './HookBanner';
import { ProjectMenu } from './ProjectMenu';
import { SearchPalette } from './SearchPalette';
import { Sidebar } from './Sidebar';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { NODE_WIDTH, boxHeight, layoutNodes } from './layout';

const nodeTypes = { box: BoxNode };
const MAX_DEPTH = 4;
const PULSE_MS = 2500;

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
        const message = JSON.parse(event.data) as LiveMessage;

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

  const view = data?.view;
  const depth = view?.spec.depth ?? 1;
  const focus = view?.spec.focus ?? null;
  const showCalls = view?.spec.showCalls ?? false;
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

  const changedBoxIds = useMemo(() => {
    if (!view || pulsing.length === 0) return new Set<string>();
    const touched = new Set(pulsing);
    return new Set(
      view.nodes.filter((node) => node.files.some((file) => touched.has(file))).map((n) => n.id),
    );
  }, [view, pulsing]);

  // Positions survive live updates: a box must not jump because the agent saved.
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());

  const { nodes, edges } = useMemo(() => {
    if (!view) return { nodes: [] as BoxNodeType[], edges: [] as Edge[] };

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
        root: data?.root ?? '',
      },
    }));

    const previous = positionsRef.current;
    const sameShape = boxes.length === previous.size && boxes.every((box) => previous.has(box.id));

    // Only the contents changed, so keep every box exactly where it was.
    const placed = sameShape
      ? boxes.map((box) => ({ ...box, position: previous.get(box.id) ?? box.position }))
      : layoutNodes(boxes, builtEdges);

    positionsRef.current = new Map(placed.map((box) => [box.id, box.position]));
    return { nodes: placed, edges: builtEdges };
  }, [view, changedBoxIds, data?.root]);

  const navigate = useCallback((params: URLSearchParams) => {
    const query = params.toString();
    const next = query ? `?${query}` : '';
    window.history.pushState(null, '', next || window.location.pathname);
    setSearch(next);
  }, []);

  // Click inspects, double-click moves. A single click used to teleport the
  // view, which made every glance at a box a navigation you had to undo.
  const handleNodeClick = useCallback((_event: MouseEvent, node: BoxNodeType) => {
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
      if (showCalls) params.set('calls', '1');
      navigate(params);
    },
    [navigate, depth, showCalls],
  );

  const handleNodeDoubleClick = useCallback(
    (_event: MouseEvent, node: BoxNodeType) => goTo(node.id, node.data.kind),
    [goTo],
  );

  const goToScope = useCallback(
    (scope: string) => {
      const params = new URLSearchParams();
      if (scope !== '') params.set('scope', scope);
      if (showCalls) params.set('calls', '1');
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
      if (showCalls) params.set('calls', '1');
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
    if (params.get('calls') === '1') params.delete('calls');
    else params.set('calls', '1');
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
      if ((event.metaKey || event.ctrlKey) && (event.key === 'k' || event.key === 'p')) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const goToMissed = useCallback(() => {
    const latest = missed.at(-1);
    if (latest === undefined) return;
    const params = new URLSearchParams();
    params.set('focus', latest);
    navigate(params);
  }, [missed, navigate]);

  return (
    <div className="app">
      <header>
        <span className="brand">codemap</span>
        <span className={live ? 'live live-on' : 'live'} title={live ? 'watching' : 'disconnected'} />
        <ProjectMenu root={data?.root ?? '…'} onSwitch={handleSwitchProject} />

        {focus === null ? (
          <nav className="trail">
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
          </nav>
        ) : (
          <nav className="trail">
            <span className="focus-label">focus</span>
            <code>{focus}</code>
            <span className="depth">
              <button type="button" onClick={() => changeDepth(depth - 1)} disabled={depth <= 1}>
                −
              </button>
              <span>
                {depth} hop{depth === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => changeDepth(depth + 1)}
                disabled={depth >= MAX_DEPTH}
              >
                +
              </button>
            </span>
            <button type="button" className="clear" onClick={() => goToScope('')}>
              clear
            </button>
          </nav>
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
          className={showCalls ? 'calls-toggle calls-on' : 'calls-toggle'}
          onClick={toggleCalls}
          title="Draw who calls whom, not only who imports whom"
        >
          calls
        </button>

        <button
          type="button"
          className="panel-toggle"
          onClick={() => setShowSidebar((was) => !was)}
          title={showSidebar ? 'Hide panel' : 'Show panel'}
        >
          {showSidebar ? '⇥' : '⇤'}
        </button>

        <span className="counts">
          {view
            ? `${view.nodes.length} boxes · ${view.totalFiles} files${view.grouped ? ' · grouped' : ''}`
            : ''}
        </span>
      </header>

      {data !== null && <HookBanner root={data.root} />}

      {searchOpen && <SearchPalette onPick={handlePick} onClose={() => setSearchOpen(false)} />}

      <main>
        <div className="canvas">
        {error !== null && <div className="error">{error}</div>}
        {error === null && view?.nodes.length === 0 && (
          <div className="empty">Nothing to show here.</div>
        )}
        <ReactFlow<BoxNodeType, Edge>
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
          <MiniMap pannable zoomable />
        </ReactFlow>
        </div>

        {showSidebar && data !== null && (
          <Sidebar
            root={data.root}
            selected={selected}
            revision={revision}
            onSelect={setSelected}
            onFocus={goTo}
          />
        )}
      </main>
    </div>
  );
}

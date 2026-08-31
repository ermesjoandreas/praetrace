import { Background, Controls, MiniMap, ReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { fetchView, type ViewGraph, type ViewResponse } from './api';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { NODE_WIDTH, boxHeight, layoutNodes } from './layout';

const nodeTypes = { box: BoxNode };
const MAX_DEPTH = 4;
const PULSE_MS = 2500;

interface LiveUpdate {
  type: 'update';
  view: ViewGraph;
  changedFiles: string[];
}

export function App() {
  const [search, setSearch] = useState(() => window.location.search);
  const [data, setData] = useState<ViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  /** Files touched by the most recent batch, for the pulse. */
  const [pulsing, setPulsing] = useState<string[]>([]);
  /** Changes that landed outside the current view and have not been looked at. */
  const [missed, setMissed] = useState<string[]>([]);

  const socketRef = useRef<WebSocket | null>(null);

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
        setData(result);
        setError(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [search]);

  useEffect(() => {
    const url = new URL('/live', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url);
    socketRef.current = socket;

    socket.onopen = () => setLive(true);
    socket.onclose = () => setLive(false);
    socket.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as LiveUpdate;
      if (message.type !== 'update') return;

      // Everything is derived from the message itself, so this handler never
      // reads stale state from its closure.
      const covered = new Set(message.view.nodes.flatMap((node) => node.files));
      const outside = message.changedFiles.filter((file) => !covered.has(file));

      setData((current) => (current ? { ...current, view: message.view } : current));
      setPulsing(message.changedFiles);
      if (outside.length > 0) {
        setMissed((previous) => [...new Set([...previous, ...outside])]);
      }
    };

    return () => {
      socketRef.current = null;
      socket.close();
    };
  }, []);

  const view = data?.view;
  const depth = view?.spec.depth ?? 1;
  const focus = view?.spec.focus ?? null;

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
  }, [view, changedBoxIds]);

  const navigate = useCallback((params: URLSearchParams) => {
    const query = params.toString();
    const next = query ? `?${query}` : '';
    window.history.pushState(null, '', next || window.location.pathname);
    setSearch(next);
  }, []);

  const handleNodeClick = useCallback(
    (_event: MouseEvent, node: BoxNodeType) => {
      const params = new URLSearchParams();
      if (node.data.kind === 'folder') {
        params.set('scope', node.id);
      } else {
        params.set('focus', node.id);
        if (depth !== 1) params.set('depth', String(depth));
      }
      navigate(params);
    },
    [navigate, depth],
  );

  const goToScope = useCallback(
    (scope: string) => {
      const params = new URLSearchParams();
      if (scope !== '') params.set('scope', scope);
      navigate(params);
    },
    [navigate],
  );

  const changeDepth = useCallback(
    (next: number) => {
      if (focus === null) return;
      const params = new URLSearchParams();
      params.set('focus', focus);
      if (next !== 1) params.set('depth', String(next));
      navigate(params);
    },
    [focus, navigate],
  );

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
        <span className="root">{data?.root ?? '…'}</span>

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

        <span className="counts">
          {view
            ? `${view.nodes.length} boxes · ${view.totalFiles} files${view.grouped ? ' · grouped' : ''}`
            : ''}
        </span>
      </header>

      <main>
        {error !== null && <div className="error">{error}</div>}
        {error === null && view?.nodes.length === 0 && (
          <div className="empty">Nothing to show here.</div>
        )}
        <ReactFlow<BoxNodeType, Edge>
          // Remounting on navigation is what re-runs fitView for the new slice.
          // A live update deliberately does not remount, so the camera holds.
          key={search}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={handleNodeClick}
          nodesDraggable={false}
          nodesConnectable={false}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.05}
          maxZoom={2}
        >
          <Background gap={22} size={1} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </main>
    </div>
  );
}

import { Background, Controls, MiniMap, ReactFlow, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { fetchView, type ViewResponse } from './api';
import { BoxNode, type BoxNodeType } from './BoxNode';
import { NODE_WIDTH, boxHeight, layoutNodes } from './layout';

const nodeTypes = { box: BoxNode };
const MAX_DEPTH = 4;

export function App() {
  const [search, setSearch] = useState(() => window.location.search);
  const [data, setData] = useState<ViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The view lives in the URL, so the back button is the navigation history.
  useEffect(() => {
    const onPopState = () => setSearch(window.location.search);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
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

  const navigate = useCallback((params: URLSearchParams) => {
    const query = params.toString();
    const next = query ? `?${query}` : '';
    window.history.pushState(null, '', next || window.location.pathname);
    setSearch(next);
  }, []);

  const view = data?.view;
  const depth = view?.spec.depth ?? 1;
  const focus = view?.spec.focus ?? null;

  const { nodes, edges } = useMemo(() => {
    if (!view) return { nodes: [] as BoxNodeType[], edges: [] as Edge[] };

    const laidOutEdges: Edge[] = view.edges.map((edge) => ({
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
        fileCount: node.fileCount,
        external: node.external,
        focused: node.focused,
      },
    }));

    return { nodes: layoutNodes(boxes, laidOutEdges), edges: laidOutEdges };
  }, [view]);

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

  return (
    <div className="app">
      <header>
        <span className="brand">codemap</span>
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
              <span>{depth} hop{depth === 1 ? '' : 's'}</span>
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

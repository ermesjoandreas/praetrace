import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { fetchFlow, openInEditor, type FlowNode as FlowStep, type FlowReply, type FlowTarget } from './api';
import { flowBoxSize, layoutFlow } from './layout';

/**
 * The activity diagram of one function, over the canvas.
 *
 * It covers the canvas and not the window, the way the welcome screen does:
 * the menu bar, both side bars and the status bar stay reachable while it is
 * up, and Escape closes it — App keeps it in the Escape order beside the
 * welcome screen, above the find bar.
 *
 * Nothing here is fetched until asked for. The flow is a parse — the worker
 * reads the file and walks the function's tree — and a page that parsed every
 * function it looked at would be the boot scan run again on every glance. So
 * the fetch is the opening of this overlay and nothing earlier; while it is
 * open it is read again on every save, because the diagram describes the
 * file as it is now and a stale flow that looked current would be the one
 * kind of wrong this project exists to stop.
 *
 * What it draws is the engine's answer and nothing more: a box per node, an
 * edge per edge, the labels the engine wrote, and under it every sentence
 * the engine gave about what it left out. The page decides where the boxes
 * stand and what shape they are; it never adds a branch.
 */

/** Past this many boxes the diagram is drawn only on request. `derive` is 135. */
export const BIG_FLOW = 40;

type StepData = {
  step: FlowStep;
  /** The size the box was laid out at, so a diamond can draw itself to it. */
  width: number;
  height: number;
};
type StepNode = Node<StepData, 'step'>;

type WayData = {
  /** Runs back up the diagram — a loop's return, a `continue` — and is drawn round the side. */
  back: boolean;
};
type WayEdge = Edge<WayData, 'way'>;

/** Length and half-width of the closed arrowhead every edge ends in. */
const HEAD = { length: 8, half: 3.5 };

/**
 * The direction a line arrives from at a handle, mirrored: a target handle on
 * the top of a box is reached from above.
 */
function inward(position: Position): { x: number; y: number } {
  switch (position) {
    case Position.Left:
      return { x: -1, y: 0 };
    case Position.Top:
      return { x: 0, y: -1 };
    case Position.Bottom:
      return { x: 0, y: 1 };
    default:
      return { x: 1, y: 0 };
  }
}

/** UML's filled arrowhead, tip on the target, pointing along the line. */
function head(x: number, y: number, position: Position): string {
  const n = inward(position);
  const back = { x: x + n.x * HEAD.length, y: y + n.y * HEAD.length };
  const p = { x: -n.y * HEAD.half, y: n.x * HEAD.half };
  return `M ${x} ${y} L ${back.x + p.x} ${back.y + p.y} L ${back.x - p.x} ${back.y - p.y} Z`;
}

/**
 * One edge. The label is the engine's — `yes`, `no`, a case's value, `catch`,
 * or the exit an edge out of a finally carries — and a back edge leaves and
 * arrives by the side handles, so a loop's return bows out beside the body
 * instead of cutting up through it.
 */
function WayEdgeView({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, label, data }: EdgeProps<WayEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge
        path={path}
        className={data?.back === true ? 'flow-way flow-way-back' : 'flow-way'}
        label={label}
        labelX={labelX}
        labelY={labelY}
        labelShowBg
        labelBgPadding={[3, 1]}
        labelBgBorderRadius={2}
      />
      <path className="flow-arrow" d={head(targetX, targetY, targetPosition)} />
    </>
  );
}

/**
 * One box, in the notation UML gives its kind: a filled dot for start, a
 * bullseye for end, a rounded box for an action, a diamond for a decision —
 * and for a loop, which UML draws as a decision with its way back — and a
 * dashed box for try, catch and finally, the line UML's interruptible region
 * wears. The engine gives a try as a box, not as a containment, so the box
 * says "region" by its line rather than pretending to enclose anything.
 *
 * Four handles: in at the top, out at the bottom, and a pair on the right for
 * the edges that run back up. Every one is invisible; they only say where a
 * line may start and end.
 */
function StepView({ data }: NodeProps<StepNode>) {
  const { step, width, height } = data;
  const where =
    step.range.startLine === step.range.endLine
      ? `line ${step.range.startLine}`
      : `lines ${step.range.startLine}–${step.range.endLine}`;
  const title = `${step.label} — ${where}. Double-click to open it.`;

  const handles = (
    <>
      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
      <Handle type="source" position={Position.Right} id="back-out" />
      <Handle type="target" position={Position.Right} id="back-in" />
    </>
  );

  // The two circles are drawn as circles, in SVG: a start node is a dot and an
  // end node a bullseye, in UML and here, and neither is a control with its
  // corners rounded — which is what a 50% radius in the stylesheet would say.
  if (step.kind === 'start') {
    return (
      <div className="flow-start" style={{ width, height }} title={title} aria-label="start">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <circle className="flow-dot" cx={width / 2} cy={height / 2} r={width / 2 - 1} />
        </svg>
        {handles}
      </div>
    );
  }
  if (step.kind === 'end') {
    return (
      <div className="flow-end" style={{ width, height }} title={title} aria-label="end">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
          <circle className="flow-ring" cx={width / 2} cy={height / 2} r={width / 2 - 1} />
          <circle className="flow-dot" cx={width / 2} cy={height / 2} r={width / 4} />
        </svg>
        {handles}
      </div>
    );
  }
  if (step.kind === 'decision' || step.kind === 'loop') {
    return (
      <div className={`flow-decision flow-${step.kind}`} style={{ width, height }} title={title}>
        <svg className="flow-diamond" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
          <polygon points={`${width / 2},0.5 ${width - 0.5},${height / 2} ${width / 2},${height - 0.5} 0.5,${height / 2}`} />
        </svg>
        <span className="flow-label">{step.label}</span>
        {step.note !== undefined && <span className="flow-aside">{step.note}</span>}
        {handles}
      </div>
    );
  }
  return (
    <div className={`flow-box flow-${step.kind}`} style={{ width, height }} title={title}>
      <span className="flow-label">{step.label}</span>
      {step.more !== undefined && step.more > 0 && (
        <span className="flow-aside">
          +{step.more} more {step.more === 1 ? 'statement' : 'statements'}
        </span>
      )}
      {step.note !== undefined && <span className="flow-aside">{step.note}</span>}
      {handles}
    </div>
  );
}

const nodeTypes = { step: StepView };
const edgeTypes = { way: WayEdgeView };

/** What the fetch came back with, or where it is. */
type Answer =
  | { state: 'reading' }
  | { state: 'gone' }
  | { state: 'failed'; message: string }
  | { state: 'answered'; reply: FlowReply };

export function Flow({
  target,
  root,
  at,
  revision,
  onClose,
}: {
  target: FlowTarget;
  root: string;
  /** The commit the diagram behind this is frozen at, so the header can say the flow is not its. */
  at: string | null;
  /** Bumped on every graph change; the flow is re-read on it, because the file may have. */
  revision: number;
  onClose: () => void;
}) {
  const [answer, setAnswer] = useState<Answer>({ state: 'reading' });
  /** "Draw anyway" was pressed for this symbol. Forgotten with the symbol. */
  const [drawBig, setDrawBig] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setDrawBig(false);
  }, [target.id]);

  // The close button takes focus, as a dialog's would: the overlay covers the
  // thing the keyboard was on, and Escape has to have somewhere to come from.
  useEffect(() => {
    closeButton.current?.focus();
  }, [target.id]);

  useEffect(() => {
    let cancelled = false;
    fetchFlow(target.id).then(
      (reply) => {
        if (cancelled) return;
        setAnswer(reply === null ? { state: 'gone' } : { state: 'answered', reply });
      },
      (error: unknown) => {
        if (cancelled) return;
        setAnswer({ state: 'failed', message: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [target.id, revision]);

  const reply = answer.state === 'answered' ? answer.reply : null;
  const flow = reply?.flow ?? null;
  const big = reply !== null && reply.boxes > BIG_FLOW;

  /**
   * The boxes and lines, laid out. Every box is sized before dagre sees it —
   * the same order the class diagram keeps — and the whole thing is rebuilt
   * on every answer: the engine's ids are not stable across edits, so there
   * is nothing to keep still between one read and the next.
   */
  const drawn = useMemo(() => {
    if (flow === null || (big && !drawBig)) return null;
    const sized = flow.nodes.map((step) => {
      const extra = (step.more !== undefined && step.more > 0 ? 1 : 0) + (step.note !== undefined ? 1 : 0);
      return { step, ...flowBoxSize(step.kind, step.label, extra) };
    });
    const { positions, backward } = layoutFlow(
      sized.map(({ step, width, height }) => ({ id: step.id, width, height })),
      flow.edges,
    );
    const nodes: StepNode[] = sized.map(({ step, width, height }) => ({
      id: step.id,
      type: 'step',
      position: positions.get(step.id) ?? { x: 0, y: 0 },
      width,
      height,
      data: { step, width, height },
      draggable: false,
      selectable: false,
    }));
    const edges: WayEdge[] = flow.edges.map((edge, index) => {
      const back = backward[index] === true;
      return {
        id: `way-${index}`,
        type: 'way',
        source: edge.from,
        target: edge.to,
        sourceHandle: back ? 'back-out' : 'out',
        targetHandle: back ? 'back-in' : 'in',
        ...(edge.label === undefined ? {} : { label: edge.label }),
        data: { back },
      };
    });
    return { nodes, edges };
  }, [flow, big, drawBig]);

  return (
    <div className="flow" role="dialog" aria-label={`Flow of ${target.name}`}>
      <header className="flow-head">
        <i className="codicon codicon-type-hierarchy" aria-hidden="true" />
        <h2 className="flow-title" title={`${target.id} — the activity diagram of one function, read off its syntax tree`}>
          Flow of {target.name}
        </h2>
        {reply !== null && reply.flow !== null && (
          <span className="flow-status">
            {reply.boxes} {reply.boxes === 1 ? 'box' : 'boxes'}
          </span>
        )}
        {/* A frozen diagram is a commit's; this is not. The route refuses a
            commit outright rather than drawing today's body under its name,
            so the one honest thing the header can do is say which it is of. */}
        {at !== null && (
          <span className="flow-status" title="The flow is read from the file on disk. A commit's files are unpacked, scanned and removed, so there is nothing to read one from.">
            of the working tree, not {at.slice(0, 7)}
          </span>
        )}
        <button
          ref={closeButton}
          type="button"
          className="flow-close"
          onClick={onClose}
          title="Close (Esc)"
          aria-label="Close"
        >
          <i className="codicon codicon-close" aria-hidden="true" />
        </button>
      </header>

      <div className="flow-body">
        {answer.state === 'reading' && <p className="flow-word">Reading {target.name}…</p>}
        {answer.state === 'gone' && (
          // The same silence the panel names, for the same cause.
          <p className="flow-word">
            Not in the graph. A file that will not parse loses its symbols until the next save.
          </p>
        )}
        {answer.state === 'failed' && <p className="flow-word flow-failed">{answer.message}</p>}
        {reply !== null && reply.flow === null && <p className="flow-word">{reply.reason}</p>}
        {reply !== null && reply.flow !== null && big && !drawBig && (
          <div className="flow-big">
            <p className="flow-word">
              <i className="codicon codicon-warning" aria-hidden="true" />
              {reply.boxes} boxes — this one is big.
            </p>
            <button type="button" className="flow-draw" onClick={() => setDrawBig(true)}>
              Draw anyway
            </button>
          </div>
        )}
        {drawn !== null && (
          // Its own provider, or this diagram would share the canvas's store
          // and the two would write each other's nodes.
          <ReactFlowProvider>
            <ReactFlow<StepNode, WayEdge>
              nodes={drawn.nodes}
              edges={drawn.edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              onNodeDoubleClick={(_event, node) =>
                void openInEditor(root, target.filePath, node.data.step.range.startLine)
              }
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              // Off, for the reason the canvas keeps it off: d3-zoom would take
              // the double click and onNodeDoubleClick would never fire.
              zoomOnDoubleClick={false}
              fitView
              fitViewOptions={{ padding: 0.1 }}
              minZoom={0.1}
              maxZoom={2}
              proOptions={{ hideAttribution: true }}
            >
              <Background gap={22} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </ReactFlowProvider>
        )}
      </div>

      {/* What this picture leaves out, in the engine's own sentences. Under
          the diagram and muted, but always there while there is a diagram: a
          flow with no callbacks and no awaits has an empty list, and then
          nothing is printed. */}
      {flow !== null && flow.notDrawn.length > 0 && (
        <footer className="flow-foot">
          <span className="flow-foot-title">Not drawn</span>
          <ul>
            {flow.notDrawn.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </footer>
      )}
    </div>
  );
}

import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

export const NODE_WIDTH = 240;
export const MAX_MEMBERS = 8;

const HEADER_HEIGHT = 38;
const ROW_HEIGHT = 17;
const DEFAULT_HEIGHT = 80;

/**
 * Boxes are measured before layout rather than after render, because dagre
 * needs dimensions up front and React Flow would otherwise lay out on stale
 * sizes for a frame.
 */
export function boxHeight(memberCount: number, isFolder: boolean): number {
  if (isFolder) return HEADER_HEIGHT + ROW_HEIGHT + 8;
  const shown = Math.min(memberCount, MAX_MEMBERS);
  const overflowRow = memberCount > MAX_MEMBERS ? 1 : 0;
  return HEADER_HEIGHT + (shown + overflowRow) * ROW_HEIGHT + 10;
}

export function layoutNodes<T extends Node>(nodes: T[], edges: Edge[]): T[] {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: 'LR', nodesep: 26, ranksep: 120, marginx: 40, marginy: 40 });

  for (const node of nodes) {
    graph.setNode(node.id, {
      width: node.width ?? NODE_WIDTH,
      height: node.height ?? DEFAULT_HEIGHT,
    });
  }
  for (const edge of edges) graph.setEdge(edge.source, edge.target);

  dagre.layout(graph);

  return nodes.map((node) => {
    const positioned = graph.node(node.id);
    if (!positioned) return node;
    // dagre positions by centre, React Flow by top-left corner.
    return {
      ...node,
      position: {
        x: positioned.x - (node.width ?? NODE_WIDTH) / 2,
        y: positioned.y - (node.height ?? DEFAULT_HEIGHT) / 2,
      },
    };
  });
}

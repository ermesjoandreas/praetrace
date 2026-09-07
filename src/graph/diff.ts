import type { Graph, GraphEdge, GraphNode } from './types.js';

/**
 * What differs between two graphs of the same project — a commit's and the
 * working tree's, or two commits'. VISION.md's session diff: git shows lines,
 * this shows what happened to the shape.
 *
 * Every node is from one graph or the other, and which one is the fact that
 * matters most: a removed node is *the before graph's*, so a file that is no
 * longer on disk — and so is in no live graph — can still be drawn, as the
 * ghost CLAUDE.md said could not be. Lists are sorted by id, so two runs over
 * the same pair compare equal and a test can pin one.
 */
export interface GraphDiff {
  /** In `after` and not in `before` — files and symbols both, `after`'s nodes. */
  added: GraphNode[];
  /** In `before` and not in `after` — `before`'s nodes, which is what a ghost is drawn from. */
  removed: GraphNode[];
  /**
   * File nodes in both graphs whose part of the graph is not the same: the
   * file's own lines or warnings changed, a symbol of its was added, removed,
   * moved or redeclared, or an edge *from* it or one of its symbols came or
   * went. `after`'s nodes. An edge *to* a file does not touch it — a file
   * that gained an importer did nothing.
   *
   * What this cannot see: an edit that shifts no declaration and changes no
   * reference the graph resolved. That file reads as unchanged here, and git
   * is the tool for it.
   */
  touched: GraphNode[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
  counts: {
    files: { added: number; removed: number; touched: number };
    symbols: { added: number; removed: number };
    edges: { added: number; removed: number };
  };
}

/**
 * Set arithmetic over ids. Ids are stable across parses — `path`,
 * `path#name`, `path#Class.member` — so a node in both graphs is the same
 * declaration and a node in one is a declaration that came or went. The one
 * place that is not true is the `~2` suffix: two symbols sharing a name in
 * one file are told apart by document order, so the suffix names a
 * *position* among namesakes, never a declaration. Remove the first of two
 * overloads and this says `name~2` was removed and `name` moved — the right
 * count under the wrong name. Swap their order and both survive, and every
 * edge either one wrote reads as removed from one and added to the other.
 * The test beside this pins that reading rather than hiding it, and the
 * server's reply carries the same sentence for the panel.
 *
 * `contains` edges are not listed. A symbol is contained by exactly one
 * thing, which its id already spells, so the contains edges that came and
 * went are the nodes that did, and counting them would report a class that
 * gained a method as two changes.
 */
export function diffGraphs(before: Graph, after: Graph): GraphDiff {
  const added: GraphNode[] = [];
  const removed: GraphNode[] = [];
  /** Files the walk found a difference in, whichever kind of difference. */
  const touchedFiles = new Set<string>();

  for (const node of after.nodes.values()) {
    const was = before.nodes.get(node.id);
    if (was === undefined) {
      added.push(node);
      if (node.kind !== 'file') touchedFiles.add(node.filePath);
    } else if (!sameDeclaration(was, node)) {
      touchedFiles.add(node.filePath);
    }
  }
  for (const node of before.nodes.values()) {
    if (after.nodes.has(node.id)) continue;
    removed.push(node);
    if (node.kind !== 'file') touchedFiles.add(node.filePath);
  }

  const beforeEdges = keyed(before.edges);
  const afterEdges = keyed(after.edges);
  const addedEdges: GraphEdge[] = [];
  const removedEdges: GraphEdge[] = [];
  for (const [key, edge] of afterEdges) {
    if (beforeEdges.has(key)) continue;
    addedEdges.push(edge);
    const source = after.nodes.get(edge.from);
    if (source) touchedFiles.add(source.filePath);
  }
  for (const [key, edge] of beforeEdges) {
    if (afterEdges.has(key)) continue;
    removedEdges.push(edge);
    const source = before.nodes.get(edge.from);
    if (source) touchedFiles.add(source.filePath);
  }

  // A file that is itself new or gone is listed under that and not as touched:
  // every symbol of a new file is new, and "touched" would say it was there.
  const touched: GraphNode[] = [];
  for (const filePath of touchedFiles) {
    const now = after.nodes.get(filePath);
    if (now?.kind === 'file' && before.nodes.get(filePath)?.kind === 'file') touched.push(now);
  }

  added.sort(byId);
  removed.sort(byId);
  touched.sort(byId);
  addedEdges.sort(byEdge);
  removedEdges.sort(byEdge);

  const files = (nodes: readonly GraphNode[]): number => nodes.filter((node) => node.kind === 'file').length;
  return {
    added,
    removed,
    touched,
    addedEdges,
    removedEdges,
    counts: {
      files: { added: files(added), removed: files(removed), touched: touched.length },
      symbols: { added: added.length - files(added), removed: removed.length - files(removed) },
      edges: { added: addedEdges.length, removed: removedEdges.length },
    },
  };
}

/**
 * Whether two nodes with one id say the same thing about the declaration.
 * `modifiedAt` is left out: it is a clock, and a commit's graph is unpacked
 * moments before it is scanned, so it would touch every file at every commit.
 */
function sameDeclaration(a: GraphNode, b: GraphNode): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.range.startLine === b.range.startLine &&
    a.range.endLine === b.range.endLine &&
    a.owner === b.owner &&
    a.parseError === b.parseError &&
    a.visibility === b.visibility &&
    a.isStatic === b.isStatic &&
    a.isAbstract === b.isAbstract &&
    a.many === b.many &&
    a.optional === b.optional &&
    a.aliasOf === b.aliasOf &&
    a.unresolved?.imports === b.unresolved?.imports &&
    a.unresolved?.calls === b.unresolved?.calls
  );
}

/** One entry per (from, kind, to); `guessed` and `roles` describe an edge and do not identify it. */
function keyed(edges: readonly GraphEdge[]): Map<string, GraphEdge> {
  const map = new Map<string, GraphEdge>();
  for (const edge of edges) {
    if (edge.kind === 'contains') continue;
    const key = `${edge.from} ${edge.kind} ${edge.to}`;
    if (!map.has(key)) map.set(key, edge);
  }
  return map;
}

function byId(a: GraphNode, b: GraphNode): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byEdge(a: GraphEdge, b: GraphEdge): number {
  const left = `${a.from} ${a.kind} ${a.to}`;
  const right = `${b.from} ${b.kind} ${b.to}`;
  return left < right ? -1 : left > right ? 1 : 0;
}

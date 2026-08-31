import path from 'node:path';
import type { ParsedFile } from '../parser/types.js';
import type { Graph, GraphDelta, GraphEdge, GraphNode } from './types.js';
import { resolveImport } from './resolve.js';

/**
 * Holds the graph and the per-file parse results it is derived from.
 *
 * Parsing is incremental — only a changed file is re-parsed — but nodes and
 * edges are re-derived from the stored parse results on every mutation. That is
 * deliberate: derivation is pure in-memory work with no I/O and no AST, and it
 * sidesteps a whole class of stale-cross-reference bugs (a newly added file can
 * satisfy an import that failed to resolve earlier). If it ever shows up in a
 * profile, index the dependents and narrow the recompute.
 */
export interface GraphStore {
  readonly files: Map<string, ParsedFile>;
  graph: Graph;
}

export function createStore(): GraphStore {
  return { files: new Map(), graph: { nodes: new Map(), edges: [] } };
}

export function setFile(store: GraphStore, parsed: ParsedFile): GraphDelta {
  store.files.set(parsed.filePath, parsed);
  return commit(store);
}

export function removeFile(store: GraphStore, filePath: string): GraphDelta {
  if (!store.files.delete(filePath)) {
    return { upsertedNodes: [], removedNodeIds: [], addedEdges: [], removedEdges: [] };
  }
  return commit(store);
}

function commit(store: GraphStore): GraphDelta {
  const before = store.graph;
  store.graph = derive(store.files);
  return diff(before, store.graph);
}

/**
 * Two symbols sharing a name in one file are disambiguated by document order.
 * The id stays stable unless their relative order changes.
 */
function uniqueId(base: string, taken: ReadonlyMap<string, unknown>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}~${suffix}`)) suffix += 1;
  return `${base}~${suffix}`;
}

function derive(files: ReadonlyMap<string, ParsedFile>): Graph {
  const nodes = new Map<string, GraphNode>();
  const knownFiles = new Set(files.keys());
  /** filePath -> symbol name -> node id, for resolving references by name. */
  const symbolsByFile = new Map<string, Map<string, string>>();
  /** filePath -> node id per symbol, positionally aligned with ParsedFile.symbols. */
  const idsByFile = new Map<string, string[]>();

  // Pass 1: every node must exist before edges are resolved, or a reference to a
  // file that happens to be visited later would be dropped.
  for (const parsed of files.values()) {
    nodes.set(parsed.filePath, {
      id: parsed.filePath,
      kind: 'file',
      name: path.posix.basename(parsed.filePath),
      filePath: parsed.filePath,
      range: { startLine: 1, endLine: parsed.lineCount },
    });

    const byName = new Map<string, string>();
    const ids: string[] = [];

    for (const symbol of parsed.symbols) {
      const id = uniqueId(`${parsed.filePath}#${symbol.name}`, nodes);
      nodes.set(id, {
        id,
        kind: symbol.kind,
        name: symbol.name,
        filePath: parsed.filePath,
        range: { startLine: symbol.startLine, endLine: symbol.endLine },
      });
      ids.push(id);
      if (!byName.has(symbol.name)) byName.set(symbol.name, id);
    }

    symbolsByFile.set(parsed.filePath, byName);
    idsByFile.set(parsed.filePath, ids);
  }

  // Pass 2: edges.
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  function addEdge(from: string, to: string, kind: GraphEdge['kind']): void {
    // Self-edges (recursion, a file importing itself) carry no structural
    // information and only clutter the diagram.
    if (from === to) return;
    const key = `${from} ${kind} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  }

  for (const parsed of files.values()) {
    const importedFiles: string[] = [];
    for (const specifier of parsed.imports) {
      const target = resolveImport(parsed.filePath, specifier, knownFiles);
      if (target) {
        importedFiles.push(target);
        addEdge(parsed.filePath, target, 'imports');
      }
    }

    /** Own file wins, then whatever it imports. Unresolvable names are dropped. */
    const lookup = (name: string): string | null => {
      const own = symbolsByFile.get(parsed.filePath)?.get(name);
      if (own) return own;
      for (const imported of importedFiles) {
        const hit = symbolsByFile.get(imported)?.get(name);
        if (hit) return hit;
      }
      return null;
    };

    const ids = idsByFile.get(parsed.filePath) ?? [];
    parsed.symbols.forEach((symbol, index) => {
      const id = ids[index];
      if (!id) return;

      addEdge(parsed.filePath, id, 'contains');

      for (const name of symbol.extends) {
        const target = lookup(name);
        if (target) addEdge(id, target, 'extends');
      }
      for (const name of symbol.implements) {
        const target = lookup(name);
        if (target) addEdge(id, target, 'implements');
      }
      for (const name of symbol.calls) {
        const target = lookup(name);
        if (target) addEdge(id, target, 'calls');
      }
    });
  }

  return { nodes, edges };
}

function sameNode(a: GraphNode, b: GraphNode): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.range.startLine === b.range.startLine &&
    a.range.endLine === b.range.endLine
  );
}

const edgeKey = (edge: GraphEdge): string => `${edge.from} ${edge.kind} ${edge.to}`;

function diff(before: Graph, after: Graph): GraphDelta {
  const upsertedNodes: GraphNode[] = [];
  for (const [id, node] of after.nodes) {
    const previous = before.nodes.get(id);
    if (!previous || !sameNode(previous, node)) upsertedNodes.push(node);
  }

  const removedNodeIds: string[] = [];
  for (const id of before.nodes.keys()) {
    if (!after.nodes.has(id)) removedNodeIds.push(id);
  }

  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));

  return {
    upsertedNodes,
    removedNodeIds,
    addedEdges: after.edges.filter((edge) => !beforeEdges.has(edgeKey(edge))),
    removedEdges: before.edges.filter((edge) => !afterEdges.has(edgeKey(edge))),
  };
}

/**
 * Insert many files and derive once. Used by the boot scan, where per-file
 * commits would re-derive the whole graph for every file.
 */
export function setFiles(store: GraphStore, parsed: readonly ParsedFile[]): GraphDelta {
  for (const file of parsed) store.files.set(file.filePath, file);
  return commit(store);
}

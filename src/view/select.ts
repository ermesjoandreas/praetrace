import type { Graph } from '../graph/types.js';
import type { ViewEdge, ViewGraph, ViewMember, ViewNode, ViewSpec } from './types.js';

/**
 * Above this many files in scope, boxes stand for directories instead. Chosen
 * so a view stays readable, not because anything breaks past it.
 */
const GROUP_THRESHOLD = 40;

/**
 * Reduce the whole graph to the slice the page should draw.
 *
 * The graph stays the single source of truth; this derives a smaller
 * presentation graph from it. It is a separate type from `Graph` on purpose:
 * a box standing for a directory is not a `GraphNode`, and an aggregated edge
 * needs a weight the core model has no business carrying.
 *
 * Pure, so a view can be checked without a browser.
 */
export function selectView(graph: Graph, spec: ViewSpec): ViewGraph {
  const files = collectFiles(graph);
  const edges = liftEdgesToFiles(graph);

  if (spec.focus !== null && files.has(spec.focus)) {
    return focusView(spec, files, edges);
  }
  return scopeView(spec, files, edges);
}

interface FileEdge {
  from: string;
  to: string;
  kind: ViewEdge['kind'];
  weight: number;
}

/** File path -> the symbols it declares, in declaration order. */
function collectFiles(graph: Graph): Map<string, ViewMember[]> {
  const files = new Map<string, ViewMember[]>();

  for (const node of graph.nodes.values()) {
    if (node.kind === 'file') {
      if (!files.has(node.filePath)) files.set(node.filePath, []);
    }
  }
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file') continue;
    files.get(node.filePath)?.push({ name: node.name, kind: node.kind, line: node.range.startLine });
  }

  return files;
}

/**
 * Collapse symbol-level edges onto the files that hold them.
 *
 * `contains` is structural and `calls` is dropped: at file granularity a call
 * into another file is already implied by the import edge beside it.
 */
function liftEdgesToFiles(graph: Graph): FileEdge[] {
  const byKey = new Map<string, FileEdge>();

  for (const edge of graph.edges) {
    if (edge.kind === 'contains' || edge.kind === 'calls') continue;

    const from = graph.nodes.get(edge.from)?.filePath;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (!from || !to || from === to) continue;

    const key = `${from} ${edge.kind} ${to}`;
    const existing = byKey.get(key);
    if (existing) existing.weight += 1;
    else byKey.set(key, { from, to, kind: edge.kind, weight: 1 });
  }

  return [...byKey.values()];
}

function fileNode(filePath: string, members: ViewMember[], focused: boolean): ViewNode {
  return {
    id: filePath,
    kind: 'file',
    label: filePath,
    members,
    files: [filePath],
    external: false,
    focused,
  };
}

// --- focus mode ---------------------------------------------------------

function focusView(
  spec: ViewSpec,
  files: ReadonlyMap<string, ViewMember[]>,
  edges: readonly FileEdge[],
): ViewGraph {
  const focus = spec.focus ?? '';
  const neighbours = new Map<string, Set<string>>();

  // Undirected: what a file pulls in and what pulls it in are both context.
  for (const edge of edges) {
    (neighbours.get(edge.from) ?? setIn(neighbours, edge.from)).add(edge.to);
    (neighbours.get(edge.to) ?? setIn(neighbours, edge.to)).add(edge.from);
  }

  const reached = new Set<string>([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < spec.depth; hop += 1) {
    const next: string[] = [];
    for (const current of frontier) {
      for (const neighbour of neighbours.get(current) ?? []) {
        if (reached.has(neighbour)) continue;
        reached.add(neighbour);
        next.push(neighbour);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  const nodes = [...reached]
    .sort()
    .map((filePath) => fileNode(filePath, files.get(filePath) ?? [], filePath === focus));

  const kept = edges
    .filter((edge) => reached.has(edge.from) && reached.has(edge.to))
    .map(({ from, to, kind, weight }) => ({ from, to, kind, weight }));

  return {
    nodes,
    edges: kept,
    spec: { ...spec, focus },
    trail: trailFor(''),
    totalFiles: reached.size,
    grouped: false,
  };
}

function setIn(map: Map<string, Set<string>>, key: string): Set<string> {
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

// --- scope mode ---------------------------------------------------------

function scopeView(
  spec: ViewSpec,
  files: ReadonlyMap<string, ViewMember[]>,
  edges: readonly FileEdge[],
): ViewGraph {
  const allPaths = [...files.keys()].sort();
  const scope = descend(normaliseScope(spec.scope), allPaths);
  const prefix = scope === '' ? '' : `${scope}/`;

  const inScope = allPaths.filter((filePath) => filePath.startsWith(prefix));
  const inScopeSet = new Set(inScope);
  const grouped = inScope.length > GROUP_THRESHOLD;

  const nodes = new Map<string, ViewNode>();
  // Distinct files behind each box. A folder reached through five edges still
  // stands for however many files it actually holds, not five.
  const backing = new Map<string, Set<string>>();

  const nodeFor = (filePath: string): ViewNode | null => {
    const inside = inScopeSet.has(filePath);
    // Files outside the scope collapse to their directory: enough to show what
    // the scope connects to, without dragging the rest of the project in.
    const target = inside
      ? grouped
        ? groupOf(filePath, prefix)
        : { id: filePath, kind: 'file' as const }
      : parentOf(filePath);

    (backing.get(target.id) ?? setIn(backing, target.id)).add(filePath);

    const existing = nodes.get(target.id);
    if (existing) return existing;

    const created: ViewNode = {
      id: target.id,
      kind: target.kind,
      label: target.id === '' ? '.' : labelFor(target.id, prefix, inside),
      members: target.kind === 'file' ? (files.get(filePath) ?? []) : [],
      files: [],
      external: !inside,
      focused: false,
    };
    nodes.set(target.id, created);
    return created;
  };

  for (const filePath of inScope) nodeFor(filePath);

  const aggregated = new Map<string, ViewEdge>();
  for (const edge of edges) {
    if (!inScopeSet.has(edge.from) && !inScopeSet.has(edge.to)) continue;

    const from = nodeFor(edge.from);
    const to = nodeFor(edge.to);
    if (!from || !to || from.id === to.id) continue;

    const key = `${from.id} ${edge.kind} ${to.id}`;
    const existing = aggregated.get(key);
    if (existing) existing.weight += edge.weight;
    else aggregated.set(key, { from: from.id, to: to.id, kind: edge.kind, weight: edge.weight });
  }

  for (const node of nodes.values()) {
    node.files = [...(backing.get(node.id) ?? [])].sort();
  }

  const boxes = [...nodes.values()].sort(byExternalThenId);

  return {
    nodes: boxes,
    edges: [...aggregated.values()],
    spec: { scope, focus: null, depth: spec.depth },
    trail: trailFor(scope),
    totalFiles: inScope.length,
    // Whether grouping actually happened, not whether it was attempted. A flat
    // directory above the threshold has no subdirectories to group by, so every
    // file stays its own box and calling that "grouped" would be a lie.
    grouped: boxes.some((node) => node.kind === 'folder' && !node.external),
  };
}

/**
 * Walk past directories whose whole content is one subdirectory, so the view
 * never opens on a single box the user has to click through.
 */
function descend(scope: string, allPaths: readonly string[]): string {
  let current = scope;

  for (let guard = 0; guard < 64; guard += 1) {
    const prefix = current === '' ? '' : `${current}/`;
    const inScope = allPaths.filter((filePath) => filePath.startsWith(prefix));
    if (inScope.length === 0) return current;

    const groups = new Set(inScope.map((filePath) => groupOf(filePath, prefix).id));
    const only = [...groups][0];
    if (groups.size !== 1 || only === undefined || only === current) return current;
    // A single group that is a file means the directory holds one file: stop.
    if (!inScope.some((filePath) => filePath.startsWith(`${only}/`))) return current;
    current = only;
  }

  return current;
}

function groupOf(filePath: string, prefix: string): { id: string; kind: 'file' | 'folder' } {
  const rest = filePath.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash === -1) return { id: filePath, kind: 'file' };
  return { id: `${prefix}${rest.slice(0, slash)}`, kind: 'folder' };
}

function parentOf(filePath: string): { id: string; kind: 'file' | 'folder' } {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? { id: filePath, kind: 'file' } : { id: filePath.slice(0, slash), kind: 'folder' };
}

/** Inside the scope only the part below it is new information. */
function labelFor(id: string, prefix: string, inside: boolean): string {
  return inside && id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

function normaliseScope(scope: string): string {
  return scope.replace(/^\/+|\/+$/g, '');
}

function trailFor(scope: string): { label: string; scope: string }[] {
  const trail = [{ label: 'root', scope: '' }];
  if (scope === '') return trail;

  const segments = scope.split('/');
  let accumulated = '';
  for (const segment of segments) {
    accumulated = accumulated === '' ? segment : `${accumulated}/${segment}`;
    trail.push({ label: segment, scope: accumulated });
  }
  return trail;
}

/** External context sinks to the end so the scope's own files read first. */
function byExternalThenId(a: ViewNode, b: ViewNode): number {
  if (a.external !== b.external) return a.external ? 1 : -1;
  return a.id.localeCompare(b.id);
}

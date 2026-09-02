import type { GitStatus } from '../git/types.js';
import type { Graph } from '../graph/types.js';
import { languageFor } from '../lang/registry.js';
import type { LanguageId, LanguageSupport } from '../lang/types.js';
import { keepsEdge, keepsFile, keepsKind, type ViewFilter } from './filter.js';
import type { LanguageCount, ViewEdge, ViewGraph, ViewMember, ViewNode, ViewSpec } from './types.js';

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
 * Pure, so a view can be checked without a browser. That is also why the git
 * status arrives as an argument: reading it shells out, and the view layer is
 * the wrong place for I/O. It defaults to null because a project that is not a
 * work tree is normal, not an error.
 */
export function selectView(
  graph: Graph,
  spec: ViewSpec,
  now: number,
  git: GitStatus | null = null,
): ViewGraph {
  // One set, built once and threaded down: every lookup below is a membership
  // test, and Object.keys on each file would be the whole cost of the view.
  const changed = git ? new Set(Object.keys(git.files)) : null;

  const files = collectFiles(graph, spec.filter, now, changed);
  // Edges to a file the filter removed would point at a box that is not there.
  const edges = liftEdgesToFiles(graph, spec.filter).filter(
    (edge) => files.has(edge.from) && files.has(edge.to),
  );

  const slice =
    spec.focus !== null && files.has(spec.focus)
      ? focusView(spec, files, edges, git, changed)
      : scopeView(spec, files, edges, git, changed);

  // Added here rather than threaded through both: it is a fact about the
  // project, not about the slice, so neither of them has any business
  // computing it — and computing it twice is how the two would disagree.
  // `at` is echoed, not acted on: the caller chose which graph this is.
  return { ...slice, languages: projectLanguages(graph), at: spec.at };
}

/** Everything a slice decides for itself; the project-wide facts land after. */
type Slice = Omit<ViewGraph, 'languages' | 'at'>;

/**
 * Read back off the path rather than carried on the node.
 *
 * `parseSource` picks a language with this same function, so for any file the
 * graph holds the two cannot disagree. A `language` on every GraphNode would be
 * a second copy of that answer, and a second copy is a thing that can drift.
 */
function languageOf(filePath: string): LanguageId | null {
  return languageFor(filePath)?.id ?? null;
}

/** The one language a box's files share, or null the moment two of them differ. */
function soleLanguage(files: readonly string[]): LanguageId | null {
  let only: LanguageId | null = null;
  for (const file of files) {
    const id = languageOf(file);
    if (id === null || (only !== null && only !== id)) return null;
    only = id;
  }
  return only;
}

/**
 * Over the whole graph, so the filter and the scope cannot change the answer.
 * Exported for the Repository panel, which asks the same question of the same
 * graph and must not get a second answer.
 */
export function projectLanguages(graph: Graph): LanguageCount[] {
  const counted = new Map<LanguageSupport, number>();

  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file') continue;
    const language = languageFor(node.filePath);
    if (language) counted.set(language, (counted.get(language) ?? 0) + 1);
  }

  return [...counted]
    .map(([language, files]) => ({ id: language.id, label: language.label, files }))
    // Ties broken by name, or two languages with the same count would swap
    // places in the header every time a file was saved.
    .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id));
}

/**
 * The project-wide count, not the count in this slice: the chip beside it says
 * "vs <base>", and a number that shrank because you navigated into a directory
 * would read as work disappearing.
 */
function gitSummary(git: GitStatus | null): ViewGraph['git'] {
  if (git === null) return null;
  return {
    base: git.base,
    requested: git.requested,
    branch: git.branch,
    changed: Object.keys(git.files).length,
  };
}

interface FileEdge {
  from: string;
  to: string;
  kind: ViewEdge['kind'];
  weight: number;
}

/**
 * The class a member belongs to, read back off its id rather than carried on
 * the node. The id already encodes it — `path#Class.member` — and a second
 * copy on every node in the graph could disagree with the first.
 */
function ownerOf(graph: Graph, id: string): string | null {
  const hash = id.indexOf('#');
  if (hash === -1) return null;
  const dot = id.indexOf('.', hash);
  return dot === -1 ? null : id.slice(hash + 1, dot);
}

/** File path -> the symbols it declares, in declaration order. */
function collectFiles(
  graph: Graph,
  filter: ViewFilter,
  now: number,
  changed: ReadonlySet<string> | null,
): Map<string, ViewMember[]> {
  const files = new Map<string, ViewMember[]>();

  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file') continue;
    if (!keepsFile(node.filePath, node.modifiedAt ?? 0, filter, now, changed)) continue;
    if (!files.has(node.filePath)) files.set(node.filePath, []);
  }
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' || !keepsKind(node.kind, filter)) continue;
    files.get(node.filePath)?.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      line: node.range.startLine,
      owner: ownerOf(graph, node.id),
      visibility: node.visibility ?? null,
      isStatic: node.isStatic === true,
      isAbstract: node.isAbstract === true,
    });
  }

  // With a kind filter on, a file left holding nothing is not worth a box.
  if (filter.kinds.length > 0) {
    for (const [filePath, members] of [...files]) {
      if (members.length === 0) files.delete(filePath);
    }
  }

  return files;
}

/**
 * Collapse symbol-level edges onto the files that hold them.
 *
 * `contains` is structural and never drawn. `calls` and `associates` are
 * drawn only when asked for, and each then *replaces* the import between the
 * same pair: two edges would take the same path on screen, and "calls twelve
 * things in here", or "holds one of those", says more than "imported a type
 * from here", which is all an import on its own tells you.
 */
function liftEdgesToFiles(graph: Graph, filter: ViewFilter): FileEdge[] {
  const byKey = new Map<string, FileEdge>();

  for (const edge of graph.edges) {
    if (edge.kind === 'contains' || !keepsEdge(edge.kind, filter)) continue;

    const from = graph.nodes.get(edge.from)?.filePath;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (!from || !to || from === to) continue;

    const key = `${from} ${edge.kind} ${to}`;
    const existing = byKey.get(key);
    if (existing) existing.weight += 1;
    else byKey.set(key, { from, to, kind: edge.kind, weight: 1 });
  }

  const lifted = [...byKey.values()];
  // Whichever detail edges the filter let through; each hides the import that
  // runs the same way, and neither is on by default.
  const detail = new Set(
    lifted
      .filter((edge) => edge.kind === 'calls' || edge.kind === 'associates')
      .map((edge) => `${edge.from} ${edge.to}`),
  );
  if (detail.size === 0) return lifted;

  return lifted.filter(
    (edge) => edge.kind !== 'imports' || !detail.has(`${edge.from} ${edge.to}`),
  );
}

function fileNode(
  filePath: string,
  members: ViewMember[],
  focused: boolean,
  git: GitStatus | null,
): ViewNode {
  const gitStatus = git?.files[filePath] ?? null;
  return {
    id: filePath,
    kind: 'file',
    label: filePath,
    members,
    files: [filePath],
    external: false,
    focused,
    gitStatus,
    gitChanged: gitStatus ? 1 : 0,
    language: languageOf(filePath),
  };
}

// --- focus mode ---------------------------------------------------------

function focusView(
  spec: ViewSpec,
  files: ReadonlyMap<string, ViewMember[]>,
  edges: readonly FileEdge[],
  git: GitStatus | null,
  _changed: ReadonlySet<string> | null,
): Slice {
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
    .map((filePath) => fileNode(filePath, files.get(filePath) ?? [], filePath === focus, git));

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
    git: gitSummary(git),
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
  git: GitStatus | null,
  changed: ReadonlySet<string> | null,
): Slice {
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
      gitStatus: target.kind === 'file' ? (git?.files[target.id] ?? null) : null,
      // Both filled in from `backing` below, once the box knows which files it
      // actually stands for — neither can be answered from the first one seen.
      gitChanged: 0,
      language: null,
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
    node.language = soleLanguage(node.files);
    if (changed !== null) node.gitChanged = node.files.filter((file) => changed.has(file)).length;
  }

  const boxes = [...nodes.values()].sort(byExternalThenId);

  return {
    nodes: boxes,
    edges: [...aggregated.values()],
    spec: { scope, focus: null, depth: spec.depth, filter: spec.filter, at: spec.at },
    trail: trailFor(scope),
    totalFiles: inScope.length,
    // Whether grouping actually happened, not whether it was attempted. A flat
    // directory above the threshold has no subdirectories to group by, so every
    // file stays its own box and calling that "grouped" would be a lie.
    grouped: boxes.some((node) => node.kind === 'folder' && !node.external),
    git: gitSummary(git),
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

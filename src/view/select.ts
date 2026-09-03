import type { Coverage, FileCoverage } from '../report/types.js';
import type { GitStatus } from '../git/types.js';
import type { Graph } from '../graph/types.js';
import { languageFor } from '../lang/registry.js';
import type { LanguageId, LanguageSupport } from '../lang/types.js';
import { keepsEdge, keepsFile, keepsKind, type ViewFilter } from './filter.js';
import { isTestFile } from './tests.js';
import type { LanguageCount, ViewEdge, ViewGraph, ViewMember, ViewNode, ViewSpec } from './types.js';

/**
 * Above this many files in scope, boxes stand for directories instead. Chosen
 * so a view stays readable, not because anything breaks past it.
 */
const GROUP_THRESHOLD = 40;

/**
 * Past this many neighbours in one direction at one hop, a focus view draws a
 * bundle standing for them instead of a box each.
 *
 * Ten is Sourcetrail's number for the same call — it bundled referencing
 * symbols at ten — and it sits above the 95th percentile of what a depth-1
 * focus view actually draws: 10 boxes on zod, 11 on TanStack/query, 4 on
 * express, against maxima of 115, 278 and 98. So the ordinary view is left
 * alone and the unreadable one collapses. That is the judgement borrowed and
 * not just the number: below this the neighbours *are* the answer, and a
 * stand-in for three files says less than the three files do.
 */
const BUNDLE_THRESHOLD = 10;

/**
 * The two things a bundle can stand for, spelled the way the box is labelled.
 *
 * Direction is the rule a bundle is named by, rather than "whatever was left
 * over": what a file leans on and what leans on it are two different questions,
 * and a reader with 278 neighbours wants them apart before anything else.
 */
type Direction = 'dependencies' | 'dependents';

const DIRECTIONS: readonly Direction[] = ['dependencies', 'dependents'];

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
 *
 * Coverage arrives the same way and for the same reason — it is read off a file
 * CI left behind — and null is again the ordinary case: most projects have no
 * report, and one that has none is not one where nothing ran.
 */
export function selectView(
  graph: Graph,
  spec: ViewSpec,
  now: number,
  git: GitStatus | null = null,
  coverage: Coverage | null = null,
): ViewGraph {
  // One set, built once and threaded down: every lookup below is a membership
  // test, and Object.keys on each file would be the whole cost of the view.
  const changed = git ? new Set(Object.keys(git.files)) : null;

  const files = collectFiles(graph, spec.filter, now, changed, coverage);
  // Edges to a file the filter removed would point at a box that is not there.
  const edges = liftEdgesToFiles(graph, spec.filter).filter(
    (edge) => files.has(edge.from) && files.has(edge.to),
  );

  const slice =
    spec.focus !== null && files.has(spec.focus)
      ? focusView(spec, files, edges, git, changed)
      : scopeView(spec, files, edges, git, changed);

  // After the slice, because "visible" is a question about what got drawn.
  markLinkedMembers(graph, spec.filter, slice);

  // Added here rather than threaded through both: they are facts about the
  // project, not about the slice, so neither of them has any business
  // computing them — and computing them twice is how the two would disagree.
  // `at` is echoed, not acted on: the caller chose which graph this is.
  return {
    ...slice,
    fileCount: countFiles(graph),
    hiddenTests: countHiddenTests(graph, spec.filter, now, changed),
    parseErrors: countParseErrors(graph),
    unresolved: countUnresolved(graph),
    languages: projectLanguages(graph),
    at: spec.at,
  };
}

/** Everything a slice decides for itself; the project-wide facts land after. */
type Slice = Omit<ViewGraph, 'languages' | 'at' | 'fileCount' | 'hiddenTests' | 'parseErrors' | 'unresolved'>;

/** What a file box is drawn from: its symbols, and whether the parse was clean. */
interface FileFacts {
  members: ViewMember[];
  parseError: boolean;
  /**
   * Carried here rather than looked up again where the box is built: focus
   * mode and scope mode make their file boxes in two different places, and the
   * report is joined once for both.
   */
  coverage?: FileCoverage;
  /** What this one file could not resolve — see `ViewNode.unresolved`. */
  unresolved?: { imports: number; calls: number };
}

/**
 * The two counts over a set of files, or nothing when they add up to nothing.
 *
 * A spread, so a box with everything resolved carries no property at all —
 * `exactOptionalPropertyTypes` holds that line, and a `{ imports: 0, calls: 0 }`
 * would put "0 unresolved" on every box in a healthy project.
 */
function unresolvedOf(
  filePaths: readonly string[],
  files: ReadonlyMap<string, FileFacts>,
): { unresolved?: { imports: number; calls: number } } {
  let imports = 0;
  let calls = 0;
  for (const filePath of filePaths) {
    const counts = files.get(filePath)?.unresolved;
    if (counts === undefined) continue;
    imports += counts.imports;
    calls += counts.calls;
  }
  return imports === 0 && calls === 0 ? {} : { unresolved: { imports, calls } };
}

/**
 * Fold one more reference into an edge that already stands for some.
 *
 * `guessed` survives only while every reference behind the line was a guess.
 * One that resolved through a binding makes the coupling itself certain, and a
 * line drawn as uncertain over a certain reference overstates the doubt just
 * as badly as dropping the flag would understate it.
 */
function absorb(edge: { weight: number; guessed?: true }, weight: number, guessed: boolean): void {
  edge.weight += weight;
  if (!guessed) delete edge.guessed;
}

function countFiles(graph: Graph): number {
  let count = 0;
  for (const node of graph.nodes.values()) if (node.kind === 'file') count += 1;
  return count;
}

/** Summed over the whole graph, not the slice: see ViewGraph.unresolved. */
function countUnresolved(graph: Graph): { imports: number; calls: number } {
  let imports = 0;
  let calls = 0;
  for (const node of graph.nodes.values()) {
    if (node.unresolved === undefined) continue;
    imports += node.unresolved.imports;
    calls += node.unresolved.calls;
  }
  return { imports, calls };
}

function countParseErrors(graph: Graph): number {
  let count = 0;
  for (const node of graph.nodes.values()) if (node.kind === 'file' && node.parseError === true) count += 1;
  return count;
}

/**
 * The tests the filter took away, and only those: a test the path or git
 * filter would have dropped anyway is not hidden by `hideTests`, and counting
 * it would promise more files than showing them again could deliver.
 */
function countHiddenTests(
  graph: Graph,
  filter: ViewFilter,
  now: number,
  changed: ReadonlySet<string> | null,
): number {
  if (!filter.hideTests) return 0;
  const otherwise: ViewFilter = { ...filter, hideTests: false };
  let count = 0;
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file' || !isTestFile(node.filePath)) continue;
    if (keepsFile(node.filePath, node.modifiedAt ?? 0, otherwise, now, changed)) count += 1;
  }
  return count;
}

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
  guessed?: true;
}

/** File path -> the symbols it declares, in declaration order. */
function collectFiles(
  graph: Graph,
  filter: ViewFilter,
  now: number,
  changed: ReadonlySet<string> | null,
  coverage: Coverage | null,
): Map<string, FileFacts> {
  const files = new Map<string, FileFacts>();

  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file') continue;
    if (!keepsFile(node.filePath, node.modifiedAt ?? 0, filter, now, changed)) continue;
    if (!files.has(node.filePath)) {
      const measured = coverage?.files[node.filePath];
      files.set(node.filePath, {
        members: [],
        parseError: node.parseError === true,
        // Spread rather than assigned, because `exactOptionalPropertyTypes`
        // holds the line this whole feature rests on: no data is no property,
        // and never an explicit nothing that reads as a measured zero.
        ...(measured === undefined ? {} : { coverage: measured }),
        ...(node.unresolved === undefined ? {} : { unresolved: node.unresolved }),
      });
    }
  }
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' || !keepsKind(node.kind, filter)) continue;
    const measured = coverage?.symbols[node.id];
    files.get(node.filePath)?.members.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      line: node.range.startLine,
      owner: node.owner ?? null,
      visibility: node.visibility ?? null,
      isStatic: node.isStatic === true,
      isAbstract: node.isAbstract === true,
      // 'unknown' is 3107 of zod's 4201 symbols, so it is the answer the row
      // is drawn without rather than one it carries.
      ...(measured === 'covered' || measured === 'never' ? { coverage: measured } : {}),
    });
  }

  // With a kind filter on, a file left holding nothing is not worth a box.
  if (filter.kinds.length > 0) {
    for (const [filePath, facts] of [...files]) {
      if (facts.members.length === 0) files.delete(filePath);
    }
  }

  return files;
}

/**
 * Mark the rows the arrows on this slice actually run through.
 *
 * The test is the edge on screen and nothing weaker: a kind the filter dropped
 * is not drawn, an edge to a file no box in this slice stands for is not drawn,
 * and a relation between two symbols of the same file writes no arrow between
 * boxes at all — the same three tests `liftEdgesToFiles` applies, asked one
 * level down. A mark that meant "linked to something, somewhere in the project"
 * would be true of nearly every symbol in a file that calls out at all, and
 * would sort nothing.
 *
 * So it runs last, on the boxes rather than on the graph, and it edits the
 * member rows in place — the objects this module made moments ago, the way
 * `scopeView` fills its own boxes in from `backing`.
 */
function markLinkedMembers(graph: Graph, filter: ViewFilter, slice: Slice): void {
  const rows = new Map<string, ViewMember>();
  const inSlice = new Set<string>();
  for (const node of slice.nodes) {
    for (const file of node.files) inSlice.add(file);
    for (const member of node.members) rows.set(member.id, member);
  }
  // A grouped view draws folders, which have no rows to choose between.
  if (rows.size === 0) return;

  for (const edge of graph.edges) {
    if (edge.kind === 'contains' || !keepsEdge(edge.kind, filter)) continue;
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    if (!from || !to || from.filePath === to.filePath) continue;
    if (!inSlice.has(from.filePath) || !inSlice.has(to.filePath)) continue;
    // An end that is a file — a call written outside every symbol — has no row
    // to mark, and asking for one is how it says so.
    const source = rows.get(edge.from);
    if (source) source.linked = true;
    const target = rows.get(edge.to);
    if (target) target.linked = true;
  }
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
    if (existing) absorb(existing, 1, edge.guessed === true);
    else {
      byKey.set(key, {
        from,
        to,
        kind: edge.kind,
        weight: 1,
        ...(edge.guessed === true ? { guessed: true as const } : {}),
      });
    }
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
  facts: FileFacts | undefined,
  focused: boolean,
  git: GitStatus | null,
): ViewNode {
  const gitStatus = git?.files[filePath] ?? null;
  return {
    id: filePath,
    kind: 'file',
    label: filePath,
    members: facts?.members ?? [],
    files: [filePath],
    external: false,
    focused,
    gitStatus,
    gitChanged: gitStatus ? 1 : 0,
    language: languageOf(filePath),
    test: isTestFile(filePath),
    parseError: facts?.parseError === true,
    ...(facts?.coverage === undefined ? {} : { coverage: facts.coverage }),
    ...(facts?.unresolved === undefined ? {} : { unresolved: facts.unresolved }),
  };
}

// --- focus mode ---------------------------------------------------------

function focusView(
  spec: ViewSpec,
  files: ReadonlyMap<string, FileFacts>,
  edges: readonly FileEdge[],
  git: GitStatus | null,
  changed: ReadonlySet<string> | null,
): Slice {
  const focus = spec.focus ?? '';

  // Both directions, kept apart: what a file leans on and what leans on it are
  // both context, and which of the two a neighbour is decides the bundle it
  // lands in when there are too many to draw.
  const uses = new Map<string, Set<string>>();
  const usedBy = new Map<string, Set<string>>();
  for (const edge of edges) {
    (uses.get(edge.from) ?? setIn(uses, edge.from)).add(edge.to);
    (usedBy.get(edge.to) ?? setIn(usedBy, edge.to)).add(edge.from);
  }

  /** Files that get a box of their own. */
  const drawn = new Set<string>([focus]);
  /** File -> the bundle standing in for it. */
  const bundled = new Map<string, string>();
  const bundles: { id: string; direction: Direction; files: string[] }[] = [];
  /** Everything the walk has accounted for, drawn or bundled. */
  const reached = new Set<string>([focus]);

  let frontier = [focus];
  for (let hop = 1; hop <= spec.depth; hop += 1) {
    const found: Record<Direction, string[]> = { dependencies: [], dependents: [] };
    // Dependencies first, and claimed as they are found, so a file reachable
    // both ways is a dependency: that is the claim the drawn boxes make about
    // it, where the other direction is a claim it makes about them.
    for (const direction of DIRECTIONS) {
      const outward = direction === 'dependencies' ? uses : usedBy;
      for (const current of frontier) {
        for (const neighbour of outward.get(current) ?? []) {
          if (reached.has(neighbour)) continue;
          reached.add(neighbour);
          found[direction].push(neighbour);
        }
      }
    }

    const advanced: string[] = [];
    for (const direction of DIRECTIONS) {
      const hits = found[direction];
      if (hits.length === 0) continue;
      if (hits.length > BUNDLE_THRESHOLD) {
        // Named for the hop and the direction, not for what is in it, so the
        // box keeps its identity — and its place on the canvas — as files join
        // and leave it. The same reason a stored group is not addressed by the
        // cluster id that embeds its member count.
        const id = `bundle:${direction}:${hop}`;
        bundles.push({ id, direction, files: hits.sort() });
        for (const filePath of hits) bundled.set(filePath, id);
        // Deliberately not pushed onto `advanced`: a bundle is a leaf. Walking
        // on from files this view has already declined to draw would pull in
        // their neighbours to hang off a box that stands for all of them.
      } else {
        for (const filePath of hits) drawn.add(filePath);
        advanced.push(...hits);
      }
    }
    if (advanced.length === 0) break;
    frontier = advanced;
  }

  const nodes = [...drawn]
    .sort()
    .map((filePath) => fileNode(filePath, files.get(filePath), filePath === focus, git));
  // After the files, in the order the walk made them: a stand-in reads as the
  // edge of the picture, not as one more box among the ones it replaced.
  for (const bundle of bundles) {
    nodes.push(bundleNode(bundle.id, bundle.direction, bundle.files, files, changed));
  }

  const boxOf = (filePath: string): string => bundled.get(filePath) ?? filePath;

  const aggregated = new Map<string, ViewEdge>();
  for (const edge of edges) {
    if (!reached.has(edge.from) || !reached.has(edge.to)) continue;
    const from = boxOf(edge.from);
    const to = boxOf(edge.to);
    // Two files inside one bundle: the coupling is real and entirely inside a
    // box that stands for both ends, so there is nothing to draw it between.
    if (from === to) continue;

    const key = `${from} ${edge.kind} ${to}`;
    const existing = aggregated.get(key);
    if (existing) absorb(existing, edge.weight, edge.guessed === true);
    else {
      aggregated.set(key, {
        from,
        to,
        kind: edge.kind,
        weight: edge.weight,
        ...(edge.guessed === true ? { guessed: true as const } : {}),
      });
    }
  }

  return {
    nodes,
    edges: [...aggregated.values()],
    spec: { ...spec, focus },
    trail: trailFor(''),
    // Every file in the slice, bundled ones included. The status bar reads it
    // beside the box count, and "3 boxes · 116 files" is the whole point.
    totalFiles: reached.size,
    // Grouping is boxes standing for directories, which this is not. A page
    // that wants to know whether anything was bundled asks the nodes.
    grouped: false,
    git: gitSummary(git),
  };
}

/**
 * A box standing for neighbours there were too many of to draw.
 *
 * It answers what a folder box answers, over a different set: how many, how
 * much of it moved, what it is written in, whether the parse held. No members —
 * it stands for many files, and one file's symbols would be a sample presented
 * as the whole. No coverage either, for the reason a folder has none.
 */
function bundleNode(
  id: string,
  direction: Direction,
  filePaths: string[],
  files: ReadonlyMap<string, FileFacts>,
  changed: ReadonlySet<string> | null,
): ViewNode {
  return {
    id,
    kind: 'bundle',
    // The count and the word for the relationship, which is all a stand-in has
    // to say. `dependencies` and `dependents` are the panel's own words for
    // these two sets, so the box and the side bar do not name them differently.
    label: `${filePaths.length} ${direction}`,
    members: [],
    files: filePaths,
    external: false,
    focused: false,
    gitStatus: null,
    gitChanged: changed === null ? 0 : filePaths.filter((file) => changed.has(file)).length,
    language: soleLanguage(filePaths),
    test: filePaths.every(isTestFile),
    parseError: filePaths.some((file) => files.get(file)?.parseError === true),
    ...unresolvedOf(filePaths, files),
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
  files: ReadonlyMap<string, FileFacts>,
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

    // A folder box gets none: its files may have been measured by different
    // runs, or not at all, and one number over the pile would claim more than
    // the report said.
    const measured = target.kind === 'file' ? files.get(filePath)?.coverage : undefined;

    const created: ViewNode = {
      id: target.id,
      kind: target.kind,
      label: target.id === '' ? '.' : labelFor(target.id, prefix, inside),
      members: target.kind === 'file' ? (files.get(filePath)?.members ?? []) : [],
      files: [],
      external: !inside,
      focused: false,
      gitStatus: target.kind === 'file' ? (git?.files[target.id] ?? null) : null,
      // All filled in from `backing` below, once the box knows which files it
      // actually stands for — none can be answered from the first one seen.
      gitChanged: 0,
      language: null,
      test: false,
      parseError: false,
      ...(measured === undefined ? {} : { coverage: measured }),
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
    if (existing) absorb(existing, edge.weight, edge.guessed === true);
    else {
      aggregated.set(key, {
        from: from.id,
        to: to.id,
        kind: edge.kind,
        weight: edge.weight,
        ...(edge.guessed === true ? { guessed: true as const } : {}),
      });
    }
  }

  for (const node of nodes.values()) {
    node.files = [...(backing.get(node.id) ?? [])].sort();
    node.language = soleLanguage(node.files);
    node.test = node.files.every(isTestFile);
    node.parseError = node.files.some((file) => files.get(file)?.parseError === true);
    if (changed !== null) node.gitChanged = node.files.filter((file) => changed.has(file)).length;
    // Assigned rather than spread, because the box already exists — and only
    // when there is something to say, so a clean box keeps no property.
    const counts = unresolvedOf(node.files, files).unresolved;
    if (counts !== undefined) node.unresolved = counts;
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

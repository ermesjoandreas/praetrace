import type { GitStatus } from '../git/types.js';
import type { GraphDiff } from '../graph/diff.js';
import type { AssociationRole, Graph, GraphEdge, GraphNode } from '../graph/types.js';
import { languageFor } from '../lang/registry.js';
import { keepsEdge, keepsFile, keepsKind, type ViewFilter } from './filter.js';
import { ownershipOf, presentationOf, projectLanguages } from './select.js';
import { isTestFile } from './tests.js';
import type { ViewEdge, ViewGraph, ViewMember, ViewNode, ViewSpec } from './types.js';

/**
 * What happened to a box, a row or a line between two graphs.
 *
 * These four types are `ViewNode`, `ViewMember`, `ViewEdge` and `ViewGraph`
 * with one field each, held here until `view/types.ts` carries `change`
 * itself — the diff page owns that file, and the exact additions are in the
 * notes handed to it. Each extends the type it stands in for, so a
 * `DiffViewGraph` is a `ViewGraph` to every reader that does not ask, and
 * the day the field moves these collapse into aliases.
 */
export type Change = 'added' | 'removed' | 'touched';

export interface DiffViewMember extends ViewMember {
  /** Absent on a row that is in both graphs — a row is never "touched", because a line moved is not news. */
  change?: 'added' | 'removed';
}

export interface DiffViewNode extends ViewNode {
  members: DiffViewMember[];
  /**
   * Absent on a context box: the far end of a line that changed, drawn
   * `external` — dimmed, no members — because a line needs two ends and
   * that file did nothing. A removed box is the ghost, built from the
   * *before* graph, which is the only place it still exists.
   */
  change?: Change;
}

export interface DiffViewEdge extends ViewEdge {
  /** Solid for added, dashed for removed. A line in both graphs is not drawn. */
  change: 'added' | 'removed';
}

export interface DiffViewGraph extends ViewGraph {
  nodes: DiffViewNode[];
  edges: DiffViewEdge[];
}

/**
 * The boxes that differ, and only those.
 *
 * Every file the diff names gets a box: added ones from `after`, removed ones
 * from `before`, touched ones from `after` with the rows `before` had and
 * `after` has not appended and marked, so a class that lost a method shows
 * it. Every edge that came or went is a line, lifted onto files and summed
 * the way `selectView` lifts them; a far end the diff does not name is drawn
 * as context. Nothing else is on the canvas — not the scope, not the focus:
 * a diff is a slice of the whole project, and the echoed spec says so.
 *
 * The filter is honoured the way every view honours it, for paths, tests
 * and edge kinds. `sinceMs` and `onlyChanged` are lifted: this view is
 * already "only what changed", and a ghost has no clock and no status to
 * pass either by. Coverage is not joined, because a report describes the
 * working tree and half these boxes are not in it.
 *
 * Pure, like `selectView`, and for the same reason: two graphs in, a picture
 * out, nothing read off disk — so the same pair drawn twice is the same
 * picture, and a test can pin one.
 */
export function diffView(
  diff: GraphDiff,
  before: Graph,
  after: Graph,
  spec: ViewSpec,
  git: GitStatus | null = null,
): DiffViewGraph {
  const filter: ViewFilter = { ...spec.filter, sinceMs: 0, onlyChanged: false };
  const keeps = (filePath: string): boolean => keepsFile(filePath, 0, filter, 0, null);

  const addedIds = new Set(diff.added.map((node) => node.id));
  const removedIds = new Set(diff.removed.map((node) => node.id));
  const membersBefore = membersByFile(before, filter);
  const membersAfter = membersByFile(after, filter);

  /** Every file the diff names, with what happened to it, before the filter. */
  const named = new Map<string, Change>();
  for (const node of diff.added) if (node.kind === 'file') named.set(node.filePath, 'added');
  for (const node of diff.removed) if (node.kind === 'file') named.set(node.filePath, 'removed');
  for (const node of diff.touched) named.set(node.filePath, 'touched');

  const boxes = new Map<string, DiffViewNode>();
  for (const [filePath, change] of named) {
    if (!keeps(filePath)) continue;
    const source = change === 'removed' ? before.nodes.get(filePath) : after.nodes.get(filePath);
    if (source === undefined) continue;

    const members: DiffViewMember[] =
      change === 'removed'
        ? (membersBefore.get(filePath) ?? []).map((row) => ({ ...row, change: 'removed' as const }))
        : (membersAfter.get(filePath) ?? []).map((row) =>
            addedIds.has(row.id) ? { ...row, change: 'added' as const } : row,
          );
    if (change === 'touched') {
      const gone = (membersBefore.get(filePath) ?? []).filter((row) => removedIds.has(row.id));
      for (const row of gone) placeRemoved(members, { ...row, change: 'removed' });
    }

    boxes.set(filePath, box(source, members, false, git, change));
  }

  // Lifted per change set, so a line that stands for an added call and a
  // removed call between the same two files is two lines, one of each — the
  // graph's edges did change twice, and one line saying "changed" would be
  // a third state nothing else in the view has.
  const edges = [
    ...liftEdges(diff.addedEdges, after, filter, 'added'),
    ...liftEdges(diff.removedEdges, before, filter, 'removed'),
  ].filter((edge) => keeps(edge.from) && keeps(edge.to));

  // The far ends. A file in both graphs that the diff does not name did
  // nothing; it is here so the line has somewhere to land, and it says so by
  // being external. Taken from `after` first: a context file is by
  // construction in both graphs, and if it were only in one it would be a
  // named box already.
  for (const edge of edges) {
    for (const end of [edge.from, edge.to]) {
      if (boxes.has(end)) continue;
      const source = after.nodes.get(end) ?? before.nodes.get(end);
      if (source?.kind === 'file') boxes.set(end, box(source, [], true, git));
    }
  }

  const nodes = [...boxes.values()].sort(byExternalThenId);
  const drawn = nodes.filter((node) => !node.external);

  return {
    nodes,
    edges,
    // Scope, focus and category are not slices of a diff, and an echo that
    // kept one would claim a narrowing this view did not apply.
    spec: {
      scope: '',
      focus: null,
      depth: spec.depth,
      filter: spec.filter,
      at: spec.at,
      diagram: spec.diagram,
      ...(spec.as === undefined ? {} : { as: spec.as }),
      ...(spec.diff === undefined ? {} : { diff: spec.diff }),
    },
    presentation: presentationOf(spec, nodes.length),
    trail: [{ label: 'root', scope: '' }],
    totalFiles: drawn.length,
    fileCount: countFiles(after),
    hiddenTests: countHiddenTests(named, filter),
    parseErrors: countParseErrors(after),
    unresolved: countUnresolved(after),
    scoped: scopedWarnings(drawn),
    grouped: false,
    languages: projectLanguages(after),
    git: git === null ? null : { base: git.base, requested: git.requested, branch: git.branch, changed: Object.keys(git.files).length },
    at: spec.at,
  };
}

/**
 * The tests the filter took away from this diff, and only those — the same
 * rule `selectView` applies: a test the path filter would have dropped anyway
 * is not counted, or the number would promise more boxes than showing them
 * again could draw.
 */
function countHiddenTests(named: ReadonlyMap<string, Change>, filter: ViewFilter): number {
  if (!filter.hideTests) return 0;
  const otherwise: ViewFilter = { ...filter, hideTests: false };
  let count = 0;
  for (const filePath of named.keys()) {
    if (isTestFile(filePath) && keepsFile(filePath, 0, otherwise, 0, null)) count += 1;
  }
  return count;
}

/**
 * File path -> the rows a box lists, in the order the graph holds them —
 * which is document order, because the store writes a file's symbols in the
 * order the parser found them. Built once over each graph rather than by
 * scanning the map per file.
 */
function membersByFile(graph: Graph, filter: ViewFilter): Map<string, ViewMember[]> {
  const byFile = new Map<string, ViewMember[]>();
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' || !keepsKind(node.kind, filter)) continue;
    let rows = byFile.get(node.filePath);
    if (rows === undefined) {
      rows = [];
      byFile.set(node.filePath, rows);
    }
    rows.push({
      id: node.id,
      name: node.name,
      kind: node.kind,
      line: node.range.startLine,
      owner: node.owner ?? null,
      visibility: node.visibility ?? null,
      isStatic: node.isStatic === true,
      isAbstract: node.isAbstract === true,
      ...(node.aliasOf === undefined ? {} : { aliasOf: node.aliasOf }),
    });
  }
  return byFile;
}

/**
 * Put a removed row where a reader looks for it: after the last row of the
 * same class, so a method that went sits under the class that had it; after
 * its class's own row when every member went with it; and at the end for a
 * top-level symbol. Its `line` is the before graph's and cannot be sorted
 * against the others, which is why this is by owner and not by line.
 */
function placeRemoved(rows: DiffViewMember[], removed: DiffViewMember): void {
  let at = -1;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row === undefined) continue;
    if (row.owner === removed.owner) {
      at = index;
      break;
    }
    if (removed.owner !== null && row.owner === null && row.name === removed.owner) {
      at = index;
      break;
    }
  }
  if (at === -1 || removed.owner === null) rows.push(removed);
  else rows.splice(at + 1, 0, removed);
}

interface Lifted {
  from: string;
  to: string;
  kind: ViewEdge['kind'];
  weight: number;
  guessed?: true;
  roles?: AssociationRole[];
}

/**
 * Graph edges onto file pairs, the three rules `selectView` applies asked of
 * one change set: `contains` is never drawn (and the diff never lists it),
 * a kind the filter dropped is not drawn, and a relation inside one file
 * writes no line between boxes. A call or an association between a pair
 * hides the import between the same pair, as it does on every other view —
 * within one change set, since an added call says nothing about a removed
 * import. `guessed` survives only while every reference behind the line
 * was a guess, and the roles are copied, both for the reasons `absorb` and
 * `rolesOf` give in `select.ts`.
 */
function liftEdges(
  edges: readonly GraphEdge[],
  graph: Graph,
  filter: ViewFilter,
  change: 'added' | 'removed',
): DiffViewEdge[] {
  const byKey = new Map<string, Lifted>();
  for (const edge of edges) {
    if (edge.kind === 'contains' || !keepsEdge(edge.kind, filter)) continue;
    const from = graph.nodes.get(edge.from)?.filePath;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (from === undefined || to === undefined || from === to) continue;

    const key = `${from} ${edge.kind} ${to}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.weight += 1;
      if (edge.guessed !== true) delete existing.guessed;
      if (edge.roles !== undefined && edge.roles.length > 0) {
        existing.roles = [...(existing.roles ?? []), ...edge.roles.map((role) => ({ ...role }))];
      }
    } else {
      byKey.set(key, {
        from,
        to,
        kind: edge.kind,
        weight: 1,
        ...(edge.guessed === true ? { guessed: true as const } : {}),
        ...(edge.roles === undefined ? {} : { roles: edge.roles.map((role) => ({ ...role })) }),
      });
    }
  }

  const lifted = [...byKey.values()];
  const detail = new Set(
    lifted.filter((edge) => edge.kind === 'calls' || edge.kind === 'associates').map((edge) => `${edge.from} ${edge.to}`),
  );
  return lifted
    .filter((edge) => edge.kind !== 'imports' || !detail.has(`${edge.from} ${edge.to}`))
    .map((edge) => {
      const ownership = ownershipOf(edge.roles);
      return { ...edge, change, ...(ownership === undefined ? {} : { ownership }) };
    });
}

/**
 * One file box, from whichever graph still holds the file. The same fields
 * `selectView` gives a file box, less coverage — see `diffView` — and with
 * `change` when the diff names it.
 */
function box(
  node: GraphNode,
  members: DiffViewMember[],
  external: boolean,
  git: GitStatus | null,
  change?: Change,
): DiffViewNode {
  const gitStatus = git?.files[node.filePath] ?? null;
  return {
    id: node.filePath,
    kind: 'file',
    label: node.filePath,
    members,
    files: [node.filePath],
    external,
    focused: false,
    gitStatus,
    gitChanged: gitStatus ? 1 : 0,
    language: languageFor(node.filePath)?.id ?? null,
    test: isTestFile(node.filePath),
    parseError: node.parseError === true,
    ...(node.unresolved === undefined ? {} : { unresolved: node.unresolved }),
    ...(change === undefined ? {} : { change }),
  };
}

function countFiles(graph: Graph): number {
  let count = 0;
  for (const node of graph.nodes.values()) if (node.kind === 'file') count += 1;
  return count;
}

function countParseErrors(graph: Graph): number {
  let count = 0;
  for (const node of graph.nodes.values()) if (node.kind === 'file' && node.parseError === true) count += 1;
  return count;
}

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

/** The same two warnings over the boxes the diff names — every one of which is one file. */
function scopedWarnings(drawn: readonly DiffViewNode[]): ViewGraph['scoped'] {
  let parseErrors = 0;
  let imports = 0;
  let calls = 0;
  for (const node of drawn) {
    if (node.parseError) parseErrors += 1;
    imports += node.unresolved?.imports ?? 0;
    calls += node.unresolved?.calls ?? 0;
  }
  return { parseErrors, unresolved: { imports, calls } };
}

/** Context sinks to the end so what changed reads first. */
function byExternalThenId(a: DiffViewNode, b: DiffViewNode): number {
  if (a.external !== b.external) return a.external ? 1 : -1;
  return a.id.localeCompare(b.id);
}

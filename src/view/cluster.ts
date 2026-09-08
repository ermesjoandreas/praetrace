import type { Graph } from '../graph/types.js';
import { isTestFile } from './tests.js';

/**
 * Groups of files that lean on each other more than on anything else.
 *
 * Membership comes from the graph and only from the graph. A name may later be
 * suggested by a model, but the model is never allowed to decide who belongs:
 * a tidy grouping that does not match the imports is worse than no grouping,
 * because it is wrong in a way that looks authoritative.
 *
 * The method is label propagation — each file repeatedly adopts whichever label
 * is heaviest among its neighbours. It is near-linear, needs no tuning, and is
 * made deterministic here by fixing the visiting order and breaking ties on the
 * lowest path, so the same graph always yields the same groups — the test
 * beside this file feeds it the same graph twice, once with every node and
 * edge in reverse order, and expects the same answer.
 *
 * Tests are left out, and so are the edges into them. A suite imports
 * everything it exercises, which is the opposite of belonging: express drew a
 * "Benchmark suite" of 131 files, 82 of them tests, and TanStack's one heavy
 * edge was query-core → query-test-utils, all of it from __tests__. The tests
 * stay in the graph and on the screen; they just do not get a vote.
 */
export interface Cluster {
  /**
   * The first member alphabetically, plus the size. Stable while that file
   * stays in the group — and the size matters, because an outer group shares
   * its first file with its own first child, and without it a group could end
   * up being set as its own parent.
   */
  id: string;
  files: string[];
  /**
   * Share of the group's edges that stay inside it, 0..1, each edge counted
   * once. It used to be counted from both ends, which made every group look
   * tighter than it was — a triangle with one edge out read 86%, and a
   * reviewer counting the edges by hand got 75% and could not reproduce the
   * figure. The number now means what the tooltip says it means.
   */
  cohesion: number;
  /**
   * Groups found inside this one by running the same clustering on just its
   * members. Empty when the group does not usefully divide.
   */
  children: Cluster[];
}

/**
 * What the graph says about a set of files somebody proposes as a group.
 *
 * This exists because a proposal has to be judged before it is accepted, and
 * the only judgement worth anything is the graph's own. A model that says
 * "these eight files are 90% cohesive" is guessing; this counts the edges.
 * `cohesion` is the same measure `Cluster.cohesion` carries, computed the same
 * way over the same edges, so a proposed group and a found one can be read
 * side by side without either number meaning something slightly different.
 */
export interface GroupEvidence {
  /** The proposed paths the graph holds a file for, sorted and deduplicated. */
  files: string[];
  /**
   * Proposed paths no file in the graph answers to.
   *
   * Never silently dropped: a proposal that names files this project has not
   * got is a proposal to distrust, and a reader who is shown only the paths
   * that happened to land cannot see that.
   */
  unknown: string[];
  /**
   * Members that are test files. They are in the graph and they are in the
   * set, and they contribute nothing to the three numbers below — tests do
   * not vote here for the reason they do not vote in the clustering.
   */
  tests: string[];
  /** Share of the set's references that stay inside it, 0..1. */
  cohesion: number;
  /** References between two members, each counted once. */
  inside: number;
  /** References with exactly one end among the members. */
  leaving: number;
  /** Files outside the set that reference a member. */
  reachedFrom: string[];
  /** Files outside the set that a member references. */
  reaches: string[];
}

/**
 * One directed reference between two files, and how many graph edges cross it.
 *
 * The one home of "what counts as coupling between two files", so the number a
 * proposal is judged by and the number the clustering computes cannot drift
 * apart: `undirectedNeighbours` below is built from this, and so is
 * `evidenceFor`. `contains` is a file holding its own symbols and says
 * nothing about two files; `depends` is a type named only in a signature and
 * does not vote, for the reason written on `undirectedNeighbours`. A test file
 * is not an end at either side — a suite imports everything it exercises,
 * which is the opposite of belonging.
 */
export interface FileLink {
  from: string;
  to: string;
  /** Repeated references between the same pair are a stronger tie, not a duplicate. */
  weight: number;
}

/** Below this, a "group" is just a couple of files that happen to touch. */
const MIN_SIZE = 3;
/**
 * A third of a group's edges staying inside. The same cut as before the count
 * was made honest — 0.5 under the doubled count is 1/3 under this one — so no
 * group anyone has named disappeared for the sake of a truer percentage.
 */
const MIN_COHESION = 1 / 3;
const MAX_ROUNDS = 20;

/** Fewer members than this and there is nothing worth dividing. */
const MIN_SPLIT = 6;
/** Two levels is what a person can read; a third is a decoration. */
const MAX_DEPTH = 2;

/**
 * How much of an outer group may sit in one child before the outer stops being
 * a piece of architecture in its own right.
 *
 * The aggregation below contributes no file of its own — an outer group is
 * exactly the union of its children — so when one child holds nearly all of it,
 * the two rows the panel offers are one architecture asked about twice.
 * Measured: serilog's outer group is 108 files at cohesion 1.00 and its first
 * child is 104 of them, which is 96% of one source tree offered as an unnamed,
 * perfectly cohesive group; ripgrep offers 36 = 29 + 4 + 3 and 25 = 22 + 3.
 * Against the nestings that say something — zustand's 23 = 10 + 10 + 3, vue's
 * 272 across six children, this project's 54 across five — three quarters
 * leaves every one of them standing.
 */
const MAX_DOMINANCE = 3 / 4;

export function clusterFiles(graph: Graph): Cluster[] {
  const neighbours = undirectedNeighbours(graph);
  const fine = partition(neighbours, [...neighbours.keys()].sort());
  if (fine.length < 2) return fine;

  // Label propagation resolves at exactly one scale, so subdividing a group it
  // already decided is one thing finds nothing — verified: a tight group returns
  // a single label every time. Nesting comes from the other direction, which is
  // Louvain's aggregation step: make each group a node, weight the edges by how
  // much crosses between them, and cluster *that*. Groups that merge up there
  // become the children of the group they merged into.
  const between = crossings(fine, neighbours);
  const merged = propagate(between, fine.map((cluster) => cluster.id));

  const byLabel = new Map<string, Cluster[]>();
  for (const cluster of fine) {
    const label = merged.get(cluster.id) ?? cluster.id;
    byLabel.set(label, [...(byLabel.get(label) ?? []), cluster]);
  }

  const outer: Cluster[] = [];
  for (const children of byLabel.values()) {
    // One child is not a nesting, it is the same group drawn twice.
    if (children.length < 2) {
      const only = children[0];
      if (only) outer.push(only);
      continue;
    }

    const files = children.flatMap((child) => child.files).sort();
    // Nor is a child that already *is* the group. The outer level is worth a
    // row of its own only when it is more than its largest child with a few
    // stragglers attached; when it is not, the children stand as peers and
    // each piece of architecture is asked about once.
    if (Math.max(...children.map((child) => child.files.length)) > files.length * MAX_DOMINANCE) {
      outer.push(...children);
      continue;
    }

    outer.push({
      id: identify(files),
      files,
      cohesion: cohesionOf(files, neighbours),
      children: [...children].sort((a, b) => b.files.length - a.files.length),
    });
  }

  return outer.sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
}

/** How much traffic runs between each pair of groups. */
function crossings(
  clusters: readonly Cluster[],
  neighbours: ReadonlyMap<string, Map<string, number>>,
): Map<string, Map<string, number>> {
  const owner = new Map<string, string>();
  for (const cluster of clusters) for (const file of cluster.files) owner.set(file, cluster.id);

  const between = new Map<string, Map<string, number>>();
  for (const cluster of clusters) between.set(cluster.id, new Map());

  for (const cluster of clusters) {
    for (const file of cluster.files) {
      for (const [neighbour, weight] of neighbours.get(file) ?? []) {
        const other = owner.get(neighbour);
        if (other === undefined || other === cluster.id) continue;
        const edges = between.get(cluster.id);
        if (edges) edges.set(other, (edges.get(other) ?? 0) + weight);
      }
    }
  }
  return between;
}

function cohesionOf(files: readonly string[], neighbours: ReadonlyMap<string, Map<string, number>>): number {
  const { inside, leaving } = edgeCounts(files, neighbours);
  const total = inside + leaving;
  return total === 0 ? 0 : inside / total;
}

/**
 * The two numbers cohesion is a ratio of. Split out so a proposal can print
 * them beside the percentage — "31 of 44 stay inside" is checkable by hand and
 * "70%" is not, and this feature exists to be checked.
 */
function edgeCounts(
  files: readonly string[],
  neighbours: ReadonlyMap<string, Map<string, number>>,
): { inside: number; leaving: number } {
  const members = new Set(files);
  let internal = 0;
  let external = 0;

  for (const file of files) {
    for (const [neighbour, weight] of neighbours.get(file) ?? []) {
      if (members.has(neighbour)) internal += weight;
      else external += weight;
    }
  }
  // The map is undirected, so an edge inside the group was seen from both of
  // its ends and an edge leaving it from one. Halving puts them on one footing.
  return { inside: internal / 2, leaving: external };
}

/**
 * Judge a set of files the graph did not choose.
 *
 * The set may come from anywhere — a person drawing a frame, a model
 * proposing one — and this says nothing about where it came from. It reports
 * what the imports actually do with those files, which is the only thing that
 * can tell a grouping worth accepting from a tidy one that does not match the
 * code. Decision 5 is why it exists: a model may propose a grouping, and the
 * numbers a person reads before accepting it are ours and never its.
 *
 * Three passes over the graph, which is nothing beside the run that produced
 * the proposal; nothing here is on the live update path.
 */
export function evidenceFor(graph: Graph, proposed: readonly string[]): GroupEvidence {
  const known = new Set<string>();
  for (const node of graph.nodes.values()) if (node.kind === 'file') known.add(node.filePath);

  const files: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const path of proposed) {
    if (seen.has(path)) continue;
    seen.add(path);
    (known.has(path) ? files : unknown).push(path);
  }
  files.sort();
  unknown.sort();

  const { inside, leaving } = edgeCounts(files, undirectedNeighbours(graph));
  const members = new Set(files);
  const reachedFrom = new Set<string>();
  const reaches = new Set<string>();
  for (const link of fileLinks(graph)) {
    if (members.has(link.to) && !members.has(link.from)) reachedFrom.add(link.from);
    if (members.has(link.from) && !members.has(link.to)) reaches.add(link.to);
  }

  const total = inside + leaving;
  return {
    files,
    unknown,
    tests: files.filter(isTestFile),
    cohesion: total === 0 ? 0 : inside / total,
    inside,
    leaving,
    reachedFrom: [...reachedFrom].sort(),
    reaches: [...reaches].sort(),
  };
}

/**
 * Label propagation itself: each node repeatedly adopts whichever label is
 * heaviest among its neighbours. Used on files first, then on the groups those
 * files formed.
 */
function propagate(
  neighbours: ReadonlyMap<string, Map<string, number>>,
  nodes: readonly string[],
): Map<string, string> {
  const label = new Map(nodes.map((node) => [node, node]));

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let moved = false;

    // A fixed order and a deterministic tie-break are what make this repeatable;
    // the usual randomised variant would redraw the groups on every refresh.
    for (const node of nodes) {
      const weights = new Map<string, number>();
      for (const [neighbour, weight] of neighbours.get(node) ?? []) {
        const nearby = label.get(neighbour);
        if (nearby === undefined) continue;
        weights.set(nearby, (weights.get(nearby) ?? 0) + weight);
      }
      if (weights.size === 0) continue;

      let best = label.get(node) ?? node;
      let bestWeight = weights.get(best) ?? 0;
      for (const [candidate, weight] of [...weights].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (weight > bestWeight) {
          best = candidate;
          bestWeight = weight;
        }
      }

      if (best !== label.get(node)) {
        label.set(node, best);
        moved = true;
      }
    }

    if (!moved) break;
  }

  return label;
}

function partition(
  neighbours: ReadonlyMap<string, Map<string, number>>,
  files: readonly string[],
): Cluster[] {
  if (files.length === 0) return [];

  return assemble(files, propagate(neighbours, files), neighbours)
    .filter((cluster) => cluster.files.length >= MIN_SIZE && cluster.cohesion >= MIN_COHESION)
    .sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
}

/** The id a group of these files would have. Exported so the one place that
 * records a decision derives it the same way, rather than reinventing it. */
export function identify(files: readonly string[]): string {
  return `${files[0] ?? ''}~${files.length}`;
}

/**
 * Every reference between two files the graph holds, summed per direction.
 * Sorted, so two runs over the same graph produce the same list.
 *
 * Tests are not ends at all, and an edge touching one is dropped with them —
 * from both ends, or a source file would still count its tests as neighbours
 * and read as leaking edges to files that are not there.
 */
export function fileLinks(graph: Graph): FileLink[] {
  const files = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' && !isTestFile(node.filePath)) files.add(node.filePath);
  }

  const weights = new Map<string, Map<string, number>>();
  for (const edge of graph.edges) {
    if (edge.kind === 'contains') continue;
    // A type named only in a signature is not the coupling this measures —
    // and letting it vote moved every stored name on every TypeScript, Java
    // and C# project the day dependency edges arrived.
    if (edge.kind === 'depends') continue;
    const from = graph.nodes.get(edge.from)?.filePath;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (!from || !to || from === to) continue;
    if (!files.has(from) || !files.has(to)) continue;

    const out = weights.get(from) ?? new Map<string, number>();
    out.set(to, (out.get(to) ?? 0) + 1);
    weights.set(from, out);
  }

  const links: FileLink[] = [];
  for (const [from, out] of weights) for (const [to, weight] of out) links.push({ from, to, weight });
  return links.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * Direction says who depends on whom; belonging is mutual — so the links above
 * are laid down both ways here. A file with no references at all still gets an
 * entry, because a file that belongs to nothing is an answer.
 */
function undirectedNeighbours(graph: Graph): Map<string, Map<string, number>> {
  const neighbours = new Map<string, Map<string, number>>();

  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' && !isTestFile(node.filePath)) neighbours.set(node.filePath, new Map());
  }

  for (const link of fileLinks(graph)) {
    bump(neighbours, link.from, link.to, link.weight);
    bump(neighbours, link.to, link.from, link.weight);
  }

  return neighbours;
}

function bump(neighbours: Map<string, Map<string, number>>, from: string, to: string, weight: number): void {
  const edges = neighbours.get(from);
  if (!edges) return;
  edges.set(to, (edges.get(to) ?? 0) + weight);
}

function assemble(
  files: readonly string[],
  label: ReadonlyMap<string, string>,
  neighbours: ReadonlyMap<string, Map<string, number>>,
): Cluster[] {
  const grouped = new Map<string, string[]>();
  for (const file of files) {
    const key = label.get(file) ?? file;
    const members = grouped.get(key);
    if (members) members.push(file);
    else grouped.set(key, [file]);
  }

  return [...grouped.values()].map((members) => {
    const sorted = [...members].sort();
    return {
      id: identify(sorted),
      files: sorted,
      cohesion: cohesionOf(sorted, neighbours),
      children: [],
    };
  });
}

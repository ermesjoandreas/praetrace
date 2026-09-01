import type { Graph } from '../graph/types.js';

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
 * lowest path, so the same graph always yields the same groups.
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
  /** Share of the group's edges that stay inside it, 0..1. */
  cohesion: number;
  /**
   * Groups found inside this one by running the same clustering on just its
   * members. Empty when the group does not usefully divide.
   */
  children: Cluster[];
}

/** Below this, a "group" is just a couple of files that happen to touch. */
const MIN_SIZE = 3;
const MIN_COHESION = 0.5;
const MAX_ROUNDS = 20;

/** Fewer members than this and there is nothing worth dividing. */
const MIN_SPLIT = 6;
/** Two levels is what a person can read; a third is a decoration. */
const MAX_DEPTH = 2;

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
  const inside = new Set(files);
  let internal = 0;
  let external = 0;

  for (const file of files) {
    for (const [neighbour, weight] of neighbours.get(file) ?? []) {
      if (inside.has(neighbour)) internal += weight;
      else external += weight;
    }
  }
  const total = internal + external;
  return total === 0 ? 0 : internal / total;
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

/** Direction says who depends on whom; belonging is mutual. */
function undirectedNeighbours(graph: Graph): Map<string, Map<string, number>> {
  const neighbours = new Map<string, Map<string, number>>();

  for (const node of graph.nodes.values()) {
    if (node.kind === 'file') neighbours.set(node.filePath, new Map());
  }

  for (const edge of graph.edges) {
    if (edge.kind === 'contains') continue;
    const from = graph.nodes.get(edge.from)?.filePath;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (!from || !to || from === to) continue;

    // Repeated edges between the same pair are a stronger tie, not a duplicate.
    bump(neighbours, from, to);
    bump(neighbours, to, from);
  }

  return neighbours;
}

function bump(neighbours: Map<string, Map<string, number>>, from: string, to: string): void {
  const edges = neighbours.get(from);
  if (!edges) return;
  edges.set(to, (edges.get(to) ?? 0) + 1);
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
    const inside = new Set(members);
    let internal = 0;
    let external = 0;

    for (const member of members) {
      for (const [neighbour, weight] of neighbours.get(member) ?? []) {
        if (inside.has(neighbour)) internal += weight;
        else external += weight;
      }
    }

    const total = internal + external;
    const sorted = [...members].sort();
    return {
      id: identify(sorted),
      files: sorted,
      cohesion: total === 0 ? 0 : internal / total,
      children: [],
    };
  });
}

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
  /** The lexicographically first member; stable while that file stays in it. */
  id: string;
  files: string[];
  /** Share of the group's edges that stay inside it, 0..1. */
  cohesion: number;
}

/** Below this, a "group" is just a couple of files that happen to touch. */
const MIN_SIZE = 3;
const MIN_COHESION = 0.5;
const MAX_ROUNDS = 20;

export function clusterFiles(graph: Graph): Cluster[] {
  const neighbours = undirectedNeighbours(graph);
  const files = [...neighbours.keys()].sort();
  if (files.length === 0) return [];

  const label = new Map(files.map((file) => [file, file]));

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let moved = false;

    // A fixed order and a deterministic tie-break are what make this repeatable;
    // the usual randomised variant would redraw the groups on every refresh.
    for (const file of files) {
      const weights = new Map<string, number>();
      for (const [neighbour, weight] of neighbours.get(file) ?? []) {
        const nearby = label.get(neighbour);
        if (nearby === undefined) continue;
        weights.set(nearby, (weights.get(nearby) ?? 0) + weight);
      }
      if (weights.size === 0) continue;

      let best = label.get(file) ?? file;
      let bestWeight = weights.get(best) ?? 0;
      for (const [candidate, weight] of [...weights].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (weight > bestWeight) {
          best = candidate;
          bestWeight = weight;
        }
      }

      if (best !== label.get(file)) {
        label.set(file, best);
        moved = true;
      }
    }

    if (!moved) break;
  }

  return assemble(files, label, neighbours)
    .filter((cluster) => cluster.files.length >= MIN_SIZE && cluster.cohesion >= MIN_COHESION)
    .sort((a, b) => b.files.length - a.files.length || a.id.localeCompare(b.id));
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
    return {
      id: [...members].sort()[0] ?? '',
      files: [...members].sort(),
      cohesion: total === 0 ? 0 : internal / total,
    };
  });
}

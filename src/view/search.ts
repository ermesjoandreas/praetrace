import path from 'node:path';
import type { Graph, NodeKind } from '../graph/types.js';

/**
 * Search runs over the whole graph, not the slice on screen — the point of it is
 * reaching something you cannot see.
 *
 * Matching is a subsequence, the way editors do it: `gst` finds `GraphStore`.
 * Ranking prefers a contiguous run, an earlier match, and a shorter name, so an
 * exact prefix beats letters scattered through a long path.
 */
export interface SearchHit {
  kind: NodeKind;
  /** What to show: the file's name, or the symbol's. */
  name: string;
  /** Always the file, so a hit can be opened or focused. */
  path: string;
  line: number;
}

export function search(graph: Graph, query: string, limit = 30): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  const scored: { hit: SearchHit; score: number }[] = [];

  for (const node of graph.nodes.values()) {
    const isFile = node.kind === 'file';
    // A file is searched by its whole path; a symbol by its own name, since
    // that is what someone types.
    const haystack = isFile ? node.filePath : node.name;

    const score = match(haystack.toLowerCase(), needle);
    if (score === null) continue;

    scored.push({
      score,
      hit: {
        kind: node.kind,
        name: isFile ? path.posix.basename(node.filePath) : node.name,
        path: node.filePath,
        line: isFile ? 1 : node.range.startLine,
      },
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.hit.name.length - b.hit.name.length)
    .slice(0, limit)
    .map((entry) => entry.hit);
}

/** Higher is better; null means the query is not a subsequence at all. */
function match(haystack: string, needle: string): number | null {
  const exact = haystack.indexOf(needle);
  if (exact !== -1) {
    // A contiguous hit always beats a scattered one, and an earlier one wins.
    return 1000 - exact * 2 - (haystack.length - needle.length);
  }

  let at = 0;
  let gaps = 0;
  let first = -1;

  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found === -1) return null;
    if (first === -1) first = found;
    if (found > at) gaps += found - at;
    at = found + 1;
  }

  return 500 - gaps * 3 - first - (haystack.length - needle.length);
}

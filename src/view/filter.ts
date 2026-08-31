import type { EdgeKind, NodeKind } from '../graph/types.js';

/**
 * What to leave out. Every field is inert when empty, so the default filter is
 * "show everything" and each part can be reasoned about on its own.
 *
 * Filtering is not navigating. Scope and focus move you somewhere; a filter
 * changes what is worth drawing wherever you are.
 */
export interface ViewFilter {
  /** Files whose path matches are dropped. */
  hidePath: string;
  /** When set, only files whose path matches are kept. */
  onlyPath: string;
  /** Symbol kinds to keep. Empty means all of them. */
  kinds: NodeKind[];
  /** Edge kinds to draw. Empty means the structural default. */
  edgeKinds: EdgeKind[];
  /** Keep only files written within this many milliseconds. 0 lifts the limit. */
  sinceMs: number;
}

export const DEFAULT_EDGE_KINDS: EdgeKind[] = ['imports', 'extends', 'implements'];

export const NO_FILTER: ViewFilter = {
  hidePath: '',
  onlyPath: '',
  kinds: [],
  edgeKinds: DEFAULT_EDGE_KINDS,
  sinceMs: 0,
};

export function isFiltering(filter: ViewFilter): boolean {
  return (
    filter.hidePath !== '' ||
    filter.onlyPath !== '' ||
    filter.kinds.length > 0 ||
    filter.sinceMs > 0
  );
}

/**
 * A plain substring unless the pattern contains `*`, in which case it is a glob.
 * Substring is what people type first, and a glob is what they reach for when
 * substring is not enough.
 */
export function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern === '') return false;
  if (!pattern.includes('*')) return filePath.includes(pattern);

  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(filePath);
}

export function keepsFile(filePath: string, modifiedAt: number, filter: ViewFilter, now: number): boolean {
  if (filter.onlyPath !== '' && !matchesPattern(filePath, filter.onlyPath)) return false;
  if (filter.hidePath !== '' && matchesPattern(filePath, filter.hidePath)) return false;
  // modifiedAt === 0 means the stat failed. Unknown is not old.
  if (filter.sinceMs > 0 && modifiedAt > 0 && modifiedAt < now - filter.sinceMs) return false;
  return true;
}

export function keepsKind(kind: NodeKind, filter: ViewFilter): boolean {
  return filter.kinds.length === 0 || filter.kinds.includes(kind);
}

export function keepsEdge(kind: EdgeKind, filter: ViewFilter): boolean {
  return filter.edgeKinds.includes(kind);
}

/** `5m`, `2h`, `90s`, `1d` — the units someone actually types. */
export function parseDuration(raw: string): number {
  const match = /^(\d+)\s*([smhd])$/.exec(raw.trim());
  if (!match?.[1] || !match[2]) return 0;

  const amount = Number(match[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]] ?? 0;
  return amount * unit;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return '';
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]] as const) {
    if (ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
}

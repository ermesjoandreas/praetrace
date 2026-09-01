import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Cluster } from '../view/cluster.js';

/**
 * The names people give the groups the graph finds.
 *
 * Kept in the project rather than in application state: a name for a piece of
 * architecture is worth committing, worth sharing with whoever else works here,
 * and worth surviving a restart. The file is only written when someone actually
 * accepts or rejects something — nothing appears in a repository uninvited.
 */
export interface NamedGroup {
  name: string;
  /** The members at the time it was named, for matching it again later. */
  files: string[];
  state: 'accepted' | 'rejected';
}

export interface GroupSuggestion extends Omit<Cluster, 'children'> {
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  /** Nesting depth: 0 is an outer group, 1 is one found inside it. */
  depth: number;
  /** The outer group this sits in, when it sits in one. */
  parent: string | null;
}

/**
 * Membership drifts as the code changes, so a stored name is matched to a fresh
 * cluster by overlap rather than by identity. Below this the two are different
 * groups that happen to share a file.
 */
const MATCH_THRESHOLD = 0.5;

function groupsPath(root: string): string {
  return path.join(root, '.codemap', 'groups.json');
}

export async function readGroups(root: string): Promise<NamedGroup[]> {
  const raw = await readFile(groupsPath(root), 'utf8').catch(() => null);
  if (raw === null) return [];

  try {
    const parsed = JSON.parse(raw) as { groups?: unknown };
    return Array.isArray(parsed.groups) ? (parsed.groups as NamedGroup[]) : [];
  } catch {
    // A hand-edited file that no longer parses should not take the feature down.
    return [];
  }
}

export async function writeGroups(root: string, groups: NamedGroup[]): Promise<void> {
  await mkdir(path.join(root, '.codemap'), { recursive: true });
  await writeFile(groupsPath(root), `${JSON.stringify({ groups }, null, 2)}\n`, 'utf8');
}

/** How much two member lists have in common, 0..1. */
function overlap(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const shared = b.filter((file) => left.has(file)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : shared / union;
}

/**
 * Merge what the graph found with what the user has already said about it.
 * Rejected groups stay in the answer, marked, so the page can keep them out of
 * sight without the next scan proposing them all over again.
 *
 * Flattened, with depth and parent kept, because every consumer — the drawing,
 * the panel, the MCP tools — wants to walk them in order rather than recurse.
 */
export function mergeGroups(clusters: readonly Cluster[], stored: readonly NamedGroup[]): GroupSuggestion[] {
  const taken = new Set<NamedGroup>();
  const out: GroupSuggestion[] = [];

  const walk = (cluster: Cluster, depth: number, parent: string | null): void => {
    out.push({ ...describeOne(cluster), depth, parent });
    for (const child of cluster.children) walk(child, depth + 1, cluster.id);
  };

  const describeOne = (cluster: Cluster): Omit<GroupSuggestion, 'depth' | 'parent'> => {
    let best: NamedGroup | null = null;
    let bestScore = MATCH_THRESHOLD;

    for (const group of stored) {
      if (taken.has(group)) continue;
      const score = overlap(cluster.files, group.files);
      if (score >= bestScore) {
        best = group;
        bestScore = score;
      }
    }

    if (best) taken.add(best);

    const { children: _children, ...flat } = cluster;
    return {
      ...flat,
      name: best?.name ?? null,
      state: best?.state ?? 'suggested',
    };
  };

  for (const cluster of clusters) walk(cluster, 0, null);
  return out;
}

/** Record a decision, replacing whatever was previously said about this group. */
export function applyDecision(
  stored: readonly NamedGroup[],
  files: readonly string[],
  decision: { name: string; state: NamedGroup['state'] },
): NamedGroup[] {
  const kept = stored.filter((group) => overlap(group.files, files) < MATCH_THRESHOLD);
  return [...kept, { name: decision.name, files: [...files], state: decision.state }];
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Cluster } from '../view/cluster.js';

/**
 * The palette a group's frame can be drawn in. Keys, not CSS colours: the
 * stylesheet owns what 'teal' looks like, and a hex value stored in the project
 * would freeze one theme into a file that outlives it.
 */
export type GroupColor = 'slate' | 'blue' | 'teal' | 'green' | 'amber' | 'orange' | 'red' | 'violet';

export const GROUP_COLORS: readonly GroupColor[] = [
  'slate',
  'blue',
  'teal',
  'green',
  'amber',
  'orange',
  'red',
  'violet',
];

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
  /**
   * The cluster id at the time of naming. Matched first, because it carries the
   * group's size and so tells a group apart from the one nested inside it —
   * which membership overlap cannot: a child of 8 shares 73% of an 11-file
   * parent, and naming one used to overwrite the other.
   */
  id?: string;
  /** The members at the time it was named, for matching it again after drift. */
  files: string[];
  state: 'accepted' | 'rejected';
  /**
   * Absent means the graph found this group; 'manual' means a person drew it.
   *
   * Membership is graph-derived on purpose (see CLAUDE.md): a tidy grouping that
   * does not match the imports is wrong in a way that looks authoritative. A
   * hand-drawn group is allowed — someone may know something the import graph
   * does not — but it carries this marker so it can never be mistaken for
   * something the imports actually said.
   */
  origin?: 'manual';
  /** A palette key, not a CSS colour. Absent means the depth default. */
  color?: GroupColor;
  /** Frame slack in px around the members. Absent means the layout default. */
  padding?: { x: number; y: number };
}

export interface GroupSuggestion extends Omit<Cluster, 'children'> {
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  /** Nesting depth: 0 is an outer group, 1 is one found inside it. */
  depth: number;
  /** The outer group this sits in, when it sits in one. */
  parent: string | null;
  /** Absent means the graph found this group; 'manual' means a person drew it. */
  origin?: 'manual';
  /** A palette key, not a CSS colour. Absent means the depth default. */
  color?: GroupColor;
  /** Frame slack in px around the members. Absent means the layout default. */
  padding?: { x: number; y: number };
}

/**
 * Membership drifts as the code changes, so a stored name is matched to a fresh
 * cluster by overlap rather than by identity. Below this the two are different
 * groups that happen to share a file.
 */
const MATCH_THRESHOLD = 0.5;

/**
 * Overlap alone cannot separate a group from the one inside it, so a match also
 * has to be about the same size. A parent and child never are.
 */
const MIN_SIZE_RATIO = 0.75;

function comparable(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  return Math.min(a.length, b.length) / Math.max(a.length, b.length) >= MIN_SIZE_RATIO;
}

function matches(cluster: { id: string; files: readonly string[] }, group: NamedGroup): boolean {
  if (group.id !== undefined && group.id === cluster.id) return true;
  // A hand-drawn group is not a cluster, so it must not be reachable by overlap:
  // accepting a derived group that happens to cover the same files would quietly
  // delete the one someone drew.
  if (group.origin === 'manual') return false;
  return comparable(cluster.files, group.files) && overlap(cluster.files, group.files) >= MATCH_THRESHOLD;
}

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
 * Origin, colour and padding are how a group is drawn, decided separately from
 * what it is called. Copied across by spreading rather than by assignment
 * because `exactOptionalPropertyTypes` makes an absent field and one set to
 * undefined two different things, and only the first survives a round trip
 * through the JSON file.
 */
function presentationOf(
  group: Pick<NamedGroup, 'origin' | 'color' | 'padding'>,
): Pick<NamedGroup, 'origin' | 'color' | 'padding'> {
  return {
    ...(group.origin === undefined ? {} : { origin: group.origin }),
    ...(group.color === undefined ? {} : { color: group.color }),
    ...(group.padding === undefined ? {} : { padding: group.padding }),
  };
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
  // Hand-drawn groups are held out of the matching entirely. They describe no
  // cluster, so an overlap match would be wrong twice over: the cluster would
  // wear a name nobody gave it, and the drawn group would be consumed and then
  // vanish from the answer.
  const derived = stored.filter((group) => group.origin !== 'manual');
  const taken = new Set<NamedGroup>();
  const out: GroupSuggestion[] = [];

  const walk = (cluster: Cluster, depth: number, parent: string | null): void => {
    out.push({ ...describeOne(cluster), depth, parent });
    for (const child of cluster.children) walk(child, depth + 1, cluster.id);
  };

  const describeOne = (cluster: Cluster): Omit<GroupSuggestion, 'depth' | 'parent'> => {
    // An exact id wins outright; otherwise the closest comparable group.
    let best = derived.find((group) => !taken.has(group) && group.id === cluster.id) ?? null;

    if (best === null) {
      let bestScore = MATCH_THRESHOLD;
      for (const group of derived) {
        if (taken.has(group) || !comparable(cluster.files, group.files)) continue;
        const score = overlap(cluster.files, group.files);
        if (score >= bestScore) {
          best = group;
          bestScore = score;
        }
      }
    }

    if (best) taken.add(best);

    const { children: _children, ...flat } = cluster;
    return {
      ...flat,
      ...(best === null ? {} : presentationOf(best)),
      name: best?.name ?? null,
      state: best?.state ?? 'suggested',
    };
  };

  for (const cluster of clusters) walk(cluster, 0, null);

  // Appended rather than woven in: a drawn group has no cohesion to report and
  // no place in the nesting the clustering found, so it is its own outer group.
  for (const group of stored) {
    if (group.origin !== 'manual') continue;
    out.push({
      id: group.id ?? manualId(group.name),
      files: [...group.files],
      cohesion: 0,
      depth: 0,
      parent: null,
      name: group.name,
      state: group.state,
      ...presentationOf(group),
      origin: 'manual',
    });
  }

  return out;
}

/**
 * Record a decision, replacing whatever was previously said about *this* group
 * and nothing else. The size test is what stops naming a nested group from
 * wiping the name off the group it sits in.
 */
export function applyDecision(
  stored: readonly NamedGroup[],
  files: readonly string[],
  decision: { name: string; state: NamedGroup['state']; id?: string },
): NamedGroup[] {
  const cluster = { id: decision.id ?? '', files };
  const previous = stored.find((group) => matches(cluster, group));
  const kept = stored.filter((group) => !matches(cluster, group));

  return [
    ...kept,
    {
      // How the group is drawn was decided elsewhere, and renaming it is not a
      // decision about its colour. Rebuilding the entry from the decision alone
      // silently reset both.
      ...(previous === undefined ? {} : presentationOf(previous)),
      name: decision.name,
      files: [...files],
      state: decision.state,
      ...(decision.id === undefined ? {} : { id: decision.id }),
    },
  ];
}

/**
 * A stable id for a hand-drawn group, derived from its first name. Prefixed so
 * it can never collide with a cluster id, which is a file path and a size.
 */
export function manualId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `manual:${slug === '' ? 'group' : slug}`;
}

/**
 * Draw a group by hand. Marked 'manual' at birth, because from here on nothing
 * downstream may present it as something the import graph found.
 *
 * The id is taken from the name only once, at creation: a rename must not
 * change who the group is, or every name stored against it would be orphaned.
 */
export function createManualGroup(
  stored: readonly NamedGroup[],
  input: { name: string; files: string[]; color?: GroupColor },
): NamedGroup[] {
  const name = input.name.trim();
  if (name === '') throw new Error('a group needs a name');
  if (input.files.length < 2) throw new Error('a group needs at least two files');

  const used = new Set(stored.map((group) => group.id));
  const base = manualId(name);
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;

  return [
    ...stored,
    {
      name,
      id,
      files: [...input.files],
      state: 'accepted',
      origin: 'manual',
      ...(input.color === undefined ? {} : { color: input.color }),
    },
  ];
}

/**
 * Patch one group by id. Name, colour and padding are presentation and may be
 * changed on anything — naming a group the graph found is already the point of
 * the feature. Membership may not: it comes from the imports, and the one
 * exception is a group that never claimed to.
 */
export function updateGroup(
  stored: readonly NamedGroup[],
  id: string,
  patch: { name?: string; color?: GroupColor; padding?: { x: number; y: number }; files?: string[] },
): NamedGroup[] {
  const target = stored.find((group) => group.id === id);
  if (target === undefined) throw new Error(`no group with id ${id}`);
  if (patch.files !== undefined && target.origin !== 'manual') {
    throw new Error('membership comes from the import graph; only a manual group can be given files');
  }

  return stored.map((group) =>
    group.id === id
      ? {
          ...group,
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.color === undefined ? {} : { color: patch.color }),
          ...(patch.padding === undefined ? {} : { padding: patch.padding }),
          ...(patch.files === undefined ? {} : { files: [...patch.files] }),
        }
      : group,
  );
}

/**
 * Forget a group entirely. Distinct from rejecting one: a rejected group is
 * remembered so the next scan does not propose it again, while a drawn group
 * that is deleted was never proposed by anything and leaves nothing behind.
 */
export function deleteGroup(stored: readonly NamedGroup[], id: string): NamedGroup[] {
  return stored.filter((group) => group.id !== id);
}

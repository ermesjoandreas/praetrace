import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { identify, type Cluster } from '../view/cluster.js';

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
  /**
   * A frame the user placed by hand, in graph coordinates.
   *
   * Only honoured while `locked`. Unlocked, a frame is derived from where its
   * members landed, and it should be: a rectangle that no longer contains what
   * it names is worse than one that moves.
   */
  geometry?: { x: number; y: number; width: number; height: number };
  /**
   * Keep that geometry through a relayout.
   *
   * The frame normally hugs its members, which is what makes it trustworthy —
   * but it also means every edit nudges it. A lock is how someone says "I know,
   * put it here anyway". A member that then falls outside is marked rather than
   * quietly cropped, so the frame cannot lie about what it holds.
   */
  locked?: boolean;
}

export interface GroupSuggestion extends Omit<Cluster, 'children'> {
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  /** Nesting depth: 0 is an outer group, 1 is one found inside it. */
  depth: number;
  /** The outer group this sits in, when it sits in one. */
  parent: string | null;
  /**
   * The id this group is recorded under, when it is recorded at all.
   *
   * Not the same as `id`, which is the cluster's, and a cluster id embeds its
   * member count — so the moment membership drifts, the two diverge. The name
   * survives that because it is re-matched by overlap, and everything that
   * edits a stored group has to address it by this rather than by the id of
   * the cluster it currently describes.
   */
  storedId?: string;
  /** Absent means the graph found this group; 'manual' means a person drew it. */
  origin?: 'manual';
  /** A palette key, not a CSS colour. Absent means the depth default. */
  color?: GroupColor;
  /** Frame slack in px around the members. Absent means the layout default. */
  padding?: { x: number; y: number };
  /**
   * A frame the user placed by hand, in graph coordinates.
   *
   * Only honoured while `locked`. Unlocked, a frame is derived from where its
   * members landed, and it should be: a rectangle that no longer contains what
   * it names is worse than one that moves.
   */
  geometry?: { x: number; y: number; width: number; height: number };
  /**
   * Keep that geometry through a relayout.
   *
   * The frame normally hugs its members, which is what makes it trustworthy —
   * but it also means every edit nudges it. A lock is how someone says "I know,
   * put it here anyway". A member that then falls outside is marked rather than
   * quietly cropped, so the frame cannot lie about what it holds.
   */
  locked?: boolean;
}

/** A stored group that describes no cluster the graph currently finds. */
export interface OrphanGroup {
  storedId: string;
  name: string;
  files: string[];
}

export interface MergedGroups {
  clusters: GroupSuggestion[];
  /**
   * Named, accepted, and matching nothing — shown rather than dropped, because
   * a name that vanishes from the panel while it sits in a committed file is a
   * bug the person cannot see. Three of this repository's own were in that
   * state. A rejection that matches nothing is left out: it is a memory, not
   * a name, and there is nothing to show for it.
   */
  orphans: OrphanGroup[];
}

/**
 * Membership drifts as the code changes, so a stored name is matched to a fresh
 * cluster by overlap rather than by identity. Two rules, because drift comes in
 * two shapes. A group that changed members must still share most of them: this
 * is the Jaccard overlap, and below it the two are different groups that happen
 * to share files. A group that only *grew* — every stored member still there,
 * new ones beside them — is recognised further, down to half, since nothing it
 * was has gone anywhere. That is the case that used to strip "View selection"
 * of its name when three files joined its four. Half is also where growth
 * stops reading as growth: a stored group inside a cluster twice its size is
 * a group that has been swallowed, and naming the whole after the part would
 * be the authoritative-looking lie this feature is not allowed to tell.
 */
const MATCH_THRESHOLD = 0.6;
const GROWN_THRESHOLD = 0.5;

/** Above every overlap score, so a cluster wearing its recorded id is never outbid. */
const EXACT_ID = 2;

/**
 * How well a stored group describes a cluster: `EXACT_ID` for its own id, the
 * overlap when close enough, null when they are not the same group. A
 * hand-drawn group describes no cluster and answers null to every one, or
 * accepting a derived group that happened to cover the same files would
 * quietly delete the one someone drew.
 */
function matchScore(cluster: { id: string; files: readonly string[] }, group: NamedGroup): number | null {
  if (group.origin === 'manual') return null;
  if (group.id !== undefined && group.id === cluster.id) return EXACT_ID;

  const score = overlap(cluster.files, group.files);
  if (score >= MATCH_THRESHOLD) return score;

  const inside = new Set(cluster.files);
  const grown = group.files.length > 0 && group.files.every((file) => inside.has(file));
  return grown && score >= GROWN_THRESHOLD ? score : null;
}

function groupsPath(root: string): string {
  return path.join(root, '.codemap', 'groups.json');
}

export async function readGroups(root: string): Promise<NamedGroup[]> {
  const raw = await readFile(groupsPath(root), 'utf8').catch(() => null);
  if (raw === null) return [];

  try {
    const parsed = JSON.parse(raw) as { groups?: unknown };
    return Array.isArray(parsed.groups) ? (parsed.groups as NamedGroup[]).map(withId) : [];
  } catch {
    // A hand-edited file that no longer parses should not take the feature down.
    return [];
  }
}

/**
 * A group written before ids existed gets the id it would have been given: a
 * cluster's is its first member and its size, and a drawn one's is its name.
 * Without one it can be matched but never addressed — not edited, not deleted,
 * not even listed as an orphan — and the file is only rewritten on the next
 * decision, so nothing is touched by merely reading it.
 */
function withId(group: NamedGroup): NamedGroup {
  if (group.id !== undefined) return group;
  const id = group.origin === 'manual' ? manualId(group.name) : identify([...group.files].sort());
  return { ...group, id };
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
  group: Pick<NamedGroup, 'origin' | 'color' | 'padding' | 'geometry' | 'locked'>,
): Pick<NamedGroup, 'origin' | 'color' | 'padding' | 'geometry' | 'locked'> {
  return {
    ...(group.origin === undefined ? {} : { origin: group.origin }),
    ...(group.color === undefined ? {} : { color: group.color }),
    ...(group.padding === undefined ? {} : { padding: group.padding }),
    ...(group.geometry === undefined ? {} : { geometry: group.geometry }),
    ...(group.locked === undefined ? {} : { locked: group.locked }),
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
export function mergeGroups(clusters: readonly Cluster[], stored: readonly NamedGroup[]): MergedGroups {
  const flat: { cluster: Cluster; depth: number; parent: string | null }[] = [];
  const walk = (cluster: Cluster, depth: number, parent: string | null): void => {
    flat.push({ cluster, depth, parent });
    for (const child of cluster.children) walk(child, depth + 1, cluster.id);
  };
  for (const cluster of clusters) walk(cluster, 0, null);

  // Every pair scored first, then paired best-first, rather than each cluster
  // taking the best group left as it is walked. Walking is outer-first, and an
  // outer group contains its children — so a name whose own cluster was three
  // rows down used to be taken by the parent it happened to overlap, and the
  // child it belonged to came up unnamed.
  const candidates: { at: number; group: NamedGroup; score: number }[] = [];
  flat.forEach(({ cluster }, at) => {
    for (const group of stored) {
      const score = matchScore(cluster, group);
      if (score !== null) candidates.push({ at, group, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score || a.at - b.at);

  const chosen = new Map<number, NamedGroup>();
  const taken = new Set<NamedGroup>();
  for (const { at, group } of candidates) {
    if (chosen.has(at) || taken.has(group)) continue;
    chosen.set(at, group);
    taken.add(group);
  }

  const out: GroupSuggestion[] = flat.map(({ cluster, depth, parent }, at) => {
    const best = chosen.get(at) ?? null;
    const { children: _children, ...rest } = cluster;
    return {
      ...rest,
      ...(best === null ? {} : presentationOf(best)),
      ...(best?.id === undefined ? {} : { storedId: best.id }),
      name: best?.name ?? null,
      state: best?.state ?? 'suggested',
      depth,
      parent,
    };
  });

  // Appended rather than woven in: a drawn group has no cohesion to report and
  // no place in the nesting the clustering found, so it is its own outer group.
  for (const group of stored) {
    if (group.origin !== 'manual') continue;
    const id = group.id ?? manualId(group.name);
    out.push({
      id,
      // A drawn group describes no cluster, so its id never drifts: the two
      // are the same, and saying so keeps every caller on one code path.
      storedId: id,
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

  const orphans: OrphanGroup[] = [];
  for (const group of stored) {
    if (taken.has(group) || group.origin === 'manual' || group.state !== 'accepted') continue;
    if (group.id === undefined) continue;
    orphans.push({ storedId: group.id, name: group.name, files: [...group.files] });
  }

  return { clusters: out, orphans };
}

/**
 * Which stored entry a decision about these files should replace, or undefined
 * when it is a new one. The answer `mergeGroups` gives, asked of the one
 * cluster with exactly this membership — so the server can settle a decision
 * that arrived without a `storedId` (the MCP tool passes files and nothing
 * else) the same way the panel would have, rather than by a second matching
 * that could disagree with the first.
 */
export function storedIdFor(
  clusters: readonly Cluster[],
  stored: readonly NamedGroup[],
  files: readonly string[],
): string | undefined {
  const wanted = [...files].sort().join('\n');
  const merged = mergeGroups(clusters, stored).clusters;
  return merged.find((group) => group.origin !== 'manual' && [...group.files].sort().join('\n') === wanted)?.storedId;
}

/**
 * Record a decision, replacing whatever was previously said about *this* group
 * and nothing else — in place, so the file keeps its order and never gains a
 * second entry for a group it already had.
 *
 * Which entry that is comes from the caller, as `storedId`, because only the
 * caller has the clusters: naming a nested group used to be matched by overlap
 * here, found the group it sits in, and wiped that one's name. Without a
 * `storedId` only the exact cluster id is trusted; a decision that matches
 * neither is a new group. `storedIdFor` is how a server settles one.
 */
export function applyDecision(
  stored: readonly NamedGroup[],
  files: readonly string[],
  decision: { name: string; state: NamedGroup['state']; id?: string; storedId?: string },
): NamedGroup[] {
  const previous =
    stored.find((group) => decision.storedId !== undefined && group.id === decision.storedId) ??
    stored.find((group) => group.origin !== 'manual' && decision.id !== undefined && group.id === decision.id);

  const next: NamedGroup = {
    // How the group is drawn was decided elsewhere, and renaming it is not a
    // decision about its colour. Rebuilding the entry from the decision alone
    // silently reset both.
    ...(previous === undefined ? {} : presentationOf(previous)),
    name: decision.name,
    files: [...files],
    state: decision.state,
    ...(decision.id === undefined ? {} : { id: decision.id }),
  };

  if (previous === undefined) return [...stored, next];
  return stored.map((group) => (group === previous ? next : group));
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
  patch: {
    name?: string;
    color?: GroupColor;
    padding?: { x: number; y: number };
    files?: string[];
    geometry?: { x: number; y: number; width: number; height: number };
    locked?: boolean;
  },
): NamedGroup[] {
  const target = stored.find((group) => group.id === id);
  if (target === undefined) throw new Error(`no group with id ${id}`);
  if (patch.files !== undefined && target.origin !== 'manual') {
    throw new Error('membership comes from the import graph; only a manual group can be given files');
  }

  return stored.map((group) => {
    if (group.id !== id) return group;

    const next: NamedGroup = {
      ...group,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.color === undefined ? {} : { color: patch.color }),
      ...(patch.padding === undefined ? {} : { padding: patch.padding }),
      ...(patch.files === undefined ? {} : { files: [...patch.files] }),
      ...(patch.geometry === undefined ? {} : { geometry: patch.geometry }),
      ...(patch.locked === undefined ? {} : { locked: patch.locked }),
    };

    // Unlocking forgets the hand-placed frame outright, and the key is deleted
    // rather than set to undefined: exactOptionalPropertyTypes makes those two
    // different things, and only the missing key survives the JSON file. A
    // rectangle kept here would spring back the next time someone locked the
    // group, long after anyone remembered putting it there.
    if (patch.locked === false) delete next.geometry;
    return next;
  });
}

/**
 * Forget a group entirely. Distinct from rejecting one: a rejected group is
 * remembered so the next scan does not propose it again, while a drawn group
 * that is deleted was never proposed by anything and leaves nothing behind.
 */
export function deleteGroup(stored: readonly NamedGroup[], id: string): NamedGroup[] {
  return stored.filter((group) => group.id !== id);
}

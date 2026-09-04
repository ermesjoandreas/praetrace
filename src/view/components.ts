import { REACHES } from '../graph/edges.js';
import type { Graph, GraphNode } from '../graph/types.js';
import { keepsKind, type ViewFilter } from './filter.js';
import type { ComponentFacts, ProvidedSymbol } from './types.js';

/**
 * The categories as components: which file belongs to which box, and what
 * each box provides.
 *
 * A component diagram is the same data the class diagram is drawn from,
 * summed one level up. The groups come from label propagation over the import
 * graph (`cluster.ts`) and the names from the people and agents who gave them
 * (`project/groups.ts`); the lines between components are the imports between
 * their files added together; and what a component *provides* — the part that
 * makes this a component diagram rather than a package diagram — is the
 * symbols in it that a file outside it reaches. Nothing here is guessed at,
 * and nothing comes from a model: a box says what the imports said, at a
 * distance where a person can read it.
 *
 * This module decides the partition and the interface. Turning that into boxes
 * and lines — the pile facts a folder box answers, the weight arithmetic, the
 * rule that a call edge replaces the import beside it — is `select.ts`'s job
 * for every diagram, and it stays there so the two diagrams cannot add the
 * same edges up differently.
 */

/**
 * One row of what `/api/clusters` answers, as much of it as a component needs.
 *
 * Declared here rather than imported from `project/groups.ts`, which reads the
 * file the names live in: `view/` is pure, and this is the same reason
 * `git/types.ts` exists apart from `project/git.ts`. `GroupSuggestion` is
 * assignable to it as it stands.
 */
export interface ComponentSource {
  /** The cluster id: first member and size, which drifts as members do. */
  id: string;
  files: readonly string[];
  cohesion: number;
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  /** The cluster this one was found inside, or null for an outer group. */
  parent: string | null;
  /** The id the name is recorded under, when it is. */
  storedId?: string;
  /** A person drew it; the imports did not find it. */
  origin?: 'manual';
}

/** One component before it is a `ViewNode`: what only this module can say. */
export interface ComponentBox {
  id: string;
  label: string;
  /** The kept files this box stands for, sorted. Never empty. */
  files: string[];
  component: ComponentFacts;
}

export interface Partition {
  /** Every kept file -> the id of the box standing for it. */
  boxOf: ReadonlyMap<string, string>;
  /** In drawing order: the categories as they were listed, then the rest. */
  boxes: ComponentBox[];
}

/**
 * The one box that is not a category. Named for what it is rather than for
 * what it holds, so it keeps its place on the canvas as files join and leave
 * it — the same reason a bundle is named for its hop and not its members.
 */
export const UNCATEGORISED_ID = 'component:none';

/**
 * How many provided symbols a box lists before it says "and N more". A class
 * box has room for about a dozen rows, and a component of this project's
 * `view/` provides sixteen; the sort below is what decides which dozen.
 */
const PROVIDES_CAP = 12;

/**
 * Which kept file each category claims, and what each provides.
 *
 * Every kept file lands in exactly one box, or the lines between boxes would
 * count one import twice. The rules that get there, in order:
 *
 * - A category with categories inside it is not a box; the ones inside are.
 *   An outer group is exactly the union of its children, so the leaves cover
 *   the same files, and they are the level a whiteboard shows: on one graph
 *   of this repository the engine was three peers of 61, 11 and 3 files, and
 *   on the next — one unrelated edit later — one 75-file group at 97% with six
 *   inside it. Drawn at the outer level that was one box with three lines,
 *   and the one category a person had named was folded inside it; drawn at
 *   the leaves it is six boxes and twenty lines either way.
 *   The outer's name, when it has one, is the page's to draw as a frame around
 *   its children, joined by id off `/api/clusters`.
 * - A rejected category is not a box. Someone said it is not a piece of the
 *   architecture, and drawing it anyway would say the opposite; its files are
 *   in no category, which is what the rejection meant.
 * - A file two categories both hold goes to the one listed first — the derived
 *   groups come before the drawn ones, largest first — and the later box stands
 *   for what is left. Its `files` say exactly that, so a drawn category that
 *   overlaps a found one reads as smaller rather than as counting a file
 *   twice, and one drawn entirely inside a found one is no box at all. That
 *   is the call the page already makes when two frames overlap — the more
 *   cohesive keeps its frame, and a drawn one has no cohesion — so the two
 *   diagrams agree about which of them is on screen. This repository's own
 *   "Lang decoder", seven files drawn by hand inside the twelve the imports
 *   found as "Prog.lang decoder", is that case.
 * - A category none of whose files survived the filter is not a box: a box
 *   that stands for nothing says nothing.
 * - Whatever no category claimed is one box, so the picture never claims those
 *   files do not exist. Tests are always among them: they do not vote in the
 *   clustering and so are in no category by rule, which is what `tests=0` is
 *   for.
 *
 * `kept` is the file set after the view's filter, so hiding tests or showing
 * only changes narrows a component to what is on screen. `filter` is read for
 * its symbol kinds only.
 */
export function partitionByCategory(
  graph: Graph,
  categories: readonly ComponentSource[],
  kept: ReadonlySet<string>,
  filter: ViewFilter,
): Partition {
  const boxOf = new Map<string, string>();
  const claimed: { source: ComponentSource | null; id: string; files: string[] }[] = [];

  const outer = new Set<string>();
  for (const category of categories) if (category.parent !== null) outer.add(category.parent);

  for (const category of categories) {
    if (outer.has(category.id) || category.state === 'rejected') continue;
    const id = `component:${category.storedId ?? category.id}`;
    const files: string[] = [];
    for (const file of category.files) {
      if (!kept.has(file) || boxOf.has(file)) continue;
      boxOf.set(file, id);
      files.push(file);
    }
    if (files.length > 0) claimed.push({ source: category, id, files: files.sort() });
  }

  // A leaf a person rejected is not a piece of its own — but its files are
  // still inside the outer category they accepted, and the Categories panel
  // says so. Sending them to "no category" contradicted it. An accepted outer
  // claims whatever its leaves left behind; an unnamed outer claims nothing,
  // because nobody said it was a piece either.
  for (const category of categories) {
    if (!outer.has(category.id) || category.state !== 'accepted') continue;
    const id = `component:${category.storedId ?? category.id}`;
    const files: string[] = [];
    for (const file of category.files) {
      if (!kept.has(file) || boxOf.has(file)) continue;
      boxOf.set(file, id);
      files.push(file);
    }
    if (files.length > 0) claimed.push({ source: category, id, files: files.sort() });
  }

  const rest = [...kept].filter((file) => !boxOf.has(file)).sort();
  if (rest.length > 0) {
    for (const file of rest) boxOf.set(file, UNCATEGORISED_ID);
    claimed.push({ source: null, id: UNCATEGORISED_ID, files: rest });
  }

  const provided = collectProvided(graph, boxOf, kept, filter);

  return {
    boxOf,
    boxes: claimed.map(({ source, id, files }) => ({
      id,
      label: source === null ? `${count(files.length, 'file')} in no category` : labelOf(source, files.length),
      files,
      component: {
        name: source?.name ?? null,
        ...(source?.storedId === undefined ? {} : { storedId: source.storedId }),
        // A drawn category has no cohesion to report — `mergeGroups` writes 0
        // there, and 0 is the one number this must not print.
        ...(source === null || source.origin === 'manual' ? {} : { cohesion: source.cohesion }),
        ...(source?.origin === 'manual' ? { origin: 'manual' as const } : {}),
        ...(source === null ? { uncategorised: true as const } : {}),
        provides: providesOf(provided.get(id)),
      },
    })),
  };
}

/** The panel's own words for a category nobody has named, over what the box holds. */
function labelOf(source: ComponentSource, held: number): string {
  return source.name ?? `${count(held, 'file')} together`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** One symbol's reaches from outside its box, before they are summed. */
interface Reach {
  node: GraphNode;
  /** Distinct files outside the box; a file reaching it three ways counts once. */
  from: Set<string>;
  /** Cleared by the first reach that was found rather than guessed. */
  guessed: boolean;
}

/**
 * Box id -> symbol id -> who outside reaches it.
 *
 * One pass over the graph's own edges rather than the lifted file edges,
 * because the question is about symbols and a file edge has already forgotten
 * which one. All four reaching kinds and not the view's `edgeKinds`: see
 * `ProvidedSymbol`. Both ends must be kept files, so a reach from a hidden
 * test does not put a symbol on a box's interface while the test is off
 * screen — the same population the lines are drawn from.
 */
function collectProvided(
  graph: Graph,
  boxOf: ReadonlyMap<string, string>,
  kept: ReadonlySet<string>,
  filter: ViewFilter,
): Map<string, Map<string, Reach>> {
  const provided = new Map<string, Map<string, Reach>>();

  for (const edge of graph.edges) {
    if (!REACHES.has(edge.kind)) continue;
    const from = graph.nodes.get(edge.from);
    const to = graph.nodes.get(edge.to);
    // Every reaching kind ends at a symbol; a file at the far end would be a
    // graph this module does not know how to read, and is left alone.
    if (!from || !to || to.kind === 'file' || !keepsKind(to.kind, filter)) continue;
    if (!kept.has(from.filePath) || !kept.has(to.filePath)) continue;

    const fromBox = boxOf.get(from.filePath);
    const toBox = boxOf.get(to.filePath);
    if (fromBox === undefined || toBox === undefined || fromBox === toBox) continue;

    let symbols = provided.get(toBox);
    if (!symbols) provided.set(toBox, (symbols = new Map()));
    let reach = symbols.get(to.id);
    if (!reach) symbols.set(to.id, (reach = { node: to, from: new Set(), guessed: true }));
    reach.from.add(from.filePath);
    if (edge.guessed !== true) reach.guessed = false;
  }

  return provided;
}

/**
 * Most reached first, then by name, then by id, so the cut keeps the symbols
 * that explain the box and two runs over one graph list them in one order.
 */
function providesOf(symbols: ReadonlyMap<string, Reach> | undefined): ComponentFacts['provides'] {
  if (symbols === undefined) return { symbols: [], total: 0 };

  const rows: ProvidedSymbol[] = [...symbols.values()].map(({ node, from, guessed }) => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    owner: node.owner ?? null,
    reachedFrom: from.size,
    ...(guessed ? { guessed: true as const } : {}),
  }));
  rows.sort(
    (a, b) => b.reachedFrom - a.reachedFrom || a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );

  return { symbols: rows.slice(0, PROVIDES_CAP), total: rows.length };
}

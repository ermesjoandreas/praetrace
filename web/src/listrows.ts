import type { GitFileStatus, LanguageId, ViewGraph, ViewNode } from './api';

/**
 * The arithmetic behind the list — one row per box, the numbers on the row,
 * the order the rows stand in. Pure, and apart from `ListView.tsx` so it can
 * be run under `node --test` the way `layout.ts` is: a `.tsx` file cannot be.
 *
 * A list is what a scope becomes past `LIST_ABOVE` boxes. The decision is the
 * engine's (`ViewGraph.presentation`) and is never made again here; what this
 * file decides is what a row says, and — the half that matters while an agent
 * is saving — what a row does *not* do, which is move.
 */

/** What a row is sorted by. Every column, so the header is the control. */
export type SortKey = 'name' | 'kind' | 'members' | 'in' | 'out' | 'git' | 'test';
export type SortDir = 'asc' | 'desc';
export interface Sort {
  key: SortKey;
  dir: SortDir;
}

/**
 * One row. Everything a box wears, and two numbers a box only ever drew as
 * lines: how many lines come in, and how many go out.
 */
export interface ListRow {
  id: string;
  label: string;
  kind: ViewNode['kind'];
  /** Outside the scope: a directory a line reaches, drawn for the line's sake. */
  external: boolean;
  /** Symbols a file declares; files a folder, bundle or component stands for. */
  members: number;
  files: number;
  /**
   * Σ `weight` over the view's edges ending here, and starting here. Counted
   * from what the view holds and nothing else — the collapsed outside
   * directories included, because their lines are on the view too. A floor:
   * a call through an untyped receiver is not in the graph, and a kind not
   * opted into (`?edges=`) is not on the view. The column's title says so.
   */
  in: number;
  out: number;
  gitStatus: GitFileStatus | null;
  gitChanged: number;
  language: LanguageId | null;
  test: boolean;
  parseError: boolean;
  unresolved?: ViewNode['unresolved'];
}

/** The rows for a view, in the view's own order. */
export function rowsOf(view: Pick<ViewGraph, 'nodes' | 'edges'>): ListRow[] {
  const inward = new Map<string, number>();
  const outward = new Map<string, number>();
  for (const edge of view.edges) {
    inward.set(edge.to, (inward.get(edge.to) ?? 0) + edge.weight);
    outward.set(edge.from, (outward.get(edge.from) ?? 0) + edge.weight);
  }
  return view.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    external: node.external,
    // A file counts what it declares; everything else stands for a pile and
    // counts the pile, the way its box draws "12 files" where the members go.
    members: node.kind === 'file' ? node.members.length : node.files.length,
    files: node.files.length,
    in: inward.get(node.id) ?? 0,
    out: outward.get(node.id) ?? 0,
    gitStatus: node.gitStatus,
    gitChanged: node.gitChanged,
    language: node.language,
    test: node.test,
    parseError: node.parseError,
    ...(node.unresolved === undefined ? {} : { unresolved: node.unresolved }),
  }));
}

/**
 * Which way a column sorts on its first click. A count sorts biggest first —
 * "which of these is imported most" is the question a click on `in` asks —
 * and a name sorts A to Z. The second click flips it.
 */
export function firstDirection(key: SortKey): SortDir {
  return key === 'name' || key === 'kind' ? 'asc' : 'desc';
}

/** What a click on a header does to the sort: picks the column, or flips it. */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key !== key) return { key, dir: firstDirection(key) };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

const KIND_ORDER: Record<ViewNode['kind'], number> = { file: 0, folder: 1, bundle: 2, component: 3 };
const GIT_ORDER: Record<GitFileStatus, number> = { modified: 0, added: 1, untracked: 2, renamed: 3, deleted: 4 };

/** Inside the scope before outside it; then the label, the way a directory lists. */
function byName(a: ListRow, b: ListRow): number {
  return Number(a.external) - Number(b.external) || a.label.localeCompare(b.label);
}

function measure(row: ListRow, key: SortKey): number {
  switch (key) {
    case 'kind':
      return KIND_ORDER[row.kind];
    case 'members':
      return row.members;
    case 'in':
      return row.in;
    case 'out':
      return row.out;
    case 'git':
      // A changed file first, then by what happened to it; a folder by how
      // many of its files moved. Unchanged is last either way.
      return row.gitStatus === null ? (row.gitChanged > 0 ? 100 + row.gitChanged : 0) : 200 - GIT_ORDER[row.gitStatus];
    case 'test':
      return Number(row.test);
    default:
      return 0;
  }
}

/**
 * The rows in the order a header asks for. Ties fall back to the name, so a
 * column of zeros reads as the directory does and not as whatever order the
 * engine happened to emit.
 */
export function sortRows(rows: readonly ListRow[], sort: Sort): ListRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === 'name') return sign * byName(a, b);
    return sign * (measure(a, sort.key) - measure(b, sort.key)) || byName(a, b);
  });
}

/**
 * Mark, do not move — the list's half of the rule the canvas keeps.
 *
 * `sorted` is the order the sort would give the rows now; `held` is the order
 * the reader was looking at before the update, or null when there is no such
 * order — a new view, a header clicked. With nothing held the sort is the
 * answer. With one, every row the reader could see stays exactly where it
 * was, a row that has gone is dropped, and a row that is new is put where the
 * sort would have put it among the rows already standing — after the nearest
 * one that sorts before it — so a name-sorted list still reads as sorted
 * without a single existing row changing place. A count that changed changes
 * on its row, and the row stays put: that is what a mark is.
 */
export function holdOrder(held: readonly string[] | null, sorted: readonly string[]): string[] {
  if (held === null) return [...sorted];
  const present = new Set(sorted);
  const order = held.filter((id) => present.has(id));
  const standing = new Set(order);
  const rank = new Map(sorted.map((id, index) => [id, index]));
  for (const id of sorted) {
    if (standing.has(id)) continue;
    const mine = rank.get(id) ?? 0;
    // The last row already standing that the sort puts before this one. Rows
    // are walked in their held order, so "last" is by position on screen.
    let after = -1;
    order.forEach((other, index) => {
      if ((rank.get(other) ?? 0) < mine) after = index;
    });
    order.splice(after + 1, 0, id);
    standing.add(id);
  }
  return order;
}

/**
 * The chip in the breadcrumb row that says how the slice is being shown, and
 * what one click does about it. Null when there is nothing to say: a diagram
 * the threshold chose is the ordinary state and gets no chip.
 *
 * `asked` is `spec.as` as the URL carried it; `shown` is what the engine
 * decided; `boxes` is how many. Four sentences:
 *
 *   - the threshold made a list: say so, and the click draws it anyway;
 *   - `as=diagram` over the threshold: the page's own warning, as the flow
 *     overlay wears for a big flow, and the click takes the override off;
 *   - `as=list` under it, or `as=diagram` under it: the override is doing
 *     work or none, and either way the click takes it off.
 */
export interface PresentationChip {
  label: string;
  title: string;
  /** What the click does: force the diagram, or drop the `as` key. */
  action: 'draw' | 'drop';
  /** The page telling on itself — 106 boxes drawn on request wear the warning. */
  warning: boolean;
}

export function presentationChip(
  asked: 'list' | 'diagram' | undefined,
  shown: 'list' | 'diagram',
  boxes: number,
  threshold: number,
): PresentationChip | null {
  const count = `${boxes} ${boxes === 1 ? 'box' : 'boxes'}`;
  if (asked === undefined) {
    if (shown !== 'list') return null;
    return {
      label: `${count} — shown as a list`,
      title: `Above ${threshold} boxes a scope is shown as a list, with the numbers on the rows. Click to draw the diagram anyway.`,
      action: 'draw',
      warning: false,
    };
  }
  if (asked === 'diagram') {
    const big = boxes > threshold;
    return {
      label: big ? `${count} — drawn anyway` : 'drawn as a diagram',
      title: big
        ? `${count} is past the ${threshold} a scope is drawn at; this diagram was asked for. Click to show it as a list.`
        : `The URL asks for a diagram, which is what ${count} would be anyway. Click to drop the request.`,
      action: 'drop',
      warning: big,
    };
  }
  return {
    label: 'shown as a list',
    title: `The URL asks for a list. Click to let the count decide: ${count} is ${
      boxes > threshold ? 'a list either way' : 'a diagram'
    }.`,
    action: 'drop',
    warning: false,
  };
}

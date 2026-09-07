import type { EntryPoint, GitFileStatus } from './api';

/**
 * The arithmetic behind the front page — which URL is the front page, how the
 * manifest's entry points fold into groups, what a line of changes says.
 * Pure, and apart from `Overview.tsx` so it runs under `node --test` the way
 * `listrows.ts` does beside `ListView.tsx`: a `.tsx` file cannot.
 *
 * The front page is what `/` shows instead of the root diagram. A map of
 * everything never works; the overview is a list, and the diagram is
 * something you go to. Every list on the page is the engine's
 * (`src/view/overview.ts`); what this file decides is how the URL says
 * "front page", and how 57 manifest rows become six.
 */

/**
 * Whether a URL is the front page: nothing asked for but, at most, a commit.
 *
 * The key's presence and never its value — `?scope=` with nothing after it
 * is the root *diagram*, which is how the old root is still reached, and
 * `?tests=0` is a filter, and a filter filters a diagram, so a URL that asks
 * for one asks for the diagram it filters. Every URL that worked before this
 * page existed still lands where it did; only a bare `/` moved.
 */
export function isFrontPage(search: string): boolean {
  for (const key of new URLSearchParams(search).keys()) {
    if (key !== 'at') return false;
  }
  return true;
}

/**
 * The front page's own URL: nothing, or the commit. Every filter is dropped
 * on the way — a filter filters a diagram, and there is none here — and the
 * rows on the page build their links afresh, so a `tests=0` set three views
 * ago does not ride into the focus view an entry point opens.
 */
export function homeSearch(at: string | null): string {
  return at === null ? '' : `?at=${encodeURIComponent(at)}`;
}

/**
 * Where the old root diagram went: `?scope=` names the root outright — the
 * key is what makes it a diagram — and `as=diagram` draws it whatever its
 * size, because "Draw the whole project" is the one row that asks for the
 * big graph on purpose and a project with forty top-level directories would
 * otherwise answer it with the list the front page already is.
 */
export function rootDiagramSearch(at: string | null): string {
  return `?scope=&as=diagram${at === null ? '' : `&at=${encodeURIComponent(at)}`}`;
}

/** The manifest's entry points, grouped by how they are known. */
export interface EntryGroup {
  why: string;
  files: EntryPoint[];
}

/**
 * One row per reason rather than one per file: astrupdata names 57 entry
 * points — 36 pages, 7 routes, 4 layouts, 3 fallbacks, 6 scripts and a main —
 * and 57 rows is the hairball again, as a list. Biggest group first, so the
 * first line says what kind of project this mostly is; the files inside a
 * group in the engine's order, which is by path.
 */
export function manifestGroups(manifest: readonly EntryPoint[]): EntryGroup[] {
  const groups = new Map<string, EntryPoint[]>();
  for (const entry of manifest) {
    const files = groups.get(entry.why) ?? [];
    files.push(entry);
    groups.set(entry.why, files);
  }
  return [...groups.entries()]
    .map(([why, files]) => ({ why, files }))
    .sort((a, b) => b.files.length - a.files.length || a.why.localeCompare(b.why));
}

/**
 * Below this many manifest entries the groups are drawn open: a handful of
 * rows is read as it is, and folding four scripts behind a twistie is a
 * click tax. At it and above they fold, with the count on the group row.
 */
export const FOLD_MANIFEST_AT = 9;

const STATUS_ORDER: readonly GitFileStatus[] = ['modified', 'added', 'untracked', 'renamed', 'deleted'];

/** "3 modified · 1 untracked" — the statuses that are non-zero, in the order the list sorts them. */
export function changesSummary(byStatus: Record<GitFileStatus, number>): string {
  return STATUS_ORDER.filter((status) => byStatus[status] > 0)
    .map((status) => `${byStatus[status]} ${status}`)
    .join(' · ');
}

/** The file's name, and the directory it sits in — empty at the root, so nothing is drawn. */
export function splitPath(path: string): { name: string; where: string } {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? { name: path, where: '' } : { name: path.slice(slash + 1), where: path.slice(0, slash) };
}

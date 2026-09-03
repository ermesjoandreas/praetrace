import type { FileCoverage, SymbolCoverage } from '../report/types.js';
import type { GitFileStatus } from '../git/types.js';
import type { EdgeKind, NodeKind } from '../graph/types.js';
import type { LanguageId } from '../lang/types.js';
import type { ViewFilter } from './filter.js';

/**
 * How a count of dependents or callers was arrived at — never how complete it is.
 *
 * The word this replaces was `full`, and it was printed beside a note saying a
 * function passed by value is not tracked. TanStack/query's `QueryObserver`
 * answered `full` and "used by 16" where grep finds 26 non-test sites in 8
 * packages, because every one of the seven adapters hands the class to another
 * function rather than calling it. Both words here say how the graph looked
 * and neither says what there was to find: `tracked`, references by name
 * followed across every file that imports the declaring one; `partial`, a way
 * of reaching this that the graph knows it does not follow. Whichever it is,
 * the count beside it is a floor, and the note says what is missing from it.
 *
 * Deliberately not called `Coverage`: in this file that word is the test
 * report's — `ViewNode.coverage` is lines a run executed — and one name over
 * two meanings is how a reader leaves with the wrong one.
 */
export type Tracking = 'tracked' | 'partial';

/**
 * Which slice of the graph to show. Carried in the page URL, so navigation is
 * links rather than client state: the back button works and a view is shareable.
 */
export interface ViewSpec {
  /** Directory to look inside; '' is the project root. */
  scope: string;
  /** File to centre on. When set, scope is ignored. */
  focus: string | null;
  /** Hops from the focus, following imports in both directions. */
  depth: number;
  /** What to leave out. Filtering is not navigating. */
  filter: ViewFilter;
  /**
   * A commit to draw the project as of, or null for the working tree now.
   *
   * A view and not a session setting — unlike the git base — because "how did
   * this look at that commit" is a place someone wants to link to and step back
   * out of. `selectView` does not act on it: it decides which graph to select
   * *from*, which is the server's choice, and a pure function handed a graph
   * cannot tell one commit's from another's.
   */
  at: string | null;
}

export interface ViewMember {
  /**
   * The graph id, so the page can ask about this exact symbol.
   *
   * Carried rather than rebuilt from name and owner: `uniqueId` disambiguates two
   * symbols sharing a name in one file with a `~2` suffix, and a page that
   * reconstructed the id would ask about the wrong one of the pair.
   */
  id: string;
  name: string;
  kind: NodeKind;
  /** Where the symbol starts, so the page can open an editor on it. */
  line: number;
  /**
   * The class this is a member of, so a box can nest it under its owner. From
   * the node, not the id: a property-assigned `app.init` has a dot and no
   * owner.
   */
  owner: string | null;
  /** UML's +, - and #. null means the source did not say, which is public. */
  visibility: 'public' | 'private' | 'protected' | null;
  isStatic: boolean;
  isAbstract: boolean;
  /**
   * Whether the test suite ever ran this symbol, when a report said so.
   *
   * Absent is the ordinary answer, not a missing one: most of a graph has no
   * runtime function to count — a field, an interface and a type never do —
   * and a run that never imported the file says nothing about it either. So
   * `unknown` is spelled as no property at all, and a row without this must
   * never be drawn as 0%. `never` is the answer worth having and it is rare:
   * 99 of zod's 4201 symbols, none of express's 145.
   */
  coverage?: Exclude<SymbolCoverage, 'unknown'>;
  /**
   * An edge this view draws runs through this symbol.
   *
   * A box has room for about a dozen rows and a file may declare forty, so
   * something has to choose which of them are drawn. Document order chooses
   * whichever the parser saw first, which answers no question at all; this
   * marks the rows that explain the box's own arrows, and the page picks from
   * them before falling back to the rest.
   *
   * Absent is the common answer, and under the default edge kinds it is every
   * row: an `imports` edge runs file to file, so no single symbol writes it.
   * `calls`, `extends`, `implements` and `associates` run between symbols and
   * are what mark anything here — and they are what gets asked for once a
   * diagram is too big to read, which is when this matters.
   */
  linked?: true;
}

export interface ViewNode {
  /**
   * A file path, a directory path when the box stands for a whole directory,
   * or a bundle's own id — see `kind`.
   */
  id: string;
  /**
   * What the box stands for.
   *
   * A `folder` collapses a directory a scope holds too many files to draw one
   * by one. A `bundle` collapses neighbours a *focus* has too many of: 278 of
   * TanStack/query's boxes at depth 1 were one file's importers, and 278 boxes
   * answer nothing. Both stand for the paths in `files`, and neither is a
   * `GraphNode` — which is why this type exists. Every field a folder answers
   * over the pile it holds — `gitChanged`, `language`, `test`, `parseError`,
   * `unresolved` — a bundle answers the same way, and both leave `members` and
   * `coverage` alone for the same reasons.
   */
  kind: 'file' | 'folder' | 'bundle';
  label: string;
  /** Symbols the file declares; empty on a folder and on a bundle. */
  members: ViewMember[];
  /** The files this box stands for; just itself for a file node. */
  files: string[];
  /** Outside the current scope, kept only to show what the scope connects to. */
  external: boolean;
  focused: boolean;
  /** Its own git status. null for folder boxes and for unchanged files. */
  gitStatus: GitFileStatus | null;
  /** How many of `files` differ from the base. 0 or 1 for a file box. */
  gitChanged: number;
  /**
   * The one language every file in this box is written in, or null when they
   * differ. A mixed folder says nothing rather than naming its majority: a
   * marker that is right most of the time is wrong in the way that looks
   * authoritative. Never null for a file box.
   */
  language: LanguageId | null;
  /**
   * A test, fixture or story — see `isTestFile`. A folder box is a test when
   * every file in it is: one test among source is source with a test beside
   * it, not a suite.
   */
  test: boolean;
  /**
   * The parser hit a syntax error in this file, or in one of a folder's, so
   * symbols may be missing. Carried onto the box because a file that draws
   * "0 symbols" is otherwise indistinguishable from an empty one.
   */
  parseError: boolean;
  /**
   * The lines the test report has a count for, and how many of them ran.
   *
   * `lines` is what the report measured, not what the file holds, so the
   * percentage is `covered / lines`. File boxes only: a folder stands for
   * files a run may have reached one at a time, and one number over the pile
   * would read as a claim about all of them. Absent means the report has no
   * entry for this file — vitest 4 reports only what a run imported, nyc omits
   * what the script excluded — and absent is not zero.
   */
  coverage?: FileCoverage;
  /**
   * References this box's files made that landed nowhere: an import naming a
   * module the scan never saw, a call naming something no declaration in reach
   * answers to. Carried up from `GraphNode.unresolved`.
   *
   * Counted here rather than drawn, because a line to nothing is not a line.
   * It is what lets a box with no arrows say which kind of nothing it is —
   * code with no coupling, or coupling the tool could not follow — and the
   * difference is not small: express drops 903 call references, zod 2 530,
   * TanStack/query 4 725.
   *
   * A folder or a bundle sums the files it stands for, the way `gitChanged`
   * does and unlike `coverage`: every file in the graph has a number here, so
   * a sum claims nothing that was not counted. Absent when both are zero.
   */
  unresolved?: { imports: number; calls: number };
}

export interface ViewEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** How many underlying graph edges collapsed into this one. */
  weight: number;
  /**
   * Every one of those `weight` references was resolved by something weaker
   * than a binding — see `GraphEdge.guessed`.
   *
   * Absent, the ordinary answer, means at least one of them was found rather
   * than guessed, and one found reference is enough to make the line itself
   * certain. Drawing the whole line as uncertain because the twelfth reference
   * behind it was a guess would be the overstatement this field exists to
   * prevent, in the other direction.
   */
  guessed?: true;
}

/** How much of a project one language accounts for. */
export interface LanguageCount {
  id: LanguageId;
  /** The registry's word for it — 'C#', not 'csharp' — so the page needs no table. */
  label: string;
  files: number;
}

export interface ViewGraph {
  nodes: ViewNode[];
  edges: ViewEdge[];
  /** The spec actually used, which may differ from the one asked for. */
  spec: ViewSpec;
  /** Breadcrumb for the current scope, root first. */
  trail: { label: string; scope: string }[];
  /** Files inside the scope before any grouping. */
  totalFiles: number;
  /**
   * Files in the whole graph this was selected from, before any filter. On a
   * frozen view it is the commit's count, which the Repository panel needs:
   * `/api/repo` counts the working tree and cannot know what last week held.
   */
  fileCount: number;
  /**
   * How many test files `hideTests` removed, project-wide like `git.changed`
   * — a count that shrank because you navigated into a directory would read
   * as tests disappearing. 0 when the filter is off.
   */
  hiddenTests: number;
  /**
   * Files in the whole graph whose parse hit a syntax error, project-wide
   * like `fileCount`: the status bar reads it beside "files in this project",
   * and a count of the boxes in the slice would be answering a different
   * question under the same words.
   */
  parseErrors: number;
  /**
   * What the whole project named and the graph could not find — the same
   * population `GraphNode.unresolved` counts per file, summed over every file
   * in the graph rather than over the boxes drawn. The status bar reads it
   * beside the syntax-error count, and two numbers standing side by side must
   * be measured over the same files or one of them is quietly about a slice.
   */
  unresolved: { imports: number; calls: number };
  /** True when boxes stand for directories rather than files. */
  grouped: boolean;
  /**
   * What the whole project is written in, biggest first — not what this slice
   * is. It answers "what is this repository", and a count that shrank because
   * you navigated into a directory would be answering something else.
   */
  languages: LanguageCount[];
  /** null when the project is not a git work tree. */
  git: { base: string; requested: string; branch: string | null; changed: number } | null;
  /**
   * The commit this was selected from, echoed back, or null for now.
   *
   * At the top level and not only inside `spec` so the page has one place to
   * ask "is what I am looking at frozen" — the answer that decides whether a
   * live update may touch the diagram at all.
   */
  at: string | null;
}

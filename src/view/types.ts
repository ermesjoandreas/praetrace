import type { GitFileStatus } from '../git/types.js';
import type { EdgeKind, NodeKind } from '../graph/types.js';
import type { LanguageId } from '../lang/types.js';
import type { ViewFilter } from './filter.js';

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
}

export interface ViewNode {
  /** A file path, or a directory path when this box stands for many files. */
  id: string;
  kind: 'file' | 'folder';
  label: string;
  /** Symbols the file declares; empty for folders. */
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
}

export interface ViewEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** How many underlying graph edges collapsed into this one. */
  weight: number;
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

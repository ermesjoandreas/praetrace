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
}

export interface ViewMember {
  name: string;
  kind: NodeKind;
  /** Where the symbol starts, so the page can open an editor on it. */
  line: number;
  /** The class this is a member of, so a box can nest it under its owner. */
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
}

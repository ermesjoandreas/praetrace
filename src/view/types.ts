import type { EdgeKind, NodeKind } from '../graph/types.js';
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
}

export interface ViewEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** How many underlying graph edges collapsed into this one. */
  weight: number;
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
}

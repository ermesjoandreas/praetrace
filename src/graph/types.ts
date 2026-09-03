/**
 * The shape of the graph. This is the contract every other layer reads through:
 * parsers produce it, renderers consume it, nothing else defines structure.
 */

export type NodeKind = 'file' | 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';

export type EdgeKind = 'imports' | 'extends' | 'implements' | 'calls' | 'contains' | 'associates';

export interface GraphNode {
  /**
   * Stable across re-parses: `${filePath}` for files,
   * `${filePath}#${symbolName}` for symbols, and
   * `${filePath}#${ClassName}.${methodName}` for a class member — a separate
   * namespace, so a method can never collide with a top-level symbol of the
   * same name.
   *
   * Nearly. A JavaScript function assigned to a property keeps the dot in its
   * name — `app.init` in express's application.js — so its id is spelled the
   * way a member's is, and a real class `app` declaring `init` in the same
   * file would collide with it. Accepted: the file would be strange, and the
   * `owner` below is what says which of the two an id is, never the id.
   */
  id: string;
  kind: NodeKind;
  name: string;
  /** POSIX path relative to the scanned root, so ids do not vary by machine. */
  filePath: string;
  range: { startLine: number; endLine: number };
  /**
   * The class this is a member of, when it is one. Absent on a top-level
   * symbol — including one whose name happens to contain a dot, which is why
   * this is carried rather than read back off the id: parsed off `app.init`,
   * the id gave an owner `app`, and the page drew the function indented under
   * a class that does not exist.
   */
  owner?: string;
  /** File nodes only: unix milliseconds of the last write. */
  modifiedAt?: number;
  /**
   * File nodes only: tree-sitter recovered from a syntax error somewhere in the
   * file. Present rather than false, like the modifiers below, and carried on
   * the node because it is the one thing that separates a file that declares
   * nothing from one that declares plenty and lost it to a stray brace.
   */
  parseError?: true;
  /**
   * UML's three modifiers, present only when the source stated them. Carried on
   * the node because they describe the declaration, not a relationship.
   */
  visibility?: 'public' | 'private' | 'protected';
  isStatic?: boolean;
  isAbstract?: boolean;
  /** Fields only: `Logger[]` rather than `Logger`, for the association's 1..*. */
  many?: boolean;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Graph {
  nodes: ReadonlyMap<string, GraphNode>;
  edges: readonly GraphEdge[];
}

/**
 * What changed between two graph states. Produced by every mutation so the
 * renderer can animate a diff instead of redrawing.
 */
export interface GraphDelta {
  /** Added or changed nodes — apply with upsert semantics. */
  upsertedNodes: GraphNode[];
  removedNodeIds: string[];
  addedEdges: GraphEdge[];
  removedEdges: GraphEdge[];
}

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
   */
  id: string;
  kind: NodeKind;
  name: string;
  /** POSIX path relative to the scanned root, so ids do not vary by machine. */
  filePath: string;
  range: { startLine: number; endLine: number };
  /** File nodes only: unix milliseconds of the last write. */
  modifiedAt?: number;
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

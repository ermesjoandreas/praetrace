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
  /**
   * File nodes only: how many references this file made that resolved to
   * nothing — an import naming a module the scan never saw, a call naming
   * something no declaration or binding in reach answers to. Absent when both
   * are zero, like the flags above.
   *
   * Kept because dropping them is what makes a file with no coupling
   * indistinguishable from a file we could not read: express drops 903 call
   * references this way, zod 2 530 and TanStack/query 4 725, and a box with no
   * edges says "nothing depends on this" in both cases. A count and never an
   * edge — a line to a node we could not name would be the lie this exists to
   * prevent.
   */
  unresolved?: { imports: number; calls: number };
}

export interface GraphEdge {
  /**
   * A node id, and for a `calls` edge that may be a *file*. A call written
   * outside every function, class and method — a bare statement, a top-level
   * `const schema = z.object(...)`, an IIFE's arguments — has no symbol to
   * hang on, so the file carries it. The alternative was a node for every
   * top-level constant, which would put a box on the diagram for something
   * nobody calls by name; the file already has one.
   *
   * It says *this file calls that*, not *this file calls that at load*: a call
   * inside an unnamed function nothing declares — a method of an object
   * literal, the arrow handed to `test(...)` — is outside every symbol too,
   * and lands here for want of anywhere better. Two of fifteen sampled from
   * zod were of that shape. The coupling is real either way; the timing is
   * what the edge cannot promise.
   *
   * Every other kind is written by a declaration and so starts at a symbol.
   */
  from: string;
  to: string;
  kind: EdgeKind;
  /**
   * How we know. Absent means a declaration in the file itself, or an import
   * the file wrote down, pointed straight at the other end. `true` means the
   * name was matched against a table nothing in the referring file named —
   * today only the whole-table fallback for a language that records no
   * bindings, where the answer is whichever imported file happens to export
   * the name.
   *
   * A field rather than a suffix on EdgeKind, because a suffix would push the
   * `?edges=` parser and `filter.edgeKinds` onto prefix matching for a fact
   * that is not about what the edge means. Absent rather than false, the same
   * idiom as `GraphNode.parseError`: a graph that says nothing is a graph that
   * found the answer.
   */
  guessed?: true;
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

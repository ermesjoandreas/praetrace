/**
 * The shape of the graph. This is the contract every other layer reads through:
 * parsers produce it, renderers consume it, nothing else defines structure.
 */

export type NodeKind = 'file' | 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';

/**
 * `depends` is UML's dependency — a class that names another only as a
 * parameter or return type of its own operations, and holds no field of it.
 *
 * A kind of its own rather than a flag on `associates`, for two reasons that
 * are the same reason. `edges.ts` says which kinds mean one symbol *reaches*
 * another, `associates` is one of them, and a dependency must not be: a class
 * that takes a Store as a parameter does not hold, run or extend it, and a
 * flag would have put it in the hook's sentence. The panel lists a dependency
 * by a choice of its own, marked as such on `SymbolRelation.edge` in
 * view/detail.ts; the hook reads REACHES and stays narrow. And a kind is what
 * the `?edges=` filter and the socket spec
 * already switch on, so it is opt-in the way `associates` is, with nothing
 * downstream growing a second test for a flag. The kind list is meant to stay
 * stable; adding to it is the one change that is — everything that switches
 * over EdgeKind exhaustively is told by the compiler, which is the point.
 */
export type EdgeKind = 'imports' | 'extends' | 'implements' | 'calls' | 'contains' | 'associates' | 'depends';

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
   * Classes only: a UML stereotype a declaration in the project put on this
   * classifier, and the declaration that did — `statedBy` is the node id of
   * the field whose type stated it, so the panel can say "a table — stated by
   * CatalogContext.Baskets in CatalogContext.cs" rather than assert it.
   *
   * `table` is the one value: an Entity Framework `DbSet<T>` names T. Derived
   * in the store rather than parsed, because the line that says it sits on a
   * different class in a different file from the class it describes — the
   * same reason a role rides on the edge. A stereotype and not a NodeKind: a
   * JPA entity has methods and a superclass and is a class, and a second box
   * kind would split one declaration in two. Absent means no line said so,
   * never "not a table": EF reaches tables through fluent configuration the
   * graph does not read, so the mark under-counts and never over-counts.
   */
  stereotype?: { name: 'table'; statedBy: string };
  /**
   * Fields only: `x?: T`, `T | null`, C#'s `T?`, Java's `Optional<T>` — the
   * far end may be absent, which is the association's 0..1. Present rather
   * than false, like the flags above.
   */
  optional?: true;
  /**
   * The sibling symbol whose body this is another name for, when the source
   * bound one function to several names — express writes `res.contentType =
   * res.type = function`, and both are real names a reader looks up.
   *
   * Carried through from `ParsedSymbol.aliasOf` rather than recomputed from
   * matching ranges, because two symbols can share a range without being one
   * body and only the parser saw the assignment that made these one. Whatever
   * counts symbols leaves the marked ones out: counting both said response.js
   * held 24 where it holds 22.
   */
  aliasOf?: string;
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

/**
 * One attribute that spells an association; see `GraphEdge.roles`.
 *
 * Everything here is what the field's declaration wrote, and absent means it
 * wrote nothing — never that the opposite holds. A diamond drawn from a guess
 * is worse than no diamond.
 */
export interface AssociationRole {
  /** The field's own name: UML's role name at the far end of the line. */
  name: string;
  /** `T[]`, `List<T>`: 1..* rather than 1. */
  many?: true;
  /** `x?: T`, `T | null`, `T?`, `Optional<T>`: 0..1 rather than 1. */
  optional?: true;
  /**
   * Composition when the class builds the part itself, aggregation when the
   * part is handed in through the constructor. One field with two states
   * rather than two booleans, because the two are exclusive by definition —
   * a part the whole created and owns cannot also be one it was merely given
   * — so two flags would admit a state that means nothing. The third state is
   * absence: the source said neither, or said both (`x = new T()` beside
   * `if (t) this.x = t`), and a claim that is half true reads as authoritative.
   * The parser reports both when it saw both; the graph is what decides.
   */
  ownership?: 'composition' | 'aggregation';
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
  /**
   * `associates` only: the fields that spell this association, one role per
   * field, in declaration order. A list because the edge is one per pair of
   * classifiers — `left: Node; right: Node` is one line from Tree to Node —
   * and a single role would keep the first field and drop the second, which
   * is a count wrong in the safe-looking direction. Never empty when present.
   */
  roles?: AssociationRole[];
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

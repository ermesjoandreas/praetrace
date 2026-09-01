/**
 * What one file looks like after parsing. Deliberately free of graph ids and
 * cross-file knowledge: a file can be parsed in isolation, which is what makes
 * incremental re-parsing possible. Resolving these names to other files is the
 * graph layer's job.
 */

export type SymbolKind = 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /**
   * The class this belongs to, for a method. Absent on a top-level symbol.
   *
   * Carried as a name rather than an id because a parsed file knows nothing
   * about ids — that is the graph layer's job, and keeping it that way is what
   * lets a file be parsed in isolation.
   */
  owner?: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Bare type names, unresolved: `extends Base` yields `['Base']`. */
  extends: string[];
  implements: string[];
  /** Names invoked anywhere inside this symbol, deduplicated and unresolved. */
  calls: string[];
  /**
   * UML's three, when the source states one. Absent means the language default,
   * which for TypeScript is public — recorded as absent rather than as 'public'
   * so the parser reports what was written, not what it inferred.
   */
  visibility?: 'public' | 'private' | 'protected';
  isStatic?: boolean;
  isAbstract?: boolean;
  /**
   * The declared type of a field, as a bare name. This is what an association
   * is drawn from: `private log: Logger` is the has-a relationship UML exists
   * to show, and an import edge cannot express it — an import says this file
   * mentions that one, an association says every Store holds a Logger.
   */
  typeName?: string;
  /** `Logger[]` rather than `Logger`, so the association can carry 1..*. */
  many?: boolean;
}

export interface ParsedFile {
  /** POSIX path relative to the scanned root. */
  filePath: string;
  /** Raw module specifiers exactly as written, e.g. `./graph/types.js`. */
  imports: string[];
  symbols: ParsedSymbol[];
  lineCount: number;
  /** Unix milliseconds from the filesystem, so "changed recently" survives a
   * restart and covers edits made before the app was even open. */
  modifiedAt: number;
}

/** Message shapes exchanged with the parser worker threads. */

export interface ParseRequest {
  id: number;
  /** POSIX path relative to the scanned root; becomes the node id. */
  filePath: string;
  absolutePath: string;
  /** Pre-read contents, or null to let the worker read the file itself. */
  source: string | null;
}

export type ParseResponse =
  | { id: number; ok: true; parsed: ParsedFile }
  | { id: number; ok: false; error: string };

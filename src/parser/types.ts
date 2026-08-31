/**
 * What one file looks like after parsing. Deliberately free of graph ids and
 * cross-file knowledge: a file can be parsed in isolation, which is what makes
 * incremental re-parsing possible. Resolving these names to other files is the
 * graph layer's job.
 */

export type SymbolKind = 'class' | 'function' | 'interface' | 'type';

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Bare type names, unresolved: `extends Base` yields `['Base']`. */
  extends: string[];
  implements: string[];
  /** Names invoked anywhere inside this symbol, deduplicated and unresolved. */
  calls: string[];
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

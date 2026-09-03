/**
 * What one file looks like after parsing. Deliberately free of graph ids and
 * cross-file knowledge: a file can be parsed in isolation, which is what makes
 * incremental re-parsing possible. Resolving these names to other files is the
 * graph layer's job.
 */

import type { LanguageId } from '../lang/types.js';

export type SymbolKind = 'class' | 'function' | 'interface' | 'type' | 'method' | 'field';

/**
 * What Go puts between an import path and the name it qualifies in a call:
 * `github.com/spf13/viper#New`, `<importPath>#T.m`. One constant rather than a
 * character in two files, because the store tells this form apart from an ES
 * private member — `T.#m`, where the hash is part of the name — by where the
 * hash sits relative to the first dot, and that test is only sound while both
 * sides agree on the character.
 */
export const QUALIFIED_SEPARATOR = '#';

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
  /**
   * Names invoked anywhere inside this symbol, deduplicated and unresolved.
   *
   * A bare `f` is a top-level name. `T.m` is a member of a named classifier,
   * emitted only when the receiver's type was written down — `this` inside
   * class T, a parameter or field declared `: T`, a `new T()` — because the
   * graph resolves a qualified name to the member node and nothing else, and
   * a guessed receiver would put a call on the wrong class. An untyped
   * receiver contributes nothing, not even its bare property name: `xs.map()`
   * is never the top-level `map` the file declares or imports, and the JS
   * family used to say it was.
   *
   * In the JS family a receiver that is an imported binding names itself:
   * `import * as ns` and then `ns.helper()` is `ns.helper`, and the graph
   * resolves the head through the file's `bindings` and the tail in the
   * module it names — never as a bare `helper`, which would land on any file
   * that exports one.
   *
   * Two forms carry a QUALIFIED_SEPARATOR, and they are told apart by which
   * comes first. Go writes `<importPath>#Name` or `<importPath>#T.m`: the head
   * before the `#` is verbatim one of the file's `imports`, and the `#` sits
   * before any `.`. An ES private member is `T.#m`: the `.` comes first, and
   * the `#` is part of the member's name exactly as it is written everywhere
   * else.
   */
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
  /**
   * Whether the file exports this under its own name — `export function f`,
   * `export { f }`, `exports.f =`, `module.exports.f =` — so that the graph's
   * export table for the file admits only what another file can actually
   * reach. A barrel's `export *` carries a private helper through otherwise,
   * and a call in some far file lands on it.
   *
   * Recorded as true or false on every top-level symbol the JS family parses,
   * so a file with nothing exported reads as exactly that and not as a file
   * the parser forgot to mark. Absent when the parser does not record it (Go,
   * Java, C# and Rust today), and the graph then admits every symbol as it
   * always did; absent on a member too, which is reached through its owner and
   * never by name.
   *
   * `export default class Foo` and `export { B as C }` export a symbol under a
   * name that is not its own, and a flag cannot say which, so both stay false
   * here: see `ParsedFile.defaultExport` for the first, and the second is a
   * gap rather than B reaching every `export *` under a name it does not
   * answer to.
   */
  exported?: boolean;
}

export interface ParsedFile {
  /** POSIX path relative to the scanned root. */
  filePath: string;
  /**
   * Which language read the file. Carried on the result rather than re-derived
   * from the extension later, so the graph resolves a Go import with Go's rules
   * because Go parsed it — not because the graph guessed from `.go`.
   */
  language: LanguageId;
  /**
   * Raw module specifiers exactly as written, e.g. `./graph/types.js`. A call
   * qualified with QUALIFIED_SEPARATOR names one of these verbatim as its
   * head — see `ParsedSymbol.calls` — which is how the graph knows which file
   * a Go name lives in without resolving the reference a second time.
   */
  imports: string[];
  /**
   * The names this file bound by importing, and where each came from.
   * `imports` says which files this one mentions; this says which *names* it
   * brought in, so a bare call resolves only to something the file can see.
   * Without it, once a barrel exposes a hundred names, every bare property
   * call in every importer can land on one of them — `rows.map()` drawn as a
   * call to a `map()` factory. Go binds each same-package sibling it names
   * and Java each type it imports or reaches unqualified, one binding per
   * name, because their resolvers already answer with the one file that
   * declares it. Absent when the parser does not record them (C# and Rust
   * today), and the graph then reads every imported file's whole export
   * table, as it always did.
   */
  bindings?: ImportBinding[];
  /**
   * The local name of the symbol this file exports as its default —
   * `export default class Foo` is `Foo`, `export default foo` and
   * `export { foo as default }` are `foo`, `module.exports = foo` and
   * TypeScript's `export = foo` are `foo` too. A binding whose `imported` is
   * `'default'` is answered from this; `exported` cannot carry it, because a
   * default is exported under a name that is not the symbol's own. Absent when
   * the file has none, or when what it exports by default declares no symbol.
   */
  defaultExport?: string;
  symbols: ParsedSymbol[];
  lineCount: number;
  /** Unix milliseconds from the filesystem, so "changed recently" survives a
   * restart and covers edits made before the app was even open. */
  modifiedAt: number;
  /**
   * What the file declares itself to belong to — a Java or C# package, a Go
   * package, a Rust module. Absent for the languages that resolve by path, and
   * the graph is what pairs it with the specifiers that name it.
   */
  moduleName?: string;
  /**
   * What the file hands on from other files: `export * from './x'` and
   * `export { A, B as C } from './x'`. Recorded with the specifier as written,
   * because a name imported from an index file is usually declared somewhere
   * behind it, and the graph follows these to find where. The specifier is in
   * `imports` as well — a re-export is an import edge just as much as an
   * import is; this is the extra half that says which names travel through.
   */
  reexports?: Reexport[];
  /**
   * tree-sitter recovered from a syntax error somewhere in the file. It is
   * error-tolerant, so a malformed file parses and quietly loses the symbols
   * around the damage; without this flag that is indistinguishable from an
   * empty one.
   */
  hasError?: boolean;
}

export interface Reexport {
  /** The module specifier exactly as written. */
  specifier: string;
  /**
   * `'*'` for `export * from`. Otherwise each name as the file exports it and
   * as the source file knows it — `export { B as C }` is `{ exported: 'C',
   * local: 'B' }`. `export * as ns from './x'` is `{ exported: 'ns', local: '*' }`:
   * one exported name standing for the whole module.
   */
  names: '*' | { exported: string; local: string }[];
}

/** One name a file bound by importing; see `ParsedFile.bindings`. */
export interface ImportBinding {
  /** The name as this file knows it: `c` in `import { b as c }`. */
  local: string;
  /** The module specifier exactly as written; it is in `imports` as well. */
  specifier: string;
  /**
   * The name the source module exports it under: `b` in `import { b as c }`.
   * Two values are reserved — `'default'` for `import d from`, and `'*'` for
   * `import * as ns from` and `const x = require()`, one local standing for
   * the whole module.
   */
  imported: string;
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

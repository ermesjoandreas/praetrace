import type { ImportBinding, ParsedSymbol, Reexport } from '../parser/types.js';

/**
 * What a language has to provide to be drawn.
 *
 * The graph model is already language-neutral — file, class, interface, method,
 * field, and extends / implements / calls / contains / associates are UML, not
 * TypeScript — so a language never changes the shape of the graph. It supplies
 * two things and nothing else: how to read symbols out of a syntax tree, and how
 * to turn a reference into a file.
 *
 * The second is the one that matters. A language that parses but cannot resolve
 * gives you what vuejs/core gave us before this existed: boxes with no edges,
 * which does not look broken, it looks like code with no coupling. So a language
 * is not finished when it parses. It is finished when its edges are checked
 * against a real repository.
 */

export type LanguageId = 'typescript' | 'javascript' | 'java' | 'go' | 'csharp' | 'rust';

/** A tree-sitter node. Kept structural so this module needs no grammar import. */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  namedChildren: SyntaxNode[];
  children: SyntaxNode[];
  childForFieldName(name: string): SyntaxNode | null;
  descendantsOfType(type: string | string[]): SyntaxNode[];
}

export interface LanguageParse {
  /** References exactly as written: a specifier, an import path, a `use` path. */
  imports: string[];
  symbols: ParsedSymbol[];
  /**
   * What the file declares itself to belong to, when the language says so — a
   * Java or C# package, a Go package, a Rust module. Languages that resolve by
   * declared name rather than by path match against this; the rest leave it out.
   */
  moduleName?: string;
  /** What the file hands on from other files, name by name; see ParsedFile.reexports. */
  reexports?: Reexport[];
  /**
   * The names this file bound by importing, and the symbol it exports by
   * default; see ParsedFile.bindings and ParsedFile.defaultExport. Both travel
   * through parseSource untouched, and a language that records neither leaves
   * them out so the graph reads its files the old, whole-table way.
   */
  bindings?: ImportBinding[];
  defaultExport?: string;
}

/**
 * Facts about the project that no single file can know, gathered once by the
 * scan. Every language reads the fields it needs and ignores the rest.
 */
export interface ProjectFacts {
  /** tsconfig `paths`, flattened across `extends` and nested configs. */
  tsPaths: ReadonlyMap<string, readonly string[]>;
  /** Package name -> the directory it lives in, for a monorepo. */
  packages: ReadonlyMap<string, string>;
  /** The module path from go.mod, so an absolute Go import can be made local. */
  goModule: string | null;
  /** Crate name -> the directory holding its src, from Cargo.toml. */
  crates: ReadonlyMap<string, string>;
}

export interface ResolveContext {
  /** The file holding the reference. Project-relative POSIX. */
  from: string;
  /** The reference exactly as written. */
  specifier: string;
  /** Every file the scan found. Project-relative POSIX. */
  files: ReadonlySet<string>;
  /** File -> its declared module name, for name-based resolution. */
  modules: ReadonlyMap<string, string>;
  /**
   * File -> the top-level names it declares.
   *
   * For the languages where a reference carries no path at all. A Go package is
   * a directory, so files in one share a namespace and name each other with
   * nothing written down: `WriteStringAndCheck` says which name is wanted and
   * not which file holds it. Only the project as a whole can answer that, and
   * this is the project as a whole, asked once per derivation.
   */
  declarations: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * File -> the references it made, exactly as `LanguageParse.imports` wrote them.
   *
   * Project-wide rather than just the referring file's own list, and for the same
   * reason `declarations` is: what a name in one file means can depend on what a
   * different file wrote. C# is the case that forces it. A bare `LogEvent` binds
   * through the `using` directives, and C# 10's `global using` puts those in a
   * file of their own — Serilog writes 80 of them across four `GlobalUsings.cs`
   * and then carries no usings at all in 102 of its 113 library sources. A
   * resolver handed only the referring file would see nothing to check against
   * and would have to guess.
   *
   * Languages that resolve on the path alone never read it.
   */
  imports: ReadonlyMap<string, readonly string[]>;
  facts: ProjectFacts;
}

export interface LanguageSupport {
  id: LanguageId;
  /** Shown in the interface, so it says "C#" rather than "csharp". */
  label: string;
  /** Extensions it claims, dot included and lower-case. */
  extensions: readonly string[];
  /**
   * The tree-sitter language to parse this file with, loaded on first use.
   *
   * Takes the path because one grammar package can hold several dialects —
   * tree-sitter-typescript exports both `typescript` and `tsx`, and picking
   * between them is the language's business, not the caller's.
   *
   * What to hand back differs by package, which is why this is per language and
   * not one shared loader. The newer grammars export `{ language, nodeTypeInfo }`
   * and want the *module*: passing the bare `.language` crashes inside `parse`
   * with an undefined node-type index rather than at the call that was wrong.
   */
  grammar(filePath: string): unknown;
  extract(root: SyntaxNode, source: string): LanguageParse;
  /** One reference to one file, or null when it names nothing in the project. */
  resolve(context: ResolveContext): string | null;
}

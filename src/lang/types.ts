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

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'go'
  | 'csharp'
  | 'rust'
  | 'python'
  | 'kotlin'
  | 'php'
  | 'cpp'
  // The view layer. A single-file component holds a script this project already
  // reads well and markup it does not, and Razor is markup with no grammar at
  // all; `angular` names a template a component pointed at, which is why it is
  // the one id here with no entry in the registry — see src/lang/angular.ts.
  | 'vue'
  | 'svelte'
  | 'razor'
  | 'angular';

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
  /** Null at the root. Read to tell a function that is an argument from one that is the symbol. */
  parent: SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  descendantsOfType(type: string | string[]): SyntaxNode[];
}

export interface LanguageParse {
  /** References exactly as written: a specifier, an import path, a `use` path. */
  imports: string[];
  symbols: ParsedSymbol[];
  /**
   * The calls written outside every symbol, which belong to the file itself;
   * see ParsedFile.calls. A language that has no top level worth the name, or
   * that does not collect them yet, leaves this out.
   */
  calls?: string[];
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
 * A file the project starts from, and how that is known.
 *
 * Only ever a file the scan found. A manifest that names build output —
 * codemap's own `bin` is `./dist/cli/index.js` — points at nothing the graph
 * can draw, so it is dropped here and the source it was compiled from turns up
 * under "nothing imports it" instead. `why` is words rather than a code
 * because the front page prints it as written, and says why, not just what.
 */
export interface EntryPoint {
  /** Project-relative POSIX, and a key into the graph's file nodes. */
  file: string;
  /** How this is known: `package.json main`, `Next.js page`, `Go func main()`. */
  why: string;
  /** The script's name for a `package.json script`; absent when `why` says it all. */
  detail?: string;
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
  /**
   * PSR-4: a namespace prefix -> the directories composer says it lives in.
   * PHP's resolver, stated by the project rather than guessed — `"App\\": "app/"`
   * is the whole of how `App\Models\User` becomes `app/Models/User.php`. The
   * prefix carries no trailing separator and a directory no trailing slash, so
   * the resolver joins them itself; `''` is composer's fallback directory.
   *
   * Optional for the same reason `entryPoints` is: a store before its scan, and
   * the fixtures that build facts by hand, have none to give.
   */
  psr4?: ReadonlyMap<string, readonly string[]>;
  /**
   * Where the project starts, by manifest and by convention: package.json
   * `main`, `bin`, `exports` and the scripts that run a file of the project's
   * own; a Go `func main`; Cargo's `[[bin]]`, `src/main.rs` and `src/bin/`;
   * Python's `__main__.py`; every `page.tsx`, `route.ts`, layout and fallback
   * under a Next project's `app/`, and every file under its `pages/`. Sorted
   * by file, one entry per file, the first claim winning.
   *
   * Optional because a store before its scan, and the fixtures that build
   * facts by hand, have none to give: absent means not gathered, and an empty
   * list is a gathered project in which nothing declared a start. Read once at
   * boot like every other fact, so a page added since is not here — it lands
   * under "nothing imports it" until the project is opened again.
   */
  entryPoints?: readonly EntryPoint[];
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
  /**
   * The text the parser should see, when that is not the file.
   *
   * A single-file component keeps its script inside markup, and the script is a
   * language this project already reads well. So the block is handed over with
   * everything around it blanked to spaces and every newline kept: the tree then
   * carries the *file's* own rows, columns and offsets, and no range has to be
   * shifted afterwards. Absent for every language whose file is already its own
   * source, and the caller then parses the file as it is.
   */
  preprocess?(source: string): string;
  /**
   * `source` is always the file as written, even when `preprocess` changed what
   * was parsed: a single-file component reads its template from here.
   *
   * `filePath` is what names a component the source never names — an SFC
   * declares one component and usually writes no symbol for it. Optional
   * because a test that hands a tree straight to a language has no file, and
   * every language that reads nothing from the path ignores it.
   */
  extract(root: SyntaxNode, source: string, filePath?: string): LanguageParse;
  /** One reference to one file, or null when it names nothing in the project. */
  resolve(context: ResolveContext): string | null;
}

/**
 * A language read as text rather than as a tree, because no grammar worth
 * trusting exists for it.
 *
 * Razor is the one, and the measurement is in `razor.ts`: the only tree-sitter
 * grammar for it fails 86 of 236 real files, a `<!DOCTYPE html>` line is an
 * error node in every layout, and three of the edge rules need a regex over the
 * source whatever the tree says.
 *
 * A scanner has no syntax errors to report — `ParsedFile.hasError` is the
 * grammar's word, and there is no grammar — so `parseSource` never sets that
 * flag for one, and a scanned file never wears the parse-error badge.
 */
export interface ScannedLanguage {
  id: LanguageId;
  label: string;
  extensions: readonly string[];
  scan(source: string): LanguageParse;
  resolve(context: ResolveContext): string | null;
}

/**
 * Every language the tool can read, however it reads it.
 *
 * `LanguageSupport` keeps its name and its shape: ten languages and their tests
 * are annotated with it, and all ten have a grammar. Anything that only wants a
 * label, an id or a resolver takes this instead, and anything that wants a tree
 * narrows with `'grammar' in language` — which is the whole difference.
 */
export type Language = LanguageSupport | ScannedLanguage;

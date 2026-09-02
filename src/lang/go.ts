import { createRequire } from 'node:module';
import path from 'node:path';

import type { ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * Go writes visibility as capitalisation rather than as a keyword, so this
 * reports what the source says instead of inferring it: an initial upper-case
 * letter exports the name, anything else confines it to the package.
 */
function visibilityOf(name: string): 'public' | 'private' {
  return /^\p{Lu}/u.test(name) ? 'public' : 'private';
}

/**
 * A type expression reduced to the one name an edge can point at, and whether
 * there are many of them. `[]*Command` and `map[string]Tag` both name a single
 * type and both mean more than one of it, which is the cardinality on the edge.
 */
function typeReference(node: SyntaxNode | null): { typeName?: string; many?: boolean } {
  if (!node) return {};
  switch (node.type) {
    case 'type_identifier':
      return { typeName: node.text };
    // `flag.FlagSet` names a type in another package, and the trailing half is
    // the only one a declaration in this project could match.
    case 'qualified_type':
      return typeReference(node.childForFieldName('name'));
    case 'pointer_type':
      return typeReference(node.namedChildren[0] ?? null);
    // `List[Item]` is a List. The element is an argument to it, not the type.
    case 'generic_type':
      return typeReference(node.childForFieldName('type'));
    case 'slice_type':
    case 'array_type':
      return { ...typeReference(node.childForFieldName('element')), many: true };
    case 'map_type':
      return { ...typeReference(node.childForFieldName('value')), many: true };
    case 'channel_type':
      return typeReference(node.childForFieldName('value'));
    default:
      return {};
  }
}

interface ImportSpec {
  /** The path exactly as written, without its quotes. */
  path: string;
  /**
   * `import . "pkg"`, which declares that package's exported names in this
   * file's own scope. Nothing is written at the point of use to tell them from
   * this package's, which is why the file has to remember that it happened.
   */
  dot: boolean;
}

function unquote(node: SyntaxNode | null): string {
  // An import path may be written as an interpreted or a raw string literal,
  // and the two differ only in which character surrounds them.
  const text = node?.text ?? '';
  return text.length < 2 ? '' : text.slice(1, -1);
}

function importsOf(root: SyntaxNode): ImportSpec[] {
  const specs: ImportSpec[] = [];

  for (const declaration of root.namedChildren) {
    if (declaration.type !== 'import_declaration') continue;
    // A single import holds its spec directly, a grouped one wraps them in a
    // list; descending covers both without asking which was written.
    for (const spec of declaration.descendantsOfType('import_spec')) {
      const importPath = unquote(spec.childForFieldName('path'));
      if (importPath === '') continue;

      // The name the package is imported under is not recorded, because nothing
      // is answered by it any more: a qualified reference names a declaration in
      // another package, and every consumer here resolves a bare name against
      // this one. The one alias worth knowing is `.`, which removes the
      // qualifier and so stops being another package's business.
      specs.push({ path: importPath, dot: spec.childForFieldName('name')?.type === 'dot' });
    }
  }

  return specs;
}

/**
 * Go's universe block: the names that mean something without being declared.
 *
 * Every file writes dozens of them, and none of them is ever a sibling's. A
 * package free to declare `func min` of its own loses that one reference, which
 * is the direction this errs in everywhere.
 */
const PREDECLARED = new Set([
  'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error',
  'float32', 'float64', 'int', 'int8', 'int16', 'int32', 'int64', 'rune',
  'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'true', 'false', 'iota', 'nil',
  'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len',
  'make', 'max', 'min', 'new', 'panic', 'print', 'println', 'real', 'recover',
]);

/**
 * Every name the file binds below package scope, over-approximated into one set
 * for the whole file rather than a scope at a time.
 *
 * Deliberately blunt. Deciding what a name means at the point it is written
 * needs the scope chain, and getting that wrong draws an edge the source does
 * not contain — a file with a parameter called `usage` would be reported as
 * calling a sibling's `usage`. Over-approximating loses that file's real
 * reference to it instead, and a gap is the cheaper mistake.
 */
function boundNames(root: SyntaxNode): Set<string> {
  const bound = new Set<string>();

  // `a, b int` and `var x, y string` repeat the name field, so the names are
  // read as children; the type beside them is never a bare `identifier`.
  for (const node of root.descendantsOfType([
    'parameter_declaration',
    'variadic_parameter_declaration',
    'type_parameter_declaration',
    'var_spec',
    'const_spec',
  ])) {
    for (const child of node.namedChildren) {
      if (child.type === 'identifier') bound.add(child.text);
    }
  }

  // `x := f()`, `for _, v := range xs`, `case v := <-ch`, `switch v := x.(type)`.
  // Only the binding side: the other half is an expression that may well name
  // the sibling being looked for.
  for (const node of root.descendantsOfType([
    'short_var_declaration',
    'range_clause',
    'receive_statement',
    'type_switch_statement',
  ])) {
    const left = node.childForFieldName(node.type === 'type_switch_statement' ? 'alias' : 'left');
    for (const child of left?.namedChildren ?? []) {
      if (child.type === 'identifier') bound.add(child.text);
    }
  }

  // A type declared inside a function is not package-level; one declared at the
  // top is this file's own, and a sibling cannot declare it twice.
  for (const node of root.descendantsOfType(['type_spec', 'type_alias'])) {
    const name = node.childForFieldName('name');
    if (name) bound.add(name.text);
  }

  return bound;
}

/**
 * The names this file declares at package level.
 *
 * `boundNames` reads the same specs but cannot tell one written at the top of
 * the file from one written inside a function, so it reports both. That is the
 * right answer for a sibling reference, where the file's own declarations are
 * refused anyway, and the wrong one for a call: the most useful edge a Go file
 * has is often to the type it declares and builds two lines further down.
 *
 * Exempting them is safe for the same reason the rest of the guard exists. A
 * name declared here is answered by this file's own symbols before any sibling
 * is consulted, and Go will not compile a second package-level declaration of
 * it anywhere in the package — so the sibling it could be mistaken for does not
 * exist.
 */
const PACKAGE_LEVEL_DECLARATIONS = new Set([
  'type_declaration',
  'var_declaration',
  'const_declaration',
]);

function packageLevelNames(root: SyntaxNode): Set<string> {
  const declared = new Set<string>();

  for (const child of root.namedChildren) {
    if (child.type === 'function_declaration') {
      const name = child.childForFieldName('name');
      if (name) declared.add(name.text);
      continue;
    }
    // A method declaration is passed over on both counts: its name is not in the
    // graph's name table, because `Execute` is reached through a value and never
    // bare, and what its body declares is not package level.
    if (!PACKAGE_LEVEL_DECLARATIONS.has(child.type)) continue;

    // `type ( A struct{}; B int )` is one declaration of several specs, and
    // `var a, b int` repeats the name, so the names are read as children. A
    // value sits inside an `expression_list`, never bare, so nothing here is.
    const specs = child.descendantsOfType(['type_spec', 'type_alias', 'var_spec', 'const_spec']);
    for (const spec of specs) {
      const name = spec.childForFieldName('name');
      if (name) declared.add(name.text);
      for (const grandchild of spec.namedChildren) {
        if (grandchild.type === 'identifier') declared.add(grandchild.text);
      }
    }
  }

  return declared;
}

/**
 * What deciding whether a bare name is this package's takes, read once per file.
 *
 * Gathered in one place because two collectors have to agree about it.
 * `collectCalls` offers names to the graph as calls and `siblingReferences`
 * offers them as same-package references, and both are answered by the same
 * bare-name lookup — so a name one refuses and the other hands over is not a
 * disagreement, it is the hole the stricter of the two was written to close.
 */
interface FileScope {
  /** See `boundNames`. */
  bound: ReadonlySet<string>;
  /** See `packageLevelNames`. */
  declared: ReadonlySet<string>;
  /**
   * Where the trailing halves of this file's `qualified_type`s start. Addressed
   * by offset because the binding hands back a fresh object for the same node
   * every time it is asked, so two sweeps cannot compare nodes.
   */
  qualified: ReadonlySet<number>;
  /** Whether any import is a dot import; see `ImportSpec.dot`. */
  dotImported: boolean;
}

function fileScope(root: SyntaxNode, imports: readonly ImportSpec[]): FileScope {
  const qualified = new Set<number>();
  for (const node of root.descendantsOfType('qualified_type')) {
    const name = node.childForFieldName('name');
    if (name) qualified.add(name.startIndex);
  }

  return {
    bound: boundNames(root),
    declared: packageLevelNames(root),
    qualified,
    dotImported: imports.some((spec) => spec.dot),
  };
}

/**
 * Whether a bare name might mean something other than a package-level
 * declaration of this package.
 *
 * This is the whole guard, and both collectors ask it. A name that survives it
 * is offered to the graph, which resolves it against this file's symbols and
 * then its package siblings — so a name that reaches there meaning something
 * else does not go unresolved, it lands on a real declaration and draws a
 * confident edge between two things that have nothing to do with each other.
 *
 * Three ways it can mean something else, all refused rather than reasoned
 * about: Go's universe block; anything the file binds below package scope; and,
 * where the file dot-imports, any exported name at all, since exported names
 * are exactly what a dot import puts in scope and nothing at the point of use
 * says which package it came from.
 *
 * A local can still shadow a name this file declares, and that one is let
 * through: the edge it draws lands on this file's own symbol, which is a
 * mis-attribution inside one box rather than a line between two unrelated
 * files, and it is the only way to keep the edge from a function to the type it
 * builds beside it.
 */
function notThisPackage(name: string, scope: FileScope): boolean {
  if (scope.declared.has(name)) return false;
  if (PREDECLARED.has(name) || scope.bound.has(name)) return true;
  return scope.dotImported && visibilityOf(name) === 'public';
}

/**
 * Every name invoked or constructed inside a declaration that this package
 * could be the one declaring.
 *
 * Go declares nothing inside anything else — a method sits beside its type
 * rather than in it — so unlike TypeScript there is no enclosing symbol that
 * has to be stopped from claiming its members' calls.
 *
 * What is left out matters more than what is kept, because these names arrive
 * at the graph bare and are resolved by name alone.
 *
 * **A qualified call is left out altogether**, and that is the decision most
 * likely to be second-guessed. `exec.Command("go", "build")` shells out to a
 * compiler; the only part of it a bare lookup can match is `Command`, and cobra
 * declares a `Command` of its own, so the edge drawn was from a test that runs
 * `go build` to the type at the centre of the library. Not a near miss — a
 * sentence the source never contained.
 *
 * The price is real and was measured: on cobra this removes two false edges and
 * nine true cross-package ones, `doc.GenManTree` and `cobra.WriteStringAndCheck`
 * among them. Nothing here can tell those from the false ones, because which package
 * `doc` names is a question about the project and this only sees one file — and
 * the name it would have to hand over reaches the graph with the qualifier
 * already gone. Restoring them means carrying the qualifier through to
 * resolution, which is a change to the language contract, not to this file.
 */
function collectCalls(declaration: SyntaxNode, scope: FileScope): string[] {
  const names = new Set<string>();

  for (const node of declaration.descendantsOfType(['call_expression', 'composite_literal'])) {
    if (node.type === 'composite_literal') {
      // `&Command{...}` is Go's `new Command()`, and the only place a type is
      // named while being built. `&pflag.FlagSet{}` builds pflag's type, and
      // reducing it to `FlagSet` is the same lie a qualified call tells.
      const type = node.childForFieldName('type');
      if (!type) continue;
      const built = typeReference(type).typeName;
      const qualified = type
        .descendantsOfType('type_identifier')
        .some((name) => scope.qualified.has(name.startIndex));
      if (built !== undefined && !qualified && !notThisPackage(built, scope)) names.add(built);
      continue;
    }

    // A bare callee is a function this package declares — unless it is a local
    // holding one, or a parameter, which is what the guard is for. Everything
    // else is a selector: `c.Execute()` is a method on a value and
    // `exec.Command()` is another package's function, and neither is a name a
    // file in this project can be asked for.
    const callee = node.childForFieldName('function');
    if (callee?.type !== 'identifier') continue;
    if (!notThisPackage(callee.text, scope)) names.add(callee.text);
  }

  return [...names];
}

/**
 * Names this file uses that a sibling in the same package might declare.
 *
 * A Go package is a directory, and files in one reference each other with no
 * import at all — so the file says which name it wants and nothing about where
 * it lives. Emitting the bare name as a reference is what lets `resolve` answer
 * that from the project's declarations. Without it cobra opens as 36 boxes with
 * 24 of them connected to nothing, which reads as code with no coupling rather
 * than as a gap.
 *
 * What is refused is `notThisPackage`, plus the file's own declarations — a
 * name this file holds is not a reference to a sibling — plus the trailing half
 * of a `qualified_type`, which belongs to the package that qualifies it:
 * `pflag.FlagSet` is not this package's `FlagSet`.
 */
function siblingReferences(
  root: SyntaxNode,
  declaredHere: ReadonlySet<string>,
  scope: FileScope,
): string[] {
  const names = new Set<string>();
  const consider = (name: string): void => {
    if (notThisPackage(name, scope) || declaredHere.has(name)) return;
    names.add(name);
  };

  // A `type_identifier` is the grammar's own answer to "this is a type being
  // named", which covers a field's type, a parameter, a return, an embedded
  // type, a composite literal and a method's receiver in one pass.
  for (const node of root.descendantsOfType('type_identifier')) {
    if (!scope.qualified.has(node.startIndex)) consider(node.text);
  }

  // A bare callee is a function in this package. `c.Execute()` is a method on a
  // value and `doc.GenMarkdownTree()` is another package's, and neither is a
  // name a sibling of this file could be holding.
  for (const node of root.descendantsOfType('call_expression')) {
    const callee = node.childForFieldName('function');
    if (callee?.type === 'identifier') consider(callee.text);
  }

  return [...names];
}

function symbolAt(node: SyntaxNode, name: string, kind: SymbolKind, calls: string[]): ParsedSymbol {
  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    // Go never writes that a type implements an interface — satisfaction is
    // structural — so nothing short of a type checker could fill this in.
    implements: [],
    calls,
    visibility: visibilityOf(name),
  };
}

/** A struct's fields, as symbols owned by it. Returns the types it embeds. */
function collectFields(struct: SyntaxNode, owner: string, out: ParsedSymbol[]): string[] {
  const embedded: string[] = [];
  const list = struct.namedChildren.find((child) => child.type === 'field_declaration_list');
  if (!list) return embedded;

  for (const field of list.namedChildren) {
    if (field.type !== 'field_declaration') continue;
    const declared = typeReference(field.childForFieldName('type'));
    // `A, B int` declares two fields of one type, so the names are read as a
    // list rather than through the single `name` field.
    const names = field.namedChildren.filter((child) => child.type === 'field_identifier');

    if (names.length === 0) {
      // An embedded field has no name of its own. It promotes the embedded
      // type's fields and methods to this one, which is as close to inheritance
      // as Go gets and the only thing an extends edge could mean here.
      if (declared.typeName !== undefined) embedded.push(declared.typeName);
      continue;
    }

    for (const name of names) {
      out.push({ ...symbolAt(field, name.text, 'field', []), owner, ...declared });
    }
  }

  return embedded;
}

/** An interface's methods, as symbols owned by it. Returns the interfaces it embeds. */
function collectInterfaceMembers(
  declaration: SyntaxNode,
  owner: string,
  out: ParsedSymbol[],
): string[] {
  const embedded: string[] = [];

  for (const member of declaration.namedChildren) {
    if (member.type === 'method_elem') {
      const name = member.childForFieldName('name');
      if (name) out.push({ ...symbolAt(member, name.text, 'method', []), owner });
    } else if (member.type === 'type_elem') {
      // `interface { io.Reader }` embeds another interface: every method of it
      // is a method of this one. A generic constraint (`~int | ~string`) is the
      // same node and names no single type, so it reduces to nothing.
      const { typeName } = typeReference(member.namedChildren[0] ?? null);
      if (typeName !== undefined) embedded.push(typeName);
    }
  }

  return embedded;
}

function collectTypeSpec(spec: SyntaxNode, out: ParsedSymbol[]): void {
  const name = spec.childForFieldName('name')?.text;
  if (name === undefined) return;

  const declared = spec.childForFieldName('type');
  const members: ParsedSymbol[] = [];
  let kind: SymbolKind = 'type';
  let embedded: string[] = [];

  if (declared?.type === 'struct_type') {
    // A struct holds fields and gathers methods, which is all a class is. Go
    // just writes the methods outside the braces.
    kind = 'class';
    embedded = collectFields(declared, name, members);
  } else if (declared?.type === 'interface_type') {
    kind = 'interface';
    embedded = collectInterfaceMembers(declared, name, members);
  }

  // The type is pushed before its members, and the graph layer relies on that
  // order to attach each one to the type it just saw.
  out.push({ ...symbolAt(spec, name, kind, []), extends: embedded });
  out.push(...members);
}

/** `func (s *Store) Add()` belongs to Store, wherever in the package it is written. */
function receiverOf(method: SyntaxNode): string | undefined {
  const receiver = method.childForFieldName('receiver');
  const parameter = receiver?.descendantsOfType('parameter_declaration')[0];
  return typeReference(parameter?.childForFieldName('type') ?? null).typeName;
}

/**
 * Top-level declarations only, which in Go is all of them bar what a function
 * body holds.
 *
 * A package-level `var` or `const` is the package's state rather than its
 * structure, and is left out for the same reason TypeScript leaves a `const`
 * out unless it holds a function. The one Go idiom that would hide a function
 * in one, `var f = func() {}`, appears nowhere in the corpus.
 */
function collectTopLevel(node: SyntaxNode, scope: FileScope, out: ParsedSymbol[]): void {
  switch (node.type) {
    case 'type_declaration':
      // `type ( A struct{}; B struct{} )` is one declaration of several specs.
      for (const spec of node.namedChildren) {
        if (spec.type === 'type_spec' || spec.type === 'type_alias') collectTypeSpec(spec, out);
      }
      return;

    case 'function_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name !== undefined) out.push(symbolAt(node, name, 'function', collectCalls(node, scope)));
      return;
    }

    case 'method_declaration': {
      const name = node.childForFieldName('name')?.text;
      if (name === undefined) return;
      const owner = receiverOf(node);
      const method = symbolAt(node, name, 'method', collectCalls(node, scope));
      out.push(owner === undefined ? method : { ...method, owner });
      return;
    }

    default:
      return;
  }
}

/**
 * Directory -> the Go files directly in it, sorted.
 *
 * An import names a directory while the file set is flat, so answering one
 * without this means a scan of every file in the project — per import, on every
 * re-derivation. Rebuilt whenever the set changes identity, which is once per
 * derivation: the store builds one set and hands the same one to every resolve
 * in that pass.
 */
let indexed: { files: ReadonlySet<string>; byDirectory: Map<string, string[]> } | null = null;

function goFilesByDirectory(files: ReadonlySet<string>): ReadonlyMap<string, string[]> {
  if (indexed?.files === files) return indexed.byDirectory;

  const byDirectory = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith('.go')) continue;
    const slash = file.lastIndexOf('/');
    // The project root is the empty string, the way every other path here is.
    const directory = slash < 0 ? '' : file.slice(0, slash);
    const siblings = byDirectory.get(directory);
    if (siblings) siblings.push(file);
    else byDirectory.set(directory, [file]);
  }
  for (const siblings of byDirectory.values()) siblings.sort();

  indexed = { files, byDirectory };
  return byDirectory;
}

/**
 * One file to stand for a whole package.
 *
 * A Go import names a directory, and every file in it is equally the thing
 * being imported — but an edge has one end, so one of them has to hold it.
 * Go's own convention decides: a package keeps its principal declarations in
 * the file named after it, `cobra.go` in package cobra. Failing that the first
 * name alphabetically, which is arbitrary but stable, so the edge does not move
 * between scans.
 *
 * Test files are passed over: an importer of a package cannot see them, and an
 * external `package foo_test` is not even part of it.
 *
 * This only answers what an import names. A package's other files are reached
 * by `siblingReferences` instead, which is a different question with a different
 * answer: not "who stands for this package" but "who declares this name".
 */
function representativeOf(directory: string, packageName: string, files: ReadonlySet<string>): string | null {
  const candidates = goFilesByDirectory(files).get(directory);
  if (!candidates) return null;

  const importable = candidates.filter((file) => !file.endsWith('_test.go'));
  const listed = importable.length > 0 ? importable : candidates;
  const principal = path.posix.join(directory, `${packageName}.go`);
  return listed.find((file) => file === principal) ?? listed[0] ?? null;
}

/**
 * How a same-package reference is written down so it can survive the trip from
 * the parser to the resolver as one more entry in `imports`.
 *
 * A Go import path may not contain a colon — the language spec excludes it —
 * so nothing a project actually writes can be mistaken for one of these.
 */
const SAME_PACKAGE = 'package:';

/**
 * The one sibling that declares a name, or nothing.
 *
 * Same directory and same package clause, because those two together are what
 * Go means by a package: a `foo_test.go` declaring `package foo_test` sits in
 * the directory without being part of it, and reaches the package through a
 * real import like anyone else.
 *
 * An ambiguous answer is refused. Build tags make it a real case rather than a
 * theoretical one — cobra declares `preExecHookFn` in both `command_win.go` and
 * `command_notwin.go`, and only the toolchain knows which one is compiled in.
 * Refusing costs an edge; picking one draws an edge that is wrong on half the
 * platforms the project builds for.
 */
function siblingDeclaring(context: ResolveContext, name: string): string | null {
  const { from, files, modules, declarations } = context;
  const packageName = modules.get(from);
  if (packageName === undefined) return null;

  const slash = from.lastIndexOf('/');
  const directory = slash < 0 ? '' : from.slice(0, slash);

  let found: string | null = null;
  for (const sibling of goFilesByDirectory(files).get(directory) ?? []) {
    if (sibling === from || modules.get(sibling) !== packageName) continue;
    if (declarations.get(sibling)?.has(name) !== true) continue;
    if (found !== null) return null;
    found = sibling;
  }
  return found;
}

export const go: LanguageSupport = {
  id: 'go',
  label: 'Go',
  extensions: ['.go'],

  grammar(_filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    loaded ??= require('tree-sitter-go');
    return loaded;
  },

  extract(root: SyntaxNode, _source: string): LanguageParse {
    const imports = importsOf(root);
    const scope = fileScope(root, imports);

    const symbols: ParsedSymbol[] = [];
    for (const child of root.namedChildren) collectTopLevel(child, scope, symbols);

    const clause = root.namedChildren.find((child) => child.type === 'package_clause');
    const moduleName = clause?.namedChildren[0]?.text;

    // A name this file declares itself is not a reference to a sibling, and the
    // methods are left out for the same reason the graph leaves them out of its
    // name table: `Execute` is reached through a value, never bare.
    const declaredHere = new Set(
      symbols.filter((symbol) => symbol.owner === undefined).map((symbol) => symbol.name),
    );

    return {
      imports: [
        ...imports.map((spec) => spec.path),
        ...siblingReferences(root, declaredHere, scope).map((name) => SAME_PACKAGE + name),
      ],
      symbols,
      ...(moduleName === undefined ? {} : { moduleName }),
    };
  },

  /**
   * A Go import is an absolute path, and only go.mod says which prefix is this
   * project. Strip it and what remains is a directory in the scan.
   *
   * Everything else — `fmt`, `github.com/spf13/pflag` — is the standard library
   * or a dependency, and resolves to nothing because there is nothing here for
   * it to resolve to. That is the answer, not a gap.
   *
   * A same-package reference is answered first, and without go.mod: it never
   * leaves the directory, so which module the directory belongs to — or whether
   * it belongs to one at all — does not come into it.
   */
  resolve(context: ResolveContext): string | null {
    const { specifier, files, facts } = context;
    if (specifier.startsWith(SAME_PACKAGE)) {
      return siblingDeclaring(context, specifier.slice(SAME_PACKAGE.length));
    }

    const module = facts.goModule;
    if (module === null) return null;

    const directory =
      specifier === module
        ? ''
        : specifier.startsWith(`${module}/`)
          ? specifier.slice(module.length + 1)
          : null;
    if (directory === null) return null;

    // A package is conventionally named after the last segment of its path;
    // for the module root that segment lives in the module path itself.
    return representativeOf(directory, specifier.slice(specifier.lastIndexOf('/') + 1), files);
  },
};

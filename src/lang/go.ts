import { createRequire } from 'node:module';
import path from 'node:path';

import { QUALIFIED_SEPARATOR } from '../parser/types.js';
import type { ImportBinding, ParsedSymbol, SymbolKind } from '../parser/types.js';
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
  /**
   * The identifier the package is used under in this file — the alias when one
   * is written, otherwise what the path conventionally implies — or null for a
   * blank or dot import, which no qualifier can name.
   */
  name: string | null;
}

/**
 * The identifier an unaliased import is used under.
 *
 * Go says it is the imported package's own clause, which this file cannot see,
 * so the convention stands in: the last element of the path, read the way the
 * packages that depart from it name themselves — `pflag/v2` is still pflag,
 * gopkg.in's `yaml.v3` is yaml, `go-isatty` is isatty. A guess that misses
 * costs precision and nothing else: a qualifier that matches no import is not
 * read as one, and the import keeps standing for its package's representative
 * file as it did before.
 */
function conventionalName(importPath: string): string {
  const segments = importPath.split('/');
  let last = segments.pop() ?? '';
  if (/^v\d+$/.test(last) && segments.length > 0) last = segments.pop() ?? last;
  last = last.replace(/\.v\d+$/, '');
  return last.startsWith('go-') ? last.slice(3) : last;
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

      // The name decides which qualified references are this import's. `_`
      // imports for effect only and `.` removes the qualifier altogether, so
      // neither can be named at a point of use.
      const alias = spec.childForFieldName('name');
      const name =
        alias === null ? conventionalName(importPath)
        : alias.type === 'package_identifier' ? alias.text
        : null;
      specs.push({ path: importPath, dot: alias?.type === 'dot', name });
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
  /**
   * Qualifier -> the import path it stands for.
   *
   * A name the file also binds is left out: a receiver named `doc` shadows the
   * package inside its method, and nothing here tracks which scope a use is
   * in, so the file refuses the qualifier rather than guess. Two imports that
   * would answer to one name are refused together, for the same reason.
   */
  packages: ReadonlyMap<string, string>;
  /**
   * Package-level variable -> the type its declaration wrote; see
   * `packageVariables`. Read once per file, as everything else here is, and
   * every function's receiver table starts from it.
   */
  variables: ReadonlyMap<string, Written | null>;
}

function fileScope(root: SyntaxNode, imports: readonly ImportSpec[]): FileScope {
  const qualified = new Set<number>();
  for (const node of root.descendantsOfType('qualified_type')) {
    const name = node.childForFieldName('name');
    if (name) qualified.add(name.startIndex);
  }

  const bound = boundNames(root);
  const declared = packageLevelNames(root);

  const packages = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const spec of imports) {
    if (spec.name === null || bound.has(spec.name) || declared.has(spec.name)) continue;
    if (packages.has(spec.name)) ambiguous.add(spec.name);
    else packages.set(spec.name, spec.path);
  }
  for (const name of ambiguous) packages.delete(name);

  return {
    bound,
    declared,
    qualified,
    dotImported: imports.some((spec) => spec.dot),
    packages,
    variables: packageVariables(root),
  };
}

/**
 * Import path -> the names this file reaches through it: the `Command` of
 * `cobra.Command`, the `GenManTree` of `doc.GenManTree(...)`.
 *
 * This is what an import alone could not say. An import names a directory,
 * and the file that stands for it is a convention — so every file in package
 * doc was drawn as depending on cobra.go, when what they all reach for is
 * `Command`, declared in command.go. The names are what let `resolve` land
 * each reference on the file that declares it. Type and expression positions
 * are read separately because the grammar keeps them apart: `cobra.Command` in
 * a signature is a `qualified_type`, in `cobra.CompError(...)` a selector.
 *
 * A reference is written down as `github.com/spf13/cobra#Command` so it can
 * survive the trip to the resolver as one more entry in `imports`, with
 * QUALIFIED_SEPARATOR between — the same character the graph puts between a
 * file and a symbol, and for the same reason: a file's name followed by
 * something in it. The Go spec keeps `#` out of import paths, as it keeps the
 * colon `SAME_PACKAGE` uses, so neither can be mistaken for a path a project
 * wrote.
 */
function qualifiedReferences(root: SyntaxNode, scope: FileScope): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  const note = (qualifier: SyntaxNode | null, name: SyntaxNode | null): void => {
    const importPath = qualifier === null ? undefined : scope.packages.get(qualifier.text);
    if (importPath === undefined || name === null) return;
    const names = byPath.get(importPath) ?? new Set<string>();
    names.add(name.text);
    byPath.set(importPath, names);
  };

  for (const type of root.descendantsOfType('qualified_type')) {
    note(type.childForFieldName('package'), type.childForFieldName('name'));
  }
  for (const selector of root.descendantsOfType('selector_expression')) {
    const operand = selector.childForFieldName('operand');
    if (operand?.type === 'identifier') note(operand, selector.childForFieldName('field'));
  }

  return byPath;
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
 * A type as an edge from this file may name it: bare for one this package
 * could declare, `<importPath>#Name` for one reached through a qualifier — the
 * form a call already takes, so the graph lands it on the file that declares
 * the name. Reduced to its tail, `struct { base.Server }` was a bare `Server`,
 * and the graph answered it with whichever file in reach declared one. A
 * qualifier this file cannot name — shadowed by a local, or two imports
 * answering to it — leaves the type unnamed rather than bare, for the same
 * reason: a sibling's `Server` is not it.
 */
function namedType(node: SyntaxNode | null, scope: FileScope): { typeName?: string; many?: boolean } {
  const reference = typeReference(node);
  if (node === null || reference.typeName === undefined) return reference;
  // The name may sit under a slice, a map or a pointer, so the node carrying
  // it is found by name rather than by position.
  const qualified = node
    .descendantsOfType('qualified_type')
    .find((candidate) => candidate.childForFieldName('name')?.text === reference.typeName);
  if (qualified === undefined) return reference;
  const importPath = scope.packages.get(qualified.childForFieldName('package')?.text ?? '');
  if (importPath === undefined) return {};
  return { ...reference, typeName: `${importPath}${QUALIFIED_SEPARATOR}${reference.typeName}` };
}

/** A type as a declaration wrote it: the `T` of `T`, `*T`, `List[T]`, `pkg.T`. */
interface Written {
  name: string;
  /** The package qualifier, when the type was written `pkg.T`. */
  qualifier: string | null;
}

/**
 * The type whose methods a variable declared with this type has. Narrower than
 * `typeReference` on purpose: `[]T` and `map[K]T` name T while holding many of
 * it, and a slice has no method of T's to call.
 */
function receiverType(node: SyntaxNode | null): Written | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
      return { name: node.text, qualifier: null };
    case 'qualified_type': {
      const name = node.childForFieldName('name')?.text;
      const qualifier = node.childForFieldName('package')?.text;
      return name === undefined || qualifier === undefined ? null : { name, qualifier };
    }
    case 'pointer_type':
    case 'parenthesized_type':
      return receiverType(node.namedChildren[0] ?? null);
    case 'generic_type':
      return receiverType(node.childForFieldName('type'));
    default:
      return null;
  }
}

/**
 * The type an expression names while building it — `&T{}`, `T{}`, `new(T)`,
 * `make([]T, 0, 5)` — or null. A call's result type is written at the callee,
 * not here, and is not guessed at.
 *
 * `make` and `new` are the universe's two constructors and both name what they
 * build in their first argument. What `make` builds is a slice, a map or a
 * channel, which `receiverType` refuses — a slice has no method of T's — so
 * admitting it changes no receiver; it is `elementType` that reads it.
 */
function builtType(value: SyntaxNode | null): SyntaxNode | null {
  if (!value) return null;
  if (value.type === 'unary_expression' && value.childForFieldName('operator')?.text === '&') {
    return builtType(value.childForFieldName('operand'));
  }
  if (value.type === 'composite_literal') return value.childForFieldName('type');
  const callee = value.type === 'call_expression' ? value.childForFieldName('function')?.text : undefined;
  if (callee === 'new' || callee === 'make') {
    return value.childForFieldName('arguments')?.namedChildren[0] ?? null;
  }
  return null;
}

/**
 * What one element of a collection type is: the T of `[]T`, `[3]T` and
 * `map[K]T`, or null when the type holds nothing a range would hand over.
 *
 * The mirror of `receiverType`, which stops at a slice on purpose. Both are
 * needed because a range binds a name to an element of what it ranges over,
 * and that is the only place in Go where a variable's type is written down
 * somewhere other than beside its name. `parents := make([]*Command, 0, 5)`
 * and then `for _, p := range parents` is how cobra reaches every persistent
 * hook a command has, and with no element type `p` was untyped, so
 * `PersistentPreRun` — the call the bug report was about — was refused.
 *
 * A channel is left out although it plainly holds a T. It is ranged over one
 * name at a time, where every other collection gives the element to the
 * *second* — and the table this fills keeps element types, not which kind of
 * collection they came from, so a single-name range cannot be told from an
 * index over a slice. Reading a channel's element would mean guessing.
 */
function elementType(node: SyntaxNode | null): SyntaxNode | null {
  if (!node) return null;
  switch (node.type) {
    case 'slice_type':
    case 'array_type':
      return node.childForFieldName('element');
    // A map is ranged over key first, value second, and it is the value a
    // range's second name is bound to.
    case 'map_type':
      return node.childForFieldName('value');
    case 'pointer_type':
    case 'parenthesized_type':
      return elementType(node.namedChildren[0] ?? null);
    default:
      return null;
  }
}

/**
 * One declaration of a name, recorded into a table of receiver types.
 *
 * A name declared twice is kept only if every declaration agrees, and one
 * declaration without a type — `c := f()`, a range over something nothing
 * declared — refuses the name outright, since nothing here knows which block a
 * later `c.X()` is in. Agreement is why the two readings added for cobra's
 * `execute` had to land together: `p` is written there both as an alias of the
 * receiver and as an element of a slice, so either one alone would have been
 * demoted by the other.
 */
function bindType(typed: Map<string, Written | null>, name: string, written: Written | null): void {
  if (name === '_') return;
  if (!typed.has(name)) {
    typed.set(name, written);
    return;
  }
  const known = typed.get(name);
  const agrees =
    known !== null && known !== undefined && written !== null &&
    known.name === written.name && known.qualifier === written.qualifier;
  if (!agrees) typed.set(name, null);
}

/**
 * What a parameter or a `var` spec declares, name by name, with the *node* of
 * the type each was given. `a, b *Command` repeats the name, so the names are
 * read as children; `var c = &Command{}` is typed by what it builds, one value
 * per name.
 *
 * The node rather than a `Written` because two tables are read off the same
 * declaration and they project it differently: what a name is, and what one
 * element of it is. `cmds []*Command` says nothing about `cmds` — a slice has
 * no method of Command's — and everything about what ranging over it yields.
 */
function declaredTypes(spec: SyntaxNode): [string, SyntaxNode | null][] {
  const names = spec.namedChildren.filter((child) => child.type === 'identifier');
  const type = spec.childForFieldName('type');
  if (type) return names.map((name) => [name.text, type]);
  const values = spec.childForFieldName('value')?.namedChildren ?? [];
  return names.map((name, index) => [
    name.text,
    values.length === names.length ? builtType(values[index] ?? null) : null,
  ]);
}

/**
 * Package-level variable -> the type its declaration wrote, over the file.
 *
 * `var rootCmd = &cobra.Command{…}` at the top of the file and
 * `rootCmd.Execute()` in `main` is how every cobra program begins, and a table
 * read from the function alone never sees the declaration — so the one call
 * the program exists to make was refused. Every function's table starts from
 * this one, and a local of the same name is a second declaration of it, held
 * to `bindType`'s rule like any other: a variable declared `Store` at package
 * level and `Cache` in a function is refused in that function, since nothing
 * here knows which block a call is in.
 */
function packageVariables(root: SyntaxNode): Map<string, Written | null> {
  const typed = new Map<string, Written | null>();
  for (const declaration of root.namedChildren) {
    if (declaration.type !== 'var_declaration') continue;
    // `var ( a *Command; b = &Command{} )` is one declaration of several specs.
    for (const spec of declaration.descendantsOfType('var_spec')) {
      for (const [name, node] of declaredTypes(spec)) bindType(typed, name, receiverType(node));
    }
  }
  return typed;
}

/**
 * Variable -> the type its declaration wrote, over one function.
 *
 * `c.Execute()` is a call to Command.Execute exactly when `c` was declared a
 * Command — as the method's receiver, a parameter, a `var` in the body or at
 * package level, or by building one — and the edge is drawn only when that was
 * written down. A receiver the source does not type is left out, not inferred:
 * a missing edge is a gap, a wrong one is a lie.
 *
 * One table for the whole body, as `boundNames` is one set for the file,
 * starting from the package's variables and held to `bindType`'s rule.
 *
 * A second table travels beside it, holding what one element of a name is
 * rather than what the name is, and it exists for exactly one statement: a
 * range binds its value variable to an element of what it ranges over, which
 * is the only place in Go a variable's type is written somewhere other than
 * beside its name. It is local because nothing outside asks — a collection is
 * never a receiver — and the sweeps are ordered so that everything it can
 * answer from is in it before the ranges are read.
 */
function receiverTypes(declaration: SyntaxNode, scope: FileScope): Map<string, Written | null> {
  const typed = new Map(scope.variables);
  const holds = new Map<string, Written | null>();

  // Declared with a type: the receiver, parameters, results, `var c *Command`.
  // `cmds ...*Command` is a slice of them, so it names no receiver and every
  // element it holds — cobra's `AddCommand(cmds ...*Command)`.
  for (const node of declaration.descendantsOfType([
    'parameter_declaration',
    'variadic_parameter_declaration',
    'var_spec',
  ])) {
    const variadic = node.type === 'variadic_parameter_declaration';
    const declared: [string, SyntaxNode | null][] = variadic
      ? [[node.childForFieldName('name')?.text ?? '_', node.childForFieldName('type')]]
      : declaredTypes(node);
    for (const [name, type] of declared) {
      bindType(typed, name, variadic ? null : receiverType(type));
      bindType(holds, name, receiverType(variadic ? type : elementType(type)));
    }
  }
  for (const node of declaration.descendantsOfType('short_var_declaration')) {
    const names = node.childForFieldName('left')?.namedChildren ?? [];
    const values = node.childForFieldName('right')?.namedChildren ?? [];
    names.forEach((name, index) => {
      if (name.type !== 'identifier') return;
      const value = values.length === names.length ? values[index] ?? null : null;
      // `p := c` is an alias, not a construction: it gives `p` whatever `c`
      // was declared, which the table already holds. Reading it from the table
      // is why `p := c` beside `for _, p := range parents` agrees rather than
      // refusing the name — cobra writes both, for the same `*Command`.
      const alias = value?.type === 'identifier';
      bindType(typed, name.text, alias ? typed.get(value.text) ?? null : receiverType(builtType(value)));
      bindType(holds, name.text, alias ? holds.get(value.text) ?? null : receiverType(elementType(builtType(value))));
    });
  }
  // Bound with no type written: `case v := <-ch`, `switch v := x.(type)`.
  for (const node of declaration.descendantsOfType(['receive_statement', 'type_switch_statement'])) {
    const holder = node.childForFieldName(node.type === 'type_switch_statement' ? 'alias' : 'left');
    for (const child of holder?.namedChildren ?? []) {
      if (child.type === 'identifier') bindType(typed, child.text, null);
    }
  }
  // `for i, c := range cmds`: the second name is an element of what is ranged
  // over, the first an index or a key and never one. Ranging over anything but
  // a name whose elements were written down — a call's result, a field — types
  // neither, exactly as before.
  for (const node of declaration.descendantsOfType('range_clause')) {
    const names = node.childForFieldName('left')?.namedChildren ?? [];
    const over = node.childForFieldName('right');
    const element = over?.type === 'identifier' ? holds.get(over.text) ?? null : null;
    names.forEach((name, index) => {
      if (name.type !== 'identifier') return;
      bindType(typed, name.text, names.length === 2 && index === 1 ? element : null);
    });
  }

  return typed;
}

/**
 * Every name invoked or constructed inside a declaration, in the three forms
 * the graph resolves: a bare name this package could declare, `T.m` for a
 * method on a receiver whose type was written down, and `path#Name` for a
 * reference through an import.
 *
 * Go declares nothing inside anything else — a method sits beside its type
 * rather than in it — so unlike TypeScript there is no enclosing symbol that
 * has to be stopped from claiming its members' calls.
 *
 * What is left out matters more than what is kept, because a bare name is
 * resolved by name alone. That is why a reference through an import is never
 * reduced to its tail. `exec.Command("go", "build")` shells out to a
 * compiler; the only part of it a bare lookup can match is `Command`, which
 * cobra declares, so the edge drawn was from a test that runs `go build` to
 * the type at the centre of the library. Not a near miss — a sentence the
 * source never contained. The reference keeps its import instead,
 * `os/exec#Command`, and the graph either follows that to the file it names
 * or draws nothing. A receiver of an imported type is the same case:
 * `cmd.Execute()` on a `*cobra.Command` is `github.com/spf13/cobra#Command.Execute`.
 */
function collectCalls(declaration: SyntaxNode, scope: FileScope): string[] {
  const names = new Set<string>();
  const typed = receiverTypes(declaration, scope);

  /** A type as this file may name it, or null when this file cannot name it at all. */
  const nameOf = (written: Written | null): string | null => {
    if (written === null) return null;
    if (written.qualifier === null) return notThisPackage(written.name, scope) ? null : written.name;
    const importPath = scope.packages.get(written.qualifier);
    return importPath === undefined ? null : `${importPath}${QUALIFIED_SEPARATOR}${written.name}`;
  };

  // `&Command{...}` is Go's `new Command()`, and `new(Command)` its other
  // spelling: the places a type is named while being built.
  const built = (type: SyntaxNode | null): void => {
    const reference = typeReference(type).typeName;
    if (type === null || reference === undefined) return;
    // The name may sit under a slice, a map or a pointer, so the node carrying
    // it is found by name rather than by position.
    const qualified = type
      .descendantsOfType('qualified_type')
      .find((node) => node.childForFieldName('name')?.text === reference);
    const name = nameOf(qualified ? receiverType(qualified) : { name: reference, qualifier: null });
    if (name !== null) names.add(name);
  };

  for (const node of declaration.descendantsOfType(['call_expression', 'composite_literal'])) {
    if (node.type === 'composite_literal') {
      built(node.childForFieldName('type'));
      continue;
    }

    const callee = node.childForFieldName('function');
    if (callee?.type === 'identifier') {
      // A bare callee is a function this package declares — unless it is a
      // local holding one, or a parameter, which is what the guard is for.
      // `new` is the universe's, and what it names is the type it builds.
      if (callee.text === 'new') built(node.childForFieldName('arguments')?.namedChildren[0] ?? null);
      else if (!notThisPackage(callee.text, scope)) names.add(callee.text);
      continue;
    }

    // `x.m()`: a function in another package when `x` names an import, a method
    // when `x` was declared with a type, and nothing otherwise.
    if (callee?.type !== 'selector_expression') continue;
    const operand = callee.childForFieldName('operand');
    const member = callee.childForFieldName('field')?.text;
    if (operand?.type !== 'identifier' || member === undefined) continue;

    const importPath = scope.packages.get(operand.text);
    if (importPath !== undefined) {
      names.add(`${importPath}${QUALIFIED_SEPARATOR}${member}`);
      continue;
    }
    const owner = nameOf(typed.get(operand.text) ?? null);
    if (owner !== null) names.add(`${owner}.${member}`);
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
function collectFields(struct: SyntaxNode, owner: string, scope: FileScope, out: ParsedSymbol[]): string[] {
  const embedded: string[] = [];
  const list = struct.namedChildren.find((child) => child.type === 'field_declaration_list');
  if (!list) return embedded;

  for (const field of list.namedChildren) {
    if (field.type !== 'field_declaration') continue;
    const declared = namedType(field.childForFieldName('type'), scope);
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
  scope: FileScope,
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
      const { typeName } = namedType(member.namedChildren[0] ?? null, scope);
      if (typeName !== undefined) embedded.push(typeName);
    }
  }

  return embedded;
}

function collectTypeSpec(spec: SyntaxNode, scope: FileScope, out: ParsedSymbol[]): void {
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
    embedded = collectFields(declared, name, scope, members);
  } else if (declared?.type === 'interface_type') {
    kind = 'interface';
    embedded = collectInterfaceMembers(declared, name, scope, members);
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
        if (spec.type === 'type_spec' || spec.type === 'type_alias') collectTypeSpec(spec, scope, out);
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
 * This only answers what a plain import names. A reference that names what it
 * wants from the package — `cobra.Command`, or a sibling's bare `Command` — is
 * a different question with a different answer: not "who stands for this
 * package" but "who declares this name", which is `declaringIn` and
 * `siblingDeclaring` below.
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
 * The one importable file in a directory that declares a name, or null.
 *
 * Test files are passed over as `representativeOf` passes them over: an
 * importer cannot see them. The package clause is not consulted, because Go
 * allows a directory one package plus its `_test` twin and nothing else, and
 * the twin is already gone. Two files declaring the name is the build-tag case
 * `siblingDeclaring` describes, and it is refused here too; the caller falls
 * back to the representative, which says "this package" and not which file.
 */
function declaringIn(directory: string, name: string, context: ResolveContext): string | null {
  let found: string | null = null;
  for (const file of goFilesByDirectory(context.files).get(directory) ?? []) {
    if (file.endsWith('_test.go') || context.declarations.get(file)?.has(name) !== true) continue;
    if (found !== null) return null;
    found = file;
  }
  return found;
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

    // An import the file reaches through its qualifier is written down as the
    // names reached, one reference each, so the edge can land on the file that
    // declares them. One used no other way — blank, dot, or a name the file
    // never wrote — stays the path, standing for the package as before.
    const qualified = qualifiedReferences(root, scope);
    const references: string[] = [];
    for (const spec of imports) {
      const names = qualified.get(spec.path);
      if (names === undefined) references.push(spec.path);
      else for (const name of names) references.push(`${spec.path}${QUALIFIED_SEPARATOR}${name}`);
    }

    // A sibling reference is a binding too, under the name itself: the
    // specifier names the one file that declares it, so the graph reads a
    // bare `New` from that sibling and from nowhere else. Before the file
    // said so, the graph read every imported file's whole table in order, and
    // `path#Name` references come first — so a `New` this package declares
    // was drawn on an imported package's `New`, exported or not. A reference
    // through a qualifier binds nothing: it is written as `path#Name`
    // wherever it is used, and the graph follows that to the import directly.
    const siblings = siblingReferences(root, declaredHere, scope);
    const bindings: ImportBinding[] = siblings.map((name) => ({
      local: name,
      specifier: SAME_PACKAGE + name,
      imported: name,
    }));

    return {
      imports: [...references, ...siblings.map((name) => SAME_PACKAGE + name)],
      symbols,
      bindings,
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
   *
   * A qualified reference lands on the file in the directory that declares the
   * name. When none does — a package-level `var` or `const` is not a symbol, so
   * `cobra.ShellCompDirectiveDefault` names nothing in the table — it falls
   * back to the package's representative, which is the answer a plain import
   * gives: this file uses that package, and which file of it is not claimed.
   */
  resolve(context: ResolveContext): string | null {
    const { specifier, files, facts } = context;
    if (specifier.startsWith(SAME_PACKAGE)) {
      return siblingDeclaring(context, specifier.slice(SAME_PACKAGE.length));
    }

    const module = facts.goModule;
    if (module === null) return null;

    const hash = specifier.indexOf(QUALIFIED_SEPARATOR);
    const importPath = hash < 0 ? specifier : specifier.slice(0, hash);
    const directory =
      importPath === module
        ? ''
        : importPath.startsWith(`${module}/`)
          ? importPath.slice(module.length + 1)
          : null;
    if (directory === null) return null;

    if (hash >= 0) {
      const declaring = declaringIn(directory, specifier.slice(hash + 1), context);
      if (declaring !== null) return declaring;
    }

    // A package is conventionally named after the last segment of its path;
    // for the module root that segment lives in the module path itself.
    return representativeOf(directory, importPath.slice(importPath.lastIndexOf('/') + 1), files);
  },
};

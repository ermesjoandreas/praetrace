import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveImport, resolveModulePath } from '../graph/resolve.js';
import type { ImportBinding, ParsedSymbol, Reexport, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let grammars: { typescript: unknown; tsx: unknown } | null = null;

/**
 * Resolve a node that names a type or value down to the name as written,
 * qualifier included: `Base`, `ns.Base`, `a.b.C`. Null for anything that is
 * not a name — a call, `this`, a subscript — rather than a guess at one.
 */
export function nameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
    // `#count` carries its hash everywhere it is written, `this.#count`
    // included, so the hash is part of the name and not a modifier spelt oddly.
    case 'private_property_identifier':
      return node.text;
    case 'generic_type':
      // `Other<T>` — the symbol is in the `name` field.
      return nameOf(node.childForFieldName('name'));
    case 'member_expression':
    case 'nested_identifier':
      // `ns.Base` used to be reduced to its trailing `Base`, which landed on
      // whatever Base the file bound directly: with `import { Base } from
      // './base1'` and `import * as ns from './base2'` side by side, `extends
      // ns.Base` drew base1. The qualifier is what says which, and the graph
      // resolves it through the file's bindings.
      return qualifiedNameOf(node.childForFieldName('object'), node.childForFieldName('property'));
    case 'nested_type_identifier':
      // The same name in a type position: `x: ns.Thing`.
      return qualifiedNameOf(node.childForFieldName('module'), node.childForFieldName('name'));
    default:
      return null;
  }
}

/** `head.tail`, or null when either half is not itself a name. */
function qualifiedNameOf(head: SyntaxNode | null, tail: SyntaxNode | null): string | null {
  const object = nameOf(head);
  const property = nameOf(tail);
  return object === null || property === null ? null : `${object}.${property}`;
}

/** Text of a module specifier node, without its surrounding quotes. */
export function specifierOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  const fragment = node.namedChildren.find((child) => child.type === 'string_fragment');
  return fragment ? fragment.text : null;
}

function collectHeritage(declaration: SyntaxNode): { extends: string[]; implements: string[] } {
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];

  for (const child of declaration.namedChildren) {
    // Classes carry `class_heritage > extends_clause | implements_clause`;
    // interfaces carry `extends_type_clause` directly.
    if (child.type === 'class_heritage') {
      for (const clause of child.namedChildren) {
        const target = clause.type === 'extends_clause' ? extendsNames
          : clause.type === 'implements_clause' ? implementsNames
          : null;
        if (!target) continue;
        for (const ref of clause.namedChildren) {
          const name = nameOf(ref);
          if (name) target.push(name);
        }
      }
    } else if (child.type === 'extends_type_clause') {
      for (const ref of child.namedChildren) {
        const name = nameOf(ref);
        if (name) extendsNames.push(name);
      }
    }
  }

  return { extends: extendsNames, implements: implementsNames };
}

/**
 * What the receivers in one symbol were declared to be, so `x.m()` can be
 * reported as `T.m` when — and only when — the source wrote T down.
 *
 * This is the whole difference between a call edge that is true and one that
 * is a guess. `this` inside a class names the class; a parameter, field or
 * local declared `: T` or initialised `new T()` names T; a name the file
 * imported names itself, because `ns.helper()` is a call on whatever `ns`
 * stands for and the graph is what knows that; and nothing else names
 * anything. A receiver with no written type contributes nothing: see
 * `calleeOf` for why the bare property it used to yield was never true.
 */
export interface Scope {
  /** The class `this` means, or null outside one. */
  owner: string | null;
  /** `this.x` -> the written type of field x. */
  fields: ReadonlyMap<string, string>;
  /**
   * A top-level name -> its written type, or itself when it is an import;
   * null when it has two.
   */
  bindings: ReadonlyMap<string, string | null>;
  /** The names bound inside the symbol, each with the subtree it is visible in. */
  locals: readonly LocalBinding[];
  /**
   * A class's `<T>`, in force throughout its body. A field declared `item:
   * Item` inside `Box<Item>` is typed, but by a name that stands for whatever
   * the caller supplies — and beside `import { Item }` every call through it
   * was drawn on the import.
   */
  typeParameters: ReadonlySet<string>;
}

/**
 * One local, and where it applies. A binding is visible in the subtree that
 * declares it — the function for a parameter, the block for a `let` — and
 * nowhere else. The flat table this replaced had every name in a symbol mean
 * one thing everywhere in it, so `items.forEach((store: Cache) => …)` typed
 * the `store` the enclosing function imported and used two lines later.
 */
export interface LocalBinding {
  name: string;
  /** The written type, or null when none was — or two were. */
  type: string | null;
  start: number;
  end: number;
}

const NO_SCOPE: Scope = {
  owner: null,
  fields: new Map(),
  bindings: new Map(),
  locals: [],
  typeParameters: new Set(),
};

/** The one class a written type names for a call through it, or null. */
function receiverTypeOf(annotation: SyntaxNode | null): string | null {
  const declared =
    annotation?.type === 'type_annotation' ? (annotation.namedChildren[0] ?? null) : annotation;
  if (!declared) return null;
  if (declared.type === 'union_type') {
    // `Logger | null` is a Logger wherever a call through it type-checks; a
    // union of two real types is not either of them.
    const members = declared.namedChildren.filter(
      (member) => !(member.type === 'literal_type' && /^(null|undefined)$/.test(member.text)),
    );
    return members.length === 1 ? receiverTypeOf(members[0] ?? null) : null;
  }
  // `Store[]` is deliberately not Store: `xs.map()` is the array's method.
  const named =
    declared.type === 'type_identifier' ||
    declared.type === 'nested_type_identifier' ||
    declared.type === 'generic_type';
  return named ? nameOf(declared) : null;
}

/** `= new T()`, the only way a type is written when no annotation is. */
function constructedTypeOf(value: SyntaxNode | null): string | null {
  const expression = value?.type === 'await_expression' ? (value.namedChildren[0] ?? null) : value;
  return expression?.type === 'new_expression' ? nameOf(expression.childForFieldName('constructor')) : null;
}

/** A declarator's written type: the annotation, or what it was constructed as. */
function declaredTypeOf(declarator: SyntaxNode): string | null {
  return (
    receiverTypeOf(declarator.childForFieldName('type')) ??
    constructedTypeOf(declarator.childForFieldName('value'))
  );
}

/**
 * Record one binding. A name bound two ways, or bound once with no type
 * written, is recorded as unknown — and stays unknown, because an untyped
 * `store` parameter hides the typed module-level `store` it shadows, and a
 * call through it must not be attributed to the type it hid.
 */
function bind(into: Map<string, string | null>, name: string, type: string | null): void {
  const known = into.get(name);
  into.set(name, known === undefined || known === type ? type : null);
}

/** The names a declaration's `<T, U extends V>` introduces. */
function typeParametersOf(declaration: SyntaxNode): string[] {
  const names: string[] = [];
  for (const parameter of declaration.childForFieldName('type_parameters')?.namedChildren ?? []) {
    const name = parameter.type === 'type_parameter' ? nameOf(parameter.childForFieldName('name')) : null;
    if (name !== null) names.push(name);
  }
  return names;
}

/** Every name a pattern binds, with its type: `x`, `x = 1`, `{ x, y }`, `[x]`, `...x`. */
function patternBindings(pattern: SyntaxNode, type: string | null): [string, string | null][] {
  if (pattern.type === 'identifier') return [[pattern.text, type]];
  if (pattern.type === 'assignment_pattern') {
    const left = pattern.childForFieldName('left');
    return left ? patternBindings(left, type) : [];
  }
  // A destructured name has the property's type, which is not written here.
  return pattern
    .descendantsOfType(['identifier', 'shorthand_property_identifier_pattern'])
    .map((name) => [name.text, null]);
}

/**
 * The names a declarator binds, with their types. `const x = require('x')`
 * and `const { a } = require('x')` bind names standing for what they
 * imported, and those name themselves — the same rule an `import` gets in
 * moduleScope, applied wherever the `require` is written.
 */
function declaratorBindings(declarator: SyntaxNode): [string, string | null][] {
  const name = declarator.childForFieldName('name');
  if (!name) return [];
  if (requireSpecifierOf(declarator.childForFieldName('value')) !== null) {
    return patternBindings(name, null).map(([bound]) => [bound, bound]);
  }
  return patternBindings(name, declaredTypeOf(declarator));
}

/** The nodes that open a function scope; parameters and `var` belong to the nearest. */
const FUNCTION_NODES: string[] = [
  'arrow_function',
  'function_expression',
  'function',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
];

/** A `let` or `const` belongs to the nearest of these instead. */
const BLOCK_NODES: string[] = [...FUNCTION_NODES, 'statement_block'];

/** The innermost of `scopes` that holds position `at`, or null. */
function innermostAt(scopes: readonly SyntaxNode[], at: number): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  for (const scope of scopes) {
    if (at < scope.startIndex || at >= scope.endIndex) continue;
    if (found === null || scope.startIndex > found.startIndex) found = scope;
  }
  return found;
}

/**
 * The bindings written inside one subtree, over an outer scope. A parameter
 * is visible in its function, a `var` in its function, a `let` or `const` in
 * its block, and the reader picks the innermost at the point of use — which
 * is the language's rule, and the only one under which a callback's typed
 * parameter cannot describe a name outside the callback.
 */
export function scopeOf(node: SyntaxNode, outer: Scope): Scope {
  const locals: LocalBinding[] = [];
  const functions = node.descendantsOfType(FUNCTION_NODES);
  const blocks = node.descendantsOfType(BLOCK_NODES);
  // A `<T>` is in force in the function that declares it, the way its
  // parameters are; `node` is among `functions` whenever it is one.
  const generics = functions.flatMap((fn) =>
    typeParametersOf(fn).map((name) => ({ name, start: fn.startIndex, end: fn.endIndex })),
  );
  /** A written type, unless at `at` it names a type parameter and not a class. */
  const written = (type: string | null, at: number): string | null =>
    type !== null &&
    (outer.typeParameters.has(type) ||
      generics.some((generic) => generic.name === type && at >= generic.start && at < generic.end))
      ? null
      : type;
  const record = (visible: SyntaxNode, pattern: SyntaxNode, type: string | null): void => {
    for (const [name, bound] of patternBindings(pattern, type)) {
      locals.push({ name, type: bound, start: visible.startIndex, end: visible.endIndex });
    }
  };

  for (const fn of functions) {
    for (const parameter of fn.childForFieldName('parameters')?.namedChildren ?? []) {
      // TypeScript wraps a parameter and keeps the name in `pattern`;
      // JavaScript's parameter is the pattern itself, and never has a type.
      const pattern = parameter.childForFieldName('pattern') ?? parameter;
      record(fn, pattern, written(receiverTypeOf(parameter.childForFieldName('type')), parameter.startIndex));
    }
    // `x => x.m()` writes its one parameter without the parentheses.
    const single = fn.childForFieldName('parameter');
    if (single) record(fn, single, null);
  }
  for (const declaration of node.descendantsOfType(['lexical_declaration', 'variable_declaration'])) {
    const scopes = declaration.type === 'lexical_declaration' ? blocks : functions;
    const visible = innermostAt(scopes, declaration.startIndex) ?? node;
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      for (const [name, type] of declaratorBindings(declarator)) {
        locals.push({
          name,
          type: written(type, declarator.startIndex),
          start: visible.startIndex,
          end: visible.endIndex,
        });
      }
    }
  }
  // `for (const x of xs)` and `catch (x)` bind a name with no type written and
  // no place to write one, so a call through it says nothing. Left unrecorded,
  // the `store` of the loop was the module's typed `store` outside it, and the
  // call landed on that type.
  for (const loop of node.descendantsOfType('for_in_statement')) {
    const left = loop.childForFieldName('left');
    if (left) record(loop, left, null);
  }
  for (const clause of node.descendantsOfType('catch_clause')) {
    const parameter = clause.childForFieldName('parameter');
    if (parameter) record(clause, parameter, null);
  }

  if (locals.length === 0) return outer;
  return { ...outer, locals: [...outer.locals, ...locals] };
}

/**
 * What a name means at one position: the innermost local visible there, or
 * the module-level binding when none is. Two locals of one name in the same
 * scope that disagree cancel out rather than either being trusted.
 */
function boundTypeOf(name: string, at: number, scope: Scope): string | null {
  let innermost: LocalBinding | null = null;
  let type: string | null = null;
  for (const local of scope.locals) {
    if (local.name !== name || at < local.start || at >= local.end) continue;
    if (innermost === null || local.start > innermost.start) {
      innermost = local;
      type = local.type;
    } else if (local.start === innermost.start && local.type !== type) {
      type = null;
    }
  }
  return innermost === null ? (scope.bindings.get(name) ?? null) : type;
}

/**
 * What the file's top-level `const`s were declared to be, and the names it
 * imported. An import names itself — `ns.helper()` is a call on whatever `ns`
 * stands for — and the graph, which knows what that is, turns `ns.helper`
 * into an edge to the helper or to nothing. The bare `helper` it used to be
 * landed on any file that exported one.
 */
export function moduleScope(root: SyntaxNode, imported: readonly ImportBinding[]): Scope {
  const bindings = new Map<string, string | null>();
  for (const statement of root.namedChildren) {
    const declaration =
      statement.type === 'export_statement' ? statement.childForFieldName('declaration') : statement;
    if (declaration?.type !== 'lexical_declaration' && declaration?.type !== 'variable_declaration') continue;
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      for (const [name, type] of declaratorBindings(declarator)) bind(bindings, name, type);
    }
  }
  for (const { local } of imported) bind(bindings, local, local);
  return { owner: null, fields: new Map(), bindings, locals: [], typeParameters: new Set() };
}

/**
 * The scope inside a class: `this` is the class, and `this.x` is whatever
 * field x was declared as — by annotation, by `= new T()`, by a constructor
 * parameter property, or by `this.x = new T()` in the constructor, which is
 * how a JavaScript class writes a field's type at all.
 *
 * Reads both grammars' field nodes, because the JavaScript extractor shares
 * this rather than keeping a copy that would drift.
 */
export function classScope(declaration: SyntaxNode, owner: string, outer: Scope): Scope {
  const fields = new Map<string, string | null>();
  const body = declaration.childForFieldName('body');
  const typeParameters = new Set([...outer.typeParameters, ...typeParametersOf(declaration)]);
  /** A field's written type, unless it is one of the class's own `<T>`. */
  const written = (annotation: SyntaxNode | null): string | null => {
    const type = receiverTypeOf(annotation);
    return type !== null && typeParameters.has(type) ? null : type;
  };

  for (const member of body?.namedChildren ?? []) {
    if (member.type === 'public_field_definition' || member.type === 'field_definition') {
      const named = member.childForFieldName('name') ?? member.childForFieldName('property');
      const type = written(member.childForFieldName('type')) ?? constructedTypeOf(member.childForFieldName('value'));
      const name = nameOf(named);
      if (name !== null) bind(fields, name, type);
    } else if (member.type === 'method_definition' && nameOf(member.childForFieldName('name')) === 'constructor') {
      const parameters = member.childForFieldName('parameters');
      for (const parameter of parameters?.namedChildren ?? []) {
        // `constructor(private log: Logger)` declares the field and takes it
        // in one line; the modifier is what makes it a field.
        if (!parameter.children.some((child) => child.type === 'accessibility_modifier')) continue;
        const name = nameOf(parameter.childForFieldName('pattern'));
        if (name !== null) bind(fields, name, written(parameter.childForFieldName('type')));
      }
    }
  }
  for (const assignment of body?.descendantsOfType('assignment_expression') ?? []) {
    const left = assignment.childForFieldName('left');
    if (left?.type !== 'member_expression' || left.childForFieldName('object')?.type !== 'this') continue;
    const name = nameOf(left.childForFieldName('property'));
    if (name !== null) bind(fields, name, constructedTypeOf(assignment.childForFieldName('right')));
  }

  const known = new Map<string, string>();
  for (const [name, type] of fields) if (type !== null) known.set(name, type);
  return { owner, fields: known, bindings: outer.bindings, locals: outer.locals, typeParameters };
}

/** Whether `node` lies inside one of `ranges`. */
function within(node: SyntaxNode, ranges: readonly SyntaxNode[]): boolean {
  return ranges.some((range) => node.startIndex >= range.startIndex && node.endIndex <= range.endIndex);
}

/**
 * The classifier a receiver expression is known to be, or null. `rebound`
 * says whether a `this` at that position belongs to a nested function rather
 * than to the class; see collectCalls.
 */
function receiverOf(
  object: SyntaxNode | null,
  scope: Scope,
  rebound: (node: SyntaxNode) => boolean,
): string | null {
  if (!object) return null;
  if (object.type === 'this') return rebound(object) ? null : scope.owner;
  if (object.type === 'identifier') return boundTypeOf(object.text, object.startIndex, scope);
  if (object.type === 'member_expression' && object.childForFieldName('object')?.type === 'this') {
    if (rebound(object)) return null;
    const field = nameOf(object.childForFieldName('property'));
    return field === null ? null : (scope.fields.get(field) ?? null);
  }
  return null;
}

/**
 * The name a call is made on. `f()` is `f`; `x.m()` is `T.m` when x is known
 * to be a T, and nothing when it is not.
 *
 * The bare `m` this used to report for an untyped receiver could only ever
 * resolve by coincidence: a property of something the file never typed is not
 * the top-level name it happens to share. The receivers that really are
 * modules are named by their import binding above, and once the graph reads
 * only what a file bound, what was left of the bare tail was `values.map()`
 * inside the file that declares zod's `map()` factory and `JSON.stringify()`
 * beside express's own `stringify` — five lies across zod, TanStack/query and
 * express, against two edges true by accident. Go and Java refuse an untyped
 * receiver already; this makes the JS family do the same.
 */
function calleeOf(
  callee: SyntaxNode | null,
  scope: Scope,
  rebound: (node: SyntaxNode) => boolean,
): string | null {
  if (callee?.type !== 'member_expression') return nameOf(callee);
  const receiver = receiverOf(callee.childForFieldName('object'), scope, rebound);
  if (receiver === null) return null;
  const property = nameOf(callee.childForFieldName('property'));
  return property === null ? null : `${receiver}.${property}`;
}

/**
 * The nodes that give `this` a meaning of their own. An arrow function is
 * deliberately not one: its `this` is the enclosing one, which is the whole
 * reason the callbacks inside a method are written as arrows.
 */
const THIS_REBINDERS: string[] = [
  'function_expression',
  'function',
  'function_declaration',
  'generator_function',
  'generator_function_declaration',
  'method_definition',
  'class',
  'class_declaration',
  'abstract_class_declaration',
];

/**
 * Every name invoked inside a symbol.
 *
 * `exclude` holds subtrees that are symbols in their own right — a class's
 * methods, a namespace's declarations — so the enclosing symbol does not also
 * claim what they call. Without it every call inside a method would produce two
 * edges from two different nodes, and the weight on the drawn edge would be
 * twice what the code actually does.
 */
export function collectCalls(
  declaration: SyntaxNode,
  exclude: readonly SyntaxNode[] = [],
  scope: Scope = NO_SCOPE,
): string[] {
  const names = new Set<string>();
  // `this` inside a nested `function` is that function's, whatever it is
  // called on: `el.addEventListener('click', function () { this.render() })`
  // is not the class calling render. The declaration itself is never one of
  // these, even when it is a function — its `this` is what `scope` says.
  const rebinders = declaration
    .descendantsOfType(THIS_REBINDERS)
    .filter((fn) => fn.startIndex > declaration.startIndex || fn.endIndex < declaration.endIndex);
  const rebound = (node: SyntaxNode): boolean => within(node, rebinders);

  for (const call of declaration.descendantsOfType('call_expression')) {
    if (within(call, exclude)) continue;
    const name = calleeOf(call.childForFieldName('function'), scope, rebound);
    if (name) names.add(name);
  }
  for (const construction of declaration.descendantsOfType('new_expression')) {
    if (within(construction, exclude)) continue;
    const name = calleeOf(construction.childForFieldName('constructor'), scope, rebound);
    if (name) names.add(name);
  }

  return [...names];
}

/**
 * `export * from './x'`, `export { A, B as C } from './x'` and
 * `export * as ns from './x'` — which names a file hands on, and from where.
 * Null for an export that names no source, which is an ordinary declaration.
 */
export function reexportOf(statement: SyntaxNode): Reexport | null {
  const specifier = specifierOf(statement.childForFieldName('source'));
  if (!specifier) return null;

  const exported = (node: SyntaxNode | null): string | null =>
    node?.type === 'string' ? specifierOf(node) : node?.type === 'default' ? 'default' : nameOf(node);

  for (const child of statement.namedChildren) {
    if (child.type === 'namespace_export') {
      const name = exported(child.namedChildren[0] ?? null);
      return name === null ? null : { specifier, names: [{ exported: name, local: '*' }] };
    }
    if (child.type === 'export_clause') {
      const names: { exported: string; local: string }[] = [];
      for (const specifierNode of child.namedChildren) {
        if (specifierNode.type !== 'export_specifier') continue;
        const local = exported(specifierNode.childForFieldName('name'));
        if (local === null) continue;
        names.push({ exported: exported(specifierNode.childForFieldName('alias')) ?? local, local });
      }
      return { specifier, names };
    }
  }
  return { specifier, names: '*' };
}

/** The module an import statement names, from whichever of two places it is written in. */
function importSpecifierOf(statement: SyntaxNode): string | null {
  const direct = specifierOf(statement.childForFieldName('source'));
  if (direct !== null) return direct;
  // `import ns = require('x')` keeps the source inside its clause.
  const clause = statement.namedChildren.find((child) => child.type === 'import_require_clause');
  return clause ? specifierOf(clause.childForFieldName('source')) : null;
}

/** An imported name as written: an identifier, or the quoted `"string name"` form. */
function importedNameOf(node: SyntaxNode | null): string | null {
  return node?.type === 'string' ? specifierOf(node) : nameOf(node);
}

/**
 * The names one import statement binds, each with the name it had where it
 * came from. `import d, { a, b as c } from 'x'` is three of them; `import * as
 * ns` and `import ns = require('x')` are one standing for the whole module.
 * `import type` binds like any other, because a type is a receiver.
 */
function importBindingsOf(statement: SyntaxNode): ImportBinding[] {
  const specifier = importSpecifierOf(statement);
  if (specifier === null) return [];
  const bindings: ImportBinding[] = [];

  for (const clause of statement.namedChildren) {
    if (clause.type === 'import_require_clause') {
      const name = clause.namedChildren.find((child) => child.type === 'identifier');
      if (name) bindings.push({ local: name.text, specifier, imported: '*' });
    }
    if (clause.type !== 'import_clause') continue;
    for (const part of clause.namedChildren) {
      if (part.type === 'identifier') {
        bindings.push({ local: part.text, specifier, imported: 'default' });
      } else if (part.type === 'namespace_import') {
        const name = part.namedChildren.find((child) => child.type === 'identifier');
        if (name) bindings.push({ local: name.text, specifier, imported: '*' });
      } else if (part.type === 'named_imports') {
        for (const item of part.namedChildren) {
          if (item.type !== 'import_specifier') continue;
          const imported = importedNameOf(item.childForFieldName('name'));
          const local = nameOf(item.childForFieldName('alias')) ?? imported;
          if (imported !== null && local !== null) bindings.push({ local, specifier, imported });
        }
      }
    }
  }
  return bindings;
}

/** Every name the file's import statements bind. */
export function importBindings(root: SyntaxNode): ImportBinding[] {
  return root.namedChildren.flatMap((statement) =>
    statement.type === 'import_statement' ? importBindingsOf(statement) : [],
  );
}

/**
 * The specifier of a `require('x')`, or null for anything else — a computed
 * `require(name)` names a file only at run time, and this graph is what the
 * source says.
 */
export function requireSpecifierOf(node: SyntaxNode | null): string | null {
  if (node?.type !== 'call_expression') return null;
  const callee = node.childForFieldName('function');
  if (callee?.type !== 'identifier' || callee.text !== 'require') return null;
  const argument = node.childForFieldName('arguments')?.namedChildren[0] ?? null;
  return argument?.type === 'string' ? specifierOf(argument) : null;
}

/**
 * `const x = require('x')` and `const { a, b: c } = require('x')`, which is
 * how a CommonJS module binds what it imports. Read across the whole file for
 * the reason its `require` calls are: that is where they are written.
 */
export function requireBindings(root: SyntaxNode): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const declarator of root.descendantsOfType('variable_declarator')) {
    const specifier = requireSpecifierOf(declarator.childForFieldName('value'));
    const name = declarator.childForFieldName('name');
    if (specifier === null || !name) continue;
    if (name.type === 'identifier') {
      bindings.push({ local: name.text, specifier, imported: '*' });
      continue;
    }
    if (name.type !== 'object_pattern') continue;
    for (const entry of name.namedChildren) {
      if (entry.type === 'shorthand_property_identifier_pattern') {
        bindings.push({ local: entry.text, specifier, imported: entry.text });
      } else if (entry.type === 'pair_pattern') {
        const key = entry.childForFieldName('key');
        const value = entry.childForFieldName('value');
        if (key?.type === 'property_identifier' && value?.type === 'identifier') {
          bindings.push({ local: value.text, specifier, imported: key.text });
        }
      }
    }
  }
  return bindings;
}

/** What a file exports: see exportsOf. */
export interface Exports {
  /** The symbols exported under their own names. */
  names: ReadonlySet<string>;
  /** The local name of the one exported as default, or null. */
  defaultExport: string | null;
}

/** The names an `export const a = 1, b = 2` or `export class C` declares. */
function declaredNamesOf(declaration: SyntaxNode): string[] {
  // `export declare function f()` wraps the declaration once more.
  const inner = declaration.type === 'ambient_declaration' ? (declaration.namedChildren[0] ?? null) : declaration;
  if (!inner) return [];
  if (inner.type === 'lexical_declaration' || inner.type === 'variable_declaration') {
    return inner.namedChildren.flatMap((declarator) => {
      const name = declarator.type === 'variable_declarator' ? declarator.childForFieldName('name') : null;
      return name ? patternBindings(name, null).map(([bound]) => bound) : [];
    });
  }
  const name =
    inner.type === 'internal_module' || inner.type === 'module'
      ? moduleNameOf(inner.childForFieldName('name'))
      : nameOf(inner.childForFieldName('name'));
  return name === null ? [] : [name];
}

/**
 * The names a file exports as the symbols' own, and the one it exports as its
 * default. Read off the top-level statements alone, because what a namespace
 * exports it exports from the namespace and what `declare module 'x'` exports
 * belongs to x — neither can be imported from this file by that name, and a
 * flag that said otherwise would carry it through every barrel's `export *`.
 *
 * `export { B as C }` exports B under a name that is not its own, and a flag
 * cannot say which, so B is left out: an import of C is a gap rather than B
 * answering to a name it does not have.
 */
export function exportsOf(root: SyntaxNode): Exports {
  const names = new Set<string>();
  let defaultExport: string | null = null;

  for (const statement of root.namedChildren) {
    if (statement.type === 'expression_statement') {
      // `module.exports = foo` is CommonJS's default export; when what it
      // assigns is a function the symbol is named `module.exports` itself.
      for (const assignment of statement.descendantsOfType('assignment_expression')) {
        if (assignment.childForFieldName('left')?.text.replace(/\s+/g, '') !== 'module.exports') continue;
        const right = assignment.childForFieldName('right');
        if (right?.type === 'identifier') defaultExport = right.text;
        else if (right && FUNCTION_VALUES.has(right.type)) defaultExport = 'module.exports';
      }
      continue;
    }
    if (statement.type !== 'export_statement' || statement.childForFieldName('source')) continue;

    // `export default …`, and TypeScript's `export = …`, which means the same.
    if (statement.children.some((child) => child.type === 'default' || child.type === '=')) {
      const declaration = statement.childForFieldName('declaration');
      const value = statement.childForFieldName('value') ?? statement.namedChildren.find((c) => c.type === 'identifier');
      const name = declaration ? (declaredNamesOf(declaration)[0] ?? null) : nameOf(value ?? null);
      if (name !== null) defaultExport = name;
      continue;
    }

    const declaration = statement.childForFieldName('declaration');
    if (declaration) {
      for (const name of declaredNamesOf(declaration)) names.add(name);
      continue;
    }
    const clause = statement.namedChildren.find((child) => child.type === 'export_clause');
    for (const item of clause?.namedChildren ?? []) {
      if (item.type !== 'export_specifier') continue;
      const local = importedNameOf(item.childForFieldName('name'));
      const alias = importedNameOf(item.childForFieldName('alias'));
      if (local === null) continue;
      if (alias === null) names.add(local);
      else if (alias === 'default') defaultExport = local;
    }
  }
  return { names, defaultExport };
}

/**
 * Stamp `exported` on every top-level symbol. Members are left alone: they
 * are reached through their owner, never by name. `exports.f =` and
 * `module.exports.f =` are exports by construction — the name says so.
 */
export function markExports(symbols: readonly ParsedSymbol[], exports: Exports): ParsedSymbol[] {
  return symbols.map((symbol) =>
    symbol.owner !== undefined
      ? symbol
      : { ...symbol, exported: exports.names.has(symbol.name) || /^(module\.)?exports\./.test(symbol.name) },
  );
}

/**
 * What the JS family reads beyond the contract's minimum. Named so the
 * extractors can say they always return these, where `LanguageParse` can
 * only say a language might.
 */
export interface ModuleParse extends LanguageParse {
  reexports: Reexport[];
  bindings: ImportBinding[];
  defaultExport?: string;
}

/** An expression that is a function, whichever of the grammars' spellings. */
export const FUNCTION_VALUES: ReadonlySet<string> = new Set(['arrow_function', 'function_expression', 'function']);

/**
 * A function defined by assigning it to a property: `app.init = function`,
 * `exports.merge = () =>`, `res.send = function send`, and express's
 * `defineGetter(req, 'protocol', function)`. This is how a CommonJS module
 * defines its API, and before it was read application.js — 632 lines, all of
 * them this — drew two symbols. The name is the property exactly as written,
 * which is the only name the file gives it.
 */
function assignedFunctionOf(statement: SyntaxNode): { name: string; value: SyntaxNode } | null {
  const expression = statement.namedChildren[0] ?? null;
  if (!expression) return null;

  if (expression.type === 'assignment_expression') {
    const left = expression.childForFieldName('left');
    const value = expression.childForFieldName('right');
    if (left?.type !== 'member_expression' || !value || !FUNCTION_VALUES.has(value.type)) return null;
    // `app[method] = function` is a subscript and names nothing static.
    if (left.childForFieldName('property')?.type !== 'property_identifier') return null;
    return { name: left.text.replace(/\s+/g, ''), value };
  }

  if (expression.type === 'call_expression' && nameOf(expression.childForFieldName('function')) === 'defineGetter') {
    const [target, key, value] = expression.childForFieldName('arguments')?.namedChildren ?? [];
    if (target?.type !== 'identifier' || key?.type !== 'string' || !value || !FUNCTION_VALUES.has(value.type)) {
      return null;
    }
    const property = specifierOf(key);
    return property === null ? null : { name: `${target.text}.${property}`, value };
  }

  return null;
}

/**
 * The symbol for a property-assigned function, or null when the statement is
 * not one. Its range is the whole statement, which is where a reader would
 * look for it; its calls are the function's own, because the `defineGetter`
 * that installs a getter is the module's doing at load and not the getter's.
 */
export function assignedSymbolOf(statement: SyntaxNode, scope: Scope): ParsedSymbol | null {
  const assigned = assignedFunctionOf(statement);
  if (!assigned) return null;
  return {
    name: assigned.name,
    kind: 'function',
    startLine: statement.startPosition.row + 1,
    endLine: statement.endPosition.row + 1,
    extends: [],
    implements: [],
    calls: collectCalls(assigned.value, [], scopeOf(assigned.value, scope)),
  };
}

/**
 * UML's three modifiers, read off the declaration rather than inferred. An
 * absent visibility means the source did not say, which in TypeScript is public
 * — recorded as absent so the diagram can tell "written public" from "not
 * written", the way the source can.
 */
function modifiersOf(member: SyntaxNode): Pick<ParsedSymbol, 'visibility' | 'isStatic' | 'isAbstract'> {
  let visibility: ParsedSymbol['visibility'];
  let isStatic = false;
  let isAbstract = false;

  for (const child of member.children) {
    if (child.type === 'accessibility_modifier') {
      const text = child.text;
      if (text === 'private' || text === 'protected' || text === 'public') visibility = text;
    } else if (child.type === 'static') isStatic = true;
    else if (child.type === 'abstract') isAbstract = true;
  }

  return {
    ...(visibility === undefined ? {} : { visibility }),
    ...(isStatic ? { isStatic: true } : {}),
    ...(isAbstract ? { isAbstract: true } : {}),
  };
}

/**
 * The declared type of a field, reduced to the one name an association can be
 * drawn to. `Logger[]` and `Array<Logger>` both name Logger and both mean many
 * of them, which is the cardinality on the edge.
 */
function typeOf(member: SyntaxNode, typeParameters: ReadonlySet<string>): { typeName?: string; many?: boolean } {
  const annotation = member.childForFieldName('type');
  const declared = annotation?.namedChildren[0] ?? null;
  if (!declared) return {};
  // `items: Item[]` inside `Box<Item>` holds whatever the caller supplies, and
  // an association to the Item the file imported is a has-a the class never
  // stated.
  const classifier = (node: SyntaxNode | null): string | null => {
    const name = nameOf(node);
    return name !== null && typeParameters.has(name) ? null : name;
  };

  if (declared.type === 'array_type') {
    const name = classifier(declared.namedChildren[0] ?? null);
    return name === null ? { many: true } : { typeName: name, many: true };
  }
  if (declared.type === 'generic_type') {
    const base = classifier(declared.childForFieldName('name'));
    // Array<T> and the collection types name their element, not themselves.
    if (base === 'Array' || base === 'Set' || base === 'ReadonlyArray') {
      const args = declared.childForFieldName('type_arguments');
      const inner = classifier(args?.namedChildren[0] ?? null);
      return inner === null ? { many: true } : { typeName: inner, many: true };
    }
    return base === null ? {} : { typeName: base };
  }

  const name = classifier(declared);
  return name === null ? {} : { typeName: name };
}

/**
 * A class's members, as symbols of their own.
 *
 * A field holding an arrow function is a method in everything but syntax, so it
 * counts as one. Returns the method bodies, which the class must not claim the
 * calls of.
 */
function collectMembers(
  declaration: SyntaxNode,
  owner: string,
  symbols: ParsedSymbol[],
  scope: Scope,
): SyntaxNode[] {
  const body = declaration.childForFieldName('body');
  if (!body) return [];

  const bodies: SyntaxNode[] = [];
  const fields: ParsedSymbol[] = [];
  const methods: ParsedSymbol[] = [];

  for (const member of body.namedChildren) {
    const named = member.childForFieldName('name');
    const name = nameOf(named);
    if (!name) continue;

    const isMethod =
      member.type === 'method_definition' ||
      member.type === 'method_signature' ||
      member.type === 'abstract_method_signature' ||
      (member.type === 'public_field_definition' &&
        member.childForFieldName('value')?.type === 'arrow_function');
    const isField =
      !isMethod &&
      (member.type === 'public_field_definition' || member.type === 'property_signature');
    if (!isMethod && !isField) continue;

    const common = {
      name,
      owner,
      startLine: member.startPosition.row + 1,
      endLine: member.endPosition.row + 1,
      extends: [],
      implements: [],
      ...modifiersOf(member),
      // `#count` states its visibility in the name, and there is no keyword
      // form of it to have been written instead.
      ...(named?.type === 'private_property_identifier' ? { visibility: 'private' as const } : {}),
    };

    if (isMethod) {
      bodies.push(member);
      methods.push({ ...common, kind: 'method', calls: collectCalls(member, [], scopeOf(member, scope)) });
    } else {
      // A field initialiser can call things, and those calls are the class's
      // doing rather than any method's, so they are collected here too.
      fields.push({
        ...common,
        kind: 'field',
        calls: collectCalls(member, [], scopeOf(member, scope)),
        ...typeOf(member, scope.typeParameters),
      });
    }
  }

  // Attributes before operations, which is the order a UML class box reads in
  // and, not by accident, the order the declarations usually appear in anyway.
  symbols.push(...fields, ...methods);
  return bodies;
}

function makeSymbol(
  declaration: SyntaxNode,
  name: string,
  kind: SymbolKind,
  exclude: readonly SyntaxNode[],
  scope: Scope,
): ParsedSymbol {
  const heritage = collectHeritage(declaration);
  return {
    name,
    kind,
    startLine: declaration.startPosition.row + 1,
    endLine: declaration.endPosition.row + 1,
    extends: heritage.extends,
    implements: heritage.implements,
    calls: collectCalls(declaration, exclude, scope),
  };
}

/**
 * An enum and a namespace are both 'type'.
 *
 * Neither is a class: an enum has no operations and a namespace has no
 * instances, so drawing either as one would put an empty UML class box on the
 * diagram and invite an association that cannot exist. 'type' already means
 * "a named thing the type system knows about", which both are, and it keeps the
 * node kinds language-neutral rather than growing one per TypeScript keyword.
 */
const DECLARATION_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  // `declare function f(): void` — a body-less declaration is still the symbol
  // an ambient file exists to declare.
  ['function_signature', 'function'],
  ['interface_declaration', 'interface'],
  ['type_alias_declaration', 'type'],
  ['enum_declaration', 'type'],
]);

interface Collected {
  imports: string[];
  reexports: Reexport[];
  symbols: ParsedSymbol[];
  /**
   * Subtrees that already became a symbol. An enclosing namespace collects the
   * calls in its body and must not claim what its own declarations call.
   */
  claimed: SyntaxNode[];
  /** Which of the symbols came from a body-less signature; see below. */
  signatures: Set<ParsedSymbol>;
  /** The file's top-level bindings, which every symbol's receivers are read against. */
  scope: Scope;
}

/**
 * An overload signature is not a second function.
 *
 * `function_signature` is two things wearing the same node type: the
 * `declare function` that is the only declaration an ambient file has, and the
 * signatures stacked in front of an implementation. 236 of the 259 in the
 * corpus are the second kind, and keeping them listed `defineComponent` three
 * times in one box. So a signature survives only when nothing else in the file
 * declares that name — which is exactly the ambient case, and the 23 symbols a
 * declaration file would otherwise hold none of.
 */
function withoutOverloads(
  symbols: readonly ParsedSymbol[],
  signatures: ReadonlySet<ParsedSymbol>,
): ParsedSymbol[] {
  if (signatures.size === 0) return [...symbols];

  // Members are excluded: a class method and a declared function can share a
  // name without either being an overload of the other.
  const implemented = new Set(
    symbols
      .filter((symbol) => symbol.owner === undefined && !signatures.has(symbol))
      .map((symbol) => symbol.name),
  );
  const kept = new Set<string>();

  return symbols.filter((symbol) => {
    if (!signatures.has(symbol)) return true;
    if (implemented.has(symbol.name) || kept.has(symbol.name)) return false;
    kept.add(symbol.name);
    return true;
  });
}

/** A namespace's name, or the quoted specifier of `declare module 'vue'`. */
function moduleNameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'string') return specifierOf(node);
  // `module Legacy.Nested` — the dotted name is what the thing is called.
  if (node.type === 'nested_identifier') return node.text;
  return nameOf(node);
}

/** Top-level declarations, plus the members of any class among them. */
function collectTopLevel(node: SyntaxNode, out: Collected): void {
  if (node.type === 'import_statement') {
    const specifier = importSpecifierOf(node);
    if (specifier) out.imports.push(specifier);
    return;
  }

  if (node.type === 'export_statement') {
    // `export { x } from './m'` is an import edge just as much as an import is,
    // and it is also the one place a name changes files without a declaration.
    const reexport = reexportOf(node);
    if (reexport) {
      out.imports.push(reexport.specifier);
      out.reexports.push(reexport);
    }

    const declaration = node.childForFieldName('declaration');
    if (declaration) collectTopLevel(declaration, out);
    return;
  }

  if (node.type === 'expression_statement') {
    const assigned = assignedSymbolOf(node, out.scope);
    if (assigned) {
      out.symbols.push(assigned);
      out.claimed.push(node);
      return;
    }
  }

  // `declare class C {}` wraps the declaration; `declare global { … }` wraps a
  // block of them; a namespace at statement position is parsed as an expression
  // because `namespace` is only contextually a keyword. All three are one level
  // of packaging around declarations that are otherwise ordinary.
  if (
    node.type === 'ambient_declaration' ||
    node.type === 'statement_block' ||
    node.type === 'expression_statement'
  ) {
    for (const child of node.namedChildren) collectTopLevel(child, out);
    return;
  }

  if (node.type === 'internal_module' || node.type === 'module') {
    // What a namespace declares is collected as ordinary top-level symbols with
    // no owner. The store keys owners by class and keeps an owned symbol out of
    // the file's name table, so owning them here would cost every edge into a
    // namespaced class in exchange for one level of nesting in a box.
    const body = node.childForFieldName('body');
    const before = out.symbols.length;
    if (body) for (const child of body.namedChildren) collectTopLevel(child, out);

    // They are collected first because the namespace excludes them from its own
    // calls, then moved behind it, so the box reads container before contents.
    const contents = out.symbols.splice(before);
    const name = moduleNameOf(node.childForFieldName('name'));
    if (name) out.symbols.push(makeSymbol(node, name, 'type', out.claimed, scopeOf(node, out.scope)));
    out.symbols.push(...contents);
    out.claimed.push(node);
    return;
  }

  const kind = DECLARATION_KINDS.get(node.type);
  if (kind) {
    const name = nameOf(node.childForFieldName('name'));
    if (!name) return;

    // The class is pushed before its members, and the graph layer relies on
    // that order to attach each one to the class it just saw.
    const members: ParsedSymbol[] = [];
    const scope =
      kind === 'class' || kind === 'interface' ? classScope(node, name, out.scope) : scopeOf(node, out.scope);
    const bodies =
      kind === 'class' || kind === 'interface' ? collectMembers(node, name, members, scope) : [];
    const symbol = { ...makeSymbol(node, name, kind, bodies, scope), ...modifiersOf(node) };
    out.symbols.push(symbol);
    if (node.type === 'function_signature') out.signatures.add(symbol);
    out.symbols.push(...members);
    out.claimed.push(node);
    return;
  }

  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (const declarator of node.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const value = declarator.childForFieldName('value');
      const name = nameOf(declarator.childForFieldName('name'));
      if (!name || !value) continue;

      // `const X = class {}` is a class declaration with the name moved to the
      // left of the equals sign — heritage, members and all.
      if (value.type === 'class') {
        const members: ParsedSymbol[] = [];
        const scope = classScope(value, name, out.scope);
        const bodies = collectMembers(value, name, members, scope);
        out.symbols.push(makeSymbol(value, name, 'class', bodies, scope));
        out.symbols.push(...members);
        out.claimed.push(declarator);
        continue;
      }

      if (value.type === 'arrow_function' || value.type === 'function_expression') {
        out.symbols.push(makeSymbol(declarator, name, 'function', [], scopeOf(declarator, out.scope)));
        out.claimed.push(declarator);
      }
    }
  }
}

/**
 * The tsconfig `paths` entry that governs a specifier, substituted.
 *
 * TypeScript's own rule: an exact pattern wins outright, and among wildcards the
 * longest prefix wins and its targets are the only ones tried. Falling back to a
 * worse pattern would resolve things the compiler does not.
 *
 * The targets are expected project-relative — each config's `baseUrl` and its
 * own directory are resolved away when the facts are gathered, because that is
 * the only place that knows which config a pattern came from.
 */
function pathTargets(specifier: string, tsPaths: ReadonlyMap<string, readonly string[]>): readonly string[] {
  const exact = tsPaths.get(specifier);
  if (exact) return exact;

  let bestPrefix = -1;
  let best: readonly string[] = [];
  for (const [pattern, targets] of tsPaths) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (prefix.length <= bestPrefix) continue;
    if (specifier.length < prefix.length + suffix.length) continue;
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;

    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    bestPrefix = prefix.length;
    best = targets.map((target) => target.replace('*', captured));
  }
  return best;
}

/**
 * The candidate targets, closest to the importing file first.
 *
 * `facts.tsPaths` merges every config in the project into one table, so a
 * monorepo where five packages each alias `@/*` to their own root offers five
 * targets and no way to ask which config governs the importer — tsc answers that
 * with the `include` globs the facts do not carry. Taking the first that exists
 * put three of TanStack/query's imports in a neighbouring package, which is a
 * wrong edge, and this project would rather have none. Path proximity is the
 * proxy available: a target under the importer's own package shares more of its
 * path than a target under any other.
 *
 * It only reorders. A target that shares nothing is still tried, because in a
 * single-config project that is the ordinary case rather than evidence of
 * anything.
 */
function nearestFirst(from: string, targets: readonly string[]): readonly string[] {
  if (targets.length < 2) return targets;

  const importer = from.split('/');
  const shared = (target: string): number => {
    const candidate = target.split('/');
    let depth = 0;
    while (depth < importer.length && depth < candidate.length && importer[depth] === candidate[depth]) {
      depth += 1;
    }
    return depth;
  };

  // Stable, so targets at equal distance keep the order the configs were read in.
  return [...targets].sort((a, b) => shared(b) - shared(a));
}

/**
 * A workspace package's directory to the file an import of it lands on.
 *
 * `src/index` before `index`, and `main` / `module` from package.json are not
 * consulted at all: in every monorepo measured they name build output —
 * `build/legacy/index.cjs`, `dist/shared.esm-bundler.js` — which is not in the
 * scanned file set, so reading them would add a fact that resolves nothing.
 * What the source actually imports is the source.
 */
function packageEntry(
  directory: string,
  subpath: string,
  files: ReadonlySet<string>,
): string | null {
  const target = subpath === '' ? 'index' : subpath;
  // Joined rather than interpolated: a single-package project names the root
  // itself, and its directory is the empty string.
  return (
    resolveModulePath(path.posix.join(directory, 'src', target), files) ??
    resolveModulePath(path.posix.join(directory, target), files)
  );
}

// `satisfies` rather than a `: LanguageSupport` annotation so `extract` keeps
// the type it really returns; the registry takes the object as the contract.
export const typescript = {
  id: 'typescript',
  label: 'TypeScript',
  extensions: ['.ts', '.tsx', '.mts', '.cts'],

  grammar(filePath: string) {
    // The one grammar package that holds two dialects, and the one that wants
    // the language rather than the module: it exports `{ typescript, tsx }`,
    // both of them already languages.
    grammars ??= require('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
    return filePath.endsWith('.tsx') ? grammars.tsx : grammars.typescript;
  },

  extract(root: SyntaxNode, _source: string): ModuleParse {
    const bindings = importBindings(root);
    const out: Collected = {
      imports: [],
      reexports: [],
      symbols: [],
      claimed: [],
      signatures: new Set(),
      scope: moduleScope(root, bindings),
    };
    for (const child of root.namedChildren) collectTopLevel(child, out);
    const exports = exportsOf(root);
    return {
      imports: out.imports,
      symbols: markExports(withoutOverloads(out.symbols, out.signatures), exports),
      reexports: out.reexports,
      bindings,
      ...(exports.defaultExport === null ? {} : { defaultExport: exports.defaultExport }),
    };
  },

  /**
   * Four rules, in the order the compiler applies them.
   *
   * The last one is the point of the other three: a bare `react` resolving to
   * null is correct, and before the middle two existed every `@vue/shared` and
   * every `@tanstack/query-core` took the same exit — 357 and 503 imports that
   * are the project importing itself, drawn as no coupling at all.
   */
  resolve(context: ResolveContext): string | null {
    const { from, specifier, files, facts } = context;

    if (specifier.startsWith('.')) return resolveImport(from, specifier, files);

    for (const target of nearestFirst(from, pathTargets(specifier, facts.tsPaths))) {
      const hit = resolveModulePath(target, files);
      if (hit) return hit;
    }

    const directory = facts.packages.get(specifier);
    if (directory !== undefined) return packageEntry(directory, '', files);

    // `@tanstack/angular-query-experimental/devtools` — a subpath into a
    // workspace package, which the package's own name cannot match.
    for (const [name, dir] of facts.packages) {
      if (!specifier.startsWith(`${name}/`)) continue;
      const hit = packageEntry(dir, specifier.slice(name.length + 1), files);
      if (hit) return hit;
    }

    return null;
  },
} satisfies LanguageSupport;

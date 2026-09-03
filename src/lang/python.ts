import { createRequire } from 'node:module';
import path from 'node:path';

import { QUALIFIED_SEPARATOR } from '../parser/types.js';
import type { ImportBinding, ParsedSymbol, Reexport, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * Python writes visibility as a leading underscore rather than as a keyword,
 * and only by convention — nothing enforces it — so this reports what the
 * source wrote and nothing it did not: `_helper` is private, `helper` says
 * nothing and is left absent, the way TypeScript's unwritten public is. A
 * dunder name (`__init__`, `__eq__`) is the language's own protocol, not a
 * private member, whatever its underscores.
 */
function visibilityOf(name: string): 'private' | undefined {
  return name.startsWith('_') && !/^__.*__$/.test(name) ? 'private' : undefined;
}

/**
 * Every module-level name is one another file can import by name. That is
 * the language's rule — `from .helpers import _split_blueprint_path` is legal
 * and flask writes eighteen lines like it, werkzeug thirty-seven — so every
 * top-level symbol is exported, underscore or not. What the underscore does
 * govern is `from m import *`, which skips them, and that is the one place
 * this over-reaches: a star hands on `_helper` too. The edge that draws is
 * to a name the star did not carry, which only code that fails at import
 * could write, and it is the cheaper mistake beside losing the eighteen.
 */
const EXPORTED = true;

/**
 * The types the language provides, which no project declares and no edge can
 * land on. A receiver annotated `dict[str, Any]` is left untyped rather than
 * reported as `dict.get`, which resolved to nothing either way but counted as
 * an unresolved call wherever the project declares a `get` of its own.
 */
const BUILTIN_TYPES = new Set([
  'object', 'int', 'float', 'complex', 'bool', 'str', 'bytes', 'bytearray', 'memoryview',
  'list', 'tuple', 'dict', 'set', 'frozenset', 'range', 'type', 'Any',
]);

/** A dotted name as written — `Base`, `m.Base`, `a.b.C` — or null for anything that is not one. */
function nameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'dotted_name':
      return node.text;
    case 'attribute': {
      const object = nameOf(node.childForFieldName('object'));
      const attribute = nameOf(node.childForFieldName('attribute'));
      return object === null || attribute === null ? null : `${object}.${attribute}`;
    }
    default:
      return null;
  }
}

/** The text of a string literal, or null when it is not one plain piece. */
function stringContentOf(node: SyntaxNode): string | null {
  const parts = node.namedChildren.filter((child) => child.type === 'string_content');
  return parts.length === 1 && parts[0] !== undefined ? parts[0].text : null;
}

/**
 * The wrappers a type is written inside without being one of them.
 * `Optional[T]` is a T wherever a call through it type-checks; `Type[T]` and
 * `type[T]` hold the class itself, whose methods are the same methods;
 * `ClassVar` and `Final` say how a field is held, not what it is.
 */
const TRANSPARENT = new Set(['Optional', 'Type', 'type', 'ClassVar', 'Final', 'Annotated', 'Required', 'NotRequired']);

/** `Union[A, None]` — a union of one real type is that type, and of two is neither. */
function singleOf(members: readonly SyntaxNode[]): string | null {
  const named = members.filter((member) => member.type !== 'none' && member.text !== 'None');
  return named.length === 1 && named[0] !== undefined ? typeNameOf(named[0]) : null;
}

/** The last segment of a dotted name: the `Optional` of `t.Optional`. */
function tailOf(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

/**
 * A type expression reduced to the one dotted name a call through it could
 * land on, or null. `list[Item]` is a list and not an Item — `xs.append()` is
 * the list's method — while `Optional[Item]` and `Item | None` are an Item
 * wherever a call through them runs. A string is a forward reference and is
 * read as the name it quotes; nothing else is guessed at.
 */
function typeNameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type':
    case 'parenthesized_expression':
      return typeNameOf(node.namedChildren[0] ?? null);
    case 'identifier':
    case 'attribute':
      return nameOf(node);
    case 'string': {
      const content = stringContentOf(node);
      return content !== null && /^[A-Za-z_][\w.]*$/.test(content) ? content : null;
    }
    case 'none':
      return null;
    // `Optional[T]` parses as generic_type when its head is a bare name and as
    // a subscript when the head is qualified, `t.Optional[T]`; the grammar
    // draws the line by the head and this reads both the same way.
    case 'generic_type':
    case 'subscript': {
      const head = node.type === 'generic_type' ? (node.namedChildren[0] ?? null) : node.childForFieldName('value');
      const name = nameOf(head);
      if (name === null) return null;
      const arguments_ =
        node.type === 'generic_type'
          ? (node.namedChildren.find((child) => child.type === 'type_parameter')?.namedChildren ?? [])
          : node.namedChildren.slice(1);
      const tail = tailOf(name);
      if (TRANSPARENT.has(tail)) return typeNameOf(arguments_[0] ?? null);
      if (tail === 'Union') return singleOf(arguments_);
      return name;
    }
    case 'binary_operator':
      return node.childForFieldName('operator')?.text === '|'
        ? singleOf([node.childForFieldName('left'), node.childForFieldName('right')].filter((n): n is SyntaxNode => n !== null))
        : null;
    default:
      return null;
  }
}

/** The collections whose element is what a field of that type holds many of. */
const MANY = new Set([
  'list', 'List', 'set', 'Set', 'frozenset', 'FrozenSet', 'tuple', 'Tuple', 'Sequence',
  'MutableSequence', 'Iterable', 'Iterator', 'Collection', 'deque', 'Deque',
]);
/** The mappings, whose value type is the one that matters. */
const MAPPING = new Set(['dict', 'Dict', 'Mapping', 'MutableMapping', 'defaultdict', 'DefaultDict', 'OrderedDict']);

/**
 * The declared type of a field, reduced to the one name an association can be
 * drawn to, and whether there are many of it. `list[Item]` and `dict[str,
 * Item]` both name Item and both mean more than one, which is the cardinality
 * on the edge; `Optional[Item]` is one Item that may be missing.
 */
function typeReference(node: SyntaxNode | null): { typeName?: string; many?: boolean } {
  if (!node) return {};
  const inner = node.type === 'type' ? (node.namedChildren[0] ?? null) : node;
  if (inner?.type === 'generic_type' || inner?.type === 'subscript') {
    const head = inner.type === 'generic_type' ? (inner.namedChildren[0] ?? null) : inner.childForFieldName('value');
    const name = nameOf(head);
    const arguments_ =
      inner.type === 'generic_type'
        ? (inner.namedChildren.find((child) => child.type === 'type_parameter')?.namedChildren ?? [])
        : inner.namedChildren.slice(1);
    if (name !== null && MANY.has(tailOf(name))) {
      // `tuple[A, B]` holds one of each; only `tuple[A, ...]` is many A.
      const element = arguments_.length === 1 || arguments_[1]?.type === 'ellipsis' ? typeNameOf(arguments_[0] ?? null) : null;
      return element === null ? { many: true } : { typeName: element, many: true };
    }
    if (name !== null && MAPPING.has(tailOf(name))) {
      const value = typeNameOf(arguments_[arguments_.length - 1] ?? null);
      return value === null ? { many: true } : { typeName: value, many: true };
    }
  }
  const name = typeNameOf(inner);
  return name === null ? {} : { typeName: name };
}

/**
 * What the file imported, in the forms the graph reads.
 *
 * `from a.b import c` is the one that needs explaining, because `c` may be a
 * name declared in module a.b or a submodule a/b/c.py, and nothing at the
 * import site says which. Python itself tries the attribute and then the
 * submodule. The parser cannot, so the reference is written down the way Go
 * writes a qualified one, `a.b#c`, with QUALIFIED_SEPARATOR between the module
 * and the name — a module path cannot contain a `#` any more than a Go import
 * path can — and the resolver, which has the file set, is what answers. Two
 * bindings are recorded for the same local, and the store keeps the first that
 * resolves: `a.b.c` resolves only when the submodule exists and binds the whole
 * module under `c`, so `c.f()` reaches into it; `a.b#c` is the name in the
 * module, for when it does not.
 *
 * Every name a module imports is also a name it exports. That is not a
 * convention, it is how a Python module works — its attributes are what it
 * bound — and it is how every package's `__init__.py` presents its API:
 * flask's is twenty lines of `from .app import Flask as Flask`. So each
 * from-import is recorded as a re-export as well, and `from flask import
 * Flask` lands on app.py rather than on the barrel that mentions it.
 */
interface Imported {
  /** Local name -> the module path it stands for, for `import a` and `import a.b as m`. */
  bindings: ImportBinding[];
  reexports: Reexport[];
  /** The specifiers to report, before the dotted ones are expanded by what reached them. */
  specifiers: Set<string>;
  /**
   * `import a.b.c` with no alias binds `a`, and the module is written out in
   * full at every use: `a.b.c.f()`. These are matched against the text of an
   * attribute's object, and a name reached through one is written as
   * `a.b.c#f`, the same form as above and resolved the same way.
   */
  dotted: Set<string>;
}

/** `.` + `x` is `.x`, `.pkg` + `y` is `.pkg.y`, `a.b` + `c` is `a.b.c`. */
function joinModule(module: string, name: string): string {
  return module.endsWith('.') ? module + name : `${module}.${name}`;
}

function importsOf(root: SyntaxNode): Imported {
  const out: Imported = { bindings: [], reexports: [], specifiers: new Set(), dotted: new Set() };

  // Read across the whole file rather than off its top: an import inside a
  // function, an `if TYPE_CHECKING:` or a `try:` still names a file this one
  // depends on, and flask writes all three.
  for (const statement of root.descendantsOfType(['import_statement', 'import_from_statement'])) {
    if (statement.type === 'import_statement') {
      for (const child of statement.namedChildren) {
        if (child.type === 'aliased_import') {
          const module = nameOf(child.childForFieldName('name'));
          const alias = child.childForFieldName('alias')?.text;
          if (module === null || alias === undefined) continue;
          out.specifiers.add(module);
          out.bindings.push({ local: alias, specifier: module, imported: '*' });
        } else if (child.type === 'dotted_name') {
          const module = child.text;
          if (module.includes('.')) out.dotted.add(module);
          else {
            out.specifiers.add(module);
            out.bindings.push({ local: module, specifier: module, imported: '*' });
          }
        }
      }
      continue;
    }

    const module = statement.childForFieldName('module_name')?.text;
    if (module === undefined) continue;

    if (statement.namedChildren.some((child) => child.type === 'wildcard_import')) {
      out.specifiers.add(module);
      out.reexports.push({ specifier: module, names: '*' });
      continue;
    }

    for (const child of statement.namedChildren) {
      let imported: string | null = null;
      let local: string | null = null;
      if (child.type === 'aliased_import') {
        imported = nameOf(child.childForFieldName('name'));
        local = child.childForFieldName('alias')?.text ?? null;
      } else if (child.type === 'dotted_name' && child !== statement.childForFieldName('module_name')) {
        imported = child.text;
        local = imported;
      }
      if (imported === null || local === null) continue;

      const qualified = `${module}${QUALIFIED_SEPARATOR}${imported}`;
      out.specifiers.add(qualified);
      out.bindings.push({ local, specifier: joinModule(module, imported), imported: '*' });
      out.bindings.push({ local, specifier: qualified, imported });
      out.reexports.push({ specifier: qualified, names: [{ exported: local, local: imported }] });
    }
  }

  return out;
}

/**
 * Import path -> the names this file reaches through it, for the dotted
 * imports that were never aliased: the `f` of `a.b.c.f()`, the `T` of
 * `x: a.b.c.T`. One reference each, so the resolver can land it on the file
 * that declares the name — a submodule, or the module itself.
 */
function reachedThrough(root: SyntaxNode, dotted: ReadonlySet<string>): Map<string, Set<string>> {
  const byPath = new Map<string, Set<string>>();
  if (dotted.size === 0) return byPath;
  for (const attribute of root.descendantsOfType('attribute')) {
    const object = nameOf(attribute.childForFieldName('object'));
    const name = attribute.childForFieldName('attribute')?.text;
    if (object === null || name === undefined || !dotted.has(object)) continue;
    const names = byPath.get(object) ?? new Set<string>();
    names.add(name);
    byPath.set(object, names);
  }
  return byPath;
}

/**
 * The scope a symbol's receivers are read against, so `x.m()` is reported as
 * `T.m` when — and only when — the source wrote T down.
 *
 * Python writes almost nothing down. A parameter has a type only when someone
 * annotated it, a local only when it was built in place with `T(...)`, and
 * `self.x` only when `__init__` assigned something typed to it. Every other
 * receiver contributes nothing, not even its bare property name — a missing
 * edge is a gap, a wrong one is a lie — so recall through receivers is low on
 * unannotated code, and that is the honest answer rather than a defect.
 */
interface Scope {
  /** Local name -> the module it stands for, for every import the file made. */
  imported: ReadonlySet<string>;
  /** See `Imported.dotted`. */
  dotted: ReadonlySet<string>;
  /** Module-level variable -> the type its assignment wrote, or null when refused. */
  variables: ReadonlyMap<string, string | null>;
  /** The class whose method this is, or null outside one. */
  owner: string | null;
  /** `self.x` -> the written type of field x. */
  fields: ReadonlyMap<string, string>;
}

/**
 * Record one declaration of a name into a table of receiver types. A name
 * declared twice is kept only if every declaration agrees, and one declaration
 * without a type — `for x in xs`, `x = f()` — refuses the name outright, since
 * nothing here knows which block a later `x.m()` is in.
 */
function bindType(typed: Map<string, string | null>, name: string, written: string | null): void {
  if (name === '_') return;
  if (!typed.has(name)) {
    typed.set(name, written);
    return;
  }
  if (typed.get(name) !== written) typed.set(name, null);
}

/** `= T(...)`, or `= await T(...)`: the one way a type is written when no annotation is. */
function constructedTypeOf(value: SyntaxNode | null): string | null {
  const expression = value?.type === 'await' ? (value.namedChildren[0] ?? null) : value;
  if (expression?.type !== 'call') return null;
  const callee = expression.childForFieldName('function');
  return callee?.type === 'identifier' || callee?.type === 'attribute' ? nameOf(callee) : null;
}

/** An assignment's written type: the annotation, or what it was constructed as. */
function assignedTypeOf(assignment: SyntaxNode): string | null {
  return typeNameOf(assignment.childForFieldName('type')) ?? constructedTypeOf(assignment.childForFieldName('right'));
}

/** Every identifier a target pattern binds: `x`, `a, b`, `(a, b)`, `[a, *rest]`. */
function targetsOf(pattern: SyntaxNode | null): SyntaxNode[] {
  if (!pattern) return [];
  if (pattern.type === 'identifier') return [pattern];
  if (pattern.type === 'pattern_list' || pattern.type === 'tuple_pattern' || pattern.type === 'list_pattern') {
    return pattern.namedChildren.flatMap(targetsOf);
  }
  if (pattern.type === 'list_splat_pattern') return targetsOf(pattern.namedChildren[0] ?? null);
  return [];
}

/**
 * The names a parameter list binds, each with the annotation written beside
 * it, as a node: a receiver reads the one name it can be called through, a
 * field copied from the parameter reads the cardinality too. The grammar
 * spells a parameter five ways and puts the name in a different place in
 * each; the separators `*` and `/` bind nothing.
 */
function parametersOf(parameters: SyntaxNode | null): [string, SyntaxNode | null][] {
  const bound: [string, SyntaxNode | null][] = [];
  for (const parameter of parameters?.namedChildren ?? []) {
    switch (parameter.type) {
      case 'identifier':
        bound.push([parameter.text, null]);
        break;
      case 'typed_parameter': {
        // `*args: int` keeps the name inside the splat, and a splat holds many.
        const name = parameter.namedChildren[0];
        if (name?.type === 'identifier') bound.push([name.text, parameter.childForFieldName('type')]);
        else for (const target of targetsOf(name ?? null)) bound.push([target.text, null]);
        break;
      }
      case 'default_parameter':
      case 'typed_default_parameter': {
        const name = parameter.childForFieldName('name');
        if (name?.type === 'identifier') bound.push([name.text, parameter.childForFieldName('type')]);
        break;
      }
      case 'list_splat_pattern':
      case 'dictionary_splat_pattern':
        for (const target of targetsOf(parameter.namedChildren[0] ?? null)) bound.push([target.text, null]);
        break;
      default:
        break;
    }
  }
  return bound;
}

/**
 * Whether one node lies inside another. Held by position, because the grammar
 * hands back a fresh object for the same node on every access.
 */
function within(node: SyntaxNode, ranges: readonly SyntaxNode[]): boolean {
  return ranges.some((range) => node.startIndex >= range.startIndex && node.endIndex <= range.endIndex);
}

/**
 * Everything a subtree binds, in one table: assignment targets with the type
 * their value wrote, loop and `with` and `except` targets with none, the
 * walrus, and nested definitions, whose names are locals of the function
 * around them. One table for the whole body, over-approximated the way Go's
 * is, and for the same reason: deciding what a name means at the point it is
 * written needs the scope chain, and getting that wrong draws an edge the
 * source does not contain.
 */
function bodyBindings(node: SyntaxNode, typed: Map<string, string | null>, skip: readonly SyntaxNode[]): void {
  const bound = (candidate: SyntaxNode): boolean => !within(candidate, skip);
  for (const assignment of node.descendantsOfType('assignment')) {
    if (!bound(assignment)) continue;
    const left = assignment.childForFieldName('left');
    if (left?.type === 'identifier') bindType(typed, left.text, assignedTypeOf(assignment));
    else for (const target of targetsOf(left)) bindType(typed, target.text, null);
  }
  for (const loop of node.descendantsOfType(['for_statement', 'for_in_clause'])) {
    if (!bound(loop)) continue;
    for (const target of targetsOf(loop.childForFieldName('left'))) bindType(typed, target.text, null);
  }
  // `with open(p) as fh` and `except E as err` share one node for the `as`.
  for (const target of node.descendantsOfType('as_pattern_target')) {
    if (!bound(target)) continue;
    for (const name of targetsOf(target.namedChildren[0] ?? null)) bindType(typed, name.text, null);
  }
  for (const walrus of node.descendantsOfType('named_expression')) {
    if (!bound(walrus)) continue;
    const name = walrus.childForFieldName('name');
    if (name?.type === 'identifier') bindType(typed, name.text, null);
  }
  for (const definition of node.descendantsOfType(['function_definition', 'class_definition'])) {
    if (!bound(definition) || definition.startIndex === node.startIndex) continue;
    const name = definition.childForFieldName('name')?.text;
    if (name !== undefined) bindType(typed, name, null);
  }
  for (const parameters of node.descendantsOfType(['parameters', 'lambda_parameters'])) {
    if (!bound(parameters)) continue;
    for (const [name, annotation] of parametersOf(parameters)) bindType(typed, name, typeNameOf(annotation));
  }
}

/**
 * A type as this file may name it, or null when it cannot: bare for one the
 * file declares or bound by import, `m.T` for one reached through an import
 * binding, which the graph resolves through the file's bindings, and `a.b.c#T`
 * for one reached through a dotted import written out in full.
 */
function qualify(written: string, scope: Scope): string | null {
  const dot = written.indexOf('.');
  if (dot === -1) return written;
  // The longest dotted import that is a prefix: `a.b.c.T` under `import a.b.c`
  // is c's T, and under `import a.b` as well it is still c's.
  let longest: string | null = null;
  for (const module of scope.dotted) {
    if (written.startsWith(`${module}.`) && (longest === null || module.length > longest.length)) longest = module;
  }
  if (longest !== null) return `${longest}${QUALIFIED_SEPARATOR}${written.slice(longest.length + 1)}`;
  return scope.imported.has(written.slice(0, dot)) ? written : null;
}

/**
 * Every name invoked inside a subtree, in the forms the graph resolves: a bare
 * `f` for a name this file declares or imported; `T.m` for a method on a
 * receiver whose type was written down — `self` inside T, a parameter
 * annotated `: T`, a local built with `T(...)`, a field `__init__` typed; and
 * `m.helper` for a call through an import binding, which the graph follows to
 * the module `m` stands for. An untyped receiver yields nothing.
 *
 * `exclude` holds the subtrees that are symbols in their own right — a class's
 * methods — so the enclosing symbol does not claim what they call.
 */
function collectCalls(
  node: SyntaxNode,
  scope: Scope,
  typed: ReadonlyMap<string, string | null>,
  locals: ReadonlySet<string>,
  instance: string | null,
  exclude: readonly SyntaxNode[] = [],
): string[] {
  const names = new Set<string>();

  /**
   * The definitions inside this one that take the instance's name as a
   * parameter of their own: the methods of a class written inside a method —
   * requests' tests do that eleven times — and a callback declared `(self)`.
   * Inside those, `self` is their instance and not this one, so it is read as
   * the local it is; a closure that merely mentions `self` still sees ours.
   */
  const rebound =
    instance === null
      ? []
      : node.descendantsOfType(['function_definition', 'lambda']).filter(
          (definition) =>
            definition.startIndex !== node.startIndex &&
            parametersOf(definition.childForFieldName('parameters')).some(([name]) => name === instance),
        );
  const isInstance = (identifier: SyntaxNode): boolean => identifier.text === instance && !within(identifier, rebound);

  /** The classifier a receiver expression is known to be, as this file may name it. */
  const receiverOf = (object: SyntaxNode | null): string | null => {
    if (!object) return null;
    if (object.type === 'identifier') {
      if (isInstance(object)) return scope.owner;
      const written = typed.get(object.text);
      return written === undefined || written === null || BUILTIN_TYPES.has(written) ? null : qualify(written, scope);
    }
    if (object.type !== 'attribute') return null;
    const holder = object.childForFieldName('object');
    if (holder?.type === 'identifier' && isInstance(holder)) {
      const field = object.childForFieldName('attribute')?.text;
      const written = field === undefined ? undefined : scope.fields.get(field);
      return written === undefined || BUILTIN_TYPES.has(written) ? null : qualify(written, scope);
    }
    return null;
  };

  for (const call of node.descendantsOfType('call')) {
    if (within(call, exclude)) continue;
    const callee = call.childForFieldName('function');
    if (!callee) continue;

    if (callee.type === 'identifier') {
      // `cls()` in a classmethod builds the class; any other local — a
      // parameter holding a callback, a nested function — names nothing the
      // graph can point at.
      if (isInstance(callee)) {
        if (scope.owner !== null) names.add(scope.owner);
      } else if (!locals.has(callee.text)) names.add(callee.text);
      continue;
    }

    if (callee.type !== 'attribute') continue;
    const member = callee.childForFieldName('attribute')?.text;
    const object = callee.childForFieldName('object');
    if (member === undefined || !object) continue;

    // `a.b.c.f()` under `import a.b.c`: the module written out, then the name.
    const path_ = object.type === 'attribute' ? nameOf(object) : null;
    if (path_ !== null && scope.dotted.has(path_)) {
      names.add(`${path_}${QUALIFIED_SEPARATOR}${member}`);
      continue;
    }
    const receiver = receiverOf(object);
    if (receiver !== null) names.add(`${receiver}.${member}`);
  }

  return [...names];
}

/** The decorators on a definition, by the name each was written as: `staticmethod`, `t.overload`. */
function decoratorsOf(decorated: SyntaxNode | null): string[] {
  const names: string[] = [];
  for (const decorator of decorated?.namedChildren ?? []) {
    if (decorator.type !== 'decorator') continue;
    const expression = decorator.namedChildren[0] ?? null;
    const name = nameOf(expression?.type === 'call' ? expression.childForFieldName('function') : expression);
    if (name !== null) names.push(tailOf(name));
  }
  return names;
}

function symbolAt(
  node: SyntaxNode,
  name: string,
  kind: SymbolKind,
  calls: string[],
): ParsedSymbol {
  const visibility = visibilityOf(name);
  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    // Python has no `implements`: an abstract base is a base, and a protocol
    // is satisfied structurally, which nothing short of a type checker sees.
    implements: [],
    calls,
    ...(visibility === undefined ? {} : { visibility }),
  };
}

/** The statements that hold others, whose blocks are still module or class level. */
const COMPOUND: ReadonlySet<string> = new Set([
  'if_statement', 'elif_clause', 'else_clause', 'try_statement', 'except_clause', 'except_group_clause',
  'finally_clause', 'with_statement', 'for_statement', 'while_statement', 'match_statement', 'case_clause',
  'block',
]);

/**
 * The definitions at one level, looking through `if`, `try` and the rest: a
 * `def` under `if TYPE_CHECKING:` or in the `except ImportError:` fallback is
 * as much the module's as one written flat, and Python has no other way to
 * write a conditional definition.
 */
function definitionsIn(node: SyntaxNode, out: SyntaxNode[]): void {
  for (const child of node.namedChildren) {
    if (child.type === 'function_definition' || child.type === 'class_definition' || child.type === 'decorated_definition') {
      out.push(child);
    } else if (COMPOUND.has(child.type)) {
      definitionsIn(child, out);
    }
  }
}

/** A definition and the decorators wrapped around it, whichever node was found. */
function unwrap(node: SyntaxNode): { definition: SyntaxNode; decorated: SyntaxNode | null } {
  if (node.type !== 'decorated_definition') return { definition: node, decorated: null };
  const definition = node.childForFieldName('definition');
  return definition ? { definition, decorated: node } : { definition: node, decorated: null };
}

/**
 * The bases of a class, as the file may name them. `class A(B, m.C,
 * Generic[T], metaclass=M)` extends B, m.C and Generic: a keyword argument
 * configures the class rather than deriving it, and a subscript names the
 * generic being specialised.
 */
function basesOf(declaration: SyntaxNode, scope: Scope): { bases: string[]; abstract: boolean } {
  const bases: string[] = [];
  let abstract = false;
  for (const argument of declaration.childForFieldName('superclasses')?.namedChildren ?? []) {
    if (argument.type === 'keyword_argument') {
      if (argument.childForFieldName('name')?.text === 'metaclass' && tailOf(argument.childForFieldName('value')?.text ?? '') === 'ABCMeta') {
        abstract = true;
      }
      continue;
    }
    const written = nameOf(argument.type === 'subscript' ? argument.childForFieldName('value') : argument);
    if (written === null) continue;
    if (tailOf(written) === 'ABC') abstract = true;
    const name = qualify(written, scope);
    if (name !== null) bases.push(name);
  }
  return { bases, abstract };
}

/** One field as the class wrote it. */
interface Field {
  /** The statement that declares it, for the range. */
  node: SyntaxNode;
  /** The one name a call through it lands on, or null when none was written or two were. */
  receiver: string | null;
  /** What an association is drawn from: the annotation's type and cardinality. */
  reference: { typeName?: string; many?: boolean };
}

/** A field from its annotation, or from what it was constructed as when there is none. */
function fieldOf(node: SyntaxNode, annotation: SyntaxNode | null, constructed: SyntaxNode | null): Field {
  const receiver = typeNameOf(annotation) ?? constructedTypeOf(constructed);
  const reference = annotation ? typeReference(annotation) : receiver === null ? {} : { typeName: receiver };
  return { node, receiver, reference };
}

/** A second declaration of a field: kept only where the two agree. */
function declareField(fields: Map<string, Field>, name: string, field: Field): void {
  const known = fields.get(name);
  if (known === undefined) fields.set(name, field);
  else if (known.receiver !== field.receiver) known.receiver = null;
}

/**
 * `self.x = …` inside `__init__`, which is how a Python class writes its
 * fields at all, each with the type that was written for it: an annotation,
 * a `T(...)`, or the parameter it was copied from — `self.log = log` under
 * `def __init__(self, log: Logger)` is the common case and the only one where
 * the type sits two lines away.
 */
function initFields(init: SyntaxNode, instance: string, out: Map<string, Field>): void {
  const parameters = new Map(parametersOf(init.childForFieldName('parameters')));
  // The same rule `collectCalls` follows: a class or a function written inside
  // `__init__` that takes the instance's name as a parameter of its own has its
  // own `self`, and its attributes are its, not ours. Without this a nested
  // `class Inner: def __init__(self): self.leak: Logger = ...` gave Widget a
  // field named leak and an association to Logger it never has.
  const rebound = init
    .descendantsOfType(['function_definition', 'lambda'])
    .filter(
      (definition) =>
        definition.startIndex !== init.startIndex &&
        parametersOf(definition.childForFieldName('parameters')).some(([name]) => name === instance),
    );
  for (const assignment of init.descendantsOfType('assignment')) {
    if (within(assignment, rebound)) continue;
    const left = assignment.childForFieldName('left');
    const targets = left?.type === 'attribute' ? [left] : (left?.namedChildren ?? []);
    for (const target of targets) {
      if (target.type !== 'attribute' || target.childForFieldName('object')?.text !== instance) continue;
      const name = target.childForFieldName('attribute')?.text;
      if (name === undefined) continue;
      const right = assignment.childForFieldName('right');
      const annotation = assignment.childForFieldName('type');
      const copied = left?.type === 'attribute' && right?.type === 'identifier' ? (parameters.get(right.text) ?? null) : null;
      declareField(out, name, fieldOf(assignment, annotation ?? copied, right));
    }
  }
}

/** The first parameter of a method is the instance, or the class under `@classmethod`; a static method has neither. */
function instanceOf(definition: SyntaxNode, decorators: readonly string[]): string | null {
  if (decorators.includes('staticmethod')) return null;
  const first = definition.childForFieldName('parameters')?.namedChildren[0];
  if (!first) return null;
  const name = first.type === 'identifier' ? first : first.type === 'typed_parameter' ? first.namedChildren[0] : first.childForFieldName('name');
  return name?.type === 'identifier' ? name.text : null;
}

interface Collected {
  symbols: ParsedSymbol[];
  /** Subtrees that became a symbol, so the file does not also claim their calls. */
  claimed: SyntaxNode[];
  /** Which symbols came from an `@overload` signature; see `withoutOverloads`. */
  signatures: Set<ParsedSymbol>;
}

/**
 * A class and its members, as symbols of their own.
 *
 * Attributes come first — the class-level ones in the order written, then what
 * `__init__` assigned to `self` — and operations after, which is the order a
 * UML class box reads in. A class written inside another is not a symbol: it
 * is a local of the class body, the way a `def` inside a `def` is a local of
 * the function, and its calls are the class's.
 */
function collectClass(node: SyntaxNode, scope: Scope, out: Collected): void {
  const { definition, decorated } = unwrap(node);
  const name = definition.childForFieldName('name')?.text;
  const body = definition.childForFieldName('body');
  if (name === undefined || !body) return;

  const { bases, abstract } = basesOf(definition, scope);
  const methods: SyntaxNode[] = [];
  definitionsIn(body, methods);

  // Attributes first, then the class scope they make, then the operations
  // read against it — `self.store.count()` needs `store`'s type before any
  // method is read.
  const fields = new Map<string, Field>();
  for (const statement of body.namedChildren) {
    const assignment = statement.type === 'expression_statement' ? statement.namedChildren[0] : undefined;
    if (assignment?.type !== 'assignment') continue;
    const left = assignment.childForFieldName('left');
    if (left?.type !== 'identifier' || fields.has(left.text)) continue;
    fields.set(left.text, fieldOf(statement, assignment.childForFieldName('type'), assignment.childForFieldName('right')));
  }
  const bodies = methods.map((method) => unwrap(method).definition);
  for (const method of methods) {
    const { definition: def, decorated: dec } = unwrap(method);
    if (def.type !== 'function_definition' || def.childForFieldName('name')?.text !== '__init__') continue;
    const instance = instanceOf(def, decoratorsOf(dec));
    if (instance !== null) initFields(def, instance, fields);
  }
  const typedFields = new Map<string, string>();
  for (const [field, { receiver }] of fields) if (receiver !== null) typedFields.set(field, receiver);
  const classScope: Scope = { ...scope, owner: name, fields: typedFields };

  const symbol: ParsedSymbol = {
    ...symbolAt(decorated ?? definition, name, 'class', collectCalls(body, classScope, scope.variables, new Set(), null, bodies)),
    extends: bases,
    ...(abstract ? { isAbstract: true } : {}),
    exported: EXPORTED,
  };
  out.symbols.push(symbol);

  for (const [field, { node: at, reference }] of fields) {
    out.symbols.push({ ...symbolAt(at, field, 'field', []), owner: name, ...reference });
  }

  for (const method of methods) {
    const { definition: def, decorated: dec } = unwrap(method);
    if (def.type !== 'function_definition') continue;
    const methodName = def.childForFieldName('name')?.text;
    if (methodName === undefined) continue;
    const decorators = decoratorsOf(dec);
    const instance = instanceOf(def, decorators);

    const typed = new Map(scope.variables);
    const locals = new Set<string>();
    for (const [parameter] of parametersOf(def.childForFieldName('parameters'))) locals.add(parameter);
    // Bound into a table of their own first. Reading them out of `typed` missed
    // every name the module already held — `Foo = make()` under
    // `from lib import Foo` was not seen as a local at all, so a bare `Foo()`
    // was drawn on the import.
    const own = new Map<string, string | null>();
    bodyBindings(def, own, []);
    for (const bound of own.keys()) locals.add(bound);
    for (const [bound, type] of own) typed.set(bound, type);

    const calls = collectCalls(def, classScope, typed, locals, instance);
    const symbol: ParsedSymbol = {
      ...symbolAt(dec ?? def, methodName, 'method', calls),
      owner: name,
      ...(decorators.includes('staticmethod') || decorators.includes('classmethod') ? { isStatic: true } : {}),
      ...(decorators.includes('abstractmethod') ? { isAbstract: true } : {}),
    };
    out.symbols.push(symbol);
    if (decorators.includes('overload')) out.signatures.add(symbol);
  }

  out.claimed.push(definition);
}

function collectFunction(node: SyntaxNode, scope: Scope, out: Collected): void {
  const { definition, decorated } = unwrap(node);
  const name = definition.childForFieldName('name')?.text;
  if (name === undefined) return;

  const typed = new Map(scope.variables);
  const locals = new Set<string>();
  for (const [parameter] of parametersOf(definition.childForFieldName('parameters'))) locals.add(parameter);
  // See collectMethods: a local that reuses a name the module bound is still
  // the local, and reading the bindings out of `typed` could not see that.
  const own = new Map<string, string | null>();
  bodyBindings(definition, own, []);
  for (const bound of own.keys()) locals.add(bound);
  for (const [bound, type] of own) typed.set(bound, type);

  const decorators = decoratorsOf(decorated);
  const symbol: ParsedSymbol = {
    ...symbolAt(decorated ?? definition, name, 'function', collectCalls(definition, scope, typed, locals, null)),
    exported: EXPORTED,
  };
  out.symbols.push(symbol);
  if (decorators.includes('overload')) out.signatures.add(symbol);
  out.claimed.push(definition);
}

/**
 * An `@overload` signature is not a second function. The stacked signatures
 * in front of an implementation would list `get` three times in one box, so
 * a signature survives only when nothing else declares that name on the same
 * owner — a stub file, where the signatures are all there is.
 */
function withoutOverloads(symbols: readonly ParsedSymbol[], signatures: ReadonlySet<ParsedSymbol>): ParsedSymbol[] {
  if (signatures.size === 0) return [...symbols];
  const key = (symbol: ParsedSymbol): string => `${symbol.owner ?? ''}.${symbol.name}`;
  const implemented = new Set(symbols.filter((symbol) => !signatures.has(symbol)).map(key));
  const kept = new Set<string>();
  return symbols.filter((symbol) => {
    if (!signatures.has(symbol)) return true;
    if (implemented.has(key(symbol)) || kept.has(key(symbol))) return false;
    kept.add(key(symbol));
    return true;
  });
}

/**
 * The importable name of a file, from its path: `pkg/sub/mod.py` is
 * `pkg.sub.mod` and `pkg/__init__.py` is `pkg`. A leading `src` is dropped,
 * because that is the one directory the packaging tools put on the path
 * without it being a package — flask is `src/flask/app.py` and is imported as
 * `flask.app`. Nothing else is inferred: the name exists so an unresolved
 * `flask.x` can be told from an unresolved `numpy`, and a head that is off by
 * one directory only miscounts.
 */
function moduleNameOf(filePath: string): string {
  const segments = filePath.replace(/\.py$/i, '').split('/');
  if (segments[segments.length - 1] === '__init__') segments.pop();
  if (segments[0] === 'src' && segments.length > 1) segments.shift();
  return segments.join('.');
}

/**
 * The directories an absolute import is tried from, over one file set: the
 * project root, and every directory that holds a package without being one
 * itself — `src` above `src/flask/__init__.py`, `tests/test_apps` above the
 * apps flask's tests import by bare name. That is what a source root is, and
 * `pyproject.toml` is not consulted because this is the answer it would give.
 * Rebuilt when the set changes identity, which is once per derivation.
 */
let indexed: { files: ReadonlySet<string>; roots: string[] } | null = null;

function rootsOf(files: ReadonlySet<string>): readonly string[] {
  if (indexed?.files === files) return indexed.roots;

  const packages = new Set<string>();
  for (const file of files) {
    if (file === '__init__.py') packages.add('');
    else if (file.endsWith('/__init__.py')) packages.add(file.slice(0, -'/__init__.py'.length));
  }
  const roots = new Set<string>(['']);
  for (const pkg of packages) {
    const parent = pkg.includes('/') ? pkg.slice(0, pkg.lastIndexOf('/')) : '';
    if (!packages.has(parent)) roots.add(parent);
  }

  indexed = { files, roots: [...roots].sort() };
  return indexed.roots;
}

/** The file a module path names, package before module as the import system has it, or null. */
function moduleFile(base: string, files: ReadonlySet<string>): string | null {
  const init = base === '' ? '__init__.py' : `${base}/__init__.py`;
  if (files.has(init)) return init;
  const module = `${base}.py`;
  return base !== '' && files.has(module) ? module : null;
}

// `satisfies` rather than a `: LanguageSupport` annotation so `extract` keeps
// the argument it really takes; the registry takes the object as the contract.
export const python = {
  id: 'python' as const,
  label: 'Python',
  extensions: ['.py'],

  grammar(_filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    loaded ??= require('tree-sitter-python');
    return loaded;
  },

  /**
   * The third argument is not in the contract yet. A Python module's name is
   * its path and nothing in the source says it, so `moduleName` can only be
   * set once the caller passes the path; until then it is absent, and only
   * the unresolved-import count is the poorer for it.
   */
  extract(root: SyntaxNode, _source: string, filePath?: string): LanguageParse {
    const imported = importsOf(root);
    const reached = reachedThrough(root, imported.dotted);
    for (const module of imported.dotted) {
      const names = reached.get(module);
      if (names === undefined) imported.specifiers.add(module);
      else for (const name of names) imported.specifiers.add(`${module}${QUALIFIED_SEPARATOR}${name}`);
    }

    const definitions: SyntaxNode[] = [];
    definitionsIn(root, definitions);

    // What the module binds at its own level: every import names itself, so
    // `m.helper()` is a call through m, and `app = Flask(__name__)` types app
    // for every `app.route(...)` below it and in every function of the file.
    // Read off the module's own statements, not through the definitions, so a
    // function's local cannot type the module's name of the same spelling.
    const variables = new Map<string, string | null>();
    for (const binding of imported.bindings) bindType(variables, binding.local, binding.local);
    bodyBindings(root, variables, definitions.map((node) => unwrap(node).definition));

    const scope: Scope = {
      imported: new Set(imported.bindings.map((binding) => binding.local)),
      dotted: imported.dotted,
      variables,
      owner: null,
      fields: new Map(),
    };

    const out: Collected = { symbols: [], claimed: [], signatures: new Set() };
    for (const node of definitions) {
      if (unwrap(node).definition.type === 'class_definition') collectClass(node, scope, out);
      else collectFunction(node, scope, out);
    }

    // What runs at import: `app = Flask(__name__)`, `app.run()` under
    // `if __name__ == "__main__":`, and every decorator, which is applied
    // when the module loads and not when the function it wraps is called.
    const calls = collectCalls(root, scope, variables, new Set(), null, out.claimed);

    return {
      imports: [...imported.specifiers],
      symbols: withoutOverloads(out.symbols, out.signatures),
      bindings: imported.bindings,
      reexports: imported.reexports,
      calls,
      ...(filePath === undefined ? {} : { moduleName: moduleNameOf(filePath) }),
    };
  },

  /**
   * A module path to a file. `a.b.c` is `a/b/c/__init__.py` or `a/b/c.py`,
   * tried from each source root in turn and last from the importing file's
   * own directory, which is where Python looks when the file is run as a
   * script; `.x` and `..x` are relative to the importing file, as written.
   *
   * `a.b#c` is `from a.b import c`: the submodule a/b/c when there is one,
   * otherwise the module a.b, which is where the name lives — a re-export
   * in an `__init__.py` included, since the graph follows those from there.
   *
   * `os`, `numpy`, and everything else the project does not hold resolve to
   * nothing, because there is nothing here for them to resolve to.
   */
  resolve(context: ResolveContext): string | null {
    const { from, specifier, files } = context;
    const hash = specifier.indexOf(QUALIFIED_SEPARATOR);
    const module = hash < 0 ? specifier : specifier.slice(0, hash);
    const name = hash < 0 ? null : specifier.slice(hash + 1);

    /** The file for a module at `base`, or its submodule `name` when that is what was asked for. */
    const at = (base: string, packageOnly: boolean): string | null => {
      if (name !== null) {
        const sub = moduleFile(base === '' ? name : `${base}/${name}`, files);
        if (sub !== null) return sub;
      }
      if (packageOnly) {
        const init = base === '' ? '__init__.py' : `${base}/__init__.py`;
        return files.has(init) ? init : null;
      }
      return moduleFile(base, files);
    };

    const dots = /^\.*/.exec(module)?.[0].length ?? 0;
    if (dots > 0) {
      let directory = path.posix.dirname(from);
      if (directory === '.') directory = '';
      for (let up = 1; up < dots; up += 1) {
        if (directory === '') return null;
        directory = path.posix.dirname(directory);
        if (directory === '.') directory = '';
      }
      const rest = module.slice(dots);
      if (rest === '') return at(directory, true);
      return at(path.posix.join(directory, ...rest.split('.')), false);
    }

    // Python 3 resolves an absolute import against sys.path, and sys.path[0]
    // is the SCRIPT's directory — never the directory of a module inside a
    // package. Trying the own directory for a packaged file drew twelve false
    // edges in flask alone: `import typing as t` in eleven files landed on
    // src/flask/typing.py, and `import json` in config.py on
    // src/flask/json/__init__.py. And for a script, the own directory comes
    // FIRST, not last: two exercise directories that each hold a `utils.py`
    // resolved to whichever one a foreign root happened to reach.
    const segments = module.split('.');
    const own = path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from);
    const insidePackage = files.has(own === '' ? '__init__.py' : `${own}/__init__.py`);
    const roots = insidePackage ? rootsOf(files) : [own, ...rootsOf(files)];
    for (const root of roots) {
      const hit = at(path.posix.join(root, ...segments), false);
      if (hit !== null) return hit;
    }
    return null;
  },
} satisfies LanguageSupport;

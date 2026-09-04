import { createRequire } from 'node:module';
import path from 'node:path';

import type { ImportBinding, ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// A grammar is a native addon, reachable from ESM only through createRequire.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * tree-sitter-c-sharp is the one grammar shipped as pure ESM, and its entry
 * point awaits at the top level, so `require` refuses it outright with
 * ERR_REQUIRE_ASYNC_MODULE — while `grammar()` is synchronous and has no
 * `await import` to fall back on.
 *
 * Nothing that entry point does is asynchronous underneath: it finds the
 * prebuilt addon, loads it, and attaches the node-type table the binding needs
 * to name nodes. Doing those two steps here is the package's own loader without
 * the `await`, not a reach past its API. `node-gyp-build` is resolved from
 * inside the package, which depends on it, so this needs no hoisting and adds
 * no dependency of ours.
 */
function loadGrammar(): unknown {
  const root = path.dirname(require.resolve('tree-sitter-c-sharp/package.json'));
  const inPackage = createRequire(path.join(root, 'package.json'));
  const build = inPackage('node-gyp-build') as (directory: string) => Record<string, unknown>;
  const binding = build(root);
  binding.nodeTypeInfo = inPackage('./src/node-types.json');
  return binding;
}

/** A type expression reduced to the one bare name an edge can be drawn to. */
function bareTypeName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
      return node.text;
    case 'qualified_name':
      return bareTypeName(node.childForFieldName('name'));
    case 'generic_name':
      // This node carries no fields: `List<T>` is an identifier followed by a
      // type_argument_list, and the identifier is the type being named.
      return bareTypeName(node.namedChildren[0] ?? null);
    case 'nullable_type':
    case 'array_type':
    case 'pointer_type':
    case 'ref_type':
    case 'scoped_type':
      return bareTypeName(node.childForFieldName('type'));
    case 'primary_constructor_base_type':
      return bareTypeName(node.namedChildren[0] ?? null);
    default:
      return null;
  }
}

/**
 * Every type a type expression mentions, so `Func<LogEvent, bool>` reports the
 * delegate and its argument rather than only the outermost name.
 */
function collectTypeNames(node: SyntaxNode, out: Set<string>): void {
  switch (node.type) {
    // Keywords rather than references: `int`, `string`, `void`, `var`.
    case 'predefined_type':
    case 'implicit_type':
      return;
    case 'identifier':
      out.add(node.text);
      return;
    case 'qualified_name': {
      const tail = node.childForFieldName('name');
      if (!tail) return;
      // `Serilog.Events.LogEvent` is kept whole: the namespace written in front
      // of the name is the evidence resolve() uses to choose between two files
      // that share it. A generic tail has to be taken apart instead.
      if (tail.type === 'generic_name') collectTypeNames(tail, out);
      else out.add(node.text);
      return;
    }
    default:
      for (const child of node.namedChildren) collectTypeNames(child, out);
  }
}

/** `Serilog.Log` for a chain of plain identifiers, null for anything else. */
function dottedName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type !== 'member_access_expression') return null;

  const name = node.childForFieldName('name');
  if (name?.type !== 'identifier') return null;
  const qualifier = dottedName(node.childForFieldName('expression'));
  return qualifier === null ? null : `${qualifier}.${name.text}`;
}

/**
 * The type a member access reads from — `Guard` in `Guard.AgainstNull(x)`,
 * `LogEventLevel` in `LogEventLevel.Debug`.
 *
 * An expression is the one place C# names a type without the grammar saying so,
 * and the capital is what separates the two cases: .NET names types and
 * namespaces in Pascal case, and locals, parameters and fields in camel case or
 * with a leading underscore. So `Serilog.Log` qualifies and `logger.Write(…)`
 * does not — and neither does `kvp.Value`, which is why *every* segment has to
 * carry the capital and not only the last.
 */
function typeQualifier(access: SyntaxNode): string | null {
  const dotted = dottedName(access.childForFieldName('expression'));
  if (dotted === null) return null;
  return dotted.split('.').every((segment) => /^[A-Z]/.test(segment)) ? dotted : null;
}

/**
 * Nodes whose named children are all types. Everything else that names one does
 * it through a `type` or `returns` field, which the sweep reads directly.
 */
const TYPE_LISTS = new Set(['base_list', 'type_argument_list', 'explicit_interface_specifier']);

/**
 * Every type the file names, which is what a C# file's dependencies actually
 * are. See resolve() for why the `using` directives are not this list.
 *
 * `aliases` are the names `using X = …` binds locally. They read as references
 * to a type called X and are not: the thing they name is the right-hand side,
 * which the directive contributes under its real name. Serilog writes
 * `using File = System.IO.File`, and a project holding a `File.cs` would
 * otherwise gain an edge to it from every mention.
 */
function collectReferences(root: SyntaxNode, aliases: readonly string[]): string[] {
  const names = new Set<string>();
  /** `T` in `class C<T>` is a placeholder being declared, not a reference. */
  const placeholders = new Set<string>();

  const pending: SyntaxNode[] = [root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    for (const child of node.namedChildren) pending.push(child);

    switch (node.type) {
      case 'using_directive': {
        // `using static X.Y.Type` and `using Alias = X.Y.Type` name one type;
        // the alias form marks itself by carrying a `name` field of its own. A
        // plain `using X.Y` names a namespace and is deliberately dropped.
        const aliased = node.childForFieldName('name') !== null;
        const isStatic = node.children.some((child) => child.type === 'static');
        if (!aliased && !isStatic) break;
        // Whichever form, what is being named is the last thing written.
        const target = node.namedChildren[node.namedChildren.length - 1];
        if (target) collectTypeNames(target, names);
        break;
      }
      case 'type_parameter': {
        const name = node.childForFieldName('name');
        if (name) placeholders.add(name.text);
        break;
      }
      case 'attribute': {
        const name = node.childForFieldName('name');
        if (name) collectTypeNames(name, names);
        break;
      }
      case 'member_access_expression': {
        const qualifier = typeQualifier(node);
        if (qualifier !== null) names.add(qualifier);
        break;
      }
      default: {
        if (TYPE_LISTS.has(node.type)) {
          for (const child of node.namedChildren) collectTypeNames(child, names);
          break;
        }
        const declared = node.childForFieldName('type') ?? node.childForFieldName('returns');
        if (declared) collectTypeNames(declared, names);
      }
    }
  }

  for (const placeholder of placeholders) names.delete(placeholder);
  for (const alias of aliases) names.delete(alias);
  return [...names];
}

/** `using File = System.IO.File` — a name this file writes, and what it stands for. */
interface Alias {
  local: string;
  /** The right-hand side, written out in full, as `imports` also carries it. */
  target: string;
}

/**
 * What the `using` directives say, which is not a list of dependencies but the
 * evidence resolve() needs to decide whether a bare name could have meant a
 * given file at all.
 */
interface Directives {
  /** Every namespace the file's own directives can be naming. */
  usings: string[];
  /** Namespaces a `global using` names — those reach the whole compilation. */
  globals: string[];
  /** Names bound locally by `using X = …`. */
  aliases: Alias[];
}

function usingDirectives(root: SyntaxNode): Directives {
  const usings: string[] = [];
  const globals: string[] = [];
  const aliases: Alias[] = [];

  const visit = (nodes: readonly SyntaxNode[], enclosing: string): void => {
    let current = enclosing;
    const join = (name: SyntaxNode | null): string =>
      name === null ? current : current === '' ? name.text : `${current}.${name.text}`;

    for (const node of nodes) {
      // The file-scoped form puts everything after it, usings included, inside it.
      if (node.type === 'file_scoped_namespace_declaration') {
        current = join(node.childForFieldName('name'));
        continue;
      }
      if (node.type === 'namespace_declaration') {
        const body = node.childForFieldName('body');
        if (body) visit(body.namedChildren, join(node.childForFieldName('name')));
        continue;
      }
      if (CONDITIONAL.has(node.type)) {
        visit(node.namedChildren, current);
        continue;
      }
      if (node.type !== 'using_directive') continue;

      // The alias form is the one that carries a `name` field of its own.
      const alias = node.childForFieldName('name');
      if (alias !== null) {
        // What it stands for is the last thing written, and it is the name the
        // *other* file declares — `using File = System.IO.File` is one name
        // here and another there.
        const target = node.namedChildren[node.namedChildren.length - 1];
        if (target !== undefined && target !== alias) aliases.push({ local: alias.text, target: target.text });
        continue;
      }
      // `using static X.Y.T` names a type and brings its members into scope. The
      // namespace it was reached through stays unreachable, so it is not one of
      // these — collectReferences takes the type instead.
      if (node.children.some((child) => child.type === 'static')) continue;
      // Whichever form, what is being named is the last thing written.
      const target = node.namedChildren[node.namedChildren.length - 1];
      if (!target) continue;
      // A `global using` is only legal at the top of a compilation unit, so it
      // names exactly what it says.
      if (node.children.some((child) => child.type === 'global')) {
        globals.push(target.text);
        continue;
      }
      // A using written *inside* a namespace is read against it and against
      // every namespace enclosing it, so `using Events;` inside
      // `namespace Serilog` names `Serilog.Events`. One written at the top of
      // the file has no enclosing namespace and names only itself — expanding
      // that one against the namespace the file happens to declare would let it
      // reach somewhere it never named.
      usings.push(target.text, ...scopesOf(current).map((scope) => `${scope}.${target.text}`));
    }
  };

  visit(root.namedChildren, '');
  return { usings, globals, aliases };
}

/**
 * A struct and a record are classes here: both hold state and declare
 * operations on it, which is what a UML class box shows and what an association
 * can point at. An enum and a delegate are not — an enum has no operations, a
 * delegate has no instances to associate with — so both are 'type', the kind
 * that already means "a named thing the type system knows about".
 */
const TYPE_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['struct_declaration', 'class'],
  // `record struct` too: the grammar has one node for both.
  ['record_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['enum_declaration', 'type'],
  ['delegate_declaration', 'type'],
]);

/** `#if` keeps declaring; which arm the build takes is a flag we never see. */
const CONDITIONAL = new Set(['preproc_if', 'preproc_elif', 'preproc_else', 'preproc_region']);

const INTERFACE_NAME = /^I[A-Z]/;

/**
 * C# writes the base class and the interfaces as one list, base class first,
 * with nothing in the syntax telling them apart — the compiler knows which is
 * which by looking the names up, and this layer cannot look anything up.
 *
 * What it can use is the one rule .NET holds to without exception: an interface
 * is named `IPascalCase`. So the head of the list is the base class unless it is
 * named like an interface, and everything after it is an interface, which the
 * language guarantees regardless. An interface's own list is all interfaces, and
 * they are generalisations of it, so they read as `extends`.
 */
function heritageOf(declaration: SyntaxNode, kind: SymbolKind): Pick<ParsedSymbol, 'extends' | 'implements'> {
  const list = declaration.namedChildren.find((child) => child.type === 'base_list');
  if (!list) return { extends: [], implements: [] };

  const entries: string[] = [];
  for (const entry of list.namedChildren) {
    const name = bareTypeName(entry);
    if (name !== null) entries.push(name);
  }

  const [first, ...rest] = entries;
  if (first === undefined) return { extends: [], implements: [] };
  if (kind === 'interface') return { extends: entries, implements: [] };
  return INTERFACE_NAME.test(first)
    ? { extends: [], implements: entries }
    : { extends: [first], implements: rest };
}

/**
 * UML's three, read off the declaration rather than inferred.
 *
 * `internal` is C#'s default for a type and has no equivalent among the three
 * the model carries, so it is recorded the way an unwritten modifier is: as
 * nothing. The rule is the same one TypeScript's implicit `public` follows —
 * report what the source wrote, infer nothing.
 */
function modifiersOf(declaration: SyntaxNode): Pick<ParsedSymbol, 'visibility' | 'isStatic' | 'isAbstract'> {
  let visibility: ParsedSymbol['visibility'];
  let isStatic = false;
  let isAbstract = false;

  for (const child of declaration.namedChildren) {
    if (child.type !== 'modifier') continue;
    const text = child.text;
    if (text === 'static') isStatic = true;
    else if (text === 'abstract') isAbstract = true;
    // `private protected` is written as two modifiers, and the first is the
    // one that actually narrows the access.
    else if (visibility === undefined && (text === 'public' || text === 'private' || text === 'protected')) {
      visibility = text;
    }
  }

  return {
    ...(visibility === undefined ? {} : { visibility }),
    ...(isStatic ? { isStatic: true } : {}),
    ...(isAbstract ? { isAbstract: true } : {}),
  };
}

/**
 * Collections that stand for many of their element rather than for themselves,
 * so the association can carry 1..*. Single-parameter ones only: `Dictionary`
 * has two, and which of them a UML association would point at is a question the
 * declaration does not answer.
 */
const MANY = new Set([
  'Array', 'IEnumerable', 'ICollection', 'IReadOnlyCollection', 'IList', 'IReadOnlyList',
  'List', 'HashSet', 'ISet', 'Queue', 'Stack', 'Span', 'ReadOnlySpan', 'Memory',
  'ReadOnlyMemory', 'ImmutableArray', 'ImmutableList', 'ImmutableHashSet',
]);

/** The declared type of a field or property, reduced to one name and a count. */
function declaredType(node: SyntaxNode | null): Pick<ParsedSymbol, 'typeName' | 'many'> {
  if (!node) return {};

  if (node.type === 'nullable_type') return declaredType(node.childForFieldName('type'));
  if (node.type === 'array_type') {
    const name = bareTypeName(node.childForFieldName('type'));
    return name === null ? { many: true } : { typeName: name, many: true };
  }
  if (node.type === 'generic_name') {
    const base = bareTypeName(node.namedChildren[0] ?? null);
    if (base !== null && MANY.has(base)) {
      const args = node.namedChildren.find((child) => child.type === 'type_argument_list');
      const inner = bareTypeName(args?.namedChildren[0] ?? null);
      return inner === null ? { many: true } : { typeName: inner, many: true };
    }
    return base === null ? {} : { typeName: base };
  }

  const name = bareTypeName(node);
  return name === null ? {} : { typeName: name };
}

/**
 * Every type invoked or constructed inside a symbol.
 *
 * `exclude` holds subtrees that are symbols in their own right, so the
 * enclosing type does not also claim what its methods call and the drawn edge
 * does not weigh twice what the code does.
 *
 * A bare `Foo()` is left out: C# has no free functions, so it is always a call
 * on `this`, and the method name alone would resolve against every class in
 * scope that happens to declare one.
 */
function collectCalls(declaration: SyntaxNode, exclude: readonly SyntaxNode[] = []): string[] {
  const names = new Set<string>();
  const inside = (node: SyntaxNode): boolean =>
    exclude.some((skip) => node.startIndex >= skip.startIndex && node.endIndex <= skip.endIndex);

  for (const creation of declaration.descendantsOfType('object_creation_expression')) {
    if (inside(creation)) continue;
    const name = bareTypeName(creation.childForFieldName('type'));
    if (name) names.add(name);
  }
  for (const call of declaration.descendantsOfType('invocation_expression')) {
    if (inside(call)) continue;
    const target = call.childForFieldName('function');
    if (target?.type !== 'member_access_expression') continue;
    const qualifier = typeQualifier(target);
    if (qualifier === null) continue;
    names.add(qualifier.slice(qualifier.lastIndexOf('.') + 1));
  }

  return [...names];
}

interface Member {
  name: string;
  kind: 'method' | 'field';
  /** The declared type, for the members that have one. */
  type: SyntaxNode | null;
}

/** One declaration inside a type body, or null when it declares no named member. */
function memberOf(node: SyntaxNode): Member | null {
  switch (node.type) {
    case 'method_declaration':
    case 'constructor_declaration':
    case 'destructor_declaration': {
      const name = node.childForFieldName('name');
      return name === null ? null : { name: name.text, kind: 'method', type: null };
    }
    case 'operator_declaration': {
      // The name is the symbol itself, so an indexer and a conversion operator,
      // which have no name node at all, are the two members left undrawn.
      const operator = node.childForFieldName('operator');
      return operator === null ? null : { name: `operator${operator.text}`, kind: 'method', type: null };
    }
    // A property is an attribute, not an operation: `LogEventLevel Level { get; }`
    // is how "every LogEvent has a level" is spelled, and that association is the
    // one relationship a C# type declaration hands over for free. Drawing it as
    // an operation would throw the association away to gain nothing.
    case 'property_declaration':
    case 'event_declaration': {
      const name = node.childForFieldName('name');
      return name === null
        ? null
        : { name: name.text, kind: 'field', type: node.childForFieldName('type') };
    }
    default:
      return null;
  }
}

/**
 * The members of one type, as symbols of their own.
 *
 * Returns the subtrees the enclosing type must not claim the calls of: its
 * operations, and any type nested inside it.
 */
function collectMembers(
  body: SyntaxNode,
  owner: string,
  symbols: ParsedSymbol[],
  nested: SyntaxNode[],
): SyntaxNode[] {
  const claimed: SyntaxNode[] = [];
  const fields: ParsedSymbol[] = [];
  const methods: ParsedSymbol[] = [];

  const visit = (container: SyntaxNode): void => {
    for (const node of container.namedChildren) {
      if (CONDITIONAL.has(node.type)) {
        visit(node);
        continue;
      }
      if (TYPE_KINDS.has(node.type)) {
        nested.push(node);
        claimed.push(node);
        continue;
      }

      const common = {
        owner,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        extends: [],
        implements: [],
        calls: collectCalls(node),
        ...modifiersOf(node),
      };

      // A field declaration can name several: `int a, b;` is two attributes
      // sharing one type.
      if (node.type === 'field_declaration' || node.type === 'event_field_declaration') {
        const declaration = node.namedChildren.find((child) => child.type === 'variable_declaration');
        if (!declaration) continue;
        const type = declaredType(declaration.childForFieldName('type'));
        for (const declarator of declaration.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const name = declarator.childForFieldName('name');
          if (name) fields.push({ ...common, name: name.text, kind: 'field', ...type });
        }
        continue;
      }

      const member = memberOf(node);
      if (!member) continue;
      if (member.kind === 'method') {
        claimed.push(node);
        methods.push({ ...common, name: member.name, kind: 'method' });
      } else {
        fields.push({ ...common, name: member.name, kind: 'field', ...declaredType(member.type) });
      }
    }
  };

  visit(body);

  // Attributes before operations, the order a UML class box reads in.
  symbols.push(...fields, ...methods);
  return claimed;
}

/** A record's positional parameters are its public attributes, and often its only ones. */
function collectRecordParameters(declaration: SyntaxNode, owner: string, symbols: ParsedSymbol[]): void {
  const parameters = declaration.namedChildren.find((child) => child.type === 'parameter_list');
  if (!parameters) return;

  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== 'parameter') continue;
    const name = parameter.childForFieldName('name');
    if (!name) continue;
    symbols.push({
      name: name.text,
      kind: 'field',
      owner,
      startLine: parameter.startPosition.row + 1,
      endLine: parameter.endPosition.row + 1,
      extends: [],
      implements: [],
      calls: [],
      ...declaredType(parameter.childForFieldName('type')),
    });
  }
}

/**
 * One top-level declaration and everything it contains.
 *
 * A nested type becomes a top-level symbol with no owner rather than a member of
 * the type around it. The store keys owners by class and keeps an owned symbol
 * out of the file's name table, so owning a nested type would cost every
 * reference to it — the same trade TypeScript's namespaces make.
 */
function collectDeclaration(node: SyntaxNode, symbols: ParsedSymbol[]): void {
  if (node.type === 'namespace_declaration') {
    // The file-scoped form declares nothing itself: what follows `namespace X;`
    // is a sibling of it, so the top-level walk already reaches it.
    const body = node.childForFieldName('body');
    if (body) for (const child of body.namedChildren) collectDeclaration(child, symbols);
    return;
  }
  if (CONDITIONAL.has(node.type)) {
    for (const child of node.namedChildren) collectDeclaration(child, symbols);
    return;
  }

  const kind = TYPE_KINDS.get(node.type);
  if (kind === undefined) return;
  const name = node.childForFieldName('name');
  if (!name) return;

  const members: ParsedSymbol[] = [];
  const nested: SyntaxNode[] = [];
  // Before the body, so the positional attributes lead the attribute list.
  if (node.type === 'record_declaration') collectRecordParameters(node, name.text, members);
  const body = node.childForFieldName('body');
  const claimed = body ? collectMembers(body, name.text, members, nested) : [];

  // The type is pushed before its members, which is the order the graph layer
  // attaches each one to the type it just saw.
  symbols.push({
    name: name.text,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    ...heritageOf(node, kind),
    calls: collectCalls(node, claimed),
    ...modifiersOf(node),
  });
  symbols.push(...members);
  for (const child of nested) collectDeclaration(child, symbols);
}

/**
 * Every scope the file declares its types in; '' is the global namespace.
 *
 * A set rather than one answer, because more than one is ordinary C# rather
 * than a corner case, and the three forms all have to land in it: a block
 * `namespace X { }`, a file-scoped `namespace X;`, and nesting, where the inner
 * name is read against the outer one. Serilog's `Guard.cs` opens with a block
 * `namespace JetBrains.Annotations` holding a one-line attribute and then
 * declares `Guard` itself at global scope — the first `namespace` in the file
 * is one that `Guard` is not in, and `Guard` is referenced 54 times.
 */
function declaredScopes(root: SyntaxNode): string[] {
  /** The scope each type is declared in; '' is the global namespace. */
  const scopes = new Set<string>();
  const declared = new Set<string>();

  const visit = (nodes: readonly SyntaxNode[], enclosing: string): void => {
    let current = enclosing;
    const join = (name: SyntaxNode | null): string =>
      name === null ? current : current === '' ? name.text : `${current}.${name.text}`;

    for (const node of nodes) {
      if (node.type === 'file_scoped_namespace_declaration') {
        // It declares nothing itself: everything after it in the file is inside it.
        current = join(node.childForFieldName('name'));
        declared.add(current);
        continue;
      }
      if (node.type === 'namespace_declaration') {
        const body = node.childForFieldName('body');
        const name = join(node.childForFieldName('name'));
        declared.add(name);
        if (body) visit(body.namedChildren, name);
        continue;
      }
      if (CONDITIONAL.has(node.type)) visit(node.namedChildren, current);
      else if (TYPE_KINDS.has(node.type)) scopes.add(current);
    }
  };

  visit(root.namedChildren, '');

  // A file that declares no type at all still has a namespace context, which is
  // read whenever it is the referencing side of a partly qualified name.
  const found = scopes.size === 0 ? declared : scopes;
  return found.size === 0 ? [''] : [...found];
}

/**
 * The one namespace a file belongs to, for the `modules` table every language
 * shares. Absent unless there is exactly one and it is not the global namespace:
 * a wrong entry there is worse than no entry, and C#'s own resolution reads the
 * whole set out of the file's references instead.
 */
function soleNamespace(scopes: readonly string[]): string | null {
  const [only] = scopes;
  return scopes.length === 1 && only !== undefined && only !== '' ? only : null;
}

/** The last identifier of a dotted name, which is the type it ends on. */
function tailOf(reference: string): string {
  return reference.slice(reference.lastIndexOf('.') + 1);
}

/**
 * Every name this file can write, and the reference each one stands for.
 *
 * C# writes no path and no file name: `LogEvent` is the whole of what the
 * source says, and resolve() answers it by asking which namespaces this file
 * could have been reading it against. A binding carries that answer down to the
 * graph, which otherwise reads a bare name out of whichever imported file
 * happens to export one, in import order — 1,270 of Serilog's 4,411 edges were
 * drawn that way, and marked `guessed` because nothing in the file had said so.
 *
 * The list can claim to be every name the file reaches, which is what makes the
 * graph right to refuse anything not in it. It is the same sweep the references
 * came from, and everything downstream reduces a type expression the same way:
 * `heritageOf`, `declaredType` and `collectCalls` all end on the last
 * identifier, which is the tail of what collectReferences recorded whole.
 */
function bindings(references: readonly string[], aliases: readonly Alias[]): ImportBinding[] {
  const bound = references.map((reference) => ({
    local: tailOf(reference),
    specifier: reference,
    imported: tailOf(reference),
  }));
  // An alias is the one place the name written here and the name declared there
  // are different, so it cannot be read off the reference.
  for (const { local, target } of aliases) {
    bound.push({ local, specifier: target, imported: tailOf(target) });
  }
  return bound;
}

/** A namespace and every namespace enclosing it, innermost first. */
function scopesOf(namespace: string): string[] {
  if (namespace === '') return [];
  const parts = namespace.split('.');
  return parts.map((_, index) => parts.slice(0, parts.length - index).join('.'));
}

/**
 * The three facts a C# file states that are not references to another file, and
 * the tags they travel under.
 *
 * They ride in `imports` because that is the only channel a parsed file has to
 * the resolver, which is where they are needed — Go writes its same-package
 * references the same way. A C# namespace or type name is dotted identifiers,
 * so nothing a project can write is mistaken for one of these.
 */
const DECLARES = 'namespace:';
const USES = 'using:';
const GLOBAL = 'global:';

const TAGGED = /^(?:namespace|using|global):/;

/**
 * The namespaces the .NET SDK puts in scope in every file when `ImplicitUsings`
 * is on, which it is by default from .NET 6 and is in Serilog's
 * `Directory.Build.props`.
 *
 * They appear in no source file, so without them a project that polyfills a BCL
 * type loses every edge to it: Serilog declares `TimeProvider` in
 * `namespace System` for the target frameworks that lack one. Assuming the
 * feature on can only matter for a candidate that declares a type in one of
 * these namespaces, which in a project's own sources means a polyfill and
 * nothing else — the .csproj that would say so is not read here.
 */
const IMPLICIT: readonly string[] = [
  'System',
  'System.Collections.Generic',
  'System.IO',
  'System.Linq',
  'System.Net.Http',
  'System.Threading',
  'System.Threading.Tasks',
];

/**
 * What the project's C# files declare and what each of them can name, read back
 * out of the tagged directives extract() left among their references.
 *
 * Cached against the reference table, which the store builds once per
 * derivation and hands to every resolve call.
 */
interface Project {
  /** file -> the namespaces it declares types in. */
  scopes: Map<string, readonly string[]>;
  /** file -> every namespace its own `using` directives can be naming. */
  usings: Map<string, readonly string[]>;
  /** A `global using` reaches every file under the directory that wrote it. */
  globals: { under: string; namespace: string }[];
  /** file -> every namespace a bare name in it may bind against. Filled lazily. */
  reachable: Map<string, ReadonlySet<string>>;
}

const projects = new WeakMap<ReadonlyMap<string, readonly string[]>, Project>();

function projectFor(imports: ReadonlyMap<string, readonly string[]>): Project {
  const cached = projects.get(imports);
  if (cached) return cached;

  const project: Project = { scopes: new Map(), usings: new Map(), globals: [], reachable: new Map() };
  for (const [file, references] of imports) {
    if (!file.endsWith('.cs')) continue;
    const scopes: string[] = [];
    const usings: string[] = [];
    for (const reference of references) {
      if (reference.startsWith(DECLARES)) scopes.push(reference.slice(DECLARES.length));
      else if (reference.startsWith(USES)) usings.push(reference.slice(USES.length));
      else if (reference.startsWith(GLOBAL)) {
        // A `global using` belongs to a compilation, and the compilation a file
        // is in is not written anywhere the graph reads — a .csproj lists files
        // rather than naming them. Its directory is the honest approximation:
        // the default compile glob is every .cs file beneath the .csproj, and
        // `GlobalUsings.cs` sits at its root. Scoping it too narrowly costs an
        // edge; pooling every project's globals would let a test file's usings
        // decide what a library file can name.
        const directory = path.posix.dirname(file);
        project.globals.push({
          under: directory === '.' ? '' : directory,
          namespace: reference.slice(GLOBAL.length),
        });
      }
    }
    project.scopes.set(file, scopes);
    project.usings.set(file, usings);
  }

  projects.set(imports, project);
  return project;
}

/**
 * Every namespace a bare name written in this file may bind against.
 *
 * This is the check the whole language turns on: 1,891 of Serilog's 1,929
 * references are bare, and without it any project type named `Task`, `Logger`
 * or `Options` becomes a hub that everything appears to depend on.
 *
 * C# binds a bare name by walking the enclosing namespaces and then the `using`
 * directives, and the global namespace is always among them — a type declared
 * outside any namespace needs no directive to be seen. Enclosing scopes alone
 * are not enough to check against: Serilog's library sources carry no usings at
 * all, 25 `global using` lines in one file serve all of them, and refusing what
 * those reach would throw away 681 correct answers.
 */
function reachableFrom(project: Project, from: string): ReadonlySet<string> {
  const cached = project.reachable.get(from);
  if (cached) return cached;

  const enclosing = new Set<string>();
  for (const namespace of project.scopes.get(from) ?? []) {
    for (const scope of scopesOf(namespace)) enclosing.add(scope);
  }

  const reachable = new Set<string>([
    '',
    ...enclosing,
    ...IMPLICIT,
    ...(project.usings.get(from) ?? []),
  ]);
  for (const global of project.globals) {
    if (global.under === '' || from.startsWith(`${global.under}/`)) reachable.add(global.namespace);
  }

  project.reachable.set(from, reachable);
  return reachable;
}

/**
 * The namespaces a partly written one can stand for, from where it was written.
 *
 * C# reads `Events.LogEvent` against each enclosing namespace in turn, so inside
 * `namespace Serilog` it means `Serilog.Events.LogEvent` and nothing else.
 * Accepting any namespace that merely *ends* in `.Events` would let a file reach
 * one it cannot name. The `using` directives are deliberately not consulted:
 * a using imports the types of a namespace, not its nested namespaces.
 */
function qualifiedBy(project: Project, from: string, qualifier: string): ReadonlySet<string> {
  const wanted = new Set([qualifier]);
  for (const namespace of project.scopes.get(from) ?? []) {
    for (const scope of scopesOf(namespace)) wanted.add(`${scope}.${qualifier}`);
  }
  return wanted;
}

/**
 * Type name -> the files named after it. Half the strategy; the namespace check
 * in resolve() is the other half, and neither is any good alone.
 *
 * A `using Serilog.Events` names a *namespace*, and a namespace is many files:
 * resolving it means either picking one arbitrarily or drawing an edge to every
 * file in it, and the second turns one directory into fifty edges out of a
 * single box. Serilog makes the point sharper than most — its usings live in one
 * `GlobalUsings.cs`, so namespace edges would make that file the hub of the
 * entire project while saying nothing about who uses what. What a file actually
 * depends on is the *types* it names.
 *
 * **The file name, and not what the file declares.** `declarations` would find
 * a type in a file not named after it — 59 references on Serilog, and 7 of them
 * a real cross-file edge this misses. It is refused anyway, because C#'s
 * convention of one file per public type is what makes the index trustworthy:
 * indexing declarations promotes every private nested helper into a
 * project-wide candidate, and they are named `Value`, `Enumerator`, `Handler`,
 * `BaseClass`. Two files in one namespace are always mutually reachable, so the
 * namespace check cannot catch that class of mistake — it would put back
 * exactly the hub this change removes, for 7 edges.
 *
 * Cached against the file set, which the store builds once per derivation and
 * hands to every resolve call. Without that, a project of any size would
 * rebuild this table once per reference.
 */
const indexes = new WeakMap<ReadonlySet<string>, ReadonlyMap<string, readonly string[]>>();

function indexFor(files: ReadonlySet<string>): ReadonlyMap<string, readonly string[]> {
  const cached = indexes.get(files);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith('.cs')) continue;
    const name = path.posix.basename(file, '.cs');
    const bucket = index.get(name);
    if (bucket) bucket.push(file);
    else index.set(name, [file]);
  }

  indexes.set(files, index);
  return index;
}

/** How many leading directories two paths share. */
function sharedDepth(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * Two files named after the same type, and a reference that did not say which.
 *
 * The nearest wins: the same namespace first, then the longest shared directory.
 * If nothing separates them, neither is chosen — a missing edge is a gap, a
 * wrong one is a lie.
 */
function nearest(from: string, candidates: readonly string[], project: Project): string | null {
  const own = new Set(project.scopes.get(from) ?? []);
  if (own.size > 0) {
    const same = candidates.filter((file) =>
      (project.scopes.get(file) ?? []).some((namespace) => own.has(namespace)),
    );
    if (same.length === 1) return same[0] ?? null;
  }

  const fromDirectories = path.posix.dirname(from).split('/');
  let best: string | null = null;
  let bestDepth = -1;
  let tied = false;

  for (const file of candidates) {
    const depth = sharedDepth(fromDirectories, path.posix.dirname(file).split('/'));
    if (depth > bestDepth) {
      bestDepth = depth;
      best = file;
      tied = false;
    } else if (depth === bestDepth) tied = true;
  }

  return tied ? null : best;
}

export const csharp: LanguageSupport = {
  id: 'csharp',
  label: 'C#',
  extensions: ['.cs'],

  grammar(_filePath: string) {
    loaded ??= loadGrammar();
    return loaded;
  },

  extract(root: SyntaxNode, _source: string): LanguageParse {
    const symbols: ParsedSymbol[] = [];
    for (const child of root.namedChildren) collectDeclaration(child, symbols);

    const scopes = declaredScopes(root);
    const directives = usingDirectives(root);
    const moduleName = soleNamespace(scopes);
    const references = collectReferences(
      root,
      directives.aliases.map((alias) => alias.local),
    );

    return {
      imports: [
        ...references,
        // Not references, and never edges. See DECLARES: they ride here because
        // this is the only thing a parsed file hands the resolver, and a bare
        // name cannot be checked without them.
        ...scopes.map((scope) => DECLARES + scope),
        ...directives.usings.map((namespace) => USES + namespace),
        ...directives.globals.map((namespace) => GLOBAL + namespace),
      ],
      symbols,
      bindings: bindings(references, directives.aliases),
      ...(moduleName === null ? {} : { moduleName }),
    };
  },

  /**
   * A type name, sometimes with the namespace it was written under, to the file
   * that declares it.
   *
   * The namespace is evidence, and both forms of reference are held to it: a
   * candidate is only an answer if the file could actually have named it that
   * way. `System.Text.StringBuilder` cannot land on a project file called
   * StringBuilder.cs, and a bare `Timer` cannot land on a project `Timer.cs`
   * whose namespace this file never brought into scope.
   *
   * Holding only the qualified form to it was the bug this replaces. That form
   * is 38 of Serilog's 1,929 references; the other 1,891 went through on a
   * basename match alone, which is what makes a project type sharing a name
   * with a framework one into a hub everything appears to depend on.
   */
  resolve(context: ResolveContext): string | null {
    const { from, specifier, files } = context;
    // A directive is a fact about the file, never an edge out of it. Resolving
    // one would draw the whole of `using Serilog.Events` as a dependency on
    // whichever file happens to be called Events.cs.
    if (TAGGED.test(specifier)) return null;

    const project = projectFor(context.imports);
    const dot = specifier.lastIndexOf('.');
    const candidates = indexFor(files).get(specifier.slice(dot + 1));
    if (!candidates) return null;

    const wanted =
      dot < 0 ? reachableFrom(project, from) : qualifiedBy(project, from, specifier.slice(0, dot));
    const matching = candidates.filter((file) =>
      (project.scopes.get(file) ?? []).some((namespace) => wanted.has(namespace)),
    );

    if (matching.length === 0) return null;
    return matching.length === 1 ? matching[0] ?? null : nearest(from, matching, project);
  },
};

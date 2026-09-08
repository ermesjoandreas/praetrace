import { createRequire } from 'node:module';

import type { ImportBinding, ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageId, LanguageParse, LanguageSupport, ProjectFacts, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * What a PHP type declaration is, in UML's four boxes.
 *
 * A trait is a class box, and that is the decision worth writing down. It
 * holds state and method bodies, which is what a class box shows and what an
 * interface box cannot; `interface` would say it is a contract, and a trait
 * is the opposite of a contract — it is the implementation somebody else's
 * contract gets satisfied with. An enum is a class for the reason java.ts
 * gives: its cases are its instances, it declares methods, and it implements
 * interfaces.
 */
const TYPE_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['trait_declaration', 'class'],
  ['enum_declaration', 'class'],
]);

/**
 * The names that are a `named_type` in the grammar and name nothing in the
 * project. `self`, `static` and `parent` are the enclosing class said three
 * ways, and are answered where the enclosing class is known rather than here;
 * the rest are the language's own types, which the grammar files under
 * `named_type` instead of `primitive_type` for reasons of its own. Compared
 * lower-case because PHP's type names are case-insensitive.
 */
const RESERVED_TYPES = new Set(['self', 'static', 'parent', 'never', 'void', 'mixed', 'object', 'iterable', 'callable', 'null', 'true', 'false']);

/** PHP's namespace separator, which is also an escape in every string this file writes. */
const SEPARATOR = '\\';

/**
 * Separates the fully qualified names one reference could mean, in the order
 * PHP tries them — see `referenceFor`. Java's constant and Java's reason: one
 * reference is one edge, so offering the candidates as separate specifiers
 * would draw two edges for a name the language binds exactly once. A PHP name
 * cannot hold this character.
 */
const CANDIDATES = '|';

/**
 * The text of a class name, exactly as the file wrote it, or null.
 *
 * Three node types and one string, because the text is the key: a binding is
 * filed under what the file wrote, so `Thing`, `\App\Deep\Thing` and
 * `namespace\Thing` are three different keys that may resolve to one file, and
 * none of them can be mistaken for another. `relative_name` is the `namespace`
 * operator, which `referenceFor` reads by its head like any other.
 */
function writtenName(node: SyntaxNode | null): string | null {
  if (!node) return null;
  return node.type === 'name' || node.type === 'qualified_name' || node.type === 'relative_name'
    ? node.text
    : null;
}

/** The last segment of a qualified name: the `User` of `\App\Models\User`. */
function tailOf(name: string): string {
  return name.slice(name.lastIndexOf(SEPARATOR) + 1);
}

/**
 * The one class a type declaration names, or null where it names none or two.
 *
 * `?Profile` and `Profile|null` are one Profile that may be absent — the
 * association's 0..1 — while `Profile|Team` is neither, and an intersection
 * is a shape no single box stands for. A primitive is not a name the project
 * can hold.
 */
function typeNameOf(node: SyntaxNode | null): { typeName?: string; optional?: true } {
  if (!node) return {};
  switch (node.type) {
    case 'named_type': {
      const name = writtenName(node.namedChildren[0] ?? null);
      return name === null || RESERVED_TYPES.has(name.toLowerCase()) ? {} : { typeName: name };
    }
    case 'optional_type': {
      const inner = typeNameOf(node.namedChildren[0] ?? null);
      return { ...inner, optional: true };
    }
    case 'union_type': {
      // `A|null` is an A that may be missing; `A|B` is a name this file cannot
      // reduce to one box, and saying nothing is the cheaper mistake.
      const members = node.namedChildren.filter((child) => child.type !== 'primitive_type' || child.text.toLowerCase() !== 'null');
      const nullable = members.length !== node.namedChildren.length;
      if (members.length !== 1) return nullable ? { optional: true } : {};
      const inner = typeNameOf(members[0] ?? null);
      return nullable ? { ...inner, optional: true } : inner;
    }
    default:
      // `primitive_type`, `intersection_type`, `bottom_type`: nothing to point at.
      return {};
  }
}

/** Every class name a type declaration writes, however many alternatives it has. */
function typeNamesIn(node: SyntaxNode | null): string[] {
  if (!node) return [];
  const names: string[] = [];
  for (const named of node.type === 'named_type' ? [node] : node.descendantsOfType('named_type')) {
    const name = writtenName(named.namedChildren[0] ?? null);
    if (name !== null && !RESERVED_TYPES.has(name.toLowerCase())) names.push(name);
  }
  return names;
}

/**
 * UML's three, read off the declaration. Absent means the source did not say,
 * which for a PHP method is public — reported as absent rather than as
 * 'public' so the parser says what was written and not what it inferred.
 */
function modifiersOf(node: SyntaxNode): Pick<ParsedSymbol, 'visibility' | 'isStatic' | 'isAbstract'> {
  let visibility: ParsedSymbol['visibility'];
  let isStatic = false;
  let isAbstract = false;

  for (const child of node.namedChildren) {
    if (child.type === 'visibility_modifier') {
      const written = child.text.toLowerCase();
      if (written === 'public' || written === 'private' || written === 'protected') visibility = written;
    } else if (child.type === 'static_modifier') isStatic = true;
    else if (child.type === 'abstract_modifier') isAbstract = true;
  }

  return {
    ...(visibility === undefined ? {} : { visibility }),
    ...(isStatic ? { isStatic: true } : {}),
    ...(isAbstract ? { isAbstract: true } : {}),
  };
}

/** What a file's `use` statements bound, and the namespace it declared. */
interface Uses {
  /** The declared namespace, or '' in the global one. */
  namespace: string;
  /** Alias -> the fully qualified name, for `use A\B\C` and `use A\B\C as D`. */
  classes: Map<string, string>;
  /** The same for `use function`, which PHP keeps in a table of its own. */
  functions: Map<string, string>;
  bindings: ImportBinding[];
}

/**
 * A name as the file wrote it, turned into the fully qualified name — or names
 * — it can mean.
 *
 * This is PHP's own name resolution, and it is short because the language
 * wrote it down: a leading `\` is already absolute; a head bound by a `use` is
 * replaced by what it was bound to; and anything left over hangs off the
 * current namespace. There is no wildcard import to expand and no implicit
 * global fallback for a class — `new Exception()` inside `namespace App` means
 * `App\Exception` and fails unless a `use` said otherwise, which is why a PHP
 * file names its own dependencies far more completely than a Java one.
 *
 * A function is the one exception, and it is the language's: an unqualified
 * function call tries the current namespace and then the global one, so it
 * arrives as two candidates in that order.
 */
function referenceFor(written: string, uses: Uses, kind: 'class' | 'function'): string {
  if (written.startsWith(SEPARATOR)) return written.slice(1);

  const separator = written.indexOf(SEPARATOR);
  const head = separator === -1 ? written : written.slice(0, separator);
  const rest = separator === -1 ? '' : written.slice(separator);

  // The `namespace` operator: `namespace\Foo` is the current namespace's Foo.
  if (head === 'namespace') return uses.namespace === '' ? rest.slice(1) : uses.namespace + rest;

  // A qualified name's head comes from the class table whatever it ends in:
  // `use App\Helpers;` makes `Helpers\slugify()` a call into App\Helpers.
  const table = kind === 'function' && separator === -1 ? uses.functions : uses.classes;
  const bound = table.get(head);
  if (bound !== undefined) return bound + rest;

  if (uses.namespace === '') return written;
  const inNamespace = uses.namespace + SEPARATOR + written;
  // Unqualified functions and constants fall back to the global namespace.
  // Classes do not, so offering a second candidate for one would invent a
  // reference the language cannot make.
  return kind === 'function' && separator === -1 ? `${inNamespace}${CANDIDATES}${written}` : inNamespace;
}

/**
 * The namespace and the `use` table, read off the whole file.
 *
 * Read across the whole tree rather than off the top, because `namespace X {}`
 * is a block form that puts every `use` inside it, and a conditional `class_alias`
 * shim can put one inside an `if`. The first namespace wins: a file with two
 * namespace blocks is legal and vanishingly rare, and one answer for the file
 * is what `moduleName` can carry.
 */
function usesOf(root: SyntaxNode): Uses {
  const out: Uses = { namespace: '', classes: new Map(), functions: new Map(), bindings: [] };

  const declaration = root.descendantsOfType('namespace_definition')[0];
  if (declaration) {
    const name = declaration.namedChildren.find((child) => child.type === 'namespace_name');
    if (name) out.namespace = name.text;
  }

  for (const statement of root.descendantsOfType('namespace_use_declaration')) {
    // `use function` / `use const` at the statement level applies to every
    // clause under it; a grouped `use A\{function f, C}` says it per clause.
    const statementKind = statement.children.find((child) => child.type === 'function' || child.type === 'const')?.type;
    const group = statement.namedChildren.find((child) => child.type === 'namespace_use_group');
    const prefix = group ? (statement.namedChildren.find((child) => child.type === 'namespace_name')?.text ?? '') : '';

    for (const clause of (group ?? statement).namedChildren) {
      if (clause.type !== 'namespace_use_clause') continue;
      const clauseKind = clause.children.find((child) => child.type === 'function' || child.type === 'const')?.type;
      const names = clause.namedChildren.filter((child) => child.type === 'name' || child.type === 'qualified_name');
      const written = names[0]?.text;
      if (written === undefined) continue;

      // A grouped clause carries only the tail; the prefix is on the statement.
      const absolute = (prefix === '' ? written : `${prefix}${SEPARATOR}${written}`).replace(/^\\/, '');
      const local = names[1]?.text ?? tailOf(absolute);
      const table = (clauseKind ?? statementKind) === 'function' ? out.functions : out.classes;
      if (!table.has(local)) table.set(local, absolute);
      out.bindings.push({ local, specifier: absolute, imported: tailOf(absolute) });
    }
  }

  return out;
}

/**
 * Every class name the file mentions, and every function it calls by name,
 * as written.
 *
 * These are what becomes an import edge. A `use` is only half of what a PHP
 * file depends on — a class in the file's own namespace needs no `use` at all,
 * and Laravel writes whole directories that way — so, like Java, the names
 * actually used are collected and offered to the resolver as the fully
 * qualified names they can mean. Unlike Java there is no convention to lean
 * on: every site below is a type position or a scope-resolution operator, so
 * the grammar says these are class names and nothing has to be believed about
 * how they are spelled.
 */
interface References {
  classes: Set<string>;
  functions: Set<string>;
}

/** The scope of a `T::` — a written class name, or null for `self`, `$var` and the rest. */
function scopeName(node: SyntaxNode): string | null {
  return writtenName(node.namedChildren[0] ?? null);
}

function collectReferences(root: SyntaxNode): References {
  const out: References = { classes: new Set(), functions: new Set() };
  const add = (name: string | null): void => {
    if (name !== null && !RESERVED_TYPES.has(name.toLowerCase())) out.classes.add(name);
  };

  for (const type of root.descendantsOfType('named_type')) add(writtenName(type.namedChildren[0] ?? null));
  for (const clause of root.descendantsOfType(['base_clause', 'class_interface_clause', 'use_declaration'])) {
    for (const child of clause.namedChildren) add(writtenName(child));
  }
  for (const created of root.descendantsOfType('object_creation_expression')) {
    add(writtenName(created.namedChildren[0] ?? null));
  }
  for (const scoped of root.descendantsOfType([
    'scoped_call_expression',
    'class_constant_access_expression',
    'scoped_property_access_expression',
  ])) {
    add(scopeName(scoped));
  }
  for (const attribute of root.descendantsOfType('attribute')) add(writtenName(attribute.namedChildren[0] ?? null));
  for (const expression of root.descendantsOfType('binary_expression')) {
    if (expression.childForFieldName('operator')?.text === 'instanceof') {
      add(writtenName(expression.childForFieldName('right')));
    }
  }
  for (const call of root.descendantsOfType('function_call_expression')) {
    const callee = writtenName(call.childForFieldName('function'));
    if (callee !== null) out.functions.add(callee);
  }

  return out;
}

/**
 * What a member's calls are read against: the class whose body it is in, the
 * class that class extends, and the fields whose declared type says which
 * classifier `$this->field->m()` reaches.
 */
interface Enclosing {
  /** The class, trait, interface or enum being read, or null at the file's top level. */
  owner: string | null;
  /** What it extends, as written, so `parent::boot()` names something. */
  parent: string | null;
  /** Property name (no `$`) -> the class its declaration wrote, as written. */
  fields: ReadonlyMap<string, string>;
}

/**
 * Variable -> the class its declaration wrote, over one member.
 *
 * Parameters, promoted properties, `catch` types and `$x = new T()` are the
 * four ways a PHP variable's class is written down; nothing else is guessed
 * at. One table for the whole member rather than a scope chain, and a name
 * declared twice is kept only where both declarations agree — the rule
 * java.ts and python.ts both follow, for the same reason: deciding what a
 * name means at the point it is written needs the scope chain, and getting
 * that wrong draws an edge the source does not contain.
 */
function typedVariables(member: SyntaxNode): Map<string, string | null> {
  const typed = new Map<string, string | null>();
  const bind = (variable: SyntaxNode | null | undefined, written: string | null): void => {
    const name = variable?.type === 'variable_name' ? variable.text.replace(/^\$/, '') : null;
    if (name === null || name === 'this') return;
    if (!typed.has(name)) typed.set(name, written);
    else if (typed.get(name) !== written) typed.set(name, null);
  };
  const nameOf = (node: SyntaxNode): SyntaxNode | undefined =>
    node.namedChildren.find((child) => child.type === 'variable_name');

  for (const parameter of member.descendantsOfType(['simple_parameter', 'property_promotion_parameter', 'variadic_parameter'])) {
    // A variadic holds many of its type, so a call through it is a call on the
    // array and not on the class; the name is bound with no type rather than left
    // out, so a later declaration cannot type it either.
    const written = parameter.type === 'variadic_parameter' ? {} : typeNameOf(parameter.namedChildren.find((child) => child.type.endsWith('_type')) ?? null);
    bind(nameOf(parameter), written.typeName ?? null);
  }
  for (const clause of member.descendantsOfType('catch_clause')) {
    // `catch (A|B $e)` types the name as neither, the way a union does anywhere else.
    const names = typeNamesIn(clause.childForFieldName('type'));
    bind(clause.childForFieldName('name'), names.length === 1 ? (names[0] ?? null) : null);
  }
  for (const assignment of member.descendantsOfType('assignment_expression')) {
    const left = assignment.childForFieldName('left');
    if (left?.type !== 'variable_name') continue;
    const right = assignment.childForFieldName('right');
    const built = right?.type === 'object_creation_expression' ? writtenName(right.namedChildren[0] ?? null) : null;
    bind(left, built);
  }
  // Everything else a name can be bound by — `foreach ($xs as $x)`, `list()`,
  // a `global` — writes no type, and binding it with none is what stops a
  // typed declaration elsewhere in the member from answering for it.
  for (const loop of member.descendantsOfType('foreach_statement')) {
    for (const variable of loop.namedChildren) {
      if (variable.type === 'variable_name') bind(variable, null);
      else if (variable.type === 'pair') for (const half of variable.namedChildren) bind(half, null);
    }
  }

  return typed;
}

/**
 * The bodies under a node whose `$this` is not this class's: an anonymous
 * class, `new class extends Base { … }`, and a class declared inside a
 * function. A closure's is — PHP binds `$this` into a closure written inside a
 * method, and into an arrow function — so those are deliberately not here.
 */
function innerBodies(node: SyntaxNode): SyntaxNode[] {
  const bodies: SyntaxNode[] = [];
  for (const anonymous of node.descendantsOfType('anonymous_class')) bodies.push(anonymous);
  for (const declaration of node.descendantsOfType([...TYPE_KINDS.keys()])) {
    if (declaration.startIndex !== node.startIndex) bodies.push(declaration);
  }
  return bodies;
}

/** Whether one node lies inside any of a set of regions. */
function within(node: SyntaxNode, regions: readonly SyntaxNode[]): boolean {
  return regions.some((region) => node.startIndex >= region.startIndex && node.endIndex <= region.endIndex);
}

/**
 * Every name invoked inside a subtree, in the forms the graph resolves.
 *
 * PHP is the one language here that can tell a static call from an instance
 * call without resolving anything, because it spells them differently: `::`
 * is scope resolution and `->` is a member on an instance. So `Str::slug()`
 * arrives as the qualified `Str.slug` rather than as the bare class the way
 * Java has to leave it — the gap CLAUDE.md records for TypeScript, closed
 * here by the syntax rather than by a guess.
 *
 * `->` still needs the receiver's class written down: `$this`, `$this->field`
 * where the property declared one, a parameter or a local built with
 * `new T()`. A receiver nobody typed contributes nothing, not even its bare
 * method name. A missing edge is a gap; a wrong one is a lie.
 *
 * `exclude` holds the subtrees that became symbols of their own, so a class
 * does not claim what its methods call.
 */
function collectCalls(
  node: SyntaxNode,
  enclosing: Enclosing,
  exclude: readonly SyntaxNode[],
): string[] {
  const names = new Set<string>();
  const typed = typedVariables(node);
  // Inside an anonymous class body `$this`, `self` and `static` are that
  // class's, and it has no name for an edge to land on. Its `new T()` and
  // `T::m()` are unambiguous whoever wrote them, so only the relative forms
  // are withheld.
  const inner = innerBodies(node);

  /** The class a `->` receiver is known to be, or null. */
  const receiverOf = (object: SyntaxNode | null): string | null => {
    if (!object) return null;
    if (object.type === 'variable_name') {
      const name = object.text.replace(/^\$/, '');
      if (name === 'this') return within(object, inner) ? null : enclosing.owner;
      return typed.get(name) ?? null;
    }
    // `$this->log->write()`: the property's declared class carries the call.
    if (object.type === 'member_access_expression' || object.type === 'nullsafe_member_access_expression') {
      const holder = object.childForFieldName('object');
      if (holder?.type !== 'variable_name' || holder.text !== '$this' || within(holder, inner)) return null;
      const field = object.childForFieldName('name')?.text;
      return field === undefined ? null : (enclosing.fields.get(field) ?? null);
    }
    return null;
  };

  for (const call of node.descendantsOfType(['member_call_expression', 'nullsafe_member_call_expression'])) {
    if (within(call, exclude)) continue;
    const member = call.childForFieldName('name')?.text;
    const receiver = receiverOf(call.childForFieldName('object'));
    if (member !== undefined && receiver !== null) names.add(`${receiver}.${member}`);
  }

  for (const call of node.descendantsOfType('scoped_call_expression')) {
    if (within(call, exclude)) continue;
    const member = call.childForFieldName('name')?.text;
    if (member === undefined) continue;
    const scope = call.childForFieldName('scope');
    if (scope === null) continue;
    if (scope.type === 'relative_scope') {
      if (within(call, inner)) continue;
      const relative = scope.text.toLowerCase();
      const owner = relative === 'parent' ? enclosing.parent : enclosing.owner;
      if (owner !== null) names.add(`${owner}.${member}`);
      continue;
    }
    const written = writtenName(scope);
    if (written !== null) names.add(`${written}.${member}`);
    else {
      // `$factory::make()` — the variable's class, when one was written.
      const receiver = receiverOf(scope);
      if (receiver !== null) names.add(`${receiver}.${member}`);
    }
  }

  for (const call of node.descendantsOfType('function_call_expression')) {
    if (within(call, exclude)) continue;
    const callee = writtenName(call.childForFieldName('function'));
    if (callee !== null) names.add(callee);
  }

  // `new T()` runs T's constructor, so it is a call on T — the same reading
  // java.ts gives an object creation, and the reason a class with no static
  // methods is not drawn as unused.
  for (const created of node.descendantsOfType('object_creation_expression')) {
    if (within(created, exclude)) continue;
    const written = writtenName(created.namedChildren[0] ?? null);
    if (written !== null) names.add(written);
  }

  return [...names];
}

/** What a property's declaration and its constructor say about the part it holds. */
type Attribute = Pick<ParsedSymbol, 'typeName' | 'optional' | 'composed' | 'handedIn'>;

/** Field -> what the constructor did to it; see `constructorAssignments`. */
interface Assigned {
  /** The one class it was built as, `$this->x = new T()`; null when none or two. */
  constructed: string | null;
  /** `$this->x = $param`, for a `$param` the constructor took. */
  handedIn: boolean;
}

/**
 * Field -> what `__construct` assigned to it. `$this->x = new T()` says the
 * class builds the part; `$this->x = $param` says it was handed in. A promoted
 * property is handed in by definition and is marked where it is read.
 */
function constructorAssignments(constructor: SyntaxNode | null, fields: ReadonlySet<string>): Map<string, Assigned> {
  const assigned = new Map<string, Assigned>();
  if (!constructor) return assigned;

  const parameters = new Set<string>();
  for (const parameter of constructor.descendantsOfType(['simple_parameter', 'property_promotion_parameter'])) {
    const name = parameter.namedChildren.find((child) => child.type === 'variable_name')?.text;
    if (name !== undefined) parameters.add(name);
  }
  const inner = innerBodies(constructor);
  /** Field -> every class it was built as; two is neither, the rule `typedVariables` follows. */
  const built = new Map<string, Set<string>>();
  const handedIn = new Set<string>();

  for (const assignment of constructor.descendantsOfType('assignment_expression')) {
    if (within(assignment, inner)) continue;
    const left = assignment.childForFieldName('left');
    if (left?.type !== 'member_access_expression') continue;
    if (left.childForFieldName('object')?.text !== '$this') continue;
    const field = left.childForFieldName('name')?.text;
    if (field === undefined || !fields.has(field)) continue;

    const right = assignment.childForFieldName('right');
    if (right?.type === 'object_creation_expression') {
      const name = writtenName(right.namedChildren[0] ?? null);
      if (name !== null) built.set(field, new Set(built.get(field)).add(name));
    } else if (right?.type === 'variable_name' && parameters.has(right.text)) handedIn.add(field);
  }

  for (const field of new Set([...built.keys(), ...handedIn])) {
    const classes = built.get(field);
    assigned.set(field, {
      constructed: classes !== undefined && classes.size === 1 ? (classes.values().next().value ?? null) : null,
      handedIn: handedIn.has(field),
    });
  }
  return assigned;
}

/**
 * Everything a property's declaration and its class's constructor say about
 * the part it holds. `composed` only when what was built is the property's own
 * declared class: `$this->log = new ConsoleLogger()` on a `Logger $log` builds
 * something this file cannot say is a Logger.
 */
function attributeOf(type: SyntaxNode | null, value: SyntaxNode | null, assigned: Assigned | undefined): Attribute {
  const declared = typeNameOf(type);
  const built = value?.type === 'object_creation_expression' ? writtenName(value.namedChildren[0] ?? null) : null;
  const composed =
    declared.typeName !== undefined && (built === declared.typeName || assigned?.constructed === declared.typeName);
  return {
    ...declared,
    ...(composed ? { composed: true as const } : {}),
    ...(assigned?.handedIn === true ? { handedIn: true as const } : {}),
  };
}

/** The type declaration on a property, parameter or method: whichever `*_type` node it carries. */
function declaredType(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type.endsWith('_type')) ?? null;
}

/**
 * What a class writes in the signatures of its own operations — parameters and
 * return types — which is UML's dependency. The graph draws it only for a name
 * the class reaches no other way; see `ParsedSymbol.dependsOn`.
 */
function signatureTypes(operation: SyntaxNode): string[] {
  const names: string[] = [];
  for (const parameter of operation.childForFieldName('parameters')?.namedChildren ?? []) {
    names.push(...typeNamesIn(declaredType(parameter)));
  }
  // The return type is the one `*_type` child of the method that is not inside
  // its parameter list or its body.
  for (const child of operation.namedChildren) {
    if (child.type.endsWith('_type')) names.push(...typeNamesIn(child));
  }
  return names;
}

interface Collected {
  symbols: ParsedSymbol[];
  /** Subtrees that became a symbol, so the file does not also claim their calls. */
  claimed: SyntaxNode[];
}

/** What a type declaration says it is built out of: its supertypes, and its traits. */
function heritageOf(declaration: SyntaxNode): { extends: string[]; implements: string[]; parent: string | null } {
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];
  // What `parent::` means, which is the superclass and never a trait — a trait
  // is mixed in beside the parent, not above it. Taken here rather than off the
  // head of `extends` below, where the traits have joined it.
  let parent: string | null = null;

  for (const child of declaration.namedChildren) {
    // `extends A, B` on an interface is generalisation and arrives here too;
    // a class may extend only one, which is the language's rule and not ours.
    const target =
      child.type === 'base_clause' ? extendsNames : child.type === 'class_interface_clause' ? implementsNames : null;
    if (!target) continue;
    for (const reference of child.namedChildren) {
      const name = writtenName(reference);
      if (name === null) continue;
      target.push(name);
      // A class may extend only one thing, so the first is the parent; on an
      // interface, `extends A, B` names several and none of them is `parent::`.
      if (child.type === 'base_clause' && parent === null && declaration.type === 'class_declaration') {
        parent = name;
      }
    }
  }

  // A trait's members become the class's own members: `$this->uuid()` declared
  // in the trait runs on the class, and `parent::` skips straight past it. That
  // is inheritance of implementation, which is what `extends` means here.
  // `implements` would say the class merely conforms to a contract, and a trait
  // is not a contract — it has bodies and state. The counter-argument is real
  // and loses: `$user instanceof HasUuid` is false in PHP, because a trait is
  // not a type. But `implements` claims the same false thing, `associates` and
  // `depends` are both off by default and would hide half of what a Laravel
  // class is made of, and inventing a kind changes the graph model. So:
  // generalisation, drawn once per trait.
  const body = declaration.namedChildren.find((child) => child.type === 'declaration_list' || child.type === 'enum_declaration_list');
  for (const use of body?.namedChildren ?? []) {
    if (use.type !== 'use_declaration') continue;
    for (const reference of use.namedChildren) {
      const name = writtenName(reference);
      if (name !== null) extendsNames.push(name);
    }
  }

  return { extends: extendsNames, implements: implementsNames, parent };
}

/** A type body's entries, whether the body is a class's or an enum's. */
function bodyEntries(declaration: SyntaxNode): SyntaxNode[] {
  const body = declaration.namedChildren.find(
    (child) => child.type === 'declaration_list' || child.type === 'enum_declaration_list',
  );
  return body?.namedChildren ?? [];
}

/** One class, interface, trait or enum, and everything inside it. */
function collectType(declaration: SyntaxNode, kind: SymbolKind, out: Collected): void {
  const name = declaration.childForFieldName('name')?.text;
  if (name === undefined) return;

  const entries = bodyEntries(declaration);
  const heritage = heritageOf(declaration);
  const constructor =
    entries.find((entry) => entry.type === 'method_declaration' && entry.childForFieldName('name')?.text === '__construct') ??
    null;

  // The fields have to be known before the first method is read: `$this->log->write()`
  // needs `log`'s declared class, and it may be declared below the method using it.
  const declaredFields = new Map<string, string>();
  const fieldNames = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== 'property_declaration') continue;
    const written = typeNameOf(declaredType(entry)).typeName;
    for (const element of entry.namedChildren) {
      if (element.type !== 'property_element') continue;
      const field = element.namedChildren[0]?.text.replace(/^\$/, '');
      if (field === undefined) continue;
      fieldNames.add(field);
      if (written !== undefined) declaredFields.set(field, written);
    }
  }
  for (const promoted of constructor?.childForFieldName('parameters')?.namedChildren ?? []) {
    if (promoted.type !== 'property_promotion_parameter') continue;
    const field = promoted.namedChildren.find((child) => child.type === 'variable_name')?.text.replace(/^\$/, '');
    const written = typeNameOf(declaredType(promoted)).typeName;
    if (field === undefined) continue;
    fieldNames.add(field);
    if (written !== undefined) declaredFields.set(field, written);
  }

  const enclosing: Enclosing = { owner: name, parent: heritage.parent, fields: declaredFields };
  const assigned = constructorAssignments(constructor, fieldNames);
  const members: ParsedSymbol[] = [];
  const claimed: SyntaxNode[] = [];
  const dependsOn = new Set<string>();

  const memberAt = (node: SyntaxNode, memberName: string, memberKind: SymbolKind): ParsedSymbol => ({
    name: memberName,
    kind: memberKind,
    owner: name,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    implements: [],
    calls: [],
    ...modifiersOf(node),
  });

  // Attributes before operations, which is the order a UML class box reads in.
  for (const promoted of constructor?.childForFieldName('parameters')?.namedChildren ?? []) {
    if (promoted.type !== 'property_promotion_parameter') continue;
    const field = promoted.namedChildren.find((child) => child.type === 'variable_name')?.text.replace(/^\$/, '');
    if (field === undefined) continue;
    // Promotion is the constructor taking the part and keeping it: UML's
    // aggregation, said in one line.
    members.push({
      ...memberAt(promoted, field, 'field'),
      ...attributeOf(declaredType(promoted), null, { constructed: null, handedIn: true }),
    });
  }
  for (const entry of entries) {
    if (entry.type === 'property_declaration') {
      const type = declaredType(entry);
      for (const element of entry.namedChildren) {
        if (element.type !== 'property_element') continue;
        const field = element.namedChildren[0]?.text.replace(/^\$/, '');
        if (field === undefined) continue;
        members.push({
          ...memberAt(entry, field, 'field'),
          calls: collectCalls(entry, enclosing, []),
          ...attributeOf(type, element.namedChildren[1] ?? null, assigned.get(field)),
        });
      }
    } else if (entry.type === 'const_declaration') {
      for (const element of entry.namedChildren) {
        if (element.type !== 'const_element') continue;
        const constant = element.namedChildren[0]?.text;
        // A class constant belongs to the class and not to an instance.
        if (constant !== undefined) members.push({ ...memberAt(entry, constant, 'field'), isStatic: true });
      }
    } else if (entry.type === 'enum_case') {
      const caseName = entry.childForFieldName('name')?.text;
      // A case is an instance of its own enum: an attribute, and a static one.
      if (caseName !== undefined) members.push({ ...memberAt(entry, caseName, 'field'), isStatic: true });
    }
  }

  for (const entry of entries) {
    if (entry.type !== 'method_declaration') continue;
    const method = entry.childForFieldName('name')?.text;
    if (method === undefined) continue;
    for (const type of signatureTypes(entry)) dependsOn.add(type);
    members.push({ ...memberAt(entry, method, 'method'), calls: collectCalls(entry, enclosing, []) });
    claimed.push(entry);
  }

  out.symbols.push({
    name,
    kind,
    startLine: declaration.startPosition.row + 1,
    endLine: declaration.endPosition.row + 1,
    extends: heritage.extends,
    implements: heritage.implements,
    calls: collectCalls(declaration, enclosing, claimed),
    ...modifiersOf(declaration),
    ...(dependsOn.size === 0 ? {} : { dependsOn: [...dependsOn] }),
  });
  out.symbols.push(...members);
  out.claimed.push(declaration);
}

function collectFunction(declaration: SyntaxNode, out: Collected): void {
  const name = declaration.childForFieldName('name')?.text;
  if (name === undefined) return;
  out.symbols.push({
    name,
    kind: 'function',
    startLine: declaration.startPosition.row + 1,
    endLine: declaration.endPosition.row + 1,
    extends: [],
    implements: [],
    calls: collectCalls(declaration, { owner: null, parent: null, fields: new Map() }, []),
  });
  out.claimed.push(declaration);
}

/**
 * The declarations at one level, looking through the statements that hold
 * others: a `namespace X { }` block, and the `if (!class_exists(…))` and
 * `try`/`catch` shims a compatibility file wraps a declaration in. A class
 * written inside a function is a local of that function and not the file's.
 */
const COMPOUND: ReadonlySet<string> = new Set([
  'namespace_definition', 'compound_statement', 'if_statement', 'else_clause', 'elseif_clause',
  'try_statement', 'catch_clause', 'finally_clause', 'switch_statement', 'case_statement',
]);

function declarationsIn(node: SyntaxNode, out: SyntaxNode[]): void {
  for (const child of node.namedChildren) {
    if (TYPE_KINDS.has(child.type) || child.type === 'function_definition') out.push(child);
    else if (COMPOUND.has(child.type)) declarationsIn(child, out);
  }
}

/** basename -> the files that have it, so resolution is not a scan per reference. */
const basenames = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

function fileIndex(files: ReadonlySet<string>): Map<string, string[]> {
  const cached = basenames.get(files);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith('.php')) continue;
    const base = file.slice(file.lastIndexOf('/') + 1);
    const found = index.get(base);
    if (found) found.push(file);
    else index.set(base, [file]);
  }
  // Keyed on the file set itself, which the graph rebuilds whenever it changes,
  // so the index cannot outlive the set it describes.
  basenames.set(files, index);
  return index;
}

/**
 * Namespace -> the files that declare it, for the names a file search cannot
 * find. Built over `declarations`, which holds every file the scan parsed,
 * rather than over `modules`, which holds only the files that declared a
 * namespace: a file with no `namespace` line is in the global one, which is
 * where PHP's own standard library and every helpers file without a namespace
 * lives, and reading only `modules` made those invisible.
 */
const namespaced = new WeakMap<ReadonlyMap<string, ReadonlySet<string>>, Map<string, string[]>>();

function namespaceIndex(context: ResolveContext): Map<string, string[]> {
  const cached = namespaced.get(context.declarations);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  for (const file of context.declarations.keys()) {
    if (!file.endsWith('.php')) continue;
    const namespace = context.modules.get(file) ?? '';
    const found = index.get(namespace);
    if (found) found.push(file);
    else index.set(namespace, [file]);
  }
  namespaced.set(context.declarations, index);
  return index;
}

/** How many leading path segments two files share, for the nearest-answer tiebreak. */
function sharedDepth(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1;
  return depth;
}

/**
 * The PSR-4 map, whether or not `ProjectFacts` carries it yet.
 *
 * composer.json's `autoload.psr-4` is the resolver — it is the table PHP's own
 * autoloader turns a class name into a path with — and it belongs on
 * `ProjectFacts` beside tsconfig's paths and go.mod's module, gathered by
 * `project/facts.ts`. That is a note for the owner of those files, not a change
 * this one may make, so until the field lands it is read structurally and the
 * resolver falls through to the namespace each file declares. That fallback is
 * not a stub: measured on laravel/framework and monica it resolves everything
 * PSR-4 does, because PSR-4 is what put the file where its namespace says it
 * is. What the map buys is the projects that break the convention, and the
 * question of which namespaces are the project's own rather than a vendor's.
 */
interface Psr4Facts {
  /** Namespace prefix, no trailing separator -> the directories it maps to. */
  psr4?: ReadonlyMap<string, readonly string[]>;
}

const NO_PSR4: ReadonlyMap<string, readonly string[]> = new Map();

function psr4Of(facts: ProjectFacts): ReadonlyMap<string, readonly string[]> {
  return (facts as ProjectFacts & Psr4Facts).psr4 ?? NO_PSR4;
}

/**
 * A fully qualified name to a file through the PSR-4 map: the longest prefix
 * that names a file wins, and the shorter ones are tried after it.
 *
 * Trying every prefix rather than only the longest is what laravel/framework
 * forces. It maps `Illuminate\Support\` to four directories that hold a
 * fraction of `Illuminate\Support`, and `Illuminate\` to the tree those four
 * sit in — so `Illuminate\Support\Str` is found under the long prefix and
 * `Illuminate\Support\Facades\Log` only under the short one.
 */
function psr4File(name: string, psr4: ReadonlyMap<string, readonly string[]>, files: ReadonlySet<string>): string | null {
  const matching: string[] = [];
  for (const prefix of psr4.keys()) {
    if (prefix === '' || name === prefix || name.startsWith(prefix + SEPARATOR)) matching.push(prefix);
  }
  matching.sort((a, b) => b.length - a.length);

  for (const prefix of matching) {
    const rest = prefix === '' ? name : name.slice(prefix.length + 1);
    if (rest === '') continue;
    const relative = rest.split(SEPARATOR).join('/');
    for (const directory of psr4.get(prefix) ?? []) {
      const candidate = directory === '' ? `${relative}.php` : `${directory}/${relative}.php`;
      if (files.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The file that declares a fully qualified name, from what the files
 * themselves said.
 *
 * PSR-4 requires the class to be in a file named after it, so the basename is
 * where to look and the declared namespace is what decides between the
 * candidates — the same shape java.ts resolves a Java import with, and it
 * needs no manifest. The fallback for a file whose namespace was not read is
 * the path, which is PSR-4 spelled out by convention rather than by the map.
 * A function or a constant is neither: it lives in a file named for nothing in
 * particular, so it is looked for by name in every file of its namespace —
 * which is how laravel's nine `helpers.php` are reached at all.
 */
function declaredFile(name: string, context: ResolveContext): string | null {
  const separator = name.lastIndexOf(SEPARATOR);
  const namespace = separator === -1 ? '' : name.slice(0, separator);
  const simple = name.slice(separator + 1);

  let winner: string | null = null;
  let score = -1;
  const take = (candidate: string): void => {
    const depth = sharedDepth(candidate, context.from);
    if (depth > score) {
      score = depth;
      winner = candidate;
    }
  };

  for (const candidate of fileIndex(context.files).get(`${simple}.php`) ?? []) {
    // A parsed file's namespace is known: `modules` when it declared one, and
    // the global one when it did not. Only a file the scan never parsed is
    // judged by its path — PSR-4 spelled out by convention rather than read.
    const declared = context.modules.get(candidate);
    const matches =
      declared !== undefined ? declared === namespace
      : context.declarations.has(candidate)
        // A parsed file in the global namespace answers only for a name it
        // actually declares. Without that, PHP's own built-ins — Exception,
        // DateTime, ArrayObject — landed on whichever project file happened to
        // be called the same thing, which is a lie with a real file behind it.
        ? namespace === '' && context.declarations.get(candidate)?.has(simple) === true
      : candidate === `${simple}.php` || candidate.endsWith(`/${namespace.split(SEPARATOR).join('/')}/${simple}.php`);
    if (matches) take(candidate);
  }
  if (winner !== null) return winner;

  for (const candidate of namespaceIndex(context).get(namespace) ?? []) {
    if (context.declarations.get(candidate)?.has(simple) === true) take(candidate);
  }
  return winner;
}

const PHP_ID: LanguageId = 'php';

export const php: LanguageSupport = {
  id: PHP_ID,
  label: 'PHP',
  extensions: ['.php'],

  grammar(_filePath: string) {
    // The module's `php` dialect, not `php_only`: a real `.php` file may open
    // with HTML and switch in and out of `<?php` tags, and `php_only` cannot
    // read the tag at all. The dialect object rather than its `.language`, for
    // the reason every other grammar here is passed whole — the bare language
    // crashes inside parse() rather than at the call that was wrong.
    loaded ??= (require('tree-sitter-php') as { php: unknown }).php;
    return loaded;
  },

  /**
   * References come out fully qualified, which is rarely how they were written.
   *
   * A PHP file's `use` list is only part of what it depends on: a class in the
   * file's own namespace needs no `use` at all. So, like Java, every class name
   * the file mentions is offered as the fully qualified name PHP's own name
   * resolution says it means — see `referenceFor` — and each is bound under the
   * text the file wrote, so a call written `Str::slug()` and one written
   * `\Illuminate\Support\Str::slug()` reach the same file by different keys and
   * neither can reach anything the file did not name.
   */
  extract(root: SyntaxNode, _source: string): LanguageParse {
    const uses = usesOf(root);
    const references = collectReferences(root);

    const out: Collected = { symbols: [], claimed: [] };
    const declarations: SyntaxNode[] = [];
    declarationsIn(root, declarations);
    for (const declaration of declarations) {
      const kind = TYPE_KINDS.get(declaration.type);
      if (kind !== undefined) collectType(declaration, kind, out);
      else collectFunction(declaration, out);
    }

    const declared = new Set(out.symbols.filter((symbol) => symbol.owner === undefined).map((symbol) => symbol.name));
    const specifiers = new Set<string>();
    const bindings = [...uses.bindings];
    const bound = new Set(bindings.map((binding) => binding.local));

    /**
     * The heads of the qualified names this file wrote, so a `use` that names a
     * *namespace* is not reported as an import that failed to resolve.
     *
     * `use Symfony\Component\Validator\Constraints as Assert;` followed by
     * `Assert\NotBlank` imports a namespace, which is not a file and never
     * resolves to one — while every reference through it does, and draws the
     * import edge to the class it really names. Counted, symfony reported 50 of
     * its 269 claimed misses this way and none of them was missing anything.
     */
    const namespaceHeads = new Set<string>();
    for (const written of [...references.classes, ...references.functions]) {
      const separator = written.indexOf(SEPARATOR);
      if (separator > 0) namespaceHeads.add(written.slice(0, separator));
    }
    for (const { local, specifier } of uses.bindings) {
      const usedBare = references.classes.has(local) || references.functions.has(local);
      if (!usedBare && namespaceHeads.has(local)) continue;
      specifiers.add(specifier);
    }

    for (const [written, kind] of [
      ...[...references.classes].map((name): [string, 'class'] => [name, 'class']),
      ...[...references.functions].map((name): [string, 'function'] => [name, 'function']),
    ]) {
      // A `use` already bound this name, or the file declares it: either way
      // the reference is answered and a second specifier would draw a second
      // edge for one reference.
      if (bound.has(written) || declared.has(written)) continue;
      const specifier = referenceFor(written, uses, kind);
      bound.add(written);
      // An unqualified function call is not evidence of an import, and must not
      // be counted as one that failed. `trim($s)` inside `namespace Illuminate\Support`
      // is a candidate for `Illuminate\Support\trim` and then for the global
      // `trim`, and it is almost always the second — PHP's standard library is
      // one flat global namespace of some 1 500 names, and no list of them
      // belongs in this file. Counted, they were 5 of laravel/framework's 5
      // worst unresolved specifiers and most of 7 238 claimed misses, which is
      // the express-was-141-of-141 failure exactly. It still becomes a binding,
      // so a helper the project really does declare in the file's own namespace
      // still resolves and still draws its call edge.
      if (kind === 'class' || written.includes(SEPARATOR)) specifiers.add(specifier);
      bindings.push({ local: written, specifier, imported: tailOf(specifier.split(CANDIDATES)[0] ?? specifier) });
    }

    return {
      imports: [...specifiers],
      symbols: out.symbols,
      bindings,
      calls: collectCalls(root, { owner: null, parent: null, fields: new Map() }, out.claimed),
      ...(uses.namespace === '' ? {} : { moduleName: uses.namespace }),
    };
  },

  /**
   * A fully qualified name to the file that declares it.
   *
   * The PSR-4 map first, because it is the project's own statement of where a
   * namespace lives and it is what PHP's autoloader uses; then what the files
   * declared about themselves, which answers when there is no map and for the
   * functions PSR-4 cannot address. A specifier holding CANDIDATES is an
   * unqualified function call, which PHP tries in the current namespace and
   * then in the global one — first hit wins, so one reference stays one edge.
   */
  resolve(context: ResolveContext): string | null {
    const psr4 = psr4Of(context.facts);
    for (const candidate of context.specifier.split(CANDIDATES)) {
      const mapped = psr4.size === 0 ? null : psr4File(candidate, psr4, context.files);
      if (mapped !== null) return mapped;
      const declaring = declaredFile(candidate, context);
      if (declaring !== null) return declaring;
    }
    return null;
  },
};

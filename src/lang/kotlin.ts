import { createRequire } from 'node:module';

import { QUALIFIED_SEPARATOR } from '../parser/types.js';
import type { ImportBinding, ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageId, LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * Kotlin writes one node for `class`, `interface` and `fun interface`, and the
 * keyword is what tells them apart. `object` is its own declaration and is a
 * class: a singleton is one class with one instance, and the instance is what
 * `Registry.add(…)` calls a method on.
 *
 * An `annotation class` stays a class here where Java's `@interface` is an
 * interface, and the divergence is deliberate: Java's annotation *is* an
 * interface in the language and in the bytecode, and Kotlin's is spelled
 * `class`, carries a constructor and reads as a box with attributes. We report
 * what the source wrote.
 */
function kindOfClass(declaration: SyntaxNode): SymbolKind {
  return declaration.children.some((child) => child.type === 'interface') ? 'interface' : 'class';
}

/** Every node that stands where a type is written. */
const TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type', 'parenthesized_type', 'non_nullable_type']);

/**
 * The collections whose element is the association's real target, as Java's
 * module does it. `List<Thing>` is many Things, and `Map<String, Thing>` is
 * many Things keyed by a String — UML's qualified association, where the value
 * is the end that matters. Kotlin spells the mutable half separately, and an
 * `Array<T>` is a type here where Java's is syntax.
 */
const ELEMENT_AT: ReadonlyMap<string, number> = new Map([
  ['List', 0],
  ['MutableList', 0],
  ['Set', 0],
  ['MutableSet', 0],
  ['Collection', 0],
  ['MutableCollection', 0],
  ['Iterable', 0],
  ['Sequence', 0],
  ['Array', 0],
  ['Map', 1],
  ['MutableMap', 1],
]);

/**
 * The stdlib functions whose lambda re-binds `this`.
 *
 * `x.apply { save() }` runs `save()` on x, not on the class the lambda is
 * written in, and nothing in the syntax says so — a receiver lambda and an
 * ordinary one are the same braces. Reading the bare call as the enclosing
 * type's would put a call on whichever class happens to declare that name,
 * which is the lie this layer exists to avoid, so inside one of these `this`
 * and a bare call are nobody's.
 *
 * These are the language's own functions rather than a convention, which is why
 * they can be named. A DSL builder — `html { body { … } }` — does the same
 * thing and cannot be named, and is a known gap.
 */
const RECEIVER_LAMBDA_MEMBERS = new Set(['apply', 'run']);
const RECEIVER_LAMBDA_FUNCTIONS = new Set(['with', 'buildString', 'buildList', 'buildMap', 'buildSet']);

/**
 * Kotlin has no casing rule, but it has the same convention Java has: types are
 * capitalised and values are not.
 *
 * It is asked in one place only, `receiverName`, and for the reason Java's
 * module gives: `Registry.add()` on an object declaration and `helper.go()` on
 * a property some supertype in another file declares are the same three tokens,
 * and no table the resolver holds can separate them. Everywhere else the
 * grammar says whether a name is in a type position, and a grammar needs no
 * convention to vouch for it — which is why 131 lower-case Java classes were
 * not lost here.
 */
function looksLikeType(name: string): boolean {
  const first = name[0];
  return first !== undefined && !(first >= 'a' && first <= 'z');
}

/**
 * Every name the file binds to a value: a property, a local, a loop or `when`
 * variable, a destructured name, a constructor or function parameter, a catch
 * parameter, an enum constant.
 *
 * What the casing test would otherwise be standing in for. An `object` name is
 * deliberately not here: the singleton is a value *and* a type, and it is
 * reached as `Registry.add(…)` — the one form that makes an object's methods
 * findable at all.
 */
function valueNames(root: SyntaxNode): Set<string> {
  const values = new Set<string>();
  const bind = (node: SyntaxNode | null | undefined): void => {
    if (node?.type === 'identifier') values.add(node.text);
  };

  for (const declaration of root.descendantsOfType('variable_declaration')) {
    bind(declaration.namedChildren.find((child) => child.type === 'identifier'));
  }
  for (const parameter of root.descendantsOfType(['parameter', 'class_parameter'])) {
    bind(parameter.namedChildren.find((child) => child.type === 'identifier'));
  }
  for (const entry of root.descendantsOfType('enum_entry')) {
    bind(entry.namedChildren.find((child) => child.type === 'identifier'));
  }
  for (const block of root.descendantsOfType('catch_block')) {
    bind(block.namedChildren.find((child) => child.type === 'identifier'));
  }

  return values;
}

/**
 * A type expression reduced to the one name an edge can be drawn to.
 *
 * A `user_type` is its dotted segments and an optional argument list, so the
 * last identifier is the type and the ones before it are the package or the
 * outer type — `LinkedTreeMap.Node` and `com.example.Deep` both name their
 * tail, exactly as Java's `scoped_type_identifier` does. A function type names
 * no classifier the graph can draw.
 */
function typeNameOf(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
      return node.text;
    case 'user_type': {
      const segments = node.namedChildren.filter((child) => child.type === 'identifier');
      return segments[segments.length - 1]?.text ?? null;
    }
    case 'nullable_type':
    case 'parenthesized_type':
      return typeNameOf(node.namedChildren.find((child) => TYPE_NODES.has(child.type)));
    default:
      // A function type, an intersection, `dynamic`. Nothing to point at.
      return null;
  }
}

/** The types written inside a `<…>`, with the projections unwrapped. */
function typeArguments(type: SyntaxNode): SyntaxNode[] {
  const list = type.namedChildren.find((child) => child.type === 'type_arguments');
  const args: SyntaxNode[] = [];
  for (const projection of list?.namedChildren ?? []) {
    const written = projection.namedChildren.find((child) => TYPE_NODES.has(child.type));
    // A star projection, `List<*>`, names nothing; the slot is kept so the
    // value half of a `Map<*, Thing>` is still the second one.
    args.push(written ?? projection);
  }
  return args;
}

/** What a property's type says about the association; see `attributeOf` for the rest. */
type Attribute = Pick<ParsedSymbol, 'typeName' | 'many' | 'optional' | 'composed' | 'handedIn'>;

function associationOf(type: SyntaxNode | null | undefined): Attribute {
  if (!type) return {};

  // `Item?` is the association's 0..1, and Kotlin writes it in the type rather
  // than in an annotation or a wrapper, so it is the one language here where
  // the far end's optionality is never a guess.
  if (type.type === 'nullable_type') {
    const inner = associationOf(type.namedChildren.find((child) => TYPE_NODES.has(child.type)));
    return { ...inner, optional: true };
  }
  if (type.type === 'parenthesized_type') {
    return associationOf(type.namedChildren.find((child) => TYPE_NODES.has(child.type)));
  }
  if (type.type !== 'user_type') return {};

  const base = typeNameOf(type);
  const at = base === null ? undefined : ELEMENT_AT.get(base);
  if (at === undefined) return base === null ? {} : { typeName: base };

  const element = typeNameOf(typeArguments(type)[at]);
  return element === null ? { many: true } : { typeName: element, many: true };
}

/**
 * The type a value expression names outright: `Item()` and `x as Item`.
 *
 * Kotlin has no `new`, so a construction and a call are the same syntax and
 * this cannot say which it read. It does not have to. The name is handed to the
 * store as the receiver's type, and the store admits a member only on a class
 * or an interface — so `val s = makeStore()` yields `makeStore.save`, which
 * resolves to nothing because `makeStore` is a function. The wrong reading
 * refuses itself, and that is why Java's `new` is not missed here.
 */
function constructedName(value: SyntaxNode | null | undefined): string | null {
  if (!value) return null;
  if (value.type === 'call_expression') {
    const callee = value.namedChildren[0];
    return callee?.type === 'identifier' ? callee.text : null;
  }
  if (value.type === 'as_expression') return typeNameOf(value.childForFieldName('right'));
  return null;
}

/**
 * UML's three, read off the declaration. `internal` is left absent: it is
 * module-wide visibility, the graph model has room for three, and writing it
 * down as public or protected would be a claim the source did not make —
 * the same answer Java's module gives package-private.
 */
function modifiersOf(node: SyntaxNode): Pick<ParsedSymbol, 'visibility' | 'isAbstract'> {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  if (!modifiers) return {};

  let visibility: ParsedSymbol['visibility'];
  let isAbstract = false;
  for (const child of modifiers.namedChildren) {
    const text = child.text;
    if (child.type === 'visibility_modifier') {
      if (text === 'public' || text === 'private' || text === 'protected') visibility = text;
    } else if (child.type === 'inheritance_modifier' && text === 'abstract') isAbstract = true;
  }

  return { ...(visibility === undefined ? {} : { visibility }), ...(isAbstract ? { isAbstract: true } : {}) };
}

/** Whether a declaration says `private`, which at the top level means this file only. */
function isPrivate(node: SyntaxNode): boolean {
  return modifiersOf(node).visibility === 'private';
}

/** The names a declaration's `<T, R : Base>` introduces. */
function typeParametersOf(declaration: SyntaxNode): Set<string> {
  const names = new Set<string>();
  const list = declaration.namedChildren.find((child) => child.type === 'type_parameters');
  for (const parameter of list?.namedChildren ?? []) {
    const name = parameter.namedChildren.find((child) => child.type === 'identifier');
    if (parameter.type === 'type_parameter' && name) names.add(name.text);
  }
  return names;
}

/**
 * A `fun` taken apart. Nothing but the name carries a field, and the receiver
 * and the return type are both bare type nodes, so they are told apart by which
 * side of the name they sit on: `fun List<Item>.first(): Item`.
 */
interface FunctionParts {
  /** The extension receiver, when the source wrote one. */
  receiver: SyntaxNode | null;
  parameters: SyntaxNode | null;
  returnType: SyntaxNode | null;
  body: SyntaxNode | null;
}

function functionParts(fn: SyntaxNode): FunctionParts {
  const name = fn.childForFieldName('name');
  const start = name === null ? -1 : name.startIndex;
  let receiver: SyntaxNode | null = null;
  let returnType: SyntaxNode | null = null;
  let parameters: SyntaxNode | null = null;
  for (const child of fn.namedChildren) {
    if (child.type === 'function_value_parameters') parameters = child;
    else if (TYPE_NODES.has(child.type)) {
      if (child.startIndex < start) receiver = child;
      else returnType ??= child;
    }
  }
  return { receiver, parameters, returnType, body: fn.namedChildren.find((c) => c.type === 'function_body') ?? null };
}

/** A `val`/`var` taken apart, by the same rule `functionParts` uses. */
interface PropertyParts {
  receiver: SyntaxNode | null;
  /** One name, or several when the source destructured. */
  declarations: SyntaxNode[];
  value: SyntaxNode | null;
}

function propertyParts(property: SyntaxNode): PropertyParts {
  const declared = property.namedChildren.find(
    (child) => child.type === 'variable_declaration' || child.type === 'multi_variable_declaration',
  );
  const start = declared?.startIndex ?? Number.MAX_SAFE_INTEGER;
  const receiver = property.namedChildren.find((child) => TYPE_NODES.has(child.type) && child.startIndex < start);
  // The initialiser is whatever follows the name and is neither an accessor nor
  // a `by` delegate; a delegated property is produced by the delegate, not by a
  // constructor, so it names no type.
  const value = property.namedChildren.find(
    (child) =>
      child.startIndex > start &&
      child.type !== 'getter' &&
      child.type !== 'setter' &&
      child.type !== 'property_delegate' &&
      child.type !== 'type_constraints',
  );
  return {
    receiver: receiver ?? null,
    declarations:
      declared?.type === 'multi_variable_declaration'
        ? declared.namedChildren.filter((child) => child.type === 'variable_declaration')
        : declared === undefined
          ? []
          : [declared],
    value: value ?? null,
  };
}

/** The name and the written type of one `variable_declaration`. */
function declaredName(declaration: SyntaxNode): { name: string | null; type: SyntaxNode | null } {
  const name = declaration.namedChildren.find((child) => child.type === 'identifier');
  const type = declaration.namedChildren.find((child) => TYPE_NODES.has(child.type));
  return { name: name?.text ?? null, type: type ?? null };
}

/**
 * Everything a property's declaration says about the part it holds.
 *
 * `composed` only when the type written on the property is the one the
 * initialiser names: `val log: Logger = Logger()` builds the part, while
 * `val items: MutableList<Item> = mutableListOf()` builds the list and not an
 * Item, and `val log: Logger = ConsoleLogger()` builds something this file
 * cannot say is a Logger.
 */
function attributeOf(type: SyntaxNode | null, value: SyntaxNode | null, handedIn: boolean): Attribute {
  const association = associationOf(type);
  const built = constructedName(value);
  return {
    ...association,
    ...(association.typeName !== undefined && built === association.typeName ? { composed: true as const } : {}),
    ...(handedIn ? { handedIn: true as const } : {}),
  };
}

/**
 * Every type name an operation's signature writes — parameters and return type
 * — less the `<T>` in force. See `ParsedSymbol.dependsOn`.
 */
function signatureTypes(fn: SyntaxNode, typeParameters: ReadonlySet<string>): string[] {
  const generic = new Set([...typeParameters, ...typeParametersOf(fn)]);
  const { parameters, returnType } = functionParts(fn);
  const names: string[] = [];
  const read = (node: SyntaxNode | null): void => {
    for (const reference of node?.descendantsOfType('user_type') ?? []) {
      const name = typeNameOf(reference);
      if (name !== null && !generic.has(name)) names.push(name);
    }
  };
  read(parameters);
  read(returnType);
  return names;
}

/**
 * What a member's calls are read against: the type whose body it is in, the
 * operations it declares itself, and the properties whose written type says
 * which class `field.m()` reaches.
 */
interface Enclosing {
  /**
   * The type `this` stands for, or null where there is none. For an extension
   * function that is its *receiver*, which the source wrote down — `fun
   * Store.reset()` makes `this.save()` a call on Store, and Kotlin is the only
   * language here where a top-level function has an owner at all.
   */
  owner: string | null;
  /** Operations the type declares itself, its companion's included. */
  methods: ReadonlySet<string>;
  /** Property -> its written type, null where that names nothing to land on. */
  fields: ReadonlyMap<string, string | null>;
  /** The type's own `<T>`, which names whatever the caller supplies. */
  typeParameters: ReadonlySet<string>;
  /** Every name the file binds to a value; see `valueNames`. */
  values: ReadonlySet<string>;
  /**
   * Bare calls the enclosing type could not answer, collected as this file
   * writes them. Kotlin's top level holds functions, so a bare `helper()` may
   * be one in another file of the same package — see `extract`.
   */
  unbound: Set<string>;
}

/**
 * Variable -> the type its declaration wrote, over one member.
 *
 * The enclosing type's properties first, then every parameter and local the
 * member declares. One table for the whole member rather than a scope chain, so
 * a name declared twice is kept only if both declarations agree, and a name
 * bound with nothing to type it — a lambda's `it`, a destructured component, a
 * `val x = someCall()` whose callee is not a plain name — refuses the name
 * outright. An untyped receiver is a gap, not a guess.
 */
function typedNames(member: SyntaxNode, enclosing: Enclosing): Map<string, string | null> {
  const typed = new Map(enclosing.fields);
  const generic = new Set(enclosing.typeParameters);
  for (const parameter of member.descendantsOfType('type_parameter')) {
    const name = parameter.namedChildren.find((child) => child.type === 'identifier');
    if (name) generic.add(name.text);
  }
  const bind = (name: string | null, written: string | null): void => {
    if (name === null) return;
    const known = written !== null && generic.has(written) ? null : written;
    if (!typed.has(name)) typed.set(name, known);
    else if (typed.get(name) !== known) typed.set(name, null);
  };

  // A Kotlin parameter always writes its type, and so does a catch parameter —
  // there is no union catch to refuse, which is where Java has to give up.
  for (const parameter of member.descendantsOfType(['parameter', 'class_parameter'])) {
    const { name, type } = declaredName(parameter);
    bind(name, typeNameOf(type));
  }
  for (const block of member.descendantsOfType('catch_block')) {
    const name = block.namedChildren.find((child) => child.type === 'identifier');
    const type = block.namedChildren.find((child) => TYPE_NODES.has(child.type));
    bind(name?.text ?? null, typeNameOf(type));
  }
  for (const declaration of member.descendantsOfType('variable_declaration')) {
    const { name, type } = declaredName(declaration);
    const written = typeNameOf(type);
    // A local usually writes no type in Kotlin, and `val s = Store()` is where
    // the type actually is; see `constructedName` for why reading it is safe.
    const parent = declaration.parent;
    const inferred =
      written ?? (parent?.type === 'property_declaration' ? constructedName(propertyParts(parent).value) : null);
    bind(name, inferred);
  }

  return typed;
}

/**
 * The bodies under a node that belong to some other type: an anonymous
 * `object : Listener { … }`, and a class or object declared inside a block.
 *
 * `this` in one of them is that type's instance and a bare call is its own
 * before it is the outer type's, so a call in one is read against that body's
 * own declarations and nothing outside them — the same rule Java's module
 * applies to an anonymous class body, and for the same reason.
 */
function innerBodies(node: SyntaxNode): SyntaxNode[] {
  const bodies: SyntaxNode[] = [];
  for (const literal of node.descendantsOfType('object_literal')) {
    for (const child of literal.namedChildren) if (child.type === 'class_body') bodies.push(child);
  }
  for (const declaration of node.descendantsOfType(['class_declaration', 'object_declaration'])) {
    // A node is among its own descendants, and its body is the one being read.
    if (declaration.startIndex === node.startIndex) continue;
    for (const child of declaration.namedChildren) {
      if (child.type === 'class_body' || child.type === 'enum_class_body') bodies.push(child);
    }
  }
  return bodies;
}

/** One inner body and what it declared; see `innerBodies`. */
interface InnerBody {
  body: SyntaxNode;
  typed: ReadonlyMap<string, string | null>;
}

/** The innermost of the bodies holding a node, or null when it is in none. */
function innermost(bodies: readonly InnerBody[], node: SyntaxNode): InnerBody | null {
  let found: InnerBody | null = null;
  for (const candidate of bodies) {
    const { body } = candidate;
    if (node.startIndex < body.startIndex || node.endIndex > body.endIndex) continue;
    if (found === null || body.startIndex > found.body.startIndex) found = candidate;
  }
  return found;
}

/**
 * The lambda bodies under a node whose `this` is not the enclosing type's;
 * see `RECEIVER_LAMBDA_MEMBERS`.
 */
function receiverLambdas(node: SyntaxNode): SyntaxNode[] {
  const bodies: SyntaxNode[] = [];
  for (const call of node.descendantsOfType('call_expression')) {
    const callee = call.namedChildren[0];
    const rebinds =
      callee?.type === 'navigation_expression'
        ? RECEIVER_LAMBDA_MEMBERS.has(callee.namedChildren[callee.namedChildren.length - 1]?.text ?? '')
        : callee?.type === 'identifier' && RECEIVER_LAMBDA_FUNCTIONS.has(callee.text);
    if (!rebinds) continue;
    for (const lambda of call.descendantsOfType('lambda_literal')) {
      if (lambda.parent?.type === 'annotated_lambda' || lambda.parent?.type === 'value_argument') bodies.push(lambda);
    }
  }
  return bodies;
}

/** The name a qualified call or navigation is written on, when it names a type. */
function receiverName(navigation: SyntaxNode, values: ReadonlySet<string>): string | null {
  const object = navigation.namedChildren[0];
  if (object?.type !== 'identifier') return null;
  const name = object.text;
  return values.has(name) || !looksLikeType(name) ? null : name;
}

/** Whether one node sits inside any of the given regions. */
function within(node: SyntaxNode, regions: readonly SyntaxNode[]): boolean {
  return regions.some((region) => node.startIndex >= region.startIndex && node.endIndex <= region.endIndex);
}

/**
 * Every name invoked inside a symbol, with the subtrees that became symbols of
 * their own left out — a class must not claim what its methods call, or every
 * call would produce two edges and double the weight on the one that gets drawn.
 *
 * Four forms get in, and nothing else does:
 *
 * - `this.m()`, and a bare `m()` the type declares, are `Owner.m`.
 * - `x.m()` where `x`'s type was written down is `T.m`.
 * - `Registry.add()`, where the receiver is a name the file never bound to a
 *   value, is `Registry.add`. Java stops at the receiver here; Kotlin need not,
 *   because an `object` is a class with the member on it and this is the only
 *   way its operations are ever called.
 * - a bare `f()` or `Item()` the type does not declare is the bare name, which
 *   the store resolves against the file's own top-level declarations and its
 *   bindings and *never* against a member. Java refuses this, because there a
 *   bare call is always a member; in Kotlin it is usually a top-level function
 *   or a constructor, and there is no `new` to tell the two apart.
 *
 * A call on a receiver nobody typed contributes nothing — not even its bare
 * property name, which is the mistake that put `def.items.map()` on a `map()`
 * factory in another module.
 */
function collectCalls(node: SyntaxNode, exclude: readonly SyntaxNode[], enclosing: Enclosing): string[] {
  const names = new Set<string>();
  const typed = typedNames(node, enclosing);
  const rebound = receiverLambdas(node);
  const inner: InnerBody[] = innerBodies(node).map((body) => ({
    body,
    typed: typedNames(body, { ...enclosing, fields: new Map(), typeParameters: enclosing.typeParameters }),
  }));

  /** What `this` is at a call site, or null when nothing here can say. */
  const receiverAt = (call: SyntaxNode): string | null =>
    innermost(inner, call) !== null || within(call, rebound) ? null : enclosing.owner;

  for (const call of node.descendantsOfType('call_expression')) {
    if (within(call, exclude)) continue;
    const callee = call.namedChildren[0];
    if (!callee) continue;

    if (callee.type === 'identifier') {
      const name = callee.text;
      const own = innermost(inner, call);
      if (own !== null) continue;
      if (enclosing.methods.has(name)) {
        const owner = receiverAt(call);
        if (owner !== null) names.add(`${owner}.${name}`);
      } else if (!enclosing.fields.has(name) && !typed.has(name)) {
        // A top-level function of this file, of another, or a constructor. The
        // store reads a bare name against top-level declarations only, so this
        // can never land on somebody's method.
        names.add(name);
        enclosing.unbound.add(name);
      }
      continue;
    }

    if (callee.type !== 'navigation_expression') continue;
    const method = callee.namedChildren[callee.namedChildren.length - 1];
    if (method?.type !== 'identifier') continue;
    const object = callee.namedChildren[0];
    if (!object) continue;

    if (object.type === 'this_expression') {
      // `this@Outer` names either an outer class or an extension function's
      // receiver, and the label is the same token for both, so it is refused.
      if (object.namedChildren.some((child) => child.type === 'identifier')) continue;
      const owner = receiverAt(call);
      if (owner !== null) names.add(`${owner}.${method.text}`);
      continue;
    }
    if (object.type !== 'identifier') continue;

    const own = innermost(inner, call);
    const type =
      own !== null
        ? own.typed.has(object.text)
          ? own.typed.get(object.text)
          : // A property of the outer type is the inner body's own name before
            // it is the outer one's, so it is refused rather than guessed.
            enclosing.fields.has(object.text)
            ? null
            : typed.get(object.text)
        : typed.get(object.text);
    if (type !== null && type !== undefined) names.add(`${type}.${method.text}`);
    else if (type === undefined) {
      const receiver = receiverName(callee, enclosing.values);
      if (receiver !== null) names.add(`${receiver}.${method.text}`);
    }
  }

  return [...names];
}

/**
 * The two supertype lists, told apart by parentheses rather than by a keyword.
 *
 * Java writes `extends` and `implements`; Kotlin writes one colon, and what
 * distinguishes the superclass is that it is *constructed* — `: Shape(),
 * Drawable` invokes Shape's constructor and merely names Drawable. On an
 * interface every supertype is an interface, which UML calls generalisation,
 * so those are `extends` the way Java's `extends_interfaces` is.
 *
 * A `by` delegation names an interface being handed to a delegate, so it is
 * realisation. The one case this reads wrongly is a class with no primary
 * constructor, `class A : Base { constructor() : super() }`, where Base carries
 * no parentheses and is called an interface: the edge is drawn either way, and
 * only its kind is wrong.
 */
function heritageOf(declaration: SyntaxNode, kind: SymbolKind): { extends: string[]; implements: string[] } {
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];
  const list = declaration.namedChildren.find((child) => child.type === 'delegation_specifiers');

  for (const specifier of list?.namedChildren ?? []) {
    if (specifier.type !== 'delegation_specifier') continue;
    const invocation = specifier.namedChildren.find((child) => child.type === 'constructor_invocation');
    const delegation = specifier.namedChildren.find((child) => child.type === 'explicit_delegation');
    const written = invocation ?? delegation ?? specifier;
    const name = typeNameOf(written.namedChildren.find((child) => TYPE_NODES.has(child.type)));
    if (name === null) continue;
    if (invocation !== undefined || kind === 'interface') extendsNames.push(name);
    else implementsNames.push(name);
  }

  return { extends: extendsNames, implements: implementsNames };
}

interface Collected {
  /** Fully qualified references, as the language resolves them; see `extract`. */
  imports: string[];
  /** The packages an on-demand import made visible, in declaration order. */
  wildcards: string[];
  symbols: ParsedSymbol[];
  packageName: string | null;
  /** Simple names an import already binds, so the package cannot. */
  bound: Set<string>;
  bindings: ImportBinding[];
  /** Every name the file binds to a value, read off the root once. */
  values: ReadonlySet<string>;
  /** Bare calls nothing in reach declared; see `Enclosing.unbound`. */
  unbound: Set<string>;
  /**
   * A name imported straight off a companion object -> the type that holds it
   * and the reference that names that type; see `qualifyCalls`.
   */
  companions: Map<string, { owner: string; specifier: string }>;
}

/** One entry of a type's body, and whether a companion object holds it. */
interface Entry {
  node: SyntaxNode;
  /**
   * Kotlin's `companion object` is how it writes what Java writes as `static`:
   * the members are reached on the enclosing type, `Circle.of(1.0)`, and the
   * companion has no name at the call site. So they are the enclosing type's
   * members, and they are the one place `isStatic` is written.
   */
  companion: boolean;
}

function bodyEntries(declaration: SyntaxNode): Entry[] {
  const body = declaration.namedChildren.find(
    (child) => child.type === 'class_body' || child.type === 'enum_class_body',
  );
  const entries: Entry[] = [];
  for (const child of body?.namedChildren ?? []) {
    if (child.type === 'companion_object') {
      const inner = child.namedChildren.find((grand) => grand.type === 'class_body');
      for (const member of inner?.namedChildren ?? []) entries.push({ node: member, companion: true });
    } else entries.push({ node: child, companion: false });
  }
  return entries;
}

/** One member of a type body, or nothing if the node declares no symbol. */
function collectMember(entry: Entry, owner: string, enclosing: Enclosing, symbols: ParsedSymbol[]): SyntaxNode | null {
  const { node, companion } = entry;
  const common = {
    owner,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    implements: [],
    ...modifiersOf(node),
    ...(companion ? { isStatic: true } : {}),
  };

  if (node.type === 'function_declaration') {
    const name = node.childForFieldName('name')?.text;
    if (name) symbols.push({ ...common, name, kind: 'method', calls: collectCalls(node, [], enclosing) });
    return node;
  }

  // A secondary constructor is the only constructor Kotlin writes as a member:
  // the primary one lives in the class header, and its `val` parameters are
  // already the attributes below. Named after the type, which is what a UML
  // operation compartment shows for a constructor.
  if (node.type === 'secondary_constructor') {
    symbols.push({ ...common, name: owner, kind: 'method', calls: collectCalls(node, [], enclosing) });
    return node;
  }

  if (node.type === 'property_declaration') {
    const { declarations, value } = propertyParts(node);
    const calls = collectCalls(node, [], enclosing);
    for (const declaration of declarations) {
      const { name, type } = declaredName(declaration);
      // A property keeps what its initialiser and its accessors call, and is
      // not returned as claimed, so the enclosing type keeps them too — the
      // same split Java's module makes, where only a body is taken away.
      if (name) symbols.push({ ...common, name, kind: 'field', calls, ...attributeOf(type, value, false) });
    }
    return null;
  }

  if (node.type === 'enum_entry') {
    const name = node.namedChildren.find((child) => child.type === 'identifier')?.text;
    // Constants are the enum's instances, so they are its attributes — of its
    // own type, which the diagram already knows from the owner.
    if (name) symbols.push({ ...common, name, kind: 'field', calls: collectCalls(node, [], enclosing), isStatic: true });
    return null;
  }

  return null;
}

/**
 * One type declaration and everything inside it.
 *
 * A nested type becomes a top-level symbol of its own rather than a member,
 * matching what Java's module does: the graph keys owners by type name and
 * keeps an owned symbol out of the file's name table, so owning a nested class
 * would cost every edge into it.
 */
function collectType(node: SyntaxNode, kind: SymbolKind, out: Collected): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;

  const members: ParsedSymbol[] = [];
  const nested: SyntaxNode[] = [];
  /** Subtrees whose calls belong to something other than this type. */
  const claimed: SyntaxNode[] = [];
  const entries = bodyEntries(node);

  // What the members' calls are read against has to be known before the first
  // member is read: a bare `run()` at the top of the body is this type's own
  // only if something further down — or its companion — declares it.
  const typeParameters = typeParametersOf(node);
  const methods = new Set<string>();
  const fields = new Map<string, string | null>();
  const named = (written: string | null): string | null =>
    written !== null && typeParameters.has(written) ? null : written;

  const constructor = node.namedChildren.find((child) => child.type === 'primary_constructor');
  const parameters =
    constructor?.namedChildren.find((child) => child.type === 'class_parameters')?.namedChildren ?? [];
  for (const parameter of parameters) {
    if (parameter.type !== 'class_parameter') continue;
    const { name: bound, type } = declaredName(parameter);
    if (bound) fields.set(bound, named(typeNameOf(type)));
  }
  for (const { node: entry } of entries) {
    if (entry.type === 'function_declaration') {
      const method = entry.childForFieldName('name')?.text;
      if (method) methods.add(method);
    } else if (entry.type === 'property_declaration') {
      for (const declaration of propertyParts(entry).declarations) {
        const { name: field, type } = declaredName(declaration);
        if (field) fields.set(field, named(typeNameOf(type)));
      }
    }
  }
  const enclosing: Enclosing = {
    owner: name,
    methods,
    fields,
    typeParameters,
    values: out.values,
    unbound: out.unbound,
  };
  const dependsOn = new Set<string>();

  // A `val`/`var` in the primary constructor is a property that arrives through
  // it — UML's aggregation, and the same reading a record component and a
  // TypeScript parameter property get. A plain parameter declares nothing.
  for (const parameter of parameters) {
    if (parameter.type !== 'class_parameter') continue;
    const binding = parameter.children.find((child) => child.type === 'val' || child.type === 'var');
    const { name: property, type } = declaredName(parameter);
    if (binding === undefined || property === null) continue;
    members.push({
      name: property,
      kind: 'field',
      owner: name,
      startLine: parameter.startPosition.row + 1,
      endLine: parameter.endPosition.row + 1,
      extends: [],
      implements: [],
      calls: [],
      ...modifiersOf(parameter),
      ...attributeOf(type, null, true),
    });
  }

  for (const entry of entries) {
    if (entry.node.type === 'class_declaration' || entry.node.type === 'object_declaration') {
      nested.push(entry.node);
      claimed.push(entry.node);
      continue;
    }
    if (entry.node.type === 'function_declaration') {
      for (const type of signatureTypes(entry.node, typeParameters)) dependsOn.add(type);
    }
    const taken = collectMember(entry, name, enclosing, members);
    if (taken) claimed.push(taken);
  }

  const heritage = heritageOf(node, kind);
  out.symbols.push({
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: heritage.extends,
    implements: heritage.implements,
    calls: collectCalls(node, claimed, enclosing),
    exported: !isPrivate(node),
    ...modifiersOf(node),
    ...(dependsOn.size === 0 ? {} : { dependsOn: [...dependsOn] }),
  });
  out.symbols.push(...members);

  for (const child of nested) {
    collectType(child, child.type === 'object_declaration' ? 'class' : kindOfClass(child), out);
  }
}

/**
 * A top-level `fun` or `val`, which Java has no room for at all.
 *
 * A Kotlin file is a list of declarations, not one class, and most of what a
 * project's own code reaches is a top-level function — so these are symbols on
 * the file, the way a property-assigned function is in JavaScript. An extension
 * function is one of them: it is not a member of the type it extends, however
 * it is called, and putting it inside that class's box would say the class
 * declares something it has never heard of. What the receiver does buy is
 * `this`, which is written down and is therefore a real qualified reference.
 */
function collectTopLevelFunction(node: SyntaxNode, out: Collected): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;
  const { receiver } = functionParts(node);
  const enclosing: Enclosing = {
    owner: typeNameOf(receiver),
    methods: new Set(),
    fields: new Map(),
    typeParameters: typeParametersOf(node),
    values: out.values,
    unbound: out.unbound,
  };
  const dependsOn = signatureTypes(node, new Set());
  out.symbols.push({
    name,
    kind: 'function',
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    implements: [],
    calls: collectCalls(node, [], enclosing),
    exported: !isPrivate(node),
    ...modifiersOf(node),
    ...(dependsOn.length === 0 ? {} : { dependsOn: [...new Set(dependsOn)] }),
  });
}

/** The `FUNCTION_VALUES` of the TypeScript module, in Kotlin's spelling. */
const FUNCTION_VALUES = new Set(['lambda_literal', 'anonymous_function', 'callable_reference']);

function collectTopLevelProperty(node: SyntaxNode, out: Collected): void {
  const { receiver, declarations, value } = propertyParts(node);
  const enclosing: Enclosing = {
    owner: typeNameOf(receiver),
    methods: new Set(),
    fields: new Map(),
    typeParameters: typeParametersOf(node),
    values: out.values,
    unbound: out.unbound,
  };
  const calls = collectCalls(node, [], enclosing);
  // 'field' unless the source wrote a function down: `val f = { … }` is one and
  // `val n = compute()` is a value, and calling either a function would be a
  // claim rather than a reading — the same line the TypeScript module draws.
  const kind: SymbolKind = value !== null && FUNCTION_VALUES.has(value.type) ? 'function' : 'field';
  for (const declaration of declarations) {
    const { name, type } = declaredName(declaration);
    if (!name) continue;
    out.symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      extends: [],
      implements: [],
      calls,
      exported: !isPrivate(node),
      ...modifiersOf(node),
      ...attributeOf(type, value, false),
    });
  }
}

function collectTopLevel(node: SyntaxNode, out: Collected): void {
  if (node.type === 'package_header') {
    const reference = node.namedChildren.find((child) => child.type === 'qualified_identifier');
    if (reference) out.packageName = reference.text;
    return;
  }

  if (node.type === 'import') {
    const reference = node.namedChildren.find((child) => child.type === 'qualified_identifier');
    if (!reference) return;
    // `import a.b.*` names a package; every other form names one declaration,
    // or a member of one, and the resolver reads the name right to left.
    if (node.children.some((child) => child.type === '*')) {
      out.wildcards.push(reference.text);
      return;
    }
    out.imports.push(reference.text);
    const simple = reference.text.slice(reference.text.lastIndexOf('.') + 1);
    // `import a.b.Thing as T` binds T to Thing, and the alias is the only name
    // the rest of the file may write — Java has no such form.
    const alias = node.namedChildren.find((child) => child.type === 'identifier');
    const local = alias?.text ?? simple;
    out.bound.add(local);
    out.bindings.push({ local, specifier: reference.text, imported: simple });
    // `import okhttp3.Headers.Companion.headersOf` and `import
    // okhttp3.TestUtil.headerEntries` make a member callable by its bare name.
    // `Companion` is the language's own name for an unnamed companion, so the
    // type in front of it is exact; an object's own name is not, and the
    // convention decides — a *member* is imported when the name in front is a
    // type and the name imported is not, which leaves `import a.b.Outer.Inner`
    // the nested type it is.
    const holder = reference.text.slice(0, reference.text.lastIndexOf('.'));
    const specifier = holder.endsWith('.Companion') ? holder.slice(0, -'.Companion'.length) : holder;
    const owner = specifier.slice(specifier.lastIndexOf('.') + 1);
    if (looksLikeType(owner) && (specifier !== holder || !looksLikeType(simple))) {
      out.companions.set(local, { owner, specifier });
    }
    return;
  }

  switch (node.type) {
    case 'class_declaration':
      collectType(node, kindOfClass(node), out);
      return;
    case 'object_declaration':
      collectType(node, 'class', out);
      return;
    case 'function_declaration':
      collectTopLevelFunction(node, out);
      return;
    case 'property_declaration':
      collectTopLevelProperty(node, out);
      return;
    case 'type_alias': {
      const name = node.childForFieldName('type')?.text;
      if (name) {
        out.symbols.push({
          name,
          kind: 'type',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          extends: [],
          implements: [],
          calls: [],
          exported: !isPrivate(node),
        });
      }
      return;
    }
    default:
      collectMisparsedAnnotation(node, out);
      return;
  }
}

/**
 * `@Target(CLASS)` above a bare `annotation class Foo`, which the grammar reads
 * as an expression.
 *
 * A grammar bug, and the one worth paying for: tree-sitter-kotlin 1.1.0 reads
 * an annotated `annotation class` that has no primary constructor as an
 * expression, and it does *not* set the error flag — so the declaration
 * vanishes with no warning anywhere, and every reference to it with it. okhttp
 * writes `OkHttpInternalApi` and `StartStop` that way and lost 97 imports of
 * the two; ktor's Annotations.kt lost `InternalAPI` and 51 more. Whatever the
 * region swallowed goes with them, which is why this reads the whole subtree
 * rather than one shape of it.
 *
 * What is recovered is the name and nothing else: no members, no visibility, no
 * range wider than the name itself. Delete this when the grammar is fixed.
 */
function collectMisparsedAnnotation(node: SyntaxNode, out: Collected): void {
  if (node.type !== 'annotated_expression') return;
  // `class` is a hard keyword, so an identifier node holding that text can only
  // have come from the misparse — which is what makes reading the tokens back
  // safe. One region can swallow several declarations, and does: ktor's
  // Annotations.kt lost `InternalAPI` and `ExperimentalKtorApi` together.
  const words = node.descendantsOfType('identifier');
  words.forEach((word, at) => {
    if (word.text !== 'annotation' || words[at + 1]?.text !== 'class') return;
    const name = words[at + 2];
    if (name === undefined) return;
    out.symbols.push({
      name: name.text,
      kind: 'class',
      startLine: name.startPosition.row + 1,
      endLine: name.endPosition.row + 1,
      extends: [],
      implements: [],
      calls: [],
      exported: true,
    });
  });
}

/**
 * The simple type names a file mentions that nothing has bound to a package yet.
 *
 * These are the implicit references: Kotlin resolves an unqualified name against
 * the current package and the on-demand imports without writing anything down,
 * so a same-package dependency leaves no trace in the source at all. Names the
 * file declares itself, binds with an import, or introduces as a type parameter
 * are already accounted for.
 */
function unboundNames(root: SyntaxNode, out: Collected): string[] {
  const declared = new Set(out.symbols.filter((symbol) => symbol.owner === undefined).map((symbol) => symbol.name));
  const parameters = new Set<string>();
  for (const parameter of root.descendantsOfType('type_parameter')) {
    const name = parameter.namedChildren.find((child) => child.type === 'identifier');
    if (name) parameters.add(name.text);
  }

  const names = new Set<string>();
  for (const reference of root.descendantsOfType('user_type')) {
    const name = typeNameOf(reference);
    if (name !== null) names.add(name);
  }
  for (const navigation of root.descendantsOfType('navigation_expression')) {
    const receiver = receiverName(navigation, out.values);
    if (receiver) names.add(receiver);
  }

  return [...names].filter((name) => !declared.has(name) && !parameters.has(name) && !out.bound.has(name));
}

/**
 * Separates the packages one unbound name could have come from, in the order
 * the compiler tries them. Not a character any Kotlin package or declaration
 * name can hold, so it cannot collide with a name a file actually wrote.
 *
 * One reference is one specifier because one reference is one edge; see the
 * same constant in Java's module for what offering them separately cost.
 */
const CANDIDATES = '|';

/**
 * The two calls whose written form does not say what the graph has to be asked.
 *
 * `Request.Builder()` rewritten as a reference into the file Request lives in.
 *
 * The two ways of naming something inside a class are one thing to Kotlin and
 * two tables to the graph. `Registry.add()` is a member of a classifier, which
 * the store finds through `T.m`; `Request.Builder()` builds a *nested type*,
 * and the graph deliberately keeps a nested type as a top-level symbol of its
 * file so that edges reach it — so `T.m` looks for it among Request's members
 * and never finds it. In okhttp that is 1 100 references, nearly all of them
 * the builder pattern, and every one of them a real edge left undrawn.
 *
 * Go's form is the one that asks the other table: `<specifier>#Name` resolves
 * the head through the file's own import and reads the tail out of the
 * declarations of the file it landed on. So a call whose member *is* a type
 * name is written that way instead.
 *
 * Which of the two to ask is the one thing nothing here can know, and the
 * convention — a type is capitalised — is what decides. It decides between two
 * questions and never invents an answer: ask the wrong one and the reference
 * resolves to nothing, which is a gap. That is why it is allowed here and why
 * `looksLikeType` may not be asked anywhere else.
 */
function qualifyCalls(out: Collected, references: Set<string>): void {
  // A companion's member arrives at the call site as a bare name, which reaches
  // only top-level declarations; said as `Headers.headersOf` it reaches the
  // member. The type it hangs off has to be a name the file binds for that to
  // resolve, and an import of the member alone does not bind it — so the
  // binding the language implies is written down here.
  for (const [local, { owner, specifier }] of out.companions) {
    if (out.bound.has(owner)) continue;
    out.bound.add(owner);
    out.bindings.push({ local: owner, specifier, imported: owner });
  }
  const specifiers = new Map(out.bindings.map((binding) => [binding.local, binding.specifier]));

  for (const symbol of out.symbols) {
    symbol.calls = symbol.calls.map((name) => {
      const companion = out.companions.get(name);
      if (companion !== undefined) return `${companion.owner}.${name}`;
      const dot = name.lastIndexOf('.');
      const member = name.slice(dot + 1);
      const specifier = dot === -1 ? undefined : specifiers.get(name.slice(0, dot));
      if (specifier === undefined || !looksLikeType(member)) return name;
      const qualified = `${specifier}${QUALIFIED_SEPARATOR}${member}`;
      references.add(qualified);
      return qualified;
    });
  }
}

/** package -> the files declaring it, so resolution is not a scan per import. */
const indexes = new WeakMap<ReadonlyMap<string, ReadonlySet<string>>, Map<string, string[]>>();

/**
 * Which files sit in which package.
 *
 * `.java` is in here on purpose. Kotlin and Java compile together into one
 * module and share one package namespace — an Android or Spring tree is both,
 * often in the same directory — so a Kotlin `import com.x.Thing` naming a Java
 * class is an ordinary reference and not a special case. Nothing else the graph
 * reads shares that namespace, so nothing else is a candidate.
 */
function packageIndex(context: ResolveContext): Map<string, string[]> {
  const cached = indexes.get(context.declarations);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  for (const file of context.files) {
    if (!file.endsWith('.kt') && !file.endsWith('.java')) continue;
    // A file with no package header is in the default package, which is a
    // package like any other and is how a script or a build-logic file resolves.
    const declared = context.modules.get(file) ?? '';
    const found = index.get(declared);
    if (found) found.push(file);
    else index.set(declared, [file]);
  }
  // Keyed on the declarations map, which the graph rebuilds whenever a file
  // changes, so the index cannot outlive the project it describes.
  indexes.set(context.declarations, index);
  return index;
}

/** How many leading path segments two files share, for the source-root tiebreak. */
function sharedDepth(a: string, b: string): number {
  const left = a.split('/');
  const right = b.split('/');
  let depth = 0;
  while (depth < left.length && depth < right.length && left[depth] === right[depth]) depth += 1;
  return depth;
}

/**
 * One qualified name to the file that declares it.
 *
 * This is where Kotlin parts company with Java, and it is the whole reason the
 * resolver could not be shared. Java's answer is a file name: `com.x.Thing` is
 * `Thing.java` somewhere under a source root. A Kotlin file may hold any number
 * of top-level declarations and is named after none of them — `Http.kt` holds
 * `HttpMethod`, `HttpStatusCode` and forty functions — so the only thing that
 * can answer is the project's own table of what each file declares.
 *
 * Read right to left, because the tail of a qualified name is not always the
 * declaration: `a.b.Outer.Inner` is a nested class and `a.b.Thing.CONST` a
 * member of one. That also makes a source root the project never states —
 * `src/main/kotlin` — something this never has to know.
 *
 * Two files in one package can both answer, and the order they are tried in
 * decides which is right, so `bestOf` states it rather than leaving it to
 * whichever the scan happened to read first.
 */
function declaringFile(specifier: string, context: ResolveContext): string | null {
  const index = packageIndex(context);
  const segments = specifier.split('.');

  for (let split = segments.length - 1; split >= 0; split -= 1) {
    const simple = segments[split];
    if (simple === undefined) continue;
    // Only a package the project actually has is tried, and the first one that
    // exists is the last: if `okhttp3.internal.connection` is a package and
    // holds no `JvmField`, then no shorter reading of the name is the right
    // one. Without that stop the walk carried on to `okhttp3.internal`, asked
    // it for `connection`, and found the extension property of that name —
    // drawing an edge from a file whose only reference is `@JvmField`.
    const candidates = index.get(segments.slice(0, split).join('.'));
    if (!candidates) continue;

    const declaring = candidates.filter((file) => context.declarations.get(file)?.has(simple));
    const [first, ...rest] = declaring;
    return first === undefined ? null : bestOf([first, ...rest], simple, context.from);
  }

  return null;
}

/**
 * Which of the files that all declare `simple` the reference means.
 *
 * They all really declare it, so this only ever chooses between right answers —
 * it can never invent one, which is why a file-naming habit is allowed to
 * decide here and is allowed nowhere else. Two things make the choice:
 *
 * A file named after the declaration wins. The reason is not tidiness, it is
 * that a *nested* class is in this table too — the graph keeps a nested type as
 * a top-level symbol so that edges reach it — while `okhttp3.Request` can only
 * ever mean a top-level `Request`, never `Dns.Request`. `declarations` cannot
 * say which is nested, and okhttp writes both: without this, every one of the
 * 273 references to `Request` landed inside Dns.kt.
 *
 * Then the nearer file, which is how a project with several source roots keeps
 * a test on the test copy of a class — a file under `src/test` shares more
 * leading segments with its neighbours there than with `src/main`. The last
 * tiebreak is the path itself, so the graph does not depend on scan order.
 */
function bestOf(candidates: readonly [string, ...string[]], simple: string, from: string): string {
  const named = candidates.filter((file) => {
    const base = file.slice(file.lastIndexOf('/') + 1);
    return base === `${simple}.kt` || base === `${simple}.java`;
  });
  const between: readonly string[] = named.length > 0 ? named : candidates;
  return between.reduce((best, file) =>
    sharedDepth(file, from) > sharedDepth(best, from) ||
    (sharedDepth(file, from) === sharedDepth(best, from) && file < best)
      ? file
      : best,
  );
}

export const KOTLIN_ID: LanguageId = 'kotlin';

export const kotlin: LanguageSupport = {
  id: KOTLIN_ID,
  label: 'Kotlin',
  // `.kts` is deliberately absent. A Gradle build script's top level is a DSL
  // supplied by Gradle rather than by the project, so its declarations are
  // configuration and draw boxes that say nothing about the architecture; the
  // status bar reporting them as unread is the honest answer.
  extensions: ['.kt'],

  grammar(_filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    loaded ??= require('@tree-sitter-grammars/tree-sitter-kotlin');
    return loaded;
  },

  /**
   * Imports come out fully qualified, which is not always how they were written.
   *
   * Kotlin's `import` list is only part of what a file depends on: a declaration
   * in the same package needs no import at all, and `import a.b.*` names a
   * package rather than any file in it. Both are resolved by the compiler per
   * *name used*, so that is what this reproduces — every unbound type name the
   * file mentions is offered as the packages it could have come from, the
   * file's own ahead of the wildcards, for the resolver to try in that order.
   *
   * A bare call is offered too, and only as a binding. Kotlin's top level holds
   * functions, so `helper()` may be one in the file next door; but it may just
   * as easily be `println` or `listOf`, and putting those in `imports` would
   * count the standard library as coupling this project lost. A binding costs
   * nothing when it resolves to nothing, and buys the edge when it does not.
   */
  extract(root: SyntaxNode, _source: string): LanguageParse {
    const out: Collected = {
      imports: [],
      wildcards: [],
      symbols: [],
      packageName: null,
      bound: new Set(),
      bindings: [],
      values: valueNames(root),
      unbound: new Set(),
      companions: new Map(),
    };
    for (const child of root.namedChildren) collectTopLevel(child, out);

    const references = new Set(out.imports);
    // The file's own package first, matching the order the compiler tries them.
    // A file with no package header is in the default package, written as the
    // empty string, so its candidates are the bare names themselves.
    const packages = [out.packageName ?? '', ...out.wildcards];
    const candidatesFor = (name: string): string =>
      packages.map((from) => (from === '' ? name : `${from}.${name}`)).join(CANDIDATES);

    for (const name of unboundNames(root, out)) {
      const specifier = candidatesFor(name);
      references.add(specifier);
      // The binding carries the same candidates, so the graph reads the name
      // from exactly the file the import edge went to.
      out.bindings.push({ local: name, specifier, imported: name });
    }
    const declared = new Set(out.symbols.map((symbol) => symbol.name));
    for (const name of out.unbound) {
      if (declared.has(name) || out.bound.has(name)) continue;
      out.bindings.push({ local: name, specifier: candidatesFor(name), imported: name });
    }
    qualifyCalls(out, references);

    return {
      imports: [...references],
      symbols: out.symbols,
      bindings: out.bindings,
      ...(out.packageName === null ? {} : { moduleName: out.packageName }),
    };
  },

  /**
   * A reference to the one file that declares it.
   *
   * A specifier is a single qualified name, or the candidates an unbound name
   * expanded to. Trying them in order and stopping at the first hit is the
   * compiler's own rule — see `extract` — and it is what keeps one reference to
   * one edge.
   */
  resolve(context: ResolveContext): string | null {
    // A qualified reference names a file through its head — see
    // `qualifyNestedTypes` — and the tail is the graph's to look up, not ours.
    const hash = context.specifier.indexOf(QUALIFIED_SEPARATOR);
    const specifier = hash === -1 ? context.specifier : context.specifier.slice(0, hash);
    for (const candidate of specifier.split(CANDIDATES)) {
      const hit = declaringFile(candidate, context);
      if (hit) return hit;
    }
    return null;
  },
};

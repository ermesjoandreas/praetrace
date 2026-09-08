import { createRequire } from 'node:module';
import path from 'node:path';

import type { ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageId, LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let cppGrammar: unknown = null;
let cGrammar: unknown = null;

/**
 * One reader, two languages, two grammars.
 *
 * C and C++ are one entry here rather than two because the only thing that
 * could tell them apart is the extension, and `.h` — the commonest header
 * extension in both — is claimed by each. curl's public API is `curl/curl.h`
 * and googletest's is `gtest/gtest.h`; a table that had to pick would mislabel
 * one of them, and it would mislabel it on the box, in the status bar's
 * language summary and in the "not read" census. Nothing downstream wants the
 * difference: the edge is the include either way, the symbols are the same
 * UML, and a struct means the same thing in both.
 *
 * The *grammar* is picked per file, which is what `grammar(filePath)` is for.
 * `.c` gets tree-sitter-c and everything else gets tree-sitter-cpp. Measured on
 * curl's 774 `.c` files: 231 parse with an error under C and 286 under C++, so
 * 55 files keep their symbols that would otherwise lose whatever sat in the
 * damaged region. On its 257 `.h` files the two grammars agree exactly (38
 * each), which is why headers can go to the superset without paying for it.
 *
 * **What this cannot read is the preprocessor, and that is structural.** There
 * is no `#define` table here, so a macro standing where a declaration goes is
 * read as whatever it looks like — see `macroClassOf` for the one shape worth
 * claiming and `isMacroInvocation` for the ones worth refusing. Where a macro
 * derails the grammar outright the file wears the syntax-error badge honestly:
 * 269 of curl's 1033 files and 66 of googletest's 157. The badge overstates the
 * damage, though, and the measured spread is the useful number — error regions
 * cover 4.2% of curl's bytes and 9.9% of googletest's, and the median affected
 * file loses under 0.2% of itself. A handful are total losses, and they are all
 * one thing: a brace opened inside `#ifdef` and closed inside `#else`
 * (`lib/vtls/openssl.c`, `gmock_main.cc`), which no parser without a
 * preprocessor can balance.
 */
const C_ONLY = '.c';

/** The bare name a type or declarator node ends in. */
function nameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'field_identifier':
    case 'namespace_identifier':
    case 'operator_name':
    case 'primitive_type':
      return node.text;
    // `std::vector<T>` and `ns::Thing` — the name is the tail, and the head is
    // the namespace it was written under.
    case 'qualified_identifier':
    case 'scoped_type_identifier':
      return nameOf(node.childForFieldName('name'));
    case 'template_type':
      return nameOf(node.childForFieldName('name'));
    case 'template_function':
      return nameOf(node.childForFieldName('name'));
    case 'destructor_name':
      return `~${node.namedChildren[0]?.text ?? ''}`;
    // `struct node* next;` writes the tag inline, which is how C spells a type.
    case 'struct_specifier':
    case 'union_specifier':
    case 'class_specifier':
    case 'enum_specifier':
      return nameOf(node.childForFieldName('name'));
    case 'sized_type_specifier':
    case 'placeholder_type_specifier':
      return null;
    default:
      return null;
  }
}

/** `outer::inner::Widget::run` -> the segments, or null when it is not a path. */
function segmentsOf(node: SyntaxNode | null): string[] | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'namespace_identifier':
    case 'field_identifier':
    case 'operator_name':
      return [node.text];
    case 'template_type':
    case 'template_function':
      return segmentsOf(node.childForFieldName('name'));
    case 'qualified_identifier':
    case 'scoped_type_identifier': {
      const scope = node.childForFieldName('scope');
      const name = segmentsOf(node.childForFieldName('name'));
      if (name === null) return null;
      // `::global()` writes an empty scope, which names the global namespace.
      if (scope === null) return name;
      const head = segmentsOf(scope);
      return head === null ? null : [...head, ...name];
    }
    default:
      return null;
  }
}

/**
 * What a declarator declares, once the pointers, references, arrays and
 * parentheses wrapped around the name are peeled off.
 *
 * The shape matters as much as the name. `Logger& log_` and `Logger log_` are
 * the same association on a diagram but not the same ownership, and
 * `int (*cb)(void*)` looks exactly like a prototype until the parentheses are
 * read.
 */
interface Declarator {
  name: string | null;
  /** It declares an operation rather than an attribute. */
  callable: boolean;
  /** A `*` or `&` stands between the holder and what it holds. */
  indirect: boolean;
  /** `Item items[4]` — a fixed run of them. */
  array: boolean;
  /** The parameter list, for reading the types an operation names. */
  parameters: SyntaxNode | null;
}

function declaratorOf(node: SyntaxNode | null): Declarator {
  const empty: Declarator = { name: null, callable: false, indirect: false, array: false, parameters: null };
  if (!node) return empty;

  switch (node.type) {
    case 'pointer_declarator':
    case 'reference_declarator':
      // A reference writes no `declarator` field — its one child is unlabelled
      // — so the first named child stands in for it. Without that every `T&`
      // was nameless, which cost the graph far more than a name: a reference
      // parameter is how C++ passes an object, so `void run(Store& store)`
      // could not type `store` and `store.save()` reached nothing at all.
      return {
        ...declaratorOf(node.childForFieldName('declarator') ?? node.namedChildren[0] ?? null),
        indirect: true,
      };
    case 'operator_cast':
      // `operator bool() const` — the type it converts to stands where a
      // return type would, which is why the declaration carries none.
      return {
        ...empty,
        name: `operator ${node.childForFieldName('type')?.text ?? ''}`.trim(),
        callable: true,
        parameters: node.childForFieldName('declarator')?.childForFieldName('parameters') ?? null,
      };
    case 'array_declarator':
      return { ...declaratorOf(node.childForFieldName('declarator')), array: true };
    case 'init_declarator':
      return declaratorOf(node.childForFieldName('declarator'));
    case 'parenthesized_declarator':
      // `(*cb)` — the parentheses are what make the next `(…)` a parameter list
      // for a pointer rather than for a function, so what is inside them is a
      // variable however much the outer node looks like a declaration.
      return { ...declaratorOf(node.namedChildren[0] ?? null), callable: false, indirect: true };
    case 'function_declarator': {
      const inner = declaratorOf(node.childForFieldName('declarator'));
      return {
        ...inner,
        // A parenthesized inner declarator is a function *pointer*: the name is
        // a variable that happens to be spelled with a parameter list.
        callable: node.childForFieldName('declarator')?.type !== 'parenthesized_declarator',
        parameters: node.childForFieldName('parameters'),
      };
    }
    // A trailing `noexcept`, `const` or `-> T` hangs off the declarator; the
    // grammar keeps the name a child, so falling through to nameOf finds it.
    default:
      return { ...empty, name: nameOf(node) };
  }
}

/** `std::vector<Item>` is how C++ spells a 1..* association. */
const COLLECTIONS: ReadonlySet<string> = new Set([
  'vector', 'list', 'deque', 'set', 'multiset', 'unordered_set', 'array', 'forward_list', 'span',
  'initializer_list',
]);
/** Wrappers that say how a value is held, not what it is. */
const WRAPPERS: ReadonlySet<string> = new Set(['unique_ptr', 'shared_ptr', 'weak_ptr', 'reference_wrapper', 'atomic']);
/**
 * `std::unique_ptr<T>` is exclusive ownership by definition rather than by
 * convention — that is the whole of what the type says — so a member holding
 * one is UML's composition as surely as a member held by value.
 */
const OWNING: ReadonlySet<string> = new Set(['unique_ptr']);

/** What a declared type says about the association drawn from it. */
interface Attribute {
  typeName?: string;
  many?: boolean;
  optional?: true;
  /** The type owns what it holds: by value, or through a unique_ptr. */
  owning?: boolean;
}

/** The first type a `<…>` names, skipping a non-type argument like `4`. */
function firstArgument(node: SyntaxNode): SyntaxNode | null {
  const args = node.childForFieldName('arguments');
  for (const child of args?.namedChildren ?? []) {
    if (child.type === 'type_descriptor') return child.namedChildren[0] ?? null;
    if (child.type !== 'number_literal') return child;
  }
  return null;
}

/**
 * A declared type reduced to the one name an association can be drawn to, and
 * what the declaration said about how it is held.
 *
 * A primitive is not a classifier, so `int count` yields nothing. `std::string`
 * yields `string` and resolves to nothing later, which costs a lookup and says
 * the truth: the project does not declare it.
 */
function attributeOf(type: SyntaxNode | null): Attribute {
  if (!type) return {};

  switch (type.type) {
    case 'primitive_type':
    case 'sized_type_specifier':
    case 'placeholder_type_specifier':
      return {};
    case 'type_descriptor':
      return attributeOf(type.namedChildren[0] ?? null);
    case 'qualified_identifier':
    case 'scoped_type_identifier': {
      const tail = type.childForFieldName('name');
      // `std::vector<Item>` is read through its tail, so the namespace it was
      // written under does not change what it holds.
      return tail === null ? {} : attributeOf(tail);
    }
    case 'template_type': {
      const base = nameOf(type.childForFieldName('name'));
      if (base === null) return {};
      if (COLLECTIONS.has(base)) return { ...attributeOf(firstArgument(type)), many: true, owning: true };
      if (base === 'optional') return { ...attributeOf(firstArgument(type)), optional: true };
      if (WRAPPERS.has(base)) return { ...attributeOf(firstArgument(type)), owning: OWNING.has(base) };
      // `std::map<K, V>` and a project's own `Result<T>` alike: the template is
      // the classifier that was named, and its arguments are not attributes of
      // the holder. Reading `map<string, Handler>` as a Handler would draw an
      // association the source did not write.
      return { typeName: base, owning: true };
    }
    default: {
      const name = nameOf(type);
      return name === null ? {} : { typeName: name, owning: true };
    }
  }
}

/**
 * The role a field plays in the association drawn from it, in the store's own
 * shape: `many`, `optional` and the ownership flags travel on the symbol.
 */
function fieldAttribute(type: SyntaxNode | null, declarator: Declarator): Attribute {
  const attribute = attributeOf(type);
  if (attribute.typeName === undefined) return {};
  return {
    ...attribute,
    ...(declarator.array ? { many: true } : {}),
    // A `*` or an `&` between the holder and the held is exactly the difference
    // between a part stored inside the object and one that lives on its own.
    ...(declarator.indirect ? { owning: false } : {}),
  };
}

/** Only the fields ParsedSymbol carries; `owning` is read here and left behind. */
function attributeFields(attribute: Attribute): Partial<ParsedSymbol> {
  return {
    ...(attribute.typeName === undefined ? {} : { typeName: attribute.typeName }),
    ...(attribute.many === true ? { many: true } : {}),
    ...(attribute.optional === true ? { optional: true as const } : {}),
    // A member held by value or through a unique_ptr is destroyed with its
    // holder, which is the whole of what UML's filled diamond claims.
    ...(attribute.owning === true ? { composed: true as const } : {}),
  };
}

/**
 * Where a declaration sits in the file's namespaces, and whether anything
 * outside the file could name it.
 *
 * An anonymous `namespace { … }` and a file-scope `static` both give internal
 * linkage: the name cannot be reached from another translation unit however
 * many files include this one. Saying so is what keeps a helper called `parse`
 * in one `.c` from answering a `parse()` written in another.
 */
interface Scope {
  /** The namespaces open at this point, outermost first, anonymous ones dropped. */
  namespaces: readonly string[];
  internal: boolean;
}

/** `static` at file scope, which in C and C++ means "not outside this file". */
function isStatic(node: SyntaxNode): boolean {
  return node.children.some((child) => child.type === 'storage_class_specifier' && child.text === 'static');
}

const VISIBILITIES: ReadonlySet<string> = new Set(['public', 'private', 'protected']);

type Visibility = 'public' | 'private' | 'protected';

/**
 * The visibility a class body starts in. C++ *states* this by choosing the
 * keyword — `struct` is public and `class` is private — so reporting it is
 * reporting what was written, not inferring a default the way TypeScript's
 * absent `public` would be.
 */
function defaultVisibility(kind: string): 'public' | 'private' {
  return kind === 'class_specifier' ? 'private' : 'public';
}

/**
 * `class GTEST_API_ Name { … }` — a class whose export macro the grammar reads
 * as its name.
 *
 * Without a preprocessor the macro is only an identifier standing where a class
 * name goes, so the grammar takes *it* for the name and reads everything after
 * it as a function definition: `class GTEST_API_` becomes a bodyless
 * class_specifier, `Name` becomes the declarator, and the class body becomes a
 * compound_statement. No part of that shape is legal C++ — a function
 * definition cannot have a class specifier for its type and a bare identifier
 * for its declarator — so claiming it costs no real code its meaning.
 *
 * It earns the special case because the macro is how a C++ library marks its
 * public API, and the classes wearing one are the classes that matter: 48 of
 * googletest's are written this way, `Mock`, `Cardinality` and `Expectation`
 * among them, and every one of them was missing from the graph. curl, which is
 * C, has none.
 */
function macroClassOf(node: SyntaxNode): { kind: SymbolKind; name: string } | null {
  if (node.type !== 'function_definition') return null;
  const specifier = node.childForFieldName('type');
  const kind = specifier === null ? undefined : TYPE_KINDS.get(specifier.type);
  // A specifier with a body of its own is a real `struct S { … } s;`, which
  // declares a variable and is not this at all.
  if (kind === undefined || specifier === null || specifier.childForFieldName('body') !== null) return null;
  const declarator = node.childForFieldName('declarator');
  if (declarator?.type !== 'identifier') return null;
  if (node.childForFieldName('body')?.type !== 'compound_statement') return null;
  return { kind, name: declarator.text };
}

/**
 * The specifier keyword a body belongs to, which is what decides the visibility
 * it starts in. A macro-named class hides its keyword one level down.
 */
function specifierOf(node: SyntaxNode): string {
  return node.type === 'function_definition' ? (node.childForFieldName('type')?.type ?? node.type) : node.type;
}

/**
 * A callable declaration that writes no return type is not a declaration. It is
 * a macro invocation the grammar had no preprocessor to expand.
 *
 * This is the language and not a convention about capitals: C++ requires a
 * return type on every function and C has since C99, so `TEST(Suite, Name)
 * { … }` and `BIT(flag);` are not functions that forgot one — they are
 * `#define`s standing where a declaration goes, and the grammar reads the macro
 * as the name because the macro is what is written there. **A macro is not a
 * symbol**, and taking these at face value said one googletest file declares
 * 230 functions all called `TEST` and one curl struct has 84 methods all called
 * `BIT`. Neither name is in the vocabulary of the code being described, and the
 * real names — the arguments — are not ours to invent a symbol out of.
 *
 * C++ defines exactly three typeless callables, and each is recognised by what
 * the language says rather than by how it is spelled: a constructor, whose name
 * is its class's; a destructor, `~Name`; and a conversion operator, whose
 * `operator` keyword stands where the return type would.
 */
function isMacroInvocation(name: string, type: SyntaxNode | null, owner: string | null): boolean {
  if (type !== null) return false;
  return name !== owner && !name.startsWith('~') && !name.startsWith('operator');
}

/** Names invoked inside a symbol, and what the file knows about the receivers. */
interface Enclosing {
  /** The class whose body this is, or null at file scope. */
  owner: string | null;
  /** Operations the class declares itself; a bare `m()` inside it is one of them. */
  methods: ReadonlySet<string>;
  /** Field -> its written type, null where the declaration named nothing to land on. */
  fields: ReadonlyMap<string, string | null>;
  /** The `<T>` in reach, which names whatever the caller supplies and never a class. */
  typeParameters: ReadonlySet<string>;
  /**
   * The namespaces this file opens or pulls in with `using namespace`.
   *
   * What decides whether `detail::parse()` is a member call or a free
   * function: `::` names either a class scope or a namespace scope, and only
   * the project can tell them apart. A head the file itself opened is a
   * namespace, so the call is to a free `parse` — and a head it did not is
   * left as `detail.parse`, which resolves only if some class `detail`
   * declares a `parse`, and otherwise reaches nothing at all.
   */
  namespaces: ReadonlySet<string>;
}

/**
 * The type a name was declared with, over one function body.
 *
 * One table for the whole body rather than a scope chain, so a name declared
 * twice is kept only if both declarations agree, and a name bound with no type
 * the graph can use — `auto`, a template parameter, a lambda's argument —
 * refuses the name outright. An untyped receiver is a gap, not a guess: `auto
 * p = make(); p.thing();` reaches nothing, and that is most of modern C++.
 */
function typedNames(body: SyntaxNode, enclosing: Enclosing): Map<string, string | null> {
  const typed = new Map(enclosing.fields);
  const generic = new Set(enclosing.typeParameters);
  for (const parameter of body.descendantsOfType('type_parameter_declaration')) {
    const name = nameOf(parameter.namedChildren[0] ?? null);
    if (name !== null) generic.add(name);
  }

  const bind = (name: string | null, type: SyntaxNode | null): void => {
    if (name === null) return;
    const written = attributeOf(type).typeName ?? null;
    const known = written !== null && generic.has(written) ? null : written;
    if (!typed.has(name)) typed.set(name, known);
    else if (typed.get(name) !== known) typed.set(name, null);
  };

  for (const parameter of body.descendantsOfType(['parameter_declaration', 'optional_parameter_declaration'])) {
    const declarator = declaratorOf(parameter.childForFieldName('declarator'));
    bind(declarator.name, parameter.childForFieldName('type'));
  }
  for (const declaration of body.descendantsOfType(['declaration', 'field_declaration'])) {
    const type = declaration.childForFieldName('type');
    for (const child of declaration.namedChildren) {
      if (child === type) continue;
      const declarator = declaratorOf(child);
      // A local function declaration is not a variable, and neither is the
      // parameter list hanging off it.
      if (declarator.callable || declarator.name === null) continue;
      bind(declarator.name, type);
    }
  }
  // `for (auto& item : items)` and `[](Thing t) { … }` bind names the graph
  // cannot type; refusing them is the point of listing them.
  for (const node of body.descendantsOfType(['for_range_loop', 'lambda_expression'])) {
    if (node.type === 'for_range_loop') bind(declaratorOf(node.childForFieldName('declarator')).name, node.childForFieldName('type'));
  }

  return typed;
}

/**
 * Names invoked inside a symbol, with the subtrees that became symbols of
 * their own left out — a class must not also claim what its methods call, or
 * every call would produce two edges.
 *
 * **The one door into the member namespace is a receiver whose type was
 * written down.** `this->step()` inside Engine is `Engine.step`; `log_.write()`
 * is `Logger.write` when `log_` was declared a Logger; `store->save()` is the
 * same, because `->` and `.` differ only in how the object is reached. A call
 * on an `auto` or on the result of another call contributes nothing — not even
 * the bare method name, which could only ever land on some unrelated free
 * function that happens to share it.
 */
function collectCalls(node: SyntaxNode, exclude: readonly SyntaxNode[], enclosing: Enclosing): string[] {
  const names = new Set<string>();
  const within = (candidate: SyntaxNode): boolean =>
    exclude.some((region) => candidate.startIndex >= region.startIndex && candidate.endIndex <= region.endIndex);
  const typed = typedNames(node, enclosing);

  /** A written-out path, with the namespaces this file opens taken off the front. */
  const qualified = (segments: readonly string[]): string | null => {
    let rest = segments;
    while (rest.length > 1 && enclosing.namespaces.has(rest[0] as string)) rest = rest.slice(1);
    if (rest.length === 1) return rest[0] as string;
    // What is left is `Scope::name`, and the scope is a class as far as anyone
    // here can tell. Only the last two segments: `a::B::c` past the namespaces
    // is B's operation c, and the segments above B are more namespaces the file
    // did not open.
    const owner = rest[rest.length - 2] as string;
    const member = rest[rest.length - 1] as string;
    return `${owner}.${member}`;
  };

  for (const call of node.descendantsOfType('call_expression')) {
    if (within(call)) continue;
    let target = call.childForFieldName('function');
    // `parse<int>()` — the explicit arguments wrap the name they apply to.
    if (target?.type === 'template_function') target = target.childForFieldName('name');
    if (!target) continue;

    if (target.type === 'field_expression') {
      const method = nameOf(target.childForFieldName('field'));
      if (method === null) continue;
      const receiver = target.childForFieldName('argument');
      if (receiver?.type === 'this') {
        if (enclosing.owner !== null) names.add(`${enclosing.owner}.${method}`);
      } else if (receiver?.type === 'identifier') {
        const type = typed.get(receiver.text);
        if (type !== null && type !== undefined) names.add(`${type}.${method}`);
      }
      continue;
    }

    if (target.type === 'qualified_identifier') {
      const segments = segmentsOf(target);
      const name = segments === null ? null : qualified(segments);
      if (name !== null) names.add(name);
      continue;
    }

    const bare = nameOf(target);
    if (bare === null) continue;
    // A bare call inside a class body is its own operation before it is
    // anything else — that is what the class declared it for.
    if (enclosing.owner !== null && enclosing.methods.has(bare)) names.add(`${enclosing.owner}.${bare}`);
    else names.add(bare);
  }

  // `new Widget(...)` is a constructor call, and the name it reaches is the
  // class. A `Widget w;` declaration is not: it names a type, which the field
  // and parameter tables already draw as the relationship it is.
  for (const created of node.descendantsOfType('new_expression')) {
    if (within(created)) continue;
    const name = attributeOf(created.childForFieldName('type')).typeName;
    if (name !== undefined) names.add(name);
  }

  names.delete('');
  return [...names];
}

/**
 * The bare type names an operation's signature writes — its parameters and its
 * return — which is UML's dependency. A type parameter is never one: it names
 * whatever the caller supplies.
 */
function signatureTypes(type: SyntaxNode | null, parameters: SyntaxNode | null, generic: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  const add = (node: SyntaxNode | null): void => {
    const name = attributeOf(node).typeName;
    if (name !== undefined && !generic.has(name)) names.add(name);
  };
  add(type);
  for (const parameter of parameters?.namedChildren ?? []) {
    if (parameter.type === 'parameter_declaration' || parameter.type === 'optional_parameter_declaration') {
      add(parameter.childForFieldName('type'));
    }
  }
  return [...names];
}

/** The names a `template <typename T, int N>` introduces. */
function typeParametersOf(node: SyntaxNode | null): Set<string> {
  const names = new Set<string>();
  for (const parameter of node?.namedChildren ?? []) {
    if (parameter.type === 'type_parameter_declaration' || parameter.type === 'variadic_type_parameter_declaration') {
      const name = nameOf(parameter.namedChildren[0] ?? null);
      if (name !== null) names.add(name);
    } else if (parameter.type === 'parameter_declaration') {
      const name = declaratorOf(parameter.childForFieldName('declarator')).name;
      if (name !== null) names.add(name);
    }
  }
  return names;
}

/**
 * `template <…> class Foo` and `template <…> void f()` — the template is how
 * the declaration is written, not a declaration of its own, so it is unwrapped
 * and the `<T>` it introduces travels with what was inside it.
 */
function unwrapTemplate(node: SyntaxNode): { declaration: SyntaxNode; typeParameters: Set<string> } {
  if (node.type !== 'template_declaration') return { declaration: node, typeParameters: new Set() };
  const typeParameters = typeParametersOf(node.childForFieldName('parameters'));
  const inner = node.namedChildren.find((child) => child.type !== 'template_parameter_list');
  if (inner === undefined) return { declaration: node, typeParameters };
  const nested = unwrapTemplate(inner);
  for (const name of nested.typeParameters) typeParameters.add(name);
  return { declaration: nested.declaration, typeParameters };
}

function makeSymbol(node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol {
  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    implements: [],
    calls: [],
  };
}

/** What one pass over a file collected. */
interface Collected {
  symbols: ParsedSymbol[];
  /** Subtrees already claimed by a symbol, so an enclosing one does not re-read them. */
  claimed: SyntaxNode[];
}

/**
 * A class body's members in document order, each carrying the visibility in
 * force where it was written.
 *
 * The labels are siblings rather than parents in this grammar, so visibility is
 * a running state read in document order — which is exactly how the language
 * defines it.
 *
 * Two body shapes reach this, and the second is one the language forces on us.
 * A `field_declaration_list` is a class body as the grammar means it, with the
 * `public:` labels as `access_specifier` siblings. A `compound_statement` is
 * what a macro-named class leaves behind — see `macroClassOf` — and there the
 * same labels have become `labeled_statement`s that *wrap* the member they
 * precede rather than standing beside it. Unwrapping one is what keeps
 * `Mock`'s operations from being read as statements and dropped.
 */
function memberNodes(body: SyntaxNode, kind: string): { node: SyntaxNode; visibility: Visibility }[] {
  const out: { node: SyntaxNode; visibility: Visibility }[] = [];
  let visibility: Visibility = defaultVisibility(kind);

  const take = (node: SyntaxNode): void => {
    if (node.type === 'access_specifier') {
      if (VISIBILITIES.has(node.text)) visibility = node.text as Visibility;
      return;
    }
    if (node.type === 'labeled_statement') {
      const label = node.childForFieldName('label')?.text ?? '';
      if (VISIBILITIES.has(label)) visibility = label as Visibility;
      for (const child of node.namedChildren) {
        if (child.type !== 'statement_identifier') take(child);
      }
      return;
    }
    if (node.type === 'field_declaration' || node.type === 'declaration' || node.type === 'function_definition') {
      out.push({ node, visibility });
    }
  };

  for (const child of body.namedChildren) take(child);
  return out;
}

/**
 * A class body's members: its attributes, its operations, and where the
 * `public:` / `private:` labels put each of them.
 */
function collectMembers(
  body: SyntaxNode,
  owner: string,
  kind: string,
  typeParameters: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  out: Collected,
): { members: ParsedSymbol[]; dependsOn: string[]; abstract: boolean } {
  const members: ParsedSymbol[] = [];
  const dependsOn = new Set<string>();
  let abstract = false;

  // Two passes: the operations and attributes have to be known before their
  // bodies are read, or `this->step()` in the first method could not be told
  // from a free function declared somewhere behind an include.
  const declared: { node: SyntaxNode; declarator: Declarator; type: SyntaxNode | null; visibility: Visibility }[] = [];
  for (const { node: member, visibility } of memberNodes(body, kind)) {
    const type = member.childForFieldName('type');
    for (const child of member.namedChildren) {
      if (child === type || child.type === 'access_specifier') continue;
      const declarator = declaratorOf(child);
      if (declarator.name === null) continue;
      // Filtered here rather than where members are emitted, so a macro can
      // never join `methodNames` and answer a call written on the class.
      if (declarator.callable && isMacroInvocation(declarator.name, type, owner)) continue;
      declared.push({ node: member, declarator, type, visibility });
      // One member declares one name; a comma list of attributes is rare enough
      // in a class body that reading only the first costs nothing measurable.
      break;
    }
  }

  const methodNames = new Set(declared.filter((entry) => entry.declarator.callable).map((entry) => entry.declarator.name as string));
  const fields = new Map<string, string | null>();
  for (const entry of declared) {
    if (entry.declarator.callable) continue;
    fields.set(entry.declarator.name as string, attributeOf(entry.type).typeName ?? null);
  }

  const enclosing: Enclosing = { owner, methods: methodNames, fields, typeParameters, namespaces };

  for (const { node, declarator, type, visibility: at } of declared) {
    const name = declarator.name as string;
    if (declarator.callable) {
      // `virtual void run() = 0;` — the grammar leaves the `0` a sibling of the
      // declarator, and it is the only thing that makes the operation abstract.
      const pure = node.namedChildren.some((child) => child.type === 'number_literal' && child.text === '0');
      if (pure) abstract = true;
      members.push({
        ...makeSymbol(node, name, 'method'),
        owner,
        visibility: at,
        ...(isStatic(node) ? { isStatic: true } : {}),
        ...(pure ? { isAbstract: true } : {}),
        calls: node.type === 'function_definition' ? collectCalls(node, [], enclosing) : [],
      });
      if (node.type === 'function_definition') out.claimed.push(node);
      for (const named of signatureTypes(type, declarator.parameters, typeParameters)) dependsOn.add(named);
      continue;
    }
    members.push({
      ...makeSymbol(node, name, 'field'),
      owner,
      visibility: at,
      ...(isStatic(node) ? { isStatic: true } : {}),
      ...attributeFields(fieldAttribute(type, declarator)),
    });
  }

  // A constructor's member-initialiser list says where each part came from:
  // `: log_(l)` for a parameter `l` is UML's aggregation, `: cache_(new Cache)`
  // is composition the source spelled out. Read after the fields exist, because
  // it is the field it is written about.
  const byName = new Map(members.filter((member) => member.kind === 'field').map((member) => [member.name, member]));
  const constructors = declared.filter((entry) => entry.declarator.callable && entry.declarator.name === owner);
  for (const { node, declarator } of constructors) {
    const parameters = new Set<string>();
    for (const parameter of declarator.parameters?.namedChildren ?? []) {
      const bound = declaratorOf(parameter.childForFieldName('declarator')).name;
      if (bound !== null) parameters.add(bound);
    }
    for (const initializer of node.descendantsOfType('field_initializer')) {
      const field = byName.get(nameOf(initializer.namedChildren[0] ?? null) ?? '');
      if (field === undefined) continue;
      const value = initializer.namedChildren[1];
      const handed = value?.namedChildren.some((child) => child.type === 'identifier' && parameters.has(child.text));
      if (handed === true) field.handedIn = true;
    }
  }

  return { members, dependsOn: [...dependsOn], abstract };
}

/**
 * A class, a struct and a union are one thing on a diagram.
 *
 * A C++ struct *is* a class — the only difference the language draws is which
 * visibility its body starts in, and that is reported on the members. A union
 * is a class whose attributes share storage, which UML has no notation for and
 * which changes nothing about who reaches whom.
 *
 * An enum is a `type`: it has no operations, so nothing can be contained by it,
 * and calling it a class would give the store an owner nothing is ever written
 * for. Rust's enums are classes here because `impl` gives them methods; C++'s
 * cannot have any.
 */
const TYPE_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_specifier', 'class'],
  ['struct_specifier', 'class'],
  ['union_specifier', 'class'],
  ['enum_specifier', 'type'],
]);

/**
 * Every base a class names, as extends and never as implements.
 *
 * C++ has no interfaces. A base with nothing but pure virtuals is one by
 * convention, and a convention is not the language — telling the two apart
 * would mean resolving the base, which a file parsed alone cannot do. So
 * multiple inheritance is several extends edges, which is what UML draws for
 * it anyway.
 */
function basesOf(declaration: SyntaxNode): string[] {
  // A macro-named class derails the grammar at exactly the `:`, so its base
  // clause survives only as an ERROR node — whose text still begins with the
  // `:` and whose named children are still the bases, the `public` and
  // `virtual` keywords being anonymous tokens. Reading it is reading the same
  // list from the same place, and refusing to would drop every supertype of
  // the 48 classes `macroClassOf` exists to recover.
  const clause = declaration.namedChildren.find(
    (child) => child.type === 'base_class_clause' || (child.type === 'ERROR' && child.text.startsWith(':')),
  );
  const names: string[] = [];
  for (const child of clause?.namedChildren ?? []) {
    if (child.type === 'access_specifier') continue;
    const name = attributeOf(child).typeName;
    if (name !== undefined) names.push(name);
  }
  return names;
}

/** One class, struct, union or enum, with its members. */
function collectType(
  node: SyntaxNode,
  kind: SymbolKind,
  name: string,
  scope: Scope,
  typeParameters: ReadonlySet<string>,
  namespaces: ReadonlySet<string>,
  out: Collected,
): void {
  const body = node.childForFieldName('body');
  const symbol: ParsedSymbol = {
    ...makeSymbol(node, name, kind),
    extends: basesOf(node),
    exported: !scope.internal,
  };

  if (kind === 'class' && body !== null) {
    const { members, dependsOn, abstract } = collectMembers(body, name, specifierOf(node), typeParameters, namespaces, out);
    // C++ has no `abstract` keyword; a pure virtual operation is how the source
    // says it, so reporting it is reporting what was written.
    if (abstract) symbol.isAbstract = true;
    if (dependsOn.length > 0) symbol.dependsOn = dependsOn;
    // The class before its members: the store builds its owner table in one
    // pass over this list, so a member arriving first would attach to the file.
    out.symbols.push(symbol, ...members);
    out.claimed.push(node);
    return;
  }

  out.symbols.push(symbol);
  out.claimed.push(node);
}

/**
 * A function written at file scope, whether it is a definition or the prototype
 * a header carries.
 *
 * Both are symbols, and they are usually two files apart — `foo.h` declares
 * `doThing` and `foo.c` defines it. Two boxes with a row each is the truth: the
 * header is what other files include and reach, the source is where the body
 * lives. Nothing pairs them, and see `cpp.resolve` for why no edge is invented
 * between the two files either.
 */
function collectFunction(node: SyntaxNode, scope: Scope, typeParameters: ReadonlySet<string>, namespaces: ReadonlySet<string>, out: Collected): void {
  const type = node.childForFieldName('type');
  const declarator = declaratorOf(node.childForFieldName('declarator'));
  if (declarator.name === null || !declarator.callable) return;

  const segments = segmentsOf(node.childForFieldName('declarator')?.childForFieldName('declarator') ?? null);
  // `void app::Engine::step() { … }` — an operation defined away from the class
  // that declared it. Everything before the last segment is namespaces and the
  // owning class, and the one just before the name is the owner. The store
  // attaches it to the class when the class is in this file and to the file
  // when it is not, which is the honest answer: the declaration is over there.
  let owner: string | null = null;
  let name = declarator.name;
  if (segments !== null && segments.length > 1) {
    let rest = segments;
    while (rest.length > 1 && namespaces.has(rest[0] as string)) rest = rest.slice(1);
    if (rest.length > 1) owner = rest[rest.length - 2] as string;
    name = rest[rest.length - 1] as string;
  }

  const enclosing: Enclosing = {
    owner,
    methods: new Set(owner === null ? [] : [name]),
    fields: new Map(),
    typeParameters,
    namespaces,
  };

  if (isMacroInvocation(name, type, owner)) return;

  const symbol: ParsedSymbol = {
    ...makeSymbol(node, name, owner === null ? 'function' : 'method'),
    ...(owner === null ? {} : { owner }),
    ...(owner === null ? { exported: !scope.internal } : {}),
    ...(isStatic(node) ? { isStatic: true } : {}),
    calls: node.type === 'function_definition' ? collectCalls(node, [], enclosing) : [],
  };
  out.symbols.push(symbol);
  out.claimed.push(node);
}

/**
 * `typedef struct node { … } node_t;` and `using Alias = std::vector<int>;`.
 *
 * C's anonymous `typedef struct { … } foo_t` is the common case and the one
 * that decides the shape: the struct has no name of its own, so the typedef's
 * is the only one anybody can write, and the class takes it. When the struct
 * *is* named, the class keeps its own name and the alias becomes a `type` of
 * its own — which is what a typedef is.
 */
function collectTypedef(node: SyntaxNode, scope: Scope, namespaces: ReadonlySet<string>, out: Collected): void {
  const type = node.childForFieldName('type');
  const kind = type === null ? undefined : TYPE_KINDS.get(type.type);
  const alias = declaratorOf(node.childForFieldName('declarator')).name;

  if (type !== null && kind !== undefined) {
    const tag = nameOf(type.childForFieldName('name'));
    const name = tag ?? alias;
    if (name !== null) collectType(type, kind, name, scope, new Set(), namespaces, out);
    if (tag !== null && alias !== null && alias !== tag) {
      out.symbols.push({ ...makeSymbol(node, alias, 'type'), exported: !scope.internal });
    }
    out.claimed.push(node);
    return;
  }

  if (alias === null) return;
  out.symbols.push({ ...makeSymbol(node, alias, 'type'), exported: !scope.internal });
  out.claimed.push(node);
}

/** `using Alias = T;`, which is the same statement written the modern way. */
function collectAlias(node: SyntaxNode, scope: Scope, out: Collected): void {
  const name = nameOf(node.childForFieldName('name') ?? node.namedChildren[0] ?? null);
  if (name === null) return;
  out.symbols.push({ ...makeSymbol(node, name, 'type'), exported: !scope.internal });
  out.claimed.push(node);
}

/**
 * Every namespace the file opens, and every one it pulls in with
 * `using namespace`.
 *
 * Read over the whole file before any call is, because a `using namespace
 * detail;` at the top of a source file governs a call written 900 lines below
 * it, and a `namespace fmt { … }` reopened at the bottom governs the one at the
 * top just the same.
 *
 * An anonymous namespace contributes no name, only internal linkage.
 */
function namespacesOf(root: SyntaxNode): Set<string> {
  const names = new Set<string>();
  for (const node of root.descendantsOfType('namespace_definition')) {
    for (const child of node.namedChildren) {
      if (child.type === 'namespace_identifier') names.add(child.text);
      // `namespace a::b { … }` opens both.
      if (child.type === 'nested_namespace_specifier') {
        for (const segment of child.namedChildren) names.add(segment.text);
      }
    }
  }
  for (const node of root.descendantsOfType('using_declaration')) {
    if (!node.text.includes('namespace')) continue;
    const segments = segmentsOf(node.namedChildren[0] ?? null);
    for (const segment of segments ?? []) names.add(segment);
  }
  return names;
}

/** Walk a declaration list, descending into namespaces rather than drawing them. */
function collectScope(node: SyntaxNode, scope: Scope, typeParameters: ReadonlySet<string>, namespaces: ReadonlySet<string>, out: Collected): void {
  for (const child of node.namedChildren) {
    const { declaration, typeParameters: introduced } = unwrapTemplate(child);
    const inScope = introduced.size === 0 ? typeParameters : new Set([...typeParameters, ...introduced]);

    if (declaration.type === 'namespace_definition') {
      const named = declaration.namedChildren.filter(
        (grandchild) => grandchild.type === 'namespace_identifier' || grandchild.type === 'nested_namespace_specifier',
      );
      const body = declaration.childForFieldName('body');
      if (body === null) continue;
      // A namespace is descended into and is never a symbol. It is not a
      // classifier — it has no attributes, no operations and nothing can
      // extend it — and making it one would give every class in `namespace
      // fmt` an owner and turn 300 classes into methods. The name it supplies
      // is used for reading calls, which is what it is for; see `Enclosing`.
      const inner: Scope = {
        namespaces: [...scope.namespaces, ...named.map((identifier) => identifier.text)],
        internal: scope.internal || named.length === 0,
      };
      collectScope(body, inner, inScope, namespaces, out);
      continue;
    }

    const kind = TYPE_KINDS.get(declaration.type);
    if (kind !== undefined) {
      const name = nameOf(declaration.childForFieldName('name'));
      // `class A;` with no body is a forward declaration: a promise that the
      // name exists, made so a pointer to it can be written. The class it
      // promises is declared somewhere else, and drawing a second box for it
      // here would put one class in two places.
      if (name !== null && declaration.childForFieldName('body') !== null) {
        collectType(declaration, kind, name, scope, inScope, namespaces, out);
      }
      continue;
    }

    switch (declaration.type) {
      case 'function_definition': {
        // A macro-named class wears a function definition's shape; it is a
        // class everywhere else, so it takes the class path.
        const macroClass = macroClassOf(declaration);
        if (macroClass !== null) {
          collectType(declaration, macroClass.kind, macroClass.name, scope, inScope, namespaces, out);
        } else {
          collectFunction(declaration, scope, inScope, namespaces, out);
        }
        break;
      }
      case 'declaration': {
        // A prototype, or a variable. Only the first is a symbol.
        const declarator = declaratorOf(declaration.childForFieldName('declarator'));
        if (declarator.callable) collectFunction(declaration, scope, inScope, namespaces, out);
        break;
      }
      case 'type_definition':
        collectTypedef(declaration, scope, namespaces, out);
        break;
      case 'alias_declaration':
        collectAlias(declaration, scope, out);
        break;
      case 'linkage_specification': {
        // `extern "C" { … }` is a linkage statement, not a scope.
        const body = declaration.childForFieldName('body');
        if (body !== null) collectScope(body, scope, inScope, namespaces, out);
        else collectScope(declaration, scope, inScope, namespaces, out);
        break;
      }
      // A conditional block is not a scope either, and descending into it is
      // not optional: the include guard is how every C and C++ header is
      // written, so `#ifndef GTEST_FOO_H_` wraps the *entire* contents of the
      // file. Stopping at it read googletest as 373 classes and 4045 symbols
      // rather than 800 and 7443, and curl as 3582 symbols rather than 11302,
      // and left `gtest-assertion-result.h` — a header whose whole job is to
      // declare one class — with no symbols at all.
      //
      // Both branches of an `#if / #else` are walked. The file does declare
      // both, and which one a compiler would take is a question about a
      // command line the graph has not got; the store already tells two
      // same-named symbols in one file apart by document order.
      case 'preproc_ifdef':
      case 'preproc_if':
      case 'preproc_else':
      case 'preproc_elif':
      case 'preproc_elifdef':
        collectScope(declaration, scope, inScope, namespaces, out);
        break;
      default:
        break;
    }
  }
}

/**
 * The includes a file wrote, with the delimiter kept.
 *
 * The delimiter is not punctuation, it is the whole difference between a file
 * this project wrote and a header from outside it, and `resolve` is handed the
 * specifier and nothing else. So a quoted include arrives as `"a/b.h"` and an
 * angled one as `<a/b.h>`, exactly as the source spelled them.
 *
 * `#include SOME_MACRO` names neither and is skipped: there is nothing here to
 * resolve and nothing to count.
 */
function includesOf(root: SyntaxNode): string[] {
  const out = new Set<string>();
  for (const node of root.descendantsOfType('preproc_include')) {
    const target = node.childForFieldName('path');
    if (target === null) continue;
    if (target.type === 'system_lib_string') out.add(target.text);
    else if (target.type === 'string_literal') out.add(target.text.replace(/^L?u?8?R?/, ''));
  }
  return [...out];
}

/**
 * The declared include directories a compiler would be handed on the command
 * line, read off the project's own shape instead — cached by the file set it
 * was built from.
 *
 * Every directory named `include` (or `inc`, or `includes`), and the directory
 * *above* each of those. That is what lands googletest's `"gtest/gtest.h"` on
 * `googletest/include/gtest/gtest.h` and curl's `<curl/curl.h>` on
 * `include/curl/curl.h`; the parent of an include directory is a root because
 * that is where a project's own `src` sits beside its public headers, which is
 * how googletest reaches `"src/gtest-internal-inl.h"`.
 *
 * These are the roots no ancestor walk can find, because they are not above the
 * file that includes them — `googletest/src/gtest.cc` is nowhere under
 * `googletest/include`.
 */
let indexed: { files: ReadonlySet<string>; roots: readonly string[] } | null = null;

const INCLUDE_DIRECTORIES: ReadonlySet<string> = new Set(['include', 'inc', 'includes']);

function rootsOf(files: ReadonlySet<string>): readonly string[] {
  if (indexed?.files === files) return indexed.roots;

  const roots = new Set<string>();
  for (const file of files) {
    const segments = file.split('/');
    for (let at = 0; at < segments.length - 1; at += 1) {
      if (!INCLUDE_DIRECTORIES.has(segments[at] as string)) continue;
      roots.add(segments.slice(0, at + 1).join('/'));
      roots.add(segments.slice(0, at).join('/'));
    }
  }

  // Longest first, so a real include directory answers before the bare parent
  // it also contributed.
  indexed = { files, roots: [...roots].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)) };
  return indexed.roots;
}

/**
 * Every directory above a file, nearest first, ending at the project root.
 *
 * An include path is written relative to *some* root the build declares, and
 * the roots a project actually declares are almost always above the file doing
 * the including: its own directory, the source root it sits in, the project
 * root. Walking ancestors says that without having to name `lib` or `src`, and
 * naming them is what a convention would be.
 *
 * curl is the case that forces it, and it is not a corner: `lib/curlx/base64.c`
 * writes `#include "curl_setup.h"` for `lib/curl_setup.h` and
 * `#include "curlx/base64.h"` for the file beside it, because the build passes
 * `-I lib`. Without the walk 1004 of curl's 3005 quoted includes resolved to
 * nothing and `lib/curl_setup.h` — the header nearly every source in the
 * project opens with — was drawn with 4 dependents instead of 500.
 *
 * Nearest first is the compiler's own preference, and it is what keeps two
 * files of the same name in different subtrees from answering for each other.
 */
function ancestorsOf(from: string): string[] {
  const out: string[] = [];
  let at = from.lastIndexOf('/');
  while (at > 0) {
    out.push(from.slice(0, at));
    at = from.lastIndexOf('/', at - 1);
  }
  out.push('');
  return out;
}

const CPP_ID: LanguageId = 'cpp';

// `satisfies` rather than a `: LanguageSupport` annotation so the object keeps
// the literal types the registry reads; the contract is checked all the same.
export const cpp = {
  id: CPP_ID,
  label: 'C/C++',
  extensions: ['.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.hxx'],

  grammar(filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    if (filePath.toLowerCase().endsWith(C_ONLY)) return (cGrammar ??= require('tree-sitter-c'));
    return (cppGrammar ??= require('tree-sitter-cpp'));
  },

  extract(root: SyntaxNode, _source: string): LanguageParse {
    const namespaces = namespacesOf(root);
    const out: Collected = { symbols: [], claimed: [] };
    collectScope(root, { namespaces: [], internal: false }, new Set(), namespaces, out);

    return {
      imports: includesOf(root),
      symbols: out.symbols,
      // No bindings, and that is the language rather than a shortfall.
      // `#include` is a wildcard — it brings in every name the header declares
      // and names none of them — so the file cannot list what it bound, and the
      // store's whole-table rule over the headers this file actually included
      // is exactly C++'s own lookup. Its edges wear `guessed`, which is the
      // honest mark for a name the file did not write down.
      //
      // No `calls` either: C and C++ have no top level worth the name. What
      // little runs before `main` is a static initialiser, and collecting them
      // would roughly double the parse for a handful of edges.
    };
  },

  /**
   * An include to a file, and the two forms mean different things.
   *
   * A quoted include is tried against the including file's own directory first
   * — that is what the quotes are for — then against every directory above it,
   * nearest first, and last against the project's declared include roots. An
   * angled include skips only the first of those: the language says the file's
   * own directory is not searched, but a `-I` root is, and every ancestor is
   * standing in for a `-I` root here.
   *
   * **An angled include that lands nowhere is not a miss.** `<vector>` and
   * `<sys/socket.h>` did not resolve and nothing is missing; they are the
   * system, and counting them would put the "lost coupling" mark on every file
   * in the project — 1006 of curl's 1161 angled includes and all 617 of
   * googletest's are exactly that. But some are not: the other 155 of curl's
   * name `include/curl/curl.h` and its five siblings, its own public API, so
   * they are *resolved* like any other and only their failures are ignored.
   * See the note in `looksInternal` for where that ignoring is spelled out.
   *
   * A header and its `.cpp` get no edge of their own. The `.cpp` includes the
   * header, so the import edge is already there and says the true thing: the
   * source file is one more consumer of the header's declarations. Pairing them
   * by matching stems would be a convention rather than the language — a `.cpp`
   * need not include the header named after it, and several sources routinely
   * define parts of one header — and the graph has no edge kind for "defines"
   * that would not simply restate the include.
   */
  resolve(context: ResolveContext): string | null {
    const { from, specifier, files } = context;
    const quoted = specifier.startsWith('"');
    const target = specifier.slice(1, -1);
    if (target === '') return null;

    // A `..` in the path is the file's own directory's business, so it is
    // normalised against each root rather than once against the project.
    const ancestors = ancestorsOf(from);
    for (const root of quoted ? ancestors : ancestors.slice(1)) {
      const candidate = path.posix.normalize(root === '' ? target : `${root}/${target}`);
      if (files.has(candidate)) return candidate;
    }

    for (const root of rootsOf(files)) {
      const candidate = path.posix.normalize(root === '' ? target : `${root}/${target}`);
      if (files.has(candidate)) return candidate;
    }
    return null;
  },
} satisfies LanguageSupport;

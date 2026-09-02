import { createRequire } from 'node:module';

import type { ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * A Java enum is a class, where a TypeScript enum is a 'type'.
 *
 * The TypeScript module's reason for 'type' was that an enum there has no
 * operations and no instances. A Java enum has both — its constants *are* its
 * instances, it declares fields and methods, and it can implement an interface —
 * so a UML class box says what it is. A record is a final class with its
 * components fixed; an annotation is an interface, in the language and in the
 * bytecode.
 */
const TYPE_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['record_declaration', 'class'],
  ['enum_declaration', 'class'],
  ['interface_declaration', 'interface'],
  ['annotation_type_declaration', 'interface'],
]);

/** Members that are operations, whatever the syntax calls them. */
const METHOD_NODES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'annotation_type_element_declaration',
]);

/**
 * Java has no casing rule, but it has a convention every real project follows:
 * packages and variables are lowerCamelCase and types are not. That is what
 * separates `Helper` from `writer` in `Helper.go()` and `writer.value()`, and
 * the package segments from the type in `com.example.deep.Deep`.
 *
 * Written as "not lower-case" rather than "upper-case" because the convention
 * that holds is the one about packages and variables. A generated type is
 * spelled `$Gson$Types` or `_Impl` and is still a type; nothing is ever a
 * package or a local named that way. Getting this wrong costs a lookup that
 * finds nothing, never a wrong edge: the resolver still has to find a file whose
 * declared package matches.
 */
function looksLikeType(name: string): boolean {
  const first = name[0];
  return first !== undefined && !(first >= 'a' && first <= 'z');
}

/**
 * The receiver of a qualified call or field access, when it names a type rather
 * than a variable: the `Streams` in `Streams.write(…)`, the `UnsafeAllocator` in
 * `UnsafeAllocator.INSTANCE`. A same-package static utility is reached this way
 * and no other, so a file that only uses one leaves no other trace of it.
 */
function receiverOf(node: SyntaxNode): string | null {
  const receiver = node.childForFieldName('object');
  if (receiver?.type !== 'identifier' || !looksLikeType(receiver.text)) return null;
  return receiver.text;
}

/** A type expression reduced to the one name an edge can be drawn to. */
function typeNameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'type_identifier':
    case 'identifier':
      return node.text;
    case 'scoped_type_identifier':
      // `LinkedTreeMap.Node` and `com.example.deep.Deep` both name their tail.
      return node.text.slice(node.text.lastIndexOf('.') + 1);
    case 'generic_type':
      return typeNameOf(node.namedChildren[0] ?? null);
    case 'array_type':
      return typeNameOf(node.childForFieldName('element'));
    case 'annotated_type':
      // `@Nullable Foo` — the annotation comes first, the type is last.
      return typeNameOf(node.namedChildren[node.namedChildren.length - 1] ?? null);
    default:
      // A primitive or `void`. Nothing in the project to point at.
      return null;
  }
}

/**
 * The collections whose element is the association's real target. `List<Thing>`
 * is many Things, not one List, and `Map<String, Thing>` is many Things keyed by
 * a String — UML's qualified association, and the value is the end that matters.
 */
const ELEMENT_AT: ReadonlyMap<string, number> = new Map([
  ['List', 0],
  ['Set', 0],
  ['Collection', 0],
  ['Iterable', 0],
  ['Queue', 0],
  ['Deque', 0],
  ['Map', 1],
]);

function associationOf(type: SyntaxNode | null): { typeName?: string; many?: boolean } {
  if (!type) return {};

  if (type.type === 'array_type') {
    const name = typeNameOf(type.childForFieldName('element'));
    return name === null ? { many: true } : { typeName: name, many: true };
  }

  if (type.type === 'generic_type') {
    const base = typeNameOf(type.namedChildren[0] ?? null);
    const at = base === null ? undefined : ELEMENT_AT.get(base);
    if (at === undefined) return base === null ? {} : { typeName: base };

    const args = type.namedChildren.find((child) => child.type === 'type_arguments');
    const element = typeNameOf(args?.namedChildren[at] ?? null);
    return element === null ? { many: true } : { typeName: element, many: true };
  }

  const name = typeNameOf(type);
  return name === null ? {} : { typeName: name };
}

/**
 * UML's three, read off the declaration. Absent means the source did not say,
 * which in Java is package-private — a fourth visibility the graph model has no
 * room for, and one that reads better as "not written" than as a guess.
 */
function modifiersOf(node: SyntaxNode): Pick<ParsedSymbol, 'visibility' | 'isStatic' | 'isAbstract'> {
  const modifiers = node.namedChildren.find((child) => child.type === 'modifiers');
  if (!modifiers) return {};

  let visibility: ParsedSymbol['visibility'];
  let isStatic = false;
  let isAbstract = false;

  for (const child of modifiers.children) {
    if (child.type === 'public' || child.type === 'private' || child.type === 'protected') {
      visibility = child.type;
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
 * Every name invoked inside a symbol, with the subtrees that became symbols of
 * their own left out — a class must not claim what its methods and its nested
 * classes call, or every call would produce two edges and double the weight on
 * the one that gets drawn.
 *
 * A qualified call contributes its *receiver*, not its method: `Helper.go()`
 * reaches the class Helper, and `go` alone could never resolve because members
 * stay out of the graph's name table on purpose.
 */
function collectCalls(node: SyntaxNode, exclude: readonly SyntaxNode[] = []): string[] {
  const names = new Set<string>();
  const inside = (candidate: SyntaxNode): boolean =>
    exclude.some((skip) => candidate.startIndex >= skip.startIndex && candidate.endIndex <= skip.endIndex);

  for (const call of node.descendantsOfType('method_invocation')) {
    if (inside(call)) continue;
    const receiver = receiverOf(call);
    if (receiver) names.add(receiver);
  }
  for (const created of node.descendantsOfType('object_creation_expression')) {
    if (inside(created)) continue;
    const name = typeNameOf(created.childForFieldName('type'));
    if (name) names.add(name);
  }

  return [...names];
}

function heritageOf(declaration: SyntaxNode): { extends: string[]; implements: string[] } {
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];

  for (const child of declaration.namedChildren) {
    if (child.type === 'superclass') {
      const name = typeNameOf(child.namedChildren[0] ?? null);
      if (name) extendsNames.push(name);
      continue;
    }
    // `implements A, B` on a class, `extends A, B` on an interface: one is
    // realisation and the other generalisation, and both arrive as a type_list.
    const target =
      child.type === 'super_interfaces' ? implementsNames
      : child.type === 'extends_interfaces' ? extendsNames
      : null;
    if (!target) continue;
    for (const list of child.namedChildren) {
      if (list.type !== 'type_list') continue;
      for (const reference of list.namedChildren) {
        const name = typeNameOf(reference);
        if (name) target.push(name);
      }
    }
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
  /** Simple names a single-type import already binds, so the package cannot. */
  bound: Set<string>;
}

/** One member of a type body, or nothing if the node is not a member. */
function collectMember(member: SyntaxNode, owner: string, symbols: ParsedSymbol[]): SyntaxNode | null {
  const common = {
    owner,
    startLine: member.startPosition.row + 1,
    endLine: member.endPosition.row + 1,
    extends: [],
    implements: [],
    ...modifiersOf(member),
  };

  if (METHOD_NODES.has(member.type)) {
    // A constructor's name node is the type's own name, which is what a UML
    // operation compartment shows for it too.
    const name = member.childForFieldName('name')?.text ?? owner;
    symbols.push({ ...common, name, kind: 'method', calls: collectCalls(member) });
    return member;
  }

  // A field keeps what its initialiser calls, and is not returned as claimed, so
  // the enclosing type keeps it too — the same split the TypeScript module makes,
  // where only a method body is taken away from its class.
  if (member.type === 'field_declaration' || member.type === 'constant_declaration') {
    const association = associationOf(member.childForFieldName('type'));
    for (const declarator of member.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name')?.text;
      // `int a, b;` is two fields sharing one type and one line range.
      if (name) {
        symbols.push({ ...common, name, kind: 'field', calls: collectCalls(member), ...association });
      }
    }
    return null;
  }

  if (member.type === 'enum_constant') {
    const name = member.childForFieldName('name')?.text;
    // Constants are the enum's instances, so they are its attributes — static
    // and of its own type, which the diagram already knows from the owner.
    if (name) symbols.push({ ...common, name, kind: 'field', calls: collectCalls(member), isStatic: true });
    return null;
  }

  return null;
}

/**
 * One type declaration and everything inside it.
 *
 * A nested type becomes a top-level symbol of its own rather than a member,
 * matching what the TypeScript module does with a namespace's contents: the
 * graph keys owners by type name and keeps an owned symbol out of the file's
 * name table, so owning a nested class would cost every edge into it in
 * exchange for one more level of nesting in a box.
 */
function collectType(node: SyntaxNode, kind: SymbolKind, out: Collected): void {
  const name = node.childForFieldName('name')?.text;
  if (!name) return;

  const members: ParsedSymbol[] = [];
  const nested: SyntaxNode[] = [];
  /** Subtrees whose calls belong to something other than this type. */
  const claimed: SyntaxNode[] = [];

  // A record declares its state in its header, not its body. Skipping the
  // components would leave a box holding only the methods, if any, of a type
  // whose whole point is the data it carries.
  const components =
    node.type === 'record_declaration'
      ? node.namedChildren.find((child) => child.type === 'formal_parameters')
      : undefined;
  if (components) {
    for (const parameter of components.namedChildren) {
      const component = parameter.childForFieldName('name')?.text;
      if (!component) continue;
      members.push({
        name: component,
        kind: 'field',
        owner: name,
        startLine: parameter.startPosition.row + 1,
        endLine: parameter.endPosition.row + 1,
        extends: [],
        implements: [],
        calls: [],
        ...associationOf(parameter.childForFieldName('type')),
      });
    }
  }

  const body = node.childForFieldName('body');
  for (const child of body?.namedChildren ?? []) {
    // An enum's constants and its declarations sit in separate wrappers.
    const children = child.type === 'enum_body_declarations' ? child.namedChildren : [child];
    for (const entry of children) {
      if (TYPE_KINDS.has(entry.type)) {
        nested.push(entry);
        claimed.push(entry);
        continue;
      }
      const taken = collectMember(entry, name, members);
      if (taken) claimed.push(taken);
    }
  }

  const heritage = heritageOf(node);
  out.symbols.push({
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: heritage.extends,
    implements: heritage.implements,
    calls: collectCalls(node, claimed),
    ...modifiersOf(node),
  });
  out.symbols.push(...members);

  for (const child of nested) {
    const nestedKind = TYPE_KINDS.get(child.type);
    if (nestedKind) collectType(child, nestedKind, out);
  }
}

function collectTopLevel(node: SyntaxNode, out: Collected): void {
  if (node.type === 'package_declaration' || node.type === 'import_declaration') {
    // Searched for rather than taken positionally: a package-info.java may
    // annotate its package — gson's own carries `@CheckReturnValue` — and the
    // annotation is the first named child, ahead of the name it decorates.
    const reference = node.namedChildren.find(
      (child) => child.type === 'scoped_identifier' || child.type === 'identifier',
    );
    if (!reference) return;

    if (node.type === 'package_declaration') {
      out.packageName = reference.text;
      return;
    }

    // `import com.x.*` names a package; every other form names a type, or a
    // static member of one, and the resolver strips the member itself.
    if (node.children.some((child) => child.type === 'asterisk')) {
      if (node.children.some((child) => child.type === 'static')) out.imports.push(reference.text);
      else out.wildcards.push(reference.text);
      return;
    }

    out.imports.push(reference.text);
    const simple = reference.text.slice(reference.text.lastIndexOf('.') + 1);
    out.bound.add(simple);
    return;
  }

  const kind = TYPE_KINDS.get(node.type);
  if (kind) collectType(node, kind, out);
  // `module-info.java` declares no types and imports nothing, so its
  // module_declaration falls through here on purpose.
}

/**
 * The simple type names a file mentions that nothing has bound to a package yet.
 *
 * These are the implicit references: Java resolves an unqualified name against
 * the current package and the on-demand imports without writing anything down,
 * so a same-package dependency leaves no trace in the source at all. Names the
 * file declares itself, binds with a single-type import, or introduces as a type
 * parameter are already accounted for.
 */
function unboundNames(root: SyntaxNode, out: Collected): string[] {
  const declared = new Set(out.symbols.filter((symbol) => symbol.owner === undefined).map((s) => s.name));
  const parameters = new Set(
    root
      .descendantsOfType('type_parameter')
      .map((parameter) => parameter.namedChildren[0]?.text)
      .filter((name): name is string => name !== undefined),
  );

  const names = new Set<string>();
  for (const reference of root.descendantsOfType('type_identifier')) names.add(reference.text);
  // An annotation's name is an identifier rather than a type, and `@Expose` is
  // as real a dependency on its declaring file as any field type.
  for (const annotation of root.descendantsOfType(['annotation', 'marker_annotation'])) {
    const name = annotation.childForFieldName('name')?.text;
    if (name) names.add(name);
  }
  for (const qualified of root.descendantsOfType(['method_invocation', 'field_access'])) {
    const receiver = receiverOf(qualified);
    if (receiver) names.add(receiver);
  }

  return [...names].filter(
    (name) => looksLikeType(name) && !declared.has(name) && !parameters.has(name) && !out.bound.has(name),
  );
}

/**
 * Separates the packages one unbound name could have come from, in the order the
 * compiler tries them. Not a character any Java package or type name can hold,
 * so it cannot collide with a name a file actually wrote.
 *
 * One reference is one specifier because one reference is one edge. Offering the
 * candidates as separate imports let each resolve on its own, and a name declared
 * both in the file's package and in an on-demand import drew two edges for a
 * reference the language binds exactly once.
 */
const CANDIDATES = '|';

/** basename -> the files that have it, so resolution is not a scan per import. */
const indexes = new WeakMap<ReadonlySet<string>, Map<string, string[]>>();

function fileIndex(files: ReadonlySet<string>): Map<string, string[]> {
  const cached = indexes.get(files);
  if (cached) return cached;

  const index = new Map<string, string[]>();
  for (const file of files) {
    if (!file.endsWith('.java')) continue;
    const base = file.slice(file.lastIndexOf('/') + 1);
    const found = index.get(base);
    if (found) found.push(file);
    else index.set(base, [file]);
  }
  // Keyed on the file set itself, which the graph rebuilds whenever it changes,
  // so the index cannot outlive the set it describes.
  indexes.set(files, index);
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
 * Which of the files named `Type.java` is the one in `packageName`.
 *
 * The declared package is what the language actually resolves against, so it
 * wins outright; the path is a fallback for a file the modules map has nothing
 * for. Between two equally good answers the nearer one takes it, which is how a
 * project with several source roots keeps a test on the test copy of a class:
 * a file under `src/test/java` shares three leading segments with its neighbour
 * there and two with the same package under `src/main/java`.
 */
function bestCandidate(
  candidates: readonly string[],
  packageName: string,
  tail: string,
  context: ResolveContext,
): string | null {
  let winner: string | null = null;
  let score = -1;

  for (const candidate of candidates) {
    const declared = context.modules.get(candidate);
    const matches =
      declared === undefined
        ? candidate === tail || candidate.endsWith(`/${tail}`)
        : declared === packageName;
    if (!matches) continue;

    const depth = sharedDepth(candidate, context.from);
    if (depth > score) {
      score = depth;
      winner = candidate;
    }
  }

  return winner;
}

/**
 * One qualified name to the file that declares it.
 *
 * Read right to left, because the tail of a qualified name is not always the
 * type: `com.x.Outer.Inner` is a nested class living in `Outer.java`, and
 * `import static com.x.Truth.assertThat` names a method on one. The first split
 * that finds a file whose *declared* package matches is the answer, so a source
 * root the project never states — `gson/src/main/java` — is never something this
 * has to know.
 */
function declaringFile(specifier: string, context: ResolveContext): string | null {
  const index = fileIndex(context.files);
  const segments = specifier.split('.');

  for (let split = segments.length - 1; split >= 1; split -= 1) {
    const simple = segments[split];
    if (simple === undefined) continue;
    const candidates = index.get(`${simple}.java`);
    if (!candidates) continue;

    const directory = segments.slice(0, split);
    const hit = bestCandidate(
      candidates,
      directory.join('.'),
      `${directory.join('/')}/${simple}.java`,
      context,
    );
    if (hit) return hit;
  }

  return null;
}

export const java: LanguageSupport = {
  id: 'java',
  label: 'Java',
  extensions: ['.java'],

  grammar(_filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    loaded ??= require('tree-sitter-java');
    return loaded;
  },

  /**
   * Imports come out fully qualified, which is not always how they were written.
   *
   * Java's `import` list is only part of what a file depends on: a type in the
   * same package needs no import at all, and an on-demand `import com.x.*` names
   * a package rather than any file in it. Both are resolved by the compiler
   * per *name used*, so that is what this reproduces — every unbound type name
   * the file mentions is offered as the packages it could have come from, the
   * file's own ahead of the wildcards, for the resolver to try in that order.
   *
   * That order is the language's, not a preference. The current package shadows
   * every on-demand import, and two on-demand imports offering the same name is
   * a compile error rather than a choice — so the first package that holds the
   * name is the only one the reference can mean.
   *
   * That is also the answer to what a wildcard should draw. An edge per file in
   * the package is true and unreadable — `import java.util.*` would reach for
   * every file in it. No edge at all silently loses the coupling, which is the
   * failure this whole layer exists to avoid. Expanding it against the names
   * actually used is neither: it is what the language does, and it draws exactly
   * the dependencies the code has.
   */
  extract(root: SyntaxNode, _source: string): LanguageParse {
    const out: Collected = {
      imports: [],
      wildcards: [],
      symbols: [],
      packageName: null,
      bound: new Set(),
    };
    for (const child of root.namedChildren) collectTopLevel(child, out);

    const references = new Set(out.imports);
    // The file's own package first, matching the order the compiler tries them.
    const packages = out.packageName === null ? out.wildcards : [out.packageName, ...out.wildcards];
    if (packages.length > 0) {
      for (const name of unboundNames(root, out)) {
        references.add(packages.map((from) => `${from}.${name}`).join(CANDIDATES));
      }
    }

    return {
      imports: [...references],
      symbols: out.symbols,
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
    for (const candidate of context.specifier.split(CANDIDATES)) {
      const hit = declaringFile(candidate, context);
      if (hit) return hit;
    }
    return null;
  },
};

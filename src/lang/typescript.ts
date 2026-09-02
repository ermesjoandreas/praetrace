import { createRequire } from 'node:module';
import path from 'node:path';

import { resolveImport, resolveModulePath } from '../graph/resolve.js';
import type { ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let grammars: { typescript: unknown; tsx: unknown } | null = null;

/** Resolve a node that names a type or value down to the bare identifier text. */
function nameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
      return node.text;
    case 'generic_type':
      // `Other<T>` — the symbol is in the `name` field.
      return nameOf(node.childForFieldName('name'));
    case 'member_expression':
      // `ns.Remote` — attribute the reference to the trailing property.
      return nameOf(node.childForFieldName('property'));
    default:
      return null;
  }
}

/** Text of a module specifier node, without its surrounding quotes. */
function specifierOf(node: SyntaxNode | null): string | null {
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
 * Every name invoked inside a symbol.
 *
 * `exclude` holds subtrees that are symbols in their own right — a class's
 * methods, a namespace's declarations — so the enclosing symbol does not also
 * claim what they call. Without it every call inside a method would produce two
 * edges from two different nodes, and the weight on the drawn edge would be
 * twice what the code actually does.
 */
function collectCalls(declaration: SyntaxNode, exclude: readonly SyntaxNode[] = []): string[] {
  const names = new Set<string>();
  const inside = (node: SyntaxNode): boolean =>
    exclude.some((skip) => node.startIndex >= skip.startIndex && node.endIndex <= skip.endIndex);

  for (const call of declaration.descendantsOfType('call_expression')) {
    if (inside(call)) continue;
    const name = nameOf(call.childForFieldName('function'));
    if (name) names.add(name);
  }
  for (const construction of declaration.descendantsOfType('new_expression')) {
    if (inside(construction)) continue;
    const name = nameOf(construction.childForFieldName('constructor'));
    if (name) names.add(name);
  }

  return [...names];
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
function typeOf(member: SyntaxNode): { typeName?: string; many?: boolean } {
  const annotation = member.childForFieldName('type');
  const declared = annotation?.namedChildren[0] ?? null;
  if (!declared) return {};

  if (declared.type === 'array_type') {
    const name = nameOf(declared.namedChildren[0] ?? null);
    return name === null ? { many: true } : { typeName: name, many: true };
  }
  if (declared.type === 'generic_type') {
    const base = nameOf(declared.childForFieldName('name'));
    // Array<T> and the collection types name their element, not themselves.
    if (base === 'Array' || base === 'Set' || base === 'ReadonlyArray') {
      const args = declared.childForFieldName('type_arguments');
      const inner = nameOf(args?.namedChildren[0] ?? null);
      return inner === null ? { many: true } : { typeName: inner, many: true };
    }
    return base === null ? {} : { typeName: base };
  }

  const name = nameOf(declared);
  return name === null ? {} : { typeName: name };
}

/**
 * A class's members, as symbols of their own.
 *
 * A field holding an arrow function is a method in everything but syntax, so it
 * counts as one. Returns the method bodies, which the class must not claim the
 * calls of.
 */
function collectMembers(declaration: SyntaxNode, owner: string, symbols: ParsedSymbol[]): SyntaxNode[] {
  const body = declaration.childForFieldName('body');
  if (!body) return [];

  const bodies: SyntaxNode[] = [];
  const fields: ParsedSymbol[] = [];
  const methods: ParsedSymbol[] = [];

  for (const member of body.namedChildren) {
    const name = nameOf(member.childForFieldName('name'));
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
    };

    if (isMethod) {
      bodies.push(member);
      methods.push({ ...common, kind: 'method', calls: collectCalls(member) });
    } else {
      // A field initialiser can call things, and those calls are the class's
      // doing rather than any method's, so they are collected here too.
      fields.push({ ...common, kind: 'field', calls: collectCalls(member), ...typeOf(member) });
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
  exclude: readonly SyntaxNode[] = [],
): ParsedSymbol {
  const heritage = collectHeritage(declaration);
  return {
    name,
    kind,
    startLine: declaration.startPosition.row + 1,
    endLine: declaration.endPosition.row + 1,
    extends: heritage.extends,
    implements: heritage.implements,
    calls: collectCalls(declaration, exclude),
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
  symbols: ParsedSymbol[];
  /**
   * Subtrees that already became a symbol. An enclosing namespace collects the
   * calls in its body and must not claim what its own declarations call.
   */
  claimed: SyntaxNode[];
  /** Which of the symbols came from a body-less signature; see below. */
  signatures: Set<ParsedSymbol>;
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
    const specifier = specifierOf(node.childForFieldName('source'));
    if (specifier) out.imports.push(specifier);
    return;
  }

  if (node.type === 'export_statement') {
    // `export { x } from './m'` is an import edge just as much as an import is.
    const specifier = specifierOf(node.childForFieldName('source'));
    if (specifier) out.imports.push(specifier);

    const declaration = node.childForFieldName('declaration');
    if (declaration) collectTopLevel(declaration, out);
    return;
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
    if (name) out.symbols.push(makeSymbol(node, name, 'type', out.claimed));
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
    const bodies =
      kind === 'class' || kind === 'interface' ? collectMembers(node, name, members) : [];
    const symbol = { ...makeSymbol(node, name, kind, bodies), ...modifiersOf(node) };
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
        const bodies = collectMembers(value, name, members);
        out.symbols.push(makeSymbol(value, name, 'class', bodies));
        out.symbols.push(...members);
        out.claimed.push(declarator);
        continue;
      }

      if (value.type === 'arrow_function' || value.type === 'function_expression') {
        out.symbols.push(makeSymbol(declarator, name, 'function'));
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

export const typescript: LanguageSupport = {
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

  extract(root: SyntaxNode, _source: string): LanguageParse {
    const out: Collected = { imports: [], symbols: [], claimed: [], signatures: new Set() };
    for (const child of root.namedChildren) collectTopLevel(child, out);
    return { imports: out.imports, symbols: withoutOverloads(out.symbols, out.signatures) };
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
};

import { createRequire } from 'node:module';

import type { ParsedSymbol, SymbolKind } from '../parser/types.js';
import { typescript } from './typescript.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/** Resolve a node that names something down to the bare identifier text. */
function nameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'property_identifier':
    // `#count` carries its hash everywhere it is written, `this.#count`
    // included, so the hash is part of the name and not a modifier spelt oddly.
    case 'private_property_identifier':
      return node.text;
    case 'member_expression':
      // `React.Component` — attribute the reference to the trailing property.
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

/**
 * Every name invoked inside a symbol.
 *
 * `exclude` holds subtrees that are symbols in their own right — a class's
 * methods — so the enclosing symbol does not also claim what they call.
 * Without it every call inside a method would produce two edges from two
 * different nodes, and the weight on the drawn edge would be twice what the
 * code actually does.
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

/** `class C extends Base`. One name: JavaScript has single inheritance and no
 *  `implements` at all, so the heritage clause holds the superclass directly. */
function superclassOf(declaration: SyntaxNode): string[] {
  for (const child of declaration.namedChildren) {
    if (child.type !== 'class_heritage') continue;
    // `extends mixin(Base)` names nothing a reference could match, and guessing
    // between the mixin and its argument would invent an edge either way.
    const name = nameOf(child.namedChildren[0] ?? null);
    return name === null ? [] : [name];
  }
  return [];
}

/** A field holding one of these is a method in everything but syntax, which is
 *  how a handler bound to its instance is written. */
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function']);

/**
 * A class's members, as symbols of their own. Returns the method bodies, which
 * the class must not claim the calls of.
 *
 * No `typeName` is read, so JavaScript draws no associations: nothing in the
 * source declares a field's type. The coupling is not lost — a field
 * initialised with `new Thing()` still calls Thing — it is drawn as a call
 * rather than as a has-a, which is as much as the language actually said.
 */
function collectMembers(declaration: SyntaxNode, owner: string, symbols: ParsedSymbol[]): SyntaxNode[] {
  const body = declaration.childForFieldName('body');
  if (!body) return [];

  const bodies: SyntaxNode[] = [];
  const fields: ParsedSymbol[] = [];
  const methods: ParsedSymbol[] = [];

  for (const member of body.namedChildren) {
    const isMethod = member.type === 'method_definition';
    if (!isMethod && member.type !== 'field_definition') continue;

    // The grammar's own split: a method's name is in `name`, a field's in
    // `property`. A computed `[key]()` names nothing a reference elsewhere
    // could be matched to, so it is skipped.
    const named = isMethod ? member.childForFieldName('name') : member.childForFieldName('property');
    if (!named) continue;
    const name = nameOf(named);
    if (!name) continue;

    const common = {
      name,
      owner,
      startLine: member.startPosition.row + 1,
      endLine: member.endPosition.row + 1,
      extends: [],
      implements: [],
      // JavaScript states visibility exactly once, in the `#` on the name.
      // There is no `public` or `protected` keyword to report as written.
      ...(named.type === 'private_property_identifier' ? { visibility: 'private' as const } : {}),
      ...(member.children.some((child) => child.type === 'static') ? { isStatic: true } : {}),
    };

    if (isMethod || FUNCTION_VALUES.has(member.childForFieldName('value')?.type ?? '')) {
      bodies.push(member);
      methods.push({ ...common, kind: 'method', calls: collectCalls(member) });
    } else {
      // A field initialiser can call things, and those calls are the class's
      // doing rather than any method's, so they are collected here too.
      fields.push({ ...common, kind: 'field', calls: collectCalls(member) });
    }
  }

  // Attributes before operations, which is the order a UML class box reads in.
  symbols.push(...fields, ...methods);
  return bodies;
}

function makeSymbol(
  declaration: SyntaxNode,
  name: string,
  kind: SymbolKind,
  exclude: readonly SyntaxNode[] = [],
): ParsedSymbol {
  return {
    name,
    kind,
    startLine: declaration.startPosition.row + 1,
    endLine: declaration.endPosition.row + 1,
    extends: kind === 'class' ? superclassOf(declaration) : [],
    implements: [],
    calls: collectCalls(declaration, exclude),
  };
}

const DECLARATION_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
]);

interface Collected {
  imports: string[];
  symbols: ParsedSymbol[];
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

  const kind = DECLARATION_KINDS.get(node.type);
  if (kind) {
    const name = nameOf(node.childForFieldName('name'));
    if (!name) return;

    // The class is pushed before its members, and the graph layer relies on
    // that order to attach each one to the class it just saw.
    const members: ParsedSymbol[] = [];
    const bodies = kind === 'class' ? collectMembers(node, name, members) : [];
    out.symbols.push(makeSymbol(node, name, kind, bodies));
    out.symbols.push(...members);
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
        continue;
      }

      if (FUNCTION_VALUES.has(value.type)) {
        out.symbols.push(makeSymbol(declarator, name, 'function'));
      }
    }
  }
}

/**
 * `require()` and dynamic `import()`, which are calls rather than statements.
 *
 * They are looked for across the whole file, not just its top level, because
 * that is where they are written: a CommonJS module requires at the top but a
 * lazily loaded route is `() => import('./Page')` inside an arrow, and query's
 * codemods are twelve `.cjs` files held together entirely by `require`. Missing
 * them would leave exactly the picture this exists to avoid — a directory of
 * files that plainly depend on each other, drawn with no edges between them.
 */
function collectCallImports(root: SyntaxNode, imports: string[]): void {
  for (const call of root.descendantsOfType('call_expression')) {
    const callee = call.childForFieldName('function');
    if (!callee) continue;
    const isImport =
      callee.type === 'import' || (callee.type === 'identifier' && callee.text === 'require');
    if (!isImport) continue;

    // A computed specifier — `require(name)`, a template literal — names a file
    // only at run time, and this graph is what the source says.
    const argument = call.childForFieldName('arguments')?.namedChildren[0] ?? null;
    const specifier = argument?.type === 'string' ? specifierOf(argument) : null;
    if (specifier) imports.push(specifier);
  }
}

export const javascript: LanguageSupport = {
  id: 'javascript',
  label: 'JavaScript',
  extensions: ['.js', '.jsx', '.mjs', '.cjs'],

  grammar(_filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    //
    // One grammar for all four extensions, JSX included — tree-sitter-javascript
    // parses JSX as part of the language rather than as a dialect, so `.jsx`
    // needs no second grammar the way `.tsx` does.
    loaded ??= require('tree-sitter-javascript');
    return loaded;
  },

  /**
   * Nearly TypeScript's job with the types taken out, but not the same code,
   * and the differences are silent ones rather than cosmetic.
   *
   * The two grammars disagree exactly where classes are: JavaScript's
   * `class_heritage` holds the superclass expression directly where
   * TypeScript's wraps it in an `extends_clause`, and a field is a
   * `field_definition` naming it in `property` where TypeScript has a
   * `public_field_definition` naming it in `name`. Run TypeScript's extractor
   * over a JavaScript tree and it parses cleanly, reports no error, and returns
   * every class with no superclass and no members — which is the failure this
   * whole effort exists to avoid, arriving through the back door. The imports,
   * the calls and the top-level declarations really are the same job, and the
   * helpers above are near-copies; they belong in a module both files import
   * once one of them is allowed to move.
   */
  extract(root: SyntaxNode, _source: string): LanguageParse {
    const out: Collected = { imports: [], symbols: [] };
    for (const child of root.namedChildren) collectTopLevel(child, out);
    collectCallImports(root, out.imports);
    return out;
  },

  /**
   * The same question TypeScript asks, so deliberately the same answer.
   *
   * A specifier means what Node says it means, and the extension on the file
   * holding it changes nothing: `./x` is a relative path whose extension on
   * disk may not be the one written, an alias table applies, and a monorepo
   * package name still names a directory. `graph/resolve.ts` already tries the
   * JavaScript extensions, so there is nothing here TypeScript's rule does not
   * already do — and a second copy of it would be a second place for the two to
   * drift, in a project where the same import is written in both languages.
   */
  resolve(context: ResolveContext): string | null {
    return typescript.resolve(context);
  },
};

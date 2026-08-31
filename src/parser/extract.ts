import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import type { ParsedFile, ParsedSymbol, SymbolKind } from './types.js';

// tree-sitter and its grammars are native CommonJS addons with no ESM entry
// point, so they can only be loaded through createRequire. Confining that to
// this module keeps the rest of the codebase plain ESM.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;
const grammars = require('tree-sitter-typescript') as {
  typescript: Parser.Language;
  tsx: Parser.Language;
};

type Node = Parser.SyntaxNode;

// One parser per grammar, reused for the lifetime of the worker. Constructing a
// parser is far more expensive than parsing a file.
const parsers = new Map<'ts' | 'tsx', Parser>();

function parserFor(filePath: string): Parser {
  const dialect = filePath.endsWith('.tsx') ? 'tsx' : 'ts';
  let parser = parsers.get(dialect);
  if (!parser) {
    parser = new TreeSitter();
    parser.setLanguage(dialect === 'tsx' ? grammars.tsx : grammars.typescript);
    parsers.set(dialect, parser);
  }
  return parser;
}

/** Resolve a node that names a type or value down to the bare identifier text. */
function nameOf(node: Node | null): string | null {
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
function specifierOf(node: Node | null): string | null {
  if (!node) return null;
  const fragment = node.namedChildren.find((child) => child.type === 'string_fragment');
  return fragment ? fragment.text : null;
}

function collectHeritage(declaration: Node): { extends: string[]; implements: string[] } {
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
 * Every name invoked inside a symbol. Nested functions are not separate nodes in
 * the MVP, so their calls attribute to the enclosing top-level symbol.
 */
function collectCalls(declaration: Node): string[] {
  const names = new Set<string>();

  for (const call of declaration.descendantsOfType('call_expression')) {
    const name = nameOf(call.childForFieldName('function'));
    if (name) names.add(name);
  }
  for (const construction of declaration.descendantsOfType('new_expression')) {
    const name = nameOf(construction.childForFieldName('constructor'));
    if (name) names.add(name);
  }

  return [...names];
}

function makeSymbol(declaration: Node, name: string, kind: SymbolKind): ParsedSymbol {
  const heritage = collectHeritage(declaration);
  return {
    name,
    kind,
    startLine: declaration.startPosition.row + 1,
    endLine: declaration.endPosition.row + 1,
    extends: heritage.extends,
    implements: heritage.implements,
    calls: collectCalls(declaration),
  };
}

const DECLARATION_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  ['interface_declaration', 'interface'],
  ['type_alias_declaration', 'type'],
]);

/** Only top-level declarations become nodes; class members do not. */
function collectTopLevel(node: Node, imports: string[], symbols: ParsedSymbol[]): void {
  if (node.type === 'import_statement') {
    const specifier = specifierOf(node.childForFieldName('source'));
    if (specifier) imports.push(specifier);
    return;
  }

  if (node.type === 'export_statement') {
    // `export { x } from './m'` is an import edge just as much as an import is.
    const specifier = specifierOf(node.childForFieldName('source'));
    if (specifier) imports.push(specifier);

    const declaration = node.childForFieldName('declaration');
    if (declaration) collectTopLevel(declaration, imports, symbols);
    return;
  }

  const kind = DECLARATION_KINDS.get(node.type);
  if (kind) {
    const name = nameOf(node.childForFieldName('name'));
    if (name) symbols.push(makeSymbol(node, name, kind));
    return;
  }

  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (const declarator of node.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const value = declarator.childForFieldName('value');
      if (value?.type !== 'arrow_function' && value?.type !== 'function_expression') continue;
      const name = nameOf(declarator.childForFieldName('name'));
      if (name) symbols.push(makeSymbol(declarator, name, 'function'));
    }
  }
}

export function parseSource(filePath: string, source: string, modifiedAt = 0): ParsedFile {
  const tree = parserFor(filePath).parse(source);
  const imports: string[] = [];
  const symbols: ParsedSymbol[] = [];

  for (const child of tree.rootNode.namedChildren) {
    collectTopLevel(child, imports, symbols);
  }

  return {
    filePath,
    imports,
    symbols,
    lineCount: tree.rootNode.endPosition.row + 1,
    modifiedAt,
  };
}

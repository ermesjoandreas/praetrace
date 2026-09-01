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
 * Every name invoked inside a symbol.
 *
 * `exclude` holds subtrees that are symbols in their own right — a class's
 * methods — so the class does not also claim what they call. Without it every
 * call inside a method would produce two edges from two different nodes, and the
 * weight on the drawn edge would be twice what the code actually does.
 */
function collectCalls(declaration: Node, exclude: readonly Node[] = []): string[] {
  const names = new Set<string>();
  const inside = (node: Node): boolean =>
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
 * A class's members, as symbols of their own.
 *
 * They were deliberately left out of the MVP, on the grounds that a call into
 * another file is already implied by the import beside it. What that missed is
 * that the tool's whole premise is watching an agent work, and an agent adding a
 * method to an existing class is the single most common thing it does — which
 * used to produce a graph update that changed nothing visible.
 *
 * A field holding an arrow function is a method in everything but syntax, so it
 * counts as one.
 */
/**
 * UML's three modifiers, read off the declaration rather than inferred. An
 * absent visibility means the source did not say, which in TypeScript is public
 * — recorded as absent so the diagram can tell "written public" from "not
 * written", the way the source can.
 */
function modifiersOf(member: Node): Pick<ParsedSymbol, 'visibility' | 'isStatic' | 'isAbstract'> {
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
function typeOf(member: Node): { typeName?: string; many?: boolean } {
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

function collectMembers(declaration: Node, owner: string, symbols: ParsedSymbol[]): Node[] {
  const body = declaration.childForFieldName('body');
  if (!body) return [];

  const bodies: Node[] = [];
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
  declaration: Node,
  name: string,
  kind: SymbolKind,
  exclude: readonly Node[] = [],
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

const DECLARATION_KINDS: ReadonlyMap<string, SymbolKind> = new Map([
  ['class_declaration', 'class'],
  ['abstract_class_declaration', 'class'],
  ['function_declaration', 'function'],
  ['generator_function_declaration', 'function'],
  ['interface_declaration', 'interface'],
  ['type_alias_declaration', 'type'],
]);

/** Top-level declarations, plus the members of any class among them. */
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
    if (!name) return;

    // The class is pushed before its members, and the graph layer relies on
    // that order to attach each one to the class it just saw.
    const members: ParsedSymbol[] = [];
    const bodies =
      kind === 'class' || kind === 'interface' ? collectMembers(node, name, members) : [];
    symbols.push({ ...makeSymbol(node, name, kind, bodies), ...modifiersOf(node) });
    symbols.push(...members);
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

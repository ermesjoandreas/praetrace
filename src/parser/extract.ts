import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import { languageFor } from '../lang/registry.js';
import type { ParsedFile } from './types.js';

// tree-sitter and its grammars are native CommonJS addons with no ESM entry
// point, so they can only be loaded through createRequire. Confining that to
// this module and to src/lang/* keeps the rest of the codebase plain ESM.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

/**
 * One parser per grammar, reused for the lifetime of the worker. Constructing a
 * parser is far more expensive than parsing a file.
 *
 * Keyed by the grammar itself rather than by language id, because one language
 * can hand back more than one: TypeScript's `.ts` and `.tsx` are separate
 * grammars, and a parser holding the wrong one silently mis-parses JSX.
 */
const parsers = new Map<unknown, Parser>();

function parserFor(grammar: unknown): Parser {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = new TreeSitter();
    // The grammar is whatever the language's package wants passed here, which
    // for the newer grammars is the module and not its typed `.language`.
    parser.setLanguage(grammar as Parser.Language);
    parsers.set(grammar, parser);
  }
  return parser;
}

/**
 * Parse one file with whichever language claims it.
 *
 * Nothing here knows a language's syntax. This picks the grammar, runs
 * tree-sitter, and hands the tree to the language — everything about what a
 * declaration looks like lives in src/lang/.
 */
export function parseSource(filePath: string, source: string, modifiedAt = 0): ParsedFile {
  const language = languageFor(filePath);
  // The scan, the watcher and the hook all filter by the same extension table,
  // so a file with no language got here by a bug rather than by being unusual.
  if (!language) throw new Error(`no language claims ${filePath}`);

  const tree = parserFor(language.grammar(filePath)).parse(source);
  const parse = language.extract(tree.rootNode, source);

  return {
    filePath,
    language: language.id,
    imports: parse.imports,
    symbols: parse.symbols,
    lineCount: tree.rootNode.endPosition.row + 1,
    modifiedAt,
    ...(parse.moduleName === undefined ? {} : { moduleName: parse.moduleName }),
  };
}

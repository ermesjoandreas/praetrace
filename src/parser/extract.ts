import { createRequire } from 'node:module';
import type Parser from 'tree-sitter';
import { languageFor } from '../lang/registry.js';
import type { LanguageParse, LanguageSupport } from '../lang/types.js';
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
 * The tree half of `parseSource`, kept apart so the scanned half needs no cast.
 *
 * `preprocess` is what a single-file component uses to be parsed by the grammar
 * of the language its script is written in: it hands back a string of exactly
 * the file's length with everything outside the script blanked to spaces, so
 * every row, column and offset in the tree is the *file's* and no range has to
 * be shifted afterwards. `source` stays the file as written for everything
 * downstream — the line count is the file's, and the extractor still has the
 * template to read.
 */
function readTree(
  language: LanguageSupport,
  filePath: string,
  source: string,
): { parse: LanguageParse; hasError: boolean } {
  const parsed = language.preprocess === undefined ? source : language.preprocess(source);
  const tree = parserFor(language.grammar(filePath)).parse(parsed);
  return { parse: language.extract(tree.rootNode, source, filePath), hasError: tree.rootNode.hasError };
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

  // A language with no grammar reads the text itself, and has no syntax errors
  // to report: `hasError` below is the grammar's word, and there is none. See
  // ScannedLanguage.
  const { parse, hasError } =
    'scan' in language
      ? { parse: language.scan(source), hasError: false }
      : readTree(language, filePath, source);

  return {
    filePath,
    language: language.id,
    imports: parse.imports,
    symbols: parse.symbols,
    lineCount: countLines(source),
    // tree-sitter is error-tolerant, so a malformed file parses to something and
    // loses symbols quietly: `export const broken = {{{ ;` drew "0 symbols" and
    // looked like an empty file. The flag is what lets a box say otherwise.
    hasError,
    modifiedAt,
    ...(parse.moduleName === undefined ? {} : { moduleName: parse.moduleName }),
    // Without this the store's re-export following never sees a barrel, and a
    // name imported through one still lands on the barrel rather than where it
    // is declared.
    ...(parse.reexports === undefined || parse.reexports.length === 0 ? {} : { reexports: parse.reexports }),
    // The store narrows a file's name lookup to what it bound only when the
    // parser said what that was. Dropped here, every TypeScript file would
    // read as one whose language had not opted in, and the whole-table rule
    // the bindings exist to replace would go on drawing `rows.map()` as a
    // call into a barrel's `map`. An empty list is kept for the same reason:
    // a file that imports nothing bound nothing, which is not the same as a
    // parser that never said.
    ...(parse.bindings === undefined ? {} : { bindings: parse.bindings }),
    // What the file calls at top level, outside every symbol; the graph draws
    // these from the file itself. Dropped when empty, unlike `bindings`:
    // nothing reads the presence of this field, so a file that calls nothing
    // at top level and a language that collects none say the same thing here.
    ...(parse.calls === undefined || parse.calls.length === 0 ? {} : { calls: parse.calls }),
    ...(parse.defaultExport === undefined ? {} : { defaultExport: parse.defaultExport }),
  };
}

/**
 * Lines the way `wc -l` counts them: one per newline, plus the last line when
 * nothing terminates it. Counted from the text rather than from the tree,
 * because the root node ends on the row *after* a trailing newline, and
 * `endPosition.row + 1` reported a 131-line file as 132 — the terminator was
 * being read as a line of its own.
 */
export function countLines(source: string): number {
  let lines = 0;
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lines++;
  if (source.length > 0 && !source.endsWith('\n')) lines++;
  return lines;
}

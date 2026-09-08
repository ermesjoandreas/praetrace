import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { parentPort } from 'node:worker_threads';
import type Parser from 'tree-sitter';
import { languageFor } from '../lang/registry.js';
import { parseSource } from './extract.js';
import { FLOW_LANGUAGES, flowOf, functionAt, hasFlowSyntax, type FlowRequest, type FlowResponse } from './flow.js';
import type { ParseRequest, ParseResponse } from './types.js';

if (!parentPort) {
  throw new Error('parser worker must be started as a worker thread');
}

const port = parentPort;

// A flow request carries a `kind`; a parse request never has. Anything else
// this worker is sent is a parse, as it always was.
function isFlowRequest(request: ParseRequest | FlowRequest): request is FlowRequest {
  return 'kind' in request && request.kind === 'flow';
}

port.on('message', (request: ParseRequest | FlowRequest) => {
  void (isFlowRequest(request) ? handleFlow(request) : handle(request)).then((response) => port.postMessage(response));
});

async function handle(request: ParseRequest): Promise<ParseResponse> {
  try {
    // Reading here rather than on the main thread keeps all per-file work,
    // I/O included, off the event loop the collector runs on.
    const source = request.source ?? (await readFile(request.absolutePath, 'utf8'));
    const modifiedAt = await stat(request.absolutePath).then((s) => s.mtimeMs, () => 0);
    return {
      id: request.id,
      ok: true,
      parsed: parseSource(request.filePath, source, modifiedAt),
    };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// tree-sitter is a native CommonJS addon; extract.ts keeps its parsers to
// itself and hands back a ParsedFile, and the flow needs the tree. One parser
// per grammar here too, for the same reason extract.ts keeps one: building a
// parser costs far more than parsing a file.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;
const parsers = new Map<unknown, Parser>();

function parserFor(grammar: unknown): Parser {
  let parser = parsers.get(grammar);
  if (!parser) {
    parser = new TreeSitter();
    parser.setLanguage(grammar as Parser.Language);
    parsers.set(grammar, parser);
  }
  return parser;
}

/**
 * The flow of one function: read the file, parse it, find the outermost
 * function inside the symbol's range, walk it. The file is read again rather
 * than kept from the last parse, because a worker keeps no source — the graph
 * holds what the parse found and nothing else — and the flow must describe the
 * file as it is now.
 */
async function handleFlow(request: FlowRequest): Promise<FlowResponse> {
  try {
    const language = languageFor(request.filePath);
    if (!language) {
      return { id: request.id, ok: true, answer: { flow: null, reason: `no language reads ${request.filePath}` } };
    }
    // `'grammar' in language` is not a second question: a scanned language has
    // no tree to walk, and hasFlowSyntax already refuses every one of them. It
    // is here so the type knows what the list already decided.
    if (!hasFlowSyntax(language.id) || !('grammar' in language)) {
      const reads = FLOW_LANGUAGES.map((id) => languageFor(`x.${id === 'typescript' ? 'ts' : id === 'javascript' ? 'js' : id}`)?.label ?? id);
      return {
        id: request.id,
        ok: true,
        answer: { flow: null, reason: `${language.label} is not read for flow yet — ${reads.join(', ')} are` },
      };
    }
    const source = await readFile(request.absolutePath, 'utf8');
    const tree = parserFor(language.grammar(request.filePath)).parse(source);
    const fn = functionAt(tree.rootNode, request.range, language.id);
    if (!fn) {
      const { startLine, endLine } = request.range;
      const where = startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
      return {
        id: request.id,
        ok: true,
        answer: { flow: null, reason: `no function body at ${where} of ${request.filePath}` },
      };
    }
    const flow = flowOf(fn, language.id);
    return flow
      ? { id: request.id, ok: true, answer: { flow } }
      : { id: request.id, ok: true, answer: { flow: null, reason: `${language.label} is not read for flow yet` } };
  } catch (error) {
    return { id: request.id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

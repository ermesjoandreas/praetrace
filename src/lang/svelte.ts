import path from 'node:path';
import { createRequire } from 'node:module';

import type Parser from 'tree-sitter';
import { resolveModulePath } from '../graph/resolve.js';
import type { ImportBinding, ParsedSymbol, Reexport } from '../parser/types.js';
import {
  collectCalls,
  moduleScope,
  nameOf,
  specifierOf,
  typescript,
  type ModuleParse,
  type Scope,
} from './typescript.js';
import type { LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

/**
 * A single-file component: `<script>`, markup, `<style>`.
 *
 * Two languages in one file, which is the whole difficulty. The script *is*
 * TypeScript, and this project already reads TypeScript well, so nothing here
 * re-reads a class or a call — the script block is handed to the reader that
 * already knows how, and what this file owns is the three things that reader
 * cannot do: find the block, put its symbols back on the lines they occupy in
 * the `.svelte` file rather than on line 1 of the block, and read the markup.
 *
 * **The markup's edges are its expressions, and not its tags**, which was
 * measured rather than assumed. A component a template renders is *always*
 * imported first — Svelte has no global registry the way Vue's `components`
 * option is one — so a tag names something the import line already drew, and
 * the tag adds nothing: of open-webui's 3 402 component tags, 3 400 name an
 * imported binding and 3 368 of those name a `.svelte` file, which declares
 * no symbol under its own name for the reference to land on. Reading them
 * added 0 call edges and 61 marks on `unresolved`, which is coupling reported
 * lost where the import edge is drawn and nothing is missing. So they are not
 * read; see `markupCalls`.
 *
 * What the markup does add is calls — `{fmt(x)}`, `on:click={() => save()}`,
 * `{#if isAdmin(user)}` — 164 resolved call edges on open-webui, written
 * nowhere else in the file.
 *
 * **Checked against three real repositories**, which is when a language is
 * finished. open-webui (662 components), immich's web (417) and svelte.dev
 * (557): 17 parse errors between them, all in markup and none costing a
 * script; 0 guessed edges; and open-webui draws 2 928 import edges, 2 314 call
 * edges and marks 0 unresolved imports. Thirty sampled edges were read against
 * the source by hand and all thirty are real. The number that decides the
 * picture is `$lib` — see `kitLib`.
 */

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/**
 * A parser of our own, for the script inside the file.
 *
 * The contract hands `extract` one tree from one grammar, which is right for
 * every language whose file is written in one language. A `.svelte` file is
 * not, so the second grammar has to be run from here. It is the same
 * TypeScript grammar `parser/extract.ts` holds and a second instance of the
 * parser around it: constructing one is expensive, so it is made once and kept
 * for the life of the worker, exactly as that module does.
 */
let scriptParser: Parser | null = null;

/**
 * A tree's root, plus the one thing the shared node type does not carry: the
 * grammar's word on whether it had to recover. `parser/extract.ts` reads it
 * off the tree it made; a fragment parsed in here has to ask for itself.
 */
interface Parsed extends SyntaxNode {
  hasError: boolean;
}

function parseScript(source: string): Parsed {
  if (scriptParser === null) {
    const TreeSitter = require('tree-sitter') as new () => Parser;
    scriptParser = new TreeSitter();
    // `.ts` and not `.tsx`: a Svelte script is never JSX, and the tsx grammar
    // reads a generic `<T>(…)` as an element.
    scriptParser.setLanguage(typescript.grammar('block.ts') as Parser.Language);
  }
  // The parser's own node type carries everything SyntaxNode names and the
  // error flag besides; the structural type is what the rest of src/lang uses.
  return scriptParser.parse(source).rootNode as unknown as Parsed;
}

/** One `<script>` block: its tree, its text, and where the block sits in the file. */
interface Block {
  root: SyntaxNode;
  source: string;
  /**
   * The 0-based row the block's text starts on, which is the row of the `>`
   * that closes the opening tag. A symbol the script reader put on line N is
   * on line `offset + N` of the `.svelte` file: the block's first line is the
   * remainder of that row, so N of 1 lands on it.
   */
  offset: number;
}

/**
 * The `<script>` blocks, in document order, each parsed as TypeScript.
 *
 * Both blocks, and merged rather than kept apart: Svelte compiles the instance
 * script and the `context="module"` (Svelte 5: `module`) script into one
 * module, they share an import list, and the graph has one node per file to
 * hang the result on. Which block a symbol came from is not a question the
 * graph model can ask.
 *
 * Always the TypeScript grammar, whatever the block's `lang` says. TypeScript
 * is a superset of what a Svelte script can hold, so a plain `<script>` reads
 * correctly through it; the alternative — the JavaScript grammar for the 449
 * plain blocks across the three corpora and the TypeScript one for the 1 106
 * that say `lang="ts"` — would mean two extractors and two tree shapes to keep
 * in step for no edge either would draw differently. And it is the TypeScript
 * extractor that has to run either way: javascript.ts exists because the
 * JavaScript grammar spells a class's heritage and fields differently, and
 * running the wrong extractor over a tree parses cleanly, reports no error,
 * and returns every class with no members.
 */
function scriptBlocksOf(root: SyntaxNode): Block[] {
  const blocks: Block[] = [];
  // Every `script_element`, not only the document's own children: a markup
  // error above the block puts it under an ERROR node, and three of
  // open-webui's 662 files have one. The script survives in all three, and a
  // Svelte file cannot nest a script inside an element, so nothing else can
  // arrive here.
  for (const element of root.descendantsOfType('script_element')) {
    const text = element.namedChildren.find((child) => child.type === 'raw_text');
    if (!text) continue;
    blocks.push({ root: parseScript(text.text), source: text.text, offset: text.startPosition.row });
  }
  return blocks;
}

/** The same symbol, on the line it occupies in the `.svelte` file. */
function shifted(symbol: ParsedSymbol, offset: number): ParsedSymbol {
  return { ...symbol, startLine: symbol.startLine + offset, endLine: symbol.endLine + offset };
}

/**
 * `export let title: string` — a prop with no default.
 *
 * Svelte 4 declares a component's public interface this way, and the script
 * reader drops it: a declarator with no initialiser says nothing about what it
 * holds, so TypeScript's extractor keeps only the exported names that were
 * bound to something. Here the name is the claim on its own — it is the
 * attribute a parent writes — and a box that listed `export let open = false`
 * while omitting `export let title: string` beside it would be describing half
 * an interface.
 *
 * 'field' for the reason typescript.ts gives: the branches that read a
 * function have already run, so what is left is a value.
 */
function propsOf(root: SyntaxNode): ParsedSymbol[] {
  const props: ParsedSymbol[] = [];
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement') continue;
    const declaration = statement.childForFieldName('declaration');
    if (declaration?.type !== 'lexical_declaration' && declaration?.type !== 'variable_declaration') continue;
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      if (declarator.childForFieldName('value') !== null) continue;
      const name = nameOf(declarator.childForFieldName('name'));
      if (name === null) continue;
      props.push({
        name,
        kind: 'field',
        startLine: declarator.startPosition.row + 1,
        endLine: declarator.endPosition.row + 1,
        extends: [],
        implements: [],
        calls: [],
        exported: true,
      });
    }
  }
  return props;
}

/**
 * `import('./Panel.svelte')` and `await import(spec)` in a script block.
 *
 * TypeScript's extractor reads `import` statements only, where JavaScript's
 * also reads the call form; a lazily loaded component is written as the call,
 * and in a Svelte project that is how a heavy panel is kept out of the first
 * bundle: 69 of them across the three corpora, and immich reaches its asset
 * viewer and its map this way and no other. Collected here rather than left to
 * drift, because the specifier is an import edge whichever spelling was used.
 */
function dynamicImportsOf(root: SyntaxNode): string[] {
  const specifiers: string[] = [];
  for (const call of root.descendantsOfType('call_expression')) {
    if (call.childForFieldName('function')?.type !== 'import') continue;
    const argument = call.childForFieldName('arguments')?.namedChildren[0] ?? null;
    // A computed specifier — `import(name)`, a template literal — names a file
    // only at run time, and this graph is what the source says.
    const specifier = argument?.type === 'string' ? specifierOf(argument) : null;
    if (specifier !== null) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * Which of a node's `svelte_raw_text` children are expressions.
 *
 * The grammar gives the same node type to a block tag's binding pattern as to
 * an interpolation, and reading the pattern as an expression is how a template
 * invents a call: `{#each items as item (item.id)}` splits into `items ` and
 * `item (item.id)`, and the second parses as a call to `item`. So the parents
 * are named one at a time, and an unrecognised one contributes nothing. Of
 * the 20 029 `svelte_raw_text` nodes in open-webui and svelte.dev, 1 125 sit
 * under a parent that is not an expression and go unread.
 *
 * `render_tag` is `{@render row(1)}`, `const_tag` is `{@const x = f()}`;
 * `each_start`'s first child is the collection and the rest of it is the
 * pattern. What is deliberately left out: `snippet_start`, whose text is a
 * parameter list, `then_start` and `catch_start`, whose text is the name being
 * bound, and `attribute_name`, the shorthand `{count}` — Svelte allows only a
 * bare name there, so it can hold no call, and reading it as a reference made
 * every component that interpolates a prop "call" it, 264 of `className` alone
 * in open-webui — 1 106 of the 1 125 unread are that one shape.
 */
const EXPRESSION_PARENTS: ReadonlySet<string> = new Set([
  'expression',
  'render_tag',
  'const_tag',
  'html_tag',
  'debug_tag',
  'if_start',
  'else_if_start',
  'await_start',
  'key_start',
]);

function expressionsOf(node: SyntaxNode, out: string[]): void {
  if (EXPRESSION_PARENTS.has(node.type) || node.type === 'each_start') {
    const texts = node.namedChildren.filter((child) => child.type === 'svelte_raw_text');
    // Only the first for an each: what follows the `as` is a binding pattern.
    for (const text of node.type === 'each_start' ? texts.slice(0, 1) : texts) out.push(text.text);
  }
  for (const child of node.namedChildren) expressionsOf(child, out);
}

/**
 * What the markup calls.
 *
 * Every expression is parsed on its own and dropped whole if it does not
 * parse. A template fragment is short and a grammar is error-tolerant, so a
 * fragment that is not an expression — `{#await promise then value}`, a form
 * some later Svelte adds — would otherwise recover into something that looks
 * like a call and be drawn as one. A missing edge is a gap; a wrong one is a
 * lie.
 *
 * `scope` is the script's, so a receiver the script typed is still typed in
 * the template: `{store.load()}` after `const store = new Store()` is
 * `Store.load` here as it would be in the script.
 *
 * **A component tag is not read, and that is the measurement rather than an
 * omission.** See the note at the top of this file: the tag names what the
 * import line already named, it lands on no node because a `.svelte` file
 * declares no symbol of its own name, and counting it marks the file as having
 * lost coupling it has not lost. If a Svelte component ever gets a node of its
 * own — vue.ts invents one for an SFC with no named default export — this is
 * the paragraph to come back to: the tag would then land somewhere, and the
 * 3 400 of them in open-webui are worth an edge each.
 */
function markupCalls(root: SyntaxNode, scope: Scope): string[] {
  const names = new Set<string>();
  const expressions: string[] = [];
  expressionsOf(root, expressions);

  for (const source of expressions) {
    // Wrapped, so that a bare `x = f()` from `{@const x = f()}` and an arrow
    // from `on:click={() => save()}` both parse as one expression. The newline
    // is what keeps a trailing `//` comment from swallowing the bracket.
    const parsed = parseScript(`(${source}\n)`);
    if (parsed.hasError) continue;
    for (const name of collectCalls(parsed, [], scope)) names.add(name);
  }

  return [...names];
}

/**
 * SvelteKit's `$lib`, which is a real alias with no table behind it.
 *
 * It is generated into `.svelte-kit/tsconfig.json`, which is build output and
 * is in every SvelteKit `.gitignore`, so a clone has no alias table at all —
 * `ProjectFacts.tsPaths` is empty for open-webui and for immich alike. Without
 * this, open-webui resolved 788 of its 4 054 imports and drew 784 import
 * edges; with it, 2 950 and 2 928. That is 2 144 edges, three quarters of the
 * project's own coupling, and a diagram missing them does not look broken —
 * it looks like a codebase whose components do not depend on anything.
 *
 * The mapping is the framework's own default (`config.kit.files.lib`), so it
 * is applied here: `$lib/x` is `src/lib/x` under whichever directory above
 * this file has one. Searched upwards rather than assumed at the root because
 * a Svelte monorepo has an app per directory — svelte.dev is four — and each
 * has its own `src/lib`. The search is its own check: a directory that does
 * not hold the file answers nothing, which is why `$lib` set to something else
 * in `svelte.config.js` costs a miss and never a wrong edge. Measured:
 * 2 162 of open-webui's 2 165 and 1 845 of immich's 1 850.
 */
function kitLib(from: string, specifier: string, files: ReadonlySet<string>): string | null {
  const rest = specifier === '$lib' ? '' : specifier.slice('$lib/'.length);
  for (let directory = path.posix.dirname(from); ; directory = path.posix.dirname(directory)) {
    const base = path.posix.join(directory === '.' ? '' : directory, 'src/lib', rest);
    const hit = componentOr(base, files);
    if (hit !== null) return hit;
    if (directory === '.' || directory === '/' || directory === '') return null;
  }
}

/**
 * A path to a file, trying the component before the module.
 *
 * `.svelte` at the end of a specifier is two things, and the order matters.
 * A component is written with its extension — Svelte requires it — so
 * `./Modal.svelte` is the file of that name and `graph/resolve.ts`, which
 * knows only the JavaScript family's extensions, would treat it as a stem and
 * ask for `./Modal.svelte.ts`. But a Svelte 5 rune module *is* named
 * `auth-manager.svelte.ts` and is imported as `$lib/managers/auth-manager.svelte`,
 * dropping the `.ts` the way any TypeScript module does — 279 of immich's
 * 1 850 `$lib` imports. So the literal file is tried first, and the stem
 * second, which is what resolveModulePath already does.
 */
function componentOr(base: string, files: ReadonlySet<string>): string | null {
  if (files.has(base)) return base;
  return resolveModulePath(base, files);
}

/**
 * The contract, with the one field this module cannot write yet.
 *
 * `'svelte'` has to join `LanguageId` in types.ts and this file has to join
 * the table in registry.ts, and neither is this module's to edit. Everything
 * else is checked against the real contract, so the day the id lands this
 * alias is `LanguageSupport` and can go.
 */
type SvelteSupport = Omit<LanguageSupport, 'id'> & { id: 'svelte' };

export const svelte = {
  id: 'svelte',
  label: 'Svelte',
  extensions: ['.svelte'],

  grammar(_filePath: string) {
    // The module, not its `.language`: the binding reads node-type info off
    // the module, and the bare language crashes inside parse().
    loaded ??= require('@tree-sitter-grammars/tree-sitter-svelte');
    return loaded;
  },

  extract(root: SyntaxNode, _source: string): ModuleParse {
    const imports: string[] = [];
    const symbols: ParsedSymbol[] = [];
    const bindings: ImportBinding[] = [];
    const reexports: Reexport[] = [];
    const calls = new Set<string>();
    let defaultExport: string | undefined;

    const blocks = scriptBlocksOf(root);
    for (const block of blocks) {
      const parse = typescript.extract(block.root, block.source);
      imports.push(...parse.imports, ...dynamicImportsOf(block.root));
      // Props first, which is where a UML class box reads its attributes and
      // where a Svelte script writes them anyway. Not interleaved by line: the
      // store attaches a class's members to the class it just saw, so the
      // order inside the script reader's own list has to survive untouched.
      for (const prop of propsOf(block.root)) symbols.push(shifted(prop, block.offset));
      for (const symbol of parse.symbols) symbols.push(shifted(symbol, block.offset));
      bindings.push(...parse.bindings);
      reexports.push(...parse.reexports);
      for (const name of parse.calls) calls.add(name);
      defaultExport ??= parse.defaultExport;
    }

    // One scope for the markup, from both blocks: a template sees everything
    // the module declared, whichever script declared it.
    for (const name of markupCalls(root, mergedScope(blocks, bindings))) calls.add(name);

    return {
      imports,
      symbols,
      bindings,
      reexports,
      // The file's own, because a component has no symbol that renders it: the
      // markup runs when the component does, which is what a file node means.
      calls: [...calls],
      ...(defaultExport === undefined ? {} : { defaultExport }),
    };
  },

  /**
   * A specifier means what the file says it means, with two additions to the
   * TypeScript rule and nothing else changed.
   *
   * `.svelte` is an extension that means itself, and `$lib` is SvelteKit's.
   * Everything else — a relative `./utils`, a tsconfig alias, a workspace
   * package — is the same question TypeScript answers, so it is answered
   * there rather than copied here and left to drift.
   *
   * Both additions are this language's only, and a `.ts` file in the same
   * project gets neither: 237 imports of a `.svelte` target written in a `.ts`
   * or `.js` file resolve to nothing across immich and svelte.dev, 187 of them
   * through `$lib` and 50 relative. The 50 are `graph/resolve.ts` not knowing
   * the extension, which is one line there and would fix it for every
   * language; the 187 need `$lib` to become a project fact, which is a bigger
   * change than a language file should make on its own.
   */
  resolve(context: ResolveContext): string | null {
    const { from, specifier, files } = context;

    if (specifier === '$lib' || specifier.startsWith('$lib/')) return kitLib(from, specifier, files);

    if (specifier.startsWith('.')) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
      const hit = componentOr(base, files);
      if (hit !== null) return hit;
    }

    return typescript.resolve(context);
  },
} satisfies SvelteSupport;

/**
 * The module scope both script blocks share.
 *
 * `moduleScope` reads one tree, and a component has two: a helper declared in
 * the `module` block types the receivers in the instance block's calls and in
 * the template. Later declarations lose to earlier ones only where a name is
 * declared twice, which Svelte does not allow.
 */
function mergedScope(blocks: readonly Block[], bindings: readonly ImportBinding[]): Scope {
  const merged = new Map<string, string | null>();
  for (const block of blocks) {
    for (const [name, type] of moduleScope(block.root, bindings).bindings) {
      if (!merged.has(name)) merged.set(name, type);
    }
  }
  return { owner: null, fields: new Map(), bindings: merged, locals: [], typeParameters: new Set() };
}

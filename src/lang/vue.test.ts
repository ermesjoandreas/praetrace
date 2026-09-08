import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { resolveImport } from '../graph/resolve.js';
import { applyBatch, createStore, setProjectFacts } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile } from '../parser/types.js';
import { languageById } from './registry.js';
import { javascript } from './javascript.js';
import { typescript } from './typescript.js';
import { blocksOf, componentName, renderedComponents, scriptSource, templateTags, vue } from './vue.js';

/**
 * `'vue'` is not a `LanguageId` until `src/lang/types.ts` admits it — see the
 * note above `VueSupport` in vue.ts. Written once here rather than at every
 * literal, and it goes away with the alias it mirrors.
 */
const VUE_ID = vue.id as ParsedFile['language'];

// The grammar is a native addon, and the blanking this file exists to check is
// only true against a real tree: a hand-built one would carry whatever rows the
// test wrote on it, which is the bug rather than the check.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

/**
 * The fixtures are read out of `src/`, not out of `dist/`, because tsc emits
 * `.ts` and nothing else: a `.vue` file compiled by this project would never
 * arrive beside the test. The same path checker.test.ts uses, for the same
 * reason.
 */
const FIXTURES = fileURLToPath(new URL('../../src/lang/fixtures/vue/', import.meta.url));

const fixture = (name: string): string => readFileSync(path.join(FIXTURES, name), 'utf8');

/** One file read the way `parseSource` reads it: preprocess, parse, extract. */
function read(source: string, filePath = 'Widget.vue') {
  const parser = new TreeSitter();
  parser.setLanguage(vue.grammar(filePath) as Parser.Language);
  return vue.extract(parser.parse(vue.preprocess(source)).rootNode, source, filePath);
}

/** A file as the store receives it: a `.vue`, or one of the modules beside it. */
function parsedFile(filePath: string, source: string): ParsedFile {
  const isVue = filePath.endsWith('.vue');
  const isJs = filePath.endsWith('.js');
  const language = isVue ? vue : isJs ? javascript : typescript;
  const parser = new TreeSitter();
  parser.setLanguage(language.grammar(filePath) as Parser.Language);
  const parse = language.extract(parser.parse(isVue ? vue.preprocess(source) : source).rootNode, source, filePath);
  return {
    filePath,
    language: isVue ? VUE_ID : isJs ? 'javascript' : 'typescript',
    lineCount: source.split('\n').length,
    modifiedAt: 0,
    ...parse,
  };
}

function graphOf(...files: ParsedFile[]): Graph {
  const store = createStore();
  setProjectFacts(store, { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() });
  applyBatch(store, files, []);
  return store.graph;
}

const edgesOf = (graph: Graph, kind: string): string[] =>
  graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();

/**
 * What the rest of the tree still has to admit before a `.vue` specifier can
 * reach a file, or `false` when it all has.
 *
 * The two edge tests below are the ones CLAUDE.md's rule asks for — a language
 * is finished when its edges are checked — and neither can pass while the graph
 * cannot follow `./Logo.vue`. They skip with the missing change named rather
 * than failing, the way the corpus baseline skips a clone it has not got, and
 * they start running the day it lands. Everything above them is this reader's
 * own work and runs either way.
 */
function unwired(): string | false {
  if (languageById(VUE_ID) === null) {
    return "register `vue` in src/lang/registry.ts, and add 'vue' to LanguageId in src/lang/types.ts";
  }
  if (resolveImport('a.ts', './b.vue', new Set(['b.vue'])) === null) {
    return "add '.vue' to EXTENSIONS in src/graph/resolve.ts";
  }
  return false;
}

const NEEDS_WIRING = unwired();

test('the blocks are the top-level ones, and a comment holding <script> is not one', () => {
  const blocks = blocksOf(fixture('App.vue'));
  assert.deepEqual(
    blocks.map((block) => block.tag),
    ['template', 'script', 'style'],
  );
  const script = blocks[1]!;
  assert.equal(script.attributes, ' setup lang="ts"');
  // The comment on line 1 writes the word `<script>`. Reading it would put the
  // block sixteen lines early and shift every symbol in the file with it.
  assert.ok(fixture('App.vue').slice(script.start).startsWith('\nimport type { Table }'));
});

test('a template ends at its own close, not at the first nested one', () => {
  const source = '<template>\n  <template v-if="a">\n    <p>x</p>\n  </template>\n  <b>y</b>\n</template>\n';
  const [block] = blocksOf(source);
  assert.ok(block);
  assert.ok(source.slice(block.start, block.end).includes('<b>y</b>'));
});

test('an attribute may hold a > without ending the tag', () => {
  const [block] = blocksOf('<template v-if="a > b">\n  <p>x</p>\n</template>\n');
  assert.ok(block);
  assert.equal(block.attributes, ' v-if="a > b"');
});

test('the parsed text is the file, character for character, with only the script left', () => {
  const source = fixture('App.vue');
  const blanked = scriptSource(source);
  assert.equal(blanked.length, source.length);
  assert.equal(blanked.split('\n').length, source.split('\n').length);
  assert.ok(!blanked.includes('<div class="app">'));
  assert.ok(blanked.includes("import StatusCard from './StatusCard.vue';"));
  // Everything that is not the script is a space or a newline, so a row and a
  // column in the tree are a row and a column in the file.
  assert.ok(/^[ \n]*$/.test(blanked.slice(0, source.indexOf('<script'))));
});

test('a symbol is at the line of the file, not the line of the block', () => {
  const source = fixture('App.vue');
  const lines = source.split('\n');
  const parse = read(source, 'App.vue');
  const load = parse.symbols.find((symbol) => symbol.name === 'load');
  assert.ok(load, 'no symbol named load');
  // The script opens on line 17 and `load` is the eleventh line inside it. The
  // sum is what every id, every range and every jump-to-source depends on, so
  // it is pinned against the fixture's own text rather than against a number.
  assert.equal(load.startLine, 27);
  assert.equal(load.endLine, 29);
  assert.ok(lines[load.startLine - 1]?.startsWith('function load'));
});

test('a script-setup component is a symbol, named after its file', () => {
  const parse = read(fixture('widgets/SidebarItem.vue'), 'widgets/SidebarItem.vue');
  const component = parse.symbols[0];
  assert.ok(component);
  assert.equal(component.name, 'SidebarItem');
  assert.equal(component.kind, 'class');
  assert.equal(component.exported, false);
  // It leaves the file as `default`, the way `export default class Foo` does.
  assert.equal(parse.defaultExport, 'SidebarItem');
});

test('a directory index is named by its directory', () => {
  assert.equal(componentName('src/layout/index.vue'), 'Layout');
  assert.equal(componentName('src/components/status-card/index.vue'), 'StatusCard');
  assert.equal(componentName('StatusCard.vue'), 'StatusCard');
  assert.equal(componentName('src/widgets/sidebar-item.vue'), 'SidebarItem');
});

test('a component the script bound keeps the name the script gave it', () => {
  // `const Logo = defineComponent(…); export default Logo` binds a name to a
  // call, which is no symbol — so the component is invented, but under the
  // source's own word for it rather than the file's.
  const parse = read(fixture('Logo.vue'), 'Logo.vue');
  assert.equal(parse.symbols[0]?.name, 'Logo');
  assert.equal(parse.defaultExport, 'Logo');
});

test('what the template renders hangs off the component', () => {
  const parse = read(fixture('App.vue'), 'App.vue');
  const component = parse.symbols[0];
  assert.ok(component);
  assert.equal(component.name, 'App');
  // `<StatusCard>` as written and `<sidebar-item>` as the same name in kebab.
  assert.deepEqual([...component.calls].sort(), ['SidebarItem', 'StatusCard']);
});

test('a native tag is never a component, whatever the file bound', () => {
  // element-plus's table.vue writes `<table>` eight times and imports a *type*
  // called `Table`; matching the tag's PascalCase drew a call edge from the
  // component to itself, and it was the only untrue edge in 2 098 across five
  // repositories. App.vue is the same shape on purpose.
  const bound = new Set(['Table', 'Slot', 'Logo']);
  assert.deepEqual(renderedComponents('<template><table><slot /></table></template>', bound), []);
  // The capitalised spelling is a component, and Vue reads it as one.
  assert.deepEqual(renderedComponents('<template><Slot /></template>', bound), ['Slot']);
});

test('a tag nobody imported is not an edge', () => {
  // Nuxt auto-imports most of a template's tags and names them nowhere at all.
  // Matching those against the project by filename would draw the component
  // tree everyone wants, and it would be a guess.
  assert.deepEqual(renderedComponents('<template><ElMenu /><auto-imported /></template>', new Set(['Logo'])), []);
});

test('a namespaced tag is resolved through the head the file bound', () => {
  assert.deepEqual(renderedComponents('<template><Icons.Check /></template>', new Set(['Icons'])), ['Icons.Check']);
  assert.deepEqual(renderedComponents('<template><Icons.Check /></template>', new Set(['Check'])), []);
});

test('every tag is collected, and the script block is not read for them', () => {
  const tags = templateTags(fixture('App.vue'));
  assert.ok(tags.includes('StatusCard'));
  assert.ok(tags.includes('sidebar-item'));
  assert.ok(tags.includes('table'));
  assert.ok(!tags.includes('style'));
});

test('a block kept in another file is an import; a stylesheet is not', () => {
  const parse = read(
    '<template src="./markup.html"></template>\n<script src="./logic.ts"></script>\n<style src="./theme.css"></style>\n',
  );
  assert.deepEqual(parse.imports, ['./markup.html', './logic.ts']);
});

test('markup we do not parse cannot make the file wear the syntax-error badge', () => {
  // The template is blanked before the parser sees it, so a broken tag is not
  // a parse error. It is not a lie either: nothing in the markup is a symbol.
  const parser = new TreeSitter();
  parser.setLanguage(vue.grammar('Broken.vue') as Parser.Language);
  const source = '<template>\n  <div <<< >\n</template>\n\n<script setup lang="ts">\nconst a = 1;\n</script>\n';
  assert.equal(parser.parse(vue.preprocess(source)).rootNode.hasError, false);
});

test('the component nodes and the edges between them', { skip: NEEDS_WIRING }, () => {
  const files = ['App.vue', 'StatusCard.vue', 'Logo.vue', 'types.ts', 'widgets/index.js', 'widgets/SidebarItem.vue'];
  const graph = graphOf(...files.map((file) => parsedFile(file, fixture(file))));

  // What the template renders, through a direct default import, through a
  // barrel that re-exports one, and from a component written the options way.
  assert.deepEqual(edgesOf(graph, 'calls'), [
    'App.vue#App -> StatusCard.vue#StatusCard',
    'App.vue#App -> widgets/SidebarItem.vue#SidebarItem',
    'StatusCard.vue#StatusCard -> Logo.vue#Logo',
  ]);
  assert.deepEqual(edgesOf(graph, 'imports'), [
    'App.vue -> StatusCard.vue',
    'App.vue -> types.ts',
    'App.vue -> widgets/index.js',
    'StatusCard.vue -> Logo.vue',
    'widgets/index.js -> widgets/SidebarItem.vue',
  ]);
  // Every component is a box with something in it, and nothing was guessed.
  for (const file of files.filter((name) => name.endsWith('.vue'))) {
    assert.ok(graph.nodes.has(`${file}#${componentName(file)}`), `no component node for ${file}`);
  }
  assert.deepEqual(graph.edges.filter((edge) => edge.guessed === true), []);
});

test('a specifier in an SFC means what an ES specifier means', { skip: NEEDS_WIRING }, () => {
  const files = new Set(['src/App.vue', 'src/components/Logo.vue', 'src/layout/index.vue']);
  const context = {
    files,
    modules: new Map(),
    declarations: new Map(),
    imports: new Map(),
    facts: { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() },
  };
  const resolve = (specifier: string): string | null => vue.resolve({ ...context, from: 'src/App.vue', specifier });
  assert.equal(resolve('./components/Logo.vue'), 'src/components/Logo.vue');
  assert.equal(resolve('./layout'), 'src/layout/index.vue');
  assert.equal(resolve('vue'), null);
});

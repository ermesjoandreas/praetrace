import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedSymbol } from '../parser/types.js';
import { svelte } from './svelte.js';
import type { ResolveContext } from './types.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(svelte.grammar('a.svelte') as Parser.Language);
  return svelte.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name);
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

/** A resolve context over a file set, with nothing else filled in. */
function context(from: string, specifier: string, files: readonly string[]): ResolveContext {
  return {
    from,
    specifier,
    files: new Set(files),
    modules: new Map(),
    declarations: new Map(),
    imports: new Map(),
    facts: { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() },
  };
}

const resolve = (from: string, specifier: string, files: readonly string[]): string | null =>
  svelte.resolve(context(from, specifier, files));

/**
 * The line numbers are the whole point of splitting the file rather than
 * handing the script to the parser on its own: a symbol found on line 3 of a
 * block that starts on line 12 is on line 14, and the panel, the box and every
 * jump to source read that sum.
 */
test('a symbol keeps the line the .svelte file has it on', () => {
  const parse_ = parse(`<h1>hello</h1>

<script lang="ts">
  import { load } from './api';

  export let title: string;

  function greet() {
    return load(title);
  }
</script>
`);
  assert.equal(byName(parse_.symbols, 'title').startLine, 6);
  const greet = byName(parse_.symbols, 'greet');
  assert.equal(greet.startLine, 8);
  assert.equal(greet.endLine, 10);
});

test('both script blocks are read, and each keeps its own offset', () => {
  const parse_ = parse(`<script context="module" lang="ts">
  export const prerender = true;
</script>

<script lang="ts">
  import Store from './store';

  export function reset() {}
</script>
`);
  assert.equal(byName(parse_.symbols, 'prerender').startLine, 2);
  assert.equal(byName(parse_.symbols, 'reset').startLine, 8);
  assert.deepEqual(parse_.imports, ['./store']);
});

/**
 * `export let title: string` is a Svelte 4 prop with no default, which the
 * TypeScript reader drops because a declarator with no initialiser says
 * nothing about what it holds.
 */
test('an export with no initialiser is a prop, and props are listed first', () => {
  const parse_ = parse(`<script lang="ts">
  function helper() {}
  export let title: string;
  export let open = false;
</script>
`);
  const title = byName(parse_.symbols, 'title');
  assert.equal(title.kind, 'field');
  assert.equal(title.exported, true);
  assert.equal(title.startLine, 3);
  assert.equal(parse_.symbols[0]?.name, 'title');
});

test('a dynamic import is an import', () => {
  const parse_ = parse(`<script lang="ts">
  import Modal from './Modal.svelte';
  const panel = () => import('./Panel.svelte');
  const named = (spec: string) => import(spec);
</script>
`);
  assert.deepEqual(parse_.imports.sort(), ['./Modal.svelte', './Panel.svelte']);
  assert.deepEqual(
    parse_.bindings.map((binding) => binding.local),
    ['Modal'],
  );
});

/**
 * What the markup adds: calls written in an interpolation, an event handler
 * and a block condition, and written nowhere else in the file.
 */
test('the markup expressions are the file calls', () => {
  const parse_ = parse(`<script lang="ts">
  import { fmt, save, isAdmin, sum, getItems } from './lib';
  let user = null;
  let items = [];
</script>

{#if isAdmin(user)}
  <button on:click={() => save(user)}>{fmt(user)}</button>
{/if}

{#each getItems() as item (item.id)}
  {@const total = sum(item.rows)}
  <span>{total}</span>
{/each}

{#snippet footer(note)}
  <i>{note}</i>
{/snippet}
{@render footer('x')}
`);
  const calls = new Set(parse_.calls);
  for (const name of ['isAdmin', 'save', 'fmt', 'getItems', 'sum', 'footer']) {
    assert.ok(calls.has(name), `${name} missing from ${[...calls].join(', ')}`);
  }
});

/**
 * A binding pattern is written in the same node type an expression is, and
 * read as one it invents a call: `{#each items as item (item.id)}` recovers
 * into a call to `item`, and `{#snippet row(a)}` into one to `row`.
 */
test('a binding pattern is never a call', () => {
  const parse_ = parse(`<script lang="ts">
  import { rows } from './lib';
</script>

{#each rows as row (row.id)}
  <b>{row.name}</b>
{/each}

{#snippet card(entry)}
  <i>{entry}</i>
{/snippet}
`);
  const calls = new Set(parse_.calls);
  assert.ok(!calls.has('row'), 'the each pattern was read as a call');
  assert.ok(!calls.has('card'), 'the snippet name was read as a call');
});

/**
 * A fragment that is not an expression is dropped whole rather than let
 * recover into something call-shaped. `{#await p then v}` is the form that
 * costs an edge, and that is the trade: a missing edge is a gap, a wrong one
 * is a lie.
 */
test('a fragment that does not parse contributes nothing', () => {
  const parse_ = parse(`<script lang="ts">
  import { load, ready } from './lib';
</script>

{#await load() then value}
  <b>{value}</b>
{/await}

{#await ready()}
  <i>waiting</i>
{/await}
`);
  const calls = new Set(parse_.calls);
  assert.ok(calls.has('ready'), 'a plain await condition is an expression');
  assert.ok(!calls.has('load'), 'the `then` form is not an expression and must be dropped');
});

test('a shorthand attribute is a name, not a call', () => {
  const parse_ = parse(`<script lang="ts">
  import Icon from './Icon.svelte';
  export let className = '';
</script>

<Icon {className} />
`);
  assert.ok(!new Set(parse_.calls).has('className'));
});

/**
 * The measured decision, and the one most likely to be revisited: a component
 * tag names what the import line already named, it lands on no node because a
 * `.svelte` file declares no symbol of its own name, and counting it marks a
 * file as having lost coupling the import edge is drawing. See the note above
 * `markupCalls`.
 */
test('a component tag is not a call, and its import is still an import', () => {
  const parse_ = parse(`<script lang="ts">
  import Modal from './Modal.svelte';
  import * as Icons from './icons';
</script>

<Modal>
  <Icons.Check />
</Modal>
`);
  assert.deepEqual(parse_.imports.sort(), ['./Modal.svelte', './icons']);
  const calls = new Set(parse_.calls);
  assert.ok(!calls.has('Modal'));
  assert.ok(!calls.has('Icons.Check'));
});

/** A store read is what the import already said; the `$` is not a reference. */
test('a dollar-prefixed store read draws nothing the import did not', () => {
  const parse_ = parse(`<script lang="ts">
  import { count } from './stores';
</script>

<p>{$count}</p>
`);
  assert.deepEqual(parse_.imports, ['./stores']);
  const calls = new Set(parse_.calls);
  assert.ok(!calls.has('count'));
  assert.ok(!calls.has('$count'));
});

/**
 * The template is read against the script's scope, both blocks of it, so a
 * receiver the script typed is still typed in the markup.
 */
test('a receiver the script typed is typed in the markup too', () => {
  const parse_ = parse(`<script context="module" lang="ts">
  import { Cache } from './cache';
  const cache = new Cache();
</script>

<script lang="ts">
  import { Store } from './store';
  const store = new Store();
</script>

<p>{store.load()} {cache.get()}</p>
`);
  const calls = new Set(parse_.calls);
  assert.ok(calls.has('Store.load'), [...calls].join(', '));
  assert.ok(calls.has('Cache.get'), [...calls].join(', '));
});

test('a markup error costs the markup, not the script', () => {
  const parse_ = parse(`<script lang="ts">
  import { save } from './lib';
  export function submit() {
    save();
  }
</script>

<span
  >{'{'}</span
>
`);
  assert.equal(byName(parse_.symbols, 'submit').startLine, 3);
  assert.deepEqual(parse_.imports, ['./lib']);
});

test('a component specifier names the file it spells', () => {
  assert.equal(resolve('src/App.svelte', './Modal.svelte', ['src/Modal.svelte']), 'src/Modal.svelte');
  assert.equal(resolve('src/App.svelte', './Modal.svelte', ['src/Other.svelte']), null);
});

/**
 * `auth-manager.svelte.ts` imported as `.../auth-manager.svelte` is a Svelte 5
 * rune module, and `Thing.svelte` beside `Thing.svelte.ts` is the case where
 * the order matters: the component is what the extension was written for.
 */
test('a rune module is found behind the same extension, and the component wins', () => {
  assert.equal(
    resolve('src/App.svelte', '$lib/managers/auth.svelte', ['src/lib/managers/auth.svelte.ts']),
    'src/lib/managers/auth.svelte.ts',
  );
  assert.equal(
    resolve('src/App.svelte', './Thing.svelte', ['src/Thing.svelte', 'src/Thing.svelte.ts']),
    'src/Thing.svelte',
  );
});

/**
 * `$lib` is generated into `.svelte-kit/tsconfig.json`, which no clone holds,
 * so there is no alias table to read it out of — and it is per app, not per
 * repository, which is why the search walks up.
 */
test('$lib is the src/lib of the nearest directory that has one', () => {
  const files = ['apps/web/src/lib/Button.svelte', 'apps/web/src/lib/index.ts', 'apps/docs/src/lib/Button.svelte'];
  assert.equal(
    resolve('apps/web/src/routes/+page.svelte', '$lib/Button.svelte', files),
    'apps/web/src/lib/Button.svelte',
  );
  assert.equal(resolve('apps/web/src/routes/+page.svelte', '$lib', files), 'apps/web/src/lib/index.ts');
  assert.equal(resolve('apps/web/src/routes/+page.svelte', '$lib/Missing.svelte', files), null);
});

test('everything else is the question TypeScript answers', () => {
  assert.equal(resolve('src/App.svelte', './utils', ['src/utils.ts']), 'src/utils.ts');
  assert.equal(resolve('src/App.svelte', 'svelte', ['src/svelte.ts']), null);
  assert.equal(resolve('src/App.svelte', '$app/navigation', ['src/app/navigation.ts']), null);
});

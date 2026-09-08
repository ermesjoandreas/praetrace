import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksInternal, resolveImport, resolveModulePath } from './resolve.js';

const files = new Set([
  'index.js',
  'lib/express.js',
  'lib/router/index.js',
  'lib/utils.js',
  'test/app.js',
  'test/res/send.js',
  'src/store.ts',
  'src/index.ts',
]);

test('a specifier naming the root directory resolves to its index', () => {
  // `require('..')` and `require('../')` are how every express test reaches the
  // package; the first normalises to `.` and the second to `./`, and neither
  // is a file.
  assert.equal(resolveImport('test/app.js', '..', files), 'index.js');
  assert.equal(resolveImport('test/app.js', '../', files), 'index.js');
  assert.equal(resolveImport('test/res/send.js', '../..', files), 'index.js');
  assert.equal(resolveImport('test/res/send.js', '../../', files), 'index.js');
});

test('a specifier naming a directory resolves to its index, from anywhere', () => {
  assert.equal(resolveImport('lib/express.js', './router', files), 'lib/router/index.js');
  assert.equal(resolveImport('lib/express.js', './router/', files), 'lib/router/index.js');
  assert.equal(resolveImport('lib/router/index.js', './', files), 'lib/router/index.js');
  assert.equal(resolveImport('lib/router/index.js', '.', files), 'lib/router/index.js');
});

test('a trailing slash means the directory, never a file of that name', () => {
  // `lib/utils.js` exists, but `./utils/` can only mean `lib/utils/index.*`.
  assert.equal(resolveImport('lib/express.js', './utils', files), 'lib/utils.js');
  assert.equal(resolveImport('lib/express.js', './utils/', files), null);
});

test('a file beats a directory of the same name, and TypeScript beats JavaScript', () => {
  assert.equal(resolveImport('lib/express.js', './utils', files), 'lib/utils.js');
  assert.equal(resolveModulePath('src', files), 'src/index.ts');
  assert.equal(resolveModulePath('src/store.js', files), 'src/store.ts');
});

test('a bare specifier is not a path', () => {
  assert.equal(resolveImport('test/app.js', 'supertest', files), null);
  assert.equal(resolveImport('test/app.js', 'node:fs', files), null);
});

test('a directory with no index resolves to nothing rather than to a neighbour', () => {
  assert.equal(resolveImport('test/app.js', './res', files), null);
  assert.equal(resolveImport('test/app.js', '../lib', files), null);
});

/**
 * The view layer's whole claim on this module, and it is two rules.
 *
 * `.vue` is an ordinary candidate extension, because the file importing a
 * component is usually not itself a component — `@/layout` is `layout/index.vue`
 * in a `.js` router as often as in an SFC, and vue-element-admin had 70
 * unresolved internal imports before this and none after. An extension no
 * language here rewrites names the file as written, which is what a Svelte
 * import and an Angular `templateUrl` are.
 */
test('a component is a candidate for a specifier that names no extension', () => {
  const files = new Set(['src/layout/index.vue', 'src/components/TabPane.vue', 'src/main.js']);
  assert.equal(resolveImport('src/main.js', './components/TabPane', files), 'src/components/TabPane.vue');
  assert.equal(resolveImport('src/main.js', './layout', files), 'src/layout/index.vue');
});

test('an extension no language rewrites names the file as written, then the stem', () => {
  const files = new Set(['src/Modal.svelte', 'src/auth.svelte.ts', 'src/app.ts', 'src/hero.html']);
  assert.equal(resolveImport('src/app.ts', './Modal.svelte', files), 'src/Modal.svelte');
  // Svelte 5 writes a rune module as `auth.svelte.ts` and imports it as `auth.svelte`.
  assert.equal(resolveImport('src/app.ts', './auth.svelte', files), 'src/auth.svelte.ts');
  assert.equal(resolveImport('src/app.ts', './hero.html', files), 'src/hero.html');
  // And a name the project does not hold is still nothing, not a near miss.
  assert.equal(resolveImport('src/app.ts', './Other.svelte', files), null);
});

test('a JavaScript extension is still a question, not the name of a file', () => {
  // The rule above must not overtake this one: `./store.js` beside a store.ts
  // is NodeNext's spelling of the TypeScript source, and answering `store.js`
  // would draw the wrong file whenever a project ships both.
  const files = new Set(['src/store.ts', 'src/store.js', 'src/app.ts']);
  assert.equal(resolveImport('src/app.ts', './store.js', files), 'src/store.ts');
});

// Each of these read as "the project lost this coupling" and none of them was
// a loss. Counting them is the express failure: 133 of 141 files marked, and
// the number that was supposed to say "we could not follow this file" saying
// nothing at all.
test('what a language spells differently is still counted, or not counted, honestly', () => {
  const facts = { tsPaths: new Map(), packages: new Map(), goModule: null };
  const prefixes = new Set(['okhttp3', 'App', 'src']);

  // C and C++: the punctuation is the answer.
  assert.equal(looksInternal('"okhttp3/util.h"', 'cpp', facts, prefixes), true);
  assert.equal(looksInternal('<vector>', 'cpp', facts, prefixes), false);
  assert.equal(looksInternal('<sys/types.h>', 'cpp', facts, prefixes), false);

  // Kotlin: a bare `String` arrives as the packages it might have come from,
  // headed by the file's own — a guess list, never an import anyone wrote.
  assert.equal(looksInternal('okhttp3.String|kotlin.String', 'kotlin', facts, prefixes), false);
  assert.equal(looksInternal('okhttp3.Request', 'kotlin', facts, prefixes), true);

  // PHP separates with a backslash, so the head used to be the whole string.
  assert.equal(looksInternal('App\\Models\\User', 'php', facts, prefixes), true);
  assert.equal(looksInternal('Symfony\\Component\\Console', 'php', facts, prefixes), false);
});


import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `listrows.test.ts` beside it: the page is bundled by vite and never
// compiled into dist/, so there is no fileicons.js for `node --test` to find.
import { FILE_ICON_URLS, fileIconFor, fileIconIdFor } from './fileicons.ts';

test('every extension a language claims has the theme’s icon for it', () => {
  // The seven languages in src/lang, and the theme's two JSX variants — a
  // .tsx and a .jsx are the same language and a different picture, which is
  // how the editor draws them.
  assert.equal(fileIconIdFor('src/graph/store.ts'), 'typescript');
  assert.equal(fileIconIdFor('a.mts'), 'typescript');
  assert.equal(fileIconIdFor('a.cts'), 'typescript');
  assert.equal(fileIconIdFor('web/src/App.tsx'), 'react_ts');
  assert.equal(fileIconIdFor('lib/router.js'), 'javascript');
  assert.equal(fileIconIdFor('scripts/corpus.mjs'), 'javascript');
  assert.equal(fileIconIdFor('a.cjs'), 'javascript');
  assert.equal(fileIconIdFor('src/Button.jsx'), 'react');
  assert.equal(fileIconIdFor('src/main/java/App.java'), 'java');
  assert.equal(fileIconIdFor('cmd/root.go'), 'go');
  assert.equal(fileIconIdFor('Program.cs'), 'csharp');
  assert.equal(fileIconIdFor('src/lib.rs'), 'rust');
  assert.equal(fileIconIdFor('src/flask/app.py'), 'python');
});

test('a .d.ts is TypeScript, as the registry says it is', () => {
  assert.equal(fileIconIdFor('types/index.d.ts'), 'typescript');
});

test('the extension is read case-blind, as the registry reads it', () => {
  assert.equal(fileIconIdFor('Main.JAVA'), 'java');
});

test('what view/tests.ts calls a test wears the test variant, where the theme has one', () => {
  assert.equal(fileIconIdFor('src/view/lanes.test.ts'), 'test-ts');
  assert.equal(fileIconIdFor('src/app.spec.js'), 'test-js');
  assert.equal(fileIconIdFor('src/Button.test.tsx'), 'test-jsx');
  assert.equal(fileIconIdFor('src/Button.spec.jsx'), 'test-jsx');
  assert.equal(fileIconIdFor('src/Button.stories.tsx'), 'test-jsx');
  // The directory rule is the predicate's, not this file's: a plain name
  // under __tests__/ is a test there, so it is one here.
  assert.equal(fileIconIdFor('src/__tests__/store.ts'), 'test-ts');
  assert.equal(fileIconIdFor('test/app.js'), 'test-js');
});

test('a test in a language the theme has no test icon for keeps the language’s icon', () => {
  // The theme draws these with the language icon in the editor, and so does this.
  assert.equal(fileIconIdFor('cmd/root_test.go'), 'go');
  assert.equal(fileIconIdFor('src/test/java/AppTest.java'), 'java');
  assert.equal(fileIconIdFor('src/tests.rs'), 'rust');
  assert.equal(fileIconIdFor('tests/test_app.py'), 'python');
  assert.equal(fileIconIdFor('Tests/AppTests.cs'), 'csharp');
});

test('a path the theme has no icon for is null, so the caller keeps its codicon', () => {
  assert.equal(fileIconIdFor('README.md'), null);
  assert.equal(fileIconIdFor('src/App.vue'), null);
  assert.equal(fileIconIdFor('src/lib'), null);
  assert.equal(fileIconIdFor('Makefile'), null);
  assert.equal(fileIconIdFor('.ts'), null, 'a dotfile is not an extension');
  assert.equal(fileIconIdFor(''), null);
  assert.equal(fileIconFor('README.md'), null);
});

test('an icon carries its picture and what it says', () => {
  const icon = fileIconFor('src/view/lanes.test.ts');
  assert.ok(icon !== null);
  assert.equal(icon.id, 'test-ts');
  assert.equal(icon.label, 'TypeScript test');
  assert.equal(icon.url, FILE_ICON_URLS['test-ts']);
});

test('the twelve pictures are on disk, each an SVG carrying the theme’s licence line', () => {
  // Under Node the URLs are file: URLs into web/src/icons/; under Vite they
  // are what the build made of the same files. Checking the files here is
  // what stops an icon being renamed away from the id that names it.
  const ids = Object.keys(FILE_ICON_URLS);
  assert.equal(ids.length, 12);
  for (const id of ids) {
    const url = FILE_ICON_URLS[id as keyof typeof FILE_ICON_URLS];
    assert.ok(url.startsWith('file:'), `${id}: ${url}`);
    const svg = readFileSync(fileURLToPath(url), 'utf8');
    assert.ok(svg.startsWith('<!-- Material Icon Theme'), `${id} has lost its licence line`);
    assert.ok(svg.includes('MIT'), `${id} names no licence`);
    assert.ok(svg.includes('<svg'), `${id} is not an SVG`);
  }
});

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type Parser from 'tree-sitter';
import type { ParsedFile } from '../parser/types.js';
import { angular, componentTemplates, namedTemplates, readTemplate } from './angular.js';
import { typescript } from './typescript.js';

// A component names its view in TypeScript, so the tree under test is a
// TypeScript tree and the grammar is TypeScript's. The native addon parses a
// real one rather than a hand-built shape, because the node shapes are what
// `componentTemplates` reads.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function templatesOf(source: string, filePath = 'a.ts'): string[] {
  const parser = new TreeSitter();
  parser.setLanguage(typescript.grammar(filePath) as Parser.Language);
  return componentTemplates(parser.parse(source).rootNode);
}

/** A file as the scan would hand it on, with only the fields this reads. */
function parsedFile(filePath: string, imports: string[]): ParsedFile {
  return { filePath, language: 'typescript', imports, symbols: [], lineCount: 1, modifiedAt: 0 };
}

test('a bare template name is resolved against the component, the way Angular does', () => {
  assert.deepEqual(
    templatesOf(`@Component({ selector: 'app-hero', templateUrl: 'hero.html' })\nclass Hero {}\n`),
    ['./hero.html'],
  );
});

test('a template name written as a specifier is left as written', () => {
  assert.deepEqual(templatesOf(`@Component({ templateUrl: './hero.html' })\nclass Hero {}\n`), ['./hero.html']);
  assert.deepEqual(templatesOf(`@Component({ templateUrl: '../shared/hero.html' })\nclass Hero {}\n`), [
    '../shared/hero.html',
  ]);
});

test('a quoted key is the same key', () => {
  assert.deepEqual(templatesOf(`@Component({ 'templateUrl': 'hero.html' })\nclass Hero {}\n`), ['./hero.html']);
});

test('a string compared to templateUrl is not a component naming its view', () => {
  // angular/components' own schematics write this, and every regexp over the
  // source reads it as a template. The pair is what makes the difference.
  assert.deepEqual(templatesOf(`function isIt(name: string) { return name === 'templateUrl'; }\n`), []);
  assert.deepEqual(templatesOf(`const meta = { templateUrl: 'hero.html' };\n`), []);
});

test('only a decorator with a view has one', () => {
  assert.deepEqual(templatesOf(`@Injectable({ templateUrl: 'hero.html' })\nclass Hero {}\n`), []);
  assert.deepEqual(templatesOf(`@Directive({ selector: '[hero]' })\nclass Hero {}\n`), []);
});

test('a name no file in the project could be is refused', () => {
  assert.deepEqual(templatesOf(`@Component({ templateUrl: 'https://cdn/hero.html' })\nclass H {}\n`), []);
  assert.deepEqual(templatesOf(`@Component({ templateUrl: '/assets/hero.html' })\nclass H {}\n`), []);
  assert.deepEqual(templatesOf(`@Component({ templateUrl: '' })\nclass H {}\n`), []);
  // Not a plain string: skipped rather than guessed at.
  assert.deepEqual(templatesOf('@Component({ templateUrl: `${base}/hero.html` })\nclass H {}\n'), []);
});

test('styleUrls are read by nobody', () => {
  assert.deepEqual(
    templatesOf(`@Component({ templateUrl: 'hero.html', styleUrls: ['hero.css'] })\nclass H {}\n`),
    ['./hero.html'],
  );
});

test('only the decorator option itself is a template name', () => {
  // A nested object is somebody else's configuration. Reading it would be the
  // regexp's mistake in a different costume.
  assert.deepEqual(templatesOf(`@Component({ host: { templateUrl: 'hero.html' } })\nclass H {}\n`), []);
});

test('a decorator with nothing in it names nothing', () => {
  assert.deepEqual(templatesOf(`@Component()\nclass H {}\n`), []);
  assert.deepEqual(templatesOf(`@Component\nclass H {}\n`), []);
});

test('the tsx dialect is the same tree', () => {
  // tree-sitter-typescript holds two grammars, and a component in a `.tsx`
  // file has to be read by whichever one the file is handed to.
  assert.deepEqual(templatesOf(`@Component({ templateUrl: 'hero.html' })\nclass H {}\n`, 'a.tsx'), ['./hero.html']);
});

test('one file can name several views', () => {
  const source = `@Component({ templateUrl: 'a.html' })\nclass A {}\n@Component({ templateUrl: 'b.html' })\nclass B {}\n`;
  assert.deepEqual(templatesOf(source), ['./a.html', './b.html']);
});

test('a named template is a path from the root, deduplicated and sorted', () => {
  const named = namedTemplates([
    parsedFile('src/app/hero/hero.component.ts', ['./hero.component.html', '@angular/core']),
    parsedFile('src/app/app.component.ts', ['./app.component.html', './hero/hero.component.js']),
    // The same view, named twice, is one file.
    parsedFile('src/app/hero/hero.other.ts', ['./hero.component.html']),
  ]);
  assert.deepEqual(named, ['src/app/app.component.html', 'src/app/hero/hero.component.html']);
});

test('nothing but a relative .html is a template', () => {
  assert.deepEqual(
    namedTemplates([
      parsedFile('src/app.ts', ['./app.css', './app.scss', './app', 'node:fs', 'some-package/x.html']),
    ]),
    [],
  );
});

test('a template above the root has no id, so it is dropped', () => {
  assert.deepEqual(namedTemplates([parsedFile('app.component.ts', ['../outside.html'])]), []);
  // From one level down, the same climb lands inside and is kept.
  assert.deepEqual(namedTemplates([parsedFile('src/app.component.ts', ['../outside.html'])]), ['outside.html']);
});

test('a template is a file with no symbols and no syntax error to report', () => {
  const parsed = readTemplate('src/app/hero.html', '<h1>Hero</h1>\n<p>x</p>\n', 42);
  assert.equal(parsed.filePath, 'src/app/hero.html');
  assert.deepEqual(parsed.symbols, []);
  assert.deepEqual(parsed.imports, []);
  assert.equal(parsed.lineCount, 2);
  assert.equal(parsed.modifiedAt, 42);
  // Absent, never false: a scanner has no tree and so no grammar's word about
  // one, and the box must not wear a badge nothing earned.
  assert.equal('hasError' in parsed, false);
});

test('a template with no trailing newline still counts its last line', () => {
  assert.equal(readTemplate('a.html', '<h1>x</h1>').lineCount, 1);
  assert.equal(readTemplate('a.html', '').lineCount, 0);
});

test('a template is read, not parsed, and asking for a grammar says so', () => {
  assert.throws(() => angular.grammar(), /read, not parsed/);
  assert.deepEqual(angular.extract(), { imports: [], symbols: [] });
  assert.equal(angular.resolve(), null);
});

/**
 * The whole rule over a project on disk, which is the half a unit test cannot
 * reach: an `.html` file is drawn because a component named it, and the host
 * page beside it is not.
 *
 * This is the re-runnable version of the measurement on angular/components —
 * 678 `.html` files, 659 named and 19 not — at a size a test can hold.
 */
const FIXTURE = fileURLToPath(new URL('../../src/lang/fixtures/angular', import.meta.url));

function filesUnder(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(path.join(directory, entry.name), relative));
    else found.push(relative);
  }
  return found.sort();
}

test('the fixture project draws the views and leaves the host page alone', () => {
  const files = filesUnder(FIXTURE);
  assert.ok(files.includes('index.html'), 'the fixture lost its host page, and this test now checks nothing');

  const parsed = files
    .filter((file) => file.endsWith('.ts'))
    .map((file) => parsedFile(file, templatesOf(readFileSync(path.join(FIXTURE, file), 'utf8'))));

  assert.deepEqual(namedTemplates(parsed), ['app/app.component.html', 'app/hero/hero.component.html']);

  // Every named template is on disk: the specifier arithmetic and the layout
  // agree, which is what the 662-of-662 measurement on angular/components says.
  for (const template of namedTemplates(parsed)) assert.ok(files.includes(template), `${template} is not there`);

  // And what is left over is exactly what nothing named: the host page, the
  // stylesheet the build makes a `.css` from, and the schematic's source.
  const drawn = new Set(namedTemplates(parsed));
  assert.deepEqual(
    files.filter((file) => !drawn.has(file) && !file.endsWith('.ts')),
    ['app/hero/hero.component.scss', 'index.html'],
  );
});

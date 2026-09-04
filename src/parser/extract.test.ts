import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countLines, parseSource } from './extract.js';

test('lines are counted the way wc -l counts them: a trailing newline terminates, it is not a line', () => {
  assert.equal(countLines(''), 0);
  assert.equal(countLines('a'), 1);
  assert.equal(countLines('a\n'), 1);
  assert.equal(countLines('a\nb'), 2);
  assert.equal(countLines('a\nb\n'), 2);
  assert.equal(countLines('a\r\nb\r\n'), 2);
  assert.equal(countLines('\n'), 1);
  assert.equal(countLines('\n\n'), 2);
});

test('the same file with and without its trailing newline has the same line count', () => {
  const body = 'export const a = 1;\nexport const b = 2;';
  assert.equal(parseSource('bg.ts', body).lineCount, 2);
  assert.equal(parseSource('bg.ts', `${body}\n`).lineCount, 2);
});

test('a file tree-sitter could not fully parse says so, instead of passing as empty', () => {
  assert.equal(parseSource('ok.ts', 'export const fine = 1;\n').hasError, false);
  const broken = parseSource('broken.ts', 'export const broken = {{{ ;\n');
  assert.equal(broken.hasError, true);
  // What the reviewer saw: nothing declared, and no word about why.
  assert.equal(broken.symbols.length, 0);
});

test('what a file bound by importing, and what it exports by default, survive parseSource', () => {
  // The store narrows a file's lookup to its bindings only when they arrive;
  // a language that records them and a parseSource that drops them is the old
  // whole-table rule wearing a new parser.
  const parsed = parseSource(
    'b.ts',
    "import * as ns from './index';\nimport d, { a as c } from './x';\nexport default function f() { ns.pub(); }\n",
  );
  assert.deepEqual(parsed.bindings, [
    { local: 'ns', specifier: './index', imported: '*' },
    { local: 'd', specifier: './x', imported: 'default' },
    { local: 'c', specifier: './x', imported: 'a' },
  ]);
  assert.equal(parsed.defaultExport, 'f');
  // Bound nothing is a fact about the file, not a parser that never said.
  assert.deepEqual(parseSource('lone.ts', 'export const x = 1;\n').bindings, []);
  // A file whose scope cannot be enumerated records none, and leaves the field
  // out rather than claiming an empty list: `use crate::imp::*` puts names in
  // scope that nothing in the source names, so the store keeps its older rule.
  assert.equal(parseSource('m.rs', 'use crate::imp::*;\npub fn f() {}\n').bindings, undefined);
  assert.deepEqual(parseSource('n.rs', 'pub fn f() {}\n').bindings, []);
});

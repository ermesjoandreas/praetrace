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

/**
 * The two seams a view-layer language rides on, and both are invisible when
 * they break: a scanned file that never reaches `scan` parses as nothing, and a
 * preprocessed one gets line numbers from a block instead of from the file.
 */
test('a language with no grammar is scanned, and a scanner has no syntax errors to report', () => {
  const view = parseSource('Views/Home/Index.cshtml', '@model Web.Models.Order\n<h1>Hi</h1>\n');
  assert.equal(view.language, 'razor');
  assert.deepEqual(view.imports, ['type:Web.Models.Order']);
  // A tree's word about a tree, and there is no tree. Never `true`, so a view
  // cannot wear the parse-error badge the status bar counts.
  assert.equal(view.hasError, false);
  // A view declares nothing the graph models. The box is empty, and honest.
  assert.deepEqual(view.symbols, []);
});

test('a symbol in a single-file component is at the line the file has it on, not the block', () => {
  const sfc = ['<template>', '  <p>{{ n }}</p>', '</template>', '', '<script>', 'export function load() {}', '</script>', ''].join('\n');
  const parsed = parseSource('App.vue', sfc);
  const load = parsed.symbols.find((symbol) => symbol.name === 'load');
  // `export function load()` is the sixth line of the file and the second of
  // the block. Without `preprocess` blanking the markup it would read as 2.
  assert.equal(load?.startLine, 6);
  assert.equal(parsed.lineCount, 7);
});

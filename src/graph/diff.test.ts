import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import { diffGraphs } from './diff.js';
import { applyBatch, createStore } from './store.js';
import type { Graph, GraphEdge, GraphNode } from './types.js';

/** A parsed file with nothing in it, for a fixture to fill in. */
function file(filePath: string, parts: Partial<ParsedFile> = {}): ParsedFile {
  return { filePath, language: 'typescript', imports: [], symbols: [], lineCount: 10, modifiedAt: 0, ...parts };
}

function symbol(name: string, kind: ParsedSymbol['kind'], parts: Partial<ParsedSymbol> = {}): ParsedSymbol {
  return { name, kind, startLine: 1, endLine: 1, extends: [], implements: [], calls: [], ...parts };
}

/** Through the store, so the ids — the `~2` suffix included — are the ones the live graph has. */
function graphOf(...files: ParsedFile[]): Graph {
  const store = createStore();
  applyBatch(store, files, []);
  return store.graph;
}

const ids = (nodes: readonly GraphNode[]): string[] => nodes.map((node) => node.id);
const lines = (edges: readonly GraphEdge[]): string[] => edges.map((edge) => `${edge.from} ${edge.kind} ${edge.to}`);

const store = file('store.ts', {
  symbols: [
    symbol('Store', 'class', { startLine: 1, endLine: 8 }),
    symbol('get', 'method', { owner: 'Store', startLine: 2, endLine: 4 }),
  ],
});
const app = file('app.ts', {
  imports: ['./store'],
  symbols: [symbol('main', 'function', { startLine: 3, endLine: 6, calls: ['Store'] })],
});

test('the same graph twice differs in nothing', () => {
  const graph = graphOf(store, app);
  const diff = diffGraphs(graph, graph);
  assert.deepEqual(diff, {
    added: [],
    removed: [],
    touched: [],
    addedEdges: [],
    removedEdges: [],
    counts: {
      files: { added: 0, removed: 0, touched: 0 },
      symbols: { added: 0, removed: 0 },
      edges: { added: 0, removed: 0 },
    },
  });
});

test('a symbol added is listed, its file is touched, and its contains edge is not an edge change', () => {
  const before = graphOf(store, app);
  const after = graphOf(
    file('store.ts', { symbols: [...store.symbols, symbol('reset', 'function', { startLine: 10, endLine: 12 })] }),
    app,
  );
  const diff = diffGraphs(before, after);

  assert.deepEqual(ids(diff.added), ['store.ts#reset']);
  assert.deepEqual(ids(diff.removed), []);
  assert.deepEqual(ids(diff.touched), ['store.ts']);
  assert.deepEqual(diff.addedEdges, []);
  assert.deepEqual(diff.counts.symbols, { added: 1, removed: 0 });
  assert.deepEqual(diff.counts.files, { added: 0, removed: 0, touched: 1 });
});

test('a symbol removed is listed as the before graph\'s node', () => {
  const before = graphOf(store, app);
  const after = graphOf(file('store.ts', { symbols: [store.symbols[0]!] }), app);
  const diff = diffGraphs(before, after);

  assert.deepEqual(ids(diff.removed), ['store.ts#Store.get']);
  // The node itself, not a name: the ghost is drawn from it.
  assert.equal(diff.removed[0], before.nodes.get('store.ts#Store.get'));
  assert.deepEqual(diff.removed[0]?.range, { startLine: 2, endLine: 4 });
  assert.deepEqual(ids(diff.touched), ['store.ts']);
});

test('a file deleted removes its every symbol and its import edges, and touches the file that imported it', () => {
  const before = graphOf(store, app);
  const after = graphOf(file('app.ts', { symbols: app.symbols }));
  const diff = diffGraphs(before, after);

  assert.deepEqual(ids(diff.removed), ['store.ts', 'store.ts#Store', 'store.ts#Store.get']);
  assert.deepEqual(lines(diff.removedEdges), ['app.ts imports store.ts', 'app.ts#main calls store.ts#Store']);
  // app.ts lost an edge it wrote; store.ts is gone, and gone is not touched.
  assert.deepEqual(ids(diff.touched), ['app.ts']);
  assert.deepEqual(diff.counts, {
    files: { added: 0, removed: 1, touched: 1 },
    symbols: { added: 0, removed: 2 },
    edges: { added: 0, removed: 2 },
  });
});

test('a method added to an existing class is one added node with an owner, and the file is touched, not added', () => {
  const before = graphOf(store, app);
  const after = graphOf(
    file('store.ts', { symbols: [...store.symbols, symbol('set', 'method', { owner: 'Store', startLine: 5, endLine: 7 })] }),
    app,
  );
  const diff = diffGraphs(before, after);

  assert.deepEqual(ids(diff.added), ['store.ts#Store.set']);
  assert.equal(diff.added[0]?.owner, 'Store');
  assert.deepEqual(ids(diff.touched), ['store.ts']);
  assert.deepEqual(diff.counts.files, { added: 0, removed: 0, touched: 1 });
});

test('an edge that moved to another target is one removed and one added', () => {
  const left = file('left.ts', { symbols: [symbol('go', 'function')] });
  const right = file('right.ts', { symbols: [symbol('go', 'function')] });
  const caller = (specifier: string): ParsedFile =>
    file('caller.ts', { imports: [specifier], symbols: [symbol('run', 'function', { calls: ['go'] })] });

  const diff = diffGraphs(graphOf(left, right, caller('./left')), graphOf(left, right, caller('./right')));

  assert.deepEqual(lines(diff.removedEdges), ['caller.ts imports left.ts', 'caller.ts#run calls left.ts#go']);
  assert.deepEqual(lines(diff.addedEdges), ['caller.ts imports right.ts', 'caller.ts#run calls right.ts#go']);
  assert.deepEqual(ids(diff.added), []);
  assert.deepEqual(ids(diff.removed), []);
  // The caller wrote the edges. Neither target did anything.
  assert.deepEqual(ids(diff.touched), ['caller.ts']);
});

test('a symbol that moved down a line touches its file and is neither added nor removed', () => {
  const before = graphOf(store, app);
  const after = graphOf(store, file('app.ts', { imports: ['./store'], symbols: [symbol('main', 'function', { startLine: 4, endLine: 7, calls: ['Store'] })] }));
  const diff = diffGraphs(before, after);

  assert.deepEqual(ids(diff.added), []);
  assert.deepEqual(ids(diff.removed), []);
  assert.deepEqual(ids(diff.touched), ['app.ts']);
});

test('a file that gained an importer is not touched; the importer is', () => {
  const before = graphOf(store, file('app.ts', { symbols: app.symbols }));
  const after = graphOf(store, app);
  const diff = diffGraphs(before, after);

  assert.deepEqual(lines(diff.addedEdges), ['app.ts imports store.ts', 'app.ts#main calls store.ts#Store']);
  assert.deepEqual(ids(diff.touched), ['app.ts']);
});

test('a file whose only change is a line count is touched', () => {
  const diff = diffGraphs(graphOf(store, app), graphOf(store, { ...app, lineCount: 11 }));
  assert.deepEqual(ids(diff.touched), ['app.ts']);
  assert.deepEqual(ids(diff.added), []);
});

test('the ~2 reading: removing the first of two overloads names the second as removed', () => {
  // Two `parse` declarations in one file are `parse` and `parse~2`, by document
  // order. Delete the first, and the survivor is now first — so it wears
  // `parse` and the diff says `parse~2` went. The count is right; the name is
  // the known hole, pinned here so a change to it is noticed.
  const twice = file('parse.ts', {
    symbols: [
      symbol('parse', 'function', { startLine: 1, endLine: 3 }),
      symbol('parse', 'function', { startLine: 5, endLine: 9 }),
    ],
  });
  const once = file('parse.ts', { symbols: [symbol('parse', 'function', { startLine: 5, endLine: 9 })] });

  const diff = diffGraphs(graphOf(twice), graphOf(once));
  assert.deepEqual(ids(diff.removed), ['parse.ts#parse~2']);
  assert.deepEqual(ids(diff.added), []);
  // `parse` survives under the id of the declaration that went, and reads as moved.
  assert.deepEqual(ids(diff.touched), ['parse.ts']);
  assert.deepEqual(graphOf(once).nodes.get('parse.ts#parse')?.range, { startLine: 5, endLine: 9 });
});

test('the ~2 reading: swapping two overloads moves every edge from one to the other', () => {
  const target = file('t.ts', { symbols: [symbol('a', 'function'), symbol('b', 'function')] });
  const ordered = (first: string, second: string): ParsedFile =>
    file('parse.ts', {
      imports: ['./t'],
      symbols: [
        symbol('parse', 'function', { startLine: 1, endLine: 3, calls: [first] }),
        symbol('parse', 'function', { startLine: 5, endLine: 9, calls: [second] }),
      ],
    });

  const diff = diffGraphs(graphOf(target, ordered('a', 'b')), graphOf(target, ordered('b', 'a')));
  // Nothing was declared or deleted, but the suffix moved and the edges with it.
  assert.deepEqual(ids(diff.added), []);
  assert.deepEqual(ids(diff.removed), []);
  assert.deepEqual(lines(diff.removedEdges), ['parse.ts#parse calls t.ts#a', 'parse.ts#parse~2 calls t.ts#b']);
  assert.deepEqual(lines(diff.addedEdges), ['parse.ts#parse calls t.ts#b', 'parse.ts#parse~2 calls t.ts#a']);
});

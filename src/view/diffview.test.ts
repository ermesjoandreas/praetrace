import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffGraphs } from '../graph/diff.js';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '../graph/types.js';
import { diffView } from './diffview.js';
import { NO_FILTER } from './filter.js';
import type { ViewSpec } from './types.js';

/** A node named after its id unless told otherwise; a member's name is bare. */
function node(id: string, kind: NodeKind, line = 1, owner?: string): GraphNode {
  const filePath = id.includes('#') ? id.slice(0, id.indexOf('#')) : id;
  const name = kind === 'file' ? id : id.slice(id.lastIndexOf(owner === undefined ? '#' : '.') + 1);
  return {
    id,
    kind,
    name,
    filePath,
    range: { startLine: line, endLine: line + 2 },
    ...(owner === undefined ? {} : { owner }),
  };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}

const spec: ViewSpec = {
  scope: 'src',
  focus: 'src/app.ts',
  depth: 1,
  filter: NO_FILTER,
  at: null,
  diagram: 'classes',
  category: 'g1',
  diff: 'base',
};

// Before: app imports store and util; Store has get and set; a test imports app.
// After: store lost `set` and gained `reset`; util is gone and app imports
// log instead; a new file `cli.ts` imports app; the test is unchanged.
const before = graphOf(
  [
    node('src/app.ts', 'file'),
    node('src/app.ts#main', 'function', 3),
    node('src/store.ts', 'file'),
    node('src/store.ts#Store', 'class', 1),
    node('src/store.ts#Store.get', 'method', 2, 'Store'),
    node('src/store.ts#Store.set', 'method', 5, 'Store'),
    node('src/util.ts', 'file'),
    node('src/util.ts#helper', 'function', 1),
    node('src/log.ts', 'file'),
    node('src/log.ts#log', 'function', 1),
    node('src/app.test.ts', 'file'),
  ],
  [
    { from: 'src/app.ts', to: 'src/store.ts', kind: 'imports' },
    { from: 'src/app.ts', to: 'src/util.ts', kind: 'imports' },
    { from: 'src/app.ts#main', to: 'src/util.ts#helper', kind: 'calls' },
    { from: 'src/app.ts#main', to: 'src/store.ts#Store.get', kind: 'calls' },
    { from: 'src/app.test.ts', to: 'src/app.ts', kind: 'imports' },
    { from: 'src/store.ts#Store', to: 'src/store.ts#Store.get', kind: 'contains' },
  ],
);
const after = graphOf(
  [
    node('src/app.ts', 'file'),
    node('src/app.ts#main', 'function', 3),
    node('src/store.ts', 'file'),
    node('src/store.ts#Store', 'class', 1),
    node('src/store.ts#Store.get', 'method', 2, 'Store'),
    node('src/store.ts#reset', 'function', 9),
    node('src/log.ts', 'file'),
    node('src/log.ts#log', 'function', 1),
    node('src/cli.ts', 'file'),
    node('src/cli.ts#run', 'function', 1),
    node('src/app.test.ts', 'file'),
  ],
  [
    { from: 'src/app.ts', to: 'src/store.ts', kind: 'imports' },
    { from: 'src/app.ts', to: 'src/log.ts', kind: 'imports' },
    { from: 'src/app.ts#main', to: 'src/log.ts#log', kind: 'calls' },
    { from: 'src/app.ts#main', to: 'src/store.ts#Store.get', kind: 'calls' },
    { from: 'src/cli.ts', to: 'src/app.ts', kind: 'imports' },
    { from: 'src/cli.ts#run', to: 'src/app.ts#main', kind: 'calls' },
    { from: 'src/app.test.ts', to: 'src/app.ts', kind: 'imports' },
    { from: 'src/store.ts#Store', to: 'src/store.ts#Store.get', kind: 'contains' },
  ],
);
const diff = diffGraphs(before, after);

test('every box the diff names carries what happened to it, and only those are drawn', () => {
  const view = diffView(diff, before, after, spec);
  assert.deepEqual(
    view.nodes.map((n) => [n.id, n.change ?? null, n.external]),
    [
      ['src/app.ts', 'touched', false],
      ['src/cli.ts', 'added', false],
      ['src/store.ts', 'touched', false],
      ['src/util.ts', 'removed', false],
      // The far end of `cli.ts imports app.ts` is app.ts, already drawn; the far
      // end of `app.ts imports log.ts` did nothing and is context.
      ['src/log.ts', null, true],
    ],
  );
  assert.equal(view.totalFiles, 4);
  assert.equal(view.presentation, 'diagram');
  // Scope, focus and category are not slices of a diff; the echo says so, and keeps the diff.
  assert.equal(view.spec.scope, '');
  assert.equal(view.spec.focus, null);
  assert.equal(view.spec.category, undefined);
  assert.equal(view.spec.diff, 'base');
  // Project-wide facts are the after graph's: five files, util.ts gone.
  assert.equal(view.fileCount, 5);
});

test('the ghost is built from the before graph, every row of it removed', () => {
  const view = diffView(diff, before, after, spec);
  const ghost = view.nodes.find((n) => n.id === 'src/util.ts');
  assert.equal(after.nodes.has('src/util.ts'), false);
  assert.deepEqual(
    ghost?.members.map((m) => [m.id, m.change]),
    [['src/util.ts#helper', 'removed']],
  );
});

test('inside a touched box the rows that came are marked, and the rows that went sit under their class', () => {
  const view = diffView(diff, before, after, spec);
  const store = view.nodes.find((n) => n.id === 'src/store.ts');
  assert.deepEqual(
    store?.members.map((m) => [m.name, m.owner, m.change ?? null]),
    [
      ['Store', null, null],
      ['get', 'Store', null],
      ['set', 'Store', 'removed'],
      ['reset', null, 'added'],
    ],
  );
  const added = view.nodes.find((n) => n.id === 'src/cli.ts');
  assert.deepEqual(added?.members.map((m) => m.change), ['added']);
  const context = view.nodes.find((n) => n.id === 'src/log.ts');
  assert.deepEqual(context?.members, []);
});

test('lines carry the change, and a line in both graphs is not drawn', () => {
  const view = diffView(diff, before, after, spec);
  assert.deepEqual(
    view.edges.map((e) => [e.from, e.kind, e.to, e.change, e.weight]),
    [
      ['src/app.ts', 'imports', 'src/log.ts', 'added', 1],
      ['src/cli.ts', 'imports', 'src/app.ts', 'added', 1],
      ['src/app.ts', 'imports', 'src/util.ts', 'removed', 1],
    ],
  );
});

test('under edges=calls a call replaces the import between the same pair, within its own change set', () => {
  const calls: ViewSpec = { ...spec, filter: { ...NO_FILTER, edgeKinds: ['imports', 'calls'] } };
  const view = diffView(diff, before, after, calls);
  assert.deepEqual(
    view.edges.map((e) => [e.from, e.kind, e.to, e.change]),
    [
      ['src/app.ts', 'calls', 'src/log.ts', 'added'],
      ['src/cli.ts', 'calls', 'src/app.ts', 'added'],
      ['src/app.ts', 'calls', 'src/util.ts', 'removed'],
    ],
  );
});

test('a removed class whose members went with it lists them under its row', () => {
  const gone = graphOf(
    [node('a.ts', 'file'), node('a.ts#keep', 'function', 1), node('a.ts#Gone', 'class', 5), node('a.ts#Gone.m', 'method', 6, 'Gone')],
    [],
  );
  const kept = graphOf([node('a.ts', 'file'), node('a.ts#keep', 'function', 1)], []);
  const view = diffView(diffGraphs(gone, kept), gone, kept, spec);
  assert.deepEqual(
    view.nodes[0]?.members.map((m) => [m.name, m.change ?? null]),
    [
      ['keep', null],
      ['Gone', 'removed'],
      ['m', 'removed'],
    ],
  );
});

test('hiding tests hides a changed test file and the line into it, and says how many', () => {
  // The test file gains an import of cli.ts, so it is touched and would be drawn.
  const withTest = graphOf(
    [...after.nodes.values()],
    [...after.edges, { from: 'src/app.test.ts', to: 'src/cli.ts', kind: 'imports' }],
  );
  const d = diffGraphs(before, withTest);
  const shown = diffView(d, before, withTest, spec);
  assert.ok(shown.nodes.some((n) => n.id === 'src/app.test.ts' && n.change === 'touched'));
  assert.equal(shown.hiddenTests, 0);

  const hidden = diffView(d, before, withTest, { ...spec, filter: { ...NO_FILTER, hideTests: true } });
  assert.equal(hidden.nodes.some((n) => n.id === 'src/app.test.ts'), false);
  assert.equal(hidden.edges.some((e) => e.from === 'src/app.test.ts'), false);
  assert.equal(hidden.hiddenTests, 1);
});

test('the git status rides the box, a ghost included, and coverage is not joined', () => {
  const git = {
    base: 'HEAD',
    requested: 'HEAD',
    branch: 'main',
    files: { 'src/util.ts': 'deleted' as const, 'src/cli.ts': 'added' as const },
    lines: {},
    totals: { added: 0, deleted: 0 },
  };
  const view = diffView(diff, before, after, spec, git);
  assert.equal(view.nodes.find((n) => n.id === 'src/util.ts')?.gitStatus, 'deleted');
  assert.equal(view.nodes.find((n) => n.id === 'src/cli.ts')?.gitStatus, 'added');
  assert.equal(view.nodes.find((n) => n.id === 'src/app.ts')?.gitStatus, null);
  assert.ok(view.nodes.every((n) => n.coverage === undefined));
  assert.deepEqual(view.git, { base: 'HEAD', requested: 'HEAD', branch: 'main', changed: 2 });
});

test('the same graph twice draws nothing', () => {
  const view = diffView(diffGraphs(after, after), after, after, spec);
  assert.deepEqual(view.nodes, []);
  assert.deepEqual(view.edges, []);
  assert.equal(view.totalFiles, 0);
});

test('the echoed spec carries the filter as applied: changes-only and since are lifted, and say so', () => {
  // With "Changes only" on, Structural diff drew boxes git lists as unchanged
  // while the chip and the View menu said the filter was on, because the
  // echo repeated the filter asked for rather than the one used.
  const empty = graphOf([], []);
  const asked: ViewSpec = { ...spec, filter: { ...NO_FILTER, onlyChanged: true, sinceMs: 600_000 } };
  const view = diffView(diffGraphs(empty, empty), empty, empty, asked);
  assert.equal(view.spec.filter.onlyChanged, false);
  assert.equal(view.spec.filter.sinceMs, 0);
});


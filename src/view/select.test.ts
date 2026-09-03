import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode } from '../graph/types.js';
import type { Coverage } from '../report/types.js';
import { NO_FILTER } from './filter.js';
import { selectView } from './select.js';
import type { ViewSpec } from './types.js';

/** Files that import each other, some of them broken, in the order given. */
function graphOf(files: readonly string[], imports: readonly [string, string][], broken: readonly string[] = []): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const file of files) {
    nodes.set(file, {
      id: file,
      kind: 'file',
      name: file,
      filePath: file,
      range: { startLine: 1, endLine: 1 },
      ...(broken.includes(file) ? { parseError: true as const } : {}),
    });
  }
  return { nodes, edges: imports.map(([from, to]) => ({ from, to, kind: 'imports' as const })) };
}

const root: ViewSpec = { scope: '', focus: null, depth: 1, filter: NO_FILTER, at: null };

const files = [
  'src/app.ts',
  'src/app.test.ts',
  'src/lib/util.ts',
  'src/lib/util.test.ts',
  'test/e2e.ts',
];
const imports: [string, string][] = [
  ['src/app.ts', 'src/lib/util.ts'],
  ['src/app.test.ts', 'src/app.ts'],
  ['src/lib/util.test.ts', 'src/lib/util.ts'],
  ['test/e2e.ts', 'src/app.ts'],
];

/**
 * Enough files that the root view draws directories: src/ holds source and
 * tests both, one source file broken; test/ holds nothing but tests.
 */
const many = [
  'src/app.ts',
  ...Array.from({ length: 20 }, (_, index) => `src/lib/m${index}.ts`),
  ...Array.from({ length: 20 }, (_, index) => `src/lib/m${index}.test.ts`),
  ...Array.from({ length: 5 }, (_, index) => `test/e2e-${index}.ts`),
];

test('every box says whether it is a test, and a folder only when all of it is', () => {
  const view = selectView(graphOf(files, imports), root, 0);
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.test]),
    [
      ['src/app.test.ts', true],
      ['src/app.ts', false],
      ['src/lib/util.test.ts', true],
      ['src/lib/util.ts', false],
      ['test/e2e.ts', true],
    ],
  );
  const folders = selectView(graphOf(many, []), root, 0);
  assert.equal(folders.grouped, true);
  assert.deepEqual(
    folders.nodes.map((node) => [node.id, node.test]),
    [
      ['src', false],
      ['test', true],
    ],
  );
});

test('hiding tests removes them and their edges, and says how many project-wide', () => {
  const spec: ViewSpec = { ...root, scope: 'src', filter: { ...NO_FILTER, hideTests: true } };
  const view = selectView(graphOf(files, imports), spec, 0);

  assert.deepEqual(
    view.nodes.map((node) => node.id),
    ['src/app.ts', 'src/lib/util.ts'],
  );
  assert.deepEqual(view.edges, [{ from: 'src/app.ts', to: 'src/lib/util.ts', kind: 'imports', weight: 1 }]);
  assert.equal(view.hiddenTests, 3);
  assert.equal(view.totalFiles, 2);
  // The whole project, not the slice: five files whatever the scope.
  assert.equal(view.fileCount, 5);
});

test('hiddenTests counts only what hideTests took away, and is 0 when it is off', () => {
  assert.equal(selectView(graphOf(files, imports), root, 0).hiddenTests, 0);
  // With a path filter already dropping test/, only the two under src/ count.
  const spec: ViewSpec = { ...root, filter: { ...NO_FILTER, hideTests: true, onlyPath: 'src/*' } };
  assert.equal(selectView(graphOf(files, imports), spec, 0).hiddenTests, 2);
});

test('a parse error is carried onto the file box, and onto any folder holding one', () => {
  const folders = selectView(graphOf(many, [], ['src/lib/m3.ts']), root, 0);
  assert.deepEqual(
    folders.nodes.map((node) => [node.id, node.parseError]),
    [
      ['src', true],
      ['test', false],
    ],
  );
  const graph = graphOf(files, imports, ['src/lib/util.ts']);
  const focused = selectView(graph, { ...root, focus: 'src/lib/util.ts' }, 0);
  assert.deepEqual(
    focused.nodes.map((node) => [node.id, node.parseError]),
    [
      ['src/app.ts', false],
      ['src/lib/util.test.ts', false],
      ['src/lib/util.ts', true],
    ],
  );
});

test('parseErrors counts the whole project\'s broken files, whatever the scope', () => {
  const graph = graphOf(files, imports, ['src/lib/util.ts', 'test/e2e.ts']);
  assert.equal(selectView(graph, root, 0).parseErrors, 2);
  assert.equal(selectView(graph, { ...root, scope: 'src/lib' }, 0).parseErrors, 2);
  assert.equal(selectView(graph, { ...root, focus: 'src/app.ts' }, 0).parseErrors, 2);
  assert.equal(selectView(graphOf(files, imports), root, 0).parseErrors, 0);
});

test('a member nests under the owner its node names, and a dotted top-level name under none', () => {
  const filePath = 'lib/application.js';
  const range = { startLine: 1, endLine: 1 };
  const nodes = new Map<string, GraphNode>([
    [filePath, { id: filePath, kind: 'file', name: 'application.js', filePath, range }],
    // express: `app.init = function init() {}` is a function whose name has a dot.
    [`${filePath}#app.init`, { id: `${filePath}#app.init`, kind: 'function', name: 'app.init', filePath, range }],
    [`${filePath}#App.init`, { id: `${filePath}#App.init`, kind: 'method', name: 'init', filePath, range, owner: 'App' }],
  ]);
  const view = selectView({ nodes, edges: [] }, root, 0);

  assert.deepEqual(
    view.nodes.flatMap((node) => node.members.map((member) => [member.id, member.owner])),
    [
      [`${filePath}#app.init`, null],
      [`${filePath}#App.init`, 'App'],
    ],
  );
});

/** Two files with symbols in them, so a member row has something to carry. */
function withSymbols(): Graph {
  const range = { startLine: 1, endLine: 1 };
  const nodes = new Map<string, GraphNode>();
  const declare = (filePath: string, names: readonly string[]): void => {
    nodes.set(filePath, { id: filePath, kind: 'file', name: filePath, filePath, range });
    for (const name of names) {
      const id = `${filePath}#${name}`;
      nodes.set(id, { id, kind: 'function', name, filePath, range });
    }
  };
  declare('src/app.ts', ['run', 'assertNever', 'Options']);
  declare('src/lib/util.ts', ['helper']);
  return { nodes, edges: [] };
}

/**
 * What a report says, and — as loudly — what it does not. src/lib/util.ts has
 * no entry because the run never imported it, and `Options` has none because a
 * type has no runtime function to count.
 */
const measured: Coverage = {
  at: 0,
  source: 'coverage/lcov.info',
  files: { 'src/app.ts': { lines: 10, covered: 7 } },
  symbols: {
    'src/app.ts#run': 'covered',
    'src/app.ts#assertNever': 'never',
    'src/app.ts#Options': 'unknown',
    'src/lib/util.ts#helper': 'unknown',
  },
};

test('a file box carries the lines the report measured, and a file with no entry carries none', () => {
  const view = selectView(withSymbols(), root, 0, null, measured);
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.coverage]),
    [
      ['src/app.ts', { lines: 10, covered: 7 }],
      // Absent, and emphatically not { lines: 0, covered: 0 }: the run never
      // imported this file, which says nothing about what it would have run.
      ['src/lib/util.ts', undefined],
    ],
  );
  // Focus mode builds its boxes somewhere else, and must reach the same answer.
  const focused = selectView(withSymbols(), { ...root, focus: 'src/app.ts' }, 0, null, measured);
  assert.deepEqual(focused.nodes[0]?.coverage, { lines: 10, covered: 7 });
});

test("a member row says 'covered' or 'never', and carries nothing for unknown", () => {
  const view = selectView(withSymbols(), root, 0, null, measured);
  assert.deepEqual(
    view.nodes.flatMap((node) => node.members.map((member) => [member.id, member.coverage])),
    [
      ['src/app.ts#run', 'covered'],
      ['src/app.ts#assertNever', 'never'],
      ['src/app.ts#Options', undefined],
      ['src/lib/util.ts#helper', undefined],
    ],
  );
});

test('with no report nothing is measured, which is not the same as nothing running', () => {
  const view = selectView(withSymbols(), root, 0);
  assert.deepEqual(view.nodes.map((node) => node.coverage), [undefined, undefined]);
  assert.deepEqual(
    view.nodes.flatMap((node) => node.members.map((member) => member.coverage)),
    [undefined, undefined, undefined, undefined],
  );
});

test('a folder box carries no coverage, however much of it was measured', () => {
  // `many` puts src/app.ts inside a folder box, and the report has a number
  // for it. Summing it over 41 files would claim the other 40 were measured.
  const folders = selectView(graphOf(many, []), root, 0, null, measured);
  assert.equal(folders.grouped, true);
  assert.deepEqual(
    folders.nodes.map((node) => [node.id, node.coverage]),
    [
      ['src', undefined],
      ['test', undefined],
    ],
  );
});

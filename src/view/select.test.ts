import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode } from '../graph/types.js';
import type { Coverage } from '../report/types.js';
import { NO_FILTER, type ViewFilter } from './filter.js';
import { categoryOf, ownershipOf, selectView } from './select.js';
import type { ComponentSource } from './components.js';
import { LIST_ABOVE, type ViewSpec } from './types.js';

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

const root: ViewSpec = { scope: '', focus: null, depth: 1, filter: NO_FILTER, at: null, diagram: 'classes' };

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

/**
 * One file at the centre of a star: `dependents` files import it, and it
 * imports `dependencies` files. The two counts are what decides which side of
 * a focus view has too many neighbours to draw.
 */
function star(dependents: number, dependencies: number): Graph {
  const inbound = Array.from({ length: dependents }, (_, index) => `src/in${index}.ts`);
  const outbound = Array.from({ length: dependencies }, (_, index) => `src/out${index}.ts`);
  return graphOf(
    ['src/hub.ts', ...inbound, ...outbound],
    [
      ...inbound.map((file): [string, string] => [file, 'src/hub.ts']),
      ...outbound.map((file): [string, string] => ['src/hub.ts', file]),
    ],
  );
}

const onHub: ViewSpec = { ...root, focus: 'src/hub.ts' };

test('neighbours past the threshold become one box; below it they are the answer', () => {
  const drawn = selectView(star(10, 3), onHub, 0);
  assert.equal(drawn.nodes.length, 14);
  assert.equal(drawn.nodes.every((node) => node.kind === 'file'), true);

  // One more importer, and the importers stop being worth a box each. The
  // three files the hub leans on are still under the threshold, so they stay.
  const view = selectView(star(11, 3), onHub, 0);
  assert.deepEqual(
    view.nodes.map((node) => [node.kind, node.label]),
    [
      ['file', 'src/hub.ts'],
      ['file', 'src/out0.ts'],
      ['file', 'src/out1.ts'],
      ['file', 'src/out2.ts'],
      ['bundle', '11 dependents'],
    ],
  );
  // The files did not go away, only the boxes: "5 boxes · 15 files".
  assert.equal(view.totalFiles, 15);
  // Bundling is not grouping — no box here stands for a directory.
  assert.equal(view.grouped, false);
});

test('a bundle stands for its files, and the edges to it are one line with a weight', () => {
  const view = selectView(star(11, 3), onHub, 0);
  const bundle = view.nodes.find((node) => node.kind === 'bundle');

  assert.equal(bundle?.id, 'bundle:dependents:1');
  assert.equal(bundle?.files.length, 11);
  assert.equal(bundle?.files[0], 'src/in0.ts');
  assert.deepEqual(bundle?.members, []);
  assert.deepEqual(
    view.edges.filter((edge) => edge.from === 'bundle:dependents:1'),
    [{ from: 'bundle:dependents:1', to: 'src/hub.ts', kind: 'imports', weight: 11 }],
  );
});

test('a bundle is a leaf: the walk does not go on from files it stands for', () => {
  // Each importer imports something of its own. At depth 2 those would be the
  // next hop — but the importers were never drawn, so their neighbours have
  // nothing to hang off.
  const inbound = Array.from({ length: 11 }, (_, index) => `src/in${index}.ts`);
  const beyond = inbound.map((file) => `${file.replace('.ts', '')}-own.ts`);
  const graph = graphOf(
    ['src/hub.ts', ...inbound, ...beyond],
    [
      ...inbound.map((file): [string, string] => [file, 'src/hub.ts']),
      ...inbound.map((file, index): [string, string] => [file, beyond[index] ?? '']),
    ],
  );

  const view = selectView(graph, { ...onHub, depth: 2 }, 0);
  assert.deepEqual(
    view.nodes.map((node) => node.id),
    ['src/hub.ts', 'bundle:dependents:1'],
  );
  assert.equal(view.totalFiles, 12);
});

test('a neighbour reachable both ways is a dependency, and is bundled once', () => {
  // The hub imports eleven files, and one of them imports it back. The claim
  // the hub makes about it is the one that decides where it lands.
  const outbound = Array.from({ length: 11 }, (_, index) => `src/out${index}.ts`);
  const graph = graphOf(
    ['src/hub.ts', ...outbound],
    [
      ...outbound.map((file): [string, string] => ['src/hub.ts', file]),
      ['src/out0.ts', 'src/hub.ts'],
    ],
  );

  const view = selectView(graph, onHub, 0);
  assert.deepEqual(
    view.nodes.map((node) => [node.kind, node.label]),
    [
      ['file', 'src/hub.ts'],
      ['bundle', '11 dependencies'],
    ],
  );
  assert.equal(view.nodes[1]?.files.includes('src/out0.ts'), true);
  // Both directions are still drawn; only the boxes at one end merged.
  assert.deepEqual(view.edges, [
    { from: 'src/hub.ts', to: 'bundle:dependencies:1', kind: 'imports', weight: 11 },
    { from: 'bundle:dependencies:1', to: 'src/hub.ts', kind: 'imports', weight: 1 },
  ]);
});

/** The same graph, with the counts the store kept for what did not resolve. */
function withUnresolved(
  graph: Graph,
  counts: Record<string, { imports: number; calls: number }>,
): Graph {
  const nodes = new Map<string, GraphNode>(graph.nodes);
  for (const [filePath, unresolved] of Object.entries(counts)) {
    const node = nodes.get(filePath);
    if (node) nodes.set(filePath, { ...node, unresolved });
  }
  return { nodes, edges: graph.edges };
}

test('a box says how many references landed nowhere, and carries nothing when none did', () => {
  const graph = withUnresolved(graphOf(['src/a.ts', 'src/b.ts', 'src/c.ts'], []), {
    'src/a.ts': { imports: 7, calls: 0 },
    'src/b.ts': { imports: 0, calls: 3 },
  });

  assert.deepEqual(
    selectView(graph, root, 0).nodes.map((node) => [node.id, node.unresolved]),
    [
      ['src/a.ts', { imports: 7, calls: 0 }],
      ['src/b.ts', { imports: 0, calls: 3 }],
      // Not { imports: 0, calls: 0 }: a box with nothing to report says nothing.
      ['src/c.ts', undefined],
    ],
  );
  // Focus mode builds its file boxes somewhere else, and must agree.
  assert.deepEqual(
    selectView(graph, { ...root, focus: 'src/a.ts' }, 0).nodes[0]?.unresolved,
    { imports: 7, calls: 0 },
  );
});

test('a folder and a bundle sum what their files could not resolve', () => {
  const folders = selectView(
    withUnresolved(graphOf(many, []), {
      'src/app.ts': { imports: 0, calls: 4 },
      'src/lib/m3.ts': { imports: 2, calls: 1 },
    }),
    root,
    0,
  );
  assert.deepEqual(
    folders.nodes.map((node) => [node.id, node.unresolved]),
    [
      ['src', { imports: 2, calls: 5 }],
      ['test', undefined],
    ],
  );

  // The eleven importers are one box, and what none of them could resolve is
  // the one number that box can honestly report.
  const bundled = selectView(
    withUnresolved(star(11, 0), {
      'src/in0.ts': { imports: 1, calls: 0 },
      'src/in7.ts': { imports: 4, calls: 2 },
    }),
    onHub,
    0,
  );
  assert.deepEqual(
    bundled.nodes.map((node) => [node.id, node.unresolved]),
    [
      ['src/hub.ts', undefined],
      ['bundle:dependents:1', { imports: 5, calls: 2 }],
    ],
  );
});

const CALLS: ViewFilter = { ...NO_FILTER, edgeKinds: ['imports', 'calls'] };

/** `src/a.ts` calls two things in `src/b.ts`; each test says which were guesses. */
function guessedCalls(first: boolean, second: boolean): Graph {
  const range = { startLine: 1, endLine: 1 };
  const nodes = new Map<string, GraphNode>();
  for (const [filePath, names] of [
    ['src/a.ts', ['run']],
    ['src/b.ts', ['one', 'two']],
  ] as const) {
    nodes.set(filePath, { id: filePath, kind: 'file', name: filePath, filePath, range });
    for (const name of names) {
      const id = `${filePath}#${name}`;
      nodes.set(id, { id, kind: 'function', name, filePath, range });
    }
  }
  return {
    nodes,
    edges: [
      { from: 'src/a.ts#run', to: 'src/b.ts#one', kind: 'calls', ...(first ? { guessed: true as const } : {}) },
      { from: 'src/a.ts#run', to: 'src/b.ts#two', kind: 'calls', ...(second ? { guessed: true as const } : {}) },
    ],
  };
}

test('a line is guessed only while every reference behind it was', () => {
  const line = (first: boolean, second: boolean) =>
    selectView(guessedCalls(first, second), { ...root, filter: CALLS }, 0).edges;

  assert.deepEqual(line(true, true), [
    { from: 'src/a.ts', to: 'src/b.ts', kind: 'calls', weight: 2, guessed: true },
  ]);
  // One reference that resolved makes the coupling itself certain, whichever
  // of the two it was — the flag is dropped, not kept and not counted.
  assert.deepEqual(line(true, false), [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'calls', weight: 2 }]);
  assert.deepEqual(line(false, true), [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'calls', weight: 2 }]);
  assert.deepEqual(line(false, false), [{ from: 'src/a.ts', to: 'src/b.ts', kind: 'calls', weight: 2 }]);
});

test('folding two file edges into one folder edge follows the same rule', () => {
  // Enough files that the boxes are directories, and two edges from src/a to
  // src/b — one found, one guessed. The folder edge stands for both.
  const files = [
    ...Array.from({ length: 41 }, (_, index) => `src/a/f${index}.ts`),
    'src/b/g0.ts',
    'src/b/g1.ts',
  ];
  const graph = graphOf(files, []);
  const edged = (guessed: boolean): Graph => ({
    nodes: graph.nodes,
    edges: [
      { from: 'src/a/f0.ts', to: 'src/b/g0.ts', kind: 'imports' },
      { from: 'src/a/f1.ts', to: 'src/b/g1.ts', kind: 'imports', ...(guessed ? { guessed: true as const } : {}) },
    ],
  });

  assert.deepEqual(selectView(edged(true), root, 0).edges, [
    { from: 'src/a', to: 'src/b', kind: 'imports', weight: 2 },
  ]);
  assert.deepEqual(selectView({ nodes: graph.nodes, edges: edged(true).edges.slice(1) }, root, 0).edges, [
    { from: 'src/a', to: 'src/b', kind: 'imports', weight: 1, guessed: true },
  ]);
});

/**
 * Three files in a chain. `Alpha` reaches across to `Beta`, `Only` reaches one
 * hop further to `Gamma`, and `Spare` is reached from inside its own file.
 */
function reaching(): Graph {
  const range = { startLine: 1, endLine: 1 };
  const nodes = new Map<string, GraphNode>();
  for (const [filePath, names] of [
    ['src/a.ts', ['Alpha', 'Spare']],
    ['src/b.ts', ['Beta', 'Only']],
    ['src/c.ts', ['Gamma']],
  ] as const) {
    nodes.set(filePath, { id: filePath, kind: 'file', name: filePath, filePath, range });
    for (const name of names) {
      const id = `${filePath}#${name}`;
      nodes.set(id, { id, kind: 'function', name, filePath, range });
    }
  }
  return {
    nodes,
    edges: [
      { from: 'src/a.ts', to: 'src/b.ts', kind: 'imports' },
      { from: 'src/b.ts', to: 'src/c.ts', kind: 'imports' },
      { from: 'src/a.ts#Alpha', to: 'src/b.ts#Beta', kind: 'calls' },
      { from: 'src/b.ts#Only', to: 'src/c.ts#Gamma', kind: 'calls' },
      // Inside one file, so it writes no arrow between two boxes.
      { from: 'src/a.ts#Alpha', to: 'src/a.ts#Spare', kind: 'calls' },
    ],
  };
}

/** Every member the view drew, and whether an arrow runs through it. */
function marks(graph: Graph, spec: ViewSpec): [string, true | undefined][] {
  return selectView(graph, spec, 0).nodes.flatMap((node) =>
    node.members.map((member): [string, true | undefined] => [member.id, member.linked]),
  );
}

test('an imports edge marks no row: no one symbol writes it', () => {
  assert.deepEqual(marks(reaching(), root), [
    ['src/a.ts#Alpha', undefined],
    ['src/a.ts#Spare', undefined],
    ['src/b.ts#Beta', undefined],
    ['src/b.ts#Only', undefined],
    ['src/c.ts#Gamma', undefined],
  ]);
});

test('a row is marked by an arrow on this slice, not by any relation anywhere', () => {
  // Depth 1 draws a and b. Alpha and Beta explain the arrow between them;
  // `Only` reaches c, which is not on screen; `Spare` is reached from inside
  // its own file, which is no arrow at all.
  assert.deepEqual(marks(reaching(), { ...root, focus: 'src/a.ts', filter: CALLS }), [
    ['src/a.ts#Alpha', true],
    ['src/a.ts#Spare', undefined],
    ['src/b.ts#Beta', true],
    ['src/b.ts#Only', undefined],
  ]);

  // One hop further and c is drawn, so the row that reaches it is the answer.
  assert.deepEqual(marks(reaching(), { ...root, focus: 'src/a.ts', depth: 2, filter: CALLS }), [
    ['src/a.ts#Alpha', true],
    ['src/a.ts#Spare', undefined],
    ['src/b.ts#Beta', true],
    ['src/b.ts#Only', true],
    ['src/c.ts#Gamma', true],
  ]);
});

test('a row that is another name for a body beside it says so, and the body does not', () => {
  // express lib/response.js: `res.contentType = res.type = function contentType`.
  // Both rows are drawn — a reader looking for res.type must find it — but the
  // box would otherwise show two functions at one range with nothing to tell
  // them apart, and anything counting the rows would count the body twice.
  const filePath = 'lib/response.js';
  const range = { startLine: 510, endLine: 517 };
  const nodes = new Map<string, GraphNode>([
    [filePath, { id: filePath, kind: 'file', name: 'response.js', filePath, range: { startLine: 1, endLine: 1 } }],
    [
      `${filePath}#res.contentType`,
      { id: `${filePath}#res.contentType`, kind: 'function', name: 'res.contentType', filePath, range },
    ],
    [
      `${filePath}#res.type`,
      {
        id: `${filePath}#res.type`,
        kind: 'function',
        name: 'res.type',
        filePath,
        range,
        aliasOf: 'res.contentType',
      },
    ],
  ]);
  const view = selectView({ nodes, edges: [] }, root, 0);

  assert.deepEqual(
    view.nodes.flatMap((node) => node.members.map((member) => [member.name, member.aliasOf])),
    [
      ['res.contentType', undefined],
      ['res.type', 'res.contentType'],
    ],
  );
});

// --- what an association line carries -----------------------------------------

const ASSOCIATES: ViewFilter = { ...NO_FILTER, edgeKinds: ['imports', 'associates'] };
const DEPENDS: ViewFilter = { ...NO_FILTER, edgeKinds: ['imports', 'depends'] };

/**
 * Two classes in `src/tree.ts` both hold a `Node` from `src/node.ts`, and one
 * of them also names it in a signature. The store writes one association per
 * class pair with the fields behind it, and an import beside them.
 */
function holding(): Graph {
  const range = { startLine: 1, endLine: 1 };
  const nodes = new Map<string, GraphNode>();
  for (const [filePath, names] of [
    ['src/tree.ts', ['Tree', 'Forest', 'Walker']],
    ['src/node.ts', ['Node']],
  ] as const) {
    nodes.set(filePath, { id: filePath, kind: 'file', name: filePath, filePath, range });
    for (const name of names) {
      const id = `${filePath}#${name}`;
      nodes.set(id, { id, kind: 'class', name, filePath, range });
    }
  }
  return {
    nodes,
    edges: [
      { from: 'src/tree.ts', to: 'src/node.ts', kind: 'imports' },
      {
        from: 'src/tree.ts#Tree',
        to: 'src/node.ts#Node',
        kind: 'associates',
        roles: [{ name: 'root', ownership: 'composition' }, { name: 'cursor', optional: true }],
      },
      { from: 'src/tree.ts#Forest', to: 'src/node.ts#Node', kind: 'associates', roles: [{ name: 'trees', many: true }] },
      { from: 'src/tree.ts#Walker', to: 'src/node.ts#Node', kind: 'depends' },
    ],
  };
}

test('an association line carries every role behind it, in graph order, and replaces the import', () => {
  const view = selectView(holding(), { ...root, filter: ASSOCIATES }, 0);
  assert.deepEqual(view.edges, [
    {
      from: 'src/tree.ts',
      to: 'src/node.ts',
      kind: 'associates',
      weight: 2,
      // Both class pairs' roles, Tree's before Forest's: a line that stands
      // for several fields keeps all of them rather than the first.
      roles: [{ name: 'root', ownership: 'composition' }, { name: 'cursor', optional: true }, { name: 'trees', many: true }],
      // The one field that states an ownership decides the diamond; the two
      // that say nothing do not vote.
      ownership: 'composition',
    },
  ]);
  // The roles are the graph's own objects copied, not shared: a view is
  // serialised and handed around, and must not be able to edit the graph.
  const role = view.edges[0]?.roles?.[0];
  assert.notEqual(role, holding().edges[1]?.roles?.[0]);
});

test('a line of any other kind carries no roles, and the default filter draws neither', () => {
  const plain = selectView(holding(), root, 0);
  assert.deepEqual(plain.edges, [{ from: 'src/tree.ts', to: 'src/node.ts', kind: 'imports', weight: 1 }]);
  assert.equal('roles' in (plain.edges[0] ?? {}), false);
});

test('a dependency is opt-in like a call, and is drawn beside the import, never instead of it', () => {
  // The review's case: Tree holds a Node and Walker only names one. With only
  // the dependency asked for, the line that stood in for the import read
  // "merely depends on" between two files one of which holds the other.
  const view = selectView(holding(), { ...root, filter: DEPENDS }, 0);
  assert.deepEqual(sortedEdges(view.edges), [
    { from: 'src/tree.ts', to: 'src/node.ts', kind: 'depends', weight: 1 },
    { from: 'src/tree.ts', to: 'src/node.ts', kind: 'imports', weight: 1 },
  ]);
});

const sortedEdges = <T extends { kind: string }>(edges: readonly T[]): T[] =>
  [...edges].sort((a, b) => a.kind.localeCompare(b.kind));

test('a folder line concatenates the roles of every file line it stands for', () => {
  const range = { startLine: 1, endLine: 1 };
  const files = [
    ...Array.from({ length: 41 }, (_, index) => `src/a/f${index}.ts`),
    'src/b/g0.ts',
    'src/b/g1.ts',
  ];
  const graph = graphOf(files, []);
  const nodes = new Map(graph.nodes);
  for (const [filePath, name] of [
    ['src/a/f0.ts', 'A0'],
    ['src/a/f1.ts', 'A1'],
    ['src/b/g0.ts', 'B0'],
    ['src/b/g1.ts', 'B1'],
  ] as const) {
    const id = `${filePath}#${name}`;
    nodes.set(id, { id, kind: 'class', name, filePath, range });
  }
  const view = selectView(
    {
      nodes,
      edges: [
        { from: 'src/a/f0.ts#A0', to: 'src/b/g0.ts#B0', kind: 'associates', roles: [{ name: 'first' }] },
        { from: 'src/a/f1.ts#A1', to: 'src/b/g1.ts#B1', kind: 'associates', roles: [{ name: 'second', ownership: 'aggregation' }] },
      ],
    },
    { ...root, filter: ASSOCIATES },
    0,
  );
  assert.deepEqual(view.edges, [
    {
      from: 'src/a',
      to: 'src/b',
      kind: 'associates',
      weight: 2,
      roles: [{ name: 'first' }, { name: 'second', ownership: 'aggregation' }],
      ownership: 'aggregation',
    },
  ]);
});

test('a line wears a diamond only when every field that states an ownership states the same one', () => {
  const range = { startLine: 1, endLine: 1 };
  const nodes = new Map<string, GraphNode>();
  for (const [filePath, names] of [
    ['src/tree.ts', ['Tree', 'Forest']],
    ['src/node.ts', ['Node']],
    ['src/leaf.ts', ['Leaf']],
  ] as const) {
    nodes.set(filePath, { id: filePath, kind: 'file', name: filePath, filePath, range });
    for (const name of names) {
      const id = `${filePath}#${name}`;
      nodes.set(id, { id, kind: 'class', name, filePath, range });
    }
  }
  const view = selectView(
    {
      nodes,
      edges: [
        // Two classes, one builds its Node and the other says nothing: the
        // unknown does not vote, and the line is a composition.
        { from: 'src/tree.ts#Tree', to: 'src/node.ts#Node', kind: 'associates', roles: [{ name: 'root', ownership: 'composition' }] },
        { from: 'src/tree.ts#Forest', to: 'src/node.ts#Node', kind: 'associates', roles: [{ name: 'any' }] },
        // One built and one handed in: the source said two things, so no diamond.
        { from: 'src/tree.ts#Tree', to: 'src/leaf.ts#Leaf', kind: 'associates', roles: [{ name: 'built', ownership: 'composition' }] },
        { from: 'src/tree.ts#Forest', to: 'src/leaf.ts#Leaf', kind: 'associates', roles: [{ name: 'given', ownership: 'aggregation' }] },
      ],
    },
    { ...root, filter: ASSOCIATES },
    0,
  );
  assert.deepEqual(
    view.edges.map((edge) => [edge.to, edge.ownership]),
    [
      ['src/node.ts', 'composition'],
      ['src/leaf.ts', undefined],
    ],
  );
  assert.equal('ownership' in (view.edges[1] ?? {}), false);
  assert.deepEqual(ownershipOf([{ name: 'a', ownership: 'aggregation' }, { name: 'b' }]), 'aggregation');
  assert.deepEqual(ownershipOf([{ name: 'b' }]), undefined);
  assert.deepEqual(ownershipOf(undefined), undefined);
});

// --- list or diagram ------------------------------------------------------------

/** A flat directory of `n` source files: one box each, none of them grouped. */
const flat = (n: number): Graph =>
  graphOf(Array.from({ length: n }, (_, index) => `src/f${index}.ts`), []);

test('a scope past LIST_ABOVE is a list, one at it is a diagram, and as= says either way', () => {
  assert.equal(LIST_ABOVE, 30);

  const under = selectView(flat(LIST_ABOVE), root, 0);
  assert.equal(under.nodes.length, 30);
  assert.equal(under.presentation, 'diagram');

  const over = selectView(flat(LIST_ABOVE + 1), root, 0);
  assert.equal(over.nodes.length, 31);
  assert.equal(over.presentation, 'list');

  // The URL wins over the count, in both directions, and is echoed.
  const asDiagram = selectView(flat(LIST_ABOVE + 1), { ...root, as: 'diagram' }, 0);
  assert.equal(asDiagram.presentation, 'diagram');
  assert.equal(asDiagram.spec.as, 'diagram');
  const asList = selectView(graphOf(files, imports), { ...root, as: 'list' }, 0);
  assert.equal(asList.presentation, 'list');
  assert.equal(asList.spec.as, 'list');
  // Not asked is not echoed: the key is absent, never null.
  assert.equal('as' in over.spec, false);
});

test('a focus is a diagram whatever the count, and so is a diff; only as= overrides them', () => {
  // A hub with ten neighbours each way, each of which has one neighbour of its
  // own: 41 boxes at depth 2, and every one of them the answer.
  const inbound = Array.from({ length: 10 }, (_, index) => `src/in${index}.ts`);
  const outbound = Array.from({ length: 10 }, (_, index) => `src/out${index}.ts`);
  const beyondIn = inbound.map((file) => file.replace('.ts', '-own.ts'));
  const beyondOut = outbound.map((file) => file.replace('.ts', '-own.ts'));
  const graph = graphOf(
    ['src/hub.ts', ...inbound, ...outbound, ...beyondIn, ...beyondOut],
    [
      ...inbound.map((file): [string, string] => [file, 'src/hub.ts']),
      ...outbound.map((file): [string, string] => ['src/hub.ts', file]),
      ...inbound.map((file, index): [string, string] => [beyondIn[index] ?? '', file]),
      ...outbound.map((file, index): [string, string] => [file, beyondOut[index] ?? '']),
    ],
  );

  const focused = selectView(graph, { ...onHub, depth: 2 }, 0);
  assert.equal(focused.nodes.length, 41);
  assert.equal(focused.presentation, 'diagram');
  assert.equal(selectView(graph, { ...onHub, depth: 2, as: 'list' }, 0).presentation, 'list');

  // A focus on a file the graph has not got falls back to the scope, and the
  // rule sees the scope: 41 boxes in a flat directory is a list.
  const fallen = selectView(graph, { ...root, focus: 'src/gone.ts' }, 0);
  assert.equal(fallen.spec.focus, null);
  assert.equal(fallen.presentation, 'list');

  // A diff needs two graphs. Handed one, this draws the ordinary slice and
  // the echo says so by carrying no `diff` — never a claim it did not apply —
  // and the count decides the presentation as it would for any scope.
  const diffed = selectView(flat(LIST_ABOVE + 1), { ...root, diff: 'base' }, 0);
  assert.equal('diff' in diffed.spec, false);
  assert.equal(diffed.presentation, 'list');
});

test('handed the before graph, a diff draws what differs and nothing else, and is a diagram at any count', () => {
  // Before: a flat directory of 40 files, f0 importing f1. After: f0 now
  // imports f2 instead, f39 is gone, and f40 is new. Four boxes differ; the
  // other 36 did nothing and are not drawn.
  const beforeFiles = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`);
  const afterFiles = [...beforeFiles.filter((file) => file !== 'src/f39.ts'), 'src/f40.ts'];
  const before = graphOf(beforeFiles, [['src/f0.ts', 'src/f1.ts']]);
  const after = graphOf(afterFiles, [['src/f0.ts', 'src/f2.ts']]);

  const view = selectView(after, { ...root, scope: 'src', diff: 'base' }, 0, null, null, [], before);
  assert.equal(view.spec.diff, 'base');
  // Not a slice of a scope: the echo drops it, and the trail is the root.
  assert.equal(view.spec.scope, '');
  assert.deepEqual(view.trail, [{ label: 'root', scope: '' }]);
  assert.equal(view.presentation, 'diagram');

  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.change ?? null, node.external]),
    [
      ['src/f0.ts', 'touched', false],
      ['src/f39.ts', 'removed', false],
      ['src/f40.ts', 'added', false],
      // The far ends of the two lines that changed: context, and marked as such.
      ['src/f1.ts', null, true],
      ['src/f2.ts', null, true],
    ],
  );
  assert.deepEqual(
    view.edges.map((edge) => [edge.from, edge.to, edge.change]),
    [
      ['src/f0.ts', 'src/f2.ts', 'added'],
      ['src/f0.ts', 'src/f1.ts', 'removed'],
    ],
  );
  // Project-wide facts are the after graph's, the way every view's are.
  assert.equal(view.fileCount, 40);
  // A diff of a graph against itself draws nothing, and says so honestly.
  const same = selectView(after, { ...root, diff: 'base' }, 0, null, null, [], after);
  assert.equal(same.nodes.length, 0);
  assert.equal(same.spec.diff, 'base');
});

// --- a scope by category ---------------------------------------------------------

/**
 * Three files in `lib/` that a stored category names, one of them a test,
 * reached from two places under `app/` and leaning on one under `util/`.
 */
const pipeline = [
  'lib/a.ts',
  'lib/b.ts',
  'lib/a.test.ts',
  'app/page.tsx',
  'app/api/route.ts',
  'util/x.ts',
];
const pipelineImports: [string, string][] = [
  ['app/page.tsx', 'lib/a.ts'],
  ['app/api/route.ts', 'lib/b.ts'],
  ['lib/a.ts', 'lib/b.ts'],
  ['lib/a.ts', 'util/x.ts'],
  ['lib/a.test.ts', 'lib/a.ts'],
];

const source = (
  storedId: string | undefined,
  state: ComponentSource['state'],
  name: string | null,
  files: readonly string[],
): ComponentSource => ({
  id: `${files[0] ?? ''}~${files.length}`,
  files,
  cohesion: 0.5,
  name,
  state,
  parent: null,
  ...(storedId === undefined ? {} : { storedId }),
});

const dataPipeline = source('lib/a.ts~3', 'accepted', 'Data Pipeline', ['lib/a.ts', 'lib/b.ts', 'lib/a.test.ts']);
const rejected = source('util/x.ts~1', 'rejected', 'Scraps', ['util/x.ts']);
const unnamed = source(undefined, 'suggested', null, ['app/page.tsx', 'app/api/route.ts']);
const stored = [dataPipeline, rejected, unnamed];

const byCategory: ViewSpec = { ...root, scope: 'app', category: 'lib/a.ts~3' };

test('a category is a scope: its members are the boxes, and the outside collapses to directories', () => {
  const view = selectView(graphOf(pipeline, pipelineImports), byCategory, 0, null, null, stored);

  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.kind, node.label, node.external]),
    [
      // Whole paths: there is no prefix the members share to leave out.
      ['lib/a.test.ts', 'file', 'lib/a.test.ts', false],
      ['lib/a.ts', 'file', 'lib/a.ts', false],
      ['lib/b.ts', 'file', 'lib/b.ts', false],
      ['app', 'folder', 'app', true],
      ['app/api', 'folder', 'app/api', true],
      ['util', 'folder', 'util', true],
    ],
  );
  // The lines a list row's numbers are read off: the two inside, and three
  // to boxes standing for what is outside.
  const lines = [...view.edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  assert.deepEqual(lines.map((edge) => [edge.from, edge.to, edge.weight]), [
    ['app', 'lib/a.ts', 1],
    ['app/api', 'lib/b.ts', 1],
    ['lib/a.test.ts', 'lib/a.ts', 1],
    ['lib/a.ts', 'lib/b.ts', 1],
    ['lib/a.ts', 'util', 1],
  ]);
  assert.equal(view.totalFiles, 3);
  assert.equal(view.grouped, false);
  assert.equal(view.presentation, 'diagram');
  // The category wins over the scope, and the echo says which was drawn.
  assert.equal(view.spec.scope, '');
  assert.equal(view.spec.category, 'lib/a.ts~3');
  assert.deepEqual(view.trail, [
    { label: 'root', scope: '' },
    { label: 'Data Pipeline', scope: '', category: 'lib/a.ts~3' },
  ]);
});

test('a category honours the filter, and never stands its members in folders', () => {
  const hidden = selectView(
    graphOf(pipeline, pipelineImports),
    { ...byCategory, filter: { ...NO_FILTER, hideTests: true } },
    0,
    null,
    null,
    stored,
  );
  assert.deepEqual(
    hidden.nodes.filter((node) => !node.external).map((node) => node.id),
    ['lib/a.ts', 'lib/b.ts'],
  );
  assert.equal(hidden.totalFiles, 2);

  // Past the directory-grouping threshold a directory scope draws folders; a
  // category of the same files draws every member, because a directory
  // inside a category stands for nothing.
  const members = Array.from({ length: 45 }, (_, index) => `lib/d${index % 5}/f${index}.ts`);
  const big = source('lib/d0/f0.ts~45', 'accepted', 'Big', members);
  const view = selectView(graphOf(members, []), { ...root, category: big.storedId ?? '' }, 0, null, null, [big]);
  assert.equal(view.nodes.length, 45);
  assert.equal(view.nodes.every((node) => node.kind === 'file'), true);
  assert.equal(view.grouped, false);
  assert.equal(view.presentation, 'list');
  assert.equal(selectView(graphOf(members, []), { ...root, scope: 'lib' }, 0).grouped, true);
});

test('a category that matches nothing falls back to the scope, and the echo carries none', () => {
  const graph = graphOf(pipeline, pipelineImports);
  for (const category of ['nobody', rejected.storedId ?? '', unnamed.id]) {
    const view = selectView(graph, { ...root, category }, 0, null, null, stored);
    assert.equal(view.nodes.length, 6, category);
    assert.equal('category' in view.spec, false, category);
    assert.deepEqual(view.trail, [{ label: 'root', scope: '' }]);
  }
  // Handed no categories at all, the same fallback.
  assert.equal('category' in selectView(graph, byCategory, 0).spec, false);

  assert.equal(categoryOf(stored, 'lib/a.ts~3'), dataPipeline);
  assert.equal(categoryOf(stored, 'util/x.ts~1'), null);
  assert.equal(categoryOf(stored, unnamed.id), null);
});

test('a focus wins over a category, and a component diagram ignores it', () => {
  const graph = graphOf(pipeline, pipelineImports);
  const focused = selectView(graph, { ...byCategory, focus: 'lib/b.ts' }, 0, null, null, stored);
  assert.equal(focused.spec.focus, 'lib/b.ts');
  assert.equal(focused.nodes.some((node) => node.focused), true);
  // Kept, not dropped: the URL said both, and leaving the focus goes back to it.
  assert.equal(focused.spec.category, 'lib/a.ts~3');

  const components = selectView(graph, { ...byCategory, diagram: 'components' }, 0, null, null, stored);
  assert.equal('category' in components.spec, false);
  assert.equal(components.nodes.every((node) => node.kind === 'component'), true);
});

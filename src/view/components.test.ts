import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphEdge, GraphNode } from '../graph/types.js';
import { partitionByCategory, UNCATEGORISED_ID, type ComponentSource } from './components.js';
import { NO_FILTER, type ViewFilter } from './filter.js';
import { selectView } from './select.js';
import type { ViewSpec } from './types.js';

/**
 * Pinned through `selectView`, which is where a component diagram is drawn:
 * this module decides who belongs where and what each box provides, and
 * `select.ts` turns that into boxes and lines with the arithmetic every
 * diagram shares. What the page gets is the composition, and the composition
 * is what a test has to hold — every function was right while five invented
 * edges lived in zod.
 */

const range = { startLine: 1, endLine: 1 };

/** A graph of files and the symbols they declare, with whatever edges the test wants. */
function graphOf(
  declared: Record<string, readonly (string | { name: string; kind: GraphNode['kind']; owner?: string })[]>,
  edges: GraphEdge[],
): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const [filePath, symbols] of Object.entries(declared)) {
    nodes.set(filePath, { id: filePath, kind: 'file', name: filePath, filePath, range });
    for (const symbol of symbols) {
      const { name, kind, owner } = typeof symbol === 'string' ? { name: symbol, kind: 'function' as const, owner: undefined } : symbol;
      const id = owner === undefined ? `${filePath}#${name}` : `${filePath}#${owner}.${name}`;
      nodes.set(id, { id, kind, name, filePath, range, ...(owner === undefined ? {} : { owner }) });
    }
  }
  return { nodes, edges };
}

const imports = (from: string, to: string): GraphEdge => ({ from, to, kind: 'imports' });
const calls = (from: string, to: string, guessed = false): GraphEdge => ({
  from,
  to,
  kind: 'calls',
  ...(guessed ? { guessed: true as const } : {}),
});

/**
 * Two categories with a file between them. `src/a/*` is named and stored;
 * `src/b/*` is one the graph found and nobody has named; `src/loose.ts` is in
 * neither. Alpha is reached from both outside boxes, Store.get from one, and
 * Hidden only from inside its own category.
 */
const graph = graphOf(
  {
    'src/a/one.ts': [{ name: 'Alpha', kind: 'class' }, 'Hidden'],
    'src/a/two.ts': [{ name: 'get', kind: 'method', owner: 'Store' }],
    'src/a/three.ts': [],
    'src/b/one.ts': ['Beta'],
    'src/b/two.ts': [],
    'src/loose.ts': [],
  },
  [
    imports('src/a/one.ts', 'src/b/one.ts'),
    imports('src/a/two.ts', 'src/b/one.ts'),
    imports('src/a/one.ts', 'src/b/two.ts'),
    imports('src/b/two.ts', 'src/a/one.ts'),
    imports('src/loose.ts', 'src/a/one.ts'),
    // Inside one category: a coupling with nothing to draw it between.
    imports('src/a/one.ts', 'src/a/two.ts'),
    calls('src/b/one.ts#Beta', 'src/a/one.ts#Alpha'),
    calls('src/b/two.ts', 'src/a/one.ts#Alpha'),
    calls('src/loose.ts', 'src/a/two.ts#Store.get'),
    calls('src/a/one.ts#Alpha', 'src/b/one.ts#Beta'),
    calls('src/a/two.ts#Store.get', 'src/a/one.ts#Hidden'),
  ],
);

const named: ComponentSource = {
  id: 'src/a/one.ts~3',
  files: ['src/a/one.ts', 'src/a/three.ts', 'src/a/two.ts'],
  cohesion: 0.5,
  name: 'Alpha side',
  state: 'accepted',
  parent: null,
  storedId: 'src/a/one.ts~3',
};
const unnamed: ComponentSource = {
  id: 'src/b/one.ts~2',
  files: ['src/b/one.ts', 'src/b/two.ts'],
  cohesion: 0.25,
  name: null,
  state: 'suggested',
  parent: null,
};
const categories = [named, unnamed];

const components: ViewSpec = {
  scope: '',
  focus: null,
  depth: 1,
  filter: NO_FILTER,
  at: null,
  diagram: 'components',
};

const draw = (spec: ViewSpec = components, sources: readonly ComponentSource[] = categories) =>
  selectView(graph, spec, 0, null, null, sources);

/** The lines in a fixed order: the engine's is the graph's edge order, which is not a promise. */
const sorted = <T extends { from: string; to: string; kind: string }>(edges: readonly T[]): T[] =>
  [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));

test('two categories are two boxes, and the files in neither are one more', () => {
  const view = draw();
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.kind, node.label, node.files]),
    [
      ['component:src/a/one.ts~3', 'component', 'Alpha side', ['src/a/one.ts', 'src/a/three.ts', 'src/a/two.ts']],
      ['component:src/b/one.ts~2', 'component', '2 files together', ['src/b/one.ts', 'src/b/two.ts']],
      [UNCATEGORISED_ID, 'component', '1 file in no category', ['src/loose.ts']],
    ],
  );
  // Six files on screen, and no box stands for a directory.
  assert.equal(view.totalFiles, 6);
  assert.equal(view.grouped, false);
  assert.deepEqual(view.nodes.map((node) => node.members), [[], [], []]);
});

test('a box carries the name, the stored id and the cohesion, and the box for no category none of them', () => {
  const view = draw();
  const [alpha, beta, none] = view.nodes.map((node) => node.component);
  assert.deepEqual(alpha && { ...alpha, provides: undefined }, {
    name: 'Alpha side',
    storedId: 'src/a/one.ts~3',
    cohesion: 0.5,
    provides: undefined,
  });
  assert.deepEqual(beta && { ...beta, provides: undefined }, { name: null, cohesion: 0.25, provides: undefined });
  assert.deepEqual(none && { ...none, provides: undefined }, { name: null, uncategorised: true, provides: undefined });
});

test('the lines are the file pairs crossing, one per direction, and none inside a box', () => {
  assert.deepEqual(sorted(draw().edges), [
    // The file in no category still couples to something, and the line says so.
    { from: UNCATEGORISED_ID, to: 'component:src/a/one.ts~3', kind: 'imports', weight: 1 },
    // a/one→b/one, a/two→b/one, a/one→b/two: three pairs, one line.
    { from: 'component:src/a/one.ts~3', to: 'component:src/b/one.ts~2', kind: 'imports', weight: 3 },
    { from: 'component:src/b/one.ts~2', to: 'component:src/a/one.ts~3', kind: 'imports', weight: 1 },
  ]);
});

test('a component provides what files outside it reach, most reached first, and not what only it reaches', () => {
  const view = draw();
  const [alpha, beta, none] = view.nodes.map((node) => node.component?.provides);

  assert.deepEqual(alpha, {
    symbols: [
      // Two distinct files outside — b/one's Beta and b/two's top-level call.
      { id: 'src/a/one.ts#Alpha', name: 'Alpha', kind: 'class', owner: null, reachedFrom: 2 },
      { id: 'src/a/two.ts#Store.get', name: 'get', kind: 'method', owner: 'Store', reachedFrom: 1 },
      // Hidden is reached only from src/a/two.ts, inside the same box: not listed.
    ],
    total: 2,
  });
  assert.deepEqual(beta, {
    symbols: [{ id: 'src/b/one.ts#Beta', name: 'Beta', kind: 'function', owner: null, reachedFrom: 1 }],
    total: 1,
  });
  // Nothing reaches into src/loose.ts, and the box says so rather than nothing.
  assert.deepEqual(none, { symbols: [], total: 0 });
});

test('provides reads the reaching edges whatever the view is drawing', () => {
  // Under the default edge kinds the lines are imports only; the interface is
  // still there, or every box would be empty under the default diagram.
  const defaults = draw();
  assert.equal(defaults.spec.filter.edgeKinds.includes('calls'), false);
  assert.equal(defaults.nodes[0]?.component?.provides.total, 2);
});

test('a call asked for replaces the import between the same two files, and the rest still import', () => {
  const withCalls: ViewFilter = { ...NO_FILTER, edgeKinds: ['imports', 'calls'] };
  assert.deepEqual(sorted(draw({ ...components, filter: withCalls }).edges), [
    // loose→a/one imports and loose→a/two calls: two file pairs, two lines.
    { from: UNCATEGORISED_ID, to: 'component:src/a/one.ts~3', kind: 'calls', weight: 1 },
    { from: UNCATEGORISED_ID, to: 'component:src/a/one.ts~3', kind: 'imports', weight: 1 },
    // a/one→b/one is now a call; a/two→b/one and a/one→b/two are still imports.
    { from: 'component:src/a/one.ts~3', to: 'component:src/b/one.ts~2', kind: 'calls', weight: 1 },
    { from: 'component:src/a/one.ts~3', to: 'component:src/b/one.ts~2', kind: 'imports', weight: 2 },
    // b/one→a/one and b/two→a/one both call; the one import between them is replaced.
    { from: 'component:src/b/one.ts~2', to: 'component:src/a/one.ts~3', kind: 'calls', weight: 2 },
  ]);
});

test('a category with categories inside it is not a box, a rejected one is nothing, and a drawn one has no cohesion', () => {
  // The two found groups nested inside one outer group that is their union,
  // the way `clusterFiles` nests them: the leaves are the boxes, and the outer
  // — named or not — is not, or the two would claim the same files.
  const outer: ComponentSource = {
    id: 'src/a/one.ts~5',
    files: [...named.files, ...unnamed.files].sort(),
    cohesion: 0.9,
    name: 'Everything',
    state: 'accepted',
    parent: null,
    storedId: 'src/a/one.ts~5',
  };
  const inner = [named, unnamed].map((leaf) => ({ ...leaf, parent: outer.id }));
  assert.deepEqual(
    draw(components, [outer, ...inner]).nodes.map((node) => [node.id, node.files.length]),
    [['component:src/a/one.ts~3', 3], ['component:src/b/one.ts~2', 2], [UNCATEGORISED_ID, 1]],
  );

  const rejected: ComponentSource = { ...unnamed, state: 'rejected' };
  assert.deepEqual(
    draw(components, [named, rejected]).nodes.map((node) => [node.id, node.files.length]),
    [['component:src/a/one.ts~3', 3], [UNCATEGORISED_ID, 3]],
  );

  const drawn: ComponentSource = {
    id: 'manual:mine',
    storedId: 'manual:mine',
    files: ['src/b/one.ts', 'src/loose.ts'],
    cohesion: 0,
    name: 'Mine',
    state: 'accepted',
    parent: null,
    origin: 'manual',
  };

  const view = draw(components, [named, drawn]);
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.label, node.files]),
    [
      ['component:src/a/one.ts~3', 'Alpha side', ['src/a/one.ts', 'src/a/three.ts', 'src/a/two.ts']],
      ['component:manual:mine', 'Mine', ['src/b/one.ts', 'src/loose.ts']],
      [UNCATEGORISED_ID, '1 file in no category', ['src/b/two.ts']],
    ],
  );
  const mine = view.nodes[1]?.component;
  assert.equal(mine?.origin, 'manual');
  // Not 0: the imports were never asked, so there is no number to print.
  assert.equal(mine?.cohesion, undefined);
});

test('a file two categories hold goes to the one listed first', () => {
  const overlapping: ComponentSource = { ...unnamed, files: ['src/a/one.ts', 'src/b/one.ts', 'src/b/two.ts'] };
  const files = new Set([...graph.nodes.values()].filter((node) => node.kind === 'file').map((node) => node.filePath));
  const { boxOf, boxes } = partitionByCategory(graph, [named, overlapping], files, NO_FILTER);

  assert.equal(boxOf.get('src/a/one.ts'), 'component:src/a/one.ts~3');
  // The later box stands for what was left, and its label counts that.
  assert.deepEqual(
    boxes.map((box) => [box.label, box.files]),
    [
      ['Alpha side', ['src/a/one.ts', 'src/a/three.ts', 'src/a/two.ts']],
      ['2 files together', ['src/b/one.ts', 'src/b/two.ts']],
      ['1 file in no category', ['src/loose.ts']],
    ],
  );
});

test('the filter narrows a component to what is on screen, and a box left with nothing is no box', () => {
  const tested = graphOf(
    { 'src/a/one.ts': ['Alpha'], 'src/a/two.ts': [], 'src/a/one.test.ts': [] },
    [imports('src/a/one.test.ts', 'src/a/one.ts'), calls('src/a/one.test.ts', 'src/a/one.ts#Alpha')],
  );
  const only: ComponentSource = { ...named, files: ['src/a/one.ts', 'src/a/two.ts'] };

  const shown = selectView(tested, components, 0, null, null, [only]);
  assert.deepEqual(shown.nodes.map((node) => [node.id, node.files.length]), [['component:src/a/one.ts~3', 2], [UNCATEGORISED_ID, 1]]);
  assert.equal(shown.nodes[0]?.component?.provides.total, 1);

  // Tests are in no category by rule; hiding them empties that box, and a
  // reach from a hidden file is not on the interface while the file is off screen.
  const hidden = selectView(tested, { ...components, filter: { ...NO_FILTER, hideTests: true } }, 0, null, null, [only]);
  assert.deepEqual(hidden.nodes.map((node) => node.id), ['component:src/a/one.ts~3']);
  assert.deepEqual(hidden.edges, []);
  assert.equal(hidden.nodes[0]?.component?.provides.total, 0);
  assert.equal(hidden.hiddenTests, 1);
});

test('the spec is echoed with scope and focus cleared: a category is a fact about the whole project', () => {
  const view = draw({ ...components, scope: 'src/a', focus: 'src/a/one.ts' });
  assert.deepEqual(view.spec, { ...components, scope: '', focus: null });
  assert.deepEqual(view.trail, [{ label: 'root', scope: '' }]);
  assert.equal(view.nodes.length, 3);
});

test('a reach marks the symbol guessed only while every reach was, and a line the same', () => {
  const guessy = graphOf(
    { 'src/a/one.ts': ['Alpha'], 'src/b/one.ts': [], 'src/b/two.ts': [] },
    [
      calls('src/b/one.ts', 'src/a/one.ts#Alpha', true),
      calls('src/b/two.ts', 'src/a/one.ts#Alpha', true),
    ],
  );
  const withCalls: ViewSpec = { ...components, filter: { ...NO_FILTER, edgeKinds: ['calls'] } };
  const a: ComponentSource = { ...named, files: ['src/a/one.ts'] };
  const b: ComponentSource = { ...unnamed, files: ['src/b/one.ts', 'src/b/two.ts'] };

  const allGuessed = selectView(guessy, withCalls, 0, null, null, [a, b]);
  assert.equal(allGuessed.nodes[0]?.component?.provides.symbols[0]?.guessed, true);
  assert.deepEqual(allGuessed.edges, [
    { from: 'component:src/b/one.ts~2', to: 'component:src/a/one.ts~3', kind: 'calls', weight: 2, guessed: true },
  ]);

  // One found reach makes the fact certain: the mark is dropped, not counted.
  const oneFound: Graph = { nodes: guessy.nodes, edges: [guessy.edges[0] ?? calls('', ''), calls('src/b/two.ts', 'src/a/one.ts#Alpha')] };
  const mixed = selectView(oneFound, withCalls, 0, null, null, [a, b]);
  assert.equal(mixed.nodes[0]?.component?.provides.symbols[0]?.guessed, undefined);
  assert.deepEqual(mixed.edges, [
    { from: 'component:src/b/one.ts~2', to: 'component:src/a/one.ts~3', kind: 'calls', weight: 2 },
  ]);
});

test('the interface is cut at a box\'s worth of rows and says how many there were', () => {
  const names = Array.from({ length: 15 }, (_, index) => `s${String(index).padStart(2, '0')}`);
  const wide = graphOf(
    { 'src/a/one.ts': names, 'src/b/one.ts': [] },
    names.map((name) => calls('src/b/one.ts', `src/a/one.ts#${name}`)),
  );
  const a: ComponentSource = { ...named, files: ['src/a/one.ts'] };
  const b: ComponentSource = { ...unnamed, files: ['src/b/one.ts'] };

  const provides = selectView(wide, components, 0, null, null, [a, b]).nodes[0]?.component?.provides;
  assert.equal(provides?.symbols.length, 12);
  assert.equal(provides?.total, 15);
  // Equal reach, so the cut is by name — and the same twelve every time.
  assert.deepEqual(provides?.symbols.map((symbol) => symbol.name), names.slice(0, 12));
});

test('with no categories at all, the whole project is one box that says so', () => {
  const view = draw(components, []);
  assert.deepEqual(view.nodes.map((node) => [node.id, node.label]), [[UNCATEGORISED_ID, '6 files in no category']]);
  assert.deepEqual(view.edges, []);
});

test('a rejected leaf under an accepted outer category stays in the outer, not in no category', () => {
  const files = ['a1.ts', 'a2.ts', 'a3.ts', 'b1.ts', 'b2.ts', 'b3.ts'];
  const plain = graphOf(Object.fromEntries(files.map((file) => [file, []])), []);
  const engine: ComponentSource = {
    id: 'a1.ts~6', files, cohesion: 0.7, name: 'Engine', state: 'accepted', parent: null, storedId: 'a1.ts~6',
  };
  const a: ComponentSource = { id: 'a1.ts~3', files: files.slice(0, 3), cohesion: 0.9, name: null, state: 'suggested', parent: 'a1.ts~6' };
  const b: ComponentSource = { id: 'b1.ts~3', files: files.slice(3), cohesion: 0.9, name: null, state: 'rejected', parent: 'a1.ts~6' };
  const view = selectView(plain, components, 0, null, null, [engine, a, b]);
  // The person rejected B as a piece of its own — not out of Engine, which the
  // Categories panel still lists as holding b1–b3.
  assert.deepEqual(
    view.nodes.map((node) => [node.id, node.files.length]).sort(),
    [['component:a1.ts~3', 3], ['component:a1.ts~6', 3]],
  );
  assert.ok(!view.nodes.some((node) => node.id === UNCATEGORISED_ID));
});

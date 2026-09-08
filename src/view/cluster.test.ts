import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode } from '../graph/types.js';
import { clusterFiles, evidenceFor, fileLinks } from './cluster.js';

/** A graph of files and the imports between them, in the order given. */
function graphOf(files: readonly string[], imports: readonly [string, string][]): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const file of files) {
    nodes.set(file, { id: file, kind: 'file', name: file, filePath: file, range: { startLine: 1, endLine: 1 } });
  }
  return { nodes, edges: imports.map(([from, to]) => ({ from, to, kind: 'imports' as const })) };
}

const triangle = (prefix: string): [string, string][] => [
  [`${prefix}1.ts`, `${prefix}2.ts`],
  [`${prefix}2.ts`, `${prefix}3.ts`],
  [`${prefix}3.ts`, `${prefix}1.ts`],
];
const members = (prefix: string): string[] => [`${prefix}1.ts`, `${prefix}2.ts`, `${prefix}3.ts`];

test('cohesion counts each edge once: a triangle with one edge out is 75%, not 86%', () => {
  // Two triangles joined by one edge. A lone file hanging off a group is
  // absorbed by it, so the edge out has to lead somewhere that holds its own.
  const graph = graphOf(
    [...members('a'), ...members('b')],
    [...triangle('a'), ...triangle('b'), ['a3.ts', 'b3.ts']],
  );
  const [outer] = clusterFiles(graph);
  const [a, b] = outer?.children ?? [];
  assert.deepEqual(a?.files, members('a'));
  assert.equal(a?.cohesion, 0.75);
  assert.equal(b?.cohesion, 0.75);
  // Seven edges, all inside once the two are one group.
  assert.equal(outer?.cohesion, 1);
});

test('the same graph gives the same groups and percentages, whatever order it arrived in', () => {
  const files = [...members('a'), ...members('b'), ...members('c'), 'd.ts', 'e.ts'];
  const imports: [string, string][] = [
    ...triangle('a'),
    ...triangle('b'),
    ...triangle('c'),
    ['a3.ts', 'b3.ts'],
    ['d.ts', 'a1.ts'],
    ['e.ts', 'c2.ts'],
  ];
  const once = clusterFiles(graphOf(files, imports));
  const twice = clusterFiles(graphOf(files, imports));
  const backwards = clusterFiles(graphOf([...files].reverse(), [...imports].reverse()));

  assert.ok(once.length >= 2, 'the fixture has groups to compare');
  assert.deepEqual(twice, once);
  assert.deepEqual(backwards, once);
});

test('tests do not decide grouping: a suite that imports everything joins nothing and pulls nothing apart', () => {
  const source = members('src/a');
  const suite = ['src/__tests__/a1.test.ts', 'src/__tests__/a2.test.ts', 'test/all.ts'];
  const imports: [string, string][] = [
    ...triangle('src/a'),
    // Every test imports every source file: far heavier than the source's own ties.
    ...suite.flatMap((file): [string, string][] => source.map((target) => [file, target])),
  ];
  const groups = clusterFiles(graphOf([...source, ...suite], imports));

  assert.deepEqual(
    groups.map((group) => group.files),
    [source],
  );
  // The edges into the tests are gone with them, so nothing leaves the group.
  assert.equal(groups[0]?.cohesion, 1);
});

test('two groups that lean on each other nest under one outer group, and a stranger stays flat', () => {
  const graph = graphOf(
    [...members('a'), ...members('b'), ...members('c')],
    [...triangle('a'), ...triangle('b'), ...triangle('c'), ['a3.ts', 'b3.ts']],
  );
  const groups = clusterFiles(graph);

  assert.deepEqual(
    groups.map((group) => group.files),
    [[...members('a'), ...members('b')], members('c')],
  );
  const [outer, lone] = groups;
  assert.deepEqual(
    outer?.children.map((child) => child.files),
    [members('a'), members('b')],
  );
  assert.equal(outer?.id, 'a1.ts~6');
  assert.deepEqual(lone?.children, []);
});

/** Every pair joined: the shape that certainly settles on one label. */
const clique = (prefix: string, size: number): [string, string][] => {
  const pairs: [string, string][] = [];
  for (let i = 1; i <= size; i += 1) {
    for (let j = i + 1; j <= size; j += 1) pairs.push([`${prefix}${i}.ts`, `${prefix}${j}.ts`]);
  }
  return pairs;
};
/** Sorted, because that is the order a cluster reports its members in. */
const clan = (prefix: string, size: number): string[] =>
  Array.from({ length: size }, (_, i) => `${prefix}${i + 1}.ts`).sort();

test('a group that is really just its largest child is not offered beside it', () => {
  // serilog's shape at a size a reader can hold: one big group, one small one,
  // a single edge between them. The aggregation joins the two, and the outer
  // group it makes is 20 files of which 16 are the first child — so the panel
  // asked for a name for the architecture, and then again for the same
  // architecture minus four files.
  const graph = graphOf(
    [...clan('a', 16), ...clan('b', 4)],
    // The bridge hangs off the last member of each: from the first, the tie
    // between "join my own group" and "join theirs" is broken on the lowest
    // path and the small group is swallowed before the aggregation ever runs.
    [...clique('a', 16), ...clique('b', 4), ['a16.ts', 'b4.ts']],
  );
  const groups = clusterFiles(graph);

  assert.deepEqual(
    groups.map((group) => group.files),
    [clan('a', 16), clan('b', 4)],
  );
  assert.deepEqual(
    groups.map((group) => group.children.length),
    [0, 0],
  );
});

test('a dependency edge does not vote on who belongs together', () => {
  // Two triangles, and one file in each naming the other's type in five
  // signatures. The day dependency edges arrived they counted like imports,
  // and every stored name on every typed project moved.
  const plain = graphOf([...members('a'), ...members('b')], [...triangle('a'), ...triangle('b')]);
  const depends = Array.from({ length: 5 }, () => ({ from: 'a1.ts', to: 'b1.ts', kind: 'depends' as const }));
  const groups = clusterFiles({ nodes: plain.nodes, edges: [...plain.edges, ...depends] });
  assert.deepEqual(
    groups.map((group) => [...group.files].sort()).sort(),
    [members('a'), members('b')],
  );
});

test('a pair of files that touch is not a category: three pairs among eleven files find nothing', () => {
  // webapp-h26's shape: two ASP.NET apps and a React front end, eleven files,
  // three imports, each between a file and one other — a controller and its
  // model twice, and main.jsx → App.jsx. MIN_SIZE is what keeps a pair from
  // being offered as 100% architecture; the page's answer to a project this
  // small is to say how a category is drawn by hand, not to find one.
  const alone = ['BackendAPI/Program.cs', 'ProsjektMVC/Program.cs', 'FrontendReact/vite.config.js', 'FrontendReact/eslint.config.js', 'FrontendReact/src/index.css'];
  const pairs: [string, string][] = [
    ['ProsjektMVC/Controllers/HomeController.cs', 'ProsjektMVC/Models/ErrorViewModel.cs'],
    ['BackendAPI/Controllers/WeatherForecastController.cs', 'BackendAPI/WeatherForecast.cs'],
    ['FrontendReact/src/main.jsx', 'FrontendReact/src/App.jsx'],
  ];
  const graph = graphOf([...alone, ...pairs.flat()], pairs);
  assert.deepEqual(clusterFiles(graph), []);
});

// --- evidenceFor: the number a proposal is judged by, and it is ours -------

test('a proposed set is measured with the same cohesion a found group reports', () => {
  // Two triangles joined by one edge, which the clustering already pins at
  // 75% each. Proposing one of them by hand must give the same number, or a
  // proposal and a cluster would mean slightly different things on one screen.
  const graph = graphOf(
    [...members('a'), ...members('b')],
    [...triangle('a'), ...triangle('b'), ['a3.ts', 'b3.ts']],
  );
  const evidence = evidenceFor(graph, members('a'));

  assert.equal(evidence.cohesion, 0.75);
  assert.equal(evidence.inside, 3);
  assert.equal(evidence.leaving, 1);
  assert.deepEqual(evidence.files, members('a'));
  // Directions, not a total: one is who would break, the other is what it needs.
  assert.deepEqual(evidence.reaches, ['b3.ts']);
  assert.deepEqual(evidence.reachedFrom, []);
});

test('a set the graph has no file for is named rather than dropped', () => {
  const graph = graphOf(members('a'), triangle('a'));
  const evidence = evidenceFor(graph, ['a1.ts', 'src/invented.ts', 'a1.ts', 'a2.ts']);

  // A proposal naming files this project has not got is a proposal to
  // distrust, and a reader shown only the paths that landed cannot see that.
  assert.deepEqual(evidence.unknown, ['src/invented.ts']);
  assert.deepEqual(evidence.files, ['a1.ts', 'a2.ts']);
  assert.equal(evidence.inside, 1);
});

test('a test file in a proposed set is reported, and votes on none of the numbers', () => {
  const source = members('src/a');
  const graph = graphOf(
    [...source, 'src/__tests__/a1.test.ts'],
    [...triangle('src/a'), ['src/__tests__/a1.test.ts', 'src/a1.ts']],
  );
  const evidence = evidenceFor(graph, [...source, 'src/__tests__/a1.test.ts']);

  assert.deepEqual(evidence.tests, ['src/__tests__/a1.test.ts']);
  // The suite's edge is not counted inside and not counted leaving: it is not
  // in the map at all, which is the rule the clustering already follows.
  assert.equal(evidence.inside, 3);
  assert.equal(evidence.leaving, 0);
  assert.equal(evidence.cohesion, 1);
});

test('a set with no references at all is 0% rather than an error', () => {
  const graph = graphOf(['a.ts', 'b.ts', 'c.ts'], []);
  const evidence = evidenceFor(graph, ['a.ts', 'b.ts']);
  assert.equal(evidence.cohesion, 0);
  assert.equal(evidence.inside, 0);
  assert.equal(evidence.leaving, 0);
});

test('fileLinks is one directed row per pair, summed, sorted, and never a test', () => {
  const graph = graphOf(
    ['a.ts', 'b.ts', 'a.test.ts'],
    [
      ['b.ts', 'a.ts'],
      ['a.ts', 'b.ts'],
      ['a.ts', 'b.ts'],
      ['a.test.ts', 'a.ts'],
    ],
  );
  assert.deepEqual(fileLinks(graph), [
    { from: 'a.ts', to: 'b.ts', weight: 2 },
    { from: 'b.ts', to: 'a.ts', weight: 1 },
  ]);
});

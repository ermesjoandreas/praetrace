import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode } from '../graph/types.js';
import { clusterFiles } from './cluster.js';

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

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode } from '../graph/types.js';
import { search } from './search.js';

/** Files, each declaring the functions named for it, in the order given. */
function graphOf(declared: readonly [string, readonly string[]][]): Graph {
  const nodes = new Map<string, GraphNode>();
  for (const [file, symbols] of declared) {
    nodes.set(file, { id: file, kind: 'file', name: file, filePath: file, range: { startLine: 1, endLine: 1 } });
    symbols.forEach((name, index) => {
      const id = `${file}#${name}`;
      nodes.set(id, { id, kind: 'function', name, filePath: file, range: { startLine: 10 + index, endLine: 20 } });
    });
  }
  return { nodes, edges: [] };
}

test('the real useQuery outranks a fixture declaring the same name, whichever was parsed first', () => {
  const graph = graphOf([
    ['packages/eslint-plugin-query/src/__tests__/ts-fixture/react-query.d.ts', ['useQuery', 'UseQueryResult']],
    ['packages/react-query/src/__tests__/useQuery.test.tsx', ['useQuery']],
    ['packages/react-query/src/useQuery.ts', ['useQuery']],
    ['packages/lit-query/src/context.ts', ['useQueryClient']],
  ]);

  const hits = search(graph, 'useQuery');
  assert.deepEqual(
    hits.map((hit) => `${hit.name} ${hit.path}`),
    [
      // Exactly the name asked for, in code: first.
      'useQuery packages/react-query/src/useQuery.ts',
      // The file itself is an exact hit too, by its basename.
      'useQuery.ts packages/react-query/src/useQuery.ts',
      // Exact but scaffolding, shortest path first.
      'useQuery packages/react-query/src/__tests__/useQuery.test.tsx',
      'useQuery packages/eslint-plugin-query/src/__tests__/ts-fixture/react-query.d.ts',
      'useQuery.test.tsx packages/react-query/src/__tests__/useQuery.test.tsx',
      // Not exact at all.
      'useQueryClient packages/lit-query/src/context.ts',
      'UseQueryResult packages/eslint-plugin-query/src/__tests__/ts-fixture/react-query.d.ts',
      'react-query.d.ts packages/eslint-plugin-query/src/__tests__/ts-fixture/react-query.d.ts',
    ],
  );
});

test('among names that are not exact, a better match still beats a shorter path', () => {
  const graph = graphOf([
    ['a.ts', ['getSomeThing']],
    ['src/graph/store.ts', ['GraphStore']],
  ]);
  assert.deepEqual(
    search(graph, 'gst')
      .filter((hit) => hit.kind !== 'file')
      .map((hit) => hit.name),
    ['GraphStore', 'getSomeThing'],
  );
});

test('a match in a test file still comes back when nothing else matches', () => {
  const graph = graphOf([['src/view/lanes.test.ts', ['threads']]]);
  assert.equal(search(graph, 'threads')[0]?.path, 'src/view/lanes.test.ts');
});

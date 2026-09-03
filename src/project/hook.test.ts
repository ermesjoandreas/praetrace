import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '../graph/types.js';
import { couplingNote } from './hook.js';

/** A node named after its id, unless told otherwise: a member's name is bare. */
function node(id: string, kind: NodeKind, filePath: string, name = id.slice(id.indexOf('#') + 1)): GraphNode {
  return { id, kind, name, filePath, range: { startLine: 1, endLine: 1 } };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}

/** This project's own shape: a store four files import and two call into. */
const store = graphOf(
  [
    node('src/graph/store.ts', 'file', 'src/graph/store.ts'),
    node('src/graph/store.ts#createStore', 'function', 'src/graph/store.ts'),
    node('src/graph/store.ts#applyBatch', 'function', 'src/graph/store.ts'),
    node('src/graph/store.ts#derive', 'function', 'src/graph/store.ts'),
    node('src/server/session.ts', 'file', 'src/server/session.ts'),
    node('src/server/session.ts#openSession', 'function', 'src/server/session.ts'),
    node('src/cli/index.ts', 'file', 'src/cli/index.ts'),
    node('src/cli/index.ts#main', 'function', 'src/cli/index.ts'),
    node('src/project/history.ts', 'file', 'src/project/history.ts'),
    node('src/server/live.ts', 'file', 'src/server/live.ts'),
  ],
  [
    { from: 'src/server/session.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/cli/index.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/project/history.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/server/live.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/server/session.ts#openSession', to: 'src/graph/store.ts#createStore', kind: 'calls' },
    { from: 'src/server/session.ts#openSession', to: 'src/graph/store.ts#applyBatch', kind: 'calls' },
    { from: 'src/cli/index.ts#main', to: 'src/graph/store.ts#createStore', kind: 'calls' },
    // Inside the file, so it says nothing about who depends on it.
    { from: 'src/graph/store.ts#applyBatch', to: 'src/graph/store.ts#derive', kind: 'calls' },
  ],
);

test('the note is prose a person would write, and it names both halves', () => {
  assert.equal(
    couplingNote(store, 'src/graph/store.ts'),
    'src/graph/store.ts is imported by 4 files — src/cli/index.ts, src/project/history.ts, ' +
      'src/server/live.ts and src/server/session.ts. applyBatch and createStore are used from ' +
      'outside it.',
  );
});

test('no ratio is offered, because the graph cannot support one', () => {
  // The denominator used to be every non-file node, and it was wrong twice
  // over: an interface's own fields counted as symbols, and members dominate
  // the population while their use from outside is exactly what the graph
  // declines to track. So a file whose only reached symbol is a method must
  // read as one fact, not as one-in-four.
  const members = graphOf(
    [
      node('src/store.ts', 'file', 'src/store.ts'),
      node('src/store.ts#Store', 'class', 'src/store.ts'),
      node('src/store.ts#Store.open', 'method', 'src/store.ts', 'open'),
      node('src/store.ts#Store.path', 'field', 'src/store.ts', 'path'),
      node('src/store.ts#Options', 'interface', 'src/store.ts'),
      node('src/store.ts#Options.root', 'field', 'src/store.ts', 'root'),
      node('src/app.ts', 'file', 'src/app.ts'),
      node('src/app.ts#main', 'function', 'src/app.ts'),
    ],
    [{ from: 'src/app.ts#main', to: 'src/store.ts#Store.open', kind: 'calls' }],
  );

  const note = couplingNote(members, 'src/store.ts');
  assert.equal(note, 'open is used from outside src/store.ts.');
  assert.ok(!/\d+ of /.test(note), `the note still counts against a denominator: ${note}`);
});

test('nothing is said about a file the graph has never seen', () => {
  assert.equal(couplingNote(store, 'src/graph/nowhere.ts'), '');
  // A symbol id is not a file, and neither is a directory the view draws as a box.
  assert.equal(couplingNote(store, 'src/graph/store.ts#createStore'), '');
  assert.equal(couplingNote(store, 'src/graph'), '');
});

test('nothing is said about a file nothing depends on', () => {
  // session.ts imports and calls plenty; the hook still has nothing to tell the
  // agent about editing it, and a hook that always speaks stops being read.
  assert.equal(couplingNote(store, 'src/server/session.ts'), '');
});

test('a file with dependents but no symbols used from outside gets one sentence', () => {
  const onlyImports = graphOf(
    [node('a.ts', 'file', 'a.ts'), node('b.ts', 'file', 'b.ts')],
    [{ from: 'b.ts', to: 'a.ts', kind: 'imports' }],
  );
  assert.equal(couplingNote(onlyImports, 'a.ts'), 'a.ts is imported by 1 file — b.ts.');
});

test('a file nobody imports can still have symbols reached from outside', () => {
  // Go resolves a call through the package, not through a file's own import, so
  // the second sentence has to be able to stand on its own and name the file.
  const pkg = graphOf(
    [
      node('cmd/root.go', 'file', 'cmd/root.go'),
      node('cmd/root.go#Command', 'class', 'cmd/root.go'),
      node('cmd/root.go#Command.Execute', 'method', 'cmd/root.go', 'Execute'),
      node('main.go', 'file', 'main.go'),
      node('main.go#main', 'function', 'main.go'),
    ],
    [{ from: 'main.go#main', to: 'cmd/root.go#Command.Execute', kind: 'calls' }],
  );

  assert.equal(couplingNote(pkg, 'cmd/root.go'), 'Execute is used from outside cmd/root.go.');
});

test('a file is a caller too, and its call counts as a dependent', () => {
  // A call written outside every symbol belongs to the file — see GraphEdge.from
  // — so the edge's source is a file node, and reading its filePath must still
  // answer which file it came from.
  const topLevel = graphOf(
    [
      node('schema.ts', 'file', 'schema.ts'),
      node('schema.ts#object', 'function', 'schema.ts'),
      node('schema.ts#string', 'function', 'schema.ts'),
      node('app.ts', 'file', 'app.ts'),
    ],
    [{ from: 'app.ts', to: 'schema.ts#object', kind: 'calls' }],
  );

  assert.equal(couplingNote(topLevel, 'schema.ts'), 'object is used from outside schema.ts.');
});

test('a file that calls something it declares is not a dependent of itself', () => {
  // The store already refuses to draw that edge; this is the second guard, so a
  // file whose own top-level statement calls its own function is not reported
  // as coupled to itself.
  const selfCall = graphOf(
    [node('a.ts', 'file', 'a.ts'), node('a.ts#helper', 'function', 'a.ts')],
    [{ from: 'a.ts', to: 'a.ts#helper', kind: 'calls' }],
  );
  assert.equal(couplingNote(selfCall, 'a.ts'), '');
});

test('one over the cap is named, and two over are counted', () => {
  const importers = (count: number): Graph =>
    graphOf(
      [node('a.ts', 'file', 'a.ts'), ...Array.from({ length: count }, (_, i) => node(`i${i}.ts`, 'file', `i${i}.ts`))],
      Array.from({ length: count }, (_unused, i) => ({ from: `i${i}.ts`, to: 'a.ts', kind: 'imports' as const })),
    );

  // Four fit, because "and 1 more" costs the room the name would have taken.
  assert.equal(
    couplingNote(importers(4), 'a.ts'),
    'a.ts is imported by 4 files — i0.ts, i1.ts, i2.ts and i3.ts.',
  );
  assert.equal(
    couplingNote(importers(5), 'a.ts'),
    'a.ts is imported by 5 files — i0.ts, i1.ts, i2.ts and 2 more.',
  );
});

test('a long-pathed project loses the paths before it loses the names', () => {
  // A real monorepo path, and both sentences: separately either fits, together
  // they do not.
  const deep = (n: number): string => `packages/some-workspace-package/src/internal/generated/module-${n}.ts`;
  const wide = graphOf(
    [
      node(deep(0), 'file', deep(0)),
      node(`${deep(0)}#parseIncomingRequestBody`, 'function', deep(0)),
      node(`${deep(0)}#serialiseOutgoingResponse`, 'function', deep(0)),
      ...[1, 2, 3, 4].map((n) => node(deep(n), 'file', deep(n))),
      ...[1, 2].map((n) => node(`${deep(n)}#handle`, 'function', deep(n), 'handle')),
    ],
    [
      ...[1, 2, 3, 4].map((n) => ({ from: deep(n), to: deep(0), kind: 'imports' as const })),
      { from: `${deep(1)}#handle`, to: `${deep(0)}#parseIncomingRequestBody`, kind: 'calls' },
      { from: `${deep(2)}#handle`, to: `${deep(0)}#serialiseOutgoingResponse`, kind: 'calls' },
    ],
  );

  const note = couplingNote(wide, deep(0));
  assert.ok(note.length <= 400, `note was ${note.length} characters`);
  // The four paths are what will not fit; the two names cost a tenth as much
  // and are the half the agent could not have worked out from its own edit.
  assert.equal(
    note,
    `${deep(0)} is imported by 4 files. parseIncomingRequestBody and ` +
      'serialiseOutgoingResponse are used from outside it.',
  );
});

test('and when even the names will not fit, it counts them instead', () => {
  const deep = (n: number): string => `packages/some-workspace-package/src/internal/generated/module-${n}.ts`;
  // Generated code, where the name carries the whole contract.
  const long = (n: number): string =>
    `handleIncomingRequestForGeneratedModule${n}WithRetriesAndStructuredLoggingPayload`;
  const wide = graphOf(
    [
      node(deep(0), 'file', deep(0)),
      ...[1, 2, 3, 4, 5].map((n) => node(`${deep(0)}#${long(n)}`, 'function', deep(0), long(n))),
      ...[1, 2, 3, 4].map((n) => node(deep(n), 'file', deep(n))),
      ...[1, 2, 3, 4].map((n) => node(`${deep(n)}#handle`, 'function', deep(n), 'handle')),
    ],
    [
      ...[1, 2, 3, 4].map((n) => ({ from: deep(n), to: deep(0), kind: 'imports' as const })),
      ...[1, 2, 3, 4].map((n) => ({
        from: `${deep(n)}#handle`,
        to: `${deep(0)}#${long(n)}`,
        kind: 'calls' as const,
      })),
    ],
  );

  const note = couplingNote(wide, deep(0));
  assert.ok(note.length <= 400, `note was ${note.length} characters`);
  assert.equal(
    note,
    `${deep(0)} is imported by 4 files. 4 symbols are used from outside it.`,
  );
});

test('a path too long even to count against is silence, not half a sentence', () => {
  const absurd = `${'a/'.repeat(220)}file.ts`;
  const graph = graphOf(
    [node(absurd, 'file', absurd), node('b.ts', 'file', 'b.ts')],
    [{ from: 'b.ts', to: absurd, kind: 'imports' }],
  );
  assert.equal(couplingNote(graph, absurd), '');
});

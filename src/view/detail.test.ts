import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode, NodeKind } from '../graph/types.js';
import { describe, describeSymbol, type Detail } from './detail.js';

/** A node named after its id, unless told otherwise: a member's name is bare. */
function node(id: string, kind: NodeKind, filePath: string, name = id.slice(id.indexOf('#') + 1)): GraphNode {
  return { id, kind, name, filePath, range: { startLine: 1, endLine: 1 } };
}

const graph: Graph = {
  nodes: new Map(
    [
      node('command.ts', 'file', 'command.ts'),
      node('command.ts#Command', 'class', 'command.ts'),
      node('command.ts#Command.Execute', 'method', 'command.ts', 'Execute'),
      node('command.ts#Command.name', 'field', 'command.ts', 'name'),
      node('command.ts#run', 'function', 'command.ts'),
      node('command.ts#Runner', 'interface', 'command.ts'),
      node('command.ts#Args', 'type', 'command.ts'),
      // A dotted type name — a namespace's, or `type Foo.Bar` as a d.ts writes it — is still a type.
      node('types.d.ts#Query.Options', 'type', 'types.d.ts'),
      // express: a function assigned to a property keeps the dot in its name.
      node('lib/utils.js#exports.compileETag', 'function', 'lib/utils.js'),
      node('lib/application.js#app.handle', 'function', 'lib/application.js'),
    ].map((n) => [n.id, n]),
  ),
  edges: [{ from: 'command.ts#run', to: 'command.ts#Command', kind: 'calls' }],
};

test('a method or a field is partial: the receiver is not always written down', () => {
  for (const id of ['command.ts#Command.Execute', 'command.ts#Command.name']) {
    const links = describeSymbol(graph, id);
    assert.equal(links?.coverage, 'partial');
    assert.match(links?.coverageNote ?? '', /not written down/);
    assert.match(links?.coverageNote ?? '', /unknown, not none/);
    // An empty list is exactly the case the note exists for.
    assert.deepEqual(links?.usedBy, []);
  }
});

test('a function assigned to a property is partial: it is called through the object', () => {
  // application.js calls `compileETag(val)`; the graph found nothing and must not call that full.
  for (const id of ['lib/utils.js#exports.compileETag', 'lib/application.js#app.handle']) {
    const links = describeSymbol(graph, id);
    assert.equal(links?.coverage, 'partial');
    assert.match(links?.coverageNote ?? '', /through the object it is assigned to/);
    assert.match(links?.coverageNote ?? '', /unknown, not none/);
    assert.deepEqual(links?.usedBy, []);
  }
});

test('an interface or a type is partial: a use in a type position is not an edge', () => {
  for (const id of ['command.ts#Runner', 'command.ts#Args', 'types.d.ts#Query.Options']) {
    const links = describeSymbol(graph, id);
    assert.equal(links?.coverage, 'partial');
    assert.match(links?.coverageNote ?? '', /type positions/);
    assert.match(links?.coverageNote ?? '', /unknown, not none/);
  }
});

test('a function or a class is full, and the note says what full leaves out', () => {
  for (const id of ['command.ts#run', 'command.ts#Command']) {
    const links = describeSymbol(graph, id);
    assert.equal(links?.coverage, 'full');
    assert.match(links?.coverageNote ?? '', /passed by value is not tracked/);
  }
  assert.deepEqual(
    describeSymbol(graph, 'command.ts#Command')?.usedBy.map((relation) => [relation.id, relation.edge]),
    [['command.ts#run', 'calls']],
  );
});

/**
 * A call written outside every symbol: main.ts calls two things in lib.ts from
 * top-level statements, and imports it as well — which is the ordinary case,
 * and the reason the two lists have to stay apart.
 */
const topLevel: Graph = {
  nodes: new Map(
    [
      node('lib.ts', 'file', 'lib.ts'),
      node('lib.ts#helper', 'function', 'lib.ts'),
      node('lib.ts#other', 'function', 'lib.ts'),
      node('main.ts', 'file', 'main.ts'),
      node('main.ts#run', 'function', 'main.ts'),
    ].map((n) => [n.id, n]),
  ),
  edges: [
    { from: 'main.ts', to: 'lib.ts', kind: 'imports' },
    { from: 'main.ts', to: 'lib.ts#helper', kind: 'calls' },
    { from: 'main.ts', to: 'lib.ts#other', kind: 'calls' },
    { from: 'main.ts', to: 'main.ts#run', kind: 'contains' },
  ],
};

/** `describe` narrowed to the file half of the union, without a cast. */
function fileDetail(graph: Graph, target: string): Extract<Detail, { kind: 'file' }> {
  const detail = describe(graph, target);
  if (detail?.kind !== 'file') throw new Error(`no file detail for ${target}`);
  return detail;
}

test('a file is a caller, and the symbol it calls says so', () => {
  assert.deepEqual(
    describeSymbol(topLevel, 'lib.ts#helper')?.usedBy.map((r) => [r.id, r.kind, r.edge]),
    [['main.ts', 'file', 'calls']],
  );
  // Its `contains` is not a relation, so a symbol never lists its own file.
  assert.deepEqual(describeSymbol(topLevel, 'main.ts#run')?.usedBy, []);
  // And nothing calls a file: a call resolves through the export tables, which
  // hold symbols only.
  assert.deepEqual(describeSymbol(topLevel, 'main.ts#run')?.uses, []);
});

test("a file's own calls are listed apart from its imports, one entry per file", () => {
  const detail = fileDetail(topLevel, 'main.ts');
  // Two calls into lib.ts, one path — and the same path under both headings,
  // because both statements are true and neither implies the other.
  assert.deepEqual(detail.calls, ['lib.ts']);
  assert.deepEqual(detail.imports, ['lib.ts']);
  assert.deepEqual(detail.importedBy, []);
  // The called file's own list is empty; it is the callee, not the caller.
  assert.deepEqual(fileDetail(topLevel, 'lib.ts').calls, []);
});

test('a file never calls itself, and a target the graph has lost is dropped', () => {
  const stale: Graph = {
    nodes: topLevel.nodes,
    edges: [
      // A re-parse can drop a node while an edge still names it. A dangling
      // target has no file path, so it cannot become one.
      { from: 'main.ts', to: 'gone.ts#vanished', kind: 'calls' },
      // The store refuses this one for the same reason the panel would: a box
      // pointing at a row inside itself says nothing that `contains` did not.
      { from: 'main.ts', to: 'main.ts#run', kind: 'calls' },
    ],
  };
  assert.deepEqual(fileDetail(stale, 'main.ts').calls, []);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Graph, GraphNode, NodeKind } from '../graph/types.js';
import { describeSymbol } from './detail.js';

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

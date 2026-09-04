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

test('a function or a class is tracked, and the note says the count is a floor', () => {
  for (const id of ['command.ts#run', 'command.ts#Command']) {
    const links = describeSymbol(graph, id);
    // Never 'full': the word claimed a census the graph has no way to take.
    assert.equal(links?.coverage, 'tracked');
    assert.match(links?.coverageNote ?? '', /passed to a function as a value/);
    assert.match(links?.coverageNote ?? '', /floor/);
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

/**
 * cobra's `Command.execute`, cut down to the question that was asked of it.
 *
 * "Does flag parsing run before PersistentPreRun?" The source runs
 * `ParseFlags` first and the persistent hooks late, so the answer is yes — but
 * it is yes by accident of the alphabet here, and `ValidateArgs` sorting last
 * is the same accident giving the wrong answer, since the source validates
 * before it runs anything. Nothing on the reply said the order was the
 * alphabet's, and nothing said the list was a floor.
 */
const lifecycle: Graph = {
  nodes: new Map(
    [
      node('command.go', 'file', 'command.go'),
      node('command.go#Command', 'class', 'command.go'),
      node('command.go#Command.execute', 'method', 'command.go', 'execute'),
      node('command.go#Command.ParseFlags', 'method', 'command.go', 'ParseFlags'),
      node('command.go#Command.PersistentPreRun', 'field', 'command.go', 'PersistentPreRun'),
      node('command.go#Command.PreRun', 'field', 'command.go', 'PreRun'),
      node('command.go#Command.ValidateArgs', 'method', 'command.go', 'ValidateArgs'),
    ].map((n) => [n.id, n]),
  ),
  edges: [
    'command.go#Command.ParseFlags',
    'command.go#Command.PersistentPreRun',
    'command.go#Command.PreRun',
    'command.go#Command.ValidateArgs',
  ].map((to) => ({ from: 'command.go#Command.execute', to, kind: 'calls' as const })),
};

test('a list of calls says it is a floor, and says what its order is', () => {
  const links = describeSymbol(lifecycle, 'command.go#Command.execute');

  // The order is the alphabet's, which is worth pinning: the note claims it,
  // and a reader who is told that much can stop reading the list as a sequence.
  assert.deepEqual(links?.uses.map((relation) => relation.name), [
    'ParseFlags',
    'PersistentPreRun',
    'PreRun',
    'ValidateArgs',
  ]);

  // Four calls, all four found, and still not a census: the receiver a Go call
  // is written on is often the result of another call, and that is dropped.
  assert.equal(links?.usesCoverage, 'partial');
  assert.match(links?.usesNote ?? '', /floor/);
  assert.match(links?.usesNote ?? '', /result of another call/);
  assert.match(links?.usesNote ?? '', /not the source's/);
  assert.match(links?.usesNote ?? '', /by file and then by name/);

  // The other direction keeps its own sentence; one list's caveat is not the
  // other's, and a method's callers are missing for a different reason.
  assert.notEqual(links?.usesNote, links?.coverageNote);
});

test("a file's own calls carry the same sentence its symbols' do", () => {
  const detail = fileDetail(topLevel, 'main.ts');
  assert.equal(detail.callsCoverage, 'partial');
  assert.match(detail.callsNote, /floor/);
  assert.match(detail.callsNote, /not the source's/);
  // The same list an empty one would carry: a file that calls nothing is not a
  // file the graph has read every call of.
  assert.equal(fileDetail(topLevel, 'lib.ts').callsCoverage, 'partial');
});

/**
 * TanStack/query's shape, cut down to what decides the answer.
 *
 * `QueryObserver` is declared in one file, handed on by a barrel that declares
 * nothing, and used by an adapter that imports the barrel and passes the class
 * to another function — which is not a call, so there is no edge from it. The
 * real graph answers "used by 16" where grep finds 26 non-test sites in 8
 * packages, and the two facts that make the number a floor are both here.
 */
const handedOn: Graph = {
  nodes: new Map(
    [
      node('packages/query-core/src/queryObserver.ts', 'file', 'packages/query-core/src/queryObserver.ts'),
      node('packages/query-core/src/queryObserver.ts#QueryObserver', 'class', 'packages/query-core/src/queryObserver.ts'),
      // The barrel: `export * from './queryObserver'` and nothing else.
      node('packages/query-core/src/index.ts', 'file', 'packages/query-core/src/index.ts'),
      node('packages/react-query/src/useQuery.ts', 'file', 'packages/react-query/src/useQuery.ts'),
      node('packages/react-query/src/useQuery.ts#useQuery', 'function', 'packages/react-query/src/useQuery.ts'),
    ].map((n) => [n.id, n]),
  ),
  edges: [
    { from: 'packages/query-core/src/index.ts', to: 'packages/query-core/src/queryObserver.ts', kind: 'imports' },
    { from: 'packages/react-query/src/useQuery.ts', to: 'packages/query-core/src/index.ts', kind: 'imports' },
  ],
};

test('a class a barrel hands on is partial, and the note names the file that hands it on', () => {
  const links = describeSymbol(handedOn, 'packages/query-core/src/queryObserver.ts#QueryObserver');
  assert.equal(links?.coverage, 'partial');
  assert.match(links?.coverageNote ?? '', /packages\/query-core\/src\/index\.ts/);
  // The note is about the importers on the far side, not about what the
  // pass-through declares: it may declare plenty and still hand this on.
  assert.match(links?.coverageNote ?? '', /Handed on by .*imported by/);
  // How many files stand behind the barrel is the scale of what is missing,
  // and it is the half of the sentence a reader can act on.
  assert.match(links?.coverageNote ?? '', /imported by 1 file\b/);
  assert.match(links?.coverageNote ?? '', /floor/);
  // And the list it qualifies is the empty one that used to read as a fact.
  assert.deepEqual(links?.usedBy, []);
});

test('a class nothing hands on is tracked, so the word still carries information', () => {
  const links = describeSymbol(handedOn, 'packages/react-query/src/useQuery.ts#useQuery');
  assert.equal(links?.coverage, 'tracked');
});

test("a file's importers are a floor when something declaring nothing hands it on", () => {
  const detail = fileDetail(handedOn, 'packages/query-core/src/queryObserver.ts');
  // One import edge, and two files that depend on it.
  assert.deepEqual(detail.importedBy, ['packages/query-core/src/index.ts']);
  assert.equal(detail.importedByCoverage, 'partial');
  assert.match(detail.importedByNote, /packages\/query-core\/src\/index\.ts/);
  assert.match(detail.importedByNote, /floor/);
});

test('a file nothing hands on says so, and still says the count is a floor', () => {
  const detail = fileDetail(topLevel, 'lib.ts');
  assert.equal(detail.importedByCoverage, 'tracked');
  assert.match(detail.importedByNote, /floor/);
});

/** The same shape one level up: the barrel sits beside the directory it hands on. */
const nested: Graph = {
  nodes: new Map(
    [
      node('core/index.ts', 'file', 'core/index.ts'),
      node('core/observers/queryObserver.ts', 'file', 'core/observers/queryObserver.ts'),
      node('core/observers/queryObserver.ts#QueryObserver', 'class', 'core/observers/queryObserver.ts'),
      node('app/useQuery.ts', 'file', 'app/useQuery.ts'),
      node('app/useQuery.ts#useQuery', 'function', 'app/useQuery.ts'),
    ].map((n) => [n.id, n]),
  ),
  edges: [
    { from: 'core/index.ts', to: 'core/observers/queryObserver.ts', kind: 'imports' },
    { from: 'app/useQuery.ts', to: 'core/index.ts', kind: 'imports' },
  ],
};

test('a directory carries the same qualification, and its own members do not raise it', () => {
  const observers = describe(nested, 'core/observers');
  assert.equal(observers?.kind === 'folder' ? observers.importedByCoverage : null, 'partial');

  // core/index.ts is inside core, so for that directory as a unit it hands
  // nothing on — the same reason an import between two members is not one of
  // the directory's imports.
  const core = describe(nested, 'core');
  assert.equal(core?.kind === 'folder' ? core.importedByCoverage : null, 'tracked');
});

/** A file that declares nothing and is imported by nobody: it hands on to no one. */
const leaf: Graph = {
  nodes: new Map(
    [
      node('lib.ts', 'file', 'lib.ts'),
      node('lib.ts#helper', 'function', 'lib.ts'),
      node('scripts/build.ts', 'file', 'scripts/build.ts'),
    ].map((n) => [n.id, n]),
  ),
  edges: [{ from: 'scripts/build.ts', to: 'lib.ts', kind: 'imports' }],
};

test('a file nobody imports hands nothing on, however little it declares', () => {
  assert.equal(fileDetail(leaf, 'lib.ts').importedByCoverage, 'tracked');
  assert.equal(describeSymbol(leaf, 'lib.ts#helper')?.coverage, 'tracked');
});

/**
 * A file whose parse hit a syntax error and yielded no symbols.
 *
 * It was excused once, on the reasoning that it declares plenty and the parser
 * dropped it. TanStack/query's react-query barrel is that file — `export type *`
 * is what tree-sitter stumbles on — and excusing it hid its 138 importers from
 * every file it hands on. We cannot read what it declares, so we cannot rule
 * out that it hands this on, and the cautious answer is the floor.
 */
const unreadable: Graph = {
  nodes: new Map(
    [
      node('lib.ts', 'file', 'lib.ts'),
      node('lib.ts#helper', 'function', 'lib.ts'),
      { ...node('broken.ts', 'file', 'broken.ts'), parseError: true as const },
      node('main.ts', 'file', 'main.ts'),
    ].map((n) => [n.id, n]),
  ),
  edges: [
    { from: 'broken.ts', to: 'lib.ts', kind: 'imports' },
    { from: 'main.ts', to: 'broken.ts', kind: 'imports' },
  ],
};

test('a file whose symbols the parser lost is counted as handing on, not excused', () => {
  const detail = fileDetail(unreadable, 'lib.ts');
  assert.equal(detail.importedByCoverage, 'partial');
  assert.match(detail.importedByNote, /broken\.ts/);
  // And the sentence claims only what is true of both kinds of empty file.
  assert.match(detail.importedByNote, /Handed on by .*imported by/);
  assert.equal(describeSymbol(unreadable, 'lib.ts#helper')?.coverage, 'partial');
});

test('an alias is carried to the panel, so what counts the symbols can count the body once', () => {
  // express lib/response.js in miniature: `res.contentType = res.type = function`
  // is one body under two names, and the parser marks the second. Nothing
  // between it and the panel carried the mark, so the header said 24 symbols
  // where response.js holds 22 — the safe-looking direction, which is the one
  // this project refuses.
  const aliased: Graph = {
    nodes: new Map(
      [
        node('res.js', 'file', 'res.js'),
        { ...node('res.js#res.contentType', 'function', 'res.js'), range: { startLine: 510, endLine: 517 } },
        {
          ...node('res.js#res.type', 'function', 'res.js'),
          range: { startLine: 510, endLine: 517 },
          aliasOf: 'res.contentType',
        },
      ].map((n) => [n.id, n]),
    ),
    edges: [],
  };

  const detail = describe(aliased, 'res.js') as Extract<Detail, { kind: 'file' }>;
  assert.equal(detail.symbols.length, 2, 'both names are still listed');
  const alias = detail.symbols.find((symbol) => symbol.name === 'res.type');
  const primary = detail.symbols.find((symbol) => symbol.name === 'res.contentType');
  assert.equal(alias?.aliasOf, 'res.contentType', 'the alias says which body it names');
  assert.equal(primary?.aliasOf, undefined, 'the body itself is nobody’s alias');
  // What the header is made of: bodies, not names.
  assert.equal(detail.symbols.filter((symbol) => symbol.aliasOf === undefined).length, 1, 'one body');
});

/**
 * The Java tree the parser was measured against, in miniature.
 *
 * `bil` is a lower-case class, which the parser used to refuse outright, and
 * the panel answered "0 in · tracked" over the names it had refused. The names
 * come back now; the word still cannot be `tracked`, because a file that
 * declares no package and a type that is not the public one of its own file are
 * both invisible to the resolver, and a bare receiver is decided by a
 * convention rather than by the language.
 */
const java: Graph = {
  nodes: new Map(
    [
      node('p/bil.java', 'file', 'p/bil.java'),
      node('p/bil.java#bil', 'class', 'p/bil.java'),
      node('p/Kjoerbar.java', 'file', 'p/Kjoerbar.java'),
      node('p/Kjoerbar.java#Kjoerbar', 'interface', 'p/Kjoerbar.java'),
      node('p/MotorvognReg.java', 'file', 'p/MotorvognReg.java'),
      node('p/MotorvognReg.java#MotorvognReg.main', 'method', 'p/MotorvognReg.java', 'main'),
    ].map((n) => [n.id, n]),
  ),
  edges: [{ from: 'p/MotorvognReg.java#MotorvognReg.main', to: 'p/bil.java#bil', kind: 'calls' }],
};

test('a Java symbol is partial, and the note names the three references not followed', () => {
  const links = describeSymbol(java, 'p/bil.java#bil');
  assert.equal(links?.coverage, 'partial');
  assert.match(links?.coverageNote ?? '', /receiver the calling file does not declare/);
  assert.match(links?.coverageNote ?? '', /declares no package/);
  assert.match(links?.coverageNote ?? '', /not the public type of its own file/);
  assert.match(links?.coverageNote ?? '', /floor/);
  // And the count itself is real: the lower-case name resolves now.
  assert.deepEqual(
    links?.usedBy.map((relation) => [relation.id, relation.edge]),
    [['p/MotorvognReg.java#MotorvognReg.main', 'calls']],
  );
});

test('a Java interface gets Java\'s answer, not the one about type positions', () => {
  // In TypeScript an interface is mostly written where no edge can be drawn.
  // In Java it is reached by name from the package or an import, exactly as a
  // class is, so the sentence about type positions would send a reader looking
  // in the wrong place.
  const links = describeSymbol(java, 'p/Kjoerbar.java#Kjoerbar');
  assert.equal(links?.coverage, 'partial');
  assert.doesNotMatch(links?.coverageNote ?? '', /type positions/);
  assert.match(links?.coverageNote ?? '', /Followed by name across the package/);
});

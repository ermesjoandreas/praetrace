import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import { applyBatch, createStore, setProjectFacts } from './store.js';
import type { Graph } from './types.js';

/** A parsed file with nothing in it, for a fixture to fill in. */
function file(filePath: string, parts: Partial<ParsedFile> = {}): ParsedFile {
  return { filePath, language: 'typescript', imports: [], symbols: [], lineCount: 1, modifiedAt: 0, ...parts };
}

function symbol(name: string, kind: ParsedSymbol['kind'], parts: Partial<ParsedSymbol> = {}): ParsedSymbol {
  return { name, kind, startLine: 1, endLine: 1, extends: [], implements: [], calls: [], ...parts };
}

function graphOf(...files: ParsedFile[]): Graph {
  const store = createStore();
  applyBatch(store, files, []);
  return store.graph;
}

/** The edges of one kind, as `from -> to` strings a test can compare in bulk. */
function edges(graph: Graph, kind: string): string[] {
  return graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
}

// --- re-exports -------------------------------------------------------------

const observer = file('core/queryObserver.ts', {
  symbols: [symbol('QueryObserver', 'class'), symbol('fetch', 'method', { owner: 'QueryObserver' })],
});

test('a name imported through a barrel lands on the file that declares it', () => {
  const graph = graphOf(
    observer,
    file('core/index.ts', {
      reexports: [{ specifier: './queryObserver', names: [{ exported: 'QueryObserver', local: 'QueryObserver' }] }],
    }),
    file('react/useBaseQuery.ts', {
      imports: ['../core/index'],
      symbols: [symbol('useBaseQuery', 'function', { calls: ['QueryObserver'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['react/useBaseQuery.ts#useBaseQuery -> core/queryObserver.ts#QueryObserver']);
  // The barrel depends on what it re-exports, whether or not the parser also
  // listed the specifier as an import.
  assert.ok(edges(graph, 'imports').includes('core/index.ts -> core/queryObserver.ts'));
});

test('extends and a field type follow a star re-export the same way', () => {
  const graph = graphOf(
    observer,
    file('core/index.ts', { reexports: [{ specifier: './queryObserver', names: '*' }] }),
    file('lit/observer.ts', {
      imports: ['../core/index'],
      symbols: [
        symbol('LitObserver', 'class', { extends: ['QueryObserver'] }),
        symbol('inner', 'field', { owner: 'LitObserver', typeName: 'QueryObserver' }),
      ],
    }),
  );

  assert.deepEqual(edges(graph, 'extends'), ['lit/observer.ts#LitObserver -> core/queryObserver.ts#QueryObserver']);
  assert.deepEqual(edges(graph, 'associates'), ['lit/observer.ts#LitObserver -> core/queryObserver.ts#QueryObserver']);
});

test('a renamed re-export answers to the new name and not the old one', () => {
  const graph = graphOf(
    observer,
    file('core/index.ts', {
      reexports: [{ specifier: './queryObserver', names: [{ exported: 'Observer', local: 'QueryObserver' }] }],
    }),
    file('react/a.ts', { imports: ['../core/index'], symbols: [symbol('a', 'function', { calls: ['Observer'] })] }),
    file('react/b.ts', { imports: ['../core/index'], symbols: [symbol('b', 'function', { calls: ['QueryObserver'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['react/a.ts#a -> core/queryObserver.ts#QueryObserver']);
});

test('a barrel that re-exports a barrel is followed, and a cycle between two is not fatal', () => {
  const graph = graphOf(
    observer,
    // a and b export each other; only b reaches the declaration.
    file('core/a.ts', { reexports: [{ specifier: './b', names: '*' }] }),
    file('core/b.ts', { reexports: [{ specifier: './a', names: '*' }, { specifier: './queryObserver', names: '*' }] }),
    file('react/use.ts', { imports: ['../core/a'], symbols: [symbol('use', 'function', { calls: ['QueryObserver'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['react/use.ts#use -> core/queryObserver.ts#QueryObserver']);
});

/** `hops` barrels in a row, the last of which re-exports the declaring file. */
function chain(hops: number): ParsedFile[] {
  const barrels: ParsedFile[] = [];
  for (let i = 0; i < hops; i += 1) {
    const next = i === hops - 1 ? './queryObserver' : `./barrel${i + 1}`;
    barrels.push(file(`core/barrel${i}.ts`, { reexports: [{ specifier: next, names: '*' }] }));
  }
  return barrels;
}

test('re-exports are followed eight deep and no further', () => {
  const caller = file('react/use.ts', {
    imports: ['../core/barrel0'],
    symbols: [symbol('use', 'function', { calls: ['QueryObserver'] })],
  });

  assert.equal(edges(graphOf(observer, ...chain(8), caller), 'calls').length, 1);
  assert.equal(edges(graphOf(observer, ...chain(9), caller), 'calls').length, 0);
});

test('a file declaring a name itself shadows the same name re-exported from elsewhere', () => {
  const graph = graphOf(
    observer,
    file('core/index.ts', {
      symbols: [symbol('QueryObserver', 'function')],
      reexports: [{ specifier: './queryObserver', names: '*' }],
    }),
    file('react/use.ts', { imports: ['../core/index'], symbols: [symbol('use', 'function', { calls: ['QueryObserver'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['react/use.ts#use -> core/index.ts#QueryObserver']);
});

// --- qualified references ---------------------------------------------------

const command = file('command.ts', {
  symbols: [
    symbol('Command', 'class'),
    symbol('Execute', 'method', { owner: 'Command' }),
    symbol('execute', 'method', { owner: 'Command', calls: ['Command.Execute'] }),
    symbol('run', 'function'),
  ],
});

test('a qualified call lands on the member of the class it names', () => {
  const graph = graphOf(
    command,
    file('main.ts', { imports: ['./command'], symbols: [symbol('main', 'function', { calls: ['Command.Execute'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), [
    'command.ts#Command.execute -> command.ts#Command.Execute',
    'main.ts#main -> command.ts#Command.Execute',
  ]);
});

test('a bare name still never reaches a member', () => {
  const graph = graphOf(
    command,
    file('main.ts', { imports: ['./command'], symbols: [symbol('main', 'function', { calls: ['Execute'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['command.ts#Command.execute -> command.ts#Command.Execute']);
});

test('a qualified call is dropped unless its owner is a class or interface that declares the member', () => {
  const graph = graphOf(
    command,
    file('main.ts', {
      imports: ['./command'],
      symbols: [
        // `run` is a function, `Command.Missing` names nothing, `Nobody` is unknown.
        symbol('main', 'function', { calls: ['run.Execute', 'Command.Missing', 'Nobody.Execute'] }),
      ],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['command.ts#Command.execute -> command.ts#Command.Execute']);
});

test('a qualified call reaches an interface member, and a class found through a re-export', () => {
  const graph = graphOf(
    file('core/store.ts', {
      symbols: [symbol('Store', 'interface'), symbol('get', 'method', { owner: 'Store' })],
    }),
    file('core/index.ts', { reexports: [{ specifier: './store', names: '*' }] }),
    file('app.ts', { imports: ['./core/index'], symbols: [symbol('main', 'function', { calls: ['Store.get'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['app.ts#main -> core/store.ts#Store.get']);
});

// --- parse errors -----------------------------------------------------------

test('a file that did not parse cleanly says so on its node, and only then', () => {
  const graph = graphOf(file('broken.ts', { hasError: true }), file('fine.ts', { hasError: false }), file('older.ts'));

  assert.equal(graph.nodes.get('broken.ts')?.parseError, true);
  assert.equal('parseError' in (graph.nodes.get('fine.ts') ?? {}), false);
  assert.equal('parseError' in (graph.nodes.get('older.ts') ?? {}), false);
});

test('fixing a syntax error without changing the line count still reports the node', () => {
  const store = createStore();
  applyBatch(store, [file('broken.ts', { hasError: true })], []);
  const delta = applyBatch(store, [file('broken.ts', { hasError: false })], []);

  assert.deepEqual(delta.upsertedNodes.map((node) => node.id), ['broken.ts']);
});

// --- bindings ---------------------------------------------------------------

/**
 * What zod's schemas.ts looks like from here: a file exporting factories named
 * like array methods, which is what made the whole-table rule expensive.
 */
const schemas = file('core/schemas.ts', {
  symbols: [
    symbol('map', 'function', { exported: true }),
    symbol('bigint', 'function', { exported: true }),
    symbol('ZodType', 'class', { exported: true }),
    symbol('parse', 'method', { owner: 'ZodType' }),
  ],
});

test('a file that recorded its bindings reaches only what it bound', () => {
  const graph = graphOf(
    schemas,
    file('bench/compile.ts', {
      imports: ['../core/schemas'],
      bindings: [{ local: 'ZodType', specifier: '../core/schemas', imported: 'ZodType' }],
      // `rows.map(...)` and `process.hrtime.bigint()` arrive as bare tails.
      symbols: [symbol('timed', 'function', { calls: ['ZodType', 'map', 'bigint'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['bench/compile.ts#timed -> core/schemas.ts#ZodType']);
});

test('a bound name answers to its local name, read under the name it was imported as', () => {
  // import { ZodType as Base, map as mapSchema } from './core/schemas'
  const graph = graphOf(
    schemas,
    file('app.ts', {
      imports: ['./core/schemas'],
      bindings: [
        { local: 'Base', specifier: './core/schemas', imported: 'ZodType' },
        { local: 'mapSchema', specifier: './core/schemas', imported: 'map' },
      ],
      symbols: [
        symbol('Mine', 'class', { extends: ['Base'] }),
        symbol('build', 'function', { calls: ['mapSchema', 'ZodType', 'map'] }),
      ],
    }),
  );

  assert.deepEqual(edges(graph, 'extends'), ['app.ts#Mine -> core/schemas.ts#ZodType']);
  assert.deepEqual(edges(graph, 'calls'), ['app.ts#build -> core/schemas.ts#map']);
});

test('a namespace import resolves `ns.name` through the module, and neither half on its own', () => {
  const graph = graphOf(
    schemas,
    file('app.ts', {
      imports: ['./core/schemas'],
      bindings: [{ local: 'z', specifier: './core/schemas', imported: '*' }],
      symbols: [
        symbol('build', 'function', { calls: ['z.map', 'z.ZodType', 'z', 'map', 'z.missing', 'z.ZodType.parse'] }),
      ],
    }),
  );

  // `z.ZodType.parse` is a member of the class the module exports, reached
  // through the module: the one two-dot form the graph admits.
  assert.deepEqual(edges(graph, 'calls'), [
    'app.ts#build -> core/schemas.ts#ZodType',
    'app.ts#build -> core/schemas.ts#ZodType.parse',
    'app.ts#build -> core/schemas.ts#map',
  ]);
});

test('`ns.Thing.run` is the member of the Thing a namespace import stands for, never of the one bound bare', () => {
  const thing = (filePath: string): ParsedFile =>
    file(filePath, { symbols: [symbol('Thing', 'class', { exported: true }), symbol('run', 'method', { owner: 'Thing' })] });
  const graph = graphOf(
    thing('t1.ts'),
    thing('t2.ts'),
    file('a.ts', {
      imports: ['./t1', './t2'],
      bindings: [
        { local: 'Thing', specifier: './t1', imported: 'Thing' },
        { local: 'ns', specifier: './t2', imported: '*' },
      ],
      symbols: [symbol('f', 'function', { calls: ['ns.Thing.run', 'ns.Thing', 'Thing.run', 'ns.Nobody.run'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), [
    'a.ts#f -> t1.ts#Thing.run',
    'a.ts#f -> t2.ts#Thing',
    'a.ts#f -> t2.ts#Thing.run',
  ]);
});

test('a bound name still follows a barrel to the file that declares it', () => {
  const graph = graphOf(
    schemas,
    file('core/index.ts', { reexports: [{ specifier: './schemas', names: '*' }] }),
    file('app.ts', {
      imports: ['./core/index'],
      bindings: [{ local: 'ZodType', specifier: './core/index', imported: 'ZodType' }],
      symbols: [symbol('build', 'function', { calls: ['ZodType', 'ZodType.parse'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), [
    'app.ts#build -> core/schemas.ts#ZodType',
    'app.ts#build -> core/schemas.ts#ZodType.parse',
  ]);
});

test('a name bound to a module outside the project binds nothing, whatever an imported file exports', () => {
  const graph = graphOf(
    schemas,
    file('app.ts', {
      imports: ['./core/schemas', 'lodash'],
      bindings: [
        { local: 'map', specifier: 'lodash', imported: 'map' },
        { local: 'ZodType', specifier: './core/schemas', imported: 'ZodType' },
      ],
      symbols: [symbol('build', 'function', { calls: ['map'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), []);
});

test('own declarations come first, and a file that recorded no bindings keeps the whole table', () => {
  const graph = graphOf(
    schemas,
    file('own.ts', {
      imports: ['./core/schemas'],
      bindings: [],
      symbols: [symbol('map', 'function'), symbol('run', 'function', { calls: ['map'] })],
    }),
    file('legacy.ts', { imports: ['./core/schemas'], symbols: [symbol('run', 'function', { calls: ['map'] })] }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['legacy.ts#run -> core/schemas.ts#map', 'own.ts#run -> own.ts#map']);
});

test('a default import reads what the module exports by default, and never a symbol sharing its local name', () => {
  const graph = graphOf(
    file('lib/view.ts', { symbols: [symbol('View', 'class', { exported: false })], defaultExport: 'View' }),
    file('lib/make.ts', { symbols: [symbol('make', 'function', { exported: true })] }),
    file('app.ts', {
      imports: ['./lib/view', './lib/make'],
      bindings: [
        { local: 'View', specifier: './lib/view', imported: 'default' },
        { local: 'make', specifier: './lib/make', imported: 'default' },
      ],
      symbols: [symbol('run', 'function', { calls: ['View', 'make'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['app.ts#run -> lib/view.ts#View']);
});

test('a default is carried by `export { default as X }` and not by `export *`', () => {
  const view = file('lib/view.ts', { symbols: [symbol('View', 'class', { exported: false })], defaultExport: 'View' });
  const graph = graphOf(
    view,
    file('lib/named.ts', {
      reexports: [{ specifier: './view', names: [{ exported: 'View', local: 'default' }] }],
    }),
    file('lib/star.ts', { reexports: [{ specifier: './view', names: '*' }] }),
    file('app.ts', {
      imports: ['./lib/named', './lib/star'],
      bindings: [
        { local: 'View', specifier: './lib/named', imported: 'View' },
        { local: 'Star', specifier: './lib/star', imported: 'default' },
      ],
      symbols: [symbol('run', 'function', { calls: ['View', 'Star'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['app.ts#run -> lib/view.ts#View']);
});

test('a CommonJS require of a whole module answers a bare use with what the module exports', () => {
  // module.exports = View; and then `var View = require('./view'); new View()`.
  const graph = graphOf(
    file('lib/view.js', {
      language: 'javascript',
      symbols: [symbol('View', 'class', { exported: false })],
      defaultExport: 'View',
    }),
    file('lib/utils.js', { language: 'javascript', symbols: [symbol('exports.compileETag', 'function', { exported: true })] }),
    file('lib/application.js', {
      language: 'javascript',
      imports: ['./view', './utils'],
      bindings: [
        { local: 'View', specifier: './view', imported: '*' },
        { local: 'utils', specifier: './utils', imported: '*' },
      ],
      symbols: [symbol('app.render', 'function', { calls: ['View', 'utils', 'utils.compileETag'] })],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['lib/application.js#app.render -> lib/view.js#View']);
});

// --- exported ---------------------------------------------------------------

test('`export *` carries what a file exported through a barrel, and not the rest', () => {
  const graph = graphOf(
    file('a.ts', {
      symbols: [
        symbol('secret', 'function', { exported: false }),
        symbol('pub', 'function', { exported: true, calls: ['secret'] }),
      ],
    }),
    file('index.ts', { reexports: [{ specifier: './a', names: '*' }] }),
    file('b.ts', {
      imports: ['./index'],
      bindings: [{ local: 'ns', specifier: './index', imported: '*' }],
      symbols: [symbol('f', 'function', { calls: ['ns.secret', 'ns.pub'] })],
    }),
  );

  // A file still sees everything it declares itself.
  assert.deepEqual(edges(graph, 'calls'), ['a.ts#pub -> a.ts#secret', 'b.ts#f -> a.ts#pub']);
});

test('a parser that flags exports hides the rest from a direct import too; one that does not hides nothing', () => {
  const importer = (target: string): ParsedFile =>
    file('b.ts', {
      imports: [target],
      bindings: [{ local: 'hidden', specifier: target, imported: 'hidden' }],
      symbols: [symbol('f', 'function', { calls: ['hidden'] })],
    });

  const flagged = graphOf(file('a.ts', { symbols: [symbol('hidden', 'function', { exported: false })] }), importer('./a'));
  assert.deepEqual(edges(flagged, 'calls'), []);

  const unflagged = graphOf(file('a.ts', { symbols: [symbol('hidden', 'function')] }), importer('./a'));
  assert.deepEqual(edges(unflagged, 'calls'), ['b.ts#f -> a.ts#hidden']);
});

// --- the two forms of `#` ---------------------------------------------------

test('a call to an ES private member lands on it, and the bare member still on nothing', () => {
  const graph = graphOf(
    file('core/observer.ts', {
      symbols: [
        symbol('Observer', 'class'),
        symbol('#tick', 'method', { owner: 'Observer', visibility: 'private' }),
        symbol('start', 'method', { owner: 'Observer', calls: ['Observer.#tick', '#tick'] }),
      ],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), ['core/observer.ts#Observer.start -> core/observer.ts#Observer.#tick']);
});

function goGraph(...files: ParsedFile[]): Graph {
  const store = createStore();
  setProjectFacts(store, { tsPaths: new Map(), packages: new Map(), goModule: 'example.com/app', crates: new Map() });
  applyBatch(store, files, []);
  return store.graph;
}

/** cobra's shape: the type in one file of the package, a method on it in another. */
const commandGo = file('lib/command.go', {
  language: 'go',
  moduleName: 'lib',
  symbols: [symbol('Command', 'class'), symbol('Execute', 'method', { owner: 'Command' })],
});
const completionsGo = file('lib/completions.go', {
  language: 'go',
  moduleName: 'lib',
  symbols: [symbol('GenBash', 'method', { owner: 'Command' })],
});

test('a Go reference through an import lands on the declaring file, and on a method declared beside the type', () => {
  const graph = goGraph(
    commandGo,
    completionsGo,
    file('cmd/main.go', {
      language: 'go',
      moduleName: 'main',
      imports: ['example.com/app/lib#Command'],
      symbols: [
        symbol('main', 'function', {
          calls: [
            'example.com/app/lib#Command',
            'example.com/app/lib#Command.Execute',
            'example.com/app/lib#Command.GenBash',
            'example.com/app/lib#Nobody',
          ],
        }),
      ],
    }),
  );

  assert.deepEqual(edges(graph, 'calls'), [
    'cmd/main.go#main -> lib/command.go#Command',
    'cmd/main.go#main -> lib/command.go#Command.Execute',
    'cmd/main.go#main -> lib/completions.go#Command.GenBash',
  ]);
});

test('a Go type reached through an import is answered by the declaring file for extends, implements and a field type', () => {
  const graph = goGraph(
    commandGo,
    completionsGo,
    file('lib/runner.go', { language: 'go', moduleName: 'lib', symbols: [symbol('Runner', 'interface')] }),
    // Declares the bare tail of a reference whose import resolves to nothing.
    file('lib/flags.go', { language: 'go', moduleName: 'lib', symbols: [symbol('FlagSet', 'class')] }),
    file('cmd/root.go', {
      language: 'go',
      moduleName: 'cmd',
      imports: ['example.com/app/lib#Command', 'example.com/app/lib#Runner', 'github.com/spf13/pflag#FlagSet'],
      symbols: [
        symbol('Root', 'class', { extends: ['example.com/app/lib#Command'] }),
        symbol('cmd', 'field', { owner: 'Root', typeName: 'example.com/app/lib#Command' }),
        symbol('flags', 'field', { owner: 'Root', typeName: 'github.com/spf13/pflag#FlagSet' }),
        symbol('Impl', 'class', { implements: ['example.com/app/lib#Runner'] }),
      ],
    }),
  );

  assert.deepEqual(edges(graph, 'extends'), ['cmd/root.go#Root -> lib/command.go#Command']);
  assert.deepEqual(edges(graph, 'implements'), ['cmd/root.go#Impl -> lib/runner.go#Runner']);
  // pflag is outside the module, so its FlagSet is nothing here — not lib's.
  assert.deepEqual(edges(graph, 'associates'), ['cmd/root.go#Root -> lib/command.go#Command']);
});

test('the package-wide search for a member is Go\'s rule and does not run for Java', () => {
  const graph = graphOf(
    file('p/Foo.java', {
      language: 'java',
      moduleName: 'p',
      symbols: [
        symbol('Foo', 'class'),
        symbol('run', 'method', { owner: 'Foo', calls: ['Builder.build'] }),
        symbol('Builder', 'class', { extends: ['BaseBuilder'] }),
      ],
    }),
    file('p/Bar.java', {
      language: 'java',
      moduleName: 'p',
      symbols: [symbol('Bar', 'class'), symbol('Builder', 'class'), symbol('build', 'method', { owner: 'Builder' })],
    }),
  );

  // Foo's Builder inherits build; Bar's Builder declares one. Neither is an answer.
  assert.deepEqual(edges(graph, 'calls'), []);
});

// --- owner ------------------------------------------------------------------

test('a member carries its owner on the node, and a top-level name with a dot in it carries none', () => {
  const graph = graphOf(
    file('lib/application.js', {
      language: 'javascript',
      symbols: [symbol('app.init', 'function'), symbol('App', 'class'), symbol('init', 'method', { owner: 'App' })],
    }),
  );

  assert.equal(graph.nodes.get('lib/application.js#app.init')?.owner, undefined);
  assert.equal(graph.nodes.get('lib/application.js#App.init')?.owner, 'App');
});

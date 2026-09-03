import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore, setProjectFacts } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import type { ResolveContext } from './types.js';
import { python } from './python.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string, filePath?: string) {
  const parser = new TreeSitter();
  parser.setLanguage(python.grammar('a.py') as Parser.Language);
  return python.extract(parser.parse(source).rootNode, source, filePath);
}

const byName = (symbols: readonly ParsedSymbol[], name: string, owner?: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name && (owner === undefined || symbol.owner === owner));
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: 'python', lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source, filePath) };
}

/** The graph of a project, derived through the store with Python's own resolver. */
function graphOf(...files: ParsedFile[]): Graph {
  const store = createStore();
  setProjectFacts(store, { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() });
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

/** A resolve context over a file set, with nothing else filled in. */
function context(from: string, specifier: string, files: readonly string[]): ResolveContext {
  return {
    from,
    specifier,
    files: new Set(files),
    modules: new Map(),
    declarations: new Map(),
    imports: new Map(),
    facts: { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() },
  };
}

test('every form of import is written down as the graph reads it', () => {
  const { imports, bindings, reexports } = parse(`
    import os
    import a.b.c
    import xml.etree.ElementTree as ET
    from a.b import c, d as e
    from . import sib
    from .pkg import y
    from ..up import z
    from x import *

    def f():
        from .late import Late
        a.b.c.run()
        return a.b.c.Config
  `);

  // `from a.b import c` is `a.b#c`: c may be a name in a.b or the submodule
  // a/b/c.py, and only the resolver, which has the file set, can say which.
  // An unaliased dotted import is written out at every use, so its
  // references are the names reached through it, as Go writes them.
  assert.deepEqual(sorted(imports), [
    '.#sib',
    '..up#z',
    '.late#Late',
    '.pkg#y',
    'a.b#c',
    'a.b#d',
    'a.b.c#Config',
    'a.b.c#run',
    'os',
    'x',
    'xml.etree.ElementTree',
  ]);

  // Two bindings per from-import, and the store keeps the first that
  // resolves: the submodule when there is one, else the name in the module.
  assert.deepEqual(bindings, [
    { local: 'os', specifier: 'os', imported: '*' },
    { local: 'ET', specifier: 'xml.etree.ElementTree', imported: '*' },
    { local: 'c', specifier: 'a.b.c', imported: '*' },
    { local: 'c', specifier: 'a.b#c', imported: 'c' },
    { local: 'e', specifier: 'a.b.d', imported: '*' },
    { local: 'e', specifier: 'a.b#d', imported: 'd' },
    { local: 'sib', specifier: '.sib', imported: '*' },
    { local: 'sib', specifier: '.#sib', imported: 'sib' },
    { local: 'y', specifier: '.pkg.y', imported: '*' },
    { local: 'y', specifier: '.pkg#y', imported: 'y' },
    { local: 'z', specifier: '..up.z', imported: '*' },
    { local: 'z', specifier: '..up#z', imported: 'z' },
    { local: 'Late', specifier: '.late.Late', imported: '*' },
    { local: 'Late', specifier: '.late#Late', imported: 'Late' },
  ]);

  // Everything a module imports it also exports: that is how a package's
  // `__init__.py` presents its API, and a star import hands on the lot.
  assert.deepEqual(reexports, [
    { specifier: 'a.b#c', names: [{ exported: 'c', local: 'c' }] },
    { specifier: 'a.b#d', names: [{ exported: 'e', local: 'd' }] },
    { specifier: '.#sib', names: [{ exported: 'sib', local: 'sib' }] },
    { specifier: '.pkg#y', names: [{ exported: 'y', local: 'y' }] },
    { specifier: '..up#z', names: [{ exported: 'z', local: 'z' }] },
    { specifier: 'x', names: '*' },
    { specifier: '.late#Late', names: [{ exported: 'Late', local: 'Late' }] },
  ]);
});

test('a class is a UML class box: attributes, then operations, with what the source wrote about each', () => {
  const { symbols } = parse(`
    from abc import ABC, abstractmethod

    class Store(Base, m.Mixin, Generic[T], metaclass=Meta):
        """A store."""
        count: int = 0
        cache = Cache()
        _hidden: "Logger"
        label = "x"

        def __init__(self, log: Logger, items: list[Item], opt: Optional[Cache] = None):
            self.log = log
            self.items = items
            self.opt = opt
            self.thing: Thing = make()
            self.built = Builder()
            self.n = 1

        @staticmethod
        def make(cfg): ...

        @classmethod
        def build(cls): ...

        @abstractmethod
        def _step(self): ...

        def __eq__(self, other): ...

        class Meta:
            ordering = []

    class Reader(ABC): ...
    class _Private: ...
    def _helper(): ...
    async def fetch(): ...
  `);

  assert.deepEqual(
    symbols.map((symbol) => `${symbol.kind} ${symbol.owner === undefined ? '' : `${symbol.owner}.`}${symbol.name}`),
    [
      'class Store',
      'field Store.count',
      'field Store.cache',
      'field Store._hidden',
      'field Store.label',
      'field Store.log',
      'field Store.items',
      'field Store.opt',
      'field Store.thing',
      'field Store.built',
      'field Store.n',
      'method Store.__init__',
      'method Store.make',
      'method Store.build',
      'method Store._step',
      'method Store.__eq__',
      'class Reader',
      'class _Private',
      'function _helper',
      'function fetch',
    ],
  );

  // A keyword argument configures the class; a subscript names the generic
  // being specialised; a base reached through nothing this file imported
  // cannot be named and is left out rather than reduced to `Mixin`.
  assert.deepEqual(byName(symbols, 'Store').extends, ['Base', 'Generic']);
  assert.equal(byName(symbols, 'Store').isAbstract, undefined);
  assert.equal(byName(symbols, 'Reader').isAbstract, true);
  assert.deepEqual(byName(symbols, 'Reader').extends, ['ABC']);

  // The annotation carries the type and its cardinality; `= T(...)` names the
  // type; a parameter copied into a field carries the parameter's annotation.
  assert.equal(byName(symbols, 'count').typeName, 'int');
  assert.equal(byName(symbols, 'cache').typeName, 'Cache');
  assert.equal(byName(symbols, '_hidden').typeName, 'Logger');
  assert.equal(byName(symbols, 'label').typeName, undefined);
  assert.equal(byName(symbols, 'log').typeName, 'Logger');
  assert.equal(byName(symbols, 'items').typeName, 'Item');
  assert.equal(byName(symbols, 'items').many, true);
  assert.equal(byName(symbols, 'opt').typeName, 'Cache');
  assert.equal(byName(symbols, 'thing').typeName, 'Thing');
  assert.equal(byName(symbols, 'built').typeName, 'Builder');
  assert.equal(byName(symbols, 'n').typeName, undefined);

  // What was written: a leading underscore, a decorator. A dunder is the
  // language's protocol, not a private member; an unmarked name says nothing.
  assert.equal(byName(symbols, '_hidden').visibility, 'private');
  assert.equal(byName(symbols, '_step').visibility, 'private');
  assert.equal(byName(symbols, '_step').isAbstract, true);
  assert.equal(byName(symbols, '__eq__').visibility, undefined);
  assert.equal(byName(symbols, '__init__').visibility, undefined);
  assert.equal(byName(symbols, 'make').isStatic, true);
  assert.equal(byName(symbols, 'build').isStatic, true);
  assert.equal(byName(symbols, 'fetch').isStatic, undefined);

  // Every module-level name can be imported by name, underscore or not; a
  // member is reached through its owner and carries no flag.
  assert.equal(byName(symbols, 'Store').exported, true);
  assert.equal(byName(symbols, '_Private').exported, true);
  assert.equal(byName(symbols, '_helper').exported, true);
  assert.equal(byName(symbols, 'make').exported, undefined);
});

test('a call on a receiver whose type was written down is that type\'s method, and nothing else is', () => {
  const { symbols, calls } = parse(`
    import a.b.c
    import helpers as h
    from .models import Model

    app = Flask(__name__)
    seen = load()

    class Service:
        def __init__(self, log: Logger):
            self.log = log
            self.store = Store()

        def run(self, req: Request, opt: Optional[Cache] = None, raw, cb):
            self.log.info("x")
            self.store.save()
            self.helper()
            req.json()
            opt.get()
            raw.read()
            cb()
            local = Model()
            local.validate()
            h.util()
            a.b.c.f()
            app.route("/")
            seen.add(1)
            Model.create()
            for item in items:
                item.tick()
            with open(p) as fh:
                fh.read()
            def inner():
                return later()
            return inner()

        @classmethod
        def build(cls):
            return cls()

    @app.route("/")
    def index():
        return app.make_response()

    if __name__ == "__main__":
        app.run()
        main()
  `);

  // `raw` and `cb` were never given a type, and the loop and `with` targets
  // have no place to write one: each is left out rather than guessed at.
  // `seen = load()` types `seen` as `load`, because `T()` and `f()` are one
  // syntax in Python; the store draws the member only when `load` turns out
  // to be a class, and refuses it when it is a function. `inner` is a local
  // of `run`.
  assert.deepEqual(sorted(byName(symbols, 'run').calls), [
    'Cache.get',
    'Flask.route',
    'Logger.info',
    'Model',
    'Model.create',
    'Model.validate',
    'Request.json',
    'Service.helper',
    'Store.save',
    'a.b.c#f',
    'h.util',
    'later',
    'load.add',
    'open',
  ]);
  assert.deepEqual(byName(symbols, 'build').calls, ['Service']);
  assert.deepEqual(byName(symbols, 'index').calls, ['Flask.make_response']);

  // What runs when the module is imported: the constructions at the top, the
  // decorator on `index`, and the block under `__main__`. The module-level
  // `app` is typed for every function of the file, as a Go package variable is.
  assert.deepEqual(sorted(calls ?? []), ['Flask', 'Flask.route', 'Flask.run', 'load', 'main']);
});

test('a class written inside a method has a self of its own, and a closure still sees ours', () => {
  // requests' tests do this eleven times: a stand-in class declared inside the
  // test method, whose methods take `self` like any other. That `self` is the
  // stand-in's instance, so `self.helper()` in it must not be drawn as a call
  // from `run` to `Outer.helper` — the one wrong edge read as authoritative.
  const { symbols } = parse(`
    class Outer:
        def helper(self): ...

        def run(self):
            class Inner:
                def go(self):
                    self.helper()
            def cb(self):
                self.helper()
            return Inner()

        def later(self):
            def go():
                self.helper()
            return go
  `);
  assert.deepEqual(byName(symbols, 'run', 'Outer').calls, []);
  assert.deepEqual(byName(symbols, 'later', 'Outer').calls, ['Outer.helper']);
});

test('a module path resolves to a file from every source root, and a relative one from the importing file', () => {
  const files = [
    'src/flask/__init__.py',
    'src/flask/app.py',
    'src/flask/json/__init__.py',
    'src/flask/json/provider.py',
    'src/flask/sansio/app.py',
    'tests/conftest.py',
    'tests/test_apps/helloworld/__init__.py',
    'tests/test_apps/helloworld/wsgi.py',
    'scripts/run.py',
    'scripts/tool.py',
  ];
  const resolve = (from: string, specifier: string): string | null => python.resolve(context(from, specifier, files));

  // `src` holds a package without being one, so it is a root; so is the
  // directory flask's tests put their example apps in.
  assert.equal(resolve('tests/conftest.py', 'flask'), 'src/flask/__init__.py');
  assert.equal(resolve('tests/conftest.py', 'flask.app'), 'src/flask/app.py');
  assert.equal(resolve('tests/conftest.py', 'flask.json'), 'src/flask/json/__init__.py');
  assert.equal(resolve('tests/conftest.py', 'helloworld.wsgi'), 'tests/test_apps/helloworld/wsgi.py');
  assert.equal(resolve('tests/conftest.py', 'flask.missing'), null);
  assert.equal(resolve('tests/conftest.py', 'os'), null);

  // `from flask import Flask`: no submodule named Flask, so the package,
  // whose re-exports the graph follows from there. `from flask import json`
  // is the submodule.
  assert.equal(resolve('tests/conftest.py', 'flask#Flask'), 'src/flask/__init__.py');
  assert.equal(resolve('tests/conftest.py', 'flask#json'), 'src/flask/json/__init__.py');
  assert.equal(resolve('tests/conftest.py', 'flask.json#provider'), 'src/flask/json/provider.py');
  assert.equal(resolve('tests/conftest.py', 'flask.json#jsonify'), 'src/flask/json/__init__.py');

  // Relative to the importing file, as written.
  assert.equal(resolve('src/flask/app.py', '.sansio.app'), 'src/flask/sansio/app.py');
  assert.equal(resolve('src/flask/app.py', '.#json'), 'src/flask/json/__init__.py');
  assert.equal(resolve('src/flask/app.py', '.#globals'), 'src/flask/__init__.py');
  assert.equal(resolve('src/flask/json/provider.py', '..app#Flask'), 'src/flask/app.py');
  assert.equal(resolve('src/flask/json/provider.py', '..'), 'src/flask/__init__.py');
  assert.equal(resolve('src/flask/json/provider.py', '....'), null);

  // A script run from its own directory sees its neighbours by bare name.
  assert.equal(resolve('scripts/run.py', 'tool'), 'scripts/tool.py');
  assert.equal(resolve('tests/conftest.py', 'tool'), null);
});

test('a flat directory of scripts is the project root, and a package there is imported bare', () => {
  const files = ['main.py', 'solver.py', 'sim/__init__.py', 'sim/params.py'];
  const resolve = (from: string, specifier: string): string | null => python.resolve(context(from, specifier, files));
  assert.equal(resolve('main.py', 'solver'), 'solver.py');
  assert.equal(resolve('main.py', 'sim.params'), 'sim/params.py');
  assert.equal(resolve('main.py', 'sim#params'), 'sim/params.py');
  assert.equal(resolve('main.py', 'sim#Params'), 'sim/__init__.py');
  assert.equal(resolve('sim/params.py', '.#solver'), 'sim/__init__.py');
  assert.equal(resolve('main.py', 'numpy'), null);
});

test('a name imported through a package lands on the file that declares it', () => {
  // flask's shape: `__init__.py` is nothing but `from .app import Flask as Flask`,
  // and every test writes `from flask import Flask`.
  const graph = graphOf(
    parsedFile('src/flask/__init__.py', 'from .app import Flask as Flask\nfrom .json import jsonify as jsonify\nfrom . import sessions\n'),
    parsedFile(
      'src/flask/app.py',
      'from .sansio.app import App\n\nclass Flask(App):\n    def run(self, host=None):\n        self.make_response()\n\n    def make_response(self): ...\n',
    ),
    parsedFile('src/flask/sansio/app.py', 'class App:\n    def route(self, rule): ...\n'),
    parsedFile('src/flask/json/__init__.py', 'def jsonify(*args): ...\n'),
    parsedFile('src/flask/sessions.py', 'class SessionInterface: ...\n'),
    parsedFile(
      'tests/test_basic.py',
      `from flask import Flask, jsonify
from flask import sessions
import flask.json

def test_run():
    app = Flask("x")
    app.run()
    jsonify(a=1)
    sessions.SessionInterface()
    flask.json.jsonify()
`,
    ),
  );

  // The barrel is followed, not landed on: the import edge goes to app.py
  // because that is where Flask is, and to json's package because that is
  // where jsonify is.
  assert.deepEqual(edges(graph, 'imports'), [
    'src/flask/__init__.py -> src/flask/app.py',
    'src/flask/__init__.py -> src/flask/json/__init__.py',
    'src/flask/__init__.py -> src/flask/sessions.py',
    'src/flask/app.py -> src/flask/sansio/app.py',
    'tests/test_basic.py -> src/flask/__init__.py',
    'tests/test_basic.py -> src/flask/json/__init__.py',
    'tests/test_basic.py -> src/flask/sessions.py',
  ]);
  assert.deepEqual(edges(graph, 'extends'), ['src/flask/app.py#Flask -> src/flask/sansio/app.py#App']);
  assert.deepEqual(edges(graph, 'calls'), [
    'src/flask/app.py#Flask.run -> src/flask/app.py#Flask.make_response',
    'tests/test_basic.py#test_run -> src/flask/app.py#Flask',
    'tests/test_basic.py#test_run -> src/flask/app.py#Flask.run',
    'tests/test_basic.py#test_run -> src/flask/json/__init__.py#jsonify',
    'tests/test_basic.py#test_run -> src/flask/sessions.py#SessionInterface',
  ]);
  // Nothing was guessed: every edge came through a binding the file wrote.
  assert.equal(graph.edges.some((edge) => edge.guessed === true), false);
});

test('a star import in a package hands on what the module declares, and an underscore name is imported like any other', () => {
  // flask's app.py: `from .helpers import _CollectErrors`, then `_CollectErrors()`.
  const graph = graphOf(
    parsedFile('pkg/__init__.py', 'from .core import *\n'),
    parsedFile('pkg/core.py', 'def public(): ...\ndef _private(): ...\n'),
    parsedFile('pkg/app.py', 'from .core import _private\n\ndef run():\n    _private()\n'),
    parsedFile('use.py', 'from pkg import public\n\ndef go():\n    public()\n'),
  );
  assert.deepEqual(edges(graph, 'calls'), ['pkg/app.py#run -> pkg/core.py#_private', 'use.py#go -> pkg/core.py#public']);
});

test('an overload signature is not a second function', () => {
  const { symbols } = parse(`
    import typing as t

    class Config:
        @t.overload
        def get(self, key: str) -> str: ...
        @t.overload
        def get(self, key: str, default: int) -> int: ...
        def get(self, key, default=None):
            return default

    @t.overload
    def only(x: int) -> int: ...
    @t.overload
    def only(x: str) -> str: ...
  `);
  // A symbol's range starts at its first decorator, which is where a reader
  // finds it; the kept `only` is the first signature, decorator included.
  assert.deepEqual(
    symbols.map((symbol) => `${symbol.name}:${symbol.startLine}`),
    ['Config:4', 'get:9', 'only:12'],
  );
});

test('a definition under if, try or with is the module\'s, and a syntax error is reported not hidden', () => {
  const { symbols } = parse(`
    try:
        from fast import parse
    except ImportError:
        def parse(s): ...

    if TYPE_CHECKING:
        class Shape: ...

    with lock:
        def guarded(): ...
  `);
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['parse', 'Shape', 'guarded']);
});

test('the module name is the path, once the caller says what it is', () => {
  assert.equal(parse('x = 1\n').moduleName, undefined);
  assert.equal(parse('x = 1\n', 'pkg/sub/mod.py').moduleName, 'pkg.sub.mod');
  assert.equal(parse('x = 1\n', 'pkg/__init__.py').moduleName, 'pkg');
  assert.equal(parse('x = 1\n', 'src/flask/app.py').moduleName, 'flask.app');
  assert.equal(parse('x = 1\n', 'main.py').moduleName, 'main');
});

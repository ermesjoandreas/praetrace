import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedSymbol } from '../parser/types.js';
import { javascript } from './javascript.js';

const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(javascript.grammar('a.js') as Parser.Language);
  return javascript.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name);
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

test('the API a CommonJS module defines by assignment is its symbols', () => {
  const { symbols } = parse(`
    var app = exports = module.exports = {};

    app.init = function init() {
      this.defaultConfiguration();
    };

    app.handle = function handle(req, res, callback) {};
    exports.compileETag = (val) => val;
    module.exports.merge = function (a, b) {};
    res.send = function send(body) {};

    defineGetter(req, 'protocol', function protocol() {
      return this.get('X-Forwarded-Proto');
    });

    app.count = 1;
    app[method] = function () {};
    methods.forEach(function (method) { app[method] = function () {}; });
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine]),
    [
      ['app.init', 'function', 4, 6],
      ['app.handle', 'function', 8, 8],
      ['exports.compileETag', 'function', 9, 9],
      ['module.exports.merge', 'function', 10, 10],
      ['res.send', 'function', 11, 11],
      ['req.protocol', 'function', 13, 15],
      // Computed both of them, and named as written rather than invented: the
      // second is express's verb loop, which defines app.get and app.post.
      ['app[method]', 'function', 18, 18],
      ['app[method]', 'function', 19, 19],
    ],
  );
  // `this` in a plain function is not a class, so the call names nothing:
  // a bare `defaultConfiguration` could only land on a top-level function of
  // that name, which `this.defaultConfiguration()` never calls.
  assert.deepEqual(byName(symbols, 'app.init').calls, []);
  assert.deepEqual(byName(symbols, 'req.protocol').calls, []);
});

test('re-exports are recorded in JavaScript too', () => {
  const { imports, reexports } = parse(`
    export * from './a.js'
    export { A as B, default as C } from './b.js'
  `);
  assert.deepEqual(imports, ['./a.js', './b.js']);
  assert.deepEqual(reexports, [
    { specifier: './a.js', names: '*' },
    {
      specifier: './b.js',
      names: [
        { exported: 'B', local: 'A' },
        { exported: 'C', local: 'default' },
      ],
    },
  ]);
});

test('with no types to read, a receiver is known only through this and new', () => {
  const { symbols } = parse(`
    const shared = new Registry()
    class Router {
      #stack = []
      constructor() {
        this.store = new Store()
      }
      #next() {}
      handle(req) {
        this.#next()
        this.store.add()
        this.#stack.push()
        req.get()
        shared.lookup()
        const view = new View()
        view.render()
      }
    }
  `);
  assert.deepEqual(byName(symbols, 'constructor').calls, ['Store']);
  assert.deepEqual(byName(symbols, 'handle').calls, [
    'Router.#next',
    'Store.add',
    // An array literal names no class, and `req` has no type: neither says anything.
    'Registry.lookup',
    'View.render',
    'View',
  ]);
});

test('require binds names the way import does, and exports.x is an export', () => {
  const parsed = parse(`
    const { a, b: c } = require('x')
    const y = require('y')
    var debug = require('debug')('app')
    import d from './d.js'
    function local() {}
    exports.compileETag = function () {}
    module.exports.merge = () => {}
    function f() {
      const q = require('q')
      y.go()
      q.run()
      a()
      compileETag()
    }
  `);
  assert.deepEqual(parsed.bindings, [
    { local: 'd', specifier: './d.js', imported: 'default' },
    { local: 'a', specifier: 'x', imported: 'a' },
    { local: 'c', specifier: 'x', imported: 'b' },
    { local: 'y', specifier: 'y', imported: '*' },
    { local: 'q', specifier: 'q', imported: '*' },
  ]);
  assert.deepEqual(
    parsed.symbols.map((s) => [s.name, s.exported]),
    [
      ['local', false],
      ['exports.compileETag', true],
      ['module.exports.merge', true],
      ['f', false],
    ],
  );
  // The whole-module bindings name themselves; `q` is one even inside f.
  assert.deepEqual(byName(parsed.symbols, 'f').calls, ['require', 'y.go', 'q.run', 'a', 'compileETag']);
  assert.equal(parsed.defaultExport, undefined);
});

test('module.exports = is the default export, named either way it is written', () => {
  assert.equal(parse('function createApplication() {}\nexports = module.exports = createApplication').defaultExport, 'createApplication');
  const assigned = parse('module.exports = function () {}');
  assert.equal(assigned.defaultExport, 'module.exports');
  assert.deepEqual(assigned.symbols.map((s) => [s.name, s.exported]), [['module.exports', false]]);
});

test('this inside a nested function is not the class in JavaScript either', () => {
  const { symbols } = parse(`
    class Widget {
      render() {}
      attach(el) {
        el.addEventListener('click', function () { this.render() })
        el.addEventListener('keydown', () => this.render())
      }
    }
  `);
  assert.deepEqual(byName(symbols, 'attach').calls, ['Widget.render']);
});

test('a superclass named through a namespace import keeps its qualifier', () => {
  const { symbols } = parse(`
    import { Base } from './base1.js'
    import * as ns from './base2.js'
    export class A extends ns.Base {}
    export class B extends mixin(Base) {}
  `);
  assert.deepEqual(byName(symbols, 'A').extends, ['ns.Base']);
  assert.deepEqual(byName(symbols, 'B').extends, []);
});

test('what a CommonJS module runs at load is the file’s own call list', () => {
  const parsed = parse(`
    var express = require('./express');
    var path = require('path');

    var app = express();
    app.set('views', path.join(__dirname, 'views'));
    app.listen(3000, function () { ready(); });

    app.handle = function handle(req, res) { inside(); };

    function unused() { never(); }
  `);
  // `app` is what `express()` returned, which is not a written type, so
  // `app.set()` and `app.listen()` name nothing — the same rule a receiver
  // inside a symbol gets. `path` is a required module and names itself.
  assert.deepEqual(parsed.calls, ['require', 'express', 'path.join', 'ready']);
  assert.deepEqual(byName(parsed.symbols, 'app.handle').calls, ['inside']);
  assert.deepEqual(byName(parsed.symbols, 'unused').calls, ['never']);
});

test('an exported const bound to a value is a symbol in JavaScript too', () => {
  // The same line TypeScript draws, and the same reason: the expression says
  // nothing about what it made, so the name is the whole claim and only an
  // exported one is a name another file can write down.
  const parsed = parse(`
    export const client = makeClient();
    const internal = makeInternal();
  `);
  assert.deepEqual(
    parsed.symbols.map((s) => [s.name, s.kind, s.exported]),
    [['client', 'field', true]],
  );
  assert.deepEqual(byName(parsed.symbols, 'client').calls, ['makeClient']);
  assert.deepEqual(parsed.calls, ['makeInternal']);
});

test('a value assigned to exports is a symbol; one assigned to a local object is not', () => {
  // express lib/express.js, whole. It headed itself "1 symbol" and hid ten of
  // the eleven things anyone opens express to find — searching "static"
  // returned nothing — because only a literal function counted. `app.count`
  // stays out for the reason it always did: it is a property of an object
  // local to the module, and no other file can write that name down.
  const parsed = parse(`
    var bodyParser = require('body-parser')
    var proto = require('./application');
    var Router = require('router');

    exports = module.exports = createApplication;

    function createApplication() {}

    exports.application = proto;
    exports.Route = Router.Route;
    exports.Router = Router;
    exports.json = bodyParser.json
    exports.static = require('serve-static');

    app.count = 1;
  `);
  assert.deepEqual(
    parsed.symbols.map((s) => [s.name, s.kind, s.exported]),
    [
      ['createApplication', 'function', false],
      ['exports.application', 'field', true],
      ['exports.Route', 'field', true],
      ['exports.Router', 'field', true],
      ['exports.json', 'field', true],
      ['exports.static', 'field', true],
    ],
  );
  // `module.exports = createApplication` names no property. What it assigns is
  // the default export, under the name the function really has, and a second
  // node called `module.exports` would be the same function counted twice.
  assert.equal(parsed.defaultExport, 'createApplication');
});

test('a var that rebinds a required name is not that module', () => {
  // express lib/application.js: `var View = this.get('view')` shadows the View
  // the file requires, and `new View(...)` was drawn as a call into lib/view.js
  // — one of the three edges the TypeScript checker called a lie.
  const parsed = parse(`
    var View = require('./view');

    app.render = function render(name, options, callback) {
      var View = this.get('view');
      var view = new View(name, {});
      return view.render();
    };

    app.plain = function plain(name) {
      return new View(name, {});
    };
  `);
  assert.deepEqual(byName(parsed.symbols, 'app.render').calls, []);
  assert.deepEqual(byName(parsed.symbols, 'app.plain').calls, ['View']);
});

test('every target of a chained assignment is a name the file defines', () => {
  // express writes six of its methods this way — `res.set =` newline
  // `res.header = function header(…)` — and none of them survived, so res.type
  // and res.set were missing from a box that gave a count as though it were
  // complete, while res.send calls both of them.
  const { symbols } = parse(`
res.contentType =
res.type = function contentType(type) {
  return this.set('Content-Type', type);
};

exports.a = exports.b = exports.c = () => run();

res.count = res.total = 1;
  `);
  // Each later target is marked as another name for the first, so that what
  // counts them counts the body once: express's response.js has 24 of these
  // and 22 functions, and a header reading 24 was wrong in the direction that
  // looks complete. The first name is the primary because it is the one the
  // source leads with — `function contentType` matches the first here and
  // `function header` matches the second in `res.set = res.header =`, so the
  // inner name settles nothing.
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine, s.aliasOf ?? '-']),
    [
      ['res.contentType', 'function', 2, 5, '-'],
      ['res.type', 'function', 2, 5, 'res.contentType'],
      ['exports.a', 'function', 7, 7, '-'],
      ['exports.b', 'function', 7, 7, 'exports.a'],
      ['exports.c', 'function', 7, 7, 'exports.a'],
    ],
  );
  // Each alias is another way in to one body, so each carries its calls.
  for (const name of ['exports.a', 'exports.b', 'exports.c']) {
    assert.deepEqual(byName(symbols, name).calls, ['run']);
  }
});

test('a function installed under a computed name is named as the source wrote it', () => {
  // express lib/application.js: app.get, app.post, app.put and app.delete are
  // all written here, and the file used to draw none of them.
  const { symbols, calls } = parse(`
methods.forEach(function (method) {
  app[method] = function (path) {
    return route(path);
  };
});
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine]),
    [['app[method]', 'function', 3, 5]],
  );
  assert.deepEqual(byName(symbols, 'app[method]').calls, ['route']);
  // The forEach still runs at load and is still the file's; only the function
  // it installs belongs to the symbol.
  assert.deepEqual(calls, []);
});

test('an exported object literal is a symbol, and so are its members', () => {
  const { symbols } = parse(`
export const environmentManager = {
  isServer,
  setIsServer(value) {
    isServerFn = value;
  },
  reset: () => reset(),
};

const internal = { hidden() {} };
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.owner ?? '-', s.startLine, s.endLine]),
    [
      ['environmentManager', 'class', '-', 2, 8],
      ['isServer', 'field', 'environmentManager', 3, 3],
      ['setIsServer', 'method', 'environmentManager', 4, 6],
      ['reset', 'method', 'environmentManager', 7, 7],
    ],
  );
  assert.equal(byName(symbols, 'environmentManager').exported, true);
  assert.deepEqual(byName(symbols, 'reset').calls, ['reset']);
});

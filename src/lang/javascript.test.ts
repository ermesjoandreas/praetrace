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

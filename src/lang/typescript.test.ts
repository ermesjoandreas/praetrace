import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedSymbol } from '../parser/types.js';
import { typescript } from './typescript.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string, filePath = 'a.ts') {
  const parser = new TreeSitter();
  parser.setLanguage(typescript.grammar(filePath) as Parser.Language);
  return typescript.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name);
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

test('ES private members are fields and methods, private by syntax', () => {
  const { symbols } = parse(`
    class Observer {
      #count = 0
      #client: Client
      #tick() { this.#count += 1 }
      run() { this.#tick() }
    }
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.visibility ?? '-']),
    [
      ['Observer', 'class', '-'],
      ['#count', 'field', 'private'],
      ['#client', 'field', 'private'],
      ['#tick', 'method', 'private'],
      ['run', 'method', '-'],
    ],
  );
  assert.deepEqual(byName(symbols, 'run').calls, ['Observer.#tick']);
});

test('re-exports are recorded with the names that travel through them', () => {
  const parse1 = parse(`
    export * from './a'
    export { A, B as C, type D } from './b'
    export * as ns from './c'
    export { E }
    export const F = 1
  `);
  assert.deepEqual(parse1.imports, ['./a', './b', './c']);
  assert.deepEqual(parse1.reexports, [
    { specifier: './a', names: '*' },
    {
      specifier: './b',
      names: [
        { exported: 'A', local: 'A' },
        { exported: 'C', local: 'B' },
        { exported: 'D', local: 'D' },
      ],
    },
    { specifier: './c', names: [{ exported: 'ns', local: '*' }] },
  ]);
});

test('a function assigned to a property is a symbol named as written', () => {
  const { symbols } = parse(`
    app.init = function init() {
      configure()
    }
    Foo.prototype.bar = () => 1
    app.count = 1
    app[name] = function () {}
  `);
  // A computed name is a symbol too, spelt the way the source spells it: the
  // alternative to `app[name]` was silence, and silence is what let a box head
  // itself "18 symbols" with express's four busiest methods missing.
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.startLine, s.endLine]),
    [
      ['app.init', 'function', 2, 4],
      ['Foo.prototype.bar', 'function', 5, 5],
      ['app[name]', 'function', 7, 7],
    ],
  );
  assert.deepEqual(byName(symbols, 'app.init').calls, ['configure']);
});

test('a call through this is a call on the enclosing class', () => {
  const { symbols } = parse(`
    class Store {
      add() {}
      addAll() { this.add(); this.missing() }
    }
  `);
  assert.deepEqual(byName(symbols, 'addAll').calls, ['Store.add', 'Store.missing']);
});

test('a call through a receiver with a written type is qualified by it', () => {
  const { symbols } = parse(`
    class Cache {
      private log: Logger
      timer: Timer | null = null
      pool = new Pool()
      constructor(private repo: Repo, other: Other) {
        this.log.info()
      }
      run(s: Store, maybe?: Thing, xs: Store[], untyped) {
        s.add()
        maybe.poke()
        xs.map()
        untyped.go()
        this.repo.save()
        this.timer.stop()
        this.pool.drain()
        const built = new Builder()
        built.build()
        const t: Thing = make()
        t.x()
        other.z()
      }
    }
  `);
  assert.deepEqual(byName(symbols, 'constructor').calls, ['Logger.info']);
  assert.deepEqual(byName(symbols, 'run').calls, [
    'Store.add',
    'Thing.poke',
    // An array's methods are the array's, not the element type's, and an
    // untyped receiver's are nobody's: neither `xs.map()` nor `untyped.go()`
    // names anything.
    'Repo.save',
    'Timer.stop',
    'Pool.drain',
    'Builder.build',
    'make',
    'Thing.x',
    // `other` is the constructor's parameter, not this method's, so `other.z()`
    // has no receiver here and says nothing.
    'Builder',
  ]);
});

test('a name bound in a nested callback means that only inside the callback', () => {
  const { symbols } = parse(`
    function f(a: A) {
      a.run()
      items.forEach((a: B) => a.run())
      a.stop()
    }
  `);
  assert.deepEqual(byName(symbols, 'f').calls, ['A.run', 'B.run', 'A.stop']);
});

test('two bindings of one name in one scope that disagree are not guessed between', () => {
  const { symbols } = parse(`
    function f() {
      var a = new A()
      var a = new B()
      a.run()
    }
    function g(b: B) {
      { const b = new C(); b.run() }
      b.stop()
    }
  `);
  assert.deepEqual(byName(symbols, 'f').calls, ['A', 'B']);
  // A block's `const` is that block's; the parameter is what the name means outside it.
  assert.deepEqual(byName(symbols, 'g').calls, ['C.run', 'B.stop', 'C']);
});

test('a typed parameter of a callback does not describe the import it shadows', () => {
  const { symbols } = parse(`
    import { store } from './store'
    function f(items: Item[]) {
      items.forEach((store: Cache) => store.get())
      store.add()
    }
  `);
  // The import names itself: the graph is what knows what `store` is.
  assert.deepEqual(byName(symbols, 'f').calls, ['Cache.get', 'store.add']);
});

test('this inside a nested function is not the class', () => {
  const { symbols } = parse(`
    class Widget {
      render() {}
      attach(el: Element) {
        el.addEventListener('click', function () { this.render() })
        el.addEventListener('keydown', () => this.render())
        const helpers = { draw() { this.render() } }
        this.render()
      }
    }
  `);
  assert.deepEqual(byName(symbols, 'attach').calls, ['Element.addEventListener', 'Widget.render']);
});

test('a call through an untyped receiver names nothing, not the top-level name it shares', () => {
  // The two survivors after bindings: zod's `values.map()` inside the file
  // that declares `map`, and express's `JSON.stringify()` beside `stringify`.
  const { symbols } = parse(`
    export function map() {}
    export function stringify() {}
    export function _enum(values) { return values.map((v) => v) }
    export function send(obj) { return JSON.stringify(obj) }
    export function drain(self) { return this.flush(), super.flush() }
  `);
  assert.deepEqual(byName(symbols, '_enum').calls, []);
  assert.deepEqual(byName(symbols, 'send').calls, []);
  assert.deepEqual(byName(symbols, 'drain').calls, []);
});

test('a call through an import is qualified by the name the file bound', () => {
  const { symbols } = parse(`
    import * as ns from './ns'
    import { Store as S } from './store'
    import Client from './client'
    import { helper } from './helper'
    function f() {
      ns.helper()
      S.create()
      Client.connect()
      helper()
      helper.call(null)
      const x = new ns.Remote()
      x.ping()
    }
    function g(ns: Local) { ns.helper() }
  `);
  assert.deepEqual(byName(symbols, 'f').calls, [
    'ns.helper',
    'S.create',
    'Client.connect',
    'helper',
    'helper.call',
    // `x` was constructed as `ns.Remote`, qualifier and all: the graph resolves
    // the head through the binding, and a bare `Remote` would land on whatever
    // Remote the file bound directly.
    'ns.Remote.ping',
    'ns.Remote',
  ]);
  // A parameter shadows the import, and its written type is what counts.
  assert.deepEqual(byName(symbols, 'g').calls, ['Local.helper']);
});

test('a module-level binding types the receiver in every function below it', () => {
  const { symbols } = parse(`
    const store = new Store()
    export const client: Client = create()
    function save() { store.add(); client.send() }
    const load = () => { const store = new Cache(); store.get() }
  `);
  assert.deepEqual(byName(symbols, 'save').calls, ['Store.add', 'Client.send']);
  // The local binding shadows the module's.
  assert.deepEqual(byName(symbols, 'load').calls, ['Cache.get', 'Cache']);
});

test('an untyped name shadows the typed one it hides, and is not guessed from it', () => {
  const { symbols } = parse(`
    const store = new Store()
    function f(store) { store.add() }
    function g({ store }) { store.add() }
    const h = (store) => store.add()
    function i() { const store = make(); store.add() }
    function j(store = fallback()) { store.add() }
    function k() { store.add() }
  `);
  for (const name of ['f', 'g', 'h', 'i', 'j']) {
    assert.ok(!byName(symbols, name).calls.includes('Store.add'), `${name} guessed through a shadowing name`);
    assert.ok(!byName(symbols, name).calls.includes('add'), `${name} reported a bare tail`);
  }
  assert.deepEqual(byName(symbols, 'k').calls, ['Store.add']);
});

test('a class-level call outside any method is qualified by the class scope too', () => {
  const { symbols } = parse(`
    const helper = new Helper()
    class Widget {
      value = helper.compute()
      static { helper.init() }
    }
  `);
  assert.deepEqual(byName(symbols, 'value').calls, ['Helper.compute']);
  // The class claims its field initialisers as well as its static block; only
  // method bodies are excluded from it, which is how it was before this.
  assert.deepEqual(byName(symbols, 'Widget').calls, ['Helper.compute', 'Helper.init']);
});

test('every import form is recorded as the names it binds', () => {
  const { imports, bindings } = parse(`
    import d, { a, b as c, type T } from 'x'
    import * as ns from 'y'
    import type { U } from 'z'
    import e = require('w')
    import 'side-effect'
  `);
  assert.deepEqual(imports, ['x', 'y', 'z', 'w', 'side-effect']);
  assert.deepEqual(bindings, [
    { local: 'd', specifier: 'x', imported: 'default' },
    { local: 'a', specifier: 'x', imported: 'a' },
    { local: 'c', specifier: 'x', imported: 'b' },
    { local: 'T', specifier: 'x', imported: 'T' },
    { local: 'ns', specifier: 'y', imported: '*' },
    { local: 'U', specifier: 'z', imported: 'U' },
    { local: 'e', specifier: 'w', imported: '*' },
  ]);
});

test('a symbol is exported only under its own name, and the default is named apart', () => {
  const parsed = parse(`
    function secret() {}
    export function pub() {}
    export const arrow = () => {}
    export abstract class Base {}
    export interface Shape {}
    export type Alias = string
    export enum Mode {}
    export declare function ambient(): void
    declare function hidden(): void
    class Late {}
    class Aliased {}
    export { Late, Aliased as Other }
    export default class Main { run() {} }
    export namespace NS { export function inner() {} }
  `);
  assert.deepEqual(
    parsed.symbols.filter((s) => s.owner === undefined).map((s) => [s.name, s.exported]),
    [
      ['secret', false],
      ['pub', true],
      ['arrow', true],
      ['Base', true],
      ['Shape', true],
      ['Alias', true],
      ['Mode', true],
      ['ambient', true],
      ['hidden', false],
      ['Late', true],
      ['Aliased', false],
      ['Main', false],
      ['NS', true],
      // Exported from the namespace, not from the file.
      ['inner', false],
    ],
  );
  assert.equal(parsed.defaultExport, 'Main');
  // A member is reached through its owner and never by name.
  assert.equal(byName(parsed.symbols, 'run').exported, undefined);
});

test('the default export is named whichever way it is written', () => {
  assert.equal(parse('function f() {}\nexport default f').defaultExport, 'f');
  assert.equal(parse('function f() {}\nexport { f as default }').defaultExport, 'f');
  assert.equal(parse('function f() {}\nexport = f').defaultExport, 'f');
  assert.equal(parse('export default function () {}').defaultExport, undefined);
  assert.equal(parse('export function f() {}').defaultExport, undefined);
});

test('a barrel cannot carry what its source never exported', () => {
  // The fixture from the review: b.ts must not reach a.ts#secret through the
  // barrel. The parser's half is the flag; the store's half reads it.
  const a = parse('function secret() {}\nexport function pub() {}');
  assert.deepEqual(a.symbols.map((s) => [s.name, s.exported]), [['secret', false], ['pub', true]]);
  const index = parse("export * from './a'");
  assert.deepEqual(index.reexports, [{ specifier: './a', names: '*' }]);
  const b = parse("import * as ns from './index'\nexport function f() { ns.secret(); ns.pub() }");
  assert.deepEqual(b.bindings, [{ local: 'ns', specifier: './index', imported: '*' }]);
  assert.deepEqual(byName(b.symbols, 'f').calls, ['ns.secret', 'ns.pub']);
});

test('a heritage named through a namespace import keeps its qualifier', () => {
  // base1 and base2 both export a Base; the first is bound directly and the
  // second through `ns`. `extends ns.Base` used to be emitted as bare `Base`,
  // which landed on base1 — the one file the class does not extend.
  const { symbols } = parse(`
    import { Base } from './base1'
    import * as ns from './base2'
    export class A extends ns.Base {}
    export class B extends ns.Base<T> implements ns.I, a.b.J {}
    export interface I extends ns.J<T>, K {}
    export class C extends mixin(Base) {}
    export class D extends make().Base {}
  `);
  assert.deepEqual(byName(symbols, 'A').extends, ['ns.Base']);
  assert.deepEqual(byName(symbols, 'B').extends, ['ns.Base']);
  assert.deepEqual(byName(symbols, 'B').implements, ['ns.I', 'a.b.J']);
  assert.deepEqual(byName(symbols, 'I').extends, ['ns.J', 'K']);
  // A call names no class, and neither does a property of what a call returned.
  assert.deepEqual(byName(symbols, 'C').extends, []);
  assert.deepEqual(byName(symbols, 'D').extends, []);
});

test('a receiver typed through a namespace import keeps its qualifier in every call', () => {
  // t1 and t2 both export a Thing. `new ns.Thing()` typed x as bare `Thing`,
  // so `x.run()` landed on t1's while the `new` itself landed on t2's.
  const { symbols } = parse(`
    import { Thing } from './t1'
    import * as ns from './t2'
    export function f() { const x = new ns.Thing(); x.run() }
    export function g(y: ns.Thing) { y.go() }
    export class C {
      private t: ns.Thing
      list: ns.Thing[]
      run() { this.t.poke(); const z = new this.Ctor(); z.go() }
    }
  `);
  assert.deepEqual(byName(symbols, 'f').calls, ['ns.Thing.run', 'ns.Thing']);
  assert.deepEqual(byName(symbols, 'g').calls, ['ns.Thing.go']);
  // `new this.Ctor()` is a call through `this`, as any is; but it names no
  // class a reference could match, so z has no type and `z.go()` says nothing.
  assert.deepEqual(byName(symbols, 'run').calls, ['ns.Thing.poke', 'C.Ctor']);
  assert.equal(byName(symbols, 't').typeName, 'ns.Thing');
  assert.deepEqual(byName(symbols, 'list'), { ...byName(symbols, 'list'), typeName: 'ns.Thing', many: true });
});

test('a loop head and a catch parameter are locals that hide the typed name they shadow', () => {
  const { symbols } = parse(`
    import { Store, Cache } from './store'
    const store = new Store()
    export function f(caches: Cache[]) { for (const store of caches) store.get(); store.put() }
    export function g(o: Record<string, Cache>) { for (const store in o) store.get() }
    export function h(pairs: [string, Cache][]) { for (const [, store] of pairs) store.get() }
    export function i(xs: Cache[]) { for (store of xs) store.get() }
    export function c(x: unknown) {
      try { throw x } catch (store) { store.get() }
      try { throw x } catch ({ store }) { store.get() }
      try { throw x } catch (store: unknown) { store.get() }
      store.get()
    }
  `);
  // The loop variable is the loop's; after it the name is the module's again.
  assert.deepEqual(byName(symbols, 'f').calls, ['Store.put']);
  assert.deepEqual(byName(symbols, 'g').calls, []);
  assert.deepEqual(byName(symbols, 'h').calls, []);
  assert.deepEqual(byName(symbols, 'i').calls, []);
  assert.deepEqual(byName(symbols, 'c').calls, ['Store.get']);
});

test('a type parameter is not a written class type', () => {
  // `Box<Item>` beside `import { Item }`: every `: Item` inside the class is
  // the parameter, which stands for whatever the caller supplies. The value
  // `Item` is still the import — TypeScript keeps the two namespaces apart.
  const { symbols } = parse(`
    import { Item } from './item'
    export class Box<Item> {
      item!: Item
      items: Item[] = []
      more: Array<Item>
      constructor(private first: Item) {}
      run() { this.item.go(); this.first.go(); Item.create() }
      every<Key>(k: Key, i: Item) { k.go(); i.go() }
    }
    export function each<Item>(x: Item) { x.go?.() }
    export const map = <Item,>(x: Item) => x.go()
    export function outer(x: Item) { const inner = <Item,>(y: Item) => y.go(); x.go() }
    export interface Shape<Item> { item: Item }
  `);
  const item = byName(symbols, 'item');
  assert.equal(item.typeName, undefined);
  assert.deepEqual(byName(symbols, 'items'), { ...byName(symbols, 'items'), many: true });
  assert.equal(byName(symbols, 'items').typeName, undefined);
  assert.equal(byName(symbols, 'more').typeName, undefined);
  assert.deepEqual(byName(symbols, 'run').calls, ['Item.create']);
  assert.deepEqual(byName(symbols, 'every').calls, []);
  assert.deepEqual(byName(symbols, 'each').calls, []);
  assert.deepEqual(byName(symbols, 'map').calls, []);
  // A `<T>` is in force in the function that declares it, not around it.
  assert.deepEqual(byName(symbols, 'outer').calls, ['Item.go']);
  assert.equal(symbols.find((s) => s.owner === 'Shape' && s.name === 'item')?.typeName, undefined);
});

test('an exported const bound to a value is a symbol, and an unexported one is not', () => {
  // zod's public API is written this way and none of it was drawn: `export
  // const parse: $Parse = _parse(errors.$ZodRealError)` left the file holding a
  // call to `_parse` and no node an importer could land on. 330 declarations of
  // it in zod, against 645 unexported ones that are locals and stay locals.
  //
  // A call is not the only expression that binds a name. TanStack/query's
  // utils.ts headed a box "41 symbols" without `isServer`, which is written
  // `typeof window === 'undefined'` — a complete-looking list missing the name
  // the file is opened for.
  const parsed = parse(`
    export const parse: $Parse = _parse(realError)
    export const answer = 6 * 7
    const helper = makeHelper()
    const late = makeLate()
    export { late }
    const quiet = makeQuiet()
  `);
  assert.deepEqual(
    parsed.symbols.map((s) => [s.name, s.kind, s.exported]),
    [
      ['parse', 'field', true],
      ['answer', 'field', true],
      ['late', 'field', true],
    ],
  );
  // What the factory was called on belongs to the name it produced, not to the
  // module; what the unexported ones call still runs at load and is the file's.
  assert.deepEqual(byName(parsed.symbols, 'parse').calls, ['_parse']);
  assert.deepEqual(byName(parsed.symbols, 'late').calls, ['makeLate']);
  assert.deepEqual(parsed.calls, ['makeHelper', 'makeQuiet']);
});

test('a const bound to a call is not called a function, because the call did not say', () => {
  // `export const dataTagSymbol = Symbol()` was reported kind 'function', which
  // is a claim and not a gap — four of them in TanStack/query. It is the same
  // syntax as zod's `$constructor(…)` factories and the source tells them
  // apart nowhere, so the honest reading is the one that says "a value the
  // module holds" for both and lets the graph draw what calls it.
  const { symbols } = parse(`
    export const dataTagSymbol = Symbol()
    export const ZodError = $constructor('ZodError', init)
    export const run = () => go()
    export const build = function () { return go() }
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind]),
    [
      ['dataTagSymbol', 'field'],
      ['ZodError', 'field'],
      ['run', 'function'],
      ['build', 'function'],
    ],
  );
});

test('a name merged as an interface and an exported const yields both symbols', () => {
  // TypeScript's declaration merging, and zod writes its schemas with it:
  // `export interface ZodError` beside `export const ZodError = $constructor(…)`
  // is one name for a type and a value. Before the const was read, the file
  // declared only the type half, so a `new ZodError()` anywhere had nothing
  // callable to land on — 374 of zod's calls edges end on a name whose file
  // declares a function of it, and all 374 now have one.
  const { symbols } = parse(`
    export interface ZodError { issues: Issue[] }
    export const ZodError = $constructor('ZodError', init)
  `);
  // The const half is a field — the source bound a name to what a call
  // returned and said nothing more — and that is still something a call can
  // land on: the store refuses only `interface` and `type` as the end of one.
  assert.deepEqual(
    symbols.filter((s) => s.owner === undefined).map((s) => [s.name, s.kind]),
    [
      ['ZodError', 'interface'],
      ['ZodError', 'field'],
    ],
  );
});

test('a call written outside every symbol is the file’s own', () => {
  const parsed = parse(`
    import * as z from './z'
    import { Store } from './store'
    import { register } from './registry'

    register(new Store())
    const schema = z.date().min(1)
    const build = () => make()
    export const started = boot()
    ;(function () { warm() })()

    export class Runner {
      go() { inside() }
    }
    export function run() { alsoInside() }
  `);
  // A `const` whose value is a function is already a symbol, and so is an
  // exported one bound to a call; both keep their own calls. Everything else at
  // the top level runs when the module loads.
  assert.deepEqual(parsed.calls, ['register', 'Store', 'z.date', 'warm']);
  assert.deepEqual(byName(parsed.symbols, 'build').calls, ['make']);
  assert.deepEqual(byName(parsed.symbols, 'started').calls, ['boot']);
  assert.deepEqual(byName(parsed.symbols, 'go').calls, ['inside']);
  assert.deepEqual(byName(parsed.symbols, 'run').calls, ['alsoInside']);
});

test('a decorator on an exported class is the file’s call, and on a plain one the class’s', () => {
  // The grammar puts a decorator inside the class it decorates — except when
  // the class is exported, where it sits beside it under the `export`. Skipping
  // the statement because the class was already a symbol lost it entirely.
  const exported = parse(`
    @Injectable({ useFactory: make() })
    export class Service {}
  `);
  assert.deepEqual(exported.calls, ['Injectable', 'make']);

  const plain = parse(`
    @Other()
    class Plain {}
  `);
  assert.deepEqual(plain.calls, []);
  assert.deepEqual(byName(plain.symbols, 'Plain').calls, ['Other']);
});

test('a parameter hides the class of the same name the file declares', () => {
  // zod's util.ts: `new Class(...)` inside a function taking a parameter called
  // Class was drawn as a call on the file's own `export abstract class Class`.
  // Two of the three edges the TypeScript checker called lies were this one.
  const { symbols } = parse(`
    export abstract class Class {
      constructor(..._args: any[]) {}
    }
    export function partial(Class, schema) {
      return new Class({ type: 'optional' })
    }
    export function required(Class: SchemaClass | null, schema) {
      return new Class({ type: 'nonoptional' })
    }
    export function unshadowed(schema) {
      return new Class({ type: 'optional' })
    }
  `);
  assert.deepEqual(byName(symbols, 'partial').calls, []);
  assert.deepEqual(byName(symbols, 'required').calls, []);
  assert.deepEqual(byName(symbols, 'unshadowed').calls, ['Class']);
});

test('a name a symbol declared itself is never the module’s', () => {
  const { symbols } = parse(`
    import { helper, View, Store } from './lib'
    export function outer() {
      function helper() {}
      helper()
      class Store {}
      new Store()
      { const View = pick(); new View() }
    }
    export function elsewhere() { helper(); new Store(); new View() }
    export function recurse(n: number) { return n > 0 ? recurse(n - 1) : 0 }
  `);
  assert.deepEqual(byName(symbols, 'outer').calls, ['pick']);
  assert.deepEqual(byName(symbols, 'elsewhere').calls, ['helper', 'Store', 'View']);
  // A symbol's own name is the module's, not a local: `recurse` is the file's.
  assert.deepEqual(byName(symbols, 'recurse').calls, ['recurse']);
});

test('a type is only the imported one while the name still means it', () => {
  // The lie one step on: `var view = new View(...)` under a rebound `View`
  // types view as the local, and `view.render()` was drawn on the import.
  const { symbols } = parse(`
    import { View } from './view'
    export function render() {
      const View = pick()
      const view = new View('name')
      view.draw()
    }
    export function honest() {
      const view = new View('name')
      view.draw()
    }
  `);
  assert.deepEqual(byName(symbols, 'render').calls, ['pick']);
  assert.deepEqual(byName(symbols, 'honest').calls, ['View.draw', 'View']);
});

test('a destructuring default is a value, not a binding', () => {
  // query's streamedQuery: every identifier in the pattern was read as a name
  // the function had bound, so the real call to the imported `addToEnd` read
  // as a call on something local and went missing.
  const { symbols } = parse(`
    import { addToEnd, seed } from './utils'
    export function streamed({ reducer = (items, chunk) => addToEnd(items, chunk), initial = seed() }) {
      return reducer(initial, 1)
    }
  `);
  assert.deepEqual(byName(symbols, 'streamed').calls, ['addToEnd', 'seed']);
});

test('a class declared in a namespace is the file’s symbol, not a name the namespace hid', () => {
  // The namespace's body is a statement_block, so the block-scoping rule above
  // read `Item` as a local and the one edge the box had went missing: the
  // graph gives every namespace member a node under the file, so a call beside
  // it is a call the graph can draw.
  const { symbols } = parse(`
    export namespace Bag {
      export class Item { use() { return helper() } }
      export const first = new Item()
    }
    declare global { class Glob {} }
    export function outside() { return new Glob() }
  `);
  assert.deepEqual(byName(symbols, 'Bag').calls, ['Item']);
  assert.deepEqual(byName(symbols, 'outside').calls, ['Glob']);
  // And a body that really is a scope still hides what it declares.
  const scoped = parse(`
    import { Item } from './bag'
    export function build() { class Item {}; return new Item() }
  `);
  assert.deepEqual(byName(scoped.symbols, 'build').calls, []);
});

test('an exported object literal is drawn as what it is: a name with members', () => {
  // query's environmentManager headed a box reading "3 symbols" that listed a
  // module-private helper and dropped the object 257 files import, because an
  // object bound to a name was no symbol at all. `as` and `satisfies` wrap it
  // without changing what it is — this module's own `export const typescript`
  // is written that way.
  const { symbols } = parse(`
export type IsServerValue = () => boolean

let isServerFn: IsServerValue = () => defaultIsServer

export const environmentManager = {
  isServer,
  version: read(),
  setIsServer(value: IsServerValue): void {
    isServerFn = value
  },
} satisfies Manager

const internal = { hidden() {} }
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind, s.owner ?? '-']),
    [
      ['IsServerValue', 'type', '-'],
      ['isServerFn', 'function', '-'],
      ['environmentManager', 'class', '-'],
      ['isServer', 'field', 'environmentManager'],
      ['version', 'field', 'environmentManager'],
      ['setIsServer', 'method', 'environmentManager'],
    ],
  );
  assert.equal(byName(symbols, 'environmentManager').exported, true);
  assert.deepEqual(byName(symbols, 'version').calls, ['read']);
});

test('a namespace is read once, so what it declares is not counted twice', () => {
  // A namespace at statement position is an expression_statement, and a
  // computed assignment is read through a whole statement — so the body was
  // read here and again when the packaging branch below descended into it.
  const { symbols } = parse(`
namespace Legacy {
  handlers[name] = function () { run() }
}
  `);
  assert.deepEqual(
    symbols.map((s) => [s.name, s.kind]),
    [
      ['Legacy', 'type'],
      ['handlers[name]', 'function'],
    ],
  );
});

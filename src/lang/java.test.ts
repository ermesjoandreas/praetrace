import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import { java } from './java.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(java.grammar('A.java') as Parser.Language);
  return java.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name);
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: 'java', lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source) };
}

/** The graph of a project, derived through the store with Java's own resolver. */
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

test('`this.m()` and a bare `m()` the class declares are its own operation', () => {
  const { symbols } = parse(`
    package p;
    public class Runner extends Base {
      public void run() { this.step(); step(); finish(); helper.go(); }
      private void step() {}
    }
  `);
  // `finish()` is not declared here, so it may be Base's; `helper` was never
  // given a type. Neither is guessed at.
  assert.deepEqual(byName(symbols, 'run').calls, ['Runner.step']);
});

test('a call on a receiver whose type was written down is that type\'s method', () => {
  const { symbols } = parse(`
    package p;
    import java.util.List;
    public class Runner<Node> {
      private Store store;
      private List<Item> items;
      private Node node;
      private Config[] configs;

      public void run(Config cfg, String s, Node other) {
        store.save();
        cfg.load();
        Item it = new Item();
        it.go();
        for (Item i : items) { i.go(); }
        items.forEach(x -> x.go());
        var v = new Item();
        v.tick();
        if (s instanceof Item p2) p2.pat();
        try (Reader r = open()) { r.read(); }
        catch (IOException | RuntimeException e) { e.printStackTrace(); }
        node.visit();
        other.visit();
        configs.clone();
        s.trim();
        Helper.stat();
      }
    }
  `);

  // A type parameter, `var`, an array, a lambda's inferred parameter and a
  // catch parameter are all bindings with no class written at them.
  assert.deepEqual(sorted(byName(symbols, 'run').calls), [
    'Config.load',
    'Helper',
    'Item',
    'Item.go',
    'Item.pat',
    'List.forEach',
    'Reader.read',
    'Store.save',
    'String.trim',
  ]);
});

test('a name declared twice is refused unless both declarations agree', () => {
  const { symbols } = parse(`
    package p;
    public class Runner {
      private Store store;
      void a() { Cache store = null; store.put(); }
      void b() { Store store = null; store.get(); }
    }
  `);
  assert.deepEqual(byName(symbols, 'a').calls, []);
  assert.deepEqual(byName(symbols, 'b').calls, ['Store.get']);
});

test('a record\'s components are typed fields, and a nested type reads its own body', () => {
  const { symbols } = parse(`
    package p;
    public record Pair(Left left, Right right) {
      public void swap() { left.flip(); right.flip(); }
      static class Inner {
        void go() { this.tick(); tick(); }
        void tick() {}
      }
    }
  `);
  assert.deepEqual(sorted(byName(symbols, 'swap').calls), ['Left.flip', 'Right.flip']);
  assert.deepEqual(byName(symbols, 'go').calls, ['Inner.tick']);
});

test('a call inside an anonymous or local class body is not the enclosing type\'s', () => {
  const { symbols } = parse(`
    package p;
    public class Outer {
      private Cache cache;
      private Runnable later = new Runnable() { public void run() { this.run(); run(); } };
      void run() {}
      void step() {}
      <T> void go(Store store, T item) {
        new Thread(new Runnable() {
          public void run() { this.run(); run(); cache.put(); store.save(); item.go(); Helper.stat(); }
        }).start();
        new Sorter() { public <U> int compare(Item a, U b) { a.go(); b.go(); return 0; } };
        class Local { void tick() { this.run(); run(); cache.put(); } }
        Runnable r = () -> { this.step(); step(); };
      }
    }
  `);
  // `this` inside `new Runnable() { … }` and inside Local is theirs, a bare
  // `run()` there is their own before it is Outer's, and a field of their own
  // or of a supertype would shadow `cache` — none of which is read, so none is
  // guessed. What the body declared itself, `Item a`, types a receiver, and so
  // does a parameter of the method it captures, `store`; a `<T>` or `<U>` from
  // either side never does. A lambda has no `this` of its own, and a receiver
  // named outright keeps.
  assert.deepEqual(sorted(byName(symbols, 'go').calls), [
    'Helper',
    'Item.go',
    'Outer.step',
    'Runnable',
    'Sorter',
    'Store.save',
    'Thread',
  ]);
  // The same body in a field's initialiser, whose calls the class keeps too.
  assert.deepEqual(byName(symbols, 'later').calls, ['Runnable']);
  assert.deepEqual(byName(symbols, 'Outer').calls, ['Runnable']);
});

test('a single-type import binds its simple name, and an unbound name binds to the packages it could come from', () => {
  const { imports, bindings } = parse(`
    package p;
    import q.Foo;
    import java.util.*;
    import static q.Foo.Streams.write;
    public class Bar extends Builder {
      void run(Foo foo) { Builder b = new Builder(); b.build(); Streams.write(); }
    }
  `);
  assert.deepEqual(sorted(imports), [
    'p.Builder|java.util.Builder',
    'p.Streams|java.util.Streams',
    'q.Foo',
    'q.Foo.Streams.write',
  ]);
  // The specifier is the same one `imports` carries, so the resolver answers
  // the binding exactly as it answers the import edge — the current package
  // first, then each on-demand import, and the first that holds the name.
  assert.deepEqual(
    [...(bindings ?? [])].sort((l, r) => (l.local < r.local ? -1 : 1)),
    [
      { local: 'Builder', specifier: 'p.Builder|java.util.Builder', imported: 'Builder' },
      { local: 'Foo', specifier: 'q.Foo', imported: 'Foo' },
      { local: 'Streams', specifier: 'p.Streams|java.util.Streams', imported: 'Streams' },
      { local: 'write', specifier: 'q.Foo.Streams.write', imported: 'write' },
    ],
  );
});

test('a same-package name never lands on a nested class of an imported type that shares it', () => {
  // q.Foo nests a Builder and a Streams; p declares top-level ones. Before
  // bindings all four references landed in Foo.java, because it was the first
  // imported file whose table held the names.
  const graph = graphOf(
    parsedFile(
      'q/Foo.java',
      `package q;
public class Foo {
  public static class Builder { public Foo build() { return new Foo(); } }
  public static class Streams { public static void write() {} }
}
`,
    ),
    parsedFile('p/Builder.java', 'package p;\npublic class Builder { public String build() { return ""; } }\n'),
    parsedFile('p/Streams.java', 'package p;\npublic class Streams { public static void write() {} }\n'),
    parsedFile(
      'p/Bar.java',
      `package p;
import q.Foo;
public class Bar extends Builder {
  void run(Foo foo) {
    Builder b = new Builder();
    b.build();
    Streams.write();
  }
}
`,
    ),
  );

  assert.deepEqual(
    edges(graph, 'calls').filter((edge) => edge.startsWith('p/Bar.java')),
    [
      'p/Bar.java#Bar.run -> p/Builder.java#Builder',
      'p/Bar.java#Bar.run -> p/Builder.java#Builder.build',
      'p/Bar.java#Bar.run -> p/Streams.java#Streams',
    ],
  );
  assert.deepEqual(edges(graph, 'extends'), ['p/Bar.java#Bar -> p/Builder.java#Builder']);
  // Bar does use Foo, and the import edge says so.
  assert.deepEqual(edges(graph, 'imports'), [
    'p/Bar.java -> p/Builder.java',
    'p/Bar.java -> p/Streams.java',
    'p/Bar.java -> q/Foo.java',
  ]);
});

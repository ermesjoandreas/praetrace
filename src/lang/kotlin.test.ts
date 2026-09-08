import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import { KOTLIN_ID, kotlin } from './kotlin.js';
import { languageById } from './registry.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(kotlin.grammar('A.kt') as Parser.Language);
  return kotlin.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name);
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: KOTLIN_ID, lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source) };
}

/** The graph of a project, derived through the store with Kotlin's own resolver. */
function graphOf(...files: ParsedFile[]): Graph {
  const store = createStore();
  applyBatch(store, files, []);
  return store.graph;
}

/**
 * A test of what the graph draws, which needs the store to be able to find this
 * language by the id its files carry.
 *
 * It is registered in `registry.ts`, which is another change's file — see
 * `KOTLIN_ID`. Until it is, the store resolves nothing for a Kotlin file and
 * these would fail for a reason that is not about Kotlin, so they say what they
 * are waiting for instead. They start running by themselves the moment the
 * entry lands, which is the point: a test that had to be re-enabled by hand
 * would quietly never be.
 */
const wired = languageById(KOTLIN_ID) !== null;
const graphTest = (name: string, body: () => void): void => {
  test(name, { skip: wired ? false : 'kotlin is not in src/lang/registry.ts yet' }, body);
};

/** The edges of one kind, as `from -> to` strings a test can compare in bulk. */
function edges(graph: Graph, kind: string): string[] {
  return graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.from} -> ${edge.to}`)
    .sort();
}

graphTest('a file may hold several top-level declarations, and its name says nothing', () => {
  // The whole reason Java's resolver could not be reused: `p.HttpStatus` is not
  // HttpStatus.kt, it is whichever file in package p declares that name.
  const graph = graphOf(
    parsedFile(
      'src/http/Http.kt',
      `
      package p.http

      class HttpMethod

      class HttpStatus

      fun statusOf(code: Int): HttpStatus = HttpStatus()
      `,
    ),
    parsedFile(
      'src/app/Server.kt',
      `
      package p.app

      import p.http.HttpStatus
      import p.http.statusOf

      class Server {
          fun run(): HttpStatus = statusOf(200)
      }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'imports'), ['src/app/Server.kt -> src/http/Http.kt']);
  assert.ok(edges(graph, 'calls').includes('src/app/Server.kt#Server.run -> src/http/Http.kt#statusOf'));
});

graphTest('a same-package name needs no import, and a file with none is in the default package', () => {
  const graph = graphOf(
    parsedFile('a/Store.kt', 'package p\n\nclass Store\n'),
    parsedFile('a/Uses.kt', 'package p\n\nclass Uses(val store: Store)\n'),
    parsedFile('Root.kt', 'class Root\n'),
    parsedFile('Main.kt', 'fun main() {\n  Root()\n}\n'),
  );

  assert.ok(edges(graph, 'imports').includes('a/Uses.kt -> a/Store.kt'));
  assert.ok(edges(graph, 'calls').includes('Main.kt#main -> Root.kt#Root'));
});

test('a top-level function is a symbol on the file, and an extension is not the type\'s member', () => {
  const { symbols } = parse(`
    package p

    fun free(): Int = 1

    fun Store.reset() {
        this.clear()
        free()
    }

    val LIMIT: Int = 10

    private fun hidden() {}
  `);

  const reset = byName(symbols, 'reset');
  assert.equal(reset.kind, 'function');
  // An extension is not owned by what it extends — the class has never heard of
  // it — but its receiver is written down, so `this` is a real reference.
  assert.equal(reset.owner, undefined);
  assert.deepEqual(sorted(reset.calls), ['Store.clear', 'free']);
  assert.equal(byName(symbols, 'LIMIT').kind, 'field');
  assert.equal(byName(symbols, 'free').exported, true);
  assert.equal(byName(symbols, 'hidden').exported, false);
});

graphTest('an object is a class, and its members are reached on its name', () => {
  const graph = graphOf(
    parsedFile(
      'a/Registry.kt',
      `
      package p

      object Registry {
          val all: MutableList<Shape> = mutableListOf()

          fun add(s: Shape) {
              all.add(s)
          }
      }
      `,
    ),
    parsedFile(
      'a/Uses.kt',
      `
      package p

      class Uses {
          fun go() {
              Registry.add(Shape())
          }
      }
      `,
    ),
  );

  assert.equal(graph.nodes.get('a/Registry.kt#Registry')?.kind, 'class');
  assert.ok(edges(graph, 'calls').includes('a/Uses.kt#Uses.go -> a/Registry.kt#Registry.add'));
});

test('a companion object\'s members belong to the enclosing type, and say static', () => {
  const { symbols } = parse(`
    package p

    class Circle(private val r: Double) {
        fun area(): Double = r

        companion object {
            const val MAX: Int = 3

            fun of(r: Double): Circle = Circle(r)
        }
    }
  `);

  // `Circle.of(1.0)` is how it is called and the companion has no name at the
  // call site, so its members are Circle's — and `companion object` is how
  // Kotlin writes what Java writes as `static`.
  const of = byName(symbols, 'of');
  assert.equal(of.owner, 'Circle');
  assert.equal(of.isStatic, true);
  assert.equal(byName(symbols, 'MAX').isStatic, true);
  assert.equal(byName(symbols, 'area').isStatic, undefined);
});

test('a data class declares what the source wrote and nothing else', () => {
  const { symbols } = parse(`
    package p

    data class Point(val x: Int, val y: Int) {
        fun length(): Int = x
    }
  `);

  // No equals, no hashCode, no copy, no componentN: the compiler writes them,
  // the source did not, and a box that listed them would be describing bytecode.
  assert.deepEqual(
    symbols.map((symbol) => `${symbol.kind} ${symbol.name}`),
    ['class Point', 'field x', 'field y', 'method length'],
  );
  // A `val` in the primary constructor arrives through it: UML's aggregation.
  assert.equal(byName(symbols, 'x').handedIn, true);
});

test('a plain primary-constructor parameter declares no attribute', () => {
  const { symbols } = parse(`
    package p

    class Server(host: String, val port: Int) {
        val label: String = host
    }
  `);

  assert.deepEqual(sorted(symbols.map((symbol) => symbol.name)), ['Server', 'label', 'port']);
});

test('parentheses decide a supertype, and an interface generalises', () => {
  const { symbols } = parse(`
    package p

    sealed class Shape : Drawable

    class Circle : Shape(), Drawable, Sized by holder

    interface Round : Drawable
  `);

  // Kotlin writes one colon where Java writes two keywords: what distinguishes
  // the superclass is that it is constructed.
  assert.deepEqual(byName(symbols, 'Circle').extends, ['Shape']);
  assert.deepEqual(sorted(byName(symbols, 'Circle').implements), ['Drawable', 'Sized']);
  // On an interface every supertype is one, which UML calls generalisation.
  assert.deepEqual(byName(symbols, 'Round').extends, ['Drawable']);
  assert.deepEqual(byName(symbols, 'Round').implements, []);
});

graphTest('a sealed hierarchy needs nothing of its own, and nesting does not hide it', () => {
  const graph = graphOf(
    parsedFile(
      'a/Shape.kt',
      `
      package p

      sealed class Shape {
          class Circle : Shape()
      }

      class Square : Shape()
      `,
    ),
  );

  // `sealed` says who *may* extend, which is not a relationship; the subclasses
  // already say that they do, and a nested one is a symbol of its own.
  assert.deepEqual(edges(graph, 'extends'), [
    'a/Shape.kt#Circle -> a/Shape.kt#Shape',
    'a/Shape.kt#Square -> a/Shape.kt#Shape',
  ]);
});

graphTest('a lower-case name may be a type', () => {
  // Java's hard-won rule. 131 of 266 real classes broke the convention there,
  // and a type position is a type because the grammar says so.
  const graph = graphOf(
    parsedFile('a/thing.kt', 'package p\n\nclass thing {\n  fun go() {}\n}\n'),
    parsedFile('a/Uses.kt', 'package p\n\nclass Uses(val t: thing) : thing()\n'),
  );

  assert.deepEqual(edges(graph, 'extends'), ['a/Uses.kt#Uses -> a/thing.kt#thing']);
  assert.deepEqual(edges(graph, 'associates'), ['a/Uses.kt#Uses -> a/thing.kt#thing']);
});

test('UML has three visibilities and `internal` is not one of them', () => {
  const { symbols } = parse(`
    package p

    class A {
        private val a: Int = 1
        protected val b: Int = 2
        internal val c: Int = 3
        val d: Int = 4
        abstract fun e()
    }
  `);

  assert.equal(byName(symbols, 'a').visibility, 'private');
  assert.equal(byName(symbols, 'b').visibility, 'protected');
  // Module-wide visibility, which the graph model has no room for: absent means
  // the source said nothing it could carry, never that it said public.
  assert.equal(byName(symbols, 'c').visibility, undefined);
  assert.equal(byName(symbols, 'd').visibility, undefined);
  assert.equal(byName(symbols, 'e').isAbstract, true);
});

test('a call is admitted only when the receiver\'s type was written down', () => {
  const { symbols } = parse(`
    package p

    class Runner(private val store: Store) {
        private val log: Logger = Logger()

        fun run(cfg: Config, other: Any) {
            this.helper()
            helper()
            missing()
            store.save()
            cfg.load()
            log.info()
            val local = Item()
            local.go()
            val untyped = make()
            untyped.tick()
            other.hmm()
            items.forEach { it.go() }
            try { risky() } catch (e: BadThing) { e.report() }
        }

        private fun helper() {}
    }
  `);

  // `it` is a lambda parameter nobody typed, so `it.go()` is nothing at all.
  // `untyped` reads as a `make` because Kotlin has no `new` and this file
  // cannot tell a constructor from a factory — and it does not have to: `make`
  // is a function, the store admits a member only on a classifier, and the
  // wrong reading refuses itself. `Any.hmm` is what the parameter was declared,
  // written down and resolving to nothing, which is a gap and not a guess.
  assert.deepEqual(sorted(byName(symbols, 'run').calls), [
    'Any.hmm',
    'BadThing.report',
    'Config.load',
    'Item',
    'Item.go',
    'Logger.info',
    'Runner.helper',
    'Store.save',
    'make',
    'make.tick',
    'missing',
    'risky',
  ]);
});

test('a receiver lambda re-binds `this`, so a bare call inside one is nobody\'s', () => {
  const { symbols } = parse(`
    package p

    class Runner(private val store: Store) {
        fun run() {
            store.apply {
                save()
                this.close()
            }
            save()
        }

        fun save() {}
        fun close() {}
    }
  `);

  // `store.apply { save() }` calls save on the store, not on Runner, and
  // nothing in the braces says so — reading it as Runner's would be a lie.
  assert.deepEqual(sorted(byName(symbols, 'run').calls), ['Runner.save', 'Store.apply']);
});

test('an anonymous object\'s body is its own', () => {
  const { symbols } = parse(`
    package p

    class Runner(private val store: Store) {
        fun run() {
            object : Listener {
                override fun on() {
                    store.save()
                    tick()
                }
            }
        }

        fun tick() {}
    }
  `);

  // `store` is a property of the outer type, which the inner body may shadow
  // with one of its own or a supertype's; `tick()` is the anonymous type's
  // before it is Runner's. Both are refused rather than guessed. `Listener` is
  // a type reference and reaches its file as an import, not as a call.
  assert.deepEqual(byName(symbols, 'run').calls, []);
});

graphTest('a nested type built on its owner\'s name reaches the file the owner is in', () => {
  const graph = graphOf(
    parsedFile(
      'a/Request.kt',
      `
      package p

      class Request {
          class Builder {
              fun build(): Request = Request()
          }
      }
      `,
    ),
    parsedFile(
      'a/Uses.kt',
      `
      package p

      import p.Request

      class Uses {
          fun go(): Request = Request.Builder().build()
      }
      `,
    ),
  );

  // The graph keeps a nested type as a top-level symbol of its file, so asking
  // Request for a member called Builder finds nothing; the reference has to
  // name the file instead.
  assert.ok(edges(graph, 'calls').includes('a/Uses.kt#Uses.go -> a/Request.kt#Builder'));
});

graphTest('a member imported off a companion or an object is called on its owner', () => {
  const graph = graphOf(
    parsedFile(
      'a/Headers.kt',
      `
      package p

      class Headers {
          companion object {
              fun headersOf(vararg parts: String): Headers = Headers()
          }
      }
      `,
    ),
    parsedFile(
      'a/TestUtil.kt',
      `
      package p

      object TestUtil {
          fun entries(): Int = 1
      }
      `,
    ),
    parsedFile(
      'a/Uses.kt',
      `
      package p

      import p.Headers.Companion.headersOf
      import p.TestUtil.entries

      class Uses {
          fun go(): Headers = headersOf("a", "b")

          fun n(): Int = entries()
      }
      `,
    ),
  );

  const calls = edges(graph, 'calls');
  assert.ok(calls.includes('a/Uses.kt#Uses.go -> a/Headers.kt#Headers.headersOf'));
  assert.ok(calls.includes('a/Uses.kt#Uses.n -> a/TestUtil.kt#TestUtil.entries'));
});

graphTest('an import may rename what it binds', () => {
  const graph = graphOf(
    parsedFile('a/Thing.kt', 'package p.deep\n\nclass Thing\n'),
    parsedFile(
      'a/Uses.kt',
      `
      package p

      import p.deep.Thing as T

      class Uses(val t: T)
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'associates'), ['a/Uses.kt#Uses -> a/Thing.kt#Thing']);
});

graphTest('a package the project has is the last one tried', () => {
  const graph = graphOf(
    parsedFile(
      'a/internal.kt',
      `
      package p.internal

      val Response.connection: Int
          get() = 1
      `,
    ),
    parsedFile(
      'a/Policy.kt',
      `
      package p.internal.connection

      class Policy(@JvmField val minimum: Int)
      `,
    ),
  );

  // `p.internal.connection.JvmField` has a package that exists and no such
  // name in it, so the reference names nothing. Reading on gave `p.internal`
  // the name `connection`, found the extension property, and drew an edge from
  // a file whose only reference is an annotation.
  assert.deepEqual(edges(graph, 'imports'), []);
});

graphTest('Kotlin and Java share one package namespace', () => {
  const java: ParsedFile = {
    filePath: 'src/main/java/p/Legacy.java',
    language: 'java',
    lineCount: 3,
    modifiedAt: 0,
    imports: [],
    moduleName: 'p',
    symbols: [
      { name: 'Legacy', kind: 'class', startLine: 1, endLine: 3, extends: [], implements: [], calls: [] },
    ],
  };
  const graph = graphOf(
    java,
    parsedFile(
      'src/main/kotlin/p/Uses.kt',
      `
      package p

      import p.Legacy

      class Uses(val legacy: Legacy)
      `,
    ),
  );

  // They compile together into one module, so a Kotlin file naming a Java class
  // is an ordinary reference and not a special case.
  assert.deepEqual(edges(graph, 'imports'), ['src/main/kotlin/p/Uses.kt -> src/main/java/p/Legacy.java']);
});

test('an annotated `annotation class` still declares its class', () => {
  // tree-sitter-kotlin 1.1.0 reads that exact shape as an expression and does
  // not flag it, so the declaration vanished silently and took every reference
  // to it with it. Delete this test when the grammar is fixed.
  const { symbols } = parse(`
    package p

    @Retention(BINARY)
    @Target(CLASS)
    annotation class InternalApi
  `);

  assert.deepEqual(
    symbols.map((symbol) => `${symbol.kind} ${symbol.name}`),
    ['class InternalApi'],
  );
});

test('a typealias is a type, and an enum entry is an attribute of its enum', () => {
  const { symbols } = parse(`
    package p

    typealias Handler = (Int) -> Unit

    enum class Colour(val rgb: Int) {
        RED(1),
        GREEN(2),
        ;

        fun hex(): Int = rgb
    }
  `);

  assert.equal(byName(symbols, 'Handler').kind, 'type');
  const red = byName(symbols, 'RED');
  assert.equal(red.kind, 'field');
  assert.equal(red.owner, 'Colour');
  // Constants are the enum's instances, so they are its attributes.
  assert.equal(red.isStatic, true);
  assert.equal(byName(symbols, 'hex').kind, 'method');
});

test('what a property\'s type says about the association', () => {
  const { symbols } = parse(`
    package p

    class Store {
        val log: Logger = Logger()
        val items: MutableList<Item> = mutableListOf()
        val index: Map<String, Item> = mapOf()
        val maybe: Item? = null
        val other: Logger = ConsoleLogger()
        val fn: (Int) -> Unit = { }
    }
  `);

  const log = byName(symbols, 'log');
  assert.equal(log.typeName, 'Logger');
  // The type written on the property is the one the initialiser names, so the
  // class builds the part: UML's composition.
  assert.equal(log.composed, true);
  assert.deepEqual(
    { typeName: byName(symbols, 'items').typeName, many: byName(symbols, 'items').many },
    { typeName: 'Item', many: true },
  );
  // A map is many values keyed by something: the value is the end that matters.
  assert.equal(byName(symbols, 'index').typeName, 'Item');
  assert.equal(byName(symbols, 'maybe').optional, true);
  // `ConsoleLogger()` builds something this file cannot say is a Logger.
  assert.equal(byName(symbols, 'other').composed, undefined);
  assert.equal(byName(symbols, 'fn').typeName, undefined);
});

test('a class writes down what its operations depend on', () => {
  const { symbols } = parse(`
    package p

    class Store<T> {
        fun save(item: Item, held: T): Receipt = Receipt()
    }
  `);

  // A type parameter is never a dependency: it names whatever the caller
  // supplies, and a project can declare a class called T as easily as not.
  assert.deepEqual(sorted(byName(symbols, 'Store').dependsOn ?? []), ['Item', 'Receipt']);
});

test('a secondary constructor is an operation, and the primary one is the header', () => {
  const { symbols } = parse(`
    package p

    class Store(val name: String) {
        constructor() : this("anonymous") {
            start()
        }

        fun start() {}
    }
  `);

  const constructor = symbols.filter((symbol) => symbol.name === 'Store' && symbol.kind === 'method');
  assert.equal(constructor.length, 1);
  assert.deepEqual(constructor[0]?.calls, ['Store.start']);
});

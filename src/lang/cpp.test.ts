import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import { cpp } from './cpp.js';

// The grammars are native addons; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test — and
// because half of what this reader has to survive is a misparse, which no
// hand-built tree would reproduce.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string, filePath = 'a.cpp') {
  const parser = new TreeSitter();
  parser.setLanguage(cpp.grammar(filePath) as Parser.Language);
  return cpp.extract(parser.parse(source).rootNode, source);
}

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: cpp.id, lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source, filePath) };
}

/** One include, asked of the project made of `files`. */
function resolve(from: string, specifier: string, files: readonly string[]): string | null {
  return cpp.resolve({
    from,
    specifier,
    files: new Set(files),
    modules: new Map(),
    declarations: new Map(),
    imports: new Map(),
    facts: { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() },
  });
}

const named = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol | undefined =>
  symbols.find((symbol) => symbol.name === name);

const signature = (symbol: ParsedSymbol | undefined): string =>
  symbol === undefined
    ? 'absent'
    : [
        symbol.kind,
        symbol.name,
        symbol.owner === undefined ? '' : `of:${symbol.owner}`,
        symbol.visibility ?? '',
        symbol.isStatic === true ? 'static' : '',
        symbol.isAbstract === true ? 'abstract' : '',
      ]
        .filter((part) => part !== '')
        .join(' ');

test('an include keeps its delimiter, because the delimiter is the whole meaning', () => {
  const { imports } = parse(`
    #include <stdio.h>
    #include "engine.h"
    #include <curl/curl.h>
    #include SOME_MACRO
  `);

  // The macro names neither a path nor a system header: there is nothing here
  // to resolve and nothing to count as missing.
  assert.deepEqual(imports.sort(), ['"engine.h"', '<curl/curl.h>', '<stdio.h>']);
});

test('a quoted include is found beside the file before anywhere else', () => {
  const files = ['src/engine.cpp', 'src/util.h', 'util.h'];
  assert.equal(resolve('src/engine.cpp', '"util.h"', files), 'src/util.h');
});

test('a quoted include is found through a directory above the file, nearest first', () => {
  // curl's shape: `lib/curlx/base64.c` writes `"curl_setup.h"` for the header
  // at `lib/`, and `"curlx/base64.h"` for the one beside it, because the build
  // passes `-I lib`.
  const files = ['lib/curl_setup.h', 'lib/curlx/base64.c', 'lib/curlx/base64.h'];
  assert.equal(resolve('lib/curlx/base64.c', '"curl_setup.h"', files), 'lib/curl_setup.h');
  assert.equal(resolve('lib/curlx/base64.c', '"curlx/base64.h"', files), 'lib/curlx/base64.h');
});

test('the nearest directory wins, so two files of one name do not answer for each other', () => {
  const files = ['tests/libtest/lib1530.c', 'tests/libtest/first.h', 'tests/server/first.h', 'first.h'];
  assert.equal(resolve('tests/libtest/lib1530.c', '"first.h"', files), 'tests/libtest/first.h');
});

test('an angled include skips the file\'s own directory, as the language says', () => {
  const files = ['src/engine.cpp', 'src/util.h'];
  assert.equal(resolve('src/engine.cpp', '<util.h>', files), null);
});

test('an angled include still lands on the project\'s own public header', () => {
  // curl's 155 resolved angled includes are all this: its own API, reached
  // through the `include/` directory the build declares.
  const files = ['include/curl/curl.h', 'lib/http.c'];
  assert.equal(resolve('lib/http.c', '<curl/curl.h>', files), 'include/curl/curl.h');
});

test('an include directory and the directory above it are both roots', () => {
  // googletest's `googlemock/test/…` reaches `googletest/src/…` because the
  // parent of an include directory is where a project's own src sits.
  const files = [
    'googletest/include/gtest/gtest.h',
    'googletest/src/gtest-internal-inl.h',
    'googlemock/test/gmock_test.cc',
  ];
  assert.equal(resolve('googlemock/test/gmock_test.cc', '"gtest/gtest.h"', files), 'googletest/include/gtest/gtest.h');
  assert.equal(
    resolve('googlemock/test/gmock_test.cc', '"src/gtest-internal-inl.h"', files),
    'googletest/src/gtest-internal-inl.h',
  );
});

test('a system header resolves to nothing, and there is nothing missing', () => {
  assert.equal(resolve('src/engine.cpp', '<vector>', ['src/engine.cpp']), null);
  assert.equal(resolve('src/engine.cpp', '<sys/socket.h>', ['src/engine.cpp']), null);
});

test('a header and its source get the include edge and no second relationship', () => {
  const header = parsedFile('src/engine.h', 'class Engine { public: void run(); };');
  const source = parsedFile('src/engine.cpp', '#include "engine.h"\nvoid Engine::run() { }');

  // The include is the whole of the relationship, and it is the one the source
  // actually wrote. Pairing the two by their matching stems would be a
  // convention rather than the language — a `.cpp` need not include the header
  // named after it — and there is no edge kind for "defines" that would not
  // simply restate the include.
  assert.deepEqual(source.imports, ['"engine.h"']);
  assert.equal(resolve('src/engine.cpp', '"engine.h"', ['src/engine.cpp', 'src/engine.h']), 'src/engine.h');
  assert.deepEqual(header.imports, []);
});

test('a struct is a class, and each keyword states where its body starts', () => {
  const { symbols } = parse(`
    class Engine { int hidden_; public: void run(); };
    struct Point { int x; };
  `);

  assert.equal(signature(named(symbols, 'Engine')), 'class Engine');
  assert.equal(signature(named(symbols, 'hidden_')), 'field hidden_ of:Engine private');
  assert.equal(signature(named(symbols, 'run')), 'method run of:Engine public');
  assert.equal(signature(named(symbols, 'Point')), 'class Point');
  assert.equal(signature(named(symbols, 'x')), 'field x of:Point public');
});

test('multiple inheritance is several extends, and a pure virtual is abstract', () => {
  const { symbols } = parse(`
    class Shape : public Drawable, private Serialisable {
     public:
      virtual void draw() = 0;
      static int count();
    };
  `);

  assert.deepEqual(named(symbols, 'Shape')?.extends, ['Drawable', 'Serialisable']);
  // C++ has no `interface`, so a base is never `implements`; telling one from
  // the other would mean resolving it, which a file parsed alone cannot do.
  assert.deepEqual(named(symbols, 'Shape')?.implements, []);
  assert.equal(named(symbols, 'Shape')?.isAbstract, true);
  assert.equal(signature(named(symbols, 'draw')), 'method draw of:Shape public abstract');
  assert.equal(signature(named(symbols, 'count')), 'method count of:Shape public static');
});

test('a field\'s declared type is the association, and how it is held is on it', () => {
  const { symbols } = parse(`
    class Store {
      Logger log_;
      Cache* cache_;
      std::vector<Item> items_;
      std::unique_ptr<Engine> engine_;
      std::optional<Handle> handle_;
      int count_;
    };
  `);

  assert.equal(named(symbols, 'log_')?.typeName, 'Logger');
  assert.equal(named(symbols, 'log_')?.composed, true);
  // A `*` between the holder and the held is exactly the difference between a
  // part stored inside the object and one that lives on its own.
  assert.equal(named(symbols, 'cache_')?.typeName, 'Cache');
  assert.equal(named(symbols, 'cache_')?.composed, undefined);
  assert.equal(named(symbols, 'items_')?.typeName, 'Item');
  assert.equal(named(symbols, 'items_')?.many, true);
  assert.equal(named(symbols, 'engine_')?.typeName, 'Engine');
  assert.equal(named(symbols, 'handle_')?.optional, true);
  // A primitive is not a classifier, so there is no association to draw.
  assert.equal(named(symbols, 'count_')?.typeName, undefined);
});

test('a call reaches a member only through a receiver whose type was written', () => {
  const { symbols } = parse(`
    class Engine {
      Logger log_;
     public:
      void step();
      void run(Store& store) {
        this->step();
        log_.write("x");
        store.save();
        auto handle = make();
        handle.flush();
        helper();
      }
    };
  `);

  const run = named(symbols, 'run');
  assert.deepEqual(
    [...(run?.calls ?? [])].sort(),
    // `handle.flush()` is absent and stays absent: nothing said what `make()`
    // returns, and a bare `flush` could only land on some unrelated function
    // of that name. A missing edge is a gap; a wrong one is a lie. `make`
    // itself is a call like any other and is kept.
    ['Engine.step', 'Logger.write', 'Store.save', 'helper', 'make'].sort(),
  );
});

test('a method defined out of line belongs to the class it names', () => {
  const { symbols } = parse(`
    namespace app {
      void Engine::step() { helper(); }
    }
  `);

  assert.equal(signature(named(symbols, 'step')), 'method step of:Engine');
});

test('a namespace is descended into and is never a symbol', () => {
  const { symbols } = parse('namespace app { namespace detail { class Widget { }; } }');

  // A namespace is not a classifier: nothing extends it and nothing is its
  // attribute. Making it one would give every class in it an owner.
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['Widget']);
});

test('an include guard does not hide the file it wraps', () => {
  // Every C and C++ header is written this way, so stopping at the `#ifndef`
  // read googletest as 4045 symbols rather than 7443 and left a header whose
  // whole job is to declare one class with none at all.
  const { symbols } = parse(
    `
    #ifndef ENGINE_H_
    #define ENGINE_H_
    class Engine { public: void run(); };
    #endif
    `,
    'engine.h',
  );

  assert.equal(signature(named(symbols, 'Engine')), 'class Engine');
  assert.equal(signature(named(symbols, 'run')), 'method run of:Engine public');
});

test('both branches of a conditional are read, because the file declares both', () => {
  const { symbols } = parse(`
    #ifdef USE_OPENSSL
    int sha256_init(void* ctx) { return 0; }
    #else
    int sha256_init(void* ctx) { return 1; }
    #endif
  `);

  // curl defines `my_sha256_init` seven times, once per TLS backend. Which one
  // a compiler takes is a question about a command line the graph has not got.
  assert.equal(symbols.filter((symbol) => symbol.name === 'sha256_init').length, 2);
});

test('a macro invocation is not a symbol, however much it looks like one', () => {
  const { symbols } = parse(`
    TEST(EngineTest, Runs) { int x = 1; }
    struct Config { BIT(verbose); int real_; };
    int main(int argc, char** argv) { return 0; }
  `);

  // C++ requires a return type and C has since C99, so a callable with none is
  // a `#define` standing where a declaration goes. Taken at face value, one
  // googletest file declared 230 functions called `TEST` and one curl struct
  // had 84 methods called `BIT`.
  assert.equal(named(symbols, 'TEST'), undefined);
  assert.equal(named(symbols, 'BIT'), undefined);
  assert.equal(signature(named(symbols, 'main')), 'function main');
  assert.equal(signature(named(symbols, 'real_')), 'field real_ of:Config public');
});

test('the three typeless callables C++ actually defines are kept', () => {
  const { symbols } = parse(`
    class Handle {
     public:
      Handle(int fd);
      ~Handle();
      operator bool() const;
    };
  `);

  assert.equal(signature(named(symbols, 'Handle')), 'class Handle');
  assert.equal(signature(named(symbols, '~Handle')), 'method ~Handle of:Handle public');
  assert.equal(named(symbols, 'operator bool')?.kind, 'method');
  // The constructor shares its class's name, so it is the second symbol of it.
  assert.equal(symbols.filter((symbol) => symbol.name === 'Handle').length, 2);
});

test('a class named through an export macro is still a class', () => {
  // The grammar reads `GTEST_API_` as the class name and the rest as a function
  // definition — a shape that is not legal C++ at all. 48 of googletest's
  // classes are written this way, `Mock` and `Expectation` among them.
  const { symbols } = parse(`
    class GTEST_API_ Cardinality : public Base {
     public:
      void Describe() const;
     private:
      Logger impl_;
    };
  `);

  assert.equal(signature(named(symbols, 'Cardinality')), 'class Cardinality');
  assert.deepEqual(named(symbols, 'Cardinality')?.extends, ['Base']);
  assert.equal(signature(named(symbols, 'Describe')), 'method Describe of:Cardinality public');
  assert.equal(signature(named(symbols, 'impl_')), 'field impl_ of:Cardinality private');
  assert.equal(named(symbols, 'GTEST_API_'), undefined);
});

test('a forward declaration is a promise, not a second box for the class', () => {
  const { symbols } = parse('class Engine;\nclass Widget { Engine* engine_; };');

  assert.deepEqual(symbols.filter((symbol) => symbol.kind === 'class').map((symbol) => symbol.name), ['Widget']);
});

test('an enum is a type, and a typedef of an anonymous struct takes its name', () => {
  const { symbols } = parse('enum Colour { Red, Green };\ntypedef struct { int x; } point_t;', 'a.c');

  // An enum has no operations, so nothing can be contained by it.
  assert.equal(named(symbols, 'Colour')?.kind, 'type');
  // The struct has no name of its own, so the typedef's is the only one
  // anybody can write.
  assert.equal(named(symbols, 'point_t')?.kind, 'class');
  assert.equal(signature(named(symbols, 'x')), 'field x of:point_t public');
});

test('a C file goes to the C grammar and a header to the superset', () => {
  // `.h` is claimed by both languages, so it goes to the grammar that can read
  // either. Measured on curl: the two agree exactly on its 257 headers.
  assert.notEqual(cpp.grammar('lib/http.c'), cpp.grammar('lib/http.h'));
  assert.equal(cpp.grammar('lib/http.h'), cpp.grammar('src/engine.cpp'));
});

test('a function pointer field is an attribute, not an operation', () => {
  const { symbols } = parse('struct Handlers { int (*on_read)(void*); void run(); };', 'a.c');

  // The parentheses are what make the next `(…)` a parameter list for a
  // pointer rather than for a function.
  assert.equal(named(symbols, 'on_read')?.kind, 'field');
  assert.equal(named(symbols, 'run')?.kind, 'method');
});

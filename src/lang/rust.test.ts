import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore, setProjectFacts } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ImportBinding, ParsedFile } from '../parser/types.js';
import { rust } from './rust.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(rust.grammar('a.rs') as Parser.Language);
  return rust.extract(parser.parse(source).rootNode, source);
}

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: 'rust', lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source) };
}

/** The graph of a workspace, derived through the store with Rust's own resolver. */
function graphOf(crates: Record<string, string>, ...files: ParsedFile[]): Graph {
  const store = createStore();
  setProjectFacts(store, {
    tsPaths: new Map(),
    packages: new Map(),
    goModule: null,
    crates: new Map(Object.entries(crates)),
  });
  applyBatch(store, files, []);
  return store.graph;
}

/** The edges of one kind, with `~>` for the ones the graph had to guess at. */
function edges(graph: Graph, kind: string): string[] {
  return graph.edges
    .filter((edge) => edge.kind === kind)
    .map((edge) => `${edge.from} ${edge.guessed === true ? '~>' : '->'} ${edge.to}`)
    .sort();
}

/** A binding under the name the other file uses too, which is the ordinary case. */
const local = (name: string, specifier: string): ImportBinding => ({
  local: name,
  specifier,
  imported: name,
});

const byLocal = (bindings: readonly ImportBinding[] | undefined): ImportBinding[] =>
  [...(bindings ?? [])].sort((a, b) => (a.local < b.local ? -1 : 1));

test('a `use` binds the name it names, and an alias binds the name the file writes', () => {
  const { bindings } = parse(`
    use crate::searcher::{Config, Range};
    use crate::line_buffer::LineBufferReader;
    use crate::lines::{self, LineStep};
    use crate::error::Error as SearchError;
    use grep_matcher::Matcher;
    mod core;
  `);

  assert.deepEqual(byLocal(bindings), [
    local('Config', 'crate::searcher::Config'),
    local('LineBufferReader', 'crate::line_buffer::LineBufferReader'),
    local('LineStep', 'crate::lines::LineStep'),
    local('Matcher', 'grep_matcher::Matcher'),
    local('Range', 'crate::searcher::Range'),
    // `as` renames it here, so the binding is under the name written here and
    // the name asked for over there.
    { local: 'SearchError', specifier: 'crate::error::Error', imported: 'Error' },
    // A `mod` is a reference like any other, and the only one Rust makes to a
    // file rather than to something in one.
    local('core', 'self::core'),
    // `use crate::lines::{self, …}` names the module itself, not an item in it
    // called `self`.
    local('lines', 'crate::lines'),
  ]);
});

test('a name two modules declare is read from the one the file named', () => {
  // ripgrep, exactly: searcher/glue.rs writes `use crate::searcher::Config` on
  // line 6 and imports line_buffer for something else. `line_buffer::Config` is
  // private and the file cannot name it, but it was the first imported table
  // holding the name, so three fields landed on it.
  const graph = graphOf(
    {},
    parsedFile('crates/searcher/src/lib.rs', 'pub mod line_buffer;\npub mod searcher;'),
    parsedFile(
      'crates/searcher/src/line_buffer.rs',
      `
        pub struct Config { capacity: usize }
        pub struct LineBufferReader { pos: usize }
      `,
    ),
    parsedFile('crates/searcher/src/searcher/mod.rs', 'pub struct Config { multi_line: bool }'),
    parsedFile(
      'crates/searcher/src/searcher/glue.rs',
      `
        use crate::line_buffer::LineBufferReader;
        use crate::searcher::Config;

        pub struct MultiLine {
          config: Config,
          rdr: LineBufferReader,
        }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'associates'), [
    'crates/searcher/src/searcher/glue.rs#MultiLine -> crates/searcher/src/line_buffer.rs#LineBufferReader',
    'crates/searcher/src/searcher/glue.rs#MultiLine -> crates/searcher/src/searcher/mod.rs#Config',
  ]);
});

test('a name the file never bound is left alone, however sure another crate looks', () => {
  // ripgrep's cli/src/decompress.rs: `io::Error::new(…)` reaches the graph as
  // the bare `Error`, and globset — imported for its globs — exports one. The
  // function returns CommandError and never mentions globset's.
  const graph = graphOf(
    { globset: 'crates/globset' },
    parsedFile(
      'crates/globset/src/lib.rs',
      `
        pub struct Error { kind: ErrorKind }
        pub struct Glob { glob: String }
      `,
    ),
    parsedFile('crates/cli/src/lib.rs', 'pub mod decompress;'),
    parsedFile(
      'crates/cli/src/decompress.rs',
      `
        use globset::Glob;

        pub fn try_resolve_binary() {
          Glob::new("*.gz");
          io::Error::new(io::ErrorKind::Other, "no PATH");
        }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'calls'), [
    'crates/cli/src/decompress.rs#try_resolve_binary -> crates/globset/src/lib.rs#Glob',
  ]);
});

test('a path written out where it is used binds too, the same as the `use` that would have shortened it', () => {
  // Both ends of the path are bound, because which one reaches the graph
  // depends on where it was written: `Str::new()` arrives as `Str`, a struct
  // literal as `Str`, and `messages::err_message!()` as the tail. A method name
  // over-bound this way finds nothing — Rust declares constructors in an impl,
  // and the graph keeps members out of a file's name table.
  assert.deepEqual(byLocal(parse('pub fn make() { crate::builder::Str::new(); }').bindings), [
    local('Str', 'crate::builder::Str::new'),
    local('new', 'crate::builder::Str::new'),
  ]);

  const graph = graphOf(
    {},
    parsedFile('src/lib.rs', 'pub mod builder;'),
    parsedFile('src/builder.rs', 'pub struct Str { inner: String }'),
    parsedFile('src/arg.rs', 'pub fn make() { crate::builder::Str::new(); }'),
  );

  assert.deepEqual(edges(graph, 'calls'), ['src/arg.rs#make -> src/builder.rs#Str']);
});

test('a glob on another module cannot be enumerated, so the file keeps the whole-table rule and says so', () => {
  // `use crate::imp::*` puts names in scope that the file never wrote down.
  // Refusing them would be a silent gap; reaching them without a binding is a
  // guess, and the edge is marked as one.
  const graph = graphOf(
    {},
    parsedFile('src/lib.rs', 'pub mod imp;\npub mod user;'),
    parsedFile('src/imp.rs', 'pub struct Handle { fd: i32 }'),
    parsedFile(
      'src/user.rs',
      `
        use crate::imp::*;

        pub struct User { handle: Handle }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'associates'), ['src/user.rs#User ~> src/imp.rs#Handle']);
});

test('a glob on a type this file declares brings variants, which the graph does not hold', () => {
  // Nine of ripgrep's eleven wildcards are this — `use self::DirEntryInner::*`
  // — and reading them as unknowable would cost eight files their bindings to
  // learn nothing.
  const { bindings } = parse(`
    use crate::imp::Handle;

    pub enum Kind { A, B }

    pub struct Holder { handle: Handle }

    impl Kind {
      fn go(&self) -> bool {
        use self::Kind::*;
        matches!(self, A)
      }
    }
  `);

  assert.deepEqual(byLocal(bindings), [local('Handle', 'crate::imp::Handle')]);
});

test('one local name spelled by two `use` lines binds to neither', () => {
  // Rust scopes a `use` inside a function body to that body; `ImportBinding`
  // is one flat list for the file, so a name two bodies spell differently
  // cannot be recorded as both. Taking the first is not a tie-break, it is a
  // wrong answer for every body but one: ripgrep's `flags/defs.rs` writes
  // `use \u2026::ContextSeparator as Separator` in one `update` and
  // `use \u2026::FieldContextSeparator as Separator` in the next, and binding the
  // first drew `FieldContextSeparator.update` and `FieldMatchSeparator.update`
  // on `ContextSeparator` \u2014 the right file, the wrong type, and no `guessed`
  // mark on either. A gap is a gap; this was a lie.
  const { bindings } = parse(`
    use crate::defs::Kept;

    fn one(v: Kept) {
      use crate::lowargs::ContextSeparator as Separator;
      let _: Separator;
    }

    fn two() {
      use crate::lowargs::FieldContextSeparator as Separator;
      let _: Separator;
    }
  `);

  assert.deepEqual(byLocal(bindings), [local('Kept', 'crate::defs::Kept')]);
});

test('the same `use` written twice is one statement, not an ambiguity', () => {
  // A `use` repeated in a `#[cfg(test)] mod tests` is the commonest way a file
  // writes one twice, and it names the same file both times.
  const { bindings } = parse(`
    use crate::lowargs::ContextSeparator as Separator;

    #[cfg(test)]
    mod tests {
      fn go() {
        use crate::lowargs::ContextSeparator as Separator;
        let _: Separator;
      }
    }
  `);

  assert.deepEqual(byLocal(bindings), [
    { local: 'Separator', specifier: 'crate::lowargs::ContextSeparator', imported: 'ContextSeparator' },
  ]);
});

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore, setProjectFacts } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import type { ResolveContext } from './types.js';
import { go } from './go.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(go.grammar('a.go') as Parser.Language);
  return go.extract(parser.parse(source).rootNode, source);
}

const byName = (symbols: readonly ParsedSymbol[], name: string): ParsedSymbol => {
  const found = symbols.find((symbol) => symbol.name === name);
  assert.ok(found, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return found;
};

const sorted = (names: readonly string[]): string[] => [...names].sort();

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: 'go', lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source) };
}

/** The graph of a module, derived through the store with Go's own resolver. */
function graphOf(goModule: string, ...files: ParsedFile[]): Graph {
  const store = createStore();
  setProjectFacts(store, { tsPaths: new Map(), packages: new Map(), goModule, crates: new Map() });
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

test('a reference through an import names what it reaches, and is never reduced to its tail', () => {
  const { imports, symbols } = parse(`
    package doc

    import (
      "fmt"
      "os/exec"
      c "github.com/spf13/cobra"
      "github.com/spf13/cobra/doc"
      "github.com/mattn/go-isatty"
      _ "embed"
      . "strings"
    )

    func GenMan(cmd *c.Command, w io.Writer) error {
      root := &c.Command{Use: "root"}
      root.Help()
      cmd.Execute()
      doc.GenManTree(cmd, nil, "")
      fmt.Println(c.ShellCompDirectiveDefault)
      exec.Command("go", "build")
      if isatty.IsTerminal(0) {
        return nil
      }
      return nil
    }
  `);

  // One reference per name reached, so each can land on the file declaring
  // it; an import used no other way — blank, dot — stays the path.
  assert.deepEqual(imports, [
    'fmt#Println',
    'os/exec#Command',
    'github.com/spf13/cobra#Command',
    'github.com/spf13/cobra#ShellCompDirectiveDefault',
    'github.com/spf13/cobra/doc#GenManTree',
    'github.com/mattn/go-isatty#IsTerminal',
    'embed',
    'strings',
  ]);

  // `exec.Command` keeps its import: bare `Command` would resolve to cobra's.
  assert.deepEqual(sorted(byName(symbols, 'GenMan').calls), [
    'fmt#Println',
    'github.com/mattn/go-isatty#IsTerminal',
    'github.com/spf13/cobra#Command',
    'github.com/spf13/cobra#Command.Execute',
    'github.com/spf13/cobra#Command.Help',
    'github.com/spf13/cobra/doc#GenManTree',
    'os/exec#Command',
  ]);
});

test('an unaliased import is used under the name its path implies', () => {
  const { imports } = parse(`
    package x

    import (
      "github.com/spf13/pflag/v2"
      "gopkg.in/yaml.v3"
    )

    func f() { pflag.Parse(); yaml.Marshal(nil) }
  `);
  assert.deepEqual(imports, ['github.com/spf13/pflag/v2#Parse', 'gopkg.in/yaml.v3#Marshal']);
});

test('a qualifier the file also binds is refused, and the import stands for its package', () => {
  const { imports, symbols } = parse(`
    package doc

    import "github.com/spf13/cobra/doc"

    func Render(doc *Command) { doc.Execute() }
  `);
  assert.deepEqual(imports, ['github.com/spf13/cobra/doc', 'package:Command']);
  // `doc` here is the parameter, typed Command, not the package.
  assert.deepEqual(byName(symbols, 'Render').calls, ['Command.Execute']);
});

test('a call on a receiver whose type was written down is that type\'s method', () => {
  const { symbols } = parse(`
    package cobra

    type Command struct{}

    func (c *Command) Execute() error { return c.execute(nil) }

    func (c *Command) execute(o *Options) {
      o.Apply()
      x := &Command{}
      x.Help()
      var y Command
      y.Usage()
      z := new(Command)
      z.Reset()
      flags := c.Flags()
      flags.Parse()
      for _, sub := range c.commands {
        sub.Execute()
      }
      c.Run(c, nil)
    }
  `);

  assert.deepEqual(byName(symbols, 'Execute').calls, ['Command.execute']);
  // `flags` and `sub` were never given a type in writing, so their calls are
  // left out rather than guessed at.
  assert.deepEqual(sorted(byName(symbols, 'execute').calls), [
    'Command',
    'Command.Flags',
    'Command.Help',
    'Command.Reset',
    'Command.Run',
    'Command.Usage',
    'Options.Apply',
  ]);
});

test('a name aliased from a typed one, and an element of a collection, are typed too', () => {
  // This is cobra's `Command.execute`, reduced. Every persistent hook a
  // command has is reached through `p`, which is written twice — once as an
  // alias of the receiver and once as an element of a slice — and while
  // neither was typed, `PersistentPreRun` was refused, so the list a reader
  // consulted about the run order named `PreRun`, `Run` and `PostRun` and left
  // the four persistent ones out with nothing said.
  const { symbols } = parse(`
    package cobra

    type Command struct{}

    func (c *Command) execute(a []string) {
      parents := make([]*Command, 0, 5)
      for p := c; p != nil; p = p.Parent() {
        parents = append(parents, p)
      }
      for _, p := range parents {
        p.PersistentPreRun(c, a)
      }
      var subs []*Command
      for _, sub := range subs {
        sub.Help()
      }
      byName := map[string]*Command{}
      for _, m := range byName {
        m.Usage()
      }
      for i := range parents {
        i.Ignored()
      }
      for _, line := range a {
        line.Ignored()
      }
      for _, found := range c.commands {
        found.Ignored()
      }
    }
  `);

  // `i` is an index and `line` a string, so neither is a Command; `c.commands`
  // is a field, whose elements are not written down anywhere this file reads.
  assert.deepEqual(sorted(byName(symbols, 'execute').calls), [
    'Command',
    'Command.Help',
    'Command.Parent',
    'Command.PersistentPreRun',
    'Command.Usage',
  ]);
});

test('a variadic parameter names no receiver and every element it holds', () => {
  const { symbols } = parse(`
    package cobra

    type Command struct{}

    func (c *Command) AddCommand(cmds ...*Command) {
      cmds.Ignored()
      for _, cmd := range cmds {
        cmd.Reset()
      }
    }
  `);
  assert.deepEqual(sorted(byName(symbols, 'AddCommand').calls), ['Command.Reset']);
});

test('an alias of a name the file never typed stays untyped', () => {
  const { symbols } = parse(`
    package cobra

    func f() {
      c := whatever()
      p := c
      p.Execute()
      q := &Command{}
      r := q
      r.Help()
    }
  `);
  assert.deepEqual(sorted(byName(symbols, 'f').calls), ['Command', 'Command.Help', 'whatever']);
});

test('a name declared twice with different types, or once without one, is refused', () => {
  const { symbols } = parse(`
    package cobra

    func f(c *Command) {
      if true {
        c := &Options{}
        c.Apply()
      }
      c.Execute()
      d := &Command{}
      d = nil
      d.Help()
      e := &Command{}
      for _, e := range items {
        e.Run()
      }
      e.Reset()
    }
  `);
  // Only `d` is typed by every declaration of it; assignment is not a declaration.
  assert.deepEqual(sorted(byName(symbols, 'f').calls), ['Command', 'Command.Help', 'Options']);
});

test('a local type or a type parameter is not a class the graph could hold', () => {
  const { symbols } = parse(`
    package x

    func g[T any](t T) {
      type local struct{}
      l := local{}
      l.M()
      t.Do()
    }
  `);
  assert.deepEqual(byName(symbols, 'g').calls, []);
});

test('a qualified reference resolves to the file that declares the name', () => {
  const files = new Set([
    'cobra.go',
    'command.go',
    'command_test.go',
    'command_win.go',
    'command_notwin.go',
    'doc/man_docs.go',
    'doc/util.go',
  ]);
  const declarations = new Map<string, ReadonlySet<string>>([
    ['cobra.go', new Set(['Gt'])],
    ['command.go', new Set(['Command'])],
    ['command_test.go', new Set(['Fixture'])],
    ['command_win.go', new Set(['preExecHookFn'])],
    ['command_notwin.go', new Set(['preExecHookFn'])],
    ['doc/man_docs.go', new Set(['GenManTree'])],
    ['doc/util.go', new Set(['hasSeeAlso'])],
  ]);
  const context = (specifier: string, from = 'doc/man_docs.go'): ResolveContext => ({
    from,
    specifier,
    files,
    modules: new Map(),
    declarations,
    imports: new Map(),
    facts: { tsPaths: new Map(), packages: new Map(), goModule: 'github.com/spf13/cobra', crates: new Map() },
  });

  assert.equal(go.resolve(context('github.com/spf13/cobra#Command')), 'command.go');
  assert.equal(go.resolve(context('github.com/spf13/cobra#Gt')), 'cobra.go');
  assert.equal(go.resolve(context('github.com/spf13/cobra/doc#GenManTree', 'cobra_test.go')), 'doc/man_docs.go');

  // A name no file declares — a package-level const — is the package's, and
  // the package's representative stands for it as a plain import would.
  assert.equal(go.resolve(context('github.com/spf13/cobra#ShellCompDirectiveDefault')), 'cobra.go');
  assert.equal(go.resolve(context('github.com/spf13/cobra')), 'cobra.go');
  // Declared in two build-tagged files: which one is not claimed.
  assert.equal(go.resolve(context('github.com/spf13/cobra#preExecHookFn')), 'cobra.go');
  // A test file is invisible to an importer.
  assert.equal(go.resolve(context('github.com/spf13/cobra#Fixture')), 'cobra.go');

  // Outside the module there is nothing to land on.
  assert.equal(go.resolve(context('github.com/spf13/pflag#Flag')), null);
  assert.equal(go.resolve(context('os/exec#Command')), null);
});

test('a package-level variable types the receiver in every function of the file', () => {
  // The program cobra's own test writes to disk and builds (cobra_test.go:268),
  // which is how every cobra program begins.
  const { symbols } = parse(`package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

var rootCmd = &cobra.Command{
	Use:     "example_program",
	Short:   "example_program - test fixture to check that deadcode elimination is allowed",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("hello world")
	},
	Aliases: []string{"alias1", "alias2"},
	Example: "stringer --help",
}

func main() {
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Whoops. There was an error while executing your CLI '%s'", err)
		os.Exit(1)
	}
}
`);
  assert.deepEqual(sorted(byName(symbols, 'main').calls), [
    'fmt#Fprintf',
    'github.com/spf13/cobra#Command.Execute',
    'os#Exit',
  ]);
});

test('a package-level variable is one more declaration, held to the same rule as a local', () => {
  const { symbols } = parse(`
    package cobra

    var (
      root *Command
      store = &Store{}
      out = open()
    )
    var flags, more *FlagSet

    func a() {
      root.Execute()
      store.Save()
      out.Flush()
      flags.Parse()
      more.Set()
    }

    func b(root *Options) {
      root.Apply()
      store := &Cache{}
      store.Put()
      out := &Buffer{}
      out.Write()
    }
  `);
  assert.deepEqual(sorted(byName(symbols, 'a').calls), [
    'Command.Execute',
    'FlagSet.Parse',
    'FlagSet.Set',
    'Store.Save',
  ]);
  // `root` is a Command at package level and an Options in `b`, `store` a
  // Store and then a Cache, and `out` was never given a type at the top:
  // nothing here knows which declaration a call is under, so none is read.
  assert.deepEqual(sorted(byName(symbols, 'b').calls), ['Buffer', 'Cache']);
});

test('a bare name is bound to the sibling that declares it, so the store reads only what the file can see', () => {
  const { imports, bindings } = parse(`
    package a

    import "example.com/m/b"

    type Derived struct{ Base }

    func Run(t b.Thing) {
      c := New()
      _ = c
      helper()
      x := Config{}
      _ = x
    }
  `);
  assert.deepEqual(sorted(imports), [
    'example.com/m/b#Thing',
    'package:Base',
    'package:Config',
    'package:New',
    'package:helper',
  ]);
  // One binding per same-package reference, under the name itself: a name is
  // reached through the one sibling that declares it and through nothing else.
  assert.deepEqual(
    [...(bindings ?? [])].sort((l, r) => (l.local < r.local ? -1 : 1)),
    [
      { local: 'Base', specifier: 'package:Base', imported: 'Base' },
      { local: 'Config', specifier: 'package:Config', imported: 'Config' },
      { local: 'New', specifier: 'package:New', imported: 'New' },
      { local: 'helper', specifier: 'package:helper', imported: 'helper' },
    ],
  );
});

test('a name declared in this package never lands on an imported package that declares it too', () => {
  // b exports New and Thing and hides helper; a declares its own New and
  // helper. Before bindings, a.go's `New()` was drawn on b's, because b.go was
  // the first imported file whose table held the name.
  const graph = graphOf(
    'example.com/m',
    parsedFile('b/b.go', 'package b\n\ntype Thing struct{}\n\nfunc New() *Thing { return &Thing{} }\n\nfunc helper() {}\n'),
    parsedFile(
      'a/new.go',
      'package a\n\ntype Config struct{}\n\ntype Base struct{}\n\nfunc New() *Config { return &Config{} }\n\nfunc helper() {}\n',
    ),
    parsedFile(
      'a/a.go',
      `package a

import "example.com/m/b"

type Derived struct{ Base }

func Run(t b.Thing) {
	c := New()
	_ = c
	helper()
	x := Config{}
	_ = x
}
`,
    ),
  );

  assert.deepEqual(
    edges(graph, 'calls').filter((edge) => edge.startsWith('a/a.go')),
    ['a/a.go#Run -> a/new.go#Config', 'a/a.go#Run -> a/new.go#New', 'a/a.go#Run -> a/new.go#helper'],
  );
  assert.deepEqual(edges(graph, 'extends'), ['a/a.go#Derived -> a/new.go#Base']);
  // The import is still there: a.go does use b.
  assert.deepEqual(edges(graph, 'imports'), ['a/a.go -> a/new.go', 'a/a.go -> b/b.go']);
});

test('an embedded or field type reached through a qualifier keeps its import, as a call does', () => {
  const { symbols } = parse(`
    package srv

    import (
      "log"
      "example.com/m/base"
      "example.com/m/item"
    )

    type Server struct {
      base.Server
      log   *log.Logger
      items []item.Item
      local Local
    }

    type Reader interface {
      base.Closer
    }
  `);
  assert.deepEqual(byName(symbols, 'Server').extends, ['example.com/m/base#Server']);
  assert.deepEqual(byName(symbols, 'Reader').extends, ['example.com/m/base#Closer']);
  assert.equal(byName(symbols, 'log').typeName, 'log#Logger');
  assert.equal(byName(symbols, 'items').typeName, 'example.com/m/item#Item');
  assert.equal(byName(symbols, 'items').many, true);
  assert.equal(byName(symbols, 'local').typeName, 'Local');

  // A qualifier the file also binds names no package here, so the type it
  // qualifies is not offered bare either: a sibling's `Server` is not it.
  const shadowed = parse(`
    package srv

    import "example.com/m/base"

    type Server struct{ base.Server }

    func f(base int) {}
  `);
  assert.deepEqual(byName(shadowed.symbols, 'Server').extends, []);
});

test('a qualified embedded type lands on the file that declares it, in the package the import names', () => {
  const graph = graphOf(
    'example.com/m',
    parsedFile('base/server.go', 'package base\n\ntype Server struct{}\n'),
    parsedFile('base/closer.go', 'package base\n\ntype Closer interface{ Close() }\n'),
    parsedFile('item/item.go', 'package item\n\ntype Item struct{}\n'),
    // A sibling declaring the same bare name, which the tail alone would have hit.
    parsedFile('srv/other.go', 'package srv\n\ntype Item struct{}\n'),
    parsedFile(
      'srv/server.go',
      `package srv

import (
	"example.com/m/base"
	"example.com/m/item"
)

type Server struct {
	base.Server
	items []item.Item
}

type Reader interface{ base.Closer }
`,
    ),
  );

  assert.deepEqual(edges(graph, 'extends'), [
    'srv/server.go#Reader -> base/closer.go#Closer',
    'srv/server.go#Server -> base/server.go#Server',
  ]);
  assert.deepEqual(edges(graph, 'associates'), ['srv/server.go#Server -> item/item.go#Item']);
});

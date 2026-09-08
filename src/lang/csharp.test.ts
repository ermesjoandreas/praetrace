import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile, ParsedSymbol } from '../parser/types.js';
import { csharp } from './csharp.js';
import { razor } from './razor.js';

// The grammar is a native addon; the test parses real trees rather than
// hand-built ones because the node shapes are the thing under test.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

function parse(source: string) {
  const parser = new TreeSitter();
  parser.setLanguage(csharp.grammar('A.cs') as Parser.Language);
  return csharp.extract(parser.parse(source).rootNode, source);
}

/** A file as the store receives it: the real grammar's reading, under a path. */
function parsedFile(filePath: string, source: string): ParsedFile {
  return { filePath, language: 'csharp', lineCount: source.split('\n').length, modifiedAt: 0, ...parse(source) };
}

/** The graph of a project, derived through the store with C#'s own resolver. */
function graphOf(...files: ParsedFile[]): Graph {
  const store = createStore();
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

test('every type the file named is a binding, under the name the file wrote', () => {
  const { bindings } = parse(`
    using Serilog.Events;
    using Ev = Serilog.Events.LogEvent;

    namespace Serilog.Core;

    public class Logger
    {
        public LogEventLevel Level { get; }
        public void Write(Ev e) => Serilog.Log.Debug("x");
    }
  `);

  assert.deepEqual(
    [...(bindings ?? [])].sort((a, b) => a.local.localeCompare(b.local)),
    [
      // The alias binds the name the *file* writes; the type it stands for is
      // what the graph has to ask the other file for.
      { local: 'Ev', specifier: 'Serilog.Events.LogEvent', imported: 'LogEvent' },
      { local: 'Log', specifier: 'Serilog.Log', imported: 'Log' },
      { local: 'LogEvent', specifier: 'Serilog.Events.LogEvent', imported: 'LogEvent' },
      { local: 'LogEventLevel', specifier: 'LogEventLevel', imported: 'LogEventLevel' },
      // The head of `Serilog.Log.Debug(…)` reads as a type too — nothing in the
      // syntax separates a namespace from one — and it is a reference like any
      // other: resolve() answers it only if the project holds a Serilog.cs the
      // file could have named.
      { local: 'Serilog', specifier: 'Serilog', imported: 'Serilog' },
    ],
  );
});

test('a name in a namespace the file never brought into scope is not reached through one it did', () => {
  // The nested `Gadget` is only nameable here as `Widget.Gadget`, and
  // `Acme.Internal.Gadget` is in no namespace this file can see. Widget.cs was
  // simply the first imported table holding the name.
  const graph = graphOf(
    parsedFile(
      'src/Widgets/Widget.cs',
      `
        namespace Acme.Widgets;
        public class Widget
        {
            public class Gadget { }
        }
      `,
    ),
    parsedFile(
      'src/Internal/Gadget.cs',
      `
        namespace Acme.Internal;
        public class Gadget { }
      `,
    ),
    parsedFile(
      'src/App/App.cs',
      `
        using Acme.Widgets;

        namespace Acme.App;

        public class App
        {
            public Widget W { get; }
            public Gadget G { get; }
        }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'associates'), [
    'src/App/App.cs#App -> src/Widgets/Widget.cs#Widget',
  ]);
});

test('a `using` alias reaches the type it stands for, under the name the file writes', () => {
  const graph = graphOf(
    parsedFile(
      'src/Events/LogEvent.cs',
      `
        namespace Serilog.Events;
        public class LogEvent { }
      `,
    ),
    parsedFile(
      'src/Log.cs',
      `
        using Ev = Serilog.Events.LogEvent;

        namespace Serilog;

        public class Log
        {
            public Ev Last { get; }
        }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'associates'), [
    'src/Log.cs#Log -> src/Events/LogEvent.cs#LogEvent',
  ]);
});

test('a type the file named lands on the file the namespaces chose, not on the first table holding it', () => {
  const graph = graphOf(
    parsedFile(
      'src/Core/Logger.cs',
      `
        namespace Serilog.Core;
        public class Logger
        {
            public void Write() { }
        }
      `,
    ),
    parsedFile(
      'src/Core/Guard.cs',
      `
        namespace Serilog.Core;
        public static class Guard
        {
            public static void AgainstNull(object o) { }
        }
      `,
    ),
    parsedFile(
      'src/LoggerConfiguration.cs',
      `
        using Serilog.Core;

        namespace Serilog;

        public class LoggerConfiguration
        {
            public Logger CreateLogger()
            {
                Guard.AgainstNull(this);
                return new Logger();
            }
        }
      `,
    ),
  );

  assert.deepEqual(edges(graph, 'calls'), [
    'src/LoggerConfiguration.cs#LoggerConfiguration.CreateLogger -> src/Core/Guard.cs#Guard',
    'src/LoggerConfiguration.cs#LoggerConfiguration.CreateLogger -> src/Core/Logger.cs#Logger',
  ]);
  assert.deepEqual(edges(graph, 'associates'), []);
});

/** The six things a field says about the part it holds, and nothing else. */
const attribute = (symbols: readonly ParsedSymbol[], name: string) => {
  const symbol = symbols.find((candidate) => candidate.name === name);
  assert.ok(symbol, `no symbol named ${name} in ${symbols.map((s) => s.name).join(', ')}`);
  return {
    ...(symbol.typeName === undefined ? {} : { typeName: symbol.typeName }),
    ...(symbol.many === undefined ? {} : { many: symbol.many }),
    ...(symbol.optional === undefined ? {} : { optional: symbol.optional }),
    ...(symbol.composed === undefined ? {} : { composed: symbol.composed }),
    ...(symbol.handedIn === undefined ? {} : { handedIn: symbol.handedIn }),
    ...(symbol.typeStereotype === undefined ? {} : { typeStereotype: symbol.typeStereotype }),
  };
};

test('a field or property says whether the part may be absent and who builds it', () => {
  const { symbols } = parse(`
    namespace N;
    public class Engine<T>
    {
        private readonly Store _store = new Store();
        private Config _config;
        private Logger _log;
        private Cache? _cache;
        private List<Item> _items = new List<Item>();
        public Sink Sink { get; } = new Sink();
        public Peer? Peer { get; set; }
        public Widget Widget { get; init; }
        public Engine(Config config, Logger logger, Widget w) { _config = config; this._log = logger; _cache = new Cache(); this.Widget = w; }
        public Engine() { _config = new Config(); }
        public Result Run(Event e, List<Task> tasks, T t) => null;
        public U Gen<U>(U u, Store s) => u;
    }
    public record Pair(Left left, Right? right);
  `);
  assert.deepEqual(attribute(symbols, '_store'), { typeName: 'Store', composed: true });
  // Handed in by one constructor and built by the other: both, and the graph decides.
  assert.deepEqual(attribute(symbols, '_config'), { typeName: 'Config', composed: true, handedIn: true });
  assert.deepEqual(attribute(symbols, '_log'), { typeName: 'Logger', handedIn: true });
  assert.deepEqual(attribute(symbols, '_cache'), { typeName: 'Cache', optional: true, composed: true });
  // `new List<Item>()` builds the list, not an Item.
  assert.deepEqual(attribute(symbols, '_items'), { typeName: 'Item', many: true });
  assert.deepEqual(attribute(symbols, 'Sink'), { typeName: 'Sink', composed: true });
  assert.deepEqual(attribute(symbols, 'Peer'), { typeName: 'Peer', optional: true });
  assert.deepEqual(attribute(symbols, 'Widget'), { typeName: 'Widget', handedIn: true });
  const engine = symbols.find((symbol) => symbol.name === 'Engine');
  assert.deepEqual([...(engine?.dependsOn ?? [])].sort(), [
    'Config', 'Event', 'List', 'Logger', 'Result', 'Store', 'Task', 'Widget',
  ]);
  // A record's positional parameters arrive through its constructor by definition.
  assert.deepEqual(attribute(symbols, 'left'), { typeName: 'Left', handedIn: true });
  assert.deepEqual(attribute(symbols, 'right'), { typeName: 'Right', optional: true, handedIn: true });
});

test('a parameter the constructor reassigns is no longer what was handed in', () => {
  const { symbols } = parse(`class E {
  private Config config;
  public E(Config config) { config = new Config(); this.config = config; }
}`);
  const config = symbols.find((symbol) => symbol.name === 'config');
  assert.ok(config);
  assert.equal(config.handedIn, undefined);
});

test('a DbSet<T> property is many of T, and says T is a table', () => {
  const { symbols } = parse(`
    namespace Shop.Infrastructure;
    public class CatalogContext : DbContext
    {
        public DbSet<Basket> Baskets { get; set; }
        public List<Basket> Recent { get; set; }
        public DbSet<int> Counters { get; set; }
    }
  `);
  // Before this, the property's type was \`DbSet\`, which resolves to nothing:
  // a DbContext drew seven properties and no edge on eShopOnWeb.
  assert.deepEqual(attribute(symbols, 'Baskets'), { typeName: 'Basket', many: true, typeStereotype: 'table' });
  // The same shape without the word says nothing about tables.
  assert.deepEqual(attribute(symbols, 'Recent'), { typeName: 'Basket', many: true });
  // No type name to mark, so no mark.
  assert.deepEqual(attribute(symbols, 'Counters'), { many: true });
});

/** A view as the store receives it: Razor's own scanner, under a path. */
function razorFile(filePath: string, source: string): ParsedFile {
  return {
    filePath,
    language: 'razor',
    lineCount: source.split('\n').length,
    modifiedAt: 0,
    ...razor.scan(source),
  };
}

/**
 * The edge the WHY of the view-layer round was written about: on the user's own
 * MVC project a controller drew as a box that reached nothing, while it in fact
 * drives three pages.
 *
 * `return View()` names no file — the view is `Views/{Controller}/{Action}`,
 * falling back to `Views/Shared` — so C# writes down the two halves the call
 * site knows and razor.ts, which holds the view-location order, turns them into
 * a file. Measured through the store rather than off `imports`, because the
 * composition is what lied every previous time a unit test passed.
 */
test('an action returns a view, and the view is where the framework puts it', () => {
  const controller = parsedFile(
    'Controllers/HomeController.cs',
    `
    namespace Web.Controllers;
    public class HomeController : Controller
    {
        public IActionResult Index() { return View(); }
        public IActionResult Privacy() { return View(); }
        public IActionResult Error() { return View(); }
        public IActionResult About() { return View("Privacy"); }
        public IActionResult Detail() { return View(nameof(Privacy)); }
        public IActionResult Data() { return View(model); }
    }
  `,
  );

  const graph = graphOf(
    controller,
    razorFile('Views/Home/Index.cshtml', '<h1>Index</h1>\n'),
    razorFile('Views/Home/Privacy.cshtml', '<h1>Privacy</h1>\n'),
    // Not under Home: the framework looks in Shared next, and only next.
    razorFile('Views/Shared/Error.cshtml', '<h1>Error</h1>\n'),
  );

  assert.deepEqual(edges(graph, 'imports'), [
    'Controllers/HomeController.cs -> Views/Home/Index.cshtml',
    'Controllers/HomeController.cs -> Views/Home/Privacy.cshtml',
    'Controllers/HomeController.cs -> Views/Shared/Error.cshtml',
  ]);
  // `View(model)` names no view, so `Data` falls back to its own name — and
  // there is no Data.cshtml, so it draws nothing rather than drawing a guess.
  assert.ok(!controller.imports.includes('action:Home/Data.cshtml'));
  assert.deepEqual(
    controller.imports.filter((reference) => reference.startsWith('action:')),
    [
      'action:Home/Index',
      'action:Home/Privacy',
      'action:Home/Error',
      'action:Home/Privacy',
      'action:Home/Privacy',
      'action:Home/Data',
    ],
  );
});

test('a class that is not a controller returns no view, whatever it calls View on', () => {
  const { imports } = parse(`
    public class ViewHelper
    {
        public string Render() { return View("Index"); }
    }
  `);
  assert.deepEqual(imports.filter((reference) => reference.startsWith('action:')), []);
});

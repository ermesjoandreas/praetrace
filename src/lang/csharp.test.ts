import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { applyBatch, createStore } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ParsedFile } from '../parser/types.js';
import { csharp } from './csharp.js';

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

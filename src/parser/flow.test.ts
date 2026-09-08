/**
 * The flow of one function, pinned over real trees.
 *
 * Parsed with the real grammars rather than hand-built nodes, the way
 * `src/lang/typescript.test.ts` and `src/oracle/checker.test.ts` do it, because
 * the node shapes are the thing under test: which child an else lives in, where
 * a Java catch clause hangs, what a Go case calls its value. Each fixture is one
 * shape the diagram has to get right or say it left out.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type Parser from 'tree-sitter';
import { languageFor } from '../lang/registry.js';
import type { LanguageId } from '../lang/types.js';
import { flowOf, functionAt, hasFlowSyntax, type FlowGraph } from './flow.js';

const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

/** The grammar of a parsed language. Every language flowed here has one. */
function grammarOf(filePath: string): Parser.Language {
  const language = languageFor(filePath);
  assert.ok(language && 'grammar' in language, `no language with a grammar for ${filePath}`);
  return language.grammar(filePath) as Parser.Language;
}

/** Parse a fixture, find the function whose range the whole fixture is, and walk it. */
function flow(source: string, filePath = 'a.ts'): FlowGraph {
  const language = languageFor(filePath);
  assert.ok(language, `no language for ${filePath}`);
  const parser = new TreeSitter();
  parser.setLanguage(grammarOf(filePath));
  const root = parser.parse(source).rootNode;
  const lines = source.split('\n').length;
  const fn = functionAt(root, { startLine: 1, endLine: lines }, language.id);
  assert.ok(fn, `no function in:\n${source}`);
  const graph = flowOf(fn, language.id);
  assert.ok(graph, `no flow table for ${language.id}`);
  return graph;
}

/** Every node as `kind:label`, in the order they were made. */
function boxes(graph: FlowGraph): string[] {
  return graph.nodes.map((node) => `${node.kind}:${node.label}`);
}

/** Every edge as `from -label-> to`, by label rather than id, so a test reads like the diagram. */
function arrows(graph: FlowGraph): string[] {
  const label = new Map(graph.nodes.map((node) => [node.id, node.label]));
  return graph.edges.map((edge) => `${label.get(edge.from)} -${edge.label ?? ''}-> ${label.get(edge.to)}`);
}

test('an if/else is a decision with a yes and a no that meet again', () => {
  const graph = flow(`
    function f(x: number) {
      if (x > 0) {
        a()
      } else {
        b()
      }
      c()
    }
  `);
  assert.deepEqual(boxes(graph), ['start:start', 'decision:x > 0', 'action:a()', 'action:b()', 'action:c()', 'end:end']);
  assert.deepEqual(arrows(graph), [
    'start --> x > 0',
    'x > 0 -yes-> a()',
    'x > 0 -no-> b()',
    'a() --> c()',
    'b() --> c()',
    'c() --> end',
  ]);
  assert.deepEqual(graph.notDrawn, ['an exception thrown by a call is not an edge — only an explicit throw is']);
});

test('an if without an else falls through on no, and an else-if chains decisions', () => {
  const graph = flow(`
    function f(x: number) {
      if (x > 0) a()
      else if (x < 0) b()
      c()
    }
  `);
  assert.deepEqual(arrows(graph), [
    'start --> x > 0',
    'x > 0 -yes-> a()',
    'x > 0 -no-> x < 0',
    'x < 0 -yes-> b()',
    'a() --> c()',
    'b() --> c()',
    'x < 0 -no-> c()',
    'c() --> end',
  ]);
});

test('a loop with a break: the body loops back, the break leaves to after the loop', () => {
  const graph = flow(`
    function f(xs: number[]) {
      for (const x of xs) {
        if (x < 0) break
        use(x)
      }
      done()
    }
  `);
  assert.deepEqual(boxes(graph), [
    'start:start',
    'loop:for (const x of xs)',
    'decision:x < 0',
    'exit:break',
    'action:use(x)',
    'action:done()',
    'end:end',
  ]);
  assert.deepEqual(arrows(graph), [
    'start --> for (const x of xs)',
    'for (const x of xs) -yes-> x < 0',
    'x < 0 -yes-> break',
    'x < 0 -no-> use(x)',
    'use(x) --> for (const x of xs)',
    'for (const x of xs) -no-> done()',
    'break --> done()',
    'done() --> end',
  ]);
  const exit = graph.nodes.find((node) => node.kind === 'exit');
  assert.equal(exit?.exit, 'break');
});

test('continue goes back to the loop header; a while (true) has no way past', () => {
  const graph = flow(`
    function f() {
      while (true) {
        if (skip()) continue
        work()
      }
    }
  `);
  assert.deepEqual(arrows(graph), [
    'start --> while (true)',
    'while (true) -yes-> skip()',
    'skip() -yes-> continue',
    'continue --> while (true)',
    'skip() -no-> work()',
    'work() --> while (true)',
  ]);
  // Nothing reaches end: the function never returns, and the diagram says so
  // rather than drawing a `no` edge off a condition that is never false.
  assert.ok(!arrows(graph).some((arrow) => arrow.endsWith('-> end')));
});

test('a do loop enters the body first and tests after it', () => {
  const graph = flow(`
    function f() {
      do {
        step()
      } while (more())
      finish()
    }
  `);
  assert.deepEqual(boxes(graph), ['start:start', 'loop:do … while (more())', 'action:step()', 'action:finish()', 'end:end']);
  assert.deepEqual(arrows(graph), [
    'start --> step()',
    'do … while (more()) -yes-> step()',
    'step() --> do … while (more())',
    'do … while (more()) -no-> finish()',
    'finish() --> end',
  ]);
});

test('a try/catch: the catch hangs off the try, a throw inside goes to it, both meet in finally', () => {
  const graph = flow(`
    function f() {
      try {
        if (bad()) throw new Error('no')
        ok()
      } catch (e) {
        report(e)
      } finally {
        cleanup()
      }
    }
  `);
  assert.deepEqual(boxes(graph), [
    'start:start',
    'try:try',
    'try:catch (e)',
    'try:finally',
    'decision:bad()',
    "exit:throw new Error('no')",
    'action:ok()',
    'action:report(e)',
    'action:cleanup()',
    'end:end',
  ]);
  assert.deepEqual(arrows(graph), [
    'start --> try',
    'try -catch-> catch (e)',
    'try --> bad()',
    "bad() -yes-> throw new Error('no')",
    "throw new Error('no') --> catch (e)",
    'bad() -no-> ok()',
    'catch (e) --> report(e)',
    'ok() --> finally',
    'report(e) --> finally',
    'finally --> cleanup()',
    'cleanup() --> end',
  ]);
});

test('a return inside try runs the finally first, and leaves it with its own label', () => {
  const graph = flow(`
    function f() {
      try {
        return load()
      } catch (e) {
        return null
      } finally {
        release()
      }
    }
  `);
  // Nothing falls out of the try, so nothing reaches end but the two
  // returns — and both go through the finally, not around it: the finally
  // box used to float with no edge into it.
  assert.deepEqual(arrows(graph), [
    'start --> try',
    'try -catch-> catch (e)',
    'try --> return load()',
    'return load() --> finally',
    'catch (e) --> return null',
    'return null --> finally',
    'finally --> release()',
    'release() -return-> end',
  ]);
});

test('a break inside try/finally inside a loop runs the finally, then leaves the loop', () => {
  const graph = flow(`
    function f(xs: number[]) {
      for (const x of xs) {
        try {
          if (x < 0) break
          use(x)
        } finally {
          tick()
        }
      }
      done()
    }
  `);
  assert.deepEqual(arrows(graph), [
    'start --> for (const x of xs)',
    'for (const x of xs) -yes-> try',
    'try --> x < 0',
    'x < 0 -yes-> break',
    'break --> finally',
    'x < 0 -no-> use(x)',
    'use(x) --> finally',
    'finally --> tick()',
    'tick() --> for (const x of xs)',
    'for (const x of xs) -no-> done()',
    'tick() -break-> done()',
    'done() --> end',
  ]);
});

test('a syntax error is said, and the statement tree-sitter invented is not a box', () => {
  const graph = flow(
    `
    class A {
      boolean f() {
        if (juni || juli || august)
      }
    }
  `,
    'A.java',
  );
  assert.deepEqual(boxes(graph), ['start:start', 'decision:juni || juli || august', 'end:end']);
  assert.ok(graph.nodes.every((node) => node.label !== ''));
  assert.ok(graph.notDrawn.includes('the source has a syntax error inside this function; what tree-sitter could not read is not drawn (1)'));
});

test('a throw outside any try goes to end', () => {
  const graph = flow(`
    function f(x: unknown) {
      if (!x) throw new TypeError('x')
      return x
    }
  `);
  assert.deepEqual(arrows(graph), [
    'start --> !x',
    "!x -yes-> throw new TypeError('x')",
    "throw new TypeError('x') --> end",
    '!x -no-> return x',
    'return x --> end',
  ]);
});

test('early returns each go to end, and the run after the last decision is one box', () => {
  const graph = flow(`
    function f(x: number | null) {
      if (x === null) return 'none'
      if (x < 0) {
        return 'negative'
      }
      const a = x * 2
      const b = a + 1
      log(b)
      return b
    }
  `);
  assert.deepEqual(boxes(graph), [
    'start:start',
    'decision:x === null',
    "exit:return 'none'",
    'decision:x < 0',
    "exit:return 'negative'",
    'action:const a = x * 2',
    'exit:return b',
    'end:end',
  ]);
  const run = graph.nodes.find((node) => node.label === 'const a = x * 2');
  assert.equal(run?.more, 2, 'three plain statements are one box and "+2 more"');
  assert.deepEqual(run?.range, { startLine: 7, endLine: 9 });
  assert.deepEqual(arrows(graph), [
    'start --> x === null',
    "x === null -yes-> return 'none'",
    "return 'none' --> end",
    'x === null -no-> x < 0',
    "x < 0 -yes-> return 'negative'",
    "return 'negative' --> end",
    'x < 0 -no-> const a = x * 2',
    'const a = x * 2 --> return b',
    'return b --> end',
  ]);
});

test('a callback is not walked: the call is one box that says so, and notDrawn counts it', () => {
  const graph = flow(`
    function f(xs: number[]) {
      const before = 1
      const out = xs.map((x) => {
        if (x > 0) return x
        return -x
      })
      const after = 2
      return out
    }
  `);
  // The callback's `if` is not this function's decision, so the whole body
  // is: a run, the call, a run, the return. Four boxes, not seven.
  assert.deepEqual(boxes(graph), [
    'start:start',
    'action:const before = 1',
    'action:const out = xs.map((x) => { …',
    'action:const after = 2',
    'exit:return out',
    'end:end',
  ]);
  const call = graph.nodes.find((node) => node.label.startsWith('const out'));
  assert.equal(call?.note, 'calls with a function as an argument — its body is a separate function, not walked');
  assert.deepEqual(call?.range, { startLine: 4, endLine: 7 });
  assert.ok(graph.notDrawn.includes('1 function body inside this one is not walked — each is a separate function'));
});

test('a nested function declaration is a box that says it is nested, and its branches are not drawn', () => {
  const graph = flow(`
    function f() {
      function helper(y: number) {
        if (y) return 1
        return 2
      }
      return helper(1)
    }
  `);
  assert.deepEqual(boxes(graph), ['start:start', 'action:function helper(y: number) { …', 'exit:return helper(1)', 'end:end']);
  assert.equal(graph.nodes[1]?.note, 'a nested function — a separate function, not walked');
});

test('await is not a branch, and is said to be absent', () => {
  const graph = flow(`
    async function f() {
      const a = await load()
      const b = await load()
      return a + b
    }
  `);
  assert.deepEqual(boxes(graph), ['start:start', 'action:const a = await load()', 'exit:return a + b', 'end:end']);
  assert.ok(graph.notDrawn.includes('2 await: waiting is not a branch, and none is drawn'));
});

test('a switch is a decision with one labelled edge per case, fallthrough included', () => {
  const graph = flow(`
    function f(k: string) {
      switch (k) {
        case 'a':
        case 'b':
          ab()
          break
        case 'c':
          c()
        default:
          d()
      }
      after()
    }
  `);
  assert.deepEqual(boxes(graph), [
    'start:start',
    'decision:k',
    'action:ab()',
    'exit:break',
    'action:c()',
    'action:d()',
    'action:after()',
    'end:end',
  ]);
  assert.deepEqual(arrows(graph), [
    'start --> k',
    "k -'b'-> ab()",
    "k -'a'-> ab()",
    'ab() --> break',
    "k -'c'-> c()",
    'k -default-> d()',
    'c() --> d()',
    'd() --> after()',
    'break --> after()',
    'after() --> end',
  ]);
});

test('a switch without a default has an else edge past it', () => {
  const graph = flow(`
    function f(k: number) {
      switch (k) {
        case 1: one(); break
      }
      after()
    }
  `);
  assert.ok(arrows(graph).includes('k -else-> after()'));
});

test('a ternary that is the whole statement is a decision; one inside an expression is counted, not drawn', () => {
  const graph = flow(`
    function f(x: number) {
      const sign = x < 0 ? 'neg' : 'pos'
      log(x ? 1 : 2)
      return x > 10 ? 'big' : 'small'
    }
  `);
  assert.deepEqual(boxes(graph), [
    'start:start',
    'decision:x < 0',
    "action:const sign = 'neg'",
    "action:const sign = 'pos'",
    'action:log(x ? 1 : 2)',
    'decision:x > 10',
    "exit:return 'big'",
    "exit:return 'small'",
    'end:end',
  ]);
  assert.ok(graph.notDrawn.includes('1 ternary inside a larger expression is not a branch here'));
});

test('an arrow with an expression body is one action, and its range is the arrow', () => {
  const graph = flow(`const double = (x: number) => x * 2`);
  assert.deepEqual(boxes(graph), ['start:start', 'action:x * 2', 'end:end']);
});

test('a method is found by its range inside a class, and this.x calls are plain', () => {
  const source = `
    class Store {
      private items: number[] = []
      add(x: number) {
        if (this.items.includes(x)) return false
        this.items.push(x)
        return true
      }
    }
  `;
  const parser = new TreeSitter();
  parser.setLanguage(grammarOf('a.ts'));
  const root = parser.parse(source).rootNode;
  const fn = functionAt(root, { startLine: 4, endLine: 8 }, 'typescript');
  assert.equal(fn?.type, 'method_definition');
  const graph = flowOf(fn!, 'typescript');
  assert.deepEqual(boxes(graph!), [
    'start:start',
    'decision:this.items.includes(x)',
    'exit:return false',
    'action:this.items.push(x)',
    'exit:return true',
    'end:end',
  ]);
  // A field on the same lines is not a function, and a signature has no body.
  assert.equal(functionAt(root, { startLine: 3, endLine: 3 }, 'typescript'), null);
});

test('a language without a table answers null, never a diagram', () => {
  const ids: LanguageId[] = ['typescript', 'javascript', 'java', 'go', 'csharp', 'rust', 'python'];
  assert.deepEqual(
    ids.filter((id) => hasFlowSyntax(id)),
    ['typescript', 'javascript', 'java', 'go'],
  );
  const parser = new TreeSitter();
  parser.setLanguage(grammarOf('a.py'));
  const root = parser.parse('def f(x):\n    if x:\n        return 1\n    return 2\n').rootNode;
  assert.equal(functionAt(root, { startLine: 1, endLine: 4 }, 'python'), null);
});

test('JavaScript shares the table: the same if/else draws the same', () => {
  const graph = flow(
    `
    function f(x) {
      if (x) { a() } else { b() }
    }
  `,
    'a.js',
  );
  assert.deepEqual(arrows(graph), ['start --> x', 'x -yes-> a()', 'x -no-> b()', 'a() --> end', 'b() --> end']);
});

test('Java: enhanced for, a labelled break, two catch clauses, and a colon-switch that falls through', () => {
  const graph = flow(
    `
    class A {
      int f(int[] xs, int k) {
        outer:
        for (int x : xs) {
          if (x < 0) break outer;
        }
        try {
          risky();
        } catch (IOException e) {
          log(e);
        } catch (RuntimeException e) {
          rethrow(e);
        }
        switch (k) {
          case 1, 2:
            a();
          default:
            b();
        }
        return k > 0 ? 1 : 0;
      }
    }
  `,
    'A.java',
  );
  assert.deepEqual(boxes(graph), [
    'start:start',
    'loop:for (int x : xs)',
    'decision:x < 0',
    'exit:break outer',
    'try:try',
    'try:catch (IOException e)',
    'try:catch (RuntimeException e)',
    'action:risky()',
    'action:log(e)',
    'action:rethrow(e)',
    'decision:k',
    'action:a()',
    'action:b()',
    'decision:k > 0',
    'exit:return 1',
    'exit:return 0',
    'end:end',
  ]);
  assert.deepEqual(arrows(graph), [
    'start --> for (int x : xs)',
    'for (int x : xs) -yes-> x < 0',
    'x < 0 -yes-> break outer',
    'x < 0 -no-> for (int x : xs)',
    'for (int x : xs) -no-> try',
    'break outer --> try',
    'try -catch-> catch (IOException e)',
    'try -catch-> catch (RuntimeException e)',
    'try --> risky()',
    'catch (IOException e) --> log(e)',
    'catch (RuntimeException e) --> rethrow(e)',
    'risky() --> k',
    'log(e) --> k',
    'rethrow(e) --> k',
    'k -1, 2-> a()',
    'k -default-> b()',
    'a() --> b()',
    'b() --> k > 0',
    'k > 0 -yes-> return 1',
    'return 1 --> end',
    'k > 0 -no-> return 0',
    'return 0 --> end',
  ]);
});

test('Java: a throw inside a try with several catches goes to end, and says why', () => {
  const graph = flow(
    `
    class A {
      void f() {
        try {
          throw new IOException();
        } catch (IOException e) {
        } catch (RuntimeException e) {
        }
      }
    }
  `,
    'A.java',
  );
  assert.ok(arrows(graph).includes('throw new IOException() --> end'));
  assert.ok(graph.notDrawn.includes('1 throw inside a try with several catch clauses goes to end: which clause takes it depends on the type'));
});

test('Go: a range loop, an if with an initializer, a switch with fallthrough, a select, and defer', () => {
  const graph = flow(
    `
    package a

    func f(xs []int) error {
      for _, x := range xs {
        if err := check(x); err != nil {
          return err
        }
      }
      switch n := len(xs); n {
      case 0:
        empty()
        fallthrough
      case 1:
        small()
      default:
        big()
      }
      select {
      case m := <-ch:
        got(m)
      }
      defer close()
      return nil
    }
  `,
    'a.go',
  );
  assert.deepEqual(boxes(graph), [
    'start:start',
    'loop:for _, x := range xs',
    'decision:err := check(x); err != nil',
    'exit:return err',
    'decision:n := len(xs); n',
    'action:empty()',
    'action:small()',
    'action:big()',
    'decision:select',
    'action:got(m)',
    'action:defer close()',
    'exit:return nil',
    'end:end',
  ]);
  assert.deepEqual(arrows(graph), [
    'start --> for _, x := range xs',
    'for _, x := range xs -yes-> err := check(x); err != nil',
    'err := check(x); err != nil -yes-> return err',
    'return err --> end',
    'err := check(x); err != nil -no-> for _, x := range xs',
    'for _, x := range xs -no-> n := len(xs); n',
    'n := len(xs); n -0-> empty()',
    'n := len(xs); n -1-> small()',
    'empty() --> small()',
    'n := len(xs); n -default-> big()',
    'small() --> select',
    'big() --> select',
    'select -m := <-ch-> got(m)',
    'got(m) --> defer close()',
    'defer close() --> return nil',
    'return nil --> end',
  ]);
  assert.ok(graph.notDrawn.includes('1 defer runs when the function returns, and is drawn where written'));
});

test('Go: a bare for never falls out, and a func literal handed to go is one box with a note', () => {
  const graph = flow(
    `
    package a

    func f() {
      for {
        go func() { work() }()
      }
    }
  `,
    'a.go',
  );
  assert.deepEqual(arrows(graph), ['start --> for', 'for -yes-> go func() { work() }()', 'go func() { work() }() --> for']);
  assert.equal(graph.nodes[2]?.note, 'calls with a function as an argument — its body is a separate function, not walked');
});

test('every node carries a line range the page can open', () => {
  const graph = flow(`
    function f(x: number) {
      if (x) {
        a()
      }
      return x
    }
  `);
  for (const node of graph.nodes) {
    assert.ok(node.range.startLine >= 1 && node.range.endLine >= node.range.startLine, `${node.label}: ${JSON.stringify(node.range)}`);
  }
  assert.deepEqual(graph.nodes.map((node) => [node.label, node.range.startLine]), [
    ['start', 2],
    ['x', 3],
    ['a()', 4],
    ['return x', 6],
    ['end', 7],
  ]);
});

test('Java: a switch used as an expression is counted as not drawn, not lost', () => {
  const graph = flow(
    `
    class A {
      int f(int k) {
        int x = switch (k) { case 1 -> 10; default -> 0; };
        return x;
      }
    }
  `,
    'A.java',
  );
  assert.deepEqual(boxes(graph), ['start:start', 'action:int x = switch (k) { case 1 -> 10; default -> 0; }', 'exit:return x', 'end:end']);
  assert.ok(graph.notDrawn.includes('1 switch inside a larger expression is not a branch here'));
});

test('a function handed to a call is never the flow of the symbol whose line it sits on', () => {
  // `items = xs.map((x) => …)` puts an arrow on the field's own line, and the
  // route once served that arrow's flow as the flow of `items`.
  const source = 'class B { items = xs.map((x: number) => { if (x > 0) return x; return -x; }); }';
  const parser = new TreeSitter();
  const language = languageFor('a.ts');
  assert.ok(language);
  parser.setLanguage(grammarOf('a.ts'));
  const root = parser.parse(source).rootNode;
  assert.equal(functionAt(root, { startLine: 1, endLine: 1 }, language.id), null);
});

test('a finally that returns on its own replaces the return it was carrying', () => {
  const graph = flow(`function f() {
  try { return a(); } finally { return b(); }
}`);
  // Every path through the finally passes `return b()`; an edge out of the
  // finally box for the try's return would be a path no run takes.
  const out = arrows(graph).filter((arrow) => arrow.startsWith('finally -'));
  assert.deepEqual(out, ['finally --> return b()']);
});

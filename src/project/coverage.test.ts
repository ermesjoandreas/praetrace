import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { Graph, GraphNode, NodeKind } from '../graph/types.js';
import { joinCoverage, parseIstanbul, parseLcov, readCoverage } from './coverage.js';

const ROOT = '/repo';

function node(id: string, kind: NodeKind, startLine: number, endLine: number): GraphNode {
  const hash = id.indexOf('#');
  return {
    id,
    kind,
    name: hash === -1 ? path.posix.basename(id) : id.slice(hash + 1),
    filePath: hash === -1 ? id : id.slice(0, hash),
    range: { startLine, endLine },
  };
}

function graphOf(...nodes: GraphNode[]): Graph {
  return { nodes: new Map(nodes.map((one) => [one.id, one])), edges: [] };
}

/** An lcov record, written the way istanbul's lcovonly reporter writes one. */
function record(file: string, body: string[]): string {
  return ['TN:', `SF:${file}`, ...body, 'end_of_record', ''].join('\n');
}

test('lcov: lines, functions and their hits come back as the report wrote them', () => {
  // express's lib/application.js, trimmed. FN and FNDA are separate lists.
  const measurement = parseLcov(
    record('lib/application.js', [
      'FN:59,init',
      'FN:152,handle',
      'FN:219,(anonymous_6)',
      'FNF:3',
      'FNH:2',
      'FNDA:963,init',
      'FNDA:1170,handle',
      'FNDA:0,(anonymous_6)',
      'DA:59,963',
      'DA:60,963',
      'DA:220,0',
    ]),
  );

  const file = measurement.get('lib/application.js');
  assert.ok(file);
  assert.deepEqual(file.functions, [
    { line: 59, hits: 963 },
    { line: 152, hits: 1170 },
    { line: 219, hits: 0 },
  ]);
  assert.equal(file.lines.size, 3);
  assert.equal(file.lines.get(220), 0);
});

test('lcov: a repeated function name pairs with its own count, in order', () => {
  // A name is not unique inside a file, so FN and FNDA can only be matched
  // positionally within the name. Pairing by name alone gave both `done`s the
  // first count.
  const measurement = parseLcov(
    record('lib/view.js', ['FN:10,done', 'FN:40,done', 'FNDA:7,done', 'FNDA:0,done']),
  );
  assert.deepEqual(measurement.get('lib/view.js')?.functions, [
    { line: 10, hits: 7 },
    { line: 40, hits: 0 },
  ]);
});

test('lcov: a name may hold a comma, a DA may hold a checksum, and a missing FNDA is zero', () => {
  const measurement = parseLcov(
    record('src/a.ts', ['FN:5,fn<A, B>', 'FN:9,lonely', 'FNDA:3,fn<A, B>', 'DA:5,3,f0e9b1']),
  );
  const file = measurement.get('src/a.ts');
  assert.deepEqual(file?.functions, [
    { line: 5, hits: 3 },
    { line: 9, hits: 0 },
  ]);
  assert.equal(file?.lines.get(5), 3);
});

test('istanbul: a line takes the highest count of the statements starting on it', () => {
  // `getLineCoverage`'s own rule. Two statements share line 4; the line ran.
  const measurement = parseIstanbul(
    JSON.stringify({
      '/repo/src/a.ts': {
        statementMap: {
          '0': { start: { line: 4, column: 0 }, end: { line: 4, column: 9 } },
          '1': { start: { line: 4, column: 11 }, end: { line: 4, column: 20 } },
          '2': { start: { line: 7, column: 0 }, end: { line: 7, column: 4 } },
        },
        s: { '0': 0, '1': 12, '2': 0 },
        fnMap: {
          '0': { name: 'run', decl: { start: { line: 6, column: 9 } }, line: 6 },
        },
        f: { '0': 2 },
      },
    }),
  );
  const file = measurement.get('/repo/src/a.ts');
  assert.equal(file?.lines.get(4), 12);
  assert.equal(file?.lines.get(7), 0);
  assert.deepEqual(file?.functions, [{ line: 6, hits: 2 }]);
});

test('absent is not zero: a file the run never imported leaves its symbols unknown', () => {
  // Vitest 4 dropped `coverage.all`, so only the files a run imported appear —
  // 16 of zod's 135 source files never do. nyc drops whatever the script
  // excluded, 74 of express's 145 symbols. Neither is untested code.
  const graph = graphOf(
    node('src/a.ts', 'file', 1, 20),
    node('src/a.ts#used', 'function', 3, 6),
    node('src/never-imported.ts', 'file', 1, 30),
    node('src/never-imported.ts#quiet', 'function', 2, 8),
  );

  const { files, symbols } = joinCoverage(
    parseLcov(record('src/a.ts', ['FN:3,used', 'FNDA:5,used', 'DA:3,5', 'DA:4,0'])),
    graph,
    ROOT,
  );

  assert.equal(symbols['src/a.ts#used'], 'covered');
  assert.equal(symbols['src/never-imported.ts#quiet'], 'unknown');
  assert.deepEqual(Object.keys(files), ['src/a.ts']);
  assert.equal(files['src/never-imported.ts'], undefined);
});

test('absent is not zero, inside a measured file too: no function record is unknown, not never', () => {
  const graph = graphOf(
    node('src/a.ts', 'file', 1, 20),
    node('src/a.ts#helper', 'function', 12, 18),
  );
  const { symbols } = joinCoverage(parseLcov(record('src/a.ts', ['DA:1,1'])), graph, ROOT);
  assert.equal(symbols['src/a.ts#helper'], 'unknown');
});

test('function hits for a symbol, lines for a file: a defined function is not a called one', () => {
  // express's `res.download`. Every line of the assignment runs at module
  // load, so joining executed statement lines gave it 87 of 88; the function
  // record says it was entered twice — and here, never.
  const graph = graphOf(
    node('lib/response.js', 'file', 1, 6),
    node('lib/response.js#res.download', 'function', 2, 5),
  );
  const { files, symbols } = joinCoverage(
    parseLcov(
      record('lib/response.js', [
        'FN:2,download',
        'FNDA:0,download',
        // The assignment and its body's lines are all "executed": the
        // statement that defines the function ran when the module loaded.
        'DA:1,88',
        'DA:2,88',
        'DA:3,88',
        'DA:4,88',
        'DA:5,88',
        'DA:6,88',
      ]),
    ),
    graph,
    ROOT,
  );

  assert.equal(symbols['lib/response.js#res.download'], 'never');
  // The file is honestly well covered at the same time. Both are true; they
  // are answers to different questions.
  assert.deepEqual(files['lib/response.js'], { lines: 6, covered: 6 });
});

test('most of a graph cannot carry a number: fields, interfaces and types are unknown', () => {
  // Of zod's 3541 symbols only 1124 join. A field is not a function, an
  // interface is erased, and a type never reaches the runtime at all — that is
  // what coverage means here, not a gap in the report.
  const graph = graphOf(
    node('src/store.ts', 'file', 1, 40),
    node('src/store.ts#Options', 'interface', 3, 6),
    node('src/store.ts#Key', 'type', 8, 8),
    node('src/store.ts#Store', 'class', 10, 30),
    node('src/store.ts#Store.logger', 'field', 11, 11),
    node('src/store.ts#Store.write', 'method', 13, 20),
  );
  const { symbols } = joinCoverage(
    parseLcov(record('src/store.ts', ['FN:13,write', 'FNDA:4,write', 'DA:13,4'])),
    graph,
    ROOT,
  );

  assert.equal(symbols['src/store.ts#Store.write'], 'covered');
  for (const id of ['src/store.ts#Options', 'src/store.ts#Key', 'src/store.ts#Store.logger']) {
    assert.equal(symbols[id], 'unknown', id);
  }
  // Nothing is declared on line 10, where the class is. Reading `write`'s
  // count off the range that contains it would call a declaration covered.
  assert.equal(symbols['src/store.ts#Store'], 'unknown');
});

test('a symbol is measured where it is declared, never by something nested in it', () => {
  // zod's `ZodType` read "covered" off a callback on line 247 of a class that
  // starts at 158, because a class's range spans everything in it. A method's
  // range spans its closures the same way.
  const graph = graphOf(
    node('src/q.ts', 'file', 1, 30),
    node('src/q.ts#Queue', 'class', 1, 30),
    node('src/q.ts#Queue.drain', 'method', 5, 20),
  );
  const { symbols } = joinCoverage(
    parseLcov(
      record('src/q.ts', [
        'FN:5,drain',
        'FN:9,(anonymous_1)',
        'FNDA:0,drain',
        'FNDA:11,(anonymous_1)',
      ]),
    ),
    graph,
    ROOT,
  );
  // The closure's count is not the method's, and neither is the class's.
  assert.equal(symbols['src/q.ts#Queue.drain'], 'never');
  assert.equal(symbols['src/q.ts#Queue'], 'unknown');
});

test('a class joins on its own line when the report declares a constructor there', () => {
  // zod's `ParseStatus`: `FN:92,ParseStatus` with 1912 hits, and 92 is where
  // the class is written. A class with nothing declared on its own line stays
  // unknown — its methods are what carry numbers.
  const graph = graphOf(
    node('src/parse.ts', 'file', 1, 60),
    node('src/parse.ts#ParseStatus', 'class', 10, 40),
    node('src/parse.ts#Bare', 'class', 45, 55),
    node('src/parse.ts#Bare.run', 'method', 47, 50),
  );
  const { symbols } = joinCoverage(
    parseLcov(
      record('src/parse.ts', [
        'FN:10,ParseStatus',
        'FN:47,run',
        'FNDA:1912,ParseStatus',
        'FNDA:3,run',
      ]),
    ),
    graph,
    ROOT,
  );
  assert.equal(symbols['src/parse.ts#ParseStatus'], 'covered');
  assert.equal(symbols['src/parse.ts#Bare'], 'unknown');
  assert.equal(symbols['src/parse.ts#Bare.run'], 'covered');
});

test('a namespace or an enum joins on the IIFE the compiler writes on its first line', () => {
  // `export enum ZodFirstPartyTypeKind {}` at zod's compat.ts:78 is parsed as
  // a `type` node and the v8 report really does declare a function there. The
  // kind of a node decides nothing here; what the report says at its line does.
  const graph = graphOf(
    node('src/util.ts', 'file', 1, 90),
    node('src/util.ts#util', 'type', 1, 79),
    node('src/util.ts#Shape', 'type', 81, 81),
    node('src/util.ts#Options', 'interface', 83, 88),
  );
  const { symbols } = joinCoverage(
    parseLcov(record('src/util.ts', ['FN:1,(anonymous_0)', 'FNDA:57,(anonymous_0)'])),
    graph,
    ROOT,
  );
  assert.equal(symbols['src/util.ts#util'], 'covered');
  assert.equal(symbols['src/util.ts#Shape'], 'unknown');
  assert.equal(symbols['src/util.ts#Options'], 'unknown');
});

test('a report covering node_modules or a sibling checkout contributes nothing', () => {
  const graph = graphOf(node('src/a.ts', 'file', 1, 3), node('src/a.ts#f', 'function', 1, 3));
  const outside = parseIstanbul(
    JSON.stringify({
      '/repo/node_modules/dep/index.js': {
        statementMap: { '0': { start: { line: 1 } } },
        s: { '0': 4 },
        fnMap: {},
        f: {},
      },
      '/elsewhere/other/src/a.ts': {
        statementMap: { '0': { start: { line: 1 } } },
        s: { '0': 4 },
        fnMap: { '0': { name: 'f', decl: { start: { line: 1 } } } },
        f: { '0': 9 },
      },
    }),
  );
  const { files, symbols } = joinCoverage(outside, graph, ROOT);
  assert.deepEqual(files, {});
  assert.equal(symbols['src/a.ts#f'], 'unknown');
});

test('readCoverage: lcov wins over the JSON, and an empty artefact is skipped for the next', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-coverage-'));
  try {
    const graph = graphOf(node('src/a.ts', 'file', 1, 9), node('src/a.ts#f', 'function', 2, 5));
    await mkdir(path.join(root, 'coverage'));

    // A run that crashed before writing leaves a zero-byte lcov.info beside a
    // usable JSON — observed on vitest 4 with a mismatched provider.
    await writeFile(path.join(root, 'coverage', 'lcov.info'), '');
    // The key is written under the root as given, which on macOS is the
    // `/var/folders` name of a `/private/var/folders` directory — the symlink
    // both a report and an opened project can be on either side of.
    await writeFile(
      path.join(root, 'coverage', 'coverage-final.json'),
      JSON.stringify({
        [path.join(root, 'src/a.ts')]: {
          statementMap: { '0': { start: { line: 2 } } },
          s: { '0': 3 },
          fnMap: { '0': { name: 'f', decl: { start: { line: 2 } } } },
          f: { '0': 3 },
        },
      }),
    );

    const skipped = await readCoverage(root, graph);
    assert.equal(skipped?.source, 'coverage/coverage-final.json');
    assert.equal(skipped?.symbols['src/a.ts#f'], 'covered');
    assert.ok((skipped?.at ?? 0) > 0);

    // With something in it, lcov is preferred: it is a tenth of the size and
    // says the same thing.
    await writeFile(
      path.join(root, 'coverage', 'lcov.info'),
      record('src/a.ts', ['FN:2,f', 'FNDA:0,f', 'DA:2,1']),
    );
    const preferred = await readCoverage(root, graph);
    assert.equal(preferred?.source, 'coverage/lcov.info');
    assert.equal(preferred?.symbols['src/a.ts#f'], 'never');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('readCoverage: a project with no coverage, and unreadable rubbish, both answer null', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-coverage-'));
  try {
    const graph = graphOf(node('src/a.ts', 'file', 1, 9));
    assert.equal(await readCoverage(root, graph), null);

    // A missing project is a missing feature, not an error — git.ts's rule.
    assert.equal(await readCoverage(path.join(root, 'gone'), graph), null);

    await mkdir(path.join(root, 'coverage'));
    await writeFile(path.join(root, 'coverage', 'coverage-final.json'), 'not json {');
    await writeFile(path.join(root, 'coverage', 'lcov.info'), 'nothing lcov understands\n');
    assert.equal(await readCoverage(root, graph), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

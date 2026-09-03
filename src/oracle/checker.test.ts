/**
 * The checker, run over a fixture written for it, as a test that can be run
 * again.
 *
 * Every check in DECISIONS.md is a scratch script that was run once and thrown
 * away, so nothing in it can be re-run to see whether it still holds. This is
 * the same measurement as `scripts/oracle.mjs` makes against a real repository,
 * pinned to thirteen files small enough to read — a barrel, a typed receiver, a
 * name rebound over an import, a call at the top level, a class hierarchy, a
 * `#private` member and a function with a function hung off it. Each is in the
 * fixture because the graph has been wrong about it.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyBatch, createStore } from '../graph/store.js';
import type { Graph, GraphNode } from '../graph/types.js';
import { parseSource } from '../parser/extract.js';
import { findSourceFiles } from '../project/walk.js';
import { isTestFile } from '../view/tests.js';
import { compareEdges, type OracleEdge, type OracleReading, readWithChecker } from './checker.js';

/**
 * Read from `src/`, not from beside this compiled test: tsconfig excludes the
 * directory, so there is nothing beside it. A JavaScript copy of the fixture
 * would be a different language with different edges, and the point of the
 * fixture is the sources.
 *
 * `fixtures`, plural, because that is the segment `view/tests.ts` knows. Named
 * `fixture` it was thirteen files of deliberately odd code that the clustering
 * voted with, the status bar counted and `?tests=0` could not hide.
 *
 * Two directories under it, because they are read for opposite reasons:
 * `graph` is the comparison, and every file in it must be vouched for;
 * `unchecked` is one file that must not be.
 */
const FIXTURE = fileURLToPath(new URL('../../src/oracle/fixtures/graph', import.meta.url));
const UNCHECKED = fileURLToPath(new URL('../../src/oracle/fixtures/unchecked', import.meta.url));

const scanned = async (root: string): Promise<string[]> =>
  (await findSourceFiles(root)).map((file) => file.filePath).sort();

/**
 * The differences that are supposed to be there, each one a limitation this
 * fixture exists to hold still. A difference not on this list fails the test:
 * an edge the checker has and we do not is a gap nobody has named, and an edge
 * we have and the checker does not is a lie until someone classifies it.
 */
const KNOWN_GAPS: readonly string[] = [
  // `memberOf` looks only at what the owner itself declares, so a call to a
  // member a class inherits reaches nothing. zod's $ZodType hierarchy loses
  // hundreds of edges to this.
  'disk.ts#Disk.save calls -> base.ts#Base.close',
  // A function's own properties are not in the file's name table: `app` is a
  // function declaration and not a typed binding, so `app.init()` inside the
  // file that defines it names nothing. All of express's lib is this shape.
  'property.js#boot calls -> property.js#app.init',
  // `receiverOf` names `this`, an identifier and `this.field`, and nothing
  // else — so a call chained straight onto a construction has no receiver.
  'shadow.ts#frame calls -> view.ts#View.render',
];

async function fixtureGraph(root: string): Promise<Graph> {
  const files = await findSourceFiles(root);
  const parsed = await Promise.all(
    files.map(async (file) => parseSource(file.filePath, await readFile(file.absolutePath, 'utf8'))),
  );
  const store = createStore();
  applyBatch(store, parsed, []);
  return store.graph;
}

const spell = (edge: OracleEdge): string => `${edge.from} ${edge.kind} -> ${edge.to}`;

test('every file under here is a test file to the rest of the tool, by its path alone', async () => {
  const root = fileURLToPath(new URL('../../src', import.meta.url));
  const here = (await findSourceFiles(root))
    .map((file) => `src/${file.filePath}`)
    .filter((file) => file.startsWith('src/oracle/') && !file.startsWith('src/oracle/checker'));

  // The doc comment above FIXTURE says why the segment is `fixtures`; this is
  // what makes that a fact rather than an intention. Named `fixture` the
  // thirteen files voted in the clustering, counted in the status bar and
  // survived `?tests=0` — deliberately odd code presented as this project's
  // architecture. A rename that misses `view/tests.ts` puts it straight back.
  assert.ok(here.length > 0, 'the fixtures moved, and this test is now checking nothing');
  assert.deepEqual(here.filter((file) => !isTestFile(file)), []);
});

test('the checker vouches for every fixture file before any of it is compared', async () => {
  const reading = readWithChecker(FIXTURE, await scanned(FIXTURE));

  // A checker that cannot see a module answers "no reference here" in the same
  // voice it uses for "nothing to report", so a fixture file with a diagnostic
  // would quietly turn into a recall problem of ours.
  assert.deepEqual(reading.skipped, [], 'a fixture file the checker could not type-check proves nothing');
  assert.equal(reading.compared.length, 13);
  assert.ok(reading.edges.length > 20, `the checker found only ${reading.edges.length} edges`);
});

test('the graph and the checker agree on the fixture, edge for edge', async () => {
  const graph = await fixtureGraph(FIXTURE);
  const reading = readWithChecker(FIXTURE, await scanned(FIXTURE));
  const comparison = compareEdges(graph, reading);

  assert.deepEqual(
    comparison.onlyOurs.map(spell).sort(),
    [],
    'an edge the checker cannot confirm is a lie until someone classifies it here',
  );
  assert.deepEqual(
    comparison.onlyChecker.map(({ edge }) => spell(edge)).sort(),
    [...KNOWN_GAPS].sort(),
    'a difference that is not on the KNOWN_GAPS list is either a new gap or a closed one',
  );
  assert.equal(comparison.precision, 1);
});

test('a JavaScript file whose modules the checker cannot find is refused, not vouched for', async () => {
  const reading = readWithChecker(UNCHECKED, await scanned(UNCHECKED));

  // `checkJs` is off, so getSemanticDiagnostics answers nothing for either of
  // these however blind the program is: before the resolution check both came
  // back compared, with zero skipped and a precision the checker had not
  // earned. blind.js names two modules that are not there; caller.js names one
  // that is, and is compared as usual.
  assert.deepEqual(
    reading.skipped.map(({ file, code }) => `${file} ${code}`),
    ['blind.js 2307'],
    'an unchecked file whose imports resolve to nothing must not be compared',
  );
  assert.deepEqual(reading.compared, ['caller.js']);
});

/** A reading with no checker in it, for the pure half of the comparison. */
function reading(edges: readonly OracleEdge[], compared: readonly string[]): OracleReading {
  return { compared: [...compared], skipped: [], edges: [...edges], unnamable: [], ms: 0 };
}

/** A graph spelled as ids, which is all the comparison reads. */
function graphOf(files: readonly string[], symbols: readonly string[], edges: readonly OracleEdge[]): Graph {
  const nodes = new Map<string, GraphNode>();
  const range = { startLine: 1, endLine: 1 };
  for (const file of files) nodes.set(file, { id: file, kind: 'file', name: file, filePath: file, range });
  for (const id of symbols) {
    const hash = id.indexOf('#');
    nodes.set(id, {
      id,
      kind: 'function',
      name: id.slice(hash + 1),
      filePath: id.slice(0, hash),
      range,
    });
  }
  return { nodes, edges: edges.map(({ from, to, kind }) => ({ from, to, kind })) };
}

test('a file the checker could not vouch for is scored on neither side', () => {
  const graph = graphOf(['a.ts', 'b.ts'], ['a.ts#f', 'b.ts#g'], [{ from: 'a.ts#f', to: 'b.ts#g', kind: 'calls' }]);
  // b.ts is the compared file; the edge starts in a.ts, which was skipped.
  const comparison = compareEdges(graph, reading([], ['b.ts']));

  assert.deepEqual(comparison.onlyOurs, [], 'our edge out of a skipped file must not count against us');
  assert.equal(comparison.precision, 1);
});

test('the tie-break suffix on a duplicate name is not part of the claim', () => {
  // Three `refine` overloads in one file give three nodes, and the edge lands
  // on the third. TypeScript reads all three as one symbol and can only name
  // `refine`, so joining on the id itself would report the same edge twice —
  // once as a lie and once as a miss.
  const graph = graphOf(
    ['a.ts', 'b.ts'],
    ['a.ts#f', 'b.ts#refine~3'],
    [{ from: 'a.ts#f', to: 'b.ts#refine~3', kind: 'calls' }],
  );
  const comparison = compareEdges(
    graph,
    reading([{ from: 'a.ts#f', to: 'b.ts#refine', kind: 'calls' }], ['a.ts', 'b.ts']),
  );

  assert.equal(comparison.agree.length, 1);
  assert.deepEqual(comparison.onlyOurs, []);
  assert.deepEqual(comparison.onlyChecker, []);
});

test('a difference is filed by what the graph is missing, not by what it is', () => {
  const graph = graphOf(['a.ts', 'b.ts'], ['b.ts#g'], []);
  const comparison = compareEdges(
    graph,
    reading(
      [
        { from: 'a.ts', to: 'b.ts#g', kind: 'calls' },
        { from: 'a.ts#gone', to: 'b.ts#g', kind: 'calls' },
        { from: 'a.ts', to: 'b.ts#missing', kind: 'calls' },
      ],
      ['a.ts', 'b.ts'],
    ),
  );

  assert.deepEqual(
    comparison.onlyChecker.map(({ cause }) => cause),
    ['both nodes exist, the edge does not', 'no caller node', 'no target node'],
  );
  assert.equal(comparison.recall, 0);
});

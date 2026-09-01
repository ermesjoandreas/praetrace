#!/usr/bin/env node
/**
 * Run the graph engine against real projects and report what it made of them.
 *
 * The point is not to check that nothing crashes — it is to find where the graph
 * is *quietly wrong*, which is the only failure mode that matters for a tool
 * whose whole job is to be trusted at a glance. A project whose imports all go
 * through a tsconfig alias produces a graph with almost no edges, and that does
 * not look broken: it looks like a codebase with very little coupling.
 *
 *   node scripts/corpus.mjs <dir> [<dir>...]
 *   node scripts/corpus.mjs --json <dir>
 *
 * Uses dist/, so run `npm run build` first.
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';

import { createParserPool } from '../dist/parser/pool.js';
import { scanProject } from '../dist/project/scan.js';
import { applyBatch, createStore } from '../dist/graph/store.js';
import { resolveImport } from '../dist/graph/resolve.js';
import { clusterFiles } from '../dist/view/cluster.js';

/**
 * How an unresolved specifier is written, because the four shapes call for four
 * different answers: an alias needs tsconfig read, a scoped package is correctly
 * ignored, and a relative one that failed is a genuine bug.
 */
function shapeOf(specifier) {
  if (specifier.startsWith('.')) return 'relative';
  if (specifier.startsWith('@/') || specifier.startsWith('~/')) return 'alias';
  if (specifier.startsWith('@')) return 'scoped';
  return 'bare';
}

/** Declarations the parser has no node kind for. Counted from source, since by
 *  definition they leave nothing behind to count in the graph. */
const BLIND_SPOTS = [
  ['enum', /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w/gm],
  ['namespace', /^\s*(?:export\s+)?(?:declare\s+)?namespace\s+\w/gm],
  ['declare module', /^\s*declare\s+module\s/gm],
  ['class expression', /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*class\b/gm],
];

async function measure(root) {
  const pool = createParserPool();
  const store = createStore();

  const scanStart = performance.now();
  const scan = await scanProject(pool, root);
  const scanMs = performance.now() - scanStart;

  applyBatch(store, scan.parsed, []);

  // What one save costs. derive() rebuilds every node and edge from the stored
  // parse results on every mutation, so this is the number that decides whether
  // the tool stays usable as a project grows.
  const sample = scan.parsed[0];
  const deriveTimes = [];
  for (let i = 0; i < 5 && sample; i += 1) {
    const start = performance.now();
    applyBatch(store, [sample], []);
    deriveTimes.push(performance.now() - start);
  }
  deriveTimes.sort((a, b) => a - b);

  await pool.close();

  const known = new Set(scan.parsed.map((file) => file.filePath));
  const unresolved = { relative: 0, alias: 0, scoped: 0, bare: 0 };
  const worst = new Map();
  let imports = 0;

  for (const file of scan.parsed) {
    for (const specifier of file.imports) {
      imports += 1;
      if (resolveImport(file.filePath, specifier, known)) continue;
      const shape = shapeOf(specifier);
      unresolved[shape] += 1;
      // Only project-shaped specifiers are worth naming; a bare `react` is
      // supposed to resolve to nothing.
      if (shape === 'alias' || shape === 'relative') {
        worst.set(specifier, (worst.get(specifier) ?? 0) + 1);
      }
    }
  }

  const kinds = {};
  for (const node of store.graph.nodes.values()) {
    kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  }

  // Read the sources back to count what the parser has no node kind for. Cheap
  // enough at corpus sizes, and it is the only way to see a silent omission.
  const blind = Object.fromEntries(BLIND_SPOTS.map(([name]) => [name, 0]));
  let emptyButNotBlank = 0;
  for (const file of scan.parsed) {
    const source = await readFile(path.join(root, file.filePath), 'utf8').catch(() => '');
    for (const [name, pattern] of BLIND_SPOTS) {
      blind[name] += (source.match(pattern) ?? []).length;
    }
    // A file that declares something the graph does not hold. Not proof of a
    // bug — a file of only re-exports is legitimately empty — but the ratio is
    // where silent loss would show up.
    if (file.symbols.length === 0 && /^\s*(?:export\s+)?(?:class|function|interface)\s/m.test(source)) {
      emptyButNotBlank += 1;
    }
  }

  const clusters = clusterFiles(store.graph);
  const largest = clusters.reduce((a, b) => (a && a.files.length >= b.files.length ? a : b), null);

  return {
    project: path.basename(root),
    files: scan.parsed.length,
    failures: scan.failures.length,
    nodes: store.graph.nodes.size,
    edges: store.graph.edges.length,
    scanMs: Math.round(scanMs),
    deriveMedianMs: deriveTimes.length ? Number(deriveTimes[Math.floor(deriveTimes.length / 2)].toFixed(1)) : 0,
    imports,
    unresolved,
    unresolvedPct: imports === 0 ? 0 : Math.round(((imports - countResolved(unresolved, imports)) / imports) * 100),
    worstSpecifiers: [...worst.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    kinds,
    blind,
    emptyButNotBlank,
    clusters: clusters.length,
    largestClusterPct: largest && scan.parsed.length ? Math.round((largest.files.length / scan.parsed.length) * 100) : 0,
    largestClusterCohesion: largest ? Number(largest.cohesion.toFixed(2)) : 0,
  };
}

function countResolved(unresolved, imports) {
  const missed = Object.values(unresolved).reduce((a, b) => a + b, 0);
  return imports - missed;
}

function report(row) {
  const miss = Object.entries(row.unresolved)
    .filter(([, n]) => n > 0)
    .map(([shape, n]) => `${shape} ${n}`)
    .join(', ');
  const blind = Object.entries(row.blind)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');

  console.log(`\n${row.project}`);
  console.log(`  ${row.files} files · ${row.nodes} nodes · ${row.edges} edges` +
    (row.failures ? ` · ${row.failures} parse failures` : ''));
  console.log(`  scan ${row.scanMs} ms · one save re-derives in ${row.deriveMedianMs} ms`);
  console.log(`  imports ${row.imports}, ${row.unresolvedPct}% unresolved${miss ? ` (${miss})` : ''}`);
  for (const [specifier, count] of row.worstSpecifiers) {
    console.log(`      ${String(count).padStart(4)}x ${specifier}`);
  }
  if (blind) console.log(`  invisible to the parser: ${blind}`);
  if (row.emptyButNotBlank) {
    console.log(`  ${row.emptyButNotBlank} files declare something but hold no symbols`);
  }
  console.log(`  ${row.clusters} groups, largest covers ${row.largestClusterPct}% at ${row.largestClusterCohesion} cohesion`);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const roots = args.filter((arg) => !arg.startsWith('--'));

if (roots.length === 0) {
  console.error('usage: node scripts/corpus.mjs [--json] <dir> [<dir>...]');
  process.exit(1);
}

const rows = [];
for (const root of roots) {
  try {
    rows.push(await measure(path.resolve(root)));
  } catch (cause) {
    console.error(`${root}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

if (asJson) console.log(JSON.stringify(rows, null, 2));
else for (const row of rows) report(row);

#!/usr/bin/env node
/**
 * Ask the TypeScript checker where our graph is wrong, and print the answer.
 *
 *   node scripts/oracle.mjs <dir> [<dir>...]
 *   node scripts/oracle.mjs --full <dir>      every difference, not the first ten
 *
 * corpus.mjs asks whether a project draws; this asks whether what it draws is
 * true. The difference matters because the failure this project cares about is
 * not a crash, it is a picture that is wrong and looks authoritative — and a
 * missing call edge looks exactly like a symbol nothing calls.
 *
 * The checker is a second opinion and never a source: nothing it says reaches
 * the graph. See src/oracle/checker.ts for what it costs and why it stays out
 * of the live path. Uses dist/, so run `npm run build` first.
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createParserPool } from '../dist/parser/pool.js';
import { scanProject } from '../dist/project/scan.js';
import { applyBatch, createStore, setProjectFacts } from '../dist/graph/store.js';
import { checkedFiles, compareEdges, isUncheckedJavaScript, readWithChecker } from '../dist/oracle/checker.js';

const KINDS = new Set(['calls', 'extends', 'implements']);

/**
 * Megabytes resident. Ours is measured first, so the checker's program cannot
 * be counted against it — but this is the whole process, so a second project in
 * the same run reads the first one's memory too. Run one project per process
 * for a number worth quoting.
 */
const rss = () => Math.round(process.memoryUsage().rss / 1e6);

async function measure(root) {
  const pool = createParserPool();
  const store = createStore();

  const started = performance.now();
  const scan = await scanProject(pool, root);
  // Facts before files, exactly as the server and the CLI install them.
  setProjectFacts(store, scan.facts);
  applyBatch(store, scan.parsed, []);
  const ourMs = Math.round(performance.now() - started);
  const ourRss = rss();
  await pool.close();

  const files = scan.parsed.map((file) => file.filePath);
  const reading = readWithChecker(root, files);
  const comparison = compareEdges(store.graph, reading);

  /** A diagnostic's message, with how many files it kept out of the comparison. */
  const bySkip = new Map();
  for (const { code, message } of reading.skipped) {
    const line = `${code} ${message.slice(0, 70)}`;
    bySkip.set(line, (bySkip.get(line) ?? 0) + 1);
  }

  const byCause = new Map();
  for (const { cause } of comparison.onlyChecker) byCause.set(cause, (byCause.get(cause) ?? 0) + 1);

  return {
    project: path.basename(root),
    files: scan.parsed.length,
    readable: checkedFiles(files).length,
    reading,
    comparison,
    skipReasons: [...bySkip].sort((a, b) => b[1] - a[1]),
    causes: [...byCause].sort((a, b) => b[1] - a[1]),
    ourMs,
    ourRss,
    checkerRss: rss(),
    nodes: store.graph.nodes,
    ours: store.graph.edges.filter((edge) => KINDS.has(edge.kind)).length,
  };
}

/** `src/graph/store.ts#derive:168` — an id is not a place until it has a line. */
function where(nodes, id) {
  const node = nodes.get(id);
  return node === undefined ? `${id} (no node)` : `${id}:${node.range.startLine}`;
}

const percent = (value) => `${(value * 100).toFixed(1)}%`;

/**
 * Below this, the numbers are not about the project any more.
 *
 * A file the checker could not type-check is compared on neither side, which
 * is the only safe thing to do with a second opinion that may not have been
 * able to see. But a project where that is most of the files has no comparison
 * left to print, and printing one anyway would be the silent failure this
 * whole script exists to refuse — 100% precision over four files.
 */
const ENOUGH = 0.5;

function report(row, full) {
  const { reading, comparison } = row;
  console.log(`\n${row.project}`);
  console.log(
    `  ${row.files} files · ${row.readable} the checker reads · ` +
      `${reading.compared.length} compared · ${reading.skipped.length} skipped for a diagnostic`,
  );
  for (const [line, count] of row.skipReasons.slice(0, 3)) console.log(`      ${count} × ${line}`);

  // What a compared JavaScript file's clean bill of health is worth. Its
  // modules were resolved — that guard is real, and it is the half that costs
  // edges — but `checkJs` is off, so nothing type-checked the calls inside it.
  // Said here rather than left in checker.ts, because the number this script
  // prints is the one people quote.
  const unchecked = reading.compared.filter(isUncheckedJavaScript).length;
  if (unchecked > 0) {
    console.log(`      ${unchecked} of the compared files are JavaScript: modules resolved, types unchecked`);
  }

  if (row.readable === 0 || reading.compared.length / row.readable < ENOUGH) {
    console.log('  no comparison: the checker vouched for too little of this project to measure it');
    return;
  }

  console.log(
    `  checker ${reading.edges.length} · ours ${row.ours} ` +
      `(${comparison.agree.length + comparison.onlyOurs.length} in compared files) · ` +
      `agree ${comparison.agree.length}`,
  );
  console.log(`  precision ${percent(comparison.precision)} · recall ${percent(comparison.recall)}`);

  console.log(`  only ours ${comparison.onlyOurs.length} — a lie until someone classifies it`);
  const lies = full ? comparison.onlyOurs : comparison.onlyOurs.slice(0, 10);
  for (const edge of lies) {
    console.log(`      ${where(row.nodes, edge.from)} ${edge.kind} -> ${edge.to}`);
  }

  console.log(`  only checker ${comparison.onlyChecker.length}`);
  for (const [cause, count] of row.causes) console.log(`      ${count} ${cause}`);
  const missed = full ? comparison.onlyChecker : comparison.onlyChecker.slice(0, 10);
  for (const { edge, cause } of missed) {
    console.log(`      ${edge.from} ${edge.kind} -> ${edge.to}   (${cause})`);
  }

  console.log('  sites the checker resolved that our model cannot name');
  for (const [reason, count] of reading.unnamable) console.log(`      ${count} ${reason}`);

  console.log(
    `  ours ${(row.ourMs / 1000).toFixed(1)} s / ${row.ourRss} MB · ` +
      `checker ${(reading.ms / 1000).toFixed(1)} s / ${row.checkerRss} MB`,
  );
}

const args = process.argv.slice(2);
const full = args.includes('--full');
const roots = args.filter((arg) => !arg.startsWith('--'));

if (roots.length === 0) {
  console.error('usage: node scripts/oracle.mjs [--full] <dir> [<dir>...]');
  process.exit(1);
}

if (roots.length > 1) console.log('memory is the whole process; run one project per process for a clean number');

for (const root of roots) {
  report(await measure(path.resolve(root)), full);
}

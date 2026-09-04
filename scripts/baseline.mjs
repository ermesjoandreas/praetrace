#!/usr/bin/env node
/**
 * What the graph *is* for a real repository, pinned, so a change to it is noticed.
 *
 * corpus.mjs asks whether a project draws and oracle.mjs asks whether what it
 * draws is true. Both print, and printing is where it stopped: recall has been
 * raised and lowered across rounds of work with nothing to notice, and three
 * rounds of evaluation found bugs — five invented edges in zod, twelve false
 * imports in flask, a symbol list headed "20 symbols" that omitted four public
 * methods — that every unit test passed through, because each function was
 * right and the composition lied. This is the composition, held still.
 *
 *   node scripts/baseline.mjs <dir> [<dir>...]      the record for a directory
 *   node scripts/baseline.mjs --json <dir>
 *   node scripts/baseline.mjs --fetch               clone the four at their shas
 *   node scripts/baseline.mjs --check               measure the clones, compare
 *   node scripts/baseline.mjs --check --json        the same verdict as JSON
 *   node scripts/baseline.mjs --accept              ... and write what it measured
 *   node scripts/baseline.mjs --compare a.json b.json    two records, no clone
 *
 * The clones live in `$CODEMAP_CORPUS`, or a `codemap-corpus` directory under
 * the system temp directory when that is unset. They are never checked in:
 * forty-five megabytes even fetched without their history, and a copy of
 * someone else's source in this tree would be read by our own scan, our own
 * clustering and our own status bar. The commit is what is checked in, and it
 * is what makes the numbers reproducible.
 *
 * One entry names a directory in this repository instead of a commit — the
 * oracle's fixture, thirteen files that are already here for checker.test.ts.
 * It is measured by everything below exactly as a clone is, and it is the entry
 * that runs on a machine that has never fetched anything. See the test for why
 * that matters more than it looks.
 *
 * Uses dist/, so run `npm run build` first.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createParserPool } from '../dist/parser/pool.js';
import { scanProject } from '../dist/project/scan.js';
import { applyBatch, createStore, setProjectFacts } from '../dist/graph/store.js';
import { clusterFiles } from '../dist/view/cluster.js';
import { selectView } from '../dist/view/select.js';
import { NO_FILTER } from '../dist/view/filter.js';

const BASELINE = fileURLToPath(new URL('../src/oracle/baseline.json', import.meta.url));

const corpusRoot = () => process.env.CODEMAP_CORPUS ?? path.join(os.tmpdir(), 'codemap-corpus');

/**
 * The kinds the record always names, so a kind falling to zero is a `0` in the
 * diff rather than a key that quietly stopped being there. A kind absent from
 * these lists is still counted — a new one must show up as an addition, not as
 * a number nobody prints.
 */
const NODE_KINDS = ['file', 'class', 'function', 'interface', 'type', 'method', 'field'];
const EDGE_KINDS = ['imports', 'extends', 'implements', 'calls', 'contains', 'associates'];

/**
 * Nothing that moves when a file's mtime does.
 *
 * `now` reaches the view only through the recency filter and the "changed
 * recently" marks, neither of which is in this record — but passing
 * `Date.now()` would leave a clock in the middle of a number that is supposed
 * to be reproducible a year from now, and the next person to add a count would
 * have no way to tell whether it was safe.
 */
const NO_CLOCK = 0;

/**
 * One repository's record: what the engine made of it, in numbers only.
 *
 * The headline is the root view, for the reason corpus.mjs gives — a repository
 * that opens with no edges does not look broken, it looks like code with no
 * coupling — and the rest is what would have to change for that headline to
 * move. `guessed` and the two `unresolved` counts are the honesty of the
 * picture: an edge matched against a table nobody named, and a reference that
 * reached nothing at all.
 */
async function measure(root) {
  const pool = createParserPool();
  const store = createStore();

  const started = performance.now();
  const scan = await scanProject(pool, root);
  // Facts before files, exactly as the server and the CLI install them. Without
  // this line the script measures a graph the app does not build.
  setProjectFacts(store, scan.facts);
  applyBatch(store, scan.parsed, []);
  await pool.close();

  const nodes = Object.fromEntries(NODE_KINDS.map((kind) => [kind, 0]));
  for (const node of store.graph.nodes.values()) nodes[node.kind] = (nodes[node.kind] ?? 0) + 1;

  const edges = Object.fromEntries(EDGE_KINDS.map((kind) => [kind, 0]));
  let guessed = 0;
  for (const edge of store.graph.edges) {
    edges[edge.kind] = (edges[edge.kind] ?? 0) + 1;
    if (edge.guessed) guessed += 1;
  }

  // The view the page opens with: no scope, no focus, nothing filtered out.
  const view = selectView(
    store.graph,
    { scope: '', focus: null, depth: 1, filter: NO_FILTER, at: null },
    NO_CLOCK,
  );
  const connected = new Set();
  for (const edge of view.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  const clusters = clusterFiles(store.graph);

  return {
    record: {
      files: scan.parsed.length,
      // A file the pool could not parse at all, and a file tree-sitter
      // recovered from. The second is the quiet one: it costs symbols and
      // leaves a box that looks merely empty.
      parseFailures: scan.failures.length,
      parseErrors: view.parseErrors,
      nodes,
      edges,
      guessed,
      unresolved: view.unresolved,
      rootView: {
        boxes: view.nodes.length,
        edges: view.edges.length,
        isolated: view.nodes.filter((node) => !connected.has(node.id)).length,
      },
      clusters: {
        count: clusters.length,
        largest: clusters.reduce((most, cluster) => Math.max(most, cluster.files.length), 0),
      },
    },
    ms: Math.round(performance.now() - started),
  };
}

/** `edges.imports`, `unresolved.calls` — a record read as one flat set of counts. */
function flatten(record, prefix = '') {
  const counts = new Map();
  // `?? {}` rather than a throw: a project with no record reads as every count
  // appearing from zero, which is what a half-finished `--accept` leaves and
  // what baseline.test.ts refuses to let anyone commit.
  for (const [key, value] of Object.entries(record ?? {})) {
    const name = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'number') counts.set(name, value);
    else if (value !== null && typeof value === 'object') {
      for (const [inner, count] of flatten(value, name)) counts.set(inner, count);
    }
  }
  return counts;
}

/**
 * Which way each count is allowed to move, and this is the whole design.
 *
 * An exact match would fail on every ordinary improvement, and a test that
 * fails when things get better is a test that gets deleted. So each count is
 * judged by direction instead: `up` is a count where more means more of the
 * repository was resolved, `down` one where less does, and `watch` a count that
 * describes the shape of the picture rather than its truth — how many boxes the
 * root view draws, how the clustering divided the project — where neither
 * direction is better and only silence would be wrong.
 *
 * A `down` count is only half a promise, and the way it breaks is worth knowing
 * before reading a printout: code that stops being parsed at all takes its own
 * references with it, so `unresolved` falls. Dropping every Go method from the
 * parser was measured here and lowered cobra's unresolved calls from 98 to 56 —
 * printed as `better`, beside the three counts that failed. That is why a
 * verdict is never read alone: the regression is in the same list.
 *
 * `nodes.*` and `edges.*` are the judgement call, and it is deliberately the
 * strict one. More symbols usually means fewer blind spots and more edges
 * usually means more resolution — but merging two names for one body lowers the
 * first, and deleting five edges zod never had lowers the second, and both are
 * real improvements that fail here. That is the intended way through: the
 * failure exists to make someone look at what they changed, not to be right
 * about it, and `--accept` is one command away.
 */
function directionOf(key) {
  if (key.startsWith('nodes.') || key.startsWith('edges.')) return 'up';
  if (key === 'files' || key === 'rootView.edges') return 'up';
  if (key === 'parseFailures' || key === 'parseErrors' || key === 'guessed') return 'down';
  if (key.startsWith('unresolved.') || key === 'rootView.isolated') return 'down';
  return 'watch';
}

/**
 * Every count that moved, each with a verdict. A count in one record and not
 * the other is compared against zero rather than skipped: an edge kind that
 * stopped being produced is exactly the thing this is for.
 */
function compare(expected, actual) {
  const before = flatten(expected);
  const after = flatten(actual);

  const changes = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const from = before.get(key) ?? 0;
    const to = after.get(key) ?? 0;
    if (from === to) continue;

    const direction = directionOf(key);
    const better = direction === 'up' ? to > from : to < from;
    changes.push({
      count: key,
      expected: from,
      actual: to,
      verdict: direction === 'watch' ? 'moved' : better ? 'better' : 'worse',
    });
  }

  changes.sort((a, b) => a.count.localeCompare(b.count));
  return changes;
}

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/**
 * The pinned projects, and where each one's source would be: a clone under the
 * corpus directory, or — for the one entry that names `directory` — a path in
 * this repository, which is always there and needs no commit to be pinned to,
 * because this repository's own commit already pins it.
 */
async function pinned() {
  const baseline = await readJson(BASELINE);
  const root = corpusRoot();
  return baseline.projects.map((project) => ({
    ...project,
    // What the row is pinned to, said the way a person would check it — and
    // taken from the file rather than from the resolved path below, which is
    // one machine's home directory and has no business in a printout.
    where: project.commit === undefined ? project.directory : project.commit.slice(0, 7),
    directory:
      project.directory === undefined
        ? path.join(root, project.project)
        : fileURLToPath(new URL(`../${project.directory}`, import.meta.url)),
  }));
}

/**
 * The commit the clone is actually on. A clone on the wrong commit is worse
 * than no clone: the numbers would differ for a reason that has nothing to do
 * with the engine, and the diff would blame the code.
 */
function headOf(directory) {
  const head = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  return head.status === 0 ? head.stdout.trim() : null;
}

const fetchCommand = (repo) =>
  repo.url === undefined
    ? `${repo.directory} belongs to this repository, and the checkout is missing it`
    : `git clone --filter=blob:none --no-checkout ${repo.url} ${repo.directory} && ` +
      `git -C ${repo.directory} checkout ${repo.commit}`;

async function fetchAll() {
  for (const repo of await pinned()) {
    if (repo.url === undefined) continue;
    if (existsSync(repo.directory)) {
      console.log(`${repo.project}: already at ${repo.directory}`);
      continue;
    }
    console.log(`${repo.project}: cloning ${repo.url}`);
    const clone = spawnSync(
      'git',
      ['clone', '--quiet', '--filter=blob:none', '--no-checkout', repo.url, repo.directory],
      { stdio: 'inherit' },
    );
    if (clone.status !== 0) {
      console.error(`${repo.project}: clone failed`);
      continue;
    }
    spawnSync('git', ['-C', repo.directory, 'checkout', '--quiet', repo.commit], { stdio: 'inherit' });
    console.log(`${repo.project}: ${repo.commit.slice(0, 7)}`);
  }
}

/**
 * Measure every clone that is present and compare it to what is written down.
 *
 * A repository with no clone is reported as absent rather than passed over in
 * silence — the whole risk of a corpus test is that it skips everything and
 * nobody notices — and the fetch command for it is printed beside it.
 */
async function check({ accept, asJson }) {
  const projects = [];
  let regressions = 0;

  for (const repo of await pinned()) {
    const row = { project: repo.project, where: repo.where, present: false, changes: [] };

    if (!existsSync(repo.directory)) {
      row.absent = repo.url === undefined ? 'missing from this repository' : 'no clone';
      row.fetch = fetchCommand(repo);
      projects.push(row);
      continue;
    }

    const head = repo.commit === undefined ? undefined : headOf(repo.directory);
    if (head !== undefined && head !== repo.commit) {
      row.absent = head === null ? 'not a git work tree' : `on ${head.slice(0, 7)}, not the pinned commit`;
      // A checkout is the remedy only where there is something to check out in.
      // A directory that is not a work tree — an interrupted clone, a copy of
      // the sources without their history — cannot be moved onto the commit,
      // and `git clone` refuses to write into it while it is there.
      row.fetch =
        head === null
          ? `rm -rf ${repo.directory} && ${fetchCommand(repo)}`
          : `git -C ${repo.directory} checkout ${repo.commit}`;
      projects.push(row);
      continue;
    }

    const { record, ms } = await measure(repo.directory);
    row.present = true;
    row.ms = ms;
    row.changes = compare(repo.record, record);
    row.regressions = row.changes.filter((change) => change.verdict === 'worse').length;
    row.record = record;
    regressions += row.regressions;
    projects.push(row);
  }

  if (accept) {
    const baseline = await readJson(BASELINE);
    const measured = new Map(projects.filter((row) => row.present).map((row) => [row.project, row.record]));
    for (const project of baseline.projects) {
      const record = measured.get(project.project);
      if (record !== undefined) project.record = record;
    }
    baseline.measured = new Date().toISOString().slice(0, 10);
    await writeFile(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  }

  const verdict = { corpus: corpusRoot(), accepted: accept === true, regressions, projects };
  if (asJson) console.log(JSON.stringify(verdict, null, 2));
  else reportCheck(verdict);

  return regressions === 0 || accept === true ? 0 : 1;
}

const ARROW = { better: '·', worse: '✕', moved: '~' };

function printChanges(changes) {
  const width = Math.max(0, ...changes.map((change) => change.count.length));
  for (const change of changes) {
    console.log(
      `    ${ARROW[change.verdict]} ${change.count.padEnd(width)}  ` +
        `${change.expected} -> ${change.actual}  ${change.verdict}`,
    );
  }
}

function reportCheck(verdict) {
  console.log(`clones in ${verdict.corpus}`);

  for (const row of verdict.projects) {
    if (!row.present) {
      console.log(`\n${row.project}: ${row.absent}`);
      console.log(`    ${row.fetch}`);
      continue;
    }

    console.log(`\n${row.project} ${row.where} · ${(row.ms / 1000).toFixed(1)} s`);
    if (row.changes.length === 0) {
      console.log('    every count as recorded');
      continue;
    }
    printChanges(row.changes);
  }

  const measured = verdict.projects.filter((row) => row.present).length;
  console.log(`\n${measured} of ${verdict.projects.length} projects measured`);
  if (verdict.accepted) console.log(`written to ${path.relative(process.cwd(), BASELINE)}`);
  else if (verdict.regressions > 0) console.log(acceptance(verdict.regressions));
}

/** Printed wherever a run fails, because a failure that hides its remedy gets ignored. */
const acceptance = (regressions) =>
  `${regressions} count${regressions === 1 ? '' : 's'} moved the wrong way. ` +
  'If that is the intended change, accept the new baseline with ' +
  '`node scripts/baseline.mjs --accept` and commit the diff.';

/**
 * Two record files, compared without measuring anything.
 *
 * Here so the direction rule above can be exercised where there is no clone and
 * no network — it is the part of this script that is pure logic, and so the
 * part that can rot without a crash. src/oracle/baseline.test.ts feeds it a
 * pair of records it wrote itself.
 */
async function compareFiles(expectedFile, actualFile) {
  const expected = await readJson(expectedFile);
  const actual = await readJson(actualFile);
  const byProject = new Map(actual.projects.map((project) => [project.project, project]));

  let regressions = 0;
  for (const repo of expected.projects) {
    const other = byProject.get(repo.project);
    if (other === undefined) {
      console.log(`\n${repo.project}: not in ${path.basename(actualFile)}`);
      continue;
    }
    if (other.commit !== repo.commit) {
      const named = other.commit === undefined ? 'no commit' : other.commit.slice(0, 7);
      console.log(`\n${repo.project}: ${named}, not the pinned commit, so the counts are not comparable`);
      continue;
    }

    const changes = compare(repo.record, other.record);
    console.log(`\n${repo.project} ${repo.commit.slice(0, 7)}`);
    if (changes.length === 0) console.log('    every count as recorded');
    else printChanges(changes);
    regressions += changes.filter((change) => change.verdict === 'worse').length;
  }

  if (regressions > 0) console.log(`\n${acceptance(regressions)}`);
  return regressions === 0 ? 0 : 1;
}

function report(project, record, ms) {
  const line = (label, value) => console.log(`  ${label.padEnd(22)}${value}`);
  console.log(`\n${project} · ${(ms / 1000).toFixed(1)} s`);
  line('files', `${record.files}` + (record.parseFailures ? ` · ${record.parseFailures} unparsed` : ''));
  line('nodes', Object.entries(record.nodes).map(([kind, n]) => `${kind} ${n}`).join(' · '));
  line('edges', Object.entries(record.edges).map(([kind, n]) => `${kind} ${n}`).join(' · '));
  line('guessed', record.guessed);
  line('unresolved', `${record.unresolved.imports} imports · ${record.unresolved.calls} calls`);
  line('parse errors', record.parseErrors);
  line('root view', `${record.rootView.boxes} boxes · ${record.rootView.edges} edges · ${record.rootView.isolated} with no edge`);
  line('groups', `${record.clusters.count}, largest ${record.clusters.largest} files`);
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const directories = args.filter((arg) => !arg.startsWith('--'));

if (args.includes('--fetch')) {
  await fetchAll();
} else if (args.includes('--compare')) {
  const [expected, actual] = directories;
  if (expected === undefined || actual === undefined) {
    console.error('usage: node scripts/baseline.mjs --compare <expected.json> <actual.json>');
    process.exit(2);
  }
  process.exitCode = await compareFiles(path.resolve(expected), path.resolve(actual));
} else if (args.includes('--check') || args.includes('--accept')) {
  process.exitCode = await check({ accept: args.includes('--accept'), asJson });
} else if (directories.length === 0) {
  console.error('usage: node scripts/baseline.mjs [--json] <dir> [<dir>...]');
  console.error('       node scripts/baseline.mjs --fetch | --check | --accept');
  process.exit(2);
} else {
  const rows = [];
  for (const directory of directories) {
    const root = path.resolve(directory);
    const { record, ms } = await measure(root);
    rows.push({ project: path.basename(root), record, ms });
  }
  if (asJson) console.log(JSON.stringify({ projects: rows.map(({ project, record }) => ({ project, record })) }, null, 2));
  else for (const row of rows) report(row.project, row.record, row.ms);
}

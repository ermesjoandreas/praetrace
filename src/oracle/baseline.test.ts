/**
 * The baseline, enforced: what the engine draws for a real repository, compared
 * to what it drew when someone last looked.
 *
 * `checker.test.ts` beside this asks whether thirteen files are read *truly*.
 * This asks a coarser question over a whole project — how much of it resolved —
 * because that is the one that has been moving without anyone noticing. Recall
 * has been raised and lowered across rounds of work with nothing to catch it,
 * and the bugs three rounds of evaluation found — five invented edges in zod,
 * twelve false imports in flask — were all compositions that lied while every
 * function inside them was right.
 *
 * **A test in `npm test` must not clone from the network.** A suite that needs
 * GitHub is a suite that fails on a plane, and one that quietly downloads
 * forty-five megabytes the first time someone runs it is worse. So the pinned
 * clones are optional, and the choice made here is *both* halves of that:
 *
 * - The **oracle's fixture runs always**. It is thirteen files that are already
 *   in this repository, and it is measured by the same script, through the same
 *   scan, store, view and clustering as a clone. That is what keeps this from
 *   being a suite that skips everything and is never noticed skipping — and it
 *   is why the fixture entry is not allowed to be absent below, while a clone
 *   is. A fresh copy of express under `src/` would have been the other way to
 *   get an always-on fixture, and it was refused: our own scan, our own
 *   clustering and our own status bar would read it as this project's code.
 * - The **four clones run when they are on disk**, and are skipped with their
 *   fetch command printed when they are not. They are the half that is not a
 *   fixture — 758 real files across JavaScript, TypeScript, Go and Python, in
 *   shapes nobody here chose.
 *
 * The comparison itself is the design, and it is exercised offline through
 * `--compare`: a count moving towards *more resolved* passes and prints, a
 * count moving the other way fails and names the project and the count. An
 * exact match on every number would fail on every ordinary improvement, and a
 * test that fails when things get better is a test that gets deleted.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Read from the repository, not from beside this compiled test: the script is
 * a script and the baseline is data, so neither is in `dist/`. The script is
 * *run* rather than imported for the same reason — it is `.mjs`, outside
 * `rootDir`, and importing it would either need `allowJs` or an `any`.
 */
const SCRIPT = fileURLToPath(new URL('../../scripts/baseline.mjs', import.meta.url));
const BASELINE = fileURLToPath(new URL('../../src/oracle/baseline.json', import.meta.url));

/** The entry that is in this repository rather than in a clone. */
const FIXTURE = 'oracle-fixture';

interface Change {
  count: string;
  expected: number;
  actual: number;
  verdict: 'better' | 'worse' | 'moved';
}

interface Row {
  project: string;
  where: string;
  present: boolean;
  /** Why it was not measured, when it was not. */
  absent?: string;
  fetch?: string;
  ms?: number;
  changes: Change[];
  regressions?: number;
}

interface PinnedProject {
  project: string;
  language: string;
  url?: string;
  commit?: string;
  directory?: string;
  record: Record<string, unknown>;
}

const run = (args: readonly string[]): { status: number; output: string } => {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) assert.fail(`${SCRIPT} did not run: ${result.error.message}`);
  return { status: result.status ?? 1, output };
};

/** How a failure names what moved, so the assertion message is the diff itself. */
const spell = (row: Row, change: Change): string =>
  `${row.project}: ${change.count} ${change.expected} -> ${change.actual}`;

/**
 * Every count that moved, printed whether the subtest passes or fails.
 *
 * A regression names itself in the assertion, but an improvement would
 * otherwise be a silent green tick — and an improvement is exactly the moment
 * someone is about to run `--accept` and write these numbers down. They should
 * be able to read what they are accepting out of the run that told them to.
 */
const announce = (context: TestContext, row: Row): void => {
  for (const change of row.changes) context.diagnostic(`${spell(row, change)} ${change.verdict}`);
};

/** A baseline-shaped file with one project in it, for the offline comparison. */
async function recordFile(directory: string, name: string, record: unknown): Promise<string> {
  const file = path.join(directory, name);
  await writeFile(
    file,
    JSON.stringify({ projects: [{ project: 'demo', commit: 'a'.repeat(40), record }] }),
  );
  return file;
}

test('the baseline pins four repositories, at four languages, by commit', async () => {
  const parsed = JSON.parse(await readFile(BASELINE, 'utf8')) as { projects?: PinnedProject[] };
  const projects = parsed.projects ?? [];

  const clones = projects.filter((project) => project.url !== undefined);
  assert.equal(clones.length, 4, 'four repositories, or the corpus is no longer polyglot');
  assert.deepEqual(
    [...new Set(clones.map((project) => project.language))].sort(),
    ['go', 'javascript', 'python', 'typescript'],
    'a resolver that stops answering for one language is invisible in the other three',
  );
  for (const project of clones) {
    assert.match(project.commit ?? '', /^[0-9a-f]{40}$/, `${project.project} is not pinned to a commit`);
  }

  // An empty record is the one way this whole file can pass while checking
  // nothing: every count would read as "appeared", and appearing is mostly an
  // improvement. It is also exactly what a half-finished `--accept` leaves.
  for (const project of projects) {
    assert.ok(
      typeof project.record['files'] === 'number' && project.record['files'] > 0,
      `${project.project} has no record; run node scripts/baseline.mjs --accept`,
    );
  }

  assert.ok(
    projects.some((project) => project.project === FIXTURE && project.directory !== undefined),
    'the entry that runs without a clone is gone, and this suite now skips by default',
  );
});

test('a count that moves the wrong way fails, and says which project and which count', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codemap-baseline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const expected = await recordFile(directory, 'expected.json', {
    files: 12,
    edges: { imports: 40, calls: 100 },
    unresolved: { calls: 7 },
  });
  // Fewer imports resolved, more references reaching nothing, and a whole edge
  // kind that stopped being produced — the shape of every regression this
  // exists for.
  const actual = await recordFile(directory, 'actual.json', {
    files: 12,
    edges: { imports: 28 },
    unresolved: { calls: 19 },
  });

  const { status, output } = run(['--compare', expected, actual]);

  assert.equal(status, 1, `three counts moved the wrong way and the run passed:\n${output}`);
  assert.match(output, /demo/, 'the failure must name the project');
  assert.match(output, /edges\.imports\s+40 -> 28\s+worse/);
  assert.match(output, /edges\.calls\s+100 -> 0\s+worse/, 'an edge kind that vanished is a regression, not a missing key');
  assert.match(output, /unresolved\.calls\s+7 -> 19\s+worse/);
  // The remedy travels with the failure, or the next person deletes the test.
  assert.match(output, /--accept/);
});

test('a count that moves the right way passes, and still prints what changed', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'codemap-baseline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const expected = await recordFile(directory, 'expected.json', {
    edges: { imports: 40 },
    guessed: 6,
    unresolved: { imports: 30 },
    rootView: { boxes: 9 },
  });
  const actual = await recordFile(directory, 'actual.json', {
    edges: { imports: 52 },
    guessed: 0,
    unresolved: { imports: 3 },
    rootView: { boxes: 11 },
  });

  const { status, output } = run(['--compare', expected, actual]);

  assert.equal(status, 0, `every count improved and the run failed:\n${output}`);
  assert.match(output, /edges\.imports\s+40 -> 52\s+better/);
  assert.match(output, /guessed\s+6 -> 0\s+better/);
  assert.match(output, /unresolved\.imports\s+30 -> 3\s+better/);
  // Neither direction is better for a count that describes the shape of the
  // picture, but silence about it would be.
  assert.match(output, /rootView\.boxes\s+9 -> 11\s+moved/);
});

test('the graph the engine builds, against what it built last time', async (t) => {
  const { output } = run(['--check', '--json']);

  // A script that did not run at all is the rot this file exists to catch, and
  // "Unexpected token o in JSON" would send the next person looking at the
  // wrong thing. `--check --json` prints a verdict whether or not it passes,
  // so anything else here means the run itself is broken.
  let verdict: { projects: Row[] };
  try {
    verdict = JSON.parse(output) as { projects: Row[] };
  } catch {
    return assert.fail(`scripts/baseline.mjs printed no verdict. Is dist/ built?\n${output}`);
  }

  const fixture = verdict.projects.find((row) => row.project === FIXTURE);
  if (fixture === undefined) assert.fail(`no ${FIXTURE} row in the verdict:\n${output}`);

  await t.test(`${FIXTURE}, which needs no clone`, (sub) => {
    // Not skippable, on purpose: this is the half that runs on a machine that
    // has never fetched anything, and the reason the rest may be skipped.
    assert.ok(fixture.present, `${FIXTURE} was not measured: ${fixture.absent ?? 'no reason given'}`);
    announce(sub, fixture);
    const worse = fixture.changes.filter((change) => change.verdict === 'worse');
    assert.deepEqual(
      worse.map((change) => spell(fixture, change)),
      [],
      'the fixture lost ground; if the fixture itself changed, accept it with ' +
        'node scripts/baseline.mjs --accept',
    );
  });

  for (const row of verdict.projects.filter((candidate) => candidate.project !== FIXTURE)) {
    await t.test(`${row.project} ${row.where}`, (sub) => {
      if (!row.present) {
        // A skip that prints the command that would end it. The corpus is
        // optional; being quiet about which half of the suite did not run is
        // not.
        sub.diagnostic(row.fetch ?? 'no fetch command');
        sub.skip(`${row.absent ?? 'not measured'} — or all four: node scripts/baseline.mjs --fetch`);
        return;
      }

      announce(sub, row);
      const worse = row.changes.filter((change) => change.verdict === 'worse');
      assert.deepEqual(
        worse.map((change) => spell(row, change)),
        [],
        `${row.project} resolved less of itself than the baseline records. If that is ` +
          'the intended change, accept it with node scripts/baseline.mjs --accept and commit the diff.',
      );
    });
  }
});

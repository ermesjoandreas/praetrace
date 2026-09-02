import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyBatch, createStore, setProjectFacts } from '../graph/store.js';
import type { Graph } from '../graph/types.js';
import type { ProjectFacts } from '../lang/types.js';
import type { ParserPool } from '../parser/pool.js';
import { archiveCommit, resolveCommit } from './git.js';
import { scanProject } from './scan.js';

/** The project as it was at one commit, derived the same way the live graph is. */
export interface HistoricalGraph {
  graph: Graph;
  facts: ProjectFacts;
  /** How many files the graph holds. */
  files: number;
}

/**
 * The whole diagram as of one commit — not today's graph with a highlight on
 * it. The commit is unpacked into a temporary directory and scanned exactly as
 * a project is at boot, through the pool the session already has, so the ids
 * come out the same and two commits can be compared node for node.
 *
 * About 115 ms on this repository and seconds on a large one, so the caller
 * caches; nothing here does. Null when `sha` names no commit, the project
 * did not exist at it, or the commit could not be drawn for any other reason —
 * never a throw, for the reason git.ts never throws: the caller has one answer
 * for "cannot show that", and a 500 under a URL naming a commit is not it. The
 * temporary directory is gone by the time this returns, whatever happened.
 */
export async function graphAt(root: string, sha: string, pool: ParserPool): Promise<HistoricalGraph | null> {
  const commit = await resolveCommit(root, sha);
  if (commit === null) return null;

  let directory: string;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), `${HISTORY_PREFIX}${commit.slice(0, 7)}-`));
  } catch {
    // An unwritable tmpdir. Nothing was made, so there is nothing to remove.
    return null;
  }
  try {
    if (!(await archiveCommit(root, commit, directory))) return null;

    const scan = await scanProject(pool, directory);
    const store = createStore();
    // Before the files, not after, for the reason the session gives: an alias
    // table arriving second is a second derivation of the whole graph.
    setProjectFacts(store, scan.facts);
    applyBatch(store, scan.parsed, []);
    return { graph: store.graph, facts: scan.facts, files: scan.parsed.length };
  } catch {
    // The pool closing under the scan — the project was switched mid build —
    // is the ordinary way here, and a graph with half its files is worse than none.
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const HISTORY_PREFIX = 'codemap-';
const HISTORY_DIR = /^codemap-[0-9a-f]{7}-/;
const STALE_MS = 60 * 60 * 1000;

/**
 * What a previous process left behind. The `finally` above removes the
 * directory on every path JavaScript can see; a SIGKILL, or the desktop shell
 * dropping the sidecar mid build, is not one of them. Only directories older
 * than an hour go, so a second codemap running beside this one keeps the build
 * it is in the middle of.
 */
export async function sweepHistoryDirs(now = Date.now()): Promise<void> {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = await readdir(tmp);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => HISTORY_DIR.test(name))
      .map(async (name) => {
        const full = path.join(tmp, name);
        try {
          const info = await stat(full);
          if (!info.isDirectory() || now - info.mtimeMs < STALE_MS) return;
          await rm(full, { recursive: true, force: true });
        } catch {
          // Someone else's, or already gone.
        }
      }),
  );
}

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { Coverage, FileCoverage, SymbolCoverage } from '../report/types.js';
import type { Graph } from '../graph/types.js';

/**
 * What the test suite actually executed, read from the artefact CI already
 * writes.
 *
 * Nothing here runs a test, instruments anything or costs a second of anyone's
 * time: `nyc --reporter=lcovonly` and `vitest --coverage` both leave a file
 * behind, and that file is the whole input. Measured on zod's own report: 5.8 ms
 * to parse 330 KB of lcov and 2.1 ms to join it onto 4201 symbols, 4.7 ms from
 * the call to the answer. Cheap to read on request, and too dear to read on
 * every live push — so the session holds the answer and `coverageStamp` is how
 * it learns to read again.
 *
 * **This is coverage, and it is not blast radius.** The tempting next question —
 * "which tests break if I change this line" — is not answerable from either
 * toolchain, because neither records which test executed which line: a merged
 * report is the union of every test in the run. Manufacturing per-test
 * attribution means running the suite once per test file, which was measured at
 * 13.6x the suite, and what it buys is "125 of 192 tests", which is not an
 * answer anyone can act on. Do not build it here.
 */

/**
 * One file as the report describes it, before it meets the graph.
 *
 * The two currencies are kept apart on purpose, because joining the wrong one
 * onto a symbol is the trap this module exists to avoid — see `joinCoverage`.
 */
export interface MeasuredFile {
  /** Execution count by line number. A file's total is the size of this. */
  lines: Map<number, number>;
  /** Every function the report found, by the line it was declared on. */
  functions: { line: number; hits: number }[];
}

/** Keyed by the path the artefact wrote, which may be absolute or relative. */
export type Measurement = Map<string, MeasuredFile>;

/**
 * The three places a JavaScript project leaves coverage, in the order they are
 * tried. lcov first because it is a tenth of the size of the JSON and says the
 * same thing about lines and functions.
 *
 * Only these three, and only at the root: a monorepo that writes coverage per
 * package leaves nothing here to find, and saying "none found" is better than
 * walking a tree of 900 directories on the chance one holds a report.
 */
const CANDIDATES = ['coverage/lcov.info', 'lcov.info', 'coverage/coverage-final.json'] as const;

/**
 * Find what CI wrote, parse it, and join it onto the graph.
 *
 * Never throws. A project with no coverage is the ordinary case, not an error,
 * and so is a report written by a tool whose dialect this does not read — both
 * answer null, the way `git.ts` answers null for a directory that is not a
 * repository. The graph is passed in rather than reached for: this module owns
 * no state and mutates nothing.
 */
export async function readCoverage(root: string, graph: Graph): Promise<Coverage | null> {
  // A runner writes absolute paths from `process.cwd()`, which Node has
  // already resolved through every symlink, so a project opened at `/tmp/x` on
  // macOS — where `/tmp` is a link to `/private/tmp` — reads a report that
  // names a directory it does not appear to be in. The real location is passed
  // alongside the given one rather than instead of it: a report can carry
  // either.
  const real = await realpath(root).catch(() => root);

  for (const candidate of CANDIDATES) {
    const absolute = path.join(root, ...candidate.split('/'));

    let at: number;
    let text: string;
    try {
      const info = await stat(absolute);
      if (!info.isFile()) continue;
      at = info.mtimeMs;
      text = await readFile(absolute, 'utf8');
    } catch {
      continue;
    }

    let measured: Measurement;
    try {
      measured = candidate.endsWith('.json') ? parseIstanbul(text) : parseLcov(text);
    } catch {
      continue;
    }
    // An empty artefact is not a measured project. A coverage run that crashed
    // before it wrote anything leaves a zero-byte lcov.info beside a three-byte
    // coverage-final.json — observed on vitest 4 with a mismatched provider —
    // and reporting "0 of 0 lines" from it would be a confident lie.
    if (measured.size === 0) continue;

    return { at, source: candidate, ...joinCoverage(measured, graph, root, real) };
  }
  return null;
}

/**
 * What is on disk right now, as a string that changes when any of it does.
 *
 * Three stats and no read, so a holder of the answer can ask before every push
 * whether the answer is still the answer. Every candidate is stamped, not just
 * the one the last read used: an empty `lcov.info` sends `readCoverage` on to
 * the JSON, and a stamp of the first file alone would never notice the second
 * being rewritten.
 *
 * Size as well as mtime, because a runner that rewrites the report inside one
 * millisecond is a run that produced different numbers under the same clock.
 * An empty string means nothing is there, which is a stamp like any other — it
 * is how a report appearing, or being deleted, is noticed.
 */
export async function coverageStamp(root: string): Promise<string> {
  const parts: string[] = [];
  for (const candidate of CANDIDATES) {
    const info = await stat(path.join(root, ...candidate.split('/'))).catch(() => null);
    if (info?.isFile()) parts.push(`${candidate}:${info.mtimeMs}:${info.size}`);
  }
  return parts.join(' ');
}

/**
 * lcov, as istanbul's `lcovonly` reporter and nyc write it.
 *
 * `SF` opens a record; `DA:<line>,<count>` is a line, `FN:<line>,<name>` is a
 * function's declaration and `FNDA:<count>,<name>` its hits. The two function
 * records are matched by name in the order they appear, because a name is not
 * unique inside a file — `(anonymous_6)` is, but a nested `function done()`
 * declared twice is not — and position within the name is the only pairing the
 * format offers.
 *
 * lcov 2.x's `FNL`/`FNA` pair is not read. Neither toolchain this targets emits
 * it, and guessing at a dialect is how a report gets misread rather than
 * skipped.
 */
export function parseLcov(text: string): Measurement {
  const measurement: Measurement = new Map();

  let file: MeasuredFile | null = null;
  let declared: Map<string, number[]> = new Map();
  let hit: Map<string, number[]> = new Map();

  const closeRecord = (): void => {
    if (!file) return;
    for (const [name, lines] of declared) {
      const hits = hit.get(name) ?? [];
      lines.forEach((line, index) => {
        // A function with no FNDA at all was never entered: genhtml reads a
        // missing count as zero, and so does every consumer of this format.
        file?.functions.push({ line, hits: hits[index] ?? 0 });
      });
    }
    file = null;
    declared = new Map();
    hit = new Map();
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === 'end_of_record') {
      closeRecord();
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const tag = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (tag === 'SF') {
      closeRecord();
      // Merged rather than replaced: some runners emit a second record for the
      // same file, and the union of what two runs executed is the truth.
      const existing = measurement.get(value);
      file = existing ?? { lines: new Map(), functions: [] };
      measurement.set(value, file);
      continue;
    }
    if (!file) continue;

    if (tag === 'DA') {
      // `DA:<line>,<count>` — a third checksum field is legal and ignored.
      const [lineText, countText] = value.split(',');
      const at = Number(lineText);
      const count = Number(countText);
      if (!Number.isFinite(at) || !Number.isFinite(count)) continue;
      file.lines.set(at, Math.max(file.lines.get(at) ?? 0, count));
      continue;
    }
    // A function name may itself contain a comma, so only the first is a
    // separator.
    if (tag === 'FN') {
      const comma = value.indexOf(',');
      if (comma === -1) continue;
      const at = Number(value.slice(0, comma));
      if (!Number.isFinite(at)) continue;
      push(declared, value.slice(comma + 1), at);
      continue;
    }
    if (tag === 'FNDA') {
      const comma = value.indexOf(',');
      if (comma === -1) continue;
      const count = Number(value.slice(0, comma));
      if (!Number.isFinite(count)) continue;
      push(hit, value.slice(comma + 1), count);
    }
  }
  closeRecord();

  return measurement;
}

function push(into: Map<string, number[]>, key: string, value: number): void {
  const existing = into.get(key);
  if (existing) existing.push(value);
  else into.set(key, [value]);
}

/**
 * istanbul's `coverage-final.json`, which vitest's v8 provider also writes
 * after converting.
 *
 * Lines are derived from `statementMap` the way istanbul's own
 * `getLineCoverage` does — a line's count is the highest of the statements
 * starting on it — so a file's percentage here matches the one the HTML report
 * shows rather than being a second opinion about the same run.
 */
export function parseIstanbul(text: string): Measurement {
  const measurement: Measurement = new Map();

  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) return measurement;

  for (const [filePath, entry] of Object.entries(parsed)) {
    if (!isRecord(entry)) continue;

    const lines = new Map<number, number>();
    const statements = isRecord(entry.s) ? entry.s : {};
    if (isRecord(entry.statementMap)) {
      for (const [key, location] of Object.entries(entry.statementMap)) {
        const at = startLineOf(location);
        if (at === null) continue;
        const count = Number(statements[key] ?? 0);
        if (!Number.isFinite(count)) continue;
        lines.set(at, Math.max(lines.get(at) ?? 0, count));
      }
    }

    const functions: MeasuredFile['functions'] = [];
    const hits = isRecord(entry.f) ? entry.f : {};
    if (isRecord(entry.fnMap)) {
      for (const [key, fn] of Object.entries(entry.fnMap)) {
        if (!isRecord(fn)) continue;
        // `decl` is the signature, `loc` the body. The declaration is what a
        // graph node's own start line is, so it is what joins.
        const at = startLineOf(fn.decl) ?? startLineOf(fn.loc) ?? numberOr(fn.line);
        if (at === null) continue;
        const count = Number(hits[key] ?? 0);
        if (!Number.isFinite(count)) continue;
        functions.push({ line: at, hits: count });
      }
    }

    if (lines.size === 0 && functions.length === 0) continue;
    measurement.set(filePath, { lines, functions });
  }

  return measurement;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `{ start: { line } }`, the shape every istanbul location shares. */
function startLineOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  if (!isRecord(value.start)) return null;
  return numberOr(value.start.line);
}

/**
 * The report, joined onto the graph the tool already has.
 *
 * Four rules, each of them a measurement rather than a preference:
 *
 * **Absent is not zero.** Vitest 4 removed `coverage.all` and reports only the
 * files a run imported, so 119 of zod's 510 files are all it mentions, and nyc
 * omits whatever the script excluded, which leaves 73 of express's 145 symbols
 * with no data. A node the report does not mention is `unknown`. Rendering it
 * as 0% would accuse tested code of being untested, which is exactly the
 * authoritative-looking wrongness this project refuses elsewhere.
 *
 * **Most of a graph cannot carry a number, and that is not a gap.** 1094 of
 * zod's 4201 symbols join. Every one of its 1209 fields, 681 interfaces and
 * 555 type aliases is `unknown` because none of them is a function at runtime
 * — see `SymbolCoverage`.
 *
 * **A symbol is measured by function hits, a file by lines.** Joining executed
 * statement lines onto a symbol's range gave express's `res.download` 87 of 88,
 * when the truth was 2: `res.download = function (...) {}` is itself a
 * statement, and it runs at module load whether or not anything ever calls what
 * it assigns. `fnMap`/`FNDA` counts are the only records that tell a function
 * that was called from one that was merely defined.
 *
 * **A symbol is measured by the function declared where the symbol is.** Only
 * an entry on the node's own first line counts, never one somewhere inside its
 * range. Ranges nest — a class spans every method, a method spans every
 * closure — so containment hands a symbol somebody else's number: zod's
 * `ZodType` read "covered" off a callback on line 247, and a two-line window
 * around the declaration picked up 210 more inner arrows the same way. Matching
 * the declaration line instead cost 4 joins of 1098 on zod and none at all on
 * express, and what it buys is that a symbol's answer is about that symbol.
 * `ParseStatus` still joins on its constructor, and a `namespace` or an `enum`
 * still joins on the IIFE the compiler puts on its first line, because in both
 * cases the report really does declare a function exactly there.
 */
export function joinCoverage(
  measured: Measurement,
  graph: Graph,
  root: string,
  /**
   * The same directory under a second name, when it has one.
   *
   * macOS's `/tmp` is a link to `/private/tmp`, and a runner writes whichever
   * of the two `process.cwd()` resolved to while the project may have been
   * opened at the other. Both were seen in one afternoon — express's report
   * carried the real path, a temporary directory's carried the linked one — so
   * a path is tried against each and the first that lands inside wins. The
   * graph's ids are relative and identical either way.
   */
  alias?: string,
): Pick<Coverage, 'files' | 'symbols'> {
  const roots = alias === undefined || alias === root ? [root] : [root, alias];

  const byPath = new Map<string, MeasuredFile>();
  for (const [reported, file] of measured) {
    const relative = relativeToRoot(reported, roots);
    // A report may cover node_modules or a sibling checkout. Neither is in the
    // graph, and a path outside the root cannot become one of its ids.
    if (relative === null) continue;
    byPath.set(relative, file);
  }

  const files: Record<string, FileCoverage> = {};
  const symbolsByFile = new Map<string, { id: string; declaredAt: number }[]>();

  for (const node of graph.nodes.values()) {
    if (node.kind === 'file') {
      const file = byPath.get(node.filePath);
      if (!file) continue;
      let covered = 0;
      for (const count of file.lines.values()) if (count > 0) covered += 1;
      files[node.filePath] = { lines: file.lines.size, covered };
      continue;
    }
    const entry = { id: node.id, declaredAt: node.range.startLine };
    const existing = symbolsByFile.get(node.filePath);
    if (existing) existing.push(entry);
    else symbolsByFile.set(node.filePath, [entry]);
  }

  const symbols: Record<string, SymbolCoverage> = {};
  for (const [filePath, nodes] of symbolsByFile) {
    const file = byPath.get(filePath);
    if (!file) {
      for (const node of nodes) symbols[node.id] = 'unknown';
      continue;
    }

    // One line can declare two functions — `const a = () => x, b = () => y` —
    // and the line ran if either of them did, which is how a line is counted
    // everywhere else here.
    const declared = new Map<number, number>();
    for (const fn of file.functions) {
      declared.set(fn.line, Math.max(declared.get(fn.line) ?? 0, fn.hits));
    }

    for (const node of nodes) {
      const hits = declared.get(node.declaredAt);
      symbols[node.id] = hits === undefined ? 'unknown' : hits > 0 ? 'covered' : 'never';
    }
  }

  return { files, symbols };
}

/**
 * A path as the report wrote it, as one of the graph's ids.
 *
 * nyc writes `SF:` relative to where it ran, istanbul's JSON keys it
 * absolutely, and both are resolved against the root the project was opened
 * at. Null for anything that lands outside every name that root goes by.
 */
function relativeToRoot(reported: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    const absolute = path.isAbsolute(reported) ? reported : path.resolve(root, reported);
    const relative = path.relative(root, absolute);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    return relative.split(path.sep).join('/');
  }
  return null;
}

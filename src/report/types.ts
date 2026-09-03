/**
 * What a test report says about a project. These live apart from
 * `project/coverage.ts` for the same reason `git/types.ts` lives apart from
 * `project/git.ts`: a box has to say how much of a file ran without pulling in
 * the module that reads the artefact off disk. `view/types.d.ts` naming a
 * module that imports `node:fs/promises` is the coupling both files exist to
 * prevent.
 *
 * `report/` and not `coverage/`, which is what it was called first and what it
 * obviously wants to be called. `coverage` is in `walk.ts`'s
 * `IGNORED_DIRECTORIES` — it is where nyc and vitest leave their output, and
 * istanbul's HTML report is full of JavaScript — so a directory of that name is
 * skipped at any depth, and this module was invisible to codemap in the one
 * repository codemap is always pointed at: absent from the graph, with all
 * seven imports of it resolving to nothing. It did not look broken. It looked
 * like a module nothing depends on, which is the authoritative-wrong picture
 * this project exists to refuse. Pinned by a test in `project/walk.test.ts`;
 * do not move it back.
 */

/** A file's line coverage — the currency a whole file is honestly measured in. */
export interface FileCoverage {
  /** Lines the report has an execution count for, not lines in the file. */
  lines: number;
  covered: number;
}

/**
 * What the report says about one symbol.
 *
 * `unknown` is the common answer and it is a real one, not a placeholder: most
 * of a graph cannot carry a number at all. 1094 of zod's 4201 symbols join,
 * because a field, an interface and a type have no runtime function to count —
 * and a file the run never imported has no data either way. `never` is the
 * answer worth having: zod's `util.assertNever` has five callers in the graph
 * and `FNDA:0` in the report, because every one of them is an exhaustiveness
 * branch that never runs.
 */
export type SymbolCoverage = 'covered' | 'never' | 'unknown';

export interface Coverage {
  /** Unix ms the artefact was written, so the page can say how old it is. */
  at: number;
  /** Which file the numbers came from, relative to the root, for the same reason. */
  source: string;
  /** Keyed by the graph's own file paths. A file with no data is absent. */
  files: Record<string, FileCoverage>;
  /** Keyed by node id. Every symbol the graph holds has an entry. */
  symbols: Record<string, SymbolCoverage>;
}

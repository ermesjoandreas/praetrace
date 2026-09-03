/**
 * Whether a path is a test, a fixture, or a story — code that exercises the
 * project rather than being it.
 *
 * One answer, shared by everything that has to tell the two apart: the
 * clustering, which must not let a test suite decide the architecture; the
 * `tests=0` filter; the search ranking; the tag on a box. Decided from the
 * path alone, and by convention rather than by reading the file, so the
 * answer is the same everywhere and costs nothing. A test file that follows
 * no convention at all is counted as source, which is the honest default: it
 * looks like source from the outside.
 */
export function isTestFile(filePath: string): boolean {
  const segments = filePath.split('/');
  const name = segments.pop() ?? '';
  if (segments.some((directory) => TEST_DIRECTORIES.has(directory))) return true;
  return TEST_NAMES.some((pattern) => pattern.test(name));
}

/**
 * Directories whose whole content is tests. Matched as a segment, so `test/`
 * at the root counts as much as `src/test/` — express keeps its suite in the
 * first place, Java in the second.
 */
const TEST_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'testdata',
  'fixtures',
]);

/** Basenames that announce a test, one convention per language family. */
const TEST_NAMES: readonly RegExp[] = [
  /\.(test|spec|stories)\.[^.]+$/, // lanes.test.ts, app.spec.js, Button.stories.tsx
  /_test\.go$/,
  /Tests?\.java$/,
  /Tests\.cs$/,
  /^tests\.rs$/,
];

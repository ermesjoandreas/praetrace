import path from 'node:path';

/**
 * Map a module specifier onto a file in the scanned set. Pure: it is given every
 * known file rather than touching the filesystem, which keeps the graph layer
 * testable and free of I/O.
 *
 * This is the TypeScript and JavaScript rule — a specifier is a path, and the
 * extension it names may not be the extension on disk. `src/lang/typescript.ts`
 * calls it for the relative case and layers aliases and package names on top;
 * languages that resolve by declared name instead have no use for it.
 *
 * Bare specifiers (`react`, `node:fs`) resolve to null here, and it is the
 * language's business whether they mean anything.
 */
export function resolveImport(
  fromFilePath: string,
  specifier: string,
  knownFiles: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;

  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFilePath), specifier));
  return resolveModulePath(base, knownFiles);
}

/**
 * The same extension arithmetic for a path that is already project-relative —
 * what a tsconfig alias or a package name expands to before it is a file.
 */
export function resolveModulePath(base: string, knownFiles: ReadonlySet<string>): string | null {
  for (const candidate of candidatesFor(base)) {
    if (knownFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * In preference order. An implementation beats the declaration that restates
 * it, which is why `.d.ts` is last: a project with both is describing one thing
 * twice, and the source is the half worth drawing.
 */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.d.ts'];

const WRITTEN = new Set(EXTENSIONS);
/** NodeNext ESM writes `./foo.js` for what is `./foo.ts` on disk. */
const REWRITTEN = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function candidatesFor(base: string): string[] {
  // `require('..')` from test/app.js arrives here as `.`, `require('../')` as
  // `./`, and `require('./')` as `lib/`: a directory, and the only file a
  // directory can mean is its index. Before this, every one of express's 91
  // test files required the package it tests and resolved to nothing, so
  // index.js — the one file the whole repository exists to export — was drawn
  // with no dependents at all.
  const directory = base === '.' || base === './' ? '' : base.replace(/\/$/, '');
  const indexes = EXTENSIONS.map((candidate) => path.posix.join(directory, `index${candidate}`));
  if (directory === '' || base.endsWith('/')) return indexes;

  const extension = /\.[a-z]+$/.exec(base)?.[0];

  if (extension !== undefined && WRITTEN.has(extension)) {
    if (!REWRITTEN.has(extension)) return [base];
    // A JavaScript extension is a question rather than an answer: it may be the
    // file, or the TypeScript source it was written to stand for.
    const stem = base.slice(0, -extension.length);
    return EXTENSIONS.map((candidate) => stem + candidate);
  }

  return [...EXTENSIONS.map((candidate) => base + candidate), ...indexes];
}

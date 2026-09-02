import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { knownExtensions } from '../lang/registry.js';

const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage']);

/** Shared with the watcher, so both see the same project. */
export function isIgnoredDirectoryName(name: string): boolean {
  return name.startsWith('.') || IGNORED_DIRECTORIES.has(name);
}

export interface SourceFile {
  /** POSIX path relative to the root; becomes the graph node id. */
  filePath: string;
  absolutePath: string;
}

/** The initial boot scan. Every later update re-parses one file, never this. */
export async function findSourceFiles(root: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];
  await visit(root, root, found);
  found.sort((a, b) => a.filePath.localeCompare(b.filePath));

  // The declaration rule needs the whole set, so it runs here rather than in the
  // per-name predicate above.
  const paths = new Set(found.map((file) => file.filePath));
  return found.filter((file) => !isShadowedDeclaration(file.filePath, paths));
}

async function visit(root: string, directory: string, found: SourceFile[]): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (isIgnoredDirectoryName(entry.name)) continue;
      await visit(root, absolutePath, found);
      continue;
    }

    if (!isSourceFileName(entry.name)) continue;
    if (!(await resolvesToFile(entry, absolutePath))) continue;

    found.push({
      absolutePath,
      filePath: path.relative(root, absolutePath).split(path.sep).join('/'),
    });
  }
}

/**
 * A symlink is neither a file nor a directory to `readdir`, so a symlinked
 * source is invisible unless something asks what it points at — every package in
 * TanStack/query links its eslint config to the root one, and those were the
 * only resolvable relative imports the tool missed in the whole corpus.
 *
 * A link to a directory is deliberately not followed: the tree it names is
 * already reachable by its real path, and walking both would draw every file in
 * it twice.
 */
async function resolvesToFile(entry: Dirent, absolutePath: string): Promise<boolean> {
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  // A dangling link stats to null rather than throwing the walk.
  return (await stat(absolutePath).catch(() => null))?.isFile() ?? false;
}

const SOURCE_EXTENSIONS = new Set(knownExtensions());

/**
 * Whether a name is one of the extensions some language claims. Deliberately
 * knows nothing about what else is in the project, because the watcher and the
 * hook endpoint decide one path at a time and have nothing else to go on.
 */
export function isSourceFileName(name: string): boolean {
  const lower = name.toLowerCase();
  const extension = lower.slice(lower.lastIndexOf('.'));
  return SOURCE_EXTENSIONS.has(extension);
}

/**
 * What each declaration extension can be a restatement of.
 *
 * The JavaScript spellings count, and that is not a TypeScript technicality: a
 * declaration emitted beside `foo.js` is what a typed JavaScript package ships,
 * and JavaScript is scanned source here, so a rule that only looked for `.ts`
 * and `.tsx` would keep both files and draw that module's symbols twice.
 */
const IMPLEMENTATIONS: ReadonlyMap<string, readonly string[]> = new Map([
  ['.d.ts', ['.ts', '.tsx', '.js', '.jsx']],
  ['.d.mts', ['.mts', '.mjs']],
  ['.d.cts', ['.cts', '.cjs']],
]);

/** The inverse, derived rather than written out, so the two cannot disagree. */
const DECLARATIONS: ReadonlyMap<string, string> = new Map(
  [...IMPLEMENTATIONS].flatMap(([declaration, sources]) =>
    sources.map((source): [string, string] => [source, declaration]),
  ),
);

/** `foo.d.ts` -> `foo.ts`, `foo.tsx`, …: the files that would make it a restatement. */
function implementationsOf(filePath: string): string[] {
  for (const [declaration, sources] of IMPLEMENTATIONS) {
    if (!filePath.endsWith(declaration)) continue;
    const stem = filePath.slice(0, -declaration.length);
    return sources.map((source) => `${stem}${source}`);
  }
  return [];
}

/** `foo.ts` -> `foo.d.ts`: the one file that could be standing behind it. */
function declarationFor(filePath: string): string | null {
  // A declaration's own name ends in `.ts`, and it restates nothing.
  if (implementationsOf(filePath).length > 0) return null;
  const extension = filePath.slice(filePath.lastIndexOf('.'));
  const declaration = DECLARATIONS.get(extension);
  return declaration === undefined ? null : `${filePath.slice(0, -extension.length)}${declaration}`;
}

/**
 * A `.d.ts` that only restates what a sibling implements.
 *
 * The old rule skipped every declaration file, which is right for a project
 * whose types are generated beside its source and wrong for a types-only
 * library: type-fest is 221 declaration files and resolved 0 of 487 imports
 * because the graph could not see a single one of them. So the test is not the
 * extension, it is whether an implementation exists — which needs the file set,
 * and is why this is not part of `isSourceFileName`.
 *
 * Exported so the sources that arrive one file at a time can apply it against
 * the files the graph already holds, rather than each inventing its own rule.
 */
export function isShadowedDeclaration(filePath: string, files: ReadonlySet<string>): boolean {
  return implementationsOf(filePath).some((sibling) => files.has(sibling));
}

/**
 * The declaration a source file was standing in front of, now that the source
 * is gone — or null when there is nothing to bring back.
 *
 * The rule runs both ways or it is not a rule. Deleting `foo.ts` returns
 * `foo.d.ts` to the project: the scan dropped it as a restatement, and with
 * nothing left to restate it is the only description of that module remaining.
 * Nothing in memory can answer this, because a shadowed declaration was never
 * stored — only the disk knows whether one is sitting there.
 */
export async function findRevealedDeclaration(
  removed: SourceFile,
  files: ReadonlySet<string>,
): Promise<SourceFile | null> {
  const filePath = declarationFor(removed.filePath);
  if (filePath === null || files.has(filePath)) return null;
  // Another implementation can still be in front of it: with `foo.ts` and
  // `foo.js` both present, losing one reveals nothing.
  if (isShadowedDeclaration(filePath, files)) return null;

  const absolutePath = path.join(path.dirname(removed.absolutePath), path.posix.basename(filePath));
  // Nothing generated beside this file is the ordinary answer, not a failure.
  const stats = await stat(absolutePath).catch(() => null);
  return stats?.isFile() ? { filePath, absolutePath } : null;
}

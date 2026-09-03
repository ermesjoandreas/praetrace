import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { knownExtensions } from '../lang/registry.js';

/**
 * Build output, by the names the tools give it. `target` is cargo's and Maven's:
 * without it the census below counted 2 801 `.d`, `.rmeta` and `.rlib` files
 * under src-tauri/target as things this tool could not read, and the scan drew
 * 22 generated `.rs` files from the same place as if they were the project's.
 */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', 'target']);

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
 * What was never going to be in a graph: prose, data, images, fonts, archives,
 * lockfiles, media. Everything else a language does not claim is counted as
 * unread, under its extension, so the interface can name what it does not know.
 *
 * The list is the complement of the one it replaced, and it is short for the
 * reason the old one was wrong. That one named twenty languages the tool knew
 * it could not read, and git/git is 1302 shell scripts, 40 Tcl files and 66
 * Perl files that were not on it — so "Cannot read" said 988 and meant "988 of
 * the kinds I had thought of". A list of what *is* source can never be kept
 * complete. A list of what is not can, because it is about files nobody would
 * ever ask for a diagram of.
 */
const NOT_SOURCE_EXTENSIONS = new Set([
  // prose
  '.md', '.markdown', '.mdx', '.rst', '.adoc', '.asciidoc', '.txt', '.rtf', '.pdf',
  // data and configuration
  '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.xml', '.csv', '.tsv',
  '.ini', '.cfg', '.conf', '.properties', '.env', '.plist', '.po', '.pot',
  '.lock', '.sum', '.log', '.patch', '.diff',
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.icns', '.webp', '.bmp',
  '.tif', '.tiff', '.psd', '.ai',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // archives and built things
  '.zip', '.gz', '.tgz', '.tar', '.bz2', '.xz', '.zst', '.7z', '.rar', '.jar',
  '.war', '.dmg', '.exe', '.dll', '.so', '.dylib', '.a', '.o', '.obj', '.lib',
  '.wasm', '.node', '.class', '.pyc', '.bin', '.dat', '.db', '.sqlite', '.map',
  '.snap',
  // media
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.mov', '.avi', '.flac', '.m4a',
]);

/**
 * Extensionless names that are prose or a manifest by convention. Lower-case,
 * because `README` and `Readme` are the same convention.
 */
const NOT_SOURCE_NAMES = new Set([
  'license', 'licence', 'copying', 'notice', 'authors', 'contributors',
  'changelog', 'changes', 'readme', 'install', 'todo', 'version', 'codeowners',
  'maintainers', 'owners', 'copyright', 'patents', 'news', 'history',
  'go.mod', 'go.sum', 'go.work',
]);

/**
 * The one bucket for files whose name carries no extension anyone would name
 * — a Makefile, `mergetools/vimdiff`, and the fixtures a test suite spells
 * `expect.git_one_two` or `foo.txt,v`. Counting each of those under its own
 * "extension" would list hundreds of kinds that exist once, which is noise
 * dressed up as a census.
 */
export const NO_EXTENSION = '(no extension)';

/**
 * The kind a file the tool cannot read is counted under, or null when it is
 * read, or was never source: `.sh` for a shell script, `(no extension)` for a
 * Makefile; null for `.png`, `.gitignore`, `LICENSE` and — because a language
 * claims it — `.eslintrc.js`.
 *
 * One name at a time, and nothing about the rest of the project, for the same
 * reason `isSourceFileName` is: the answer must not depend on what else is
 * there. A `.d.ts` is read here even when the scan later skips it as a
 * restatement of its sibling; skipped-on-purpose is not cannot-read.
 */
export function unreadExtension(name: string): string | null {
  if (isSourceFileName(name)) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith('.') || NOT_SOURCE_NAMES.has(lower)) return null;

  const dot = lower.lastIndexOf('.');
  if (dot === -1) return NO_EXTENSION;
  const extension = lower.slice(dot);
  if (NOT_SOURCE_EXTENSIONS.has(extension)) return null;
  return /^\.[a-z0-9]+$/.test(extension) ? extension : NO_EXTENSION;
}

export interface UnreadCount {
  /** An extension with its dot, or NO_EXTENSION. */
  extension: string;
  files: number;
}

/**
 * Count the files under the project no language claims, biggest kind first.
 *
 * The same directories `findSourceFiles` ignores, over the complement of the
 * same question. A directory that cannot be read is skipped rather than fatal:
 * an unreadable corner of the tree must not take down the answer for the rest
 * of it.
 */
export async function countUnreadable(root: string): Promise<UnreadCount[]> {
  const counted = new Map<string, number>();

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) await visit(absolutePath);
        continue;
      }
      const extension = unreadExtension(entry.name);
      if (extension === null || !(await resolvesToFile(entry, absolutePath))) continue;
      counted.set(extension, (counted.get(extension) ?? 0) + 1);
    }
  }

  await visit(root);

  return [...counted]
    .map(([extension, files]) => ({ extension, files }))
    .sort((a, b) => b.files - a.files || a.extension.localeCompare(b.extension));
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

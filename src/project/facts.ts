import { open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { EntryPoint, ProjectFacts } from '../lang/types.js';
import { isIgnoredDirectoryName } from './walk.js';
import { collectTsPaths } from './tsconfig.js';
import { collectCrates, collectGoModule, collectPackages } from './workspaces.js';

/**
 * Everything about a project that no single file can know.
 *
 * This is where the corpus said the graph was failing. Parsing was never the
 * problem: vuejs/core parsed cleanly and drew four boxes and zero edges, because
 * its 357 internal imports are aliases and its packages answer to names that
 * live in files the parser never opens. Resolution is a project-level question,
 * so the answers are gathered once, here, and handed to the languages.
 *
 * One walk feeds all of it. The four manifests are scattered — a tsconfig per
 * package, a package.json per package, a Cargo.toml per crate — and walking the
 * tree four times to find them would cost four times as much for the same
 * answer.
 */

interface Manifests {
  tsconfigs: string[];
  packages: string[];
  cargo: string[];
  goMod: string[];
  composer: string[];
}

function classify(name: string): keyof Manifests | null {
  if (name === 'package.json') return 'packages';
  if (name === 'composer.json') return 'composer';
  if (name === 'Cargo.toml') return 'cargo';
  if (name === 'go.mod') return 'goMod';
  // Not just `tsconfig.json`: query keeps its `@tanstack/query-core` alias in a
  // sibling `tsconfig.prod.json`, and zod's build configs carry aliases too.
  if (name.startsWith('tsconfig') && name.endsWith('.json')) return 'tsconfigs';
  // The same `paths` table, in the file a JavaScript-only project writes it in.
  if (name === 'jsconfig.json') return 'tsconfigs';
  return null;
}

/**
 * Files first, then subdirectories, so a manifest is always seen before any
 * manifest nested under it. That ordering is what lets the collectors resolve a
 * duplicate name by taking the first.
 */
async function visit(directory: string, found: Manifests): Promise<void> {
  // This walk runs after the source walk, not with it, so a directory can have
  // gone between the two. Losing one directory's manifests beats failing boot.
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!isIgnoredDirectoryName(entry.name)) directories.push(path.join(directory, entry.name));
      continue;
    }
    const kind = entry.isFile() ? classify(entry.name) : null;
    if (kind !== null) found[kind].push(path.join(directory, entry.name));
  }

  for (const child of directories) await visit(child, found);
}

/**
 * Every directory that holds a scanned file, ancestors included, so a package
 * can be asked whether the scan found anything inside it.
 */
function directoriesWithFiles(files: readonly string[]): Set<string> {
  const directories = new Set<string>(['']);
  for (const file of files) {
    let directory = file;
    for (;;) {
      const parent = path.posix.dirname(directory);
      if (parent === directory || parent === '.') break;
      if (directories.has(parent)) break;
      directories.add(parent);
      directory = parent;
    }
  }
  return directories;
}

/**
 * A name pointing at a directory the scan found nothing in cannot resolve to
 * anything, so it is dropped rather than carried. Not a correctness fix — the
 * lookup would have failed either way — but it keeps the map to the names that
 * can actually become an edge, which is what makes counting it worth anything.
 */
function withFiles(named: Map<string, string>, populated: ReadonlySet<string>): Map<string, string> {
  const kept = new Map<string, string>();
  for (const [name, directory] of named) {
    if (populated.has(directory)) kept.set(name, directory);
  }
  return kept;
}

/** A manifest's directory, project-relative POSIX; the project root is the empty string. */
function directoryOf(root: string, file: string): string {
  return path.relative(root, path.dirname(file)).split(path.sep).join('/');
}

/**
 * Where the project starts.
 *
 * Four manifests and one framework's convention, read here because this is
 * where manifests are read. package.json's `main`, `bin` and `exports`, and
 * any script that runs a file of the project's own — astrupdata's package.json
 * has no `main` at all, and five `tsx scripts/…` entries are the whole of what
 * it names. Cargo's `[[bin]]`, beside the `src/main.rs` and `src/bin/`
 * conventions. Python's `__main__.py`. And Next's pages and routes, by path,
 * only under a package that depends on `next`: a `pages/` directory of React
 * components is ordinary in a project that is not Next, and Gatsby routes by
 * the same name.
 *
 * A Go program's start is written in the file — `package main` and a `func
 * main` — and the parser already reads the first half as `moduleName`. But a
 * parse result is not a fact: facts are gathered while the workers parse, and
 * the graph carries no module name a pure module could read later. So the head
 * of each `.go` file is read here, once more, as the manifest of itself; the
 * cost is one small read per Go file. Both halves are required, because a file
 * in `package main` without `func main` is part of a program and not where it
 * starts — `cmd/foo/` is three such files and one start.
 *
 * Only files the scan found are kept — see EntryPoint — and one entry per
 * file, the first claim winning, in the order the claims are made below.
 */
async function collectEntryPoints(
  root: string,
  files: ReadonlySet<string>,
  found: Manifests,
): Promise<EntryPoint[]> {
  const claims: EntryPoint[] = [];
  for (const file of found.packages) claims.push(...(await packageEntryPoints(root, file, files)));
  for (const file of found.cargo) claims.push(...(await cargoEntryPoints(root, file, files)));
  claims.push(...(await goMains(root, files)));
  for (const file of files) {
    if (path.posix.basename(file) === '__main__.py') claims.push({ file, why: 'Python __main__' });
  }

  const byFile = new Map<string, EntryPoint>();
  for (const claim of claims) {
    if (!byFile.has(claim.file)) byFile.set(claim.file, claim);
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * The source a compiled name stands for: `.js` written where `.ts` is meant,
 * which is the ESM-in-TypeScript spelling typescript.ts already resolves
 * `./x.js` by.
 */
const SOURCE_FOR: ReadonlyMap<string, readonly string[]> = new Map([
  ['.js', ['.ts', '.tsx', '.jsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

/**
 * The scanned file a manifest path stands for, or null. Exact first, then the
 * source beside it that the `.js` is compiled from. Never `dist/` for `src/`:
 * that would be a guess about a build nobody described, and a guessed entry
 * point is the confident lie the front page exists not to tell.
 */
function scannedFile(candidate: string, files: ReadonlySet<string>): string | null {
  if (files.has(candidate)) return candidate;
  const extension = path.posix.extname(candidate);
  for (const source of SOURCE_FOR.get(extension) ?? []) {
    const sibling = candidate.slice(0, -extension.length) + source;
    if (files.has(sibling)) return sibling;
  }
  return null;
}

/** A path written in a manifest, relative to the manifest's directory, as project-relative POSIX. */
function inProject(directory: string, value: string): string {
  return path.posix.normalize(path.posix.join(directory, value));
}

/** The keys read out of package.json. Everything is `unknown` because a manifest is user input. */
interface PackageManifest {
  main?: unknown;
  bin?: unknown;
  exports?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

/** Every string under `exports`, however nested: a subpath map, a conditions map, or both. */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

/**
 * Whether a word in a script command could be a file of the project's own:
 * `tsx scripts/backfill.ts` names one, `next dev` and `--coverage` do not. The
 * scan decides in the end — a word that names no scanned file is dropped — so
 * this only has to keep the lookup off flags and bare commands.
 */
function looksLikeFile(token: string): boolean {
  if (token === '' || token.startsWith('-') || token.startsWith('$')) return false;
  return token.includes('/') || /\.(m?[jt]sx?|cjs|cts)$/.test(token);
}

function dependsOn(manifest: PackageManifest, name: string): boolean {
  for (const table of [manifest.dependencies, manifest.devDependencies]) {
    if (table !== null && typeof table === 'object' && name in table) return true;
  }
  return false;
}

async function packageEntryPoints(
  root: string,
  file: string,
  files: ReadonlySet<string>,
): Promise<EntryPoint[]> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return [];

  let manifest: PackageManifest;
  try {
    // Strict JSON, as in workspaces.ts: npm rejects anything else.
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') return [];
    manifest = parsed as PackageManifest;
  } catch {
    return [];
  }

  const directory = directoryOf(root, file);
  const out: EntryPoint[] = [];
  const claim = (value: unknown, why: string, detail?: string): void => {
    if (typeof value !== 'string' || value === '') return;
    const scanned = scannedFile(inProject(directory, value), files);
    if (scanned !== null) out.push({ file: scanned, why, ...(detail === undefined ? {} : { detail }) });
  };

  claim(manifest.main, 'package.json main');
  if (typeof manifest.bin === 'string') claim(manifest.bin, 'package.json bin');
  else if (manifest.bin !== null && typeof manifest.bin === 'object') {
    for (const value of Object.values(manifest.bin)) claim(value, 'package.json bin');
  }
  for (const target of exportTargets(manifest.exports)) claim(target, 'package.json exports');

  if (manifest.scripts !== null && typeof manifest.scripts === 'object') {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      if (typeof command !== 'string') continue;
      for (const word of command.split(/\s+/)) {
        const token = word.replace(/^["']|["']$/g, '');
        if (looksLikeFile(token)) claim(token, 'package.json script', name);
      }
    }
  }

  if (dependsOn(manifest, 'next')) out.push(...nextEntryPoints(directory, files));
  return out;
}

/**
 * Next's special files under `app/`, by the name that makes them special, and
 * what the front page calls each. A layout or template wraps every page below
 * it; the rest render in a page's place — while it loads, when it throws, when
 * there is none. None of them is where a person enters, but the framework
 * enters all of them, and nothing imports any: astrupdata's four layouts and
 * three error pages were the top of "nothing imports it" until they were
 * named here, beside seven components that really are dead.
 */
const NEXT_SPECIAL: ReadonlyMap<string, string> = new Map([
  ['page', 'Next.js page'],
  ['route', 'Next.js route'],
  ['layout', 'Next.js layout'],
  ['template', 'Next.js layout'],
  ['loading', 'Next.js fallback'],
  ['error', 'Next.js fallback'],
  ['global-error', 'Next.js fallback'],
  ['not-found', 'Next.js fallback'],
  ['default', 'Next.js fallback'],
]);
const NEXT_APP_FILE = /^([a-z-]+)\.(tsx|ts|jsx|js)$/;
const NEXT_PAGES_FILE = /\.(tsx|ts|jsx|js)$/;

/**
 * Next's routing is the file system. Under `app/`, every `page.tsx` is a route
 * and every `route.ts` a handler, and the other special files above are
 * loaded by name too; under the older `pages/`, every file is a page and
 * everything under `pages/api/` a handler. Either tree may sit under `src/`.
 * A name beginning with `_` — `_app`, `_document` — is Next's own
 * scaffolding, and a `.d.ts` declares rather than renders.
 */
function nextEntryPoints(directory: string, files: ReadonlySet<string>): EntryPoint[] {
  const out: EntryPoint[] = [];
  for (const base of [directory, path.posix.join(directory, 'src')]) {
    const app = `${path.posix.join(base, 'app')}/`;
    const pages = `${path.posix.join(base, 'pages')}/`;
    for (const file of files) {
      const name = path.posix.basename(file);
      if (file.startsWith(app)) {
        const why = NEXT_SPECIAL.get(NEXT_APP_FILE.exec(name)?.[1] ?? '');
        if (why !== undefined) out.push({ file, why });
      } else if (file.startsWith(pages)) {
        if (!NEXT_PAGES_FILE.test(name) || name.startsWith('_') || name.endsWith('.d.ts')) continue;
        out.push({ file, why: file.startsWith(`${pages}api/`) ? 'Next.js API route' : 'Next.js page' });
      }
    }
  }
  return out;
}

const TOML_HEADING = /^\s*\[/;
const TOML_BIN = /^\s*\[\[bin\]\]/;
const TOML_PATH = /^\s*path\s*=\s*"([^"]*)"/;

/**
 * Cargo's three ways to say where a binary starts: `src/main.rs` by
 * convention, every file directly under `src/bin/` (or a `main.rs` one
 * directory further down) by the same convention, and a `[[bin]]` table with
 * its `path` written out. A `[[bin]]` that gives a name and no path is the
 * `src/bin/` convention again, and is already covered by it. The line reader
 * `collectCrates` uses, for the same reason: one key under one heading.
 */
async function cargoEntryPoints(
  root: string,
  file: string,
  files: ReadonlySet<string>,
): Promise<EntryPoint[]> {
  const directory = directoryOf(root, file);
  const out: EntryPoint[] = [];

  const main = inProject(directory, 'src/main.rs');
  if (files.has(main)) out.push({ file: main, why: 'Cargo src/main.rs' });

  const bin = `${inProject(directory, 'src/bin')}/`;
  for (const candidate of files) {
    if (!candidate.startsWith(bin) || !candidate.endsWith('.rs')) continue;
    const below = candidate.slice(bin.length);
    if (!below.includes('/') || /^[^/]+\/main\.rs$/.test(below)) {
      out.push({ file: candidate, why: 'Cargo src/bin' });
    }
  }

  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return out;

  let inBin = false;
  for (const line of text.split('\n')) {
    if (TOML_HEADING.test(line)) {
      inBin = TOML_BIN.test(line);
      continue;
    }
    if (!inBin) continue;
    const target = TOML_PATH.exec(line)?.[1];
    if (target === undefined || target === '') continue;
    const scanned = scannedFile(inProject(directory, target), files);
    if (scanned !== null) out.push({ file: scanned, why: 'Cargo [[bin]]' });
  }
  return out;
}

const GO_PACKAGE_MAIN = /^package\s+main\b/m;
const GO_FUNC_MAIN = /^func\s+main\s*\(/m;
/** Past any licence header: Apache's is 600 bytes, and the longest in the corpus under 2 KB. */
const GO_HEAD_BYTES = 4096;
/**
 * Reads in flight at once. Every open holds a descriptor until its read and
 * close have had their turn in the thread pool, so opening a whole tree at
 * once is how a large Go repository runs out of them.
 */
const READS_AT_ONCE = 32;

async function goMains(root: string, files: ReadonlySet<string>): Promise<EntryPoint[]> {
  const candidates = [...files].filter((file) => file.endsWith('.go') && !file.endsWith('_test.go'));
  const out: EntryPoint[] = [];
  for (let start = 0; start < candidates.length; start += READS_AT_ONCE) {
    const batch = candidates.slice(start, start + READS_AT_ONCE);
    const answers = await Promise.all(batch.map((file) => isGoMain(path.join(root, file))));
    batch.forEach((file, index) => {
      if (answers[index]) out.push({ file, why: 'Go func main()' });
    });
  }
  return out;
}

/**
 * The package clause is in the head; `func main` usually is, and the whole
 * file is read only for a main package whose start is further down.
 */
async function isGoMain(absolutePath: string): Promise<boolean> {
  const head = await readHead(absolutePath, GO_HEAD_BYTES);
  if (head === null || !GO_PACKAGE_MAIN.test(head)) return false;
  if (GO_FUNC_MAIN.test(head)) return true;
  const whole = await readFile(absolutePath, 'utf8').catch(() => null);
  return whole !== null && GO_FUNC_MAIN.test(whole);
}

/** The first `bytes` of a file, or null when it cannot be read. */
async function readHead(absolutePath: string, bytes: number): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(absolutePath, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** What is read out of composer.json. `unknown` throughout, because a manifest is user input. */
interface ComposerManifest {
  autoload?: unknown;
  'autoload-dev'?: unknown;
}

/**
 * Namespace prefix -> the directories composer says it lives in.
 *
 * PSR-4 is PHP's resolver: `"App\\": "app/"` in composer.json is the whole of
 * how `App\Models\User` becomes `app/Models/User.php`, and the project states it
 * rather than the tool guessing it. Read from every composer.json the walk
 * found, because a monorepo of packages states it per package — symfony writes
 * one map at the root and another in each of its 60 components, and the second
 * is relative to the component's own directory.
 *
 * `autoload-dev` is merged in beside `autoload`. It maps the test tree, and a
 * test naming the class it tests is real coupling the graph should draw, the
 * same reason `devDependencies` is read a few functions up. `classmap` and
 * `files` are not read: they name paths rather than a prefix, so there is
 * nothing for a namespace to be turned into, and both are reachable anyway — a
 * classmap file declares its namespace like any other, and php.ts's fallback
 * finds it by that.
 *
 * Prefixes are stored with the trailing separator stripped and directories with
 * the trailing slash stripped, so the resolver joins them itself and never has
 * to ask which spelling it was handed. A `""` prefix is composer's fallback
 * directory and stays the empty string.
 */
async function collectPsr4(
  root: string,
  composerFiles: readonly string[],
): Promise<Map<string, string[]>> {
  const psr4 = new Map<string, string[]>();

  for (const file of composerFiles) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;

    let manifest: ComposerManifest;
    try {
      // Strict JSON, as package.json is: composer rejects anything else.
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object') continue;
      manifest = parsed as ComposerManifest;
    } catch {
      continue;
    }

    const directory = directoryOf(root, file);
    for (const section of [manifest.autoload, manifest['autoload-dev']]) {
      if (section === null || typeof section !== 'object') continue;
      const map = (section as { 'psr-4'?: unknown })['psr-4'];
      if (map === null || typeof map !== 'object') continue;

      for (const [prefix, target] of Object.entries(map)) {
        const namespace = prefix.replace(/\\+$/, '');
        const directories = (Array.isArray(target) ? target : [target]).filter(
          (value): value is string => typeof value === 'string',
        );
        const existing = psr4.get(namespace) ?? [];
        for (const value of directories) {
          // A path relative to the manifest, as project-relative POSIX. A
          // component manifest writes `""` for its own directory.
          const resolved = path.posix
            .normalize(path.posix.join(directory, value.replace(/\/+$/, '')))
            .replace(/^\.$/, '');
          if (!existing.includes(resolved)) existing.push(resolved);
        }
        if (existing.length > 0) psr4.set(namespace, existing);
      }
    }
  }

  return psr4;
}

export async function gatherFacts(root: string, files: readonly string[]): Promise<ProjectFacts> {
  const found: Manifests = { tsconfigs: [], packages: [], cargo: [], goMod: [], composer: [] };
  await visit(root, found);

  const scanned = new Set(files);
  const [tsPaths, packages, crates, goModule, psr4, entryPoints] = await Promise.all([
    collectTsPaths(root, found.tsconfigs),
    collectPackages(root, found.packages),
    collectCrates(root, found.cargo),
    collectGoModule(found.goMod),
    collectPsr4(root, found.composer),
    collectEntryPoints(root, scanned, found),
  ]);

  const populated = directoriesWithFiles(files);
  return {
    tsPaths,
    packages: withFiles(packages, populated),
    goModule,
    crates: withFiles(crates, populated),
    // Not passed through `withFiles`: a PSR-4 prefix maps to a directory that
    // may legitimately hold nothing yet, and php.ts checks the full path
    // against `files` before it answers.
    psr4,
    entryPoints,
  };
}

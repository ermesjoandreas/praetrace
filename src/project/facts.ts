import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { ProjectFacts } from '../lang/types.js';
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
}

function classify(name: string): keyof Manifests | null {
  if (name === 'package.json') return 'packages';
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

export async function gatherFacts(root: string, files: readonly string[]): Promise<ProjectFacts> {
  const found: Manifests = { tsconfigs: [], packages: [], cargo: [], goMod: [] };
  await visit(root, found);

  const [tsPaths, packages, crates, goModule] = await Promise.all([
    collectTsPaths(root, found.tsconfigs),
    collectPackages(root, found.packages),
    collectCrates(root, found.cargo),
    collectGoModule(found.goMod),
  ]);

  const populated = directoriesWithFiles(files);
  return {
    tsPaths,
    packages: withFiles(packages, populated),
    goModule,
    crates: withFiles(crates, populated),
  };
}

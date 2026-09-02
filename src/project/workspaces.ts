import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The names a project gives its own directories.
 *
 * A monorepo import does not look local. vuejs/core writes `@vue/shared`, and
 * 503 of TanStack/query's imports are `@tanstack/...` — indistinguishable from
 * `react` unless something knows that `packages/query-core` answers to that
 * name. The same problem, and the same answer, in three languages: npm
 * packages, Cargo crates, and the module path a Go project declares.
 *
 * Membership is read from the packages themselves, never from workspace globs.
 * npm, yarn, pnpm and lerna each declare it differently and two of them declare
 * it outside package.json entirely, but all four leave the same evidence on
 * disk: a package.json with a `name` in it.
 */

/** Every directory is project-relative POSIX; the project root is the empty string. */
function directoryOf(root: string, file: string): string {
  return path.relative(root, path.dirname(file)).split(path.sep).join('/');
}

export async function collectPackages(
  root: string,
  packageFiles: readonly string[],
): Promise<Map<string, string>> {
  const packages = new Map<string, string>();

  for (const file of packageFiles) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;

    let name: unknown;
    try {
      // package.json is strict JSON — npm rejects anything else — so no
      // tolerant reader here, unlike tsconfig.
      name = (JSON.parse(text) as { name?: unknown }).name;
    } catch {
      continue;
    }

    // First wins. The walk is depth-first, so the shallower package.json is
    // seen first and a vendored copy nested inside it cannot shadow it.
    if (typeof name === 'string' && name !== '' && !packages.has(name)) {
      packages.set(name, directoryOf(root, file));
    }
  }

  return packages;
}

const TOML_SECTION = /^\s*\[([^\]]+)\]/;
const TOML_NAME = /^\s*name\s*=\s*"([^"]*)"/;

/**
 * Crate name -> the directory holding its Cargo.toml.
 *
 * A line reader rather than a TOML parser, because only one key is wanted and
 * the section it sits in is what makes it unambiguous: clap's root manifest
 * declares `[workspace]`, `[workspace.package]` and `[dependencies]` before it
 * reaches the `name` under `[package]` on line 110.
 *
 * `[lib] name` is filed as well as `[package] name`, because it is the one a
 * `use` is written against when the two differ. This repository is the example:
 * src-tauri is package `codemap` and lib `codemap_lib`, and its own main.rs says
 * `codemap_lib::run()`.
 */
export async function collectCrates(
  root: string,
  cargoFiles: readonly string[],
): Promise<Map<string, string>> {
  const crates = new Map<string, string>();

  for (const file of cargoFiles) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) continue;

    const directory = directoryOf(root, file);
    let section = '';
    for (const line of text.split('\n')) {
      const heading = TOML_SECTION.exec(line);
      if (heading) {
        section = heading[1] ?? '';
        continue;
      }
      if (section !== 'package' && section !== 'lib') continue;

      const name = TOML_NAME.exec(line)?.[1];
      if (name === undefined || name === '') continue;

      if (!crates.has(name)) crates.set(name, directory);
      // Rust code says `clap_lex`, never `clap-lex`, so a hyphenated crate is
      // also filed under the name a `use` will actually be written with.
      const inCode = name.replace(/-/g, '_');
      if (!crates.has(inCode)) crates.set(inCode, directory);
    }
  }

  return crates;
}

const GO_MODULE = /^\s*module\s+(\S+)/m;

/**
 * The module path from go.mod, which is what makes an absolute Go import local:
 * a file in cobra imports `github.com/spf13/cobra/doc`, and only the manifest
 * says that prefix is this project.
 *
 * The shallowest go.mod wins. A repository can hold several, but the graph model
 * has one project, and the one at the top is the one whose prefix the rest of
 * the tree is written against.
 */
export async function collectGoModule(goModFiles: readonly string[]): Promise<string | null> {
  const shallowest = [...goModFiles].sort((a, b) => a.split(path.sep).length - b.split(path.sep).length)[0];
  if (shallowest === undefined) return null;

  const text = await readFile(shallowest, 'utf8').catch(() => null);
  return text === null ? null : (GO_MODULE.exec(text)?.[1] ?? null);
}

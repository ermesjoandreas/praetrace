import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * tsconfig `paths`, which is most of the difference between vuejs/core drawing
 * four boxes and drawing its real shape. 357 of its imports are written
 * `@vue/shared` rather than `../../shared/src`, and an alias nobody reads is an
 * edge nobody draws — which does not look broken, it looks like code with no
 * coupling.
 *
 * Two things make this more than a `JSON.parse`:
 *
 * - A tsconfig is JSONC. 43 of the 178 in the corpus have comments or trailing
 *   commas and are unreadable to a strict parser, TanStack/query's among them.
 * - The aliases are usually not in the root config. zod's live in a docs
 *   package, and query keeps `@tanstack/query-core` in a `tsconfig.prod.json`
 *   one directory down, so every config in the project is read and each one's
 *   targets are resolved against its own directory.
 */

/** What is left of a tsconfig once everything we do not read is dropped. */
type RawConfig = Record<string, unknown>;

/** Absolute config path -> its contents, or null when missing or unreadable. */
type ConfigCache = Map<string, RawConfig | null>;

interface Inherited {
  /** Absolute directory `paths` targets are relative to, when one is declared. */
  baseUrl: string | null;
  /**
   * The winning `paths` table and the config that declared it. Relative paths in
   * a config are resolved against the file they were written in, not against the
   * one that extends it, so the directory has to travel with the table.
   */
  paths: { directory: string; table: Map<string, readonly string[]> } | null;
}

const NOTHING: Inherited = { baseUrl: null, paths: null };

/**
 * A tolerant JSON reader: comments and trailing commas, which real tsconfigs
 * have and `JSON.parse` rejects.
 *
 * String literals are copied through untouched, so the `//` in
 * `"$schema": "https://json.schemastore.org/tsconfig"` is not mistaken for a
 * comment — the bug every naive strip-the-comments regex has. Written rather
 * than depended on because the whole grammar is two comment forms and one
 * stray comma.
 */
export function parseJsonc(text: string): unknown {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let out = '';
  let i = 0;

  while (i < source.length) {
    const character = source[i];

    if (character === '"') {
      let end = i + 1;
      while (end < source.length) {
        if (source[end] === '\\') {
          end += 2;
          continue;
        }
        end += 1;
        if (source[end - 1] === '"') break;
      }
      out += source.slice(i, end);
      i = end;
      continue;
    }

    if (character === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }

    if (character === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }

    // A closer is the only place a trailing comma can appear, and a string
    // literal always ends in a quote, so this can never reach inside one.
    if (character === '}' || character === ']') out = out.replace(/,\s*$/, '');

    out += character;
    i += 1;
  }

  return JSON.parse(out);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function loadConfig(cache: ConfigCache, file: string): Promise<RawConfig | null> {
  const cached = cache.get(file);
  if (cached !== undefined) return cached;

  const text = await readFile(file, 'utf8').catch(() => null);
  let config: RawConfig | null = null;
  if (text !== null) {
    try {
      config = asRecord(parseJsonc(text));
    } catch {
      // A config we cannot read costs the aliases it declared and nothing else.
      config = null;
    }
  }

  cache.set(file, config);
  return config;
}

function extendsList(config: RawConfig): string[] {
  const value = config['extends'];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

function pathsTable(options: Record<string, unknown>): Map<string, readonly string[]> | null {
  const raw = asRecord(options['paths']);
  if (raw === null) return null;

  const table = new Map<string, readonly string[]>();
  for (const [pattern, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue;
    const targets = value.filter((entry): entry is string => typeof entry === 'string');
    if (targets.length > 0) table.set(pattern, targets);
  }
  return table.size > 0 ? table : null;
}

/**
 * `extends` names either a path or a package. The package form is resolved the
 * way Node would, walking up through `node_modules` — which is how a config
 * inherits from `@sindresorhus/tsconfig` or `astro/tsconfigs/strict`.
 */
async function locateExtends(
  cache: ConfigCache,
  fromDirectory: string,
  specifier: string,
): Promise<string | null> {
  const candidates: string[] = [];

  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    const resolved = path.resolve(fromDirectory, specifier);
    candidates.push(resolved, `${resolved}.json`);
  } else {
    let directory = fromDirectory;
    for (;;) {
      const base = path.join(directory, 'node_modules', specifier);
      candidates.push(base, `${base}.json`, path.join(base, 'tsconfig.json'));
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }

  for (const candidate of candidates) {
    if (await loadConfig(cache, candidate)) return candidate;
  }
  return null;
}

/**
 * The effective `baseUrl` and `paths` for one config, after `extends`.
 *
 * `paths` is replaced wholesale by whichever config declares it last, never
 * merged — that is TypeScript's rule, and merging would invent aliases the
 * compiler does not have. `seen` guards the cycle a hand-written `extends` pair
 * can form.
 */
async function inherited(cache: ConfigCache, file: string, seen: Set<string>): Promise<Inherited> {
  if (seen.has(file)) return NOTHING;
  seen.add(file);

  const config = await loadConfig(cache, file);
  if (config === null) return NOTHING;

  const directory = path.dirname(file);
  let result = NOTHING;

  // Left to right, so the rightmost entry of an `extends` array wins.
  for (const specifier of extendsList(config)) {
    const base = await locateExtends(cache, directory, specifier);
    if (base === null) continue;
    const from = await inherited(cache, base, seen);
    result = { baseUrl: from.baseUrl ?? result.baseUrl, paths: from.paths ?? result.paths };
  }

  const options = asRecord(config['compilerOptions']) ?? {};
  const baseUrl = options['baseUrl'];
  const table = pathsTable(options);

  return {
    baseUrl: typeof baseUrl === 'string' ? path.resolve(directory, baseUrl) : result.baseUrl,
    paths: table === null ? result.paths : { directory, table },
  };
}

function projectRelative(root: string, absolute: string): string | null {
  const relative = path.relative(root, absolute);
  // A target outside the project can never name a file the scan found.
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const posix = relative.split(path.sep).join('/');
  // An alias into node_modules names a dependency, which the graph deliberately
  // does not hold. query aliases `react` to a bundled preact/compat; keeping it
  // would turn a bare import the tool is right to ignore into a phantom edge.
  if (posix.split('/').includes('node_modules')) return null;

  return posix;
}

/**
 * Every alias the project declares, flattened to project-relative POSIX targets.
 *
 * Patterns from different configs share one table, so an `@/*` declared in two
 * packages ends up with both targets. That is deliberate: the resolver checks
 * which target exists, and a table keyed by config would make every lookup ask
 * which config governs the importing file — a question tsc answers with the
 * `include` globs we do not read.
 */
export async function collectTsPaths(
  root: string,
  configFiles: readonly string[],
): Promise<Map<string, string[]>> {
  const cache: ConfigCache = new Map();
  const collected = new Map<string, string[]>();

  for (const file of configFiles) {
    const { baseUrl, paths } = await inherited(cache, file, new Set());
    if (paths === null) continue;

    const base = baseUrl ?? paths.directory;
    for (const [pattern, targets] of paths.table) {
      const merged = collected.get(pattern) ?? [];
      for (const target of targets) {
        const relative = projectRelative(root, path.resolve(base, target));
        if (relative !== null && !merged.includes(relative)) merged.push(relative);
      }
      if (merged.length > 0) collected.set(pattern, merged);
    }
  }

  return collected;
}

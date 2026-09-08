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
 *
 * `.vue` is here rather than in `vue.ts`, because the file importing a
 * component is usually not itself a component: `import TabPane from
 * './components/TabPane'` is `TabPane.vue` and `import Layout from '@/layout'`
 * is `layout/index.vue`, and both are as often written in a `.ts` router as in
 * an SFC. It sits after the JavaScript family so `./foo` still prefers `foo.ts`
 * where a project holds both.
 */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.d.ts'];

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

  // An extension no language here rewrites is the name of a real file or of
  // nothing: `./Modal.svelte` is Modal.svelte, and appending `.ts` to it names
  // nothing anywhere. Tried first, and it costs nothing when the project holds
  // no such file — only a walked file is ever in `knownFiles`. The appended
  // candidates still follow, because `auth-manager.svelte` is also how a Svelte
  // 5 rune module named `auth-manager.svelte.ts` is imported.
  return [
    ...(extension === undefined ? [] : [base]),
    ...EXTENSIONS.map((candidate) => base + candidate),
    ...indexes,
  ];
}

/**
 * What is not source, whatever a bundler does with it. Fixed rather than derived
 * from the files the scan found: a project with no stylesheet would otherwise
 * decide `./theme.css` is a resolution failure the first time someone adds one.
 */
const ASSET_EXTENSIONS = new Set([
  'css', 'scss', 'sass', 'less', 'styl', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif',
  'ico', 'json', 'json5', 'md', 'mdx', 'txt', 'csv', 'yaml', 'yml', 'toml', 'xml', 'html',
  'wasm', 'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp3', 'mp4', 'webm', 'wav', 'pdf', 'graphql',
]);

/** `./styles.css` is not a resolution failure, it is a stylesheet. */
function isAsset(specifier: string): boolean {
  const extension = /[^/.]\.([a-z0-9]+)$/i.exec(specifier)?.[1]?.toLowerCase();
  return extension !== undefined && ASSET_EXTENSIONS.has(extension);
}

/** Whether a tsconfig `paths` entry claims this specifier. Membership, not resolution. */
function matchesAlias(specifier: string, tsPaths: ReadonlyMap<string, readonly string[]>): boolean {
  if (tsPaths.has(specifier)) return true;
  for (const pattern of tsPaths.keys()) {
    const star = pattern.indexOf('*');
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (specifier.length < prefix.length + suffix.length) continue;
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix)) return true;
  }
  return false;
}

function inWorkspace(specifier: string, packages: ReadonlyMap<string, string>): boolean {
  if (packages.has(specifier)) return true;
  for (const name of packages.keys()) if (specifier.startsWith(`${name}/`)) return true;
  return false;
}

/**
 * Whether a specifier names something this project could plausibly hold.
 *
 * The difference between a gap and a fact. `import http from "node:http"` did not
 * resolve, and nothing is missing — node:http is not in the project and never
 * will be. `import { Store } from "@app/core"` did not resolve either, and that
 * IS missing coupling. Counting both as "unresolved" put the mark on nearly every
 * file in express, where 241 of 241 unresolved specifiers are node builtins and
 * npm packages: an authoritative-looking claim that coupling was lost when none
 * was.
 *
 * What makes a bare specifier the project's own is an alias or a workspace
 * package — the two tables the TypeScript resolver itself consults. It errs
 * towards yes: java.ts qualifies an implicit reference with the file's own
 * package, so `String` arrives as `com.google.gson.String` and reads as internal.
 * A count that is slightly too high is a gap reported; one that is too low hides
 * the thing the count exists for.
 */
export function looksInternal(
  specifier: string,
  language: string,
  facts: { tsPaths: ReadonlyMap<string, readonly string[]>; packages: ReadonlyMap<string, string>; goModule: string | null },
  modulePrefixes: ReadonlySet<string>,
): boolean {
  if (specifier.startsWith('.')) return !isAsset(specifier);
  if (language === 'typescript' || language === 'javascript') {
    if (isAsset(specifier)) return false;
    return matchesAlias(specifier, facts.tsPaths) || inWorkspace(specifier, facts.packages);
  }
  if (/^(crate|self|super)::/.test(specifier)) return true;
  if (facts.goModule !== null && specifier.startsWith(facts.goModule)) return true;
  // C and C++ say which is which in the punctuation: a quoted include is a path
  // the project could hold, an angled one is a system or third-party header and
  // is no more missing than `node:http` is. Kept in the specifier because that
  // is how the resolver tells them apart too.
  if (language === 'cpp') return specifier.startsWith('"');
  // A Kotlin bare type name arrives as the packages it *might* have come from,
  // separated — a guess list, not an import the file wrote. Its head is the
  // file's own package, so it read as internal, and every `String`, `List` and
  // `Exception` counted as coupling the project had lost. Counting them is the
  // express failure again: 133 of 141 files marked, claiming lost coupling
  // where there was none. A written `import` line still counts.
  if (specifier.includes('|')) return false;
  // PHP separates a namespace with a backslash, so without it the head was the
  // whole specifier and nothing PHP ever wrote could be counted.
  const head = specifier.split(/[.:/\\]/)[0];
  return head !== undefined && head !== '' && modulePrefixes.has(head);
}

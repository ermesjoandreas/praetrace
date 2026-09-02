#!/usr/bin/env node
/**
 * Run the graph engine against real projects and report what it made of them.
 *
 * The point is not to check that nothing crashes — it is to find where the graph
 * is *quietly wrong*, which is the only failure mode that matters for a tool
 * whose whole job is to be trusted at a glance. A project whose imports all go
 * through a tsconfig alias produces a graph with almost no edges, and that does
 * not look broken: it looks like a codebase with very little coupling.
 *
 * So the headline number is not the graph, it is the ROOT VIEW — the boxes and
 * edges the page actually draws when you open the project. A repository that
 * opens with zero edges is the failure this script exists to catch.
 *
 *   node scripts/corpus.mjs <dir> [<dir>...]
 *   node scripts/corpus.mjs --json <dir>
 *
 * Uses dist/, so run `npm run build` first.
 */

import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';

import { createParserPool } from '../dist/parser/pool.js';
import { scanProject } from '../dist/project/scan.js';
import { applyBatch, createStore, setProjectFacts } from '../dist/graph/store.js';
import { languageById, knownExtensions } from '../dist/lang/registry.js';
import { clusterFiles } from '../dist/view/cluster.js';
import { selectView } from '../dist/view/select.js';
import { NO_FILTER } from '../dist/view/filter.js';

/** The languages that declare no module name, and so answer by manifest instead. */
const JS_FAMILY = new Set(['typescript', 'javascript']);

/**
 * Whether a tsconfig `paths` entry claims this specifier.
 *
 * The shape of `pathTargets` in src/lang/typescript.ts, asking membership rather
 * than resolution: these specifiers have already failed to resolve, so the
 * question is whether the project said the name is its own, not which file it
 * would have landed on. Longest-prefix does not matter for a yes/no.
 */
function matchesAlias(specifier, tsPaths) {
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

/** A workspace package by name, or a subpath into one. */
function inWorkspace(specifier, packages) {
  if (packages.has(specifier)) return true;
  for (const name of packages.keys()) {
    if (specifier.startsWith(`${name}/`)) return true;
  }
  return false;
}

/**
 * Whether a specifier names something the project could plausibly hold.
 *
 * The old test was `startsWith('.')`, which is a TypeScript answer to a question
 * six languages now ask. `java.util.List`, `fmt` and `std::fmt` are all supposed
 * to resolve to nothing, and counting them as misses buries the ones that are
 * really misses — gson alone writes 1,551 JDK references.
 *
 * The head-of-name test that answers for the other five is built from declared
 * module names, which the JS family never writes, so on a TypeScript repo it can
 * only ever say no and the count collapses back to "relative". That is exactly
 * the number this script exists to make honest: query has 1,706 unresolved
 * imports and used to report 10 as internal. What makes a bare specifier the
 * project's own here is an alias or a workspace package — the two tables the
 * TypeScript resolver itself consults, and the two the corpus keeps finding.
 *
 * It errs towards saying yes. java.ts qualifies an implicit reference with the
 * package the file is in, so `String` arrives as `com.google.gson.String` and
 * looks internal. The top-five list beside the count is what makes that visible,
 * and it is cheaper than teaching this script what the JDK holds.
 */
function looksInternal(specifier, language, modulePrefixes, facts) {
  if (specifier.startsWith('.')) return !isAsset(specifier);
  if (JS_FAMILY.has(language)) {
    // An alias points at assets too: zod imports `@/public/logo/logo.png`.
    if (isAsset(specifier)) return false;
    return matchesAlias(specifier, facts.tsPaths) || inWorkspace(specifier, facts.packages);
  }
  if (/^(crate|self|super)::/.test(specifier)) return true;
  if (facts.goModule && specifier.startsWith(facts.goModule)) return true;
  // A dotted or scoped name whose head some file in the project answers to.
  const head = specifier.split(/[.:/]/)[0];
  return head !== undefined && head !== '' && modulePrefixes.has(head);
}

const SOURCE_EXTENSIONS = new Set(knownExtensions());

/**
 * `./styles.css` is not a resolution failure, it is a stylesheet. Only relative
 * specifiers and the JS family are tested: a dotted Java package would match the
 * extension shape by accident — `com.example.util` ends in `.util`.
 *
 * A stem is required ahead of the dot, or a trailing path segment that is itself
 * dotted reads as an extension. zod aliases `@/.source` at a generated directory
 * the walk skips for being dotted — an internal reference the graph genuinely
 * cannot draw, and the kind this count exists to surface.
 */
function isAsset(specifier) {
  const extension = /[^/.]\.[a-z0-9]+$/.exec(specifier)?.[0].slice(1);
  return extension !== undefined && !SOURCE_EXTENSIONS.has(extension);
}

/**
 * Declarations the parser might have no node kind for, checked against where the
 * symbols actually start. Counting matches alone over-reports: a regex sees the
 * 13 TypeScript enums vuejs/core writes inside template literals in its own
 * compiler tests, which are correctly not parsed.
 */
const BLIND_SPOTS = [
  ['enum', /^[^\S\n]*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+\w/gm],
  ['namespace', /^[^\S\n]*(?:export\s+)?(?:declare\s+)?namespace\s+\w/gm],
  ['declare module', /^[^\S\n]*declare\s+module\s/gm],
  ['class expression', /^[^\S\n]*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*class\b/gm],
];

/** Only the JS family writes these, and only it is worth reading back. */
const BLIND_SPOT_LANGUAGES = new Set(['typescript', 'javascript']);

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (source.charCodeAt(i) === 10) line += 1;
  return line;
}

async function measure(root) {
  const pool = createParserPool();
  const store = createStore();

  const scanStart = performance.now();
  const scan = await scanProject(pool, root);
  const scanMs = performance.now() - scanStart;

  // Facts before files, exactly as the server and the CLI install them. Without
  // this line the script measures a graph the app does not build.
  setProjectFacts(store, scan.facts);
  applyBatch(store, scan.parsed, []);

  // What one save costs. derive() rebuilds every node and edge from the stored
  // parse results on every mutation, so this is the number that decides whether
  // the tool stays usable as a project grows.
  const sample = scan.parsed[0];
  const deriveTimes = [];
  for (let i = 0; i < 5 && sample; i += 1) {
    const start = performance.now();
    applyBatch(store, [sample], []);
    deriveTimes.push(performance.now() - start);
  }
  deriveTimes.sort((a, b) => a - b);

  await pool.close();

  // The same arguments derive() builds, so resolution here is the resolution the
  // graph got — asking resolveImport directly would report every alias, package
  // name and Java package as a miss. Owned symbols are left out of `declarations`
  // exactly as the store leaves them out of its name table.
  const known = new Set(scan.parsed.map((file) => file.filePath));
  const modules = new Map();
  const declarations = new Map();
  // C# reads every file's usings, not just the referring one's: a `global using`
  // sits in a file of its own and decides what the rest of the project can name.
  const references = new Map();
  for (const file of scan.parsed) {
    if (file.moduleName !== undefined) modules.set(file.filePath, file.moduleName);
    references.set(file.filePath, file.imports);
    declarations.set(
      file.filePath,
      new Set(file.symbols.filter((symbol) => symbol.owner === undefined).map((symbol) => symbol.name)),
    );
  }
  const modulePrefixes = new Set([...modules.values()].map((name) => name.split(/[.:/]/)[0]));

  const languages = new Map();
  const worst = new Map();
  let imports = 0;
  let unresolved = 0;
  let unresolvedInternal = 0;

  for (const file of scan.parsed) {
    const language = languageById(file.language);
    const counts = languages.get(file.language) ?? { files: 0, imports: 0, unresolved: 0 };
    counts.files += 1;

    for (const specifier of file.imports) {
      imports += 1;
      counts.imports += 1;
      const context = {
        from: file.filePath,
        specifier,
        files: known,
        modules,
        declarations,
        imports: references,
        facts: scan.facts,
      };
      if (language?.resolve(context)) continue;
      unresolved += 1;
      counts.unresolved += 1;
      // A bare `react` is supposed to resolve to nothing; a project-shaped
      // specifier that did not is the only kind worth naming.
      if (looksInternal(specifier, file.language, modulePrefixes, scan.facts)) {
        unresolvedInternal += 1;
        worst.set(specifier, (worst.get(specifier) ?? 0) + 1);
      }
    }

    languages.set(file.language, counts);
  }

  const kinds = {};
  for (const node of store.graph.nodes.values()) {
    kinds[node.kind] = (kinds[node.kind] ?? 0) + 1;
  }

  // Read the sources back to count what the parser has no node kind for. Cheap
  // enough at corpus sizes, and it is the only way to see a silent omission.
  const blind = Object.fromEntries(BLIND_SPOTS.map(([name]) => [name, 0]));
  let emptyButNotBlank = 0;
  for (const file of scan.parsed) {
    if (!BLIND_SPOT_LANGUAGES.has(file.language)) continue;
    const source = await readFile(path.join(root, file.filePath), 'utf8').catch(() => '');
    const declared = new Set(file.symbols.map((symbol) => symbol.startLine));

    for (const [name, pattern] of BLIND_SPOTS) {
      pattern.lastIndex = 0;
      // Only a declaration with no symbol on its line is actually missing.
      for (const hit of source.matchAll(pattern)) {
        if (!declared.has(lineOf(source, hit.index))) blind[name] += 1;
      }
    }

    // A file that declares something the graph does not hold. Not proof of a
    // bug — a file of only re-exports is legitimately empty — but the ratio is
    // where silent loss would show up.
    if (file.symbols.length === 0 && /^\s*(?:export\s+)?(?:class|function|interface)\s/m.test(source)) {
      emptyButNotBlank += 1;
    }
  }

  const clusters = clusterFiles(store.graph);
  const largest = clusters.reduce((a, b) => (a && a.files.length >= b.files.length ? a : b), null);

  return {
    project: path.basename(root),
    files: scan.parsed.length,
    failures: scan.failures.length,
    firstFailures: scan.failures.slice(0, 3),
    nodes: store.graph.nodes.size,
    edges: store.graph.edges.length,
    scanMs: Math.round(scanMs),
    deriveMedianMs: deriveTimes.length ? Number(deriveTimes[Math.floor(deriveTimes.length / 2)].toFixed(1)) : 0,
    languages: [...languages]
      .map(([id, counts]) => ({ id, ...counts }))
      .sort((a, b) => b.files - a.files || a.id.localeCompare(b.id)),
    imports,
    unresolved,
    unresolvedPct: imports === 0 ? 0 : Math.round((unresolved / imports) * 100),
    unresolvedInternal,
    worstSpecifiers: [...worst.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5),
    kinds,
    blind,
    emptyButNotBlank,
    root: rootView(store.graph),
    clusters: clusters.length,
    largestClusterPct: largest && scan.parsed.length ? Math.round((largest.files.length / scan.parsed.length) * 100) : 0,
    largestClusterCohesion: largest ? Number(largest.cohesion.toFixed(2)) : 0,
  };
}

/**
 * The acceptance test: what the page draws when the project is opened, with no
 * scope, no focus and nothing filtered out. Isolated boxes are the number that
 * matters — a box with no edge is one the graph could not connect to anything.
 */
function rootView(graph) {
  const view = selectView(graph, { scope: '', focus: null, depth: 1, filter: NO_FILTER }, Date.now());

  const connected = new Set();
  for (const edge of view.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }

  return {
    boxes: view.nodes.length,
    edges: view.edges.length,
    isolated: view.nodes.filter((node) => !connected.has(node.id)).length,
    grouped: view.grouped,
    scope: view.spec.scope,
    totalFiles: view.totalFiles,
  };
}

function report(row) {
  const languages = row.languages.map((l) => `${l.id} ${l.files}`).join(' · ');
  const blind = Object.entries(row.blind)
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(', ');

  console.log(`\n${row.project}`);
  console.log(`  ${languages}`);
  console.log(`  ${row.files} files · ${row.nodes} nodes · ${row.edges} edges` +
    (row.failures ? ` · ${row.failures} parse failures` : ''));
  for (const failure of row.firstFailures) console.log(`      ${failure}`);
  console.log(`  scan ${row.scanMs} ms · one save re-derives in ${row.deriveMedianMs} ms`);
  console.log(`  imports ${row.imports}, ${row.unresolvedPct}% unresolved` +
    ` (${row.unresolvedInternal} of them name something the project might hold)`);
  for (const [specifier, count] of row.worstSpecifiers) {
    console.log(`      ${String(count).padStart(4)}x ${specifier}`);
  }
  console.log(`  ROOT VIEW: ${row.root.boxes} boxes · ${row.root.edges} edges · ` +
    `${row.root.isolated} with no edge` +
    (row.root.grouped ? ` (folders, ${row.root.totalFiles} files)` : '') +
    (row.root.scope ? ` (descended to ${row.root.scope})` : ''));
  if (blind) console.log(`  declared in source but not in the graph: ${blind}`);
  if (row.emptyButNotBlank) {
    console.log(`  ${row.emptyButNotBlank} files declare something but hold no symbols`);
  }
  console.log(`  ${row.clusters} groups, largest covers ${row.largestClusterPct}% at ${row.largestClusterCohesion} cohesion`);
}

/** One line per project, for reading ten of them at once. */
function table(rows) {
  const columns = ['project', 'files', 'edges', 'boxes', 'view edges', 'no edge', 'unres%'];
  const cells = rows.map((row) => [
    row.project,
    String(row.files),
    String(row.edges),
    String(row.root.boxes),
    String(row.root.edges),
    String(row.root.isolated),
    `${row.unresolvedPct}%`,
  ]);

  const widths = columns.map((name, i) =>
    Math.max(name.length, ...cells.map((cell) => cell[i].length)),
  );
  const line = (cell) => cell.map((value, i) => (i === 0 ? value.padEnd(widths[i]) : value.padStart(widths[i]))).join('  ');

  console.log(`\n${line(columns)}`);
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const cell of cells) console.log(line(cell));
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const roots = args.filter((arg) => !arg.startsWith('--'));

if (roots.length === 0) {
  console.error('usage: node scripts/corpus.mjs [--json] <dir> [<dir>...]');
  process.exit(1);
}

const rows = [];
for (const root of roots) {
  try {
    rows.push(await measure(path.resolve(root)));
  } catch (cause) {
    console.error(`${root}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) report(row);
  if (rows.length > 1) table(rows);
}

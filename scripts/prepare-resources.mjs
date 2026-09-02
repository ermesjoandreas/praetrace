// Builds the app payload Tauri ships as a resource: the compiled server and web
// page, plus only the dependencies the server actually loads at runtime.
//
// Shipping the repository's node_modules would carry 160 MB of build tooling
// into the bundle. The frontend's dependencies are already inside dist/web,
// bundled by Vite, so the only real files needed are Fastify, chokidar and the
// tree-sitter addons — and of those, only this platform's native binaries.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const staging = path.join(repoRoot, 'dist-app');

/**
 * What `dist/server` imports at run time. Everything else is a build tool.
 *
 * Every grammar in `src/lang/` belongs here, not only the ones this repository
 * is written in. The list still carried the two from when the tool read
 * TypeScript alone, so the packaged app offered six languages and could parse
 * one — and it did not say so: a grammar that is not in the bundle fails one
 * file at a time, on a stderr stream the desktop app has nobody reading, and
 * the language simply never appears in the graph.
 */
const RUNTIME_DEPENDENCIES = [
  '@fastify/static',
  '@fastify/websocket',
  'chokidar',
  'fastify',
  'tree-sitter',
  'tree-sitter-c-sharp',
  'tree-sitter-go',
  'tree-sitter-java',
  'tree-sitter-javascript',
  'tree-sitter-rust',
  'tree-sitter-typescript',
];

/** Where a package keeps a generated parser. tree-sitter-typescript ships two. */
const GENERATED_SOURCES = ['src', 'typescript/src', 'tsx/src'];

const platformPrebuild = `${process.platform === 'win32' ? 'win32' : process.platform}-${
  process.arch === 'x64' ? 'x64' : process.arch
}`;

const manifest = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8'));

await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });

await cp(path.join(repoRoot, 'dist'), path.join(staging, 'dist'), { recursive: true });

// A manifest of its own, so `npm install` here resolves a production-only tree
// rather than the repository's full one.
await writeFile(
  path.join(staging, 'package.json'),
  `${JSON.stringify(
    {
      name: 'codemap-app',
      private: true,
      type: 'module',
      dependencies: Object.fromEntries(
        RUNTIME_DEPENDENCIES.map((name) => [name, manifest.dependencies[name]]),
      ),
    },
    null,
    2,
  )}\n`,
);

// The same peer-dependency situation as the repository, for the same reason.
await writeFile(path.join(staging, '.npmrc'), 'legacy-peer-deps=true\n');

console.log('installing runtime dependencies…');
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--silent'], {
  cwd: staging,
  stdio: 'inherit',
});

// Native addons ship prebuilt for six platforms, and a grammar package is
// mostly the generated C those were built from. Both are dead weight in a
// bundle that only ever runs here, and six grammars make it 142 MB of it.
await pruneGrammars(path.join(staging, 'node_modules'));

const size = execFileSync('du', ['-sh', staging], { encoding: 'utf8' }).split('\t')[0];
console.log(`app payload ready: dist-app (${size.trim()}, prebuilds pruned to ${platformPrebuild})`);

async function pruneGrammars(modules) {
  for (const pkg of await findGrammarPackages(modules)) {
    const prebuilds = path.join(pkg, 'prebuilds');
    if (existsSync(prebuilds)) {
      for (const entry of await readdir(prebuilds)) {
        if (entry !== platformPrebuild) {
          await rm(path.join(prebuilds, entry), { recursive: true, force: true });
        }
      }
    }

    // The wasm builds are for web-tree-sitter, which nothing here loads, and
    // binding.gyp describes a compile that happened before the package shipped.
    for (const entry of await readdir(pkg)) {
      if (entry === 'binding.gyp' || entry.endsWith('.wasm')) {
        await rm(path.join(pkg, entry), { force: true });
      }
    }

    // Only build inputs. Note what stays: `bindings`, which is the package's
    // own `main`, and `common`, which its grammars require. Deleting either
    // makes the addon unloadable — and because a worker that fails at module
    // load looks exactly like a worker that crashed, the symptom is a hang
    // rather than an error.
    //
    // `node-types.json` stays for a different reason and fails differently.
    // tree-sitter-c-sharp's binding is ESM and so unreachable through
    // createRequire; src/lang/csharp.ts calls node-gyp-build itself and loads
    // that file the way the binding would have. Delete it and nothing hangs:
    // every .cs file fails on its own and the project draws with no C# in it.
    for (const relative of GENERATED_SOURCES) {
      const generated = path.join(pkg, relative);
      if (!existsSync(generated)) continue;
      for (const entry of await readdir(generated)) {
        if (entry === 'node-types.json') continue;
        await rm(path.join(generated, entry), { recursive: true, force: true });
      }
    }
  }
}

/**
 * The tree-sitter packages in the staged tree, wherever npm put them — found
 * rather than listed, because the nesting is npm's decision and not ours.
 * tree-sitter-typescript depends on an older tree-sitter-javascript than we
 * do, so npm buries a second copy of that grammar inside it, and a list of
 * top-level names walks straight past its six platforms' worth of prebuilds.
 */
async function findGrammarPackages(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(directory, entry.name);

    // A scope holds packages; it is not one.
    if (entry.name.startsWith('@')) {
      found.push(...(await findGrammarPackages(candidate)));
      continue;
    }

    if (entry.name.startsWith('tree-sitter')) found.push(candidate);
    const nested = path.join(candidate, 'node_modules');
    if (existsSync(nested)) found.push(...(await findGrammarPackages(nested)));
  }
  return found;
}

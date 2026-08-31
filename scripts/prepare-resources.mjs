// Builds the app payload Tauri ships as a resource: the compiled server and web
// page, plus only the dependencies the server actually loads at runtime.
//
// Shipping the repository's node_modules would carry 160 MB of build tooling
// into the bundle. The frontend's dependencies are already inside dist/web,
// bundled by Vite, so the only real files needed are Fastify, chokidar and the
// tree-sitter addons — and of those, only this platform's native binaries.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const staging = path.join(repoRoot, 'dist-app');

/** What `dist/server` imports at run time. Everything else is a build tool. */
const RUNTIME_DEPENDENCIES = [
  '@fastify/static',
  '@fastify/websocket',
  'chokidar',
  'fastify',
  'tree-sitter',
  'tree-sitter-typescript',
];

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

// Native addons ship prebuilt for six platforms. Five of them are dead weight in
// a bundle that only ever runs on this one.
await pruneForeignPrebuilds(path.join(staging, 'node_modules'));

const size = execFileSync('du', ['-sh', staging], { encoding: 'utf8' }).split('\t')[0];
console.log(`app payload ready: dist-app (${size.trim()}, prebuilds pruned to ${platformPrebuild})`);

async function pruneForeignPrebuilds(modules) {
  for (const pkg of ['tree-sitter', 'tree-sitter-typescript', 'tree-sitter-javascript']) {
    const prebuilds = path.join(modules, pkg, 'prebuilds');
    if (!existsSync(prebuilds)) continue;

    const { readdir } = await import('node:fs/promises');
    for (const entry of await readdir(prebuilds)) {
      if (entry !== platformPrebuild) {
        await rm(path.join(prebuilds, entry), { recursive: true, force: true });
      }
    }

    // Only build inputs. Note what is NOT here: `bindings`, which is the
    // package's own `main`, and `common`, which its grammars require. Deleting
    // those makes the addon unloadable — and because a worker that fails at
    // module load looks exactly like a worker that crashed, the symptom is a
    // hang rather than an error.
    for (const spare of [
      'typescript/src',
      'tsx/src',
      'src',
      'tree-sitter-typescript.wasm',
      'tree-sitter-tsx.wasm',
      'binding.gyp',
    ]) {
      await rm(path.join(modules, pkg, spare), { recursive: true, force: true });
    }
  }
}

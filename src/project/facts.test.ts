import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { EntryPoint } from '../lang/types.js';
import { gatherFacts } from './facts.js';

/**
 * A project on disk, small enough to hold in the head: one package that is
 * Next, one that is not, a Go command, a crate, a Python module. The scan is
 * played by the file list handed to `gatherFacts` — every source written here
 * — so the manifests are read off disk exactly as they are at boot.
 */
async function writeFixture(root: string, files: Record<string, string>): Promise<string[]> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(file)), { recursive: true });
    await writeFile(path.join(root, file), text, 'utf8');
  }
  return Object.keys(files).filter((file) => !/\.(json|toml|mod)$/.test(file));
}

/** Enough comment to push `func main` past the 4 KB head read. */
const LONG_HEADER = `${'// licence\n'.repeat(600)}`;

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'fixture',
    main: './src/index.js',
    bin: { tool: './bin/tool.js' },
    exports: { '.': { import: './src/index.js', types: './dist/index.d.ts' } },
    scripts: {
      build: 'tsc',
      dev: 'next dev',
      backfill: 'tsx "scripts/backfill.ts" --dry-run',
      test: 'vitest run --coverage',
    },
    dependencies: { next: '16.0.0' },
  }),
  'src/index.ts': '',
  'bin/tool.js': '',
  'scripts/backfill.ts': '',
  'app/page.tsx': '',
  'app/dashboard/[id]/page.tsx': '',
  'app/api/health/route.ts': '',
  'app/dashboard/layout.tsx': '',
  'app/loading.tsx': '',
  'app/dashboard/Widget.tsx': '',
  'pages/about.tsx': '',
  'pages/api/users.ts': '',
  'pages/_app.tsx': '',

  // Not Next: a `pages/` directory of components, and a script that runs a file.
  'other/package.json': JSON.stringify({ name: 'other', scripts: { run: 'node run.js' } }),
  'other/pages/Home.tsx': '',
  'other/run.js': '',

  'go.mod': 'module example.com/fixture\n',
  'cmd/tool/main.go': `package main\n${LONG_HEADER}\nfunc main() {}\n`,
  'cmd/tool/flags.go': 'package main\n\nvar verbose bool\n',
  'internal/lib.go': 'package lib\n\nfunc main() {}\n',
  'cmd/tool/main_test.go': 'package main\n\nfunc main() {}\n',

  'Cargo.toml': '[package]\nname = "fixture"\n\n[[bin]]\nname = "alt"\npath = "src/alt.rs"\n\n[dependencies]\npath = "not-a-bin"\n',
  'src/main.rs': '',
  'src/alt.rs': '',
  'src/bin/extra.rs': '',
  'src/bin/nested/main.rs': '',
  'src/bin/nested/helper.rs': '',

  'tool/__main__.py': '',
  'tool/cli.py': '',
};

test('every manifest and convention names its file, with why, and nothing else', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-facts-'));
  try {
    const files = await writeFixture(root, FIXTURE);
    const facts = await gatherFacts(root, files);
    const entries = facts.entryPoints ?? [];

    const byFile = new Map(entries.map((entry) => [entry.file, entry]));
    const expected: EntryPoint[] = [
      { file: 'app/api/health/route.ts', why: 'Next.js route' },
      { file: 'app/dashboard/[id]/page.tsx', why: 'Next.js page' },
      { file: 'app/dashboard/layout.tsx', why: 'Next.js layout' },
      { file: 'app/loading.tsx', why: 'Next.js fallback' },
      { file: 'app/page.tsx', why: 'Next.js page' },
      { file: 'bin/tool.js', why: 'package.json bin' },
      { file: 'cmd/tool/main.go', why: 'Go func main()' },
      { file: 'other/run.js', why: 'package.json script', detail: 'run' },
      { file: 'pages/about.tsx', why: 'Next.js page' },
      { file: 'pages/api/users.ts', why: 'Next.js API route' },
      { file: 'scripts/backfill.ts', why: 'package.json script', detail: 'backfill' },
      { file: 'src/alt.rs', why: 'Cargo [[bin]]' },
      { file: 'src/bin/extra.rs', why: 'Cargo src/bin' },
      { file: 'src/bin/nested/main.rs', why: 'Cargo src/bin' },
      // `main` and `exports` both name it; the first claim wins.
      { file: 'src/index.ts', why: 'package.json main' },
      { file: 'src/main.rs', why: 'Cargo src/main.rs' },
      { file: 'tool/__main__.py', why: 'Python __main__' },
    ];
    for (const entry of expected) assert.deepEqual(byFile.get(entry.file), entry, entry.file);

    // What must not be there: a component under `app/` with no special name,
    // Next's own `_app`, a `package main` without a start, a `func main`
    // outside package main, a Go test, a file beside a nested bin, a `pages/`
    // outside Next.
    for (const file of [
      'app/dashboard/Widget.tsx',
      'pages/_app.tsx',
      'cmd/tool/flags.go',
      'internal/lib.go',
      'cmd/tool/main_test.go',
      'src/bin/nested/helper.rs',
      'other/pages/Home.tsx',
      'tool/cli.py',
    ]) {
      assert.equal(byFile.has(file), false, file);
    }
    assert.equal(entries.length, expected.length);

    const order = entries.map((entry) => entry.file);
    assert.deepEqual(order, [...order].sort((a, b) => a.localeCompare(b)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a manifest naming build output names nothing; a project without manifests has an empty list', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-facts-'));
  try {
    const files = await writeFixture(root, {
      'package.json': JSON.stringify({ name: 'built', main: 'dist/index.js', bin: './dist/cli.js' }),
      'src/index.ts': '',
      'src/cli.ts': '',
    });
    const facts = await gatherFacts(root, files);
    // `dist/` is not `src/`, and a guess would be an entry point nobody declared.
    assert.deepEqual(facts.entryPoints, []);

    // Gathered and empty is not the same as absent: the list is there to say
    // nothing declared a start.
    await rm(path.join(root, 'package.json'));
    const bare = await gatherFacts(root, files);
    assert.deepEqual(bare.entryPoints, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The shape symfony forces: one map at the root and one in each component,
 * whose directories are relative to the component rather than to the project.
 * `\` is one backslash in a JS string, which is the single separator composer
 * writes doubled in JSON.
 */
const COMPOSER_FIXTURE: Record<string, string> = {
  'composer.json': JSON.stringify({
    autoload: {
      'psr-4': { 'App\\': 'app/', 'Multi\\': ['src/a/', 'src/b'], '': 'fallback/' },
      classmap: ['database/'],
      files: ['app/helpers.php'],
    },
    'autoload-dev': { 'psr-4': { 'Tests\\': 'tests/' } },
  }),
  'app/Models/User.php': '',
  'tests/UserTest.php': '',

  // A component states its own map, and `""` is the component's directory.
  'packages/core/composer.json': JSON.stringify({
    autoload: { 'psr-4': { 'Vendor\\Core\\': 'src/', 'Vendor\\Core\\Root\\': '' } },
  }),
  'packages/core/src/Kernel.php': '',

  // Installed rather than written: `vendor` is an ignored directory, so its
  // manifest is never opened and its prefixes never enter the map.
  'vendor/acme/lib/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'Acme\\': 'src/' } } }),
};

test('composer states the PSR-4 map, per manifest, and a broken one costs only itself', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-facts-'));
  try {
    const files = await writeFixture(root, COMPOSER_FIXTURE);
    const facts = await gatherFacts(root, files);
    const psr4 = new Map([...(facts.psr4 ?? new Map())].map(([k, v]) => [k, [...v]]));

    assert.deepEqual(psr4, new Map<string, string[]>([
      // The trailing separator is stripped from the prefix and the trailing
      // slash from the directory, so the resolver joins them itself.
      ['App', ['app']],
      ['Multi', ['src/a', 'src/b']],
      // composer's fallback directory: an empty prefix stays the empty string.
      ['', ['fallback']],
      // `autoload-dev` counts. A test naming the class it tests is real coupling.
      ['Tests', ['tests']],
      ['Vendor\\Core', ['packages/core/src']],
      // `""` is the manifest's own directory, and the project root is `''`.
      ['Vendor\\Core\\Root', ['packages/core']],
    ]));

    // A manifest that is not JSON at all is skipped, and the rest still answer.
    await writeFile(path.join(root, 'packages/core/composer.json'), '{ not json', 'utf8');
    const survivor = await gatherFacts(root, files);
    assert.deepEqual([...(survivor.psr4 ?? new Map())].map(([prefix]) => prefix), [
      'App',
      'Multi',
      '',
      'Tests',
    ]);

    // No composer.json is an empty map, never absent: gathered-and-empty is an
    // answer, and php.ts falls back to what each file declared about itself.
    await rm(path.join(root, 'composer.json'));
    await rm(path.join(root, 'packages/core/composer.json'));
    const bare = await gatherFacts(root, files);
    assert.deepEqual(bare.psr4, new Map());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

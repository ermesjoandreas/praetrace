import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countUnreadable, findSourceFiles, NO_EXTENSION, unreadExtension } from './walk.js';

test('program text no language reads is counted under its extension', () => {
  // The kinds git/git is made of that the curated list never named.
  for (const [name, extension] of [
    ['t0001-init.sh', '.sh'],
    ['git-gui.tcl', '.tcl'],
    ['git-svn.perl', '.perl'],
    ['Git.pm', '.pm'],
    ['fmt.pl', '.pl'],
    ['Rakefile.rb', '.rb'],
    ['meson.build', '.build'],
    ['SETUP.SH', '.sh'],
  ]) {
    assert.equal(unreadExtension(name!), extension, name);
  }
});

test('a name with no extension anyone would name is one bucket, not a kind each', () => {
  for (const name of ['Makefile', 'vimdiff', 'Dockerfile', 'GIT-VERSION-GEN', 'expect.git_one_two', 'foo.txt,v', 'x.main^']) {
    assert.equal(unreadExtension(name), NO_EXTENSION, name);
  }
});

test('what a language claims is read, whatever the scan later decides about it', () => {
  // `builtin.c` and `cache.h` were counted as unread above until C and C++
  // were added, which is the whole point of deriving this from the registry:
  // the census is the complement of what some language claims, so a language
  // arriving moves files out of it and nothing else has to be edited.
  for (const name of [
    'index.ts', 'App.tsx', 'types.d.ts', '.eslintrc.js', 'main.go', 'Foo.java', 'lib.rs',
    'Program.cs', 'x.min.js', 'Store.kt', 'User.php', 'builtin.c', 'cache.h', 'gmock.cc',
    // The view layer, which was the whole of "Cannot read" on an MVC project:
    // 7 of the user's 11 files were `.cshtml` and none of them was drawn.
    'App.vue', 'Modal.svelte', 'Index.cshtml',
  ]) {
    assert.equal(unreadExtension(name), null, name);
  }
});

test('a Gradle build script is not read, and that is a decision rather than an omission', () => {
  // `.kts` is deliberately not on Kotlin's extension list — a build script's
  // top level is a DSL Gradle supplies, so its declarations are configuration
  // and would draw boxes that say nothing about the architecture. The honest
  // answer is the status bar counting them, so it has to be counted.
  assert.equal(unreadExtension('build.gradle.kts'), '.kts');
});

test('prose, data, images, fonts, archives, lockfiles and dotfiles were never source', () => {
  for (const name of [
    'README.md', 'notes.txt', 'git.adoc', 'package.json', 'ci.yaml', 'Cargo.toml', 'pom.xml',
    'data.csv', 'no.po', 'logo.png', 'icon.svg', 'font.woff2', 'bundle.tar.gz', 'yarn.lock',
    'Cargo.lock', 'go.sum', 'go.mod', 'fix.patch', 'LICENSE', 'COPYING', 'Readme', 'INSTALL',
    '.gitignore', '.npmrc', '.editorconfig', '.env',
  ]) {
    assert.equal(unreadExtension(name), null, name);
  }
});

test('the census walks what the scan walks, skips what it skips, and counts nothing twice', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-walk-'));
  try {
    for (const dir of ['scripts', 'src', 'node_modules/dep', '.git/hooks', 'dist', 'target/release']) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    for (const file of [
      'Makefile', 'run.sh', 'scripts/build.sh', 'src/index.ts', 'src/types.d.ts', 'README.md',
      '.gitignore', 'node_modules/dep/index.sh', '.git/hooks/pre-commit.sh', 'dist/out.sh',
      'target/release/bundle_dmg.sh',
    ]) {
      await writeFile(path.join(root, file), '');
    }
    // A link to a directory is not a file of any kind, and is not followed.
    await symlink(path.join(root, 'scripts'), path.join(root, 'tools'));

    assert.deepEqual(await countUnreadable(root), [
      { extension: '.sh', files: 2 },
      { extension: NO_EXTENSION, files: 1 },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The one seam a view-layer reader can rot at, and it rots silently.
 *
 * `findSourceFiles` and `countUnreadable` are complements of each other through
 * `knownExtensions()`, so a language arriving has to move its files across in
 * one motion. The failure to refuse is the half-move: the diagram draws seven
 * Razor views while the status bar goes on saying "not read: .cshtml 7", which
 * is the interface contradicting itself about the same seven files.
 */
test('a view file is walked and is no longer counted as unread', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-views-'));
  try {
    await mkdir(path.join(root, 'Views/Home'), { recursive: true });
    for (const file of ['App.vue', 'Modal.svelte', 'Views/Home/Index.cshtml', 'index.html']) {
      await writeFile(path.join(root, file), '');
    }

    assert.deepEqual(
      (await findSourceFiles(root)).map((file) => file.filePath).sort(),
      ['App.vue', 'Modal.svelte', 'Views/Home/Index.cshtml'],
    );
    // `.html` is the one still counted, and on purpose: an `.html` file is a
    // view only when a component named it, which no extension can say.
    assert.deepEqual(await countUnreadable(root), [{ extension: '.html', files: 1 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a root that cannot be read is an empty census, not a failure', async () => {
  assert.deepEqual(await countUnreadable(path.join(os.tmpdir(), 'codemap-walk-does-not-exist')), []);
});

/**
 * The names in `IGNORED_DIRECTORIES` are output directories, and they are
 * ignored at any depth, which is right: a monorepo's `packages/x/dist` is as
 * generated as the root one. The trap is that four of them are also ordinary
 * English — `src/coverage/` reads as "the coverage feature" and scans as "the
 * report nyc left behind". A module put in one is invisible to codemap, in the
 * project codemap is pointed at, and it does not look broken: the imports of it
 * simply resolve to nothing and the module is drawn nowhere. That is the
 * failure this repository exists to refuse, so its own layout is pinned here.
 */
test('every module this project has is a module the scan can reach', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const scanned = new Set((await findSourceFiles(root)).map((file) => file.filePath));

  const onDisk: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await visit(child);
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) onDisk.push(child);
    }
  };
  await visit('src');

  assert.deepEqual(onDisk.filter((file) => !scanned.has(file)), []);
});

/**
 * A virtualenv is `node_modules` with a different name, and it was not on the
 * list. DAPE read "839 files" where 732 of them were pip's own vendored `.py`
 * sitting under `venv/`, so the one number the interface leads with described
 * the packages the project installed rather than the project.
 */
test("a virtualenv is somebody else's code, and is not counted as the project's", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'codemap-venv-'));
  try {
    for (const dir of [
      'app',
      'venv/lib/python3.11/site-packages/pip/_vendor',
      '.venv/lib/python3.12/site-packages',
      'env/lib/python3.11/site-packages',
      '__pycache__',
      'vendor/github.com/spf13/pflag',
      'Pods/Alamofire',
    ]) {
      await mkdir(path.join(root, dir), { recursive: true });
    }
    for (const file of [
      'app/main.py',
      'app/tool.ts',
      'venv/pyvenv.cfg',
      'venv/lib/python3.11/site-packages/pip/_vendor/rich.py',
      '.venv/lib/python3.12/site-packages/six.py',
      'env/lib/python3.11/site-packages/attrs.py',
      '__pycache__/main.cpython-311.pyc',
      'vendor/github.com/spf13/pflag/flag.go',
      'Pods/Alamofire/Session.swift',
    ]) {
      await writeFile(path.join(root, file), '');
    }

    // Python is read now, so the census — what NO language reads — is the one
    // Swift file under Pods and nothing else. The vendored `.py`, the Go under
    // `vendor/` and the `.pyc` are not counted, because they are not walked.
    assert.deepEqual(await countUnreadable(root), []);

    // And the same rule on the scanning side: the project's own two files, and
    // nothing from the four directories that hold somebody else's code.
    // `vendor/` holds real Go the tool can read, which is exactly why it has to
    // be named rather than left to the census.
    assert.deepEqual(
      (await findSourceFiles(root)).map((file) => file.filePath).sort(),
      ['app/main.py', 'app/tool.ts'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

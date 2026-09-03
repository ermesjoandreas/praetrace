import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countUnreadable, NO_EXTENSION, unreadExtension } from './walk.js';

test('program text no language reads is counted under its extension', () => {
  // The kinds git/git is made of that the curated list never named.
  for (const [name, extension] of [
    ['t0001-init.sh', '.sh'],
    ['git-gui.tcl', '.tcl'],
    ['git-svn.perl', '.perl'],
    ['Git.pm', '.pm'],
    ['fmt.pl', '.pl'],
    ['setup.py', '.py'],
    ['App.vue', '.vue'],
    ['builtin.c', '.c'],
    ['cache.h', '.h'],
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
  for (const name of ['index.ts', 'App.tsx', 'types.d.ts', '.eslintrc.js', 'main.go', 'Foo.java', 'lib.rs', 'Program.cs', 'x.min.js']) {
    assert.equal(unreadExtension(name), null, name);
  }
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

test('a root that cannot be read is an empty census, not a failure', async () => {
  assert.deepEqual(await countUnreadable(path.join(os.tmpdir(), 'codemap-walk-does-not-exist')), []);
});

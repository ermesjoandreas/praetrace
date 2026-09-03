import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNameStatus, parseNumstat, parseUntracked, projectPath } from './git.js';

// Fixtures are what git writes with `-z`: NUL-terminated records, no quoting.

test('--untracked-files=all lists every file; a collapsed directory would be one record', () => {
  const out = '?? src/Main.java\0?? src/util/Strings.java\0?? src/util/Lists.java\0';
  assert.deepEqual(parseUntracked(out), [
    'src/Main.java',
    'src/util/Strings.java',
    'src/util/Lists.java',
  ]);
});

test('a rename carries a second path, consumed rather than read as an untracked file', () => {
  const out = 'R  new.ts\0old.ts\0?? fresh.ts\0';
  assert.deepEqual(parseUntracked(out), ['fresh.ts']);
});

test('only ?? is untracked, and a path with a space survives -z', () => {
  const out = ' M a.ts\0A  b.ts\0?? my file.ts\0';
  assert.deepEqual(parseUntracked(out), ['my file.ts']);
});

test('name-status: a rename reads its new path, a copy is an add, the trailing NUL is not a path', () => {
  const out = 'M\0a.ts\0R100\0old.ts\0new.ts\0C075\0src.ts\0copy.ts\0D\0gone.ts\0';
  assert.deepEqual(parseNameStatus(out), [
    ['a.ts', 'modified'],
    ['new.ts', 'renamed'],
    ['copy.ts', 'added'],
    ['gone.ts', 'deleted'],
  ]);
});

test('numstat: a binary file is skipped, a rename is read from its two extra fields', () => {
  const out = '3\t1\ta.ts\0-\t-\tlogo.png\0' + '5\t0\t\0old.ts\0new.ts\0';
  assert.deepEqual(parseNumstat(out), [
    ['a.ts', 3, 1],
    ['new.ts', 5, 0],
  ]);
});

test("the tool's own files are never the project's changes", () => {
  assert.equal(projectPath('.codemap/groups.json', ''), null);
  assert.equal(projectPath('.codemap/explain.json', ''), null);
  assert.equal(projectPath('.claude/codemap.port', ''), null);
  // The hook settings are the project's, and a file that merely shares a name is too.
  assert.equal(projectPath('.claude/settings.json', ''), '.claude/settings.json');
  assert.equal(projectPath('src/codemap.port', ''), 'src/codemap.port');
  assert.equal(projectPath('src/.codemap/x', ''), 'src/.codemap/x');
});

test('a project opened in a subdirectory sees its own paths, and nothing above or beside it', () => {
  assert.equal(projectPath('packages/core/src/index.ts', 'packages/core'), 'src/index.ts');
  assert.equal(projectPath('packages/other/src/index.ts', 'packages/core'), null);
  // A prefix match on the directory name is not a match on the directory.
  assert.equal(projectPath('packages/core-extra/x.ts', 'packages/core'), null);
  // The tool writes into the directory it was opened at, so that is where its files are dropped.
  assert.equal(projectPath('packages/core/.codemap/groups.json', 'packages/core'), null);
  assert.equal(projectPath('.codemap/groups.json', 'packages/core'), null);
});

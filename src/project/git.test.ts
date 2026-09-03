import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  fetchRemote,
  parseNameStatus,
  parseNumstat,
  parseUntracked,
  projectPath,
  readBranch,
  readGitStatus,
  readLog,
  readRemote,
  resolveCommit,
} from './git.js';

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

// The rest shells out to a real repository, because the bug being pinned is
// which repository git answers with — which no fixture string can express.

/**
 * git's own configuration is taken out of the way: a global `core.excludesFile`
 * or a template directory belonging to whoever runs the suite would otherwise
 * decide what these repositories contain.
 */
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'codemap-no-such-gitconfig');
process.env.GIT_CONFIG_SYSTEM = path.join(os.tmpdir(), 'codemap-no-such-gitconfig');
process.env.GIT_AUTHOR_NAME = 'codemap';
process.env.GIT_AUTHOR_EMAIL = 'codemap@example.invalid';
process.env.GIT_COMMITTER_NAME = 'codemap';
process.env.GIT_COMMITTER_EMAIL = 'codemap@example.invalid';

const run = promisify(execFile);

async function write(file: string, text = 'export const a = 1;\n'): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/**
 * The report this pins: `keeta-benchmark-sandbox` is not a repository, so git
 * walked up to the home directory, found a stray `git init` somebody had run
 * there years ago, and the panel showed it as the project's own state — "Last
 * fetch 6 months ago" with a live Fetch button, "Changes 7", and "No commits
 * yet", all at once, none of it about the project.
 */
test('a repository found by walking above the project is not the project\'s repository', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'codemap-home-'));
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: home });
    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/dotfiles.git'], { cwd: home });
    await write(path.join(home, '.zshrc'), '# dotfiles\n');
    await run('git', ['add', '.'], { cwd: home });
    await run('git', ['commit', '-q', '-m', 'dotfiles'], { cwd: home });

    const root = path.join(home, 'keeta-benchmark-sandbox');
    for (const n of [1, 2, 3, 4, 5, 6, 7]) await write(path.join(root, 'src', `f${n}.ts`));

    assert.equal(await readGitStatus(root, 'HEAD'), null);
    assert.equal(await readRemote(root), null);
    assert.deepEqual(await readLog(root), []);
    assert.equal(await readBranch(root), null);
    assert.equal(await resolveCommit(root, 'HEAD'), null);
    assert.deepEqual(await fetchRemote(root), { ok: false, detail: 'Not a git repository.' });

    // The home directory is still a repository when it is the one you opened.
    assert.equal((await readGitStatus(home, 'HEAD'))?.branch, 'main');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a package nobody has committed yet keeps the monorepo it sits in', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'codemap-newpkg-'));
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await write(path.join(repo, 'packages', 'core', 'src', 'index.ts'));
    await run('git', ['add', '.'], { cwd: repo });
    await run('git', ['commit', '-q', '-m', 'first'], { cwd: repo });

    // Created a minute ago, never added. `ls-files` inside it is empty, and the
    // first rule turned the branch, the log and the remote off for it at once.
    const fresh = path.join(repo, 'packages', 'newpkg');
    await write(path.join(fresh, 'src', 'b.ts'), 'export const b = 2;\n');

    assert.equal((await readGitStatus(fresh, 'HEAD'))?.branch, 'main');
    assert.equal(await readBranch(fresh), 'main');
    assert.equal((await readLog(fresh)).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a package inside the repository that tracks it keeps its git', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'codemap-repo-'));
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await write(path.join(repo, 'packages', 'core', 'src', 'index.ts'));
    await run('git', ['add', '.'], { cwd: repo });
    await run('git', ['commit', '-q', '-m', 'first'], { cwd: repo });
    await write(path.join(repo, 'packages', 'core', 'src', 'index.ts'), 'export const a = 2;\n');

    const root = path.join(repo, 'packages', 'core');
    const status = await readGitStatus(root, 'HEAD');
    assert.deepEqual(status?.files, { 'src/index.ts': 'modified' });
    assert.equal(status?.branch, 'main');
    assert.equal((await readLog(root)).length, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('a fresh init at the project root is git, with everything in it untracked', async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), 'codemap-fresh-'));
  try {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await write(path.join(repo, 'src', 'index.ts'));

    // Nothing is tracked and there is no HEAD to diff against, and it is still
    // the project's repository: the toplevel is the project root itself.
    assert.deepEqual((await readGitStatus(repo, 'HEAD'))?.files, { 'src/index.ts': 'untracked' });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

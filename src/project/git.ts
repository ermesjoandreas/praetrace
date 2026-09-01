import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GitFileStatus, GitStatus } from '../git/types.js';

const execFileAsync = promisify(execFile);

/**
 * Every git invocation goes through here, and every failure is the same answer:
 * nothing. git may be missing, the directory may not be a repository, a ref may
 * not exist, an enormous repository may outrun the timeout. None of those are
 * errors this tool should surface — a project without git simply does not get
 * the feature, and the caller can only ever act on the presence of an answer.
 */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 2000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch {
    return null;
  }
}

/** The refs to try for 'branch', after whatever origin/HEAD points at. */
const DEFAULT_BRANCH_REFS = ['origin/main', 'origin/master', 'main', 'master'];

const TRACKED_STATUS: Record<string, GitFileStatus> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  // A copy leaves the source untouched, so only the new file is news.
  C: 'added',
  T: 'modified',
};

/**
 * The working tree against a base commit, as a flat map the view layer can ask
 * about one file at a time. Returns null when there is no git to read: not a
 * work tree, no git on PATH, or any failure at all along the way.
 *
 * `base` is what the caller asked for — 'HEAD', 'HEAD~1' or 'branch'. What was
 * actually used comes back in `GitStatus.base`, because the two differ whenever
 * a ref could not be resolved and the fallback took over, and a chip reading
 * "vs HEAD~1" over a diff against HEAD would be a lie.
 *
 * Nothing here filters by `isSourceFileName`. The view decides what it draws; a
 * status map that quietly dropped files would make a "N changed" count disagree
 * with what git says, which is worse than reporting a file nobody will render.
 */
export async function readGitStatus(root: string, base: string): Promise<GitStatus | null> {
  const toplevel = await git(root, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) return null;
  const repoRoot = toplevel.trim();
  if (repoRoot === '') return null;

  const prefix = await pathPrefix(repoRoot, root);
  if (prefix === null) return null;

  const branch = await readBranch(root);
  const resolved = await resolveBase(root, base);

  const files: Record<string, GitFileStatus> = {};

  // A repository with no commits has no HEAD to diff against, so everything in
  // it is untracked and the tracked half is skipped rather than failed.
  if (resolved !== null) {
    const diff = await git(root, ['diff', '--name-status', '-z', resolved]);
    if (diff !== null) {
      for (const [gitPath, status] of parseNameStatus(diff)) {
        const filePath = stripPrefix(gitPath, prefix);
        if (filePath !== null) files[filePath] = status;
      }
    }
  }

  const untracked = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (untracked !== null) {
    for (const gitPath of parseUntracked(untracked)) {
      const filePath = stripPrefix(gitPath, prefix);
      if (filePath !== null) files[filePath] = 'untracked';
    }
  }

  return { base: resolved ?? 'HEAD', requested: base, branch, files };
}

async function readBranch(root: string): Promise<string | null> {
  const output = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = output?.trim();
  // The literal 'HEAD' is what a detached HEAD answers, not a branch called HEAD.
  if (name === undefined || name === '' || name === 'HEAD') return null;
  return name;
}

/**
 * Turns the requested base into something `git diff` will accept, or null when
 * even HEAD does not resolve. 'HEAD~1' in a repository with one commit is the
 * ordinary case for the fallback: the request is reasonable, the ref does not
 * exist, and diffing against HEAD says something true instead of failing.
 */
async function resolveBase(root: string, requested: string): Promise<string | null> {
  const wanted = requested === 'branch' ? await defaultBranchBase(root) : requested;
  if (wanted !== null && (await verify(root, wanted))) return wanted;
  return (await verify(root, 'HEAD')) ? 'HEAD' : null;
}

/**
 * 'branch' means "what I have done on this branch", which is the merge base with
 * the default branch rather than the branch tip — diffing against the tip would
 * also report everything other people landed since.
 *
 * Which branch is the default is a guess, so it is made in order of how much the
 * repository itself asserts: origin/HEAD is a recorded answer, the rest are the
 * conventional names.
 */
async function defaultBranchBase(root: string): Promise<string | null> {
  const candidates: string[] = [];
  const recorded = await git(root, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
  const named = recorded?.trim();
  if (named !== undefined && named !== '') candidates.push(named);
  candidates.push(...DEFAULT_BRANCH_REFS);

  for (const ref of candidates) {
    if (!(await verify(root, ref))) continue;
    const mergeBase = await git(root, ['merge-base', ref, 'HEAD']);
    const commit = mergeBase?.trim();
    if (commit !== undefined && commit !== '') return commit;
  }
  return null;
}

async function verify(root: string, ref: string): Promise<boolean> {
  return (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null;
}

/**
 * `--name-status -z` is a stream of NUL-*terminated* fields, not lines: a record
 * is STATUS, PATH, except for R and C which carry the old path before the new
 * one. Reading fields on demand rather than chunking in pairs is what keeps the
 * loop aligned across a rename, and it ignores the trailing terminator — which a
 * split would otherwise hand back as an empty-string path.
 *
 * The similarity score is part of the status field ('R050'), so only its first
 * character carries meaning here.
 */
function parseNameStatus(stdout: string): Array<[string, GitFileStatus]> {
  const fields = stdout.split('\0');
  const found: Array<[string, GitFileStatus]> = [];
  let at = 0;

  while (at < fields.length) {
    const code = fields[at++];
    if (code === undefined || code === '') break;
    const first = fields[at++];
    if (first === undefined) break;

    const letter = code[0] ?? '';
    const target = letter === 'R' || letter === 'C' ? fields[at++] : first;
    if (target === undefined || target === '') break;

    const status = TRACKED_STATUS[letter];
    if (status !== undefined) found.push([target, status]);
  }

  return found;
}

/**
 * `--porcelain=v1 -z` records are the two-character code, a space, then the path
 * — and, for a rename, a second field holding where it came from. That extra
 * field is consumed rather than examined: a code of '??' is the only thing
 * wanted here, and a stray path left in the stream would be read as one.
 *
 * The whole reason for -z is that this form does not quote paths, so a filename
 * with a space or a quote in it survives verbatim.
 */
function parseUntracked(stdout: string): string[] {
  const fields = stdout.split('\0');
  const found: string[] = [];
  let at = 0;

  while (at < fields.length) {
    const record = fields[at++];
    if (record === undefined || record === '') break;

    const code = record.slice(0, 2);
    if (code.includes('R') || code.includes('C')) at++;
    if (code === '??') {
      const filePath = record.slice(3);
      if (filePath !== '') found.push(filePath);
    }
  }

  return found;
}

/**
 * git reports paths from the repository root, but the project being watched can
 * sit in a subdirectory of it — a monorepo package, most obviously. Everything
 * above the project is dropped rather than reported at a path the graph has
 * never heard of.
 *
 * The project root is resolved through realpath first because `--show-toplevel`
 * answers with the physical path: on macOS a root reached through /tmp would
 * otherwise appear to sit outside its own repository.
 */
async function pathPrefix(repoRoot: string, root: string): Promise<string | null> {
  const absolute = path.resolve(root);
  const projectRoot = await realpath(absolute).catch(() => absolute);
  const relative = path.relative(repoRoot, projectRoot);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function stripPrefix(gitPath: string, prefix: string): string | null {
  if (prefix === '') return gitPath;
  if (!gitPath.startsWith(`${prefix}/`)) return null;
  return gitPath.slice(prefix.length + 1);
}

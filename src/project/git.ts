import { execFile, spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
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
 * work tree, no git on PATH, a repository that has never heard of this project
 * — see `worktreePrefix` — or any failure at all along the way.
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
  const prefix = await worktreePrefix(root);
  if (prefix === null) return null;

  const branch = await branchOf(root);
  const resolved = await resolveBase(root, base);

  const files: Record<string, GitFileStatus> = {};
  const lines: Record<string, { added: number; deleted: number }> = {};
  const totals = { added: 0, deleted: 0 };

  // Every command is limited to the project's own subtree (`-- .` from the
  // project root). Paths still come back from the repository root — that is
  // what `projectPath` translates — but git no longer walks the rest of the
  // repository to find them. The case that forced it: a Java folder opened
  // under a `git init` somebody ran in their home directory, where an
  // unrestricted `git status` has to enumerate everything under ~ before it
  // can say a word, outruns the 2 s timeout, and answers "Changes 0" for a
  // project of 203 untracked files.
  const here = ['--', '.'];

  // A repository with no commits has no HEAD to diff against, so everything in
  // it is untracked and the tracked half is skipped rather than failed.
  if (resolved !== null) {
    const diff = await git(root, ['diff', '--name-status', '-z', resolved, ...here]);
    if (diff !== null) {
      for (const [gitPath, status] of parseNameStatus(diff)) {
        const filePath = projectPath(gitPath, prefix);
        if (filePath !== null) files[filePath] = status;
      }
    }

    // A second pass rather than one command: --name-status and --numstat cannot
    // be asked for together, and the statuses are what the badges need whether
    // or not the counts arrive.
    const numbers = await git(root, ['diff', '--numstat', '-z', resolved, ...here]);
    if (numbers !== null) {
      for (const [gitPath, added, deleted] of parseNumstat(numbers)) {
        const filePath = projectPath(gitPath, prefix);
        if (filePath === null) continue;
        lines[filePath] = { added, deleted };
        totals.added += added;
        totals.deleted += deleted;
      }
    }
  }

  // `--untracked-files=all` is not optional: the default collapses a directory
  // with nothing tracked in it to one `dir/` entry, which is not a file and
  // would be counted as one change where there are two hundred.
  const untracked = await git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    ...here,
  ]);
  if (untracked !== null) {
    for (const gitPath of parseUntracked(untracked)) {
      const filePath = projectPath(gitPath, prefix);
      if (filePath !== null) files[filePath] = 'untracked';
    }
  }

  return { base: resolved ?? 'HEAD', requested: base, branch, files, lines, totals };
}

export async function readBranch(root: string): Promise<string | null> {
  if ((await worktreePrefix(root)) === null) return null;
  return branchOf(root);
}

async function branchOf(root: string): Promise<string | null> {
  const output = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const name = output?.trim();
  // The literal 'HEAD' is what a detached HEAD answers, not a branch called HEAD.
  if (name === undefined || name === '' || name === 'HEAD') return null;
  return name;
}

/**
 * Where the project sits inside the repository that owns it — '' when they are
 * the same directory — or null when no repository owns it.
 *
 * git ascends until it finds a repository, and this is the one place that
 * decides whether the answer it comes back with is the project's. Ascending is
 * right for a package opened inside its monorepo, and wrong for a project that
 * merely sits under a stray `git init` somebody once ran in their home
 * directory. `keeta-benchmark-sandbox` is not a repository, and the panel
 * showed the home directory's: "Last fetch 6 months ago" with a live Fetch
 * button, "Changes 7", and "No commits yet", all at once and none of it about
 * the project.
 *
 * So a repository above the project has to earn it, and the test is whether it
 * actually holds the project — `ls-files` limited to the project's own subtree.
 * A `git init` in the project itself is still git, because the toplevel *is*
 * the root and nothing needs to be tracked yet; a monorepo package is still
 * git, because the repository has its files. A directory the repository has
 * never heard of has no git, which is a missing feature and not an error.
 *
 * The extra command only runs when the repository was found by ascending, so
 * the ordinary project — its own repository, opened at its own root — still
 * costs exactly one.
 */
async function worktreePrefix(root: string): Promise<string | null> {
  const toplevel = await git(root, ['rev-parse', '--show-toplevel']);
  if (toplevel === null) return null;
  const repoRoot = toplevel.trim();
  if (repoRoot === '') return null;

  const prefix = await pathPrefix(repoRoot, root);
  if (prefix === null || prefix === '') return prefix;

  const tracked = await git(root, ['ls-files', '-z', '--', '.']);
  if (tracked !== null && tracked !== '') return prefix;

  // Nothing here is tracked yet, and that is two different situations. A
  // package somebody just created inside its monorepo is still the
  // repository's, and turning git off for it would take the branch, the log,
  // the remote and the whole Source Control section with it. A project that
  // merely sits under a stray `git init` in a home directory is not, and
  // showing that repository's state — "Last fetch 6 months ago" with a live
  // Fetch button, "Changes 7", "No commits yet", all at once — is describing
  // somebody else's work as yours.
  //
  // What tells them apart is whether the project is nested inside a directory
  // the repository already uses. `packages/newpkg` sits under `packages/`,
  // which holds the packages that came before it; `keeta-benchmark-sandbox`
  // sits directly under the toplevel with nothing between, so there is nothing
  // to have earned it. Untracked and directly under the toplevel is the shape
  // of a project that merely happens to be there.
  const parent = path.posix.dirname(prefix.replace(/\/$/, ''));
  if (parent === '.' || parent === '' || parent === '/') return null;
  const nearby = await git(root, ['ls-files', '-z', '--', path.posix.join('..', '.')]);
  return nearby !== null && nearby !== '' ? prefix : null;
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
export function parseNameStatus(stdout: string): Array<[string, GitFileStatus]> {
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
 * `--numstat -z` is added TAB deleted TAB path NUL, except for a rename, which
 * writes an empty field and then both paths — the same three-field shape
 * `--name-status` uses, arrived at differently.
 *
 * A binary file reports a dash for both counts. It is skipped rather than
 * counted as zero: the file did change, and saying "+0 -0" about it would be a
 * measurement rather than the absence of one.
 */
export function parseNumstat(stdout: string): Array<[string, number, number]> {
  const fields = stdout.split('\0');
  const found: Array<[string, number, number]> = [];
  let at = 0;

  while (at < fields.length) {
    const head = fields[at++];
    if (head === undefined || head === '') break;

    const [addedText, deletedText, inlinePath] = head.split('\t');
    // A rename leaves the path empty here and writes the old and new ones next.
    let target = inlinePath;
    if (target === undefined || target === '') {
      at += 1;
      target = fields[at++];
    }
    if (target === undefined || target === '') break;

    const added = Number(addedText);
    const deleted = Number(deletedText);
    if (Number.isFinite(added) && Number.isFinite(deleted)) {
      found.push([target, added, deleted]);
    }
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
export function parseUntracked(stdout: string): string[] {
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

/**
 * A path as git reports it, as the project knows it — or null when the project
 * has no business hearing about it: outside the opened subtree, or one of the
 * tool's own.
 *
 * The tool leaves `.codemap/` and `.claude/codemap.port` in the project it is
 * watching, and git sees them like anything else. Three reviewers saw "Changes
 * 3" over a project they had not touched, and every one of the three was a
 * file this program had written. They are never the project's changes, so they
 * leave here — the one place every status, count and total passes through —
 * rather than at each of the places that would otherwise each need to know.
 */
export function projectPath(gitPath: string, prefix: string): string | null {
  const filePath = stripPrefix(gitPath, prefix);
  if (filePath === null || isToolFile(filePath)) return null;
  return filePath;
}

function isToolFile(filePath: string): boolean {
  return filePath === '.claude/codemap.port' || filePath.startsWith('.codemap/');
}

function stripPrefix(gitPath: string, prefix: string): string | null {
  if (prefix === '') return gitPath;
  if (!gitPath.startsWith(`${prefix}/`)) return null;
  return gitPath.slice(prefix.length + 1);
}

/** One commit as the log reports it: enough to draw a graph of them. */
export interface Commit {
  sha: string;
  /** Full shas, first parent first. Empty for a root commit. */
  parents: string[];
  author: string;
  /** Unix milliseconds, like every other `at` in the project — git's seconds, scaled. */
  at: number;
  subject: string;
  /**
   * What points here, in git's own words: `HEAD`, `main`, `origin/main`,
   * `tag: v1`. The arrow in `HEAD -> main` is taken apart into `HEAD` and the
   * branch, so a consumer can look for either without knowing the spelling.
   * The tag prefix is kept, because `v1` on its own could be a branch.
   */
  refs: string[];
}

const LOG_FORMAT = '%H%x00%P%x00%an%x00%at%x00%s%x00%D';
const DEFAULT_LOG_LIMIT = 300;
const HEAD_ARROW = 'HEAD -> ';

/**
 * The most recent commits on every ref, newest first. Empty when there is no
 * git to read, or nothing committed yet.
 *
 * `--date-order` rather than the default: both sort by date, but only this one
 * promises a parent never comes before its child when clocks disagreed, and a
 * lane drawn top-down needs exactly that promise. Fields are NUL-separated
 * because a subject can contain any printable character; records are lines,
 * because none of these fields can contain a newline.
 */
export async function readLog(root: string, limit = DEFAULT_LOG_LIMIT): Promise<Commit[]> {
  if ((await worktreePrefix(root)) === null) return [];
  const output = await git(root, [
    'log',
    `--format=${LOG_FORMAT}`,
    '--date-order',
    '-n',
    String(limit),
    '--all',
  ]);
  return output === null ? [] : parseLog(output);
}

/** Pure, and exported for the test the parsing half of this module is owed. */
export function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const [sha, parents, author, seconds, subject, decorations] = line.split('\0');
    const at = Number(seconds) * 1000;
    if (sha === undefined || sha === '' || !Number.isFinite(at)) continue;
    commits.push({
      sha,
      parents: parents === undefined || parents === '' ? [] : parents.split(' '),
      author: author ?? '',
      at,
      subject: subject ?? '',
      refs: parseRefs(decorations ?? ''),
    });
  }
  return commits;
}

/** `HEAD -> main, origin/main, tag: v1` -> `HEAD`, `main`, `origin/main`, `tag: v1`. */
function parseRefs(decorations: string): string[] {
  const refs: string[] = [];
  for (const entry of decorations.split(', ')) {
    if (entry === '') continue;
    if (entry.startsWith(HEAD_ARROW)) refs.push('HEAD', entry.slice(HEAD_ARROW.length));
    else refs.push(entry);
  }
  return refs;
}

/**
 * Where the repository stands against its remote. Every field can be absent on
 * its own: a fresh `git init` has no origin, a local branch tracks nothing, a
 * clone that never fetched has no FETCH_HEAD. None of those is an error.
 */
export interface RemoteStatus {
  /** What `origin` points at, or null when there is no origin. */
  url: string | null;
  /** `origin/main`: what the current branch tracks, or null when it tracks nothing. */
  upstream: string | null;
  /** Commits here the upstream lacks, and the reverse. Both 0 without an upstream. */
  ahead: number;
  behind: number;
  /** Unix milliseconds of the last fetch, or null when there has never been one. */
  fetchedAt: number | null;
}

/** Null when there is no git to read; otherwise an answer, however empty. */
export async function readRemote(root: string): Promise<RemoteStatus | null> {
  if ((await worktreePrefix(root)) === null) return null;

  const url = nonEmpty(await git(root, ['remote', 'get-url', 'origin']));
  const upstream = nonEmpty(await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']));

  let ahead = 0;
  let behind = 0;
  if (upstream !== null) {
    const counts = await git(root, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    const [left, right] = (counts ?? '').trim().split(/\s+/).map(Number);
    if (left !== undefined && right !== undefined && Number.isFinite(left) && Number.isFinite(right)) {
      ahead = left;
      behind = right;
    }
  }

  return { url, upstream, ahead, behind, fetchedAt: await lastFetch(root) };
}

function nonEmpty(output: string | null): string | null {
  const text = output?.trim();
  return text === undefined || text === '' ? null : text;
}

/**
 * git rewrites FETCH_HEAD on every fetch, so its mtime is the last one. Asked
 * for by `--git-path` rather than assumed under `.git`, because a worktree or
 * a project opened inside a larger repository keeps it somewhere else.
 */
async function lastFetch(root: string): Promise<number | null> {
  const gitPath = nonEmpty(await git(root, ['rev-parse', '--git-path', 'FETCH_HEAD']));
  if (gitPath === null) return null;
  const stats = await stat(path.resolve(root, gitPath)).catch(() => null);
  return stats?.mtimeMs ?? null;
}

const FETCH_TIMEOUT_MS = 30_000;

/**
 * `git fetch`, the one verb here that talks to the network and the only one
 * that is not a read — and it still touches no working tree, which matters
 * because an agent may be editing it at the time. Never throws: every way it
 * can fail comes back as a sentence the panel can show.
 */
export async function fetchRemote(root: string): Promise<{ ok: boolean; detail: string }> {
  if ((await worktreePrefix(root)) === null) {
    return { ok: false, detail: 'Not a git repository.' };
  }
  const remote = await fetchTarget(root);
  if (remote === null) return { ok: false, detail: 'This repository has no remote to fetch from.' };

  try {
    await execFileAsync('git', ['fetch', '--quiet', remote], {
      cwd: root,
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: 'utf8',
      // A remote wanting a password would otherwise wait on a terminal nobody
      // is looking at, and only the timeout would ever answer.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, detail: `Fetched ${remote}.` };
  } catch (error) {
    return { ok: false, detail: describeFetchFailure(error, remote) };
  }
}

/**
 * The remote a bare `git fetch` would pick — the current branch's, else
 * origin, else whichever is configured — resolved here so the answer can name
 * it. Null when there is none.
 */
async function fetchTarget(root: string): Promise<string | null> {
  const remotes = (await git(root, ['remote']))?.split('\n').filter((name) => name !== '') ?? [];
  if (remotes.length === 0) return null;

  // `origin/main` names the remote by prefix, and a remote name may itself
  // contain a slash, so the longest configured name that fits is the one.
  const upstream = nonEmpty(await git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])) ?? '';
  const tracked = remotes
    .filter((name) => upstream.startsWith(`${name}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (tracked !== undefined) return tracked;
  return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
}

function describeFetchFailure(error: unknown, remote: string): string {
  if (typeof error === 'object' && error !== null) {
    const { killed, stderr } = error as { killed?: boolean; stderr?: string };
    if (killed === true) return `git fetch ${remote} gave up after ${FETCH_TIMEOUT_MS / 1000} seconds.`;
    const line = stderr
      ?.split('\n')
      .map((text) => text.trim())
      .find((text) => text !== '');
    if (line !== undefined) return line.replace(/^fatal: /, '');
  }
  return `git fetch ${remote} failed.`;
}

/**
 * The full sha a ref names, or null when it names no commit: a typo, a short
 * sha that matches nothing, a branch this clone never fetched. The ref comes
 * from a URL, so `--end-of-options` keeps one spelled like a flag from being
 * read as one.
 */
export async function resolveCommit(root: string, ref: string): Promise<string | null> {
  if ((await worktreePrefix(root)) === null) return null;
  return nonEmpty(await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]));
}

const ARCHIVE_TIMEOUT_MS = 60_000;

/**
 * Unpack the project as it was at `sha` into `into`, an existing directory.
 * When the project sits inside a larger repository only its own subtree is
 * taken, so the paths — and with them the graph's ids — come out the same as
 * a scan of the working tree gives.
 *
 * `git archive` streams a tar and `tar` unpacks it: an archive is what git
 * hands over without touching the working tree, and it is one process for the
 * whole tree rather than a `git show` per file. False for a sha that does not
 * resolve, a commit the project did not exist at, or no `tar` on PATH — each
 * of which is an ordinary answer to "what did this look like then".
 */
export async function archiveCommit(root: string, sha: string, into: string): Promise<boolean> {
  const location = await git(root, ['rev-parse', '--show-toplevel', '--show-prefix']);
  if (location === null) return false;
  const [toplevel, prefix = ''] = location.split('\n').map((line) => line.trim().replace(/\/$/, ''));
  if (toplevel === undefined || toplevel === '') return false;
  const tree = prefix === '' ? sha : `${sha}:${prefix}`;

  return new Promise((resolve) => {
    // Run from the top of the repository, not the project: inside a
    // subdirectory `git archive` keeps only that directory's paths *within the
    // tree it was given*, and `sha:src` holds no `src/`, so from src/ it would
    // quietly archive nothing at all.
    const archive = spawn('git', ['archive', '--format=tar', '--end-of-options', tree], {
      cwd: toplevel,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const extract = spawn('tar', ['-x', '-f', '-', '-C', into], {
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const abandon = (): void => {
      archive.kill();
      extract.kill();
      finish(false);
    };
    const timer = setTimeout(abandon, ARCHIVE_TIMEOUT_MS);

    // Whichever side dies first breaks the pipe under the other, and a broken
    // pipe is an 'error' on the stream that takes the process down when nobody
    // is listening. The exit codes already say what went wrong.
    archive.stdout.on('error', () => {});
    extract.stdin.on('error', () => {});
    archive.on('error', abandon);
    extract.on('error', abandon);

    let archived: number | null = null;
    let extracted: number | null = null;
    const check = (): void => {
      if (archived === null || extracted === null) return;
      finish(archived === 0 && extracted === 0);
    };
    archive.on('close', (code) => {
      archived = code ?? 1;
      check();
    });
    extract.on('close', (code) => {
      extracted = code ?? 1;
      check();
    });

    archive.stdout.pipe(extract.stdin);
  });
}

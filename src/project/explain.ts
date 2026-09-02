import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * One thing to explain: a symbol, or a whole file.
 *
 * `source` and `context` are gathered by the caller rather than read here,
 * because this module is the only one in `project/` that must not know the
 * graph — and because the point of the design is that a subprocess is handed
 * exactly the code being asked about and nothing else.
 */
export interface ExplainTarget {
  /** A graph node id for a symbol, or the file path for a file. */
  id: string;
  kind: 'symbol' | 'file';
  name: string;
  filePath: string;
  /** The source being explained: a symbol's line range, or the whole file. */
  source: string;
  /** From describeSymbol / describe — "used by X#a", "uses Y#b". */
  context: string[];
  /**
   * The files those relations live in, which is what drift is measured against.
   *
   * Separate from `context` because that is prose for the prompt and this is a
   * key: the two must be computed the same way on both sides of a run, and a
   * sentence is not a stable thing to hash.
   */
  related: string[];
}

export interface Explanation {
  id: string;
  kind: 'symbol' | 'file';
  /** One or two sentences. */
  short: string;
  /** A paragraph, which may name the callers and say what would break. */
  long: string;
  at: number;
  /**
   * Hash of the exact source that was described, so a reading of code that has
   * since been rewritten can be shown as stale rather than as current.
   *
   * Algorithm-prefixed on purpose: a consumer reads the prefix back and answers
   * 'unknown' for one it cannot compute, rather than comparing a hex string
   * against a hash of a different function and calling the entry stale.
   */
  fingerprint: string;
  /**
   * Hash of the relations the explanation was written against — who called it,
   * what it called.
   *
   * Separate from the source hash because the two rot differently: the source
   * changing means the words may be FALSE, while the relations changing means
   * they are still true but no longer the whole story. Absent on entries written
   * before this existed, which read as current rather than as drifted.
   *
   * It is a hash and not a timestamp for one reason: the first attempt compared
   * a related file's mtime against `at`, and on a fresh clone every mtime is the
   * checkout time — so every explanation in a committed file read as drifted for
   * everyone except the person who wrote it, which is the whole point of
   * committing them.
   */
  relations?: string;
}

export type ExplainOutcome =
  | { ok: true; explanations: Explanation[]; costUsd: number; ms: number }
  | { ok: false; reason: 'missing' | 'auth' | 'timeout' | 'failed' | 'unreadable'; detail: string };

/** The algorithm `fingerprintOf` produces, and the prefix it writes. */
export const FINGERPRINT_ALGORITHM = 'sha256';

/**
 * A cap per target rather than on the whole prompt. The fixed overhead of a run
 * is what the batching is for; an 8000-character function is already far past
 * the point where more source improves an answer about its *role*, and one
 * generated file should not be able to make a five-cent run a five-dollar one.
 */
const MAX_SOURCE_CHARS = 8000;

/**
 * Three real symbols measured 37 seconds — `--json-schema` is satisfied by a
 * StructuredOutput tool call, so a run is several turns rather than one. This
 * is generous against that, and is why the caller must not wait on it.
 */
const BASE_TIMEOUT_MS = 60_000;

/**
 * Per target, on top of the base. A run answers each item in turn, so a fixed
 * ceiling is one a long list reaches every time — and it reaches it *after* the
 * money is spent, which is the worst order for a failure to happen in.
 */
const TIMEOUT_PER_TARGET_MS = 45_000;

const MAX_TIMEOUT_MS = 600_000;

export function timeoutFor(targets: number): number {
  return Math.min(MAX_TIMEOUT_MS, BASE_TIMEOUT_MS + Math.max(1, targets) * TIMEOUT_PER_TARGET_MS);
}

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Where to look for `claude`, after the env override and the login shell. */
const CLAUDE_ENV_OVERRIDE = 'CODEMAP_CLAUDE_BIN';

const CLAUDE_FALLBACK_PATHS: readonly string[] = [
  '~/.local/bin/claude',
  '~/.claude/local/claude',
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '~/.bun/bin/claude',
  '/usr/bin/claude',
];

/**
 * The output shape, enforced by the CLI rather than by a parsing convention.
 * `--json-schema` makes "the model answered in prose" a thing that cannot
 * happen, which is the largest single failure mode this feature would have had.
 */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    explanations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          short: { type: 'string' },
          long: { type: 'string' },
        },
        required: ['id', 'short', 'long'],
        additionalProperties: false,
      },
    },
  },
  required: ['explanations'],
  additionalProperties: false,
};

/**
 * Ask Claude what these things are for, in one run.
 *
 * **This never throws and never rejects**, the same rule `project/git.ts`
 * follows and for a stronger reason: a server that hangs or dies because a
 * subprocess did is the worst outcome available here. Every way this can fail
 * comes back as a named reason the interface can state in words.
 *
 * The invocation is deliberate and was measured. From a neutral directory with
 * no tools and no MCP, three real symbols cost $0.029 and took 37 seconds;
 * letting the subprocess sit in the project instead costs $0.217 for a trivial
 * prompt, because it loads the project's own CLAUDE.md and tool definitions on
 * every run. Three of the flags are not about money at all:
 *
 * - `--strict-mcp-config` — without it the child reads the project's `.mcp.json`
 *   and starts a second codemap MCP server, whose every query comes back through
 *   the server's own request hook and is recorded as *the agent* asking. codemap
 *   would be reporting itself in the one timeline it exists to keep honest.
 * - `--setting-sources ''` — no user, project or local settings, so the
 *   project's PostToolUse hook is never loaded by the child and cannot feed the
 *   child's own edits back into this server.
 * - `--allowed-tools ''` — nothing pre-approved, and `-p` has nobody to ask, so
 *   every tool call is denied. Only the source passed in the prompt leaves the
 *   machine.
 *
 * `--restricted` would say the same thing in one flag and is deliberately not
 * used: it is newer than CLIs people still have installed — 2.1.167 on this
 * machine rejects it outright — and a flag that fails the whole feature on an
 * older `claude` is worse than three that every version accepts.
 */
export async function explain(
  targets: ExplainTarget[],
  options: { timeoutMs?: number } = {},
): Promise<ExplainOutcome> {
  if (targets.length === 0) return { ok: true, explanations: [], costUsd: 0, ms: 0 };

  const binary = await resolveClaude();
  if (binary.path === null) {
    // Where we looked, because "looked in these five places" is fixable and
    // "not found" is not — and under the desktop app this is the likely failure:
    // a macOS GUI app's children inherit /usr/bin:/bin, not the login PATH.
    return { ok: false, reason: 'missing', detail: `claude not found. Looked in: ${binary.looked.join(', ')}` };
  }

  const started = Date.now();
  let stdout: string;
  try {
    const run = await execFileAsync(
      binary.path,
      [
        '-p',
        buildPrompt(targets),
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(ANSWER_SCHEMA),
        '--model',
        'haiku',
        '--allowed-tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-session-persistence',
      ],
      {
        // A neutral directory: nothing here should be read as a project.
        cwd: os.tmpdir(),
        timeout: options.timeoutMs ?? timeoutFor(targets.length),
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      },
    );
    stdout = run.stdout;
  } catch (error) {
    return failureOf(error, binary.looked);
  }

  return readAnswer(stdout, targets, Date.now() - started);
}

/**
 * The prompt is the feature, so it is written as carefully as the code.
 *
 * It asks for the role in the architecture — what this is for, why it sits
 * here, who depends on it — and forbids the walkthrough, because a walkthrough
 * is the thing the reader can already do by opening the file. The relations are
 * passed in because they are the graph's own answer to "where does this sit",
 * and a model that has them reasons about position instead of guessing it.
 */
function buildPrompt(targets: ExplainTarget[]): string {
  const blocks = targets.map((target, index) => {
    const context = target.context.length > 0 ? target.context.join('\n') : '(nothing in the graph touches it)';
    return [
      `--- target ${index + 1} of ${targets.length} ---`,
      `id: ${target.id}`,
      `kind: ${target.kind}`,
      `name: ${target.name}`,
      `file: ${target.filePath}`,
      'relations:',
      context,
      'source:',
      clip(target.source),
    ].join('\n');
  });

  return [
    'You are reading code you have not seen before and explaining its ROLE IN THE ARCHITECTURE.',
    '',
    'For each target below, answer two questions and nothing else:',
    '  short — one or two sentences: what this is for, in the system’s terms.',
    '  long  — one paragraph: why it sits where it does, who depends on it, what',
    '          decision it carries, and what would break without it.',
    '',
    'Rules:',
    '- Explain the role, not the lines. No walkthrough, no restating the signature,',
    '  no describing control flow. Someone can already read the code; they cannot',
    '  read why it is here.',
    '- The relations are the graph’s own answer for what touches this. Reason from',
    '  them — they are the position you are being asked about.',
    '- If the code does not tell you why it exists, say that plainly in a clause',
    '  rather than inventing a reason.',
    '- Plain prose. No markdown, no headings, no bullet lists, no code fences.',
    '',
    'Return one entry per target, each carrying that target’s id verbatim.',
    '',
    ...blocks,
  ].join('\n');
}

function clip(source: string): string {
  if (source.length <= MAX_SOURCE_CHARS) return source;
  return `${source.slice(0, MAX_SOURCE_CHARS)}\n… truncated; the rest is not needed to say what this is for.`;
}

/**
 * Turn whatever went wrong into a reason the interface can put in a sentence.
 * Node reports all of these as one Error, so the discrimination is on its
 * fields and, for auth, on what the CLI actually said.
 */
function failureOf(error: unknown, looked: readonly string[]): ExplainOutcome {
  const detail = messageOf(error);

  if (hasCode(error, 'ENOENT')) {
    return { ok: false, reason: 'missing', detail: `claude not found. Looked in: ${looked.join(', ')}` };
  }
  // execFile reports its own timeout by killing the child, not by a code.
  if (wasKilled(error)) return { ok: false, reason: 'timeout', detail: 'claude did not answer in time' };
  if (looksLikeAuth(detail)) return { ok: false, reason: 'auth', detail };
  return { ok: false, reason: 'failed', detail };
}

/**
 * Auth is guessed from the text because the CLI's exit code does not separate
 * "you are logged out" from any other failure, and it is the one failure whose
 * fix the user can act on immediately.
 */
function looksLikeAuth(text: string): boolean {
  return /log ?in|login|logged out|authenticat|unauthorized|api key|credential|\b401\b/i.test(text);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === code;
}

function wasKilled(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { killed, signal } = error as { killed?: unknown; signal?: unknown };
  return killed === true || typeof signal === 'string';
}

function messageOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);
  const { stderr, message } = error as { stderr?: unknown; message?: unknown };
  const text = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : message;
  return (typeof text === 'string' ? text : String(error)).trim().slice(0, 2000);
}

interface CliResult {
  /**
   * Where `--json-schema` puts the validated object. The CLI satisfies the
   * schema by making the model call a StructuredOutput tool, so `result` holds
   * only its closing remark — "Done. The StructuredOutput tool has been called."
   * Reading `result` and finding no JSON in it is the shape of this mistake.
   */
  structured_output?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  is_error?: unknown;
  subtype?: unknown;
}

/**
 * The CLI's envelope, then the model's answer inside it. Both are parsed
 * defensively: an answer that cannot be read is `unreadable`, which is a
 * sentence the interface can show, and never an exception the server has to
 * survive.
 */
function readAnswer(stdout: string, targets: ExplainTarget[], ms: number): ExplainOutcome {
  let envelope: CliResult;
  try {
    envelope = JSON.parse(stdout) as CliResult;
  } catch {
    return { ok: false, reason: 'unreadable', detail: `claude printed something that is not JSON: ${stdout.trim().slice(0, 400)}` };
  }

  const text = typeof envelope.result === 'string' ? envelope.result : '';
  const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : 'success';
  if (envelope.is_error === true || subtype !== 'success') {
    // The CLI's own name for "the model would not produce the shape asked for",
    // which is this module's 'unreadable' rather than a failure of the run.
    if (subtype.includes('structured_output')) return { ok: false, reason: 'unreadable', detail: subtype };
    return looksLikeAuth(text) ? { ok: false, reason: 'auth', detail: text } : { ok: false, reason: 'failed', detail: text || 'claude reported an error' };
  }

  const answers = parseAnswers(envelope.structured_output ?? envelope.result);
  if (answers === null) {
    const shown = (text.trim() === '' ? stdout : text).trim().slice(0, 400);
    return { ok: false, reason: 'unreadable', detail: `no answer could be read out of: ${shown}` };
  }

  const at = Date.now();
  const byId = new Map(targets.map((target) => [target.id, target]));
  const explanations: Explanation[] = [];
  const seen = new Set<string>();

  for (const answer of answers) {
    const target = byId.get(answer.id);
    // Ids that were not asked about are dropped rather than stored: an entry
    // keyed to nothing in the graph could never be shown, refreshed or removed.
    if (target === undefined || seen.has(answer.id)) continue;
    seen.add(answer.id);
    explanations.push({
      id: target.id,
      kind: target.kind,
      short: answer.short.trim(),
      long: answer.long.trim(),
      at,
      fingerprint: fingerprintOf(target.source),
      // What it was told about its surroundings, so drift can be seen later
      // without asking the filesystem what time it is.
      relations: relationsFingerprint(target.related),
    });
  }

  if (explanations.length === 0) {
    return { ok: false, reason: 'unreadable', detail: 'the answer named none of the targets that were asked about' };
  }

  const cost = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0;
  return { ok: true, explanations, costUsd: cost, ms };
}

interface Answer {
  id: string;
  short: string;
  long: string;
}

/**
 * `--json-schema` should make the first branch the only one that ever runs. The
 * others are here because a model that ignores the shape must degrade into
 * 'unreadable' or a partial answer, never into a crash on the server.
 */
function parseAnswers(result: unknown): Answer[] | null {
  const value = typeof result === 'string' ? parseJsonish(result) : result;
  if (typeof value !== 'object' || value === null) return null;

  const wrapped = (value as { explanations?: unknown }).explanations;
  if (Array.isArray(wrapped)) return collect(wrapped);
  if (Array.isArray(value)) return collect(value);

  // An object keyed by id: the shape the prompt describes in words, arrived at
  // without the wrapper.
  const entries: Answer[] = [];
  for (const [id, body] of Object.entries(value)) {
    const answer = answerOf({ ...(typeof body === 'object' && body !== null ? body : {}), id });
    if (answer !== null) entries.push(answer);
  }
  return entries.length > 0 ? entries : null;
}

function collect(items: readonly unknown[]): Answer[] | null {
  const found = items.map(answerOf).filter((answer): answer is Answer => answer !== null);
  return found.length > 0 ? found : null;
}

function answerOf(item: unknown): Answer | null {
  if (typeof item !== 'object' || item === null) return null;
  const { id, short, long } = item as { id?: unknown; short?: unknown; long?: unknown };
  if (typeof id !== 'string' || id === '') return null;
  const one = typeof short === 'string' ? short : '';
  const many = typeof long === 'string' ? long : '';
  if (one === '' && many === '') return null;
  // Either half alone is still worth keeping; the panel shows what it has.
  return { id, short: one === '' ? many : one, long: many === '' ? one : many };
}

/** Text that is meant to be JSON, possibly wearing a code fence or a preamble. */
function parseJsonish(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidates = [text, fenced?.[1] ?? '', sliceBraces(text)];
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue;
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }
  return null;
}

function sliceBraces(text: string): string {
  const open = text.indexOf('{');
  const close = text.lastIndexOf('}');
  return open === -1 || close <= open ? '' : text.slice(open, close + 1);
}

/**
 * Find `claude`. Its own resolution is a function because PATH cannot be
 * trusted here: under the packaged desktop app the server is a child of a macOS
 * GUI process, which inherits `/usr/bin:/bin` and not the login shell's PATH,
 * so the binary the user installed is invisible to a bare spawn.
 *
 * Not cached. The one saved login-shell spawn is nothing against the model
 * call, and a stale cached path would survive an upgrade that moved it.
 */
async function resolveClaude(): Promise<{ path: string | null; looked: string[] }> {
  const looked: string[] = [];

  const override = process.env[CLAUDE_ENV_OVERRIDE];
  if (override !== undefined && override !== '') {
    looked.push(`$${CLAUDE_ENV_OVERRIDE}=${override}`);
    if (await isExecutable(override)) return { path: override, looked };
  }

  const shell = process.env['SHELL'];
  if (shell !== undefined && shell !== '') {
    looked.push(`${shell} -lc 'command -v claude'`);
    const found = await askShell(shell);
    if (found !== null) return { path: found, looked };
  }

  for (const candidate of CLAUDE_FALLBACK_PATHS) {
    const absolute = expandHome(candidate);
    looked.push(absolute);
    if (await isExecutable(absolute)) return { path: absolute, looked };
  }

  return { path: null, looked };
}

/**
 * A login shell, because that is where a user's PATH additions live — a
 * non-interactive `sh -c` would miss exactly the installs this is for.
 */
async function askShell(shell: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(shell, ['-lc', 'command -v claude'], {
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    const first = stdout.split('\n')[0]?.trim() ?? '';
    if (first === '' || !path.isAbsolute(first)) return null;
    return (await isExecutable(first)) ? first : null;
  } catch {
    return null;
  }
}

function expandHome(candidate: string): string {
  return candidate.startsWith('~/') ? path.join(os.homedir(), candidate.slice(2)) : candidate;
}

async function isExecutable(candidate: string): Promise<boolean> {
  return access(candidate, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}

function explainPath(root: string): string {
  return path.join(root, '.codemap', 'explain.json');
}

/**
 * Stored beside the group names, in the project, for the same reason: a reading
 * of why a piece of architecture exists is worth committing and worth sharing
 * with whoever else works here.
 *
 * Returns [] for a file that is missing or that no longer parses. A hand-edited
 * file must not be able to take the feature down.
 */
export async function readExplanations(root: string): Promise<Explanation[]> {
  const raw = await readFile(explainPath(root), 'utf8').catch(() => null);
  if (raw === null) return [];

  try {
    const parsed = JSON.parse(raw) as { explanations?: unknown };
    return Array.isArray(parsed.explanations) ? (parsed.explanations as Explanation[]) : [];
  } catch {
    return [];
  }
}

/** Called only when an answer actually arrived; nothing appears in a repository uninvited. */
export async function writeExplanations(root: string, all: Explanation[]): Promise<void> {
  await mkdir(path.join(root, '.codemap'), { recursive: true });
  await writeFile(explainPath(root), `${JSON.stringify({ explanations: all }, null, 2)}\n`, 'utf8');
}

/**
 * The identity of the source that was explained.
 *
 * Prefixed with the algorithm so a future one can be added without a stored
 * entry silently comparing unequal and reading as stale — a consumer that does
 * not recognise the prefix must say it cannot tell, not that the words are now
 * false.
 */
export function fingerprintOf(source: string): string {
  return `${FINGERPRINT_ALGORITHM}:${createHash(FINGERPRINT_ALGORITHM).update(source).digest('hex')}`;
}

/**
 * The same hash over a symbol's relations, sorted so the order the graph happens
 * to walk them in cannot make an unchanged project look changed.
 */
export function relationsFingerprint(related: readonly string[]): string {
  return fingerprintOf([...related].sort().join('\n'));
}

import { execFile, spawn } from 'node:child_process';
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
  /**
   * How much of `context` the graph can vouch for, in the graph's own words.
   *
   * A method's callers are only known when the call went through a receiver
   * whose type was written down, so an empty list under a method means
   * unknown, not none. The reading of cobra's `Command.Execute` said nothing
   * depended on it — false in sixteen places — because the prompt let the
   * model read an empty list as a fact. `describeSymbol` decides which it is;
   * the prompt repeats its note beside the relations so the model cannot miss it.
   */
  coverage?: 'full' | 'partial';
  coverageNote?: string;
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

export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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
  options: { timeoutMs?: number; onDelta?: (text: string) => void } = {},
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
  const stream = await runStreaming(
    binary.path,
    buildPrompt(targets),
    options.timeoutMs ?? timeoutFor(targets.length),
    options.onDelta,
  );
  if (!stream.ok) return failureOf(stream.error, binary.looked);

  return readAnswer(stream.text, targets, Date.now() - started, stream.costUsd);
}

/**
 * Run it and read the answer as it is written, rather than waiting for the end.
 *
 * `--output-format stream-json` emits one JSON object per line, and with
 * `--include-partial-messages` the content arrives as `content_block_delta`
 * events carrying a few characters each. Handing those to `onDelta` is the
 * whole reason this is a spawn rather than an execFile: fifty seconds of an
 * unmoving "Explaining…" is indistinguishable from a hung subprocess, and the
 * only cure is showing the words appearing.
 *
 * The cost of it is that `--json-schema` had to go. A schema makes the model
 * stream a JSON object, so what a reader would watch arrive is
 * `{"explanations":[{"id":"src/pro` — the structure, not the sentences. So the
 * answer is asked for as delimited prose instead, and "the model answered in
 * the wrong shape" is a failure again. It is caught as `unreadable`, and it is
 * worth the trade: an answer nobody watched arrive feels broken even when it works.
 */
async function runStreaming(
  binary: string,
  prompt: string,
  timeoutMs: number,
  onDelta?: (text: string) => void,
): Promise<{ ok: true; text: string; costUsd: number } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--model',
        'haiku',
        '--allowed-tools',
        '',
        '--strict-mcp-config',
        '--setting-sources',
        '',
        '--no-session-persistence',
      ],
      { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let answer = '';
    // The closing 'result' line carries what the run actually cost. It is the
    // one thing the deltas do not, so it is picked up as it goes past.
    let costUsd = 0;
    let stderr = '';
    let buffer = '';
    let size = 0;
    let settled = false;

    const done = (result: { ok: true; text: string; costUsd: number } | { ok: false; error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Our own timer, because spawn has no timeout option worth the name: SIGTERM
    // first so the CLI can end its own turn, and nothing after — a killed child
    // still fires 'close', which is where the reporting happens.
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      done({ ok: false, error: Object.assign(new Error('claude did not answer in time'), { killed: true }) });
    }, timeoutMs);

    child.on('error', (error) => done({ ok: false, error }));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });

    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        child.kill('SIGTERM');
        done({ ok: false, error: new Error('claude produced more output than could be read') });
        return;
      }
      buffer += chunk.toString('utf8');
      // A chunk can split a line, so the tail is kept until its newline arrives.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const price = costOf(line);
        if (price !== null) costUsd = price;
        const text = deltaOf(line);
        if (text === null) continue;
        answer += text;
        onDelta?.(text);
      }
    });

    child.on('close', (code) => {
      if (code === 0) done({ ok: true, text: answer, costUsd });
      else done({ ok: false, error: new Error(stderr.trim() || `claude exited with code ${code ?? 'null'}`) });
    });
  });
}

/** What the closing line says the run cost, or null on any other line. */
function costOf(line: string): number | null {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.includes('total_cost_usd')) return null;
  try {
    const value = (JSON.parse(trimmed) as { total_cost_usd?: unknown }).total_cost_usd;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/** The text a stream line carries, or null when it carries none. */
function deltaOf(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    // A line that is not JSON is not an answer; the CLI writes those too.
    return null;
  }
  const record = event as { type?: unknown; event?: { type?: unknown; delta?: { text?: unknown } } };
  if (record.type !== 'stream_event') return null;
  if (record.event?.type !== 'content_block_delta') return null;
  const text = record.event.delta?.text;
  return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * The prompt is the feature, so it is written as carefully as the code.
 *
 * It asks for the role in the architecture — what this is for, why it sits
 * here, who depends on it — and forbids the walkthrough, because a walkthrough
 * is the thing the reader can already do by opening the file. The relations are
 * passed in because they are the graph's own answer to "where does this sit",
 * and a model that has them reasons about position instead of guessing it.
 *
 * It also says what the graph cannot see. Static analysis tracks a call only
 * when the receiver's type is written down, so an empty list under a method is
 * not "nothing calls this" — and a model that is not told so will conclude
 * exactly that, confidently, which is the one failure this project cares most
 * about. Exported for the test beside this module: the prompt is the product,
 * and a paid run is not the way to check its words.
 */
export function buildPrompt(targets: ExplainTarget[]): string {
  const blocks = targets.map((target, index) => {
    const context = target.context.length > 0 ? target.context.join('\n') : '(nothing in the graph touches it)';
    // The graph's own note goes beside the list it qualifies, not only in the
    // rules above: a caveat forty lines away from an empty list is one that
    // gets forgotten by the time the list is read.
    const coverage =
      target.coverage === 'partial'
        ? `relations (PARTIAL — ${target.coverageNote ?? 'an empty list means unknown, not none'}):`
        : 'relations:';
    return [
      `--- target ${index + 1} of ${targets.length} ---`,
      `id: ${target.id}`,
      `kind: ${target.kind}`,
      `name: ${target.name}`,
      `file: ${target.filePath}`,
      coverage,
      context,
      'source:',
      clip(target.source),
    ].join('\n');
  });

  return [
    'You are reading code you have not seen before and explaining its ROLE IN THE ARCHITECTURE.',
    '',
    'WHO YOU ARE WRITING FOR: a developer with a computer science background and',
    'about three years of experience. They know what a class, a callback, a queue',
    'and a race condition are — do not explain those. They do not know THIS system,',
    'and they have not read a paper on it either. So: plain words, short sentences,',
    'ordinary terms. If a piece of jargon is the honest name for something, use it',
    'and say what it means here in the same breath. Never reach for a longer word',
    'than the thing needs.',
    '',
    'For each target, answer two things and nothing else:',
    '  first  — one or two sentences: what this is for, in the system’s terms.',
    '  then   — a blank line, then a paragraph or two: why it sits where it does,',
    '           who depends on it, what decision it carries, and what would break',
    '           without it.',
    '',
    'Rules:',
    '- Explain the role, not the lines. No walkthrough, no restating the signature,',
    '  no describing control flow. Someone can already read the code; they cannot',
    '  read why it is here.',
    '- The relations are the graph’s own answer for what touches this. Reason from',
    '  them — they are the position you are being asked about.',
    '- The graph has blind spots, and it says so. It was built by static analysis:',
    '  a call is tracked only when the receiver’s type is written in the source, so',
    '  a call through an untyped variable, a callback, an interface value or a',
    '  dynamic lookup is invisible to it. A method’s or a field’s relations are',
    '  marked PARTIAL for exactly this reason. Under a PARTIAL list, an empty',
    '  "used by" means UNKNOWN, not none: say that callers are not tracked, and',
    '  never conclude that nothing depends on it. A non-empty PARTIAL list is a',
    '  lower bound, not the whole set. A list that is not marked PARTIAL — a',
    '  top-level function, a class, an interface, a type, a file — is what the',
    '  graph actually found, and may be read as such.',
    '- If the code does not tell you why it exists, say that plainly in a clause',
    '  rather than inventing a reason.',
    '- Plain prose. No markdown, no headings, no bullet lists, no code fences.',
    '',
    'FORMAT. Before each answer, write a line that is exactly two at-signs, a',
    'space, and that target’s id copied verbatim. Then the answer. Nothing else —',
    'no preamble before the first one, no summary after the last.',
    '',
    '  @@ src/example.ts#thing',
    '  One or two sentences saying what it is for.',
    '',
    '  The longer part, in one or two paragraphs.',
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
export function failureOf(error: unknown, looked: readonly string[]): Extract<ExplainOutcome, { ok: false }> {
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
export function looksLikeAuth(text: string): boolean {
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

export interface CliResult {
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
function readAnswer(text: string, targets: ExplainTarget[], ms: number, costUsd: number): ExplainOutcome {
  if (looksLikeAuth(text)) return { ok: false, reason: 'auth', detail: text.trim().slice(0, 400) };

  const answers = parseAnswers(text);
  if (answers.length === 0) {
    const shown = text.trim().slice(0, 400);
    return {
      ok: false,
      reason: 'unreadable',
      detail: shown === '' ? 'claude answered with nothing' : `no answer could be read out of: ${shown}`,
    };
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

  return { ok: true, explanations, costUsd, ms };
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
/**
 * Read the delimited prose back into answers.
 *
 * The format is a separator line naming the id, then the paragraphs. The first
 * paragraph is the short answer and the rest is the long one, which is why the
 * prompt asks for a blank line after the opening sentences: it is the only
 * structure in the whole reply, and it is one a model writing prose produces
 * naturally rather than one it has to remember.
 *
 * Tolerant on purpose. An id that was never asked about is dropped by the
 * caller, a target that got no block simply has no entry, and a reply with no
 * separators at all reads as none — which the caller turns into 'unreadable'.
 */
function parseAnswers(text: string): Answer[] {
  const answers: Answer[] = [];
  let id: string | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (id === null) return;
    const paragraphs = body
      .join('\n')
      .split(/\n\s*\n/)
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const short = paragraphs[0] ?? '';
    if (short !== '') {
      answers.push({ id, short, long: paragraphs.slice(1).join('\n\n') });
    }
    id = null;
    body = [];
  };

  for (const line of text.split('\n')) {
    const marker = /^\s*@@\s+(\S.*?)\s*$/.exec(line);
    if (marker?.[1] !== undefined) {
      flush();
      id = marker[1];
      continue;
    }
    if (id !== null) body.push(line);
  }
  flush();

  return answers;
}


/** Text that is meant to be JSON, possibly wearing a code fence or a preamble. */
export function parseJsonish(text: string): unknown {
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
export async function resolveClaude(): Promise<{ path: string | null; looked: string[] }> {
  const looked: string[] = [];

  const override = process.env[CLAUDE_ENV_OVERRIDE];
  if (override !== undefined && override !== '') {
    looked.push(`$${CLAUDE_ENV_OVERRIDE}=${override}`);
    // An override is the only place looked. Falling through to the login shell
    // when it names nothing executable ran the real binary — and spent — on a
    // machine where the variable had been set precisely so that it would not.
    return { path: (await isExecutable(override)) ? override : null, looked };
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

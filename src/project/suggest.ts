import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import {
  failureOf,
  looksLikeAuth,
  MAX_OUTPUT_BYTES,
  parseJsonish,
  resolveClaude,
  timeoutFor,
  type CliResult,
} from './explain.js';

const execFileAsync = promisify(execFile);

/**
 * One group to name: a cluster the graph found and nobody has accepted or
 * rejected yet. Files rather than symbols, because a name is what a developer
 * would call the group in conversation, and the paths are what say what it is.
 */
export interface SuggestTarget {
  /** The cluster id, which is how the answer is matched back. */
  id: string;
  files: string[];
  /** Share of the group's edges that stay inside it, 0..1. */
  cohesion: number;
}

/**
 * A name the model proposed for one target. Session state on the server and
 * a row on the page, never a line in `groups.json`: decision 5 says a model
 * may suggest a name and a person accepts it, and accepting is the only write.
 */
export interface Suggestion {
  id: string;
  name: string;
  /** One sentence: what in the files argued for the name. */
  reason: string;
}

export type SuggestOutcome =
  | { ok: true; suggestions: Suggestion[]; costUsd: number; ms: number }
  | { ok: false; reason: 'missing' | 'auth' | 'timeout' | 'failed' | 'unreadable'; detail: string };

/**
 * A cap per target, for the reason explain caps source. A name is read off the
 * shape of the paths, and eighty of them show that shape as well as eight
 * hundred would — while a monorepo's outer cluster must not be able to turn a
 * two-cent run into a two-dollar one.
 */
const MAX_FILES_PER_TARGET = 80;

/** How many of a named group's files are shown as context for its name. */
const NAMED_FILES_SHOWN = 6;

/**
 * The shape the CLI holds the model to. `--json-schema` makes "the model
 * answered in prose" impossible; what it cannot make impossible is an invented
 * id, which is why `readAnswer` checks every one against what was asked.
 */
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['id', 'name', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['suggestions'],
  additionalProperties: false,
};

/**
 * Ask Claude what to call these groups, in one run.
 *
 * The invocation is `explain()`'s, and the reasons for every flag are written
 * above that function: a neutral cwd so the child does not load this project's
 * CLAUDE.md, `--strict-mcp-config` so it cannot start a second codemap and be
 * recorded as the agent, `--setting-sources ''` so the project's hook is never
 * loaded, `--allowed-tools ''` so only the prompt leaves the machine. This one
 * keeps `--json-schema` where explain gave it up for streaming: nobody watches
 * a name arrive, and a shape the CLI enforces is worth more than a prompt the
 * model is asked to honour.
 *
 * Measured: this repository's three unnamed groups, 62 files in the largest,
 * cost $0.044 and took 62.6 seconds. A flat 60 seconds was the first draft and
 * timed out on exactly that run, after the money was spent — so the ceiling is
 * explain's, which grows with the list for the reason written above it.
 *
 * **Never throws and never rejects.** Every failure is a named reason the
 * section can put in a sentence, and the model's answer is a proposal: nothing
 * here writes, and `named` is context — the names already taken, and the style
 * to match — not a list to edit.
 */
export async function suggestNames(
  targets: SuggestTarget[],
  named: { name: string; files: string[] }[],
  options: { timeoutMs?: number } = {},
): Promise<SuggestOutcome> {
  if (targets.length === 0) return { ok: true, suggestions: [], costUsd: 0, ms: 0 };

  const binary = await resolveClaude();
  if (binary.path === null) {
    return { ok: false, reason: 'missing', detail: `claude not found. Looked in: ${binary.looked.join(', ')}` };
  }

  const started = Date.now();
  let stdout: string;
  try {
    const pending = execFileAsync(
      binary.path,
      [
        '-p',
        buildPrompt(targets, named),
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
    // The CLI reads stdin when it is not a terminal and waits three seconds
    // for it before going on without it. execFile hands the child a pipe
    // nobody will write to, which is exactly that — so it is closed at once.
    // explain spawns with stdin ignored for the same reason.
    pending.child.stdin?.end();
    stdout = (await pending).stdout;
  } catch (error) {
    // A non-zero exit still carries what the CLI printed: the envelope with
    // is_error and its words is on the error's `stdout`, and that is where an
    // auth failure is told apart from any other. Read it first. And never the
    // error's own message — execFile's is the whole command line, prompt
    // included, which is not what a section should print under its header.
    const printed = stdoutOf(error);
    if (printed !== null) return readAnswer(printed, targets, Date.now() - started);
    return failureOf(withoutCommandLine(error), binary.looked);
  }

  return readAnswer(stdout, targets, Date.now() - started);
}

/** The envelope a failed exit printed, when it printed one. */
function stdoutOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { stdout } = error as { stdout?: unknown };
  return typeof stdout === 'string' && stdout.trim().startsWith('{') ? stdout : null;
}

/**
 * The same error, with execFile's message — the command line — replaced by
 * what a person can act on. `stderr`, `code`, `killed` and `signal` are own
 * enumerable fields and survive the spread; `message` is not, and is set.
 */
function withoutCommandLine(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const { stderr, code } = error as { stderr?: unknown; code?: unknown };
  if (typeof stderr === 'string' && stderr.trim() !== '') return error;
  return { ...error, message: typeof code === 'number' ? `claude exited with code ${code}` : 'claude failed without saying why' };
}

/**
 * The brief is the one `name_group` gives the agent, so a name from either
 * source reads the same on the page. The names already taken are passed for
 * two reasons: a model that can see "Graph engine" writes in that register,
 * and one that cannot see it proposes it again for the group that contains it.
 */
function buildPrompt(targets: SuggestTarget[], named: { name: string; files: string[] }[]): string {
  const taken =
    named.length === 0
      ? ['  (none yet)']
      : named.map((group) => `  "${group.name}" (${group.files.length} files): ${sampleOf(group.files)}`);

  const blocks = targets.map((target, index) =>
    [
      `--- target ${index + 1} of ${targets.length} ---`,
      `id: ${target.id}`,
      `cohesion: ${Math.round(target.cohesion * 100)}%`,
      `files (${target.files.length}):`,
      ...listOf(target.files),
    ].join('\n'),
  );

  return [
    'You are naming groups of files in a codebase you have not seen before.',
    '',
    'Each target is a group the import graph found: files that lean on each other',
    'more than on anything else. Give each one a short name describing what it',
    'is — two or three words, the kind a developer would use in conversation,',
    'for example "Parsing" or "HTTP surface". Name what the group does, not',
    'where it lives: "Parsing", never "Files in src/parser".',
    '',
    'Rules:',
    '- One suggestion per target, with its id copied verbatim. Never invent an id.',
    '- One sentence of reason each, saying which files argued for the name.',
    '- Some groups already have names, listed below. Match their style, and do',
    '  not reuse one: a target that overlaps a named group is a different group',
    '  and needs a name of its own.',
    '- Cohesion is the share of the group’s imports that stay inside it. A low',
    '  number is a loose group, and its name should not claim more than that.',
    '- Nothing else: no preamble, no commentary, no summary.',
    '',
    'Names already taken:',
    ...taken,
    '',
    ...blocks,
  ].join('\n');
}

function listOf(files: readonly string[]): string[] {
  const shown = files.slice(0, MAX_FILES_PER_TARGET).map((file) => `  ${file}`);
  const rest = files.length - MAX_FILES_PER_TARGET;
  if (rest > 0) shown.push(`  … and ${rest} more`);
  return shown;
}

function sampleOf(files: readonly string[]): string {
  const shown = files.slice(0, NAMED_FILES_SHOWN).join(', ');
  return files.length > NAMED_FILES_SHOWN ? `${shown}, …` : shown;
}

/**
 * The CLI's envelope, then the model's answer inside it — in
 * `structured_output`, which is where `--json-schema` puts it; `result` holds
 * only a closing remark. Both are read defensively: an answer that cannot be
 * read is `unreadable`, a sentence the section can show, never an exception
 * the server has to survive.
 */
/** Pure, and exported for the test beside this module. */
export function readAnswer(stdout: string, targets: readonly SuggestTarget[], ms: number): SuggestOutcome {
  let envelope: CliResult;
  try {
    envelope = JSON.parse(stdout) as CliResult;
  } catch {
    return {
      ok: false,
      reason: 'unreadable',
      detail: `claude printed something that is not JSON: ${stdout.trim().slice(0, 400)}`,
    };
  }

  const text = typeof envelope.result === 'string' ? envelope.result : '';
  const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : 'success';
  if (envelope.is_error === true || subtype !== 'success') {
    // The CLI's own name for "the model would not produce the shape asked for",
    // which is this module's 'unreadable' rather than a failure of the run.
    if (subtype.includes('structured_output')) return { ok: false, reason: 'unreadable', detail: subtype };
    return looksLikeAuth(text)
      ? { ok: false, reason: 'auth', detail: text }
      : { ok: false, reason: 'failed', detail: text || 'claude reported an error' };
  }

  const proposed = parseSuggestions(envelope.structured_output ?? envelope.result);
  if (proposed === null) {
    const shown = (text.trim() === '' ? stdout : text).trim().slice(0, 400);
    return { ok: false, reason: 'unreadable', detail: `no answer could be read out of: ${shown}` };
  }

  const asked = new Set(targets.map((target) => target.id));
  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const suggestion of proposed) {
    // An id that was not asked about would be a row for no group on the page,
    // and a second answer for the same id is the model changing its mind.
    if (!asked.has(suggestion.id) || seen.has(suggestion.id)) continue;
    seen.add(suggestion.id);
    suggestions.push(suggestion);
  }

  if (suggestions.length === 0) {
    return { ok: false, reason: 'unreadable', detail: 'the answer named none of the groups that were asked about' };
  }

  const cost = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0;
  return { ok: true, suggestions, costUsd: cost, ms };
}

/**
 * `--json-schema` should make the wrapped object the only shape that ever
 * arrives. The rest is here because a model that ignores the shape must
 * degrade into 'unreadable' or a partial answer, never into a crash.
 */
function parseSuggestions(result: unknown): Suggestion[] | null {
  const value = typeof result === 'string' ? parseJsonish(result) : result;
  if (typeof value !== 'object' || value === null) return null;

  const wrapped = (value as { suggestions?: unknown }).suggestions;
  const list = Array.isArray(wrapped) ? wrapped : Array.isArray(value) ? value : null;
  if (list === null) return null;

  const suggestions: Suggestion[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name, reason } = entry as { id?: unknown; name?: unknown; reason?: unknown };
    // A blank name is not a suggestion, whatever the reason beside it says.
    if (typeof id !== 'string' || typeof name !== 'string' || name.trim() === '') continue;
    suggestions.push({ id, name: name.trim(), reason: typeof reason === 'string' ? reason.trim() : '' });
  }
  return suggestions;
}

import { spawn } from 'node:child_process';
import os from 'node:os';

import type { EdgeKind, NodeKind } from '../graph/types.js';
import { failureOf, looksLikeAuth, MAX_OUTPUT_BYTES, resolveClaude } from './explain.js';

/**
 * One symbol a category puts on its interface: declared inside it, reached by
 * a file outside it. `view/types.ts`'s `ProvidedSymbol` narrowed to what a
 * sentence can use — the count of *which* files reach it is what says whether
 * a symbol is the category's front door or an accident.
 */
export interface AskProvided {
  name: string;
  kind: NodeKind;
  /** The class this is a member of, so `init` can be spelled `App.init`. */
  owner: string | null;
  reachedFrom: number;
}

/**
 * One category, as the component diagram draws it.
 *
 * The fields are `ComponentFacts`' and `ViewNode.files`, restated here rather
 * than imported so this module does not depend on `view/` — the same reason
 * `git/types.ts` sits apart from `project/git.ts`. `server/ask.ts` fills it
 * from a real component view, so what the model is told and what the person
 * is looking at are the same picture.
 */
export interface AskCategory {
  /** The box id, which is what the edges name. Never shown to the model. */
  id: string;
  /** The name a person or an agent gave it, or null while nobody has. */
  name: string | null;
  files: string[];
  /** Share of the category's edges that stay inside it, 0..1. */
  cohesion?: number;
  /** A person drew it; the import graph did not find it. */
  origin?: 'manual';
  /** The box for every file no category holds. */
  uncategorised?: true;
  provides: AskProvided[];
  /** How many symbols it provides in all, before `provides` was cut. */
  providesTotal: number;
}

/** One line between two categories: the imports between their files, summed. */
export interface AskEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** How many file-to-file edges cross this pair. */
  weight: number;
}

/**
 * Everything the model is told, and the whole of it.
 *
 * Deliberately not the source of a single file. A trivial prompt run from
 * inside the project measured $0.217 against $0.0255 from a neutral directory,
 * because the child loads the project's CLAUDE.md and tool definitions on
 * every run — and a conversation that re-read the codebase every turn would
 * pay that on every turn. This is what the graph already holds, at the
 * distance the component diagram draws it.
 */
export interface AskContext {
  /** The project's directory name. The only thing said about it that is not a fact of the graph. */
  project: string;
  /** How many files the graph holds, so a category's size can be read as a share. */
  fileCount: number;
  categories: AskCategory[];
  edges: AskEdge[];
}

export type AskFailure = 'missing' | 'auth' | 'timeout' | 'failed' | 'unreadable';

/**
 * Which of the two things arriving a few characters are.
 *
 * Measured, and the reason this distinction exists at all: haiku writes a
 * `thinking` block before it writes a word of the answer, and on a real
 * question that took 12 seconds while the answer itself then took 3. Reading
 * only the answer meant twelve seconds of nothing on screen — the unmoving
 * spinner streaming exists to prevent. Reading the thinking *as* the answer
 * would be worse: it is the model working, not the model's reply, and this
 * project does not show a reader something that is not what it says it is.
 * So both arrive, each saying which it is, and the page draws them apart.
 */
export type AskDeltaKind = 'thinking' | 'answer';

export type AskOutcome =
  | {
      ok: true;
      text: string;
      /**
       * The CLI session this run was, which is what the next turn resumes.
       * Null when no line named one, which is the case a follow-up must fall
       * back to re-sending the context for.
       */
      sessionId: string | null;
      costUsd: number;
      ms: number;
      /**
       * Wall clock from spawn to the first characters on screen, of either
       * kind. What a person actually waits before something moves.
       */
      firstTokenMs: number | null;
      /**
       * And to the first character of the answer itself.
       *
       * Two numbers because haiku thinks before it answers, and measured they
       * are 2 seconds and 12 — so one number would either hide the wait for
       * the answer or claim the screen sat empty for it. See `AskDeltaKind`.
       */
      firstAnswerMs: number | null;
    }
  | { ok: false; reason: AskFailure; detail: string };

export interface AskRequest {
  question: string;
  /**
   * The categories. Sent on a turn that starts a conversation, and null on one
   * that resumes: the CLI holds the transcript, so re-sending it would be
   * paying twice for the same paragraphs.
   */
  context: AskContext | null;
  /** The session to continue, or null to start one. */
  resume: string | null;
}

/**
 * A cap per category, for the reason `suggest.ts` caps its file lists: the
 * shape of a group is legible in forty paths and does not become more legible
 * in four hundred, while one monorepo category must not be able to turn a
 * two-cent turn into a two-dollar one.
 */
const MAX_FILES_PER_CATEGORY = 40;

/**
 * One question, one answer, and haiku. Measured on an eleven-category project:
 * first characters in 2.5 s, the whole answer in 17 s. This is generous
 * against that, and the caller does not wait on it either way — the words
 * arrive on the socket as they are written.
 */
const ASK_TIMEOUT_MS = 120_000;

/**
 * Ask Claude about the shape of this project, and keep asking.
 *
 * **Never throws and never rejects**, the rule `explain()` and `suggest()`
 * follow: every way this can fail comes back as a named reason the interface
 * can put in a sentence. The invocation is `explain()`'s and the reasons for
 * each flag are written above it — a neutral cwd so the child does not load
 * this project's CLAUDE.md, `--strict-mcp-config` so it cannot start a second
 * codemap and be recorded as the agent, `--setting-sources ''` so the
 * project's hook is never loaded, `--allowed-tools ''` so only the prompt
 * leaves the machine.
 *
 * Two things differ from explain, and both are the point of this module:
 *
 * - **`--no-session-persistence` is not passed.** The CLI's help is explicit
 *   that a session it does not save "cannot be resumed", and resuming is the
 *   whole feature: measured on an eleven-category project, a first turn cost
 *   $0.0257 and the follow-up that resumed it $0.0112, and that follow-up
 *   could name files out of the earlier answer without being sent them again.
 *   The price is that the CLI writes the transcript into its own store under
 *   the user's home, as it does for any `claude -p` run — see
 *   `AskConversation` in `server/session.ts` for what codemap itself keeps,
 *   which is nothing on disk.
 * - **No `--json-schema`.** An answer here is prose for a person to read, so
 *   there is no shape to enforce; and a schema would make the model stream a
 *   JSON object, which is `{"answer":"The graph eng` arriving character by
 *   character rather than words. explain gave the schema up for exactly this.
 *
 * This reads and it never decides. It is told the categories and answers about
 * them; nothing it says is written anywhere, and a name it proposes is a name
 * a person still has to accept through the gesture that already exists.
 */
export async function ask(
  request: AskRequest,
  options: { timeoutMs?: number; onDelta?: (text: string, kind: AskDeltaKind) => void } = {},
): Promise<AskOutcome> {
  const binary = await resolveClaude();
  if (binary.path === null) {
    // Where we looked, because "looked in these five places" is fixable and
    // "not found" is not — the same sentence explain shows, for the same
    // failure under the packaged desktop app.
    return { ok: false, reason: 'missing', detail: `claude not found. Looked in: ${binary.looked.join(', ')}` };
  }

  const started = Date.now();
  const stream = await runStreaming(
    binary.path,
    buildPrompt(request),
    request.resume,
    options.timeoutMs ?? ASK_TIMEOUT_MS,
    started,
    options.onDelta,
  );
  if (!stream.ok) return failureOf(stream.error, binary.looked);

  if (looksLikeAuth(stream.text)) return { ok: false, reason: 'auth', detail: stream.text.trim().slice(0, 400) };

  const text = stream.text.trim();
  if (text === '') {
    return { ok: false, reason: 'unreadable', detail: 'claude answered with nothing' };
  }

  return {
    ok: true,
    text,
    sessionId: stream.sessionId,
    costUsd: stream.costUsd,
    ms: Date.now() - started,
    firstTokenMs: stream.firstTokenMs,
    firstAnswerMs: stream.firstAnswerMs,
  };
}

interface StreamResult {
  text: string;
  costUsd: number;
  sessionId: string | null;
  firstTokenMs: number | null;
  firstAnswerMs: number | null;
}

/**
 * Run it and hand the words on as they are written.
 *
 * Streaming is what makes this feel like a conversation rather than a form
 * submission: explain measured 27 to 37 seconds for a whole answer, and thirty
 * seconds of an unmoving spinner is indistinguishable from a hung subprocess.
 * The first characters here arrive in about two seconds, and that is the
 * number a person actually experiences — so it is measured and reported
 * separately from the total.
 */
function runStreaming(
  binary: string,
  prompt: string,
  resume: string | null,
  timeoutMs: number,
  started: number,
  onDelta?: (text: string, kind: AskDeltaKind) => void,
): Promise<{ ok: true } & StreamResult | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        '-p',
        prompt,
        ...(resume === null ? [] : ['--resume', resume]),
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
      ],
      { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let answer = '';
    let costUsd = 0;
    let sessionId: string | null = null;
    let firstTokenMs: number | null = null;
    let firstAnswerMs: number | null = null;
    let stderr = '';
    let buffer = '';
    let size = 0;
    let settled = false;

    const done = (result: { ok: true } & StreamResult | { ok: false; error: unknown }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    // Our own timer, as explain's is: SIGTERM so the CLI can end its own turn,
    // and nothing after — a killed child still fires 'close', which is where
    // the reporting happens.
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
        const facts = readLine(line);
        if (facts === null) continue;
        if (facts.sessionId !== undefined) sessionId = facts.sessionId;
        if (facts.costUsd !== undefined) costUsd = facts.costUsd;
        if (facts.text === undefined) continue;
        if (firstTokenMs === null) firstTokenMs = Date.now() - started;
        if (facts.kind === 'answer') {
          if (firstAnswerMs === null) firstAnswerMs = Date.now() - started;
          answer += facts.text;
        }
        onDelta?.(facts.text, facts.kind ?? 'answer');
      }
    });

    child.on('close', (code) => {
      if (code === 0) done({ ok: true, text: answer, costUsd, sessionId, firstTokenMs, firstAnswerMs });
      else done({ ok: false, error: new Error(stderr.trim() || `claude exited with code ${code ?? 'null'}`) });
    });
  });
}

/** What one line of `--output-format stream-json` carries, of what we read. */
export interface StreamFacts {
  /** Characters the model wrote. Always paired with `kind`. */
  text?: string;
  /** Which of the two blocks those characters came out of. */
  kind?: AskDeltaKind;
  /** What the run cost, on the closing line. */
  costUsd?: number;
  /**
   * The CLI session this run is. Every line carries it, including the first,
   * which is why a conversation survives a turn that produced no words.
   */
  sessionId?: string;
}

/**
 * Read one stream line. Pure, and exported for the test beside this module:
 * this is the whole of what codemap understands about the CLI's wire format,
 * and a paid run is not the way to check it.
 *
 * Null for a line that carries none of it — the CLI writes lines that are not
 * JSON at all, and several kinds of JSON that are not an answer.
 */
export function readLine(line: string): StreamFacts | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null) return null;

  const record = event as {
    type?: unknown;
    session_id?: unknown;
    total_cost_usd?: unknown;
    event?: { type?: unknown; delta?: { type?: unknown; text?: unknown; thinking?: unknown } };
  };

  const facts: StreamFacts = {};
  if (typeof record.session_id === 'string' && record.session_id !== '') facts.sessionId = record.session_id;
  if (typeof record.total_cost_usd === 'number') facts.costUsd = record.total_cost_usd;

  if (record.type === 'stream_event' && record.event?.type === 'content_block_delta') {
    const delta = record.event.delta;
    // The two are told apart by the delta's own type, not by which field is
    // populated: a `signature_delta` rides in the same block as the thinking
    // and carries neither, and reading "whatever string is here" would put
    // its base64 into the transcript.
    const thinking = delta?.type === 'thinking_delta' ? delta.thinking : undefined;
    const answer = delta?.type === 'text_delta' ? delta.text : undefined;
    if (typeof thinking === 'string' && thinking !== '') {
      facts.text = thinking;
      facts.kind = 'thinking';
    } else if (typeof answer === 'string' && answer !== '') {
      facts.text = answer;
      facts.kind = 'answer';
    }
  }

  return Object.keys(facts).length === 0 ? null : facts;
}

/**
 * The prompt is the feature, so it is written as carefully as the code.
 * Pure, and exported for the test beside this module.
 *
 * The first turn carries the categories; a follow-up carries the question and
 * one line of reminder, because the CLI already holds everything above it and
 * re-sending it is the cost this feature exists to avoid.
 */
export function buildPrompt(request: AskRequest): string {
  if (request.context === null) {
    // A transcript drifts over a long conversation, and the rules are the part
    // worth restating: one line against the model answering about software in
    // general once the categories are ten turns behind it.
    return [
      request.question.trim(),
      '',
      '(Same rules: answer about THIS project from the categories above, plain prose,',
      'and say what the graph cannot see rather than concluding from a gap in it.)',
    ].join('\n');
  }

  return [...briefFor(request.context), '', ...contextBlock(request.context), '', 'QUESTION:', request.question.trim()].join(
    '\n',
  );
}

/**
 * What the model is for, and what it is not.
 *
 * The blind spots are stated for the reason explain's are: the graph's gaps
 * read as facts to a model that is not told about them, and the reading of
 * cobra's `Command.Execute` said "nothing depends on it" — false in sixteen
 * places — because an empty list was allowed to look like an answer. Every
 * gap named here is one this project has measured and written down.
 */
function briefFor(context: AskContext): string[] {
  return [
    `You are answering questions about the architecture of a project called "${context.project}".`,
    '',
    'WHAT YOU ARE LOOKING AT. A tool read this project\'s source and built a graph of',
    'its files, the symbols in them and the references between them. It then grouped',
    'the files into CATEGORIES: groups that lean on each other more than on anything',
    'else. Below are those categories, the files in each, the symbols in each that a',
    'file outside it reaches, and the imports between categories added up. That is',
    'everything you have. You have NOT seen the source of a single file.',
    '',
    'WHO YOU ARE WRITING FOR: the developer who works on this project. They know their',
    'own code; what they cannot see is its shape from above, which is what you have.',
    'Plain words, short sentences, ordinary terms. No markdown, no headings, no bullet',
    'lists, no code fences — prose, the way you would answer out loud.',
    '',
    'WHAT THE GRAPH CANNOT SEE. These are measured gaps, not hedges, and reasoning',
    'past them is the one thing you must not do:',
    '- A reference is tracked only when the source wrote the type down. A call through',
    '  an untyped variable, a callback, an interface value or a dynamic lookup is',
    '  invisible. So every line and every count below is a LOWER BOUND: two categories',
    '  with no line between them may still depend on each other.',
    '- Nothing that happens at run time is here. An HTTP call, a queue, a database, a',
    '  container wiring two pieces together — none of it is an import, so none of it is',
    '  a line. Two halves of a system that talk over the network look unconnected.',
    '- Test files do not vote in the grouping, so they are in no category by rule.',
    '  "Files in no category" is not a complaint about them.',
    '- A category marked "drawn by hand" came from a person, who may know something',
    '  the imports do not. It has no cohesion number because nothing measured it.',
    '- A name is a person\'s or an agent\'s word for the group, not the tool\'s. An',
    '  unnamed category means nobody has named it yet, and nothing more.',
    '',
    'RULES:',
    '- Answer about THIS project, from what is below. Never general architecture advice.',
    '- When the answer is not in what you were given, say so plainly in a clause and',
    '  say what would answer it. Never fill a gap with a plausible guess.',
    '- Do not describe what a file does. You have its path and the names of the symbols',
    '  other categories reach — that is what you may reason from, and nothing else.',
    '- You are reading, not deciding. You cannot rename a category, move a file or',
    '  change anything. If a better name occurs to you, propose it in a sentence and',
    '  say it is a suggestion.',
    '- Short. A few paragraphs at most, and fewer if the question is small.',
  ];
}

/** The categories and the lines between them, in the order the diagram lists them. */
function contextBlock(context: AskContext): string[] {
  const names = displayNames(context.categories);
  const lines: string[] = [
    `THE PROJECT: ${context.categories.length} ${plural(context.categories.length, 'category', 'categories')} over ${count(context.fileCount, 'file')}.`,
    '',
  ];

  for (const category of context.categories) {
    const name = names.get(category.id) ?? 'unnamed';
    lines.push(`--- ${name} — ${count(category.files.length, 'file')}${qualityOf(category)} ---`);
    lines.push(...listOf(category.files));
    lines.push(providesLine(category));
    lines.push('');
  }

  if (context.edges.length === 0) {
    lines.push('BETWEEN CATEGORIES: no references between any two of them were resolved.');
    return lines;
  }

  lines.push('BETWEEN CATEGORIES (the file-to-file references crossing each pair, added up):');
  for (const edge of context.edges) {
    const from = names.get(edge.from);
    const to = names.get(edge.to);
    // An edge naming a box that is not listed is a graph this cannot describe;
    // it is dropped rather than printed against an id nobody can read.
    if (from === undefined || to === undefined) continue;
    lines.push(`  ${from} ${edge.kind} ${to} (${edge.weight})`);
  }
  return lines;
}

/** "cohesion 84%", or the sentence a category with no number gets instead. */
function qualityOf(category: AskCategory): string {
  if (category.uncategorised === true) return ', in no category';
  if (category.origin === 'manual') return ', drawn by hand';
  if (category.cohesion === undefined) return '';
  return `, ${Math.round(category.cohesion * 100)}% of its references stay inside it`;
}

function providesLine(category: AskCategory): string {
  if (category.provides.length === 0) {
    return category.uncategorised === true
      ? '  reached from other categories: nothing was resolved'
      : '  reached from outside: nothing was resolved (which may mean nothing was tracked)';
  }
  const shown = category.provides
    .map((symbol) => `${symbol.owner === null ? '' : `${symbol.owner}.`}${symbol.name} (${symbol.kind}, reached from ${count(symbol.reachedFrom, 'file')})`)
    .join(', ');
  const rest = category.providesTotal - category.provides.length;
  return `  reached from outside: ${shown}${rest > 0 ? `, and ${rest} more` : ''}`;
}

function listOf(files: readonly string[]): string[] {
  const shown = files.slice(0, MAX_FILES_PER_CATEGORY).map((file) => `  ${file}`);
  const rest = files.length - MAX_FILES_PER_CATEGORY;
  if (rest > 0) shown.push(`  … and ${count(rest, 'more file')}`);
  return shown;
}

/**
 * A name for each category that a sentence can use, and that names one
 * category only.
 *
 * The box id is `component:src/graph/store.ts~8` and no answer should contain
 * that; the label is "8 files together", which two unnamed categories can both
 * be. So an unnamed one is named for where it starts, and a collision after
 * that is numbered — an answer that says "the group around src/lang" is worth
 * more than one that says "category 3".
 *
 * Pure, and exported for the test beside this module.
 */
export function displayNames(categories: readonly AskCategory[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Map<string, number>();

  for (const category of categories) {
    const base =
      category.name !== null && category.name.trim() !== ''
        ? category.name.trim()
        : category.uncategorised === true
          ? 'files in no category'
          : `the unnamed group around ${category.files[0] ?? 'nothing'}`;

    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    names.set(category.id, seen === 0 ? base : `${base} (${seen + 1})`);
  }

  return names;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

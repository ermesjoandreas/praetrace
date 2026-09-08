import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';

import type { EdgeKind, NodeKind } from '../graph/types.js';
import {
  failureOf,
  looksLikeAuth,
  MAX_OUTPUT_BYTES,
  parseJsonish,
  resolveClaude,
  type CliResult,
} from './explain.js';

const execFileAsync = promisify(execFile);

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


// --- Proposing a grouping -------------------------------------------------

/**
 * One file that may be grouped, and the category that already holds it.
 *
 * The mark rides on the file rather than in a block of its own because that
 * is how a person reads it: down the list of paths, seeing which are spoken
 * for. It also keeps a 254-file category from being printed twice.
 */
export interface ProposeFile {
  path: string;
  /** The accepted category holding it, or null while nothing does. */
  category: string | null;
}

/**
 * One directed reference between two files, summed. `view/cluster.ts`'s
 * `FileLink`, restated here for the reason `AskCategory` restates
 * `ComponentFacts`: this module does not depend on `view/`.
 */
export interface ProposeLink {
  from: string;
  to: string;
  weight: number;
}

/**
 * Everything the model is sent when it is asked to propose a grouping, and
 * the whole of it.
 *
 * **This is not `AskContext`, and that is the point of it.** `AskContext` is
 * the component diagram — the categories, what they provide, the lines
 * between them — and a project with no categories has *nothing* in it. That
 * project is the one this feature exists for. So what is sent instead is the
 * level underneath: every file that may be grouped, and every reference
 * between two of them. It is what a person would need to group the project by
 * hand, and nothing else: no source, no symbols, no coverage, no git.
 *
 * Measured on three real projects — 9, 119 and 305 groupable files, with 18,
 * 355 and 1 092 references — that is 3.9 KB, 22.8 KB and 91 KB of prompt. See
 * `tooBigToPropose` for the project this cannot be done for at all.
 */
export interface ProposeContext {
  /** The project's directory name. The only thing said about it that is not a fact of the graph. */
  project: string;
  /** Every file that may be grouped: the graph's files, tests left out. */
  files: ProposeFile[];
  links: ProposeLink[];
  /**
   * The categories that already exist, by name and size, so the model proposes
   * something new rather than restating what a person already accepted.
   */
  existing: { name: string; files: number; origin?: 'manual' }[];
  /** Every file the graph holds, tests included, so the list can be read as a share. */
  fileCount: number;
  /**
   * Every path the graph holds, tests included. Only `files` is sent to the
   * model; this is what tells a path the project does not have from one it has
   * and did not offer. Without it a test file the model named was reported as
   * invented while `evidenceFor`, which reads the whole graph, listed it as a
   * member — the same path called two different things on one screen.
   */
  allPaths: readonly string[];
  /** How many of them are tests, so "where are the rest" has an answer. */
  testCount: number;
}

/**
 * One grouping the model proposed. Text on a screen and nothing else: it is
 * carried to the page beside evidence *we* computed, and it reaches
 * `.codemap/groups.json` only when a person presses accept — as a group with
 * `origin: 'manual'`, because the person pressing is the person drawing it.
 * Decision 5 is not bent by this; a model still never decides who belongs.
 */
export interface ProposedGroup {
  name: string;
  /** One sentence: what this group is. */
  sentence: string;
  /** The members, every one a path that was in the context. */
  files: string[];
  /**
   * Paths the answer named that the project has no file for. Kept and shown
   * rather than dropped in silence — a proposal that invents paths is one to
   * distrust, and a reader shown only what landed cannot see that.
   */
  invented: string[];
}

export type ProposeFailure = AskFailure | 'too-big';

export type ProposeOutcome =
  | {
      ok: true;
      groups: ProposedGroup[];
      /** The model's own sentence about why the grouping was hard, when it wrote one. */
      note: string | null;
      /** Proposals that named too few real files to be worth judging. */
      dropped: number;
      costUsd: number;
      ms: number;
    }
  | { ok: false; reason: ProposeFailure; detail: string };

/**
 * How much of a project one prompt may hold.
 *
 * A refusal with a reason beats a proposal drawn from a tenth of the graph:
 * a grouping is only true if it was made from all of the coupling, and a
 * model handed the first 600 files of 3 000 would confidently group them and
 * say nothing about the 2 400 it never saw. That is the authoritative-looking
 * wrong answer this project exists not to give.
 *
 * The numbers are the measured ones with room above them: this repository is
 * 119 files and 355 references, astrupdata 305 and 1 092. Six hundred files
 * and three thousand references is about 250 KB of prompt, which is still one
 * argv and about 60 000 tokens — expensive but honest. Above it, the answer
 * is no.
 */
const MAX_PROPOSE_FILES = 600;
const MAX_PROPOSE_LINKS = 3000;

/**
 * At most this many proposals. A model asked for a grouping and answering
 * with thirty has not grouped anything, and the page would ask a person to
 * read thirty. Twelve is past every real answer measured.
 */
const MAX_PROPOSED_GROUPS = 12;

/**
 * Below this a proposal is not a group. The same three the clustering uses
 * (`MIN_SIZE` in `view/cluster.ts`): two files that touch are two files that
 * touch.
 */
const MIN_PROPOSED_FILES = 3;

/**
 * One run, one answer, and a prompt far larger than suggest's — but the wait
 * is the model reading, not the prompt arriving: measured with haiku, a
 * nine-file project took 91 seconds, a 119-file one 126, and a 305-file one
 * 112, at $0.10 to $0.15 a run. Size barely moves it. This is generous
 * against the longest of those, and the caller does not wait on it either
 * way: the route answers 202 and the panel polls.
 */
const PROPOSE_TIMEOUT_MS = 300_000;

/**
 * The shape the CLI holds the model to. `--json-schema` makes "the model
 * answered in prose" impossible; what it cannot make impossible is an invented
 * path, which is why `readProposal` checks every one against what was sent.
 *
 * Kept where `ask()` gave it up: a proposal is a list to act on rather than
 * prose to read, and nobody watches a list stream in.
 */
const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          sentence: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'sentence', 'files'],
        additionalProperties: false,
      },
    },
    note: { type: 'string' },
  },
  required: ['groups'],
  additionalProperties: false,
};

/**
 * Why this project cannot be proposed for, or null when it can.
 *
 * Exported because the route has to refuse *before* it spends anything, and
 * `propose` checks it again so the rule has one home. The sentence names both
 * numbers, because both are on the person's own status bar.
 */
export function tooBigToPropose(context: ProposeContext): string | null {
  if (context.files.length > MAX_PROPOSE_FILES) {
    return `this project has ${count(context.files.length, 'file')} to group, and a grouping proposed from part of a project is a guess dressed as a reading. The limit is ${MAX_PROPOSE_FILES}`;
  }
  if (context.links.length > MAX_PROPOSE_LINKS) {
    return `this project has ${count(context.links.length, 'reference')} between its files, and a grouping proposed from part of them is a guess dressed as a reading. The limit is ${MAX_PROPOSE_LINKS}`;
  }
  return null;
}

/**
 * Ask Claude how this project divides.
 *
 * The invocation is `explain()`'s, and every flag's reason is written above
 * it: a neutral cwd, `--strict-mcp-config`, `--setting-sources ''`,
 * `--allowed-tools ''`. Two things differ from `ask()` above, and both follow
 * from a proposal being a list rather than a conversation: `--json-schema` is
 * kept, and there is nothing to resume, so `--no-session-persistence` is
 * passed as suggest passes it.
 *
 * **Never throws and never rejects**, the rule `explain()`, `suggest()` and
 * `ask()` all follow. And it decides nothing: what comes back is measured by
 * `view/cluster.ts` against the real imports before a person sees it, and
 * accepted only by a press.
 */
export async function propose(
  context: ProposeContext,
  options: { timeoutMs?: number } = {},
): Promise<ProposeOutcome> {
  const refusal = tooBigToPropose(context);
  if (refusal !== null) return { ok: false, reason: 'too-big', detail: refusal };

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
        buildProposePrompt(context),
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(PROPOSAL_SCHEMA),
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
        timeout: options.timeoutMs ?? PROPOSE_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      },
    );
    // The CLI waits three seconds for a stdin that nobody will write to.
    // suggest closes it for the same reason.
    pending.child.stdin?.end();
    stdout = (await pending).stdout;
  } catch (error) {
    // A non-zero exit still carries the envelope, and an auth failure is only
    // told apart from any other by what is in it. Never the error's own
    // message: execFile's is the whole command line, this prompt included.
    const printed = stdoutOf(error);
    if (printed !== null) return readProposal(printed, context, Date.now() - started);
    return failureOf(withoutCommandLine(error), binary.looked);
  }

  return readProposal(stdout, context, Date.now() - started);
}

/** The envelope a failed exit printed, when it printed one. */
function stdoutOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { stdout } = error as { stdout?: unknown };
  return typeof stdout === 'string' && stdout.trim().startsWith('{') ? stdout : null;
}

/**
 * The same error with execFile's message — the command line, which here is a
 * quarter of a megabyte of prompt — replaced by something a person can act on.
 */
function withoutCommandLine(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return error;
  const { stderr, code } = error as { stderr?: unknown; code?: unknown };
  if (typeof stderr === 'string' && stderr.trim() !== '') return error;
  return {
    ...error,
    message: typeof code === 'number' ? `claude exited with code ${code}` : 'claude failed without saying why',
  };
}

/**
 * The prompt is the feature, so it is written as carefully as the code.
 * Pure, and exported for the test beside this module.
 *
 * The blind spots are stated for the reason explain's and ask's are: a gap in
 * the graph reads as a fact to a model that is not told about it, and a
 * grouping is exactly the place where an unseen edge changes the answer — two
 * halves of a system that talk over HTTP look like two independent pieces of
 * architecture, and they are not.
 */
export function buildProposePrompt(context: ProposeContext): string {
  return [
    `You are proposing a grouping for a project called "${context.project}", which you have`,
    'not seen before.',
    '',
    'WHAT YOU ARE LOOKING AT. A tool read this project\'s source and built a graph of its',
    'files and the references between them. Below is every file that can be grouped, and',
    'every reference between two of them added up per pair. That is everything you have.',
    'You have NOT seen the source of a single file.',
    '',
    'WHAT YOU ARE FOR. Propose groups of files that belong together — the pieces a',
    'developer would name if they drew this project\'s architecture on a whiteboard. Two',
    'to eight groups, each at least three files. Not every file has to be in one: a file',
    'that belongs nowhere is a better answer than a group that is not true.',
    '',
    'WHAT THE GRAPH CANNOT SEE. These are measured gaps, not hedges, and reasoning past',
    'them is the one thing you must not do:',
    '- A reference is tracked only when the source wrote the type down. A call through an',
    '  untyped variable, a callback, an interface value or a dynamic lookup is invisible.',
    '  So every count below is a LOWER BOUND: two files with no reference between them may',
    '  still depend on each other.',
    '- Nothing that happens at run time is here. An HTTP call, a queue, a database, a',
    '  container wiring two pieces together — none of it is a reference, so none of it is',
    '  below. Two halves of a system that talk over the network look unconnected, and a',
    '  project written in two languages looks like two projects.',
    '- Test files are left out of the list entirely. They do not vote in a grouping: a',
    '  suite imports everything it exercises, which is the opposite of belonging.',
    '',
    'RULES:',
    '- Every path in a group must be copied verbatim from the list below. Never invent',
    '  one, never shorten one, never name a directory instead of a file.',
    '- A file belongs to at most one group.',
    '- Never pad a group to reach three files. Measured: told each group needs three,',
    '  this model put a file with no references at all into one "to meet the three-file',
    '  minimum". Drop the group instead — a file that belongs nowhere is a real answer.',
    '- Name what the group does, not where it lives: "Parsing", never "Files in',
    '  src/parser". Two or three words, the kind a developer uses in conversation.',
    '- One sentence each, saying what the group is and what argued for it — the paths and',
    '  the references you were given, never what you imagine the code does.',
    '- Put NO counts anywhere you write — not in a sentence, not in the note. Measured:',
    '  asked for one, this model wrote "94 references among 21 files" where the graph',
    '  holds 57 pairs, and "288 of 305 files already belong to a category" where 254 do.',
    '  The real counts are printed beside your words, and two numbers disagreeing on one',
    '  screen is worse than one number.',
    '- A category that already exists is marked after the path. Do not hand one of those',
    '  back as a proposal. But a marked file is not a finished one, and this is the',
    '  mistake to avoid: a category holding most of the project says nobody has divided',
    '  it yet, not that it is divided. Proposing the pieces INSIDE a large category, or a',
    '  group that cuts across two, is the useful answer — measured, a project whose one',
    '  accepted category held 254 of its 305 files got a single proposal about the five',
    '  it did not, which was the least useful true thing that could have been said.',
    '- The person reading this will be shown the real cohesion of every group you propose,',
    '  counted from the references below, before they accept anything. So do not claim a',
    '  group is tight or well separated: propose it, and let the number say.',
    '- If this project does not divide — one tangle, or too little here to tell — say so',
    '  in "note" and propose fewer groups, or none at all. That is a real answer.',
    '',
    ...contextOf(context),
  ].join('\n');
}

/** The project, its categories, its files and its references. */
function contextOf(context: ProposeContext): string[] {
  const tests =
    context.testCount === 0 ? '' : ` (${context.testCount} of its ${context.fileCount} files are tests and are left out)`;
  const lines = [
    `THE PROJECT: ${count(context.files.length, 'file')} to group${tests}, with ${count(context.links.length, 'reference')} between them.`,
    '',
    'CATEGORIES THAT ALREADY EXIST:',
  ];

  if (context.existing.length === 0) {
    // The case this feature was built for, and it is said plainly rather than
    // left as an empty heading the model has to interpret.
    lines.push('  (none — nobody has grouped this project yet)');
  } else {
    for (const category of context.existing) {
      const drawn = category.origin === 'manual' ? ', drawn by hand' : '';
      lines.push(`  "${category.name}" (${count(category.files, 'file')}${drawn})`);
    }
  }

  lines.push('', 'FILES:');
  for (const file of context.files) {
    lines.push(`  ${file.path}${file.category === null ? '' : `  [${file.category}]`}`);
  }

  lines.push('', 'REFERENCES (which file reaches which, and how many times):');
  if (context.links.length === 0) {
    lines.push('  (none were resolved — see the blind spots above before reading anything into that)');
  } else {
    for (const link of context.links) lines.push(`  ${link.from} -> ${link.to} (${link.weight})`);
  }
  return lines;
}

/**
 * The CLI's envelope, then the model's answer inside it — in
 * `structured_output`, which is where `--json-schema` puts it; `result` holds
 * only a closing remark. Pure, and exported for the test beside this module.
 *
 * Every path is checked against what was sent. That check is the whole of what
 * keeps a proposal honest at this end: the schema can force a list of strings
 * and cannot force them to be files of this project.
 */
export function readProposal(stdout: string, context: ProposeContext, ms: number): ProposeOutcome {
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
    // The CLI's own name for "the model would not produce the shape asked
    // for", which is 'unreadable' rather than a failure of the run.
    if (subtype.includes('structured_output')) return { ok: false, reason: 'unreadable', detail: subtype };
    return looksLikeAuth(text)
      ? { ok: false, reason: 'auth', detail: text }
      : { ok: false, reason: 'failed', detail: text || 'claude reported an error' };
  }

  const answer = parseProposals(envelope.structured_output ?? envelope.result);
  if (answer === null) {
    const shown = (text.trim() === '' ? stdout : text).trim().slice(0, 400);
    return { ok: false, reason: 'unreadable', detail: `no answer could be read out of: ${shown}` };
  }

  const known = new Set(context.files.map((file) => file.path));
  const inProject = new Set(context.allPaths);
  const groups: ProposedGroup[] = [];
  let dropped = 0;
  for (const raw of answer.groups) {
    const files: string[] = [];
    const invented: string[] = [];
    const seen = new Set<string>();
    for (const path of raw.files) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (known.has(path)) {
        files.push(path);
        continue;
      }
      // A test the model reached for is real, and it is not a member: tests do
      // not vote in the clustering and were never offered. Dropped without a
      // word, because "invented" would be false about a file that exists.
      if (!inProject.has(path)) invented.push(path);
    }
    // Too small to be a group once the paths that are not files are gone.
    // Counted rather than hidden: "it proposed four and two were nonsense" is
    // a thing about the run a person should be able to see.
    if (files.length < MIN_PROPOSED_FILES) {
      dropped += 1;
      continue;
    }
    groups.push({ name: raw.name, sentence: raw.sentence, files, invented });
    if (groups.length === MAX_PROPOSED_GROUPS) break;
  }

  const cost = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0;
  return { ok: true, groups, note: answer.note, dropped, costUsd: cost, ms };
}

/**
 * `--json-schema` should make the wrapped object the only shape that ever
 * arrives. The rest is here because a model that ignores the shape must
 * degrade into 'unreadable' or a partial answer, never into a crash.
 */
function parseProposals(result: unknown): { groups: { name: string; sentence: string; files: string[] }[]; note: string | null } | null {
  const value = typeof result === 'string' ? parseJsonish(result) : result;
  if (typeof value !== 'object' || value === null) return null;

  const wrapped = (value as { groups?: unknown }).groups;
  const list = Array.isArray(wrapped) ? wrapped : Array.isArray(value) ? value : null;
  if (list === null) return null;

  const groups: { name: string; sentence: string; files: string[] }[] = [];
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, sentence, files } = entry as { name?: unknown; sentence?: unknown; files?: unknown };
    // A blank name is not a proposal, whatever the sentence beside it says.
    if (typeof name !== 'string' || name.trim() === '' || !Array.isArray(files)) continue;
    groups.push({
      name: name.trim(),
      sentence: typeof sentence === 'string' ? sentence.trim() : '',
      files: files.filter((file): file is string => typeof file === 'string'),
    });
  }

  const note = (value as { note?: unknown }).note;
  return { groups, note: typeof note === 'string' && note.trim() !== '' ? note.trim() : null };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

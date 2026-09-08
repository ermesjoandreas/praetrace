import type {
  AskConversation,
  AskDeltaKind,
  AskFailure,
  AskState,
  AskTurn,
  Proposal,
  ProposeFailure,
  ProposeRun,
} from './api';

/**
 * The rules behind the two things the Ask panel does: the conversation about
 * the categories — what a transcript is, how the words arriving on the socket
 * are added to it, and when the question box will not send — and the sentences
 * a proposed grouping is read by. Pure, and apart from `Ask.tsx` so it runs
 * under `node --test` the way `listrows.ts` does beside `ListView.tsx` — a
 * `.tsx` file cannot.
 *
 * Nothing here decides anything about the project. An answer is text on a
 * screen: no name is written, no file joins a category, and nothing in this
 * module can reach `groups.json`. That is decisions 4 and 5, and it is why
 * this file holds no writer of any kind. A *proposed* grouping is the same
 * thing — text, with numbers this project computed beside it — until a person
 * presses accept, and that press is the create `Categories.tsx` already makes,
 * which stores the group as one a person drew.
 *
 * The one thing below that is not a function is the socket bridge at the
 * bottom, and the reason it is here rather than threaded through props is
 * named there.
 */

/**
 * Where `server/ask.ts` caps a question, spelled again so the box can say so
 * before the press rather than turning a typed paragraph into a 400.
 */
export const MAX_QUESTION = 2000;

/**
 * What a press stands to cost, before there is a real number to show instead.
 *
 * Measured, not guessed: the engine's own runs on this repository's eleven
 * categories were $0.0257 for a first question and $0.0112 for a follow-up,
 * which is the whole point of resuming the CLI session — the categories are
 * sent once. It scales with how many categories a project has, so it is "about"
 * and is replaced by what the last answer actually cost the moment there is one.
 */
export const FIRST_QUESTION_USD = 0.03;
export const FOLLOW_UP_USD = 0.01;

/** What a failed turn is called. The detail beside it is the fixable half. */
export const FAILURE_WORDS: Record<AskFailure, string> = {
  missing: 'The Claude CLI was not found.',
  auth: 'Claude is not logged in.',
  timeout: 'It took too long and was given up on.',
  failed: 'The run failed.',
  unreadable: 'The answer came back in a shape this could not read.',
};

/**
 * The two frames the server puts on the socket for a conversation. `live.ts`
 * sends both to every client, so a run another tab started arrives here too.
 */
export type AskFrame =
  | { type: 'ask'; conversation: AskConversation }
  | { type: 'ask-delta'; conversationId: string; text: string; kind: AskDeltaKind };

/**
 * A few characters, added to the turn being written.
 *
 * Returns the conversation it was given, unchanged and by identity, whenever
 * the delta belongs to something else — another conversation, or a turn that
 * has already ended — so React can skip the render rather than redraw the
 * transcript for a frame that changed nothing.
 *
 * Thinking and answer are kept apart because they are different things. The
 * thinking is the model working; drawing it as the reply would be showing a
 * reader something that is not what it says it is, which is the one thing this
 * project does not do. See `AskDeltaKind` in `src/project/ask.ts`.
 */
export function applyDelta(
  held: AskConversation | null,
  frame: { conversationId: string; text: string; kind: AskDeltaKind },
): AskConversation | null {
  if (held === null || held.id !== frame.conversationId) return held;
  const last = held.turns.at(-1);
  if (last === undefined || last.state !== 'running') return held;

  const turn: AskTurn =
    frame.kind === 'answer'
      ? { ...last, answer: last.answer + frame.text }
      : { ...last, thinking: (last.thinking ?? '') + frame.text };
  return { ...held, turns: [...held.turns.slice(0, -1), turn] };
}

/**
 * The server's copy of the conversation, laid over the one on screen.
 *
 * Two things make this more than "take the newer one". The socket is faster
 * than the fetch that answered 202, so the reply to a press can carry a turn
 * with an empty answer while several deltas have already landed — replacing
 * wholesale would blank the words and then fill them in again. And a poll that
 * was already in flight when the press went out comes back describing the
 * conversation as it was one turn ago.
 *
 * So: a turn that has ended is the CLI's own copy of what it said and always
 * wins, a running one keeps whichever text is longer, and neither side's turns
 * are dropped for being absent from the other. The result is returned by
 * identity when nothing observable moved, which is what keeps a poll every
 * three seconds from redrawing a transcript nobody is changing.
 */
export function mergeConversation(
  held: AskConversation | null,
  incoming: AskConversation | null,
): AskConversation | null {
  // The server has no conversation: it was ended, or the project switched and
  // took the session with it. Either way what is on screen is about something
  // that is no longer open.
  if (incoming === null) return null;
  if (held === null || held.id !== incoming.id) return incoming;

  const length = Math.max(held.turns.length, incoming.turns.length);
  const turns: AskTurn[] = [];
  for (let index = 0; index < length; index += 1) {
    const mine = held.turns[index];
    const theirs = incoming.turns[index];
    if (theirs === undefined) {
      turns.push(mine as AskTurn);
      continue;
    }
    if (mine === undefined || mine.at !== theirs.at || theirs.state !== 'running') {
      turns.push(theirs);
      continue;
    }
    const thinking = longer(theirs.thinking ?? '', mine.thinking ?? '');
    turns.push({
      ...theirs,
      answer: longer(theirs.answer, mine.answer),
      ...(thinking === '' ? {} : { thinking }),
    });
  }

  const merged: AskConversation = {
    ...incoming,
    sessionId: incoming.sessionId ?? held.sessionId,
    // A total only grows, so a stale answer cannot lower it.
    costUsd: Math.max(incoming.costUsd, held.costUsd),
    turns,
  };
  return same(held, merged) ? held : merged;
}

function longer(a: string, b: string): string {
  return a.length >= b.length ? a : b;
}

/** Everything a reader would see. Used for identity, never for correctness. */
function same(a: AskConversation, b: AskConversation): boolean {
  if (a.id !== b.id || a.sessionId !== b.sessionId || a.costUsd !== b.costUsd) return false;
  if (a.turns.length !== b.turns.length) return false;
  return a.turns.every((turn, index) => {
    const other = b.turns[index] as AskTurn;
    return (
      turn.at === other.at &&
      turn.state === other.state &&
      turn.answer === other.answer &&
      (turn.thinking ?? '') === (other.thinking ?? '') &&
      turn.costUsd === other.costUsd &&
      turn.reason === other.reason
    );
  });
}

/**
 * Everything the panel holds about the conversation, and the one function that
 * moves it.
 *
 * A reducer rather than three `useState` calls because the three moves are not
 * independent: a delta belongs to the turn the server's last answer put there,
 * and a conversation going away means one thing when the page ended it and
 * another when the project switched underneath it. Written here so it can be
 * run in a test rather than only in a browser.
 */
export interface AskView {
  conversation: AskConversation | null;
  running: boolean;
  /**
   * Why there is no conversation, when there was one a moment ago. `switched`
   * is the honest half: the session's conversation was about the project that
   * was open, and answering a follow-up against another project's categories
   * is exactly the confidently wrong answer this tool exists not to give.
   */
  gone: 'ended' | 'switched' | null;
}

export type AskAction =
  /**
   * What the server says the conversation is — from the fetch, the poll, or an
   * `ask` frame. Only those two fields: a proposal is not part of the
   * conversation, arrives on no frame, and is held beside this.
   */
  | { kind: 'server'; state: Pick<AskState, 'conversation' | 'running'> }
  /** A few characters, from an `ask-delta` frame. */
  | { kind: 'delta'; frame: { conversationId: string; text: string; kind: AskDeltaKind } }
  /** This page pressed End. Told apart from a switch because only the page knows. */
  | { kind: 'ended' };

export const NO_CONVERSATION: AskView = { conversation: null, running: false, gone: null };

export function reduceAsk(view: AskView, action: AskAction): AskView {
  if (action.kind === 'ended') return { conversation: null, running: false, gone: 'ended' };

  if (action.kind === 'delta') {
    const conversation = applyDelta(view.conversation, action.frame);
    return conversation === view.conversation ? view : { ...view, conversation };
  }

  const conversation = mergeConversation(view.conversation, action.state.conversation);
  const gone: AskView['gone'] =
    conversation !== null
      ? null
      : view.conversation !== null
        ? // It was on screen and the session no longer has it, and this page
          // did not end it — the only other way is a project switch, which
          // closes the session the conversation lived in.
          'switched'
        : view.gone;
  if (conversation === view.conversation && action.state.running === view.running && gone === view.gone) {
    return view;
  }
  return { conversation, running: action.state.running, gone };
}

/**
 * Why the press would do nothing, in words, or null when it would run.
 *
 * One answer, so the button's disabled state and the sentence it wears in its
 * tooltip can never disagree about whether the user is about to spend money.
 */
export function askBlocked(state: {
  question: string;
  /** A turn is being written right now — this page's, or another tab's. */
  running: boolean;
  /** The press has gone out and the server has not answered it yet. */
  sending: boolean;
  /** How many categories there are to ask about. The server refuses a project with none. */
  categories: number;
}): string | null {
  if (state.sending || state.running) return 'An answer is still being written. It arrives here as it is typed.';
  if (state.categories === 0) return 'There are no categories yet to ask about.';
  const question = state.question.trim();
  if (question === '') return 'Type a question first.';
  if (question.length > MAX_QUESTION) {
    return `A question is at most ${MAX_QUESTION} characters, and this one is ${question.length}.`;
  }
  return null;
}

/**
 * Whether the thinking is the thing to draw for this turn.
 *
 * Only while nothing of the answer has arrived. Measured by the engine, the
 * first thinking lands at 1.4–2.4 s and the first word of the answer at 6–22 s,
 * so without this the panel sits empty for up to twenty seconds and the feature
 * reads as hung. The moment the answer starts, the answer is what is wanted and
 * the working notes step aside — which is also what the server does with them
 * when the turn ends, so this is the earlier of two jumps rather than a third.
 */
export function showThinking(turn: AskTurn): boolean {
  return turn.state === 'running' && turn.answer === '' && (turn.thinking ?? '') !== '';
}

/** What the last answer actually cost, or null before one has arrived. */
export function lastCost(conversation: AskConversation | null): number | null {
  const turns = conversation?.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] as AskTurn;
    if (turn.state === 'done' && turn.costUsd !== undefined) return turn.costUsd;
  }
  return null;
}

/**
 * A duration for a person: one decimal under ten seconds, whole above.
 *
 * The small numbers are the ones that matter here — "first words in 1.9 s" is
 * the whole difference between this feeling fast and feeling hung — and
 * rounding that to "2 s" throws away the half of the measurement a reader
 * would actually check.
 */
export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/**
 * How the CLI's own numbers read under an answer, or null when the turn
 * carried none. `firstTokenMs` is there because it is what a person
 * experienced, and `ms` because it is what they paid for.
 */
export function timingNote(turn: AskTurn): string | null {
  if (turn.ms === undefined) return null;
  const first = turn.firstTokenMs === undefined ? '' : `first words in ${seconds(turn.firstTokenMs)}, `;
  return `${first}${seconds(turn.ms)} in all`;
}

/* --- proposing a grouping ---------------------------------------------------
 *
 * The other half of the panel, and a different job from the question above it:
 * a question is answered from the categories that *exist*, and a project with
 * none has nothing to talk about — which is the project this exists for. The
 * model is sent the files and the imports between them and answers with
 * groupings; every number a reader judges one by is computed here from the
 * graph, in `view/cluster.ts`, and never taken from what the model said.
 */

/**
 * What one proposal run stands to cost, before there is a real number.
 *
 * Measured with haiku, and across four projects it barely moves with size:
 * $0.040 and 37 s for a nine-file one driven through this panel, and the
 * engine's own $0.06 to $0.15 at 78 to 126 seconds for that one, this
 * repository at 119 files and astrupdata at 305. So one number rather than a
 * curve, and the top of the range rather than the middle: a press that costs
 * less than it said is the harmless direction to be wrong in.
 */
export const PROPOSE_USD = 0.12;

/** What a failed run is called. `too-big` is the refusal that costs nothing. */
export const PROPOSE_FAILURE_WORDS: Record<ProposeFailure, string> = {
  ...FAILURE_WORDS,
  'too-big': 'This project is too big to propose a grouping for in one prompt.',
};

/**
 * Why the press would do nothing, in words, or null when it would run.
 *
 * **Not gated on there being categories**, which is the one thing that would
 * be wrong here: `askBlocked` refuses a project with none because a question
 * about nothing is a question about nothing, and a project with none is
 * exactly what this button is for. The server's own two refusals — a project
 * with no files, and one too big for a single prompt — are 400s carrying a
 * sentence, and that sentence is printed rather than guessed at here.
 */
export function proposeBlocked(state: {
  /** A run is in flight — this page's, or another tab's. */
  proposing: boolean;
  /** The press has gone out and the server has not answered it yet. */
  sending: boolean;
  /** Files in the graph. None is the server's own refusal, said before the press. */
  fileCount: number;
}): string | null {
  if (state.sending || state.proposing) return 'A grouping is already being proposed.';
  if (state.fileCount === 0) return 'There are no files here to group.';
  return null;
}

/**
 * The cohesion of a proposed set, as the two counts it is a ratio of.
 *
 * The percentage alone is the number a model would have made up; the counts
 * are what make it checkable, and they are what say how much there was to
 * measure — "1 of 2" and "31 of 44" are both high and only one of them means
 * anything. A set the graph found no reference at either end of gets a
 * sentence instead of "0%", which would read as a measurement rather than as
 * an absence.
 */
export function cohesionNote(evidence: Proposal['evidence']): string {
  const total = evidence.inside + evidence.leaving;
  if (total === 0) return 'No imports or calls at either end of these files';
  const share = Math.round(evidence.cohesion * 100);
  return `${evidence.inside} of ${total} references stay inside (${share}%)`;
}

/**
 * A third of the references staying inside — `MIN_COHESION` in
 * `view/cluster.ts`, the cut the clustering itself uses. Below it the graph
 * would not have offered these files as a group, and the page says so beside
 * the number rather than leaving a reader to do the arithmetic.
 *
 * It does not stop the accept, and must not: a person may know something the
 * imports do not, which is decision 5's own carve-out. What this buys is that
 * they are told first.
 */
export function weakCohesion(evidence: Proposal['evidence']): boolean {
  return evidence.cohesion < 1 / 3;
}

/**
 * What this proposal does to the categories that already exist.
 *
 * Covering files nobody has claimed is a different act from re-cutting a
 * category a person accepted, and a reader has to be able to tell which
 * before they press. The overlap is counted by the server against the
 * accepted groups, never by the model.
 */
export function overlapNote(proposal: Proposal): string {
  const total = proposal.files.length;
  if (proposal.overlaps.length === 0) {
    return total === 0 ? 'No file here is one this project holds' : 'Covers files no category holds';
  }
  const named = proposal.overlaps
    .slice(0, 3)
    .map((overlap) => `${overlap.name} ${overlap.shared}/${overlap.size}`)
    .join(', ');
  const rest = proposal.overlaps.length > 3 ? `, and ${proposal.overlaps.length - 3} more` : '';
  const free =
    proposal.unclaimed === 0
      ? ''
      : ` · ${proposal.unclaimed} of ${total} ${proposal.unclaimed === 1 ? 'file is' : 'files are'} in no category`;
  return `Re-cuts ${named}${rest}${free}`;
}

/** Who reaches into the set and what it reaches, or null when it stands alone. */
export function reachNote(evidence: Proposal['evidence']): string | null {
  const into = evidence.reachedFrom.length;
  const out = evidence.reaches.length;
  if (into === 0 && out === 0) return null;
  return `${into} ${into === 1 ? 'file reaches' : 'files reach'} in, ${out} reached out to`;
}

/**
 * The paths the model named that this project has no file for.
 *
 * Two lists say it — `invented`, checked against what was sent, and the
 * evidence's `unknown`, checked against the graph — and they are unioned
 * rather than one being picked, because a path missing from either is a path
 * that is not there. Never hidden: a proposal that invents files is a
 * proposal to distrust, and a reader shown only what landed cannot see that.
 */
export function inventedPaths(proposal: Proposal): string[] {
  return [...new Set([...proposal.invented, ...proposal.evidence.unknown])].sort();
}

/**
 * What the panel says while a run is happening, or about one that failed —
 * and null when the proposals themselves are the answer.
 *
 * A proposal does not stream. The answer is a schema, so there is nothing to
 * watch arrive, and a still panel for a minute and a half reads as hung
 * unless it says what it is doing and what it is reading.
 */
export function proposeStatus(run: ProposeRun | null): string | null {
  if (run === null) return null;
  if (run.state === 'running') {
    return `Reading ${run.sent.files} ${run.sent.files === 1 ? 'file' : 'files'} and ${run.sent.links} references. This takes a minute or two, and nothing appears until it is done.`;
  }
  if (run.state === 'failed') {
    const words = PROPOSE_FAILURE_WORDS[run.reason ?? 'failed'];
    return run.detail === undefined || run.detail === '' ? words : `${words} ${run.detail}`;
  }
  return null;
}

/**
 * Whether two readings of the run describe the same thing.
 *
 * The poll re-parses the run every three seconds, so without this the
 * proposals and every file row under them re-render on a timer while nobody
 * is changing anything. A run only ever moves from running to done or failed,
 * and only then gains its proposals, so those three fields are the whole of
 * what a reader could see change.
 */
export function sameRun(a: ProposeRun | null, b: ProposeRun | null): boolean {
  if (a === null || b === null) return a === b;
  return a.at === b.at && a.state === b.state && a.proposals.length === b.proposals.length;
}

/**
 * The line under a finished run: how many groupings, out of how much project,
 * and what was thrown away before a person saw it.
 *
 * `dropped` is on the face of it rather than in a tooltip because it is the
 * one number that says the answer was not entirely usable.
 */
export function proposeSummary(run: ProposeRun): string {
  const count = run.proposals.length;
  const head =
    count === 0
      ? 'No grouping proposed'
      : `${count} ${count === 1 ? 'grouping' : 'groupings'} from ${run.sent.files} files`;
  const dropped = run.dropped === 0 ? '' : ` · ${run.dropped} dropped for naming too few real files`;
  return `${head}${dropped}`;
}

/**
 * The socket's frames, handed from where the socket is opened to where the
 * conversation is drawn.
 *
 * `App.tsx` owns the one websocket, and this panel is four components below
 * it. Threading a frame down as a prop is how the rest of the page does it,
 * and it is what this deliberately does not do: the streaming *is* the
 * feature — the first characters land in about two seconds and the answer
 * itself can be twenty behind — so the panel has to be able to draw a delta
 * without the whole page re-rendering for each one, and the wiring has to be
 * three lines in a file another piece of work owns rather than a state tree
 * threaded through two components.
 *
 * A registry rather than a store: nothing is remembered here, so a listener
 * that is gone simply stops being called, and the transcript's one home stays
 * the panel's own state.
 */
const listeners = new Set<(frame: AskFrame) => void>();

/** Called from the socket's `onmessage`, for the two ask frames and nothing else. */
export function publishAsk(frame: AskFrame): void {
  for (const listener of listeners) listener(frame);
}

/** Listen until the returned function is called. Panels mount and unmount; this must not leak. */
export function subscribeAsk(listener: (frame: AskFrame) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

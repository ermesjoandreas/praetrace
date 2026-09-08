import type { AskConversation, AskDeltaKind, AskFailure, AskState, AskTurn } from './api';

/**
 * The rules behind the conversation about the categories: what a transcript
 * is, how the words arriving on the socket are added to it, and when the
 * question box will not send. Pure, and apart from `Ask.tsx` so it runs under
 * `node --test` the way `listrows.ts` does beside `ListView.tsx` — a `.tsx`
 * file cannot.
 *
 * Nothing here decides anything about the project. The conversation is text on
 * a screen: no name is written, no file joins a category, and nothing in this
 * module can reach `groups.json`. That is decisions 4 and 5, and it is why
 * this file holds no writer of any kind.
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
  /** What the server says the conversation is — from the fetch, the poll, or an `ask` frame. */
  | { kind: 'server'; state: AskState }
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

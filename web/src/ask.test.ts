import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `listrows.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no ask.js for `node --test` to find. And nothing
// here imports a *value* from './api' — that module reaches for
// `@tauri-apps/api/core` and for `src/parser/flow.js`, neither of which
// resolves outside the bundle.
import {
  applyDelta,
  askBlocked,
  lastCost,
  MAX_QUESTION,
  mergeConversation,
  NO_CONVERSATION,
  reduceAsk,
  seconds,
  showThinking,
  timingNote,
  type AskView,
} from './ask.ts';

type Conversation = NonNullable<AskView['conversation']>;
type Turn = Conversation['turns'][number];

const turn = (over: Partial<Turn> = {}): Turn => ({
  at: 1000,
  question: 'how do these fit together?',
  answer: '',
  state: 'running',
  ...over,
});

const conversation = (over: Partial<Conversation> = {}): Conversation => ({
  id: 'ask-1',
  at: 1000,
  sessionId: null,
  turns: [turn()],
  costUsd: 0,
  ...over,
});

test('a delta lands on the turn being written', () => {
  const held = conversation();
  const next = applyDelta(held, { conversationId: 'ask-1', text: 'They ', kind: 'answer' });
  assert.equal(next?.turns[0]?.answer, 'They ');
  // The thinking and the answer are two fields, never one.
  assert.equal(next?.turns[0]?.thinking, undefined);

  const thinking = applyDelta(next, { conversationId: 'ask-1', text: 'reading…', kind: 'thinking' });
  assert.equal(thinking?.turns[0]?.answer, 'They ');
  assert.equal(thinking?.turns[0]?.thinking, 'reading…');
});

test('a delta for another conversation, or a finished turn, changes nothing at all', () => {
  const held = conversation();
  // By identity: the panel must not redraw a transcript for a frame that
  // belongs to somebody else's conversation.
  assert.equal(applyDelta(held, { conversationId: 'ask-2', text: 'x', kind: 'answer' }), held);
  assert.equal(applyDelta(null, { conversationId: 'ask-1', text: 'x', kind: 'answer' }), null);

  const done = conversation({ turns: [turn({ state: 'done', answer: 'whole' })] });
  assert.equal(applyDelta(done, { conversationId: 'ask-1', text: '!', kind: 'answer' }), done);
});

test('the socket may be ahead of the fetch, and a running turn keeps the longer text', () => {
  // The real order: POST goes out, deltas stream in, and only then does the
  // 202 land carrying a turn whose answer is still empty.
  const streamed = conversation({ turns: [turn({ answer: 'They split into ' })] });
  const from202 = conversation({ turns: [turn()] });
  const merged = mergeConversation(streamed, from202);
  assert.equal(merged?.turns[0]?.answer, 'They split into ');
});

test('a finished turn is the CLI\'s own copy and replaces the deltas', () => {
  const streamed = conversation({ turns: [turn({ answer: 'They split into ' })] });
  const ended = conversation({
    turns: [turn({ state: 'done', answer: 'They split into three.', costUsd: 0.011, ms: 14_000 })],
    costUsd: 0.011,
  });
  const merged = mergeConversation(streamed, ended);
  assert.equal(merged?.turns[0]?.answer, 'They split into three.');
  assert.equal(merged?.costUsd, 0.011);
});

test('a poll that answered from before the press does not drop the new turn', () => {
  const two = conversation({ turns: [turn({ state: 'done', answer: 'one' }), turn({ at: 2000 })] });
  const stale = conversation({ turns: [turn({ state: 'done', answer: 'one' })] });
  const merged = mergeConversation(two, stale);
  assert.equal(merged?.turns.length, 2);
  assert.equal(merged?.turns[1]?.at, 2000);
});

test('nothing observable moved, so the object is the one already on screen', () => {
  const held = conversation({ turns: [turn({ state: 'done', answer: 'settled', costUsd: 0.01 })], costUsd: 0.01 });
  const again = conversation({ turns: [turn({ state: 'done', answer: 'settled', costUsd: 0.01 })], costUsd: 0.01 });
  assert.equal(mergeConversation(held, again), held);
});

test('a different conversation replaces the one held', () => {
  const held = conversation();
  const other = conversation({ id: 'ask-2' });
  assert.equal(mergeConversation(held, other), other);
  assert.equal(mergeConversation(held, null), null);
});

test('a conversation that went away without this page ending it was a project switch', () => {
  const started = reduceAsk(NO_CONVERSATION, { kind: 'server', state: { conversation: conversation(), running: true } });
  assert.equal(started.running, true);

  const switched = reduceAsk(started, { kind: 'server', state: { conversation: null, running: false } });
  assert.equal(switched.conversation, null);
  assert.equal(switched.gone, 'switched');

  // Pressing End is the other way one goes away, and it is not a switch — the
  // panel must not tell the user their project changed when it did not.
  const ended = reduceAsk(started, { kind: 'ended' });
  assert.equal(ended.gone, 'ended');
  // And a poll arriving after it does not turn that into a switch.
  assert.equal(reduceAsk(ended, { kind: 'server', state: { conversation: null, running: false } }).gone, 'ended');
});

test('asking again clears the reason the last one went away', () => {
  const ended: AskView = { conversation: null, running: false, gone: 'ended' };
  const next = reduceAsk(ended, { kind: 'server', state: { conversation: conversation({ id: 'ask-3' }), running: true } });
  assert.equal(next.gone, null);
});

test('the box says why it will not send, in one answer', () => {
  const base = { question: 'why?', running: false, sending: false, categories: 4 };
  assert.equal(askBlocked(base), null);
  assert.match(askBlocked({ ...base, running: true }) ?? '', /still being written/);
  assert.match(askBlocked({ ...base, sending: true }) ?? '', /still being written/);
  assert.match(askBlocked({ ...base, categories: 0 }) ?? '', /no categories/);
  assert.match(askBlocked({ ...base, question: '   ' }) ?? '', /Type a question/);
  assert.match(askBlocked({ ...base, question: 'x'.repeat(MAX_QUESTION + 1) }) ?? '', /at most 2000/);
  // A run in flight is the more useful thing to say than an empty box.
  assert.match(askBlocked({ ...base, question: '', running: true }) ?? '', /still being written/);
});

test('the thinking is drawn until the answer starts, and never after', () => {
  assert.equal(showThinking(turn({ thinking: 'reading the categories' })), true);
  // The first word of the answer is what takes the screen back.
  assert.equal(showThinking(turn({ thinking: 'reading', answer: 'They' })), false);
  assert.equal(showThinking(turn()), false);
  assert.equal(showThinking(turn({ state: 'done', thinking: 'reading' })), false);
});

test('the price under an answer is the last one that actually arrived', () => {
  assert.equal(lastCost(null), null);
  assert.equal(lastCost(conversation()), null);
  // A failed turn printed no price, so it is not one.
  assert.equal(
    lastCost(
      conversation({
        turns: [turn({ state: 'done', costUsd: 0.026 }), turn({ at: 2000, state: 'failed', reason: 'timeout' })],
      }),
    ),
    0.026,
  );
});

test('a duration keeps the decimal where the decimal is the point', () => {
  // "first words in 1.9 s" is the number that decides whether this feels
  // fast; rounding it to 2 s throws away half the measurement.
  assert.equal(seconds(1900), '1.9 s');
  assert.equal(seconds(14_200), '14 s');
  assert.equal(timingNote(turn({ state: 'done', ms: 14_200, firstTokenMs: 1900 })), 'first words in 1.9 s, 14 s in all');
  assert.equal(timingNote(turn({ state: 'done', ms: 14_200 })), '14 s in all');
  assert.equal(timingNote(turn()), null);
});

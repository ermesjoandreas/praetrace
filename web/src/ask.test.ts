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
  cohesionNote,
  inventedPaths,
  lastCost,
  MAX_QUESTION,
  mergeConversation,
  NO_CONVERSATION,
  overlapNote,
  proposeBlocked,
  proposeStatus,
  proposeSummary,
  reachNote,
  reduceAsk,
  sameRun,
  seconds,
  showThinking,
  timingNote,
  weakCohesion,
  type AskView,
} from './ask.ts';
import type { Proposal, ProposeRun } from './api';

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

/* --- proposing a grouping -------------------------------------------------- */

const evidence = (over: Partial<Proposal['evidence']> = {}): Proposal['evidence'] => ({
  files: ['a.ts', 'b.ts', 'c.ts'],
  unknown: [],
  tests: [],
  cohesion: 0.7,
  inside: 7,
  leaving: 3,
  reachedFrom: [],
  reaches: [],
  ...over,
});

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  name: 'Parser',
  sentence: 'Turns source into the graph.',
  files: ['a.ts', 'b.ts', 'c.ts'],
  invented: [],
  evidence: evidence(),
  overlaps: [],
  unclaimed: 3,
  ...over,
});

test('the cohesion a reader judges by is two counts, not a percentage on its own', () => {
  // "1 of 2" and "31 of 44" are both high, and only one of them means
  // anything — which is why the counts are on the face of the row.
  assert.equal(cohesionNote(evidence()), '7 of 10 references stay inside (70%)');
  assert.equal(
    cohesionNote(evidence({ inside: 5, leaving: 40, cohesion: 5 / 45 })),
    '5 of 45 references stay inside (11%)',
  );
  // Not "0%": nothing was measured, and a percentage would read as a
  // measurement rather than as an absence.
  assert.equal(
    cohesionNote(evidence({ inside: 0, leaving: 0, cohesion: 0 })),
    'No imports or calls at either end of these files',
  );
});

test('below the cut the clustering itself uses, the number is marked', () => {
  // MIN_COHESION in view/cluster.ts is 1/3. Below it the import graph would
  // not have offered these files as a group.
  assert.equal(weakCohesion(evidence({ cohesion: 0.34 })), false);
  assert.equal(weakCohesion(evidence({ cohesion: 1 / 3 })), false);
  assert.equal(weakCohesion(evidence({ cohesion: 0.32 })), true);
  assert.equal(weakCohesion(evidence({ inside: 0, leaving: 12, cohesion: 0 })), true);
});

test('covering unclaimed files and re-cutting a category are different sentences', () => {
  assert.equal(overlapNote(proposal()), 'Covers files no category holds');
  assert.equal(
    overlapNote(
      proposal({
        overlaps: [{ name: 'Data Pipeline', storedId: 'src/a.ts~96', shared: 3, size: 96 }],
        unclaimed: 0,
      }),
    ),
    'Re-cuts Data Pipeline 3/96',
  );
  // What the proposal takes from a category and what it takes from nobody are
  // both said, because they are what makes it one act rather than the other.
  assert.equal(
    overlapNote(
      proposal({
        overlaps: [{ name: 'Data Pipeline', storedId: null, shared: 1, size: 96 }],
        unclaimed: 2,
      }),
    ),
    'Re-cuts Data Pipeline 1/96 · 2 of 3 files are in no category',
  );
});

test('a path the project has no file for is never dropped, whichever list said so', () => {
  // Two lists check it — one against what was sent, one against the graph —
  // and a path missing from either is a path that is not there.
  assert.deepEqual(inventedPaths(proposal()), []);
  assert.deepEqual(
    inventedPaths(proposal({ invented: ['src/made-up.ts'], evidence: evidence({ unknown: ['src/gone.ts'] }) })),
    ['src/gone.ts', 'src/made-up.ts'],
  );
});

test('what reaches in and what is reached out to, or nothing when it stands alone', () => {
  assert.equal(reachNote(evidence()), null);
  assert.equal(reachNote(evidence({ reachedFrom: ['x.ts'], reaches: ['y.ts', 'z.ts'] })), '1 file reaches in, 2 reached out to');
});

test('the propose button is never gated on there being categories', () => {
  // askBlocked refuses a project with none; this one must not, because a
  // project with none is exactly what it exists for.
  assert.equal(proposeBlocked({ proposing: false, sending: false, fileCount: 119 }), null);
  assert.equal(askBlocked({ question: 'how?', running: false, sending: false, categories: 0 }) !== null, true);
  assert.equal(proposeBlocked({ proposing: false, sending: false, fileCount: 0 }), 'There are no files here to group.');
  assert.equal(proposeBlocked({ proposing: true, sending: false, fileCount: 119 }) !== null, true);
});

test('a run that is not the answer yet says what it is doing, and for how long', () => {
  const run = (over: Partial<ProposeRun> = {}): ProposeRun => ({
    at: 1000,
    state: 'running',
    proposals: [],
    note: null,
    dropped: 0,
    sent: { files: 119, links: 355, categories: 0 },
    ...over,
  });
  assert.match(proposeStatus(run()) ?? '', /Reading 119 files and 355 references/);
  // Nothing streams, so the sentence has to say a still panel is not a hung one.
  assert.match(proposeStatus(run()) ?? '', /nothing appears until it is done/);
  assert.equal(proposeStatus(run({ state: 'done' })), null);
  assert.equal(
    proposeStatus(run({ state: 'failed', reason: 'timeout', detail: 'after 300 s' })),
    'It took too long and was given up on. after 300 s',
  );
  assert.match(proposeStatus(run({ state: 'failed', reason: 'too-big' })) ?? '', /too big/);

  assert.equal(proposeSummary(run({ state: 'done', proposals: [proposal()] })), '1 grouping from 119 files');
  assert.equal(
    proposeSummary(run({ state: 'done', proposals: [proposal(), proposal({ name: 'View' })], dropped: 2 })),
    '2 groupings from 119 files · 2 dropped for naming too few real files',
  );
  assert.equal(proposeSummary(run({ state: 'done' })), 'No grouping proposed');

  // The poll re-reads the run every three seconds; only these three fields
  // can change what a reader sees, so nothing else redraws the list.
  assert.equal(sameRun(run(), run()), true);
  assert.equal(sameRun(run(), run({ state: 'done' })), false);
  assert.equal(sameRun(run(), null), false);
  assert.equal(sameRun(null, null), true);
});

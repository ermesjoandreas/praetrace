import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `panes.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no marks.js for `node --test` to find.
import {
  addMarks,
  ASKED,
  bandOf,
  describeMark,
  liveMarks,
  nextChange,
  WRITTEN,
  type Mark,
} from './marks.ts';

const NONE: ReadonlySet<string> = new Set();

test('a mark is at full strength, then weakened, then gone', () => {
  assert.equal(bandOf(1000, 1000, WRITTEN), 'fresh');
  assert.equal(bandOf(1000, 1000 + WRITTEN.fresh - 1, WRITTEN), 'fresh');
  assert.equal(bandOf(1000, 1000 + WRITTEN.fresh, WRITTEN), 'cooled');
  assert.equal(bandOf(1000, 1000 + WRITTEN.gone - 1, WRITTEN), 'cooled');
  assert.equal(bandOf(1000, 1000 + WRITTEN.gone, WRITTEN), null);
});

test('a write outlasts a glance and a question does not', () => {
  // The whole point of the change: the old mark was 2 500 ms, which is gone
  // before a person looks up from the terminal.
  assert.ok(WRITTEN.gone >= 90_000);
  assert.ok(ASKED.gone < WRITTEN.gone);
});

test('a batch marks its files and leaves the rest alone', () => {
  const before = new Map<string, Mark>([['a.ts', { at: 10, born: false, by: null }]]);
  const after = addMarks(before, ['b.ts'], 500, new Set(['b.ts']), undefined);
  assert.deepEqual(after.get('a.ts'), { at: 10, born: false, by: null });
  assert.deepEqual(after.get('b.ts'), { at: 500, born: true, by: null });
});

test('an empty batch is the same map, so it costs no re-render', () => {
  const before = new Map<string, Mark>([['a.ts', { at: 10, born: false, by: null }]]);
  assert.equal(addMarks(before, [], 500, NONE, undefined), before);
});

test('a file that appeared stays new for the whole window, even when edited again', () => {
  const born = addMarks(new Map(), ['a.ts'], 100, new Set(['a.ts']), undefined);
  const again = addMarks(born, ['a.ts'], 5000, NONE, undefined);
  assert.equal(again.get('a.ts')?.born, true);
  assert.equal(again.get('a.ts')?.at, 5000, 'the time is the latest edit, not the birth');
});

test('the last claim wins, and an unclaimed edit takes the name off', () => {
  const claimed = addMarks(new Map(), ['a.ts'], 100, NONE, {
    'a.ts': { agent: 'Claude Code', how: 'recognised', tool: 'Write', subagent: null, session: 'x' },
  });
  assert.equal(claimed.get('a.ts')?.by?.agent, 'Claude Code');
  // A hand edit to a file an agent wrote is not that agent's, and the mark
  // must not keep saying it is.
  const watched = addMarks(claimed, ['a.ts'], 200, NONE, undefined);
  assert.equal(watched.get('a.ts')?.by, null);
});

test('expired marks are dropped, and a sweep that finds none returns the same map', () => {
  const marks = new Map<string, Mark>([
    ['old.ts', { at: 0, born: false, by: null }],
    ['new.ts', { at: 100_000, born: false, by: null }],
  ]);
  assert.equal(liveMarks(marks, 100_000, WRITTEN), marks);
  const swept = liveMarks(marks, 130_000, WRITTEN);
  assert.deepEqual([...swept.keys()], ['new.ts']);
});

test('one timer, set to the next thing that actually changes', () => {
  assert.equal(nextChange(new Map(), 0, WRITTEN), null);
  const marks = new Map<string, Mark>([
    ['fresh.ts', { at: 90_000, born: false, by: null }],
    ['cool.ts', { at: 10_000, born: false, by: null }],
  ]);
  // At 100 000 the fresh one cools in 10 000 and the cool one expires in
  // 30 000, so the timer is the sooner of the two.
  assert.equal(nextChange(marks, 100_000, WRITTEN), 10_000);
  // Once nothing is fresh the timer is the oldest one's expiry.
  assert.equal(nextChange(new Map([['cool.ts', { at: 10_000, born: false, by: null }]]), 100_000, WRITTEN), 30_000);
});

test('a mark says who, or says plainly that nobody claimed it', () => {
  const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const at = Date.UTC(2026, 8, 8, 14, 12);
  assert.match(describeMark({ at, born: false, by: null }, clock), /^Written at 14:12 — unattributed/);
  assert.equal(
    describeMark(
      { at, born: true, by: { agent: 'Cursor', how: 'declared', tool: null, subagent: null, session: null } },
      clock,
    ),
    'Added at 14:12 by Cursor',
  );
  assert.equal(
    describeMark(
      {
        at,
        born: false,
        by: { agent: 'Claude Code', how: 'recognised', tool: 'Edit', subagent: 'code-reviewer', session: 's' },
      },
      clock,
    ),
    'Written at 14:12 by Claude Code · code-reviewer (Edit)',
  );
});

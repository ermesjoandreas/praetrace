import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignLanes, type LaneRow, type LaneSegment } from './lanes.js';

/** The threads of one row, sorted so a test can compare them regardless of order. */
function threads(row: LaneRow): LaneSegment[] {
  return [...row.segments].sort((a, b) => (a.from ?? -1) - (b.from ?? -1) || (a.to ?? -1) - (b.to ?? -1));
}

test('a linear history is one lane, every commit joined to the next', () => {
  const rows = assignLanes([
    { sha: 'c', parents: ['b'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);

  assert.deepEqual(
    rows.map((row) => row.lane),
    [0, 0, 0],
  );
  assert.deepEqual(
    rows.map((row) => row.width),
    [1, 1, 1],
  );
  // The tip has nothing above it, the root nothing below.
  assert.deepEqual(threads(rows[0]!), [{ from: null, to: 0 }]);
  assert.deepEqual(threads(rows[1]!), [{ from: null, to: 0 }, { from: 0, to: null }]);
  assert.deepEqual(threads(rows[2]!), [{ from: 0, to: null }]);
});

test('a branch that merges back opens a second lane and closes it at the fork', () => {
  // a <- b <- m, and a <- d <- m: d was branched from a and merged into m.
  const rows = assignLanes([
    { sha: 'm', parents: ['b', 'd'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'd', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);

  const [merge, main, branch, fork] = rows as [LaneRow, LaneRow, LaneRow, LaneRow];

  // The merge sits in lane 0; its second parent leaves in a new lane.
  assert.equal(merge.lane, 0);
  assert.deepEqual(threads(merge), [{ from: null, to: 0 }, { from: null, to: 1 }]);
  assert.equal(merge.width, 2);

  // The mainline commit keeps lane 0 while the branch passes it in lane 1.
  assert.equal(main.lane, 0);
  assert.deepEqual(threads(main), [{ from: null, to: 0 }, { from: 0, to: null }, { from: 1, to: 1 }]);

  // The branch commit is in lane 1, with the mainline passing in lane 0.
  assert.equal(branch.lane, 1);
  assert.deepEqual(threads(branch), [{ from: null, to: 1 }, { from: 0, to: 0 }, { from: 1, to: null }]);

  // Both lanes were waiting for the fork commit: it takes the first, the
  // other folds into it, and nothing is left open below a root.
  assert.equal(fork.lane, 0);
  assert.deepEqual(threads(fork), [{ from: 0, to: null }, { from: 1, to: null }]);
  assert.equal(fork.width, 2);
});

test('two branches alive at once share the fork and never a lane', () => {
  // a <- b and a <- c, neither merged. c is newest.
  const rows = assignLanes([
    { sha: 'c', parents: ['a'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);

  const [c, b, a] = rows as [LaneRow, LaneRow, LaneRow];
  assert.equal(c.lane, 0);
  assert.equal(b.lane, 1);
  assert.notEqual(c.lane, b.lane);
  // Each tip has no thread above it: nothing in the log descends from it.
  assert.deepEqual(threads(c), [{ from: null, to: 0 }]);
  assert.deepEqual(threads(b), [{ from: null, to: 1 }, { from: 0, to: 0 }]);
  assert.deepEqual(threads(a), [{ from: 0, to: null }, { from: 1, to: null }]);
  assert.ok(rows.every((row) => row.width <= 2));
});

test('a lane freed by a merge is reused rather than left as a gap', () => {
  // Branch d merges into m1 and closes; a later branch e opens and should
  // land in the same second lane, not a third.
  const rows = assignLanes([
    { sha: 'm2', parents: ['m1', 'e'] },
    { sha: 'e', parents: ['m1'] },
    { sha: 'm1', parents: ['b', 'd'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'd', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);

  assert.ok(rows.every((row) => row.width <= 2), 'never needs a third lane');
  assert.equal(rows[1]!.lane, 1);
  assert.equal(rows[4]!.lane, 1);
});

test('a merge into a thread that is already open keeps that thread running through the row', () => {
  // t sits on a branch off a; m merges a in as its second parent while t's
  // thread is still waiting for a. Git draws that as `|/`, the thread never
  // breaking; the merge joins it rather than opening a lane of its own.
  const rows = assignLanes([
    { sha: 't', parents: ['a'] },
    { sha: 'm', parents: ['b', 'a'] },
    { sha: 'b', parents: ['a'] },
    { sha: 'a', parents: [] },
  ]);

  const [tip, merge, main, fork] = rows as [LaneRow, LaneRow, LaneRow, LaneRow];
  assert.equal(tip.lane, 0);
  assert.equal(merge.lane, 1);
  assert.equal(merge.width, 2);
  // The join goes to lane 0, and lane 0's own thread still passes through.
  assert.deepEqual(threads(merge), [{ from: null, to: 0 }, { from: null, to: 1 }, { from: 0, to: 0 }]);
  assert.equal(main.lane, 1);
  assert.deepEqual(threads(main), [{ from: null, to: 1 }, { from: 0, to: 0 }, { from: 1, to: null }]);
  assert.equal(fork.lane, 0);
  assert.deepEqual(threads(fork), [{ from: 0, to: null }, { from: 1, to: null }]);
});

test('a parent outside the log keeps its thread running to the bottom', () => {
  const rows = assignLanes([
    { sha: 'c', parents: ['b'] },
    { sha: 'b', parents: ['a'] },
  ]);

  // The last row still leaves in lane 0: the thread does not pretend b is a root.
  assert.deepEqual(threads(rows[1]!), [{ from: null, to: 0 }, { from: 0, to: null }]);
});

test('an octopus merge opens a lane per extra parent and does not crash', () => {
  const rows = assignLanes([
    { sha: 'm', parents: ['a', 'b', 'c'] },
    { sha: 'a', parents: [] },
    { sha: 'b', parents: [] },
    { sha: 'c', parents: [] },
  ]);

  const [merge, a, b, c] = rows as [LaneRow, LaneRow, LaneRow, LaneRow];
  assert.equal(merge.width, 3);
  assert.deepEqual(threads(merge), [
    { from: null, to: 0 },
    { from: null, to: 1 },
    { from: null, to: 2 },
  ]);
  assert.deepEqual([a.lane, b.lane, c.lane], [0, 1, 2]);
  // The last root sits in lane 2, so its row stays three wide with nothing else open.
  assert.equal(c.width, 3);
  assert.deepEqual(threads(c), [{ from: 2, to: null }]);
});

test('an empty log is an empty layout', () => {
  assert.deepEqual(assignLanes([]), []);
});

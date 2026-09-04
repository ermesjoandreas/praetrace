import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `panes.test.ts` and `layout.test.ts` beside it: the page is bundled by vite
// and never compiled into dist/, so there is no listkeys.js for `node --test`
// to find.
import { activeRow, nextRow, stopAfterRender, tabStop } from './listkeys.ts';

/** How many rows the commit graph draws — `git log -n 300`. The list this exists for. */
const COMMITS = 300;

/** Every row's tabIndex, which is the only thing the hook writes to the DOM. */
const stops = (active: number, count: number) =>
  Array.from({ length: count }, (_, index) => tabStop(index, active, count));

test('a list is one tab stop, whichever row it is on', () => {
  const graph = stops(7, COMMITS);
  assert.equal(graph.filter((stop) => stop === 0).length, 1);
  assert.equal(graph.indexOf(0), 7);
  // The other 299 are reachable by arrow and by click, and by nothing else.
  assert.equal(graph.filter((stop) => stop === -1).length, COMMITS - 1);
});

test('before anything is focused the stop is the first row', () => {
  assert.equal(activeRow(-1, COMMITS), 0);
  assert.equal(stops(-1, COMMITS).indexOf(0), 0);
});

test('a list cut short keeps the stop at its end, not back at the top', () => {
  // The Changes list is rebuilt every time the working tree moves: a row the
  // keyboard was on can simply stop existing between two renders.
  assert.equal(activeRow(9, 4), 3);
  assert.equal(stops(9, 4).indexOf(0), 3);
});

test('an empty list has no tab stop at all', () => {
  assert.equal(activeRow(0, 0), -1);
  assert.deepEqual(stops(0, 0), []);
  // And it answers no key, so nothing is swallowed on the way to the page.
  for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End']) {
    assert.equal(nextRow(key, 0, 0), null);
  }
});

test('down and up move one row', () => {
  assert.equal(nextRow('ArrowDown', 0, COMMITS), 1);
  assert.equal(nextRow('ArrowUp', 5, COMMITS), 4);
});

test('the ends hold, and the press is still the list’s', () => {
  // Not null: null would hand the key back to the page, and the panel would
  // scroll out from under a list that has merely ended.
  assert.equal(nextRow('ArrowDown', COMMITS - 1, COMMITS), COMMITS - 1);
  assert.equal(nextRow('ArrowUp', 0, COMMITS), 0);
});

test('home and end reach the ends of a 300-row list in one press', () => {
  assert.equal(nextRow('Home', 299, COMMITS), 0);
  assert.equal(nextRow('End', 0, COMMITS), COMMITS - 1);
});

test('every other key belongs to the page', () => {
  for (const key of ['Enter', ' ', 'Escape', 'ArrowLeft', 'ArrowRight', 'PageDown', 'k']) {
    assert.equal(nextRow(key, 3, COMMITS), null);
  }
});

test('a one-row list moves nowhere and still answers', () => {
  assert.equal(nextRow('ArrowDown', 0, 1), 0);
  assert.equal(nextRow('End', 0, 1), 0);
  assert.deepEqual(stops(0, 1), [0]);
});

// The bug this pins: the stop was stamped from a remembered index, so a row
// inserted above the focused one moved the list's one tab stop onto its
// neighbour while focus stayed put. Measured against Changes: focus and stop
// both on `lanes.ts` at index 2, then a file that sorts first arrives — focus
// is on index 3 and the stop was still written to index 2.
test('a row arriving above the focused one does not take its tab stop', () => {
  const remembered = 2;
  const nowAt = 3; // the same row, one further down, because a file sorted in
  assert.equal(stopAfterRender(nowAt, remembered, 0), nowAt);
  assert.equal(stops(stopAfterRender(nowAt, remembered, 0), 5).indexOf(0), 3);
});

test('a list nobody is inside keeps where the keyboard last was', () => {
  assert.equal(stopAfterRender(-1, 7, 0), 7);
});

test('a list that has never held focus starts where it was told to', () => {
  // The commit graph passes the row the diagram is at, so Tab arrives there
  // rather than 300 rows away from it.
  assert.equal(stopAfterRender(-1, -1, 42), 42);
  assert.equal(stopAfterRender(-1, -1, 0), 0);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `panes.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no find.js for `node --test` to find.
import { countLabel } from './find.ts';

test('nothing typed is not a search, so the bar says nothing', () => {
  assert.equal(countLabel('', 0, 0), '');
  assert.equal(countLabel('   ', 0, 0), '');
});

test('the count says which match the camera is on', () => {
  assert.equal(countLabel('store', 17, 0), '1 of 17');
  assert.equal(countLabel('store', 17, 2), '3 of 17');
  assert.equal(countLabel('store', 17, 16), '17 of 17');
});

test('a query that matched nothing says so in VS Code’s words', () => {
  assert.equal(countLabel('store', 0, 0), 'No results');
});

test('a current match the view no longer has falls back to the count', () => {
  // The diagram changes under the bar — a save, a filter, a navigation — and
  // the index the last step left behind can outlive the match it named. The
  // honest thing to say then is how many there are, not a place in the list
  // that is not where the camera is.
  assert.equal(countLabel('store', 3, 7), '3 matches');
  assert.equal(countLabel('store', 1, 4), '1 match');
  assert.equal(countLabel('store', 3, -1), '3 matches');
});

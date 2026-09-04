import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REACHES } from './edges.js';

test('a dependency does not reach, and a has-a does', () => {
  // The whole reason `depends` is a kind of its own and not a flag on
  // `associates`: the hook's sentence and the panel's "used by" read this set,
  // and a class that only takes a Store as a parameter must not be told it
  // holds one.
  assert.equal(REACHES.has('depends'), false);
  assert.equal(REACHES.has('associates'), true);
  assert.equal(REACHES.has('imports'), false);
  assert.equal(REACHES.has('contains'), false);
});

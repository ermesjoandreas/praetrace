import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAnswer, type SuggestTarget } from './suggest.js';

const targets: SuggestTarget[] = [
  { id: 'a.ts~3', files: ['a.ts', 'b.ts', 'c.ts'], cohesion: 0.7 },
  { id: 'x.ts~2', files: ['x.ts', 'y.ts'], cohesion: 0.5 },
];

/** What `claude -p --output-format json` prints, with the fields a test cares about. */
function envelope(fields: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'Done.',
    total_cost_usd: 0.021,
    ...fields,
  });
}

test('ids come back as sent; an invented id, a second answer and a blank name are dropped', () => {
  const out = readAnswer(
    envelope({
      structured_output: {
        suggestions: [
          { id: 'a.ts~3', name: '  Graph engine ', reason: 'They derive the graph.' },
          { id: 'a.ts~3', name: 'Second thoughts', reason: 'Changed its mind.' },
          { id: 'made-up~9', name: 'Ghost', reason: 'Not a group that was asked about.' },
          { id: 'x.ts~2', name: '   ', reason: 'A reason with no name.' },
        ],
      },
    }),
    targets,
    12,
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.suggestions, [{ id: 'a.ts~3', name: 'Graph engine', reason: 'They derive the graph.' }]);
  assert.equal(out.costUsd, 0.021);
  assert.equal(out.ms, 12);
});

test('prose where an envelope should be is unreadable, and the prose is quoted', () => {
  const out = readAnswer('hello there', targets, 1);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'unreadable');
  assert.match(out.detail, /hello there/);
});

test('an error envelope that mentions logging in is an auth failure, any other is failed', () => {
  const auth = readAnswer(envelope({ is_error: true, result: 'Not logged in. Please run /login' }), targets, 1);
  assert.deepEqual(auth, { ok: false, reason: 'auth', detail: 'Not logged in. Please run /login' });
  const other = readAnswer(envelope({ is_error: true, result: 'Something broke' }), targets, 1);
  assert.deepEqual(other, { ok: false, reason: 'failed', detail: 'Something broke' });
});

test('the CLI refusing the shape is unreadable, not a failed run', () => {
  const out = readAnswer(envelope({ subtype: 'error_structured_output_validation', is_error: true }), targets, 1);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'unreadable');
});

test('an answer naming none of the groups asked about is unreadable', () => {
  const out = readAnswer(
    envelope({ structured_output: { suggestions: [{ id: 'nope~1', name: 'Nope', reason: '' }] } }),
    targets,
    1,
  );
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.equal(out.reason, 'unreadable');
});

test('a fenced JSON answer in result is read when structured_output is absent', () => {
  const fenced = '```json\n{"suggestions":[{"id":"x.ts~2","name":"Pair","reason":"Two files."}]}\n```';
  const out = readAnswer(envelope({ result: fenced }), targets, 1);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.suggestions, [{ id: 'x.ts~2', name: 'Pair', reason: 'Two files.' }]);
});

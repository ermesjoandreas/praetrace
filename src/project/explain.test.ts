import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, type ExplainTarget } from './explain.js';

/**
 * The reading of cobra's `Command.Execute` said "nothing depends on it", which
 * was false in sixteen places: the graph tracks a call only through a typed
 * receiver, and the prompt let the model read an empty list as a fact. These
 * check the words the model is given, which is the only part of a paid run
 * that can be checked for free.
 */
function target(fields: Partial<ExplainTarget> & Pick<ExplainTarget, 'id'>): ExplainTarget {
  return {
    kind: 'symbol',
    name: fields.id.slice(fields.id.indexOf('#') + 1),
    filePath: fields.id.slice(0, fields.id.indexOf('#')),
    source: 'func (c *Command) Execute() error { return c.ExecuteC() }',
    context: [],
    related: [],
    ...fields,
  };
}

const NOTE =
  'calls through a receiver whose type is not written down are not tracked, so an empty list means unknown, not none';

/** The lines of one target's block, from its separator to the next one. */
function blockOf(prompt: string, id: string): string {
  const start = prompt.indexOf(`id: ${id}`);
  assert.notEqual(start, -1, `no block for ${id}`);
  const next = prompt.indexOf('--- target', start);
  return prompt.slice(start, next === -1 ? undefined : next);
}

test('the rules tell the model what the graph cannot see, in words it can act on', () => {
  const prompt = buildPrompt([target({ id: 'command.go#Command.Execute', coverage: 'partial', coverageNote: NOTE })]);
  const rules = prompt.slice(0, prompt.indexOf('--- target'));

  assert.match(rules, /static analysis/);
  assert.match(rules, /receiver/);
  assert.match(rules, /UNKNOWN, not none/);
  assert.match(rules, /never conclude that nothing depends on it/);
});

test('a partial target carries the graph’s note beside its relations, and an empty list under it is not none', () => {
  const prompt = buildPrompt([target({ id: 'command.go#Command.Execute', coverage: 'partial', coverageNote: NOTE })]);
  const block = blockOf(prompt, 'command.go#Command.Execute');

  assert.match(block, /relations \(PARTIAL — /);
  assert.ok(block.includes(NOTE), 'the note describeSymbol wrote is what the model reads');
  // The header comes before the empty-list line, so the caveat is read first.
  assert.ok(block.indexOf('PARTIAL') < block.indexOf('(nothing in the graph touches it)'));
});

test('a full target is presented as what the graph found, with no caveat on its list', () => {
  const prompt = buildPrompt([
    target({ id: 'cobra.go#OnInitialize', coverage: 'full', context: ['used by command.go#Command.Execute (calls)'] }),
  ]);
  const block = blockOf(prompt, 'cobra.go#OnInitialize');

  assert.match(block, /\nrelations:\n/);
  assert.doesNotMatch(block, /PARTIAL/);
  assert.match(block, /used by command\.go#Command\.Execute \(calls\)/);
});

test('a partial target that was given no note still gets one, rather than an unqualified list', () => {
  const prompt = buildPrompt([target({ id: 'a.ts#T.m', coverage: 'partial' })]);
  const block = blockOf(prompt, 'a.ts#T.m');

  assert.match(block, /relations \(PARTIAL — an empty list means unknown, not none\):/);
});

test('two targets each keep their own coverage', () => {
  const prompt = buildPrompt([
    target({ id: 'a.ts#T.m', coverage: 'partial', coverageNote: NOTE }),
    target({ id: 'a.ts#helper', coverage: 'full', context: ['uses a.ts#T.m (calls)'] }),
  ]);

  assert.match(blockOf(prompt, 'a.ts#T.m'), /PARTIAL/);
  assert.doesNotMatch(blockOf(prompt, 'a.ts#helper'), /PARTIAL/);
});

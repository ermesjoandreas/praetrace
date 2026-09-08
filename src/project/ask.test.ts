import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPrompt, displayNames, readLine, type AskCategory, type AskContext } from './ask.js';

function category(fields: Partial<AskCategory> & { id: string }): AskCategory {
  return {
    name: null,
    files: [`${fields.id}.ts`],
    provides: [],
    providesTotal: 0,
    ...fields,
  };
}

const context: AskContext = {
  project: 'codemap',
  fileCount: 12,
  categories: [
    category({
      id: 'component:a',
      name: 'Graph engine',
      files: ['src/graph/store.ts', 'src/graph/resolve.ts'],
      cohesion: 0.84,
      provides: [{ name: 'createStore', kind: 'function', owner: null, reachedFrom: 4 }],
      providesTotal: 9,
    }),
    category({ id: 'component:b', files: ['src/view/select.ts', 'src/view/filter.ts'], cohesion: 0.31 }),
    category({ id: 'component:c', name: 'Lang decoder', files: ['src/lang/go.ts'], origin: 'manual' }),
    category({ id: 'component:none', files: ['src/x.test.ts'], uncategorised: true }),
  ],
  edges: [
    { from: 'component:b', to: 'component:a', kind: 'imports', weight: 7 },
    { from: 'component:b', to: 'component:gone', kind: 'imports', weight: 2 },
  ],
};

// --- readLine: the whole of what codemap understands about the CLI's wire ---

test('a content delta is the answer arriving, and every line names the session', () => {
  const facts = readLine(
    JSON.stringify({
      type: 'stream_event',
      session_id: 'f3b2a8db-2d6d-4f53-aa64-f19d69f30d32',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The graph' } },
    }),
  );
  assert.deepEqual(facts, { sessionId: 'f3b2a8db-2d6d-4f53-aa64-f19d69f30d32', text: 'The graph', kind: 'answer' });
});

test('the model thinks first, and thinking is marked as thinking rather than read as the answer', () => {
  // Measured: haiku writes a thinking block for about twelve seconds before
  // the first word of the answer. Reading only the answer left the screen
  // empty for all of it; reading this as the answer would show a reader the
  // model's working as if it were its reply.
  const facts = readLine(
    JSON.stringify({
      type: 'stream_event',
      session_id: 'abc',
      event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Let me look at' } },
    }),
  );
  assert.deepEqual(facts, { sessionId: 'abc', text: 'Let me look at', kind: 'thinking' });
});

test('a signature delta rides in the thinking block and is not text', () => {
  // It carries base64, and "whatever string is here" would put it in the
  // transcript. The delta's own type is what tells the three apart.
  const facts = readLine(
    JSON.stringify({
      type: 'stream_event',
      session_id: 'abc',
      event: { type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'EqEDCrIBCBEYAipA' } },
    }),
  );
  assert.deepEqual(facts, { sessionId: 'abc' });
});

test('the session id arrives on the first line, before any words', () => {
  const facts = readLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', model: 'haiku' }));
  // Read off every line and not only the closing one, so the id to resume does
  // not depend on the answer's shape. What the session then does with it on a
  // turn that failed is `AskConversation`'s decision, not this function's.
  assert.deepEqual(facts, { sessionId: 'abc' });
});

test('the closing line is what the turn cost', () => {
  const facts = readLine(JSON.stringify({ type: 'result', subtype: 'success', session_id: 'abc', total_cost_usd: 0.0024 }));
  assert.deepEqual(facts, { sessionId: 'abc', costUsd: 0.0024 });
});

test('a line that is not JSON, is empty, or carries nothing we read is null', () => {
  assert.equal(readLine(''), null);
  assert.equal(readLine('Loading…'), null);
  assert.equal(readLine('null'), null);
  assert.equal(readLine(JSON.stringify({ type: 'stream_event', event: { type: 'message_start' } })), null);
  // A delta with no text in it is not the answer arriving.
  assert.equal(
    readLine(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { text: '' } } })),
    null,
  );
});

// --- displayNames: what a sentence may call a category --------------------

test('a name is its own; an unnamed one is named for where it starts, never by box id', () => {
  const names = displayNames(context.categories);
  assert.equal(names.get('component:a'), 'Graph engine');
  assert.equal(names.get('component:b'), 'the unnamed group around src/view/select.ts');
  assert.equal(names.get('component:none'), 'files in no category');
  for (const name of names.values()) assert.ok(!name.includes('component:'), name);
});

test('two categories cannot share a name a sentence would use', () => {
  const names = displayNames([
    category({ id: 'one', name: 'Parsing' }),
    category({ id: 'two', name: '  Parsing  ' }),
    category({ id: 'three', name: 'Parsing' }),
  ]);
  assert.deepEqual([...names.values()], ['Parsing', 'Parsing (2)', 'Parsing (3)']);
});

// --- buildPrompt: the feature ---------------------------------------------

test('the first turn carries the categories, their quality and what they provide', () => {
  const prompt = buildPrompt({ question: 'What is this project?', context, resume: null });

  assert.match(prompt, /project called "codemap"/);
  assert.match(prompt, /4 categories over 12 files/);
  assert.match(prompt, /Graph engine — 2 files, 84% of its references stay inside it/);
  assert.match(prompt, /createStore \(function, reached from 4 files\), and 8 more/);
  assert.match(prompt, /QUESTION:\nWhat is this project\?$/);
});

test('a drawn category says so and reports no cohesion, and the uncategorised box is not a category', () => {
  const prompt = buildPrompt({ question: 'q', context, resume: null });
  assert.match(prompt, /Lang decoder — 1 file, drawn by hand/);
  // 0 is the one number a hand-drawn group must never print: it would read as
  // a terrible group rather than as one nobody measured.
  assert.ok(!/Lang decoder — 1 file, 0%/.test(prompt));
  assert.match(prompt, /files in no category — 1 file, in no category/);
});

test('the model is told the graph’s blind spots, and told they are floors', () => {
  const prompt = buildPrompt({ question: 'q', context, resume: null });
  assert.match(prompt, /LOWER BOUND/);
  assert.match(prompt, /Test files do not vote/);
  assert.match(prompt, /You have NOT seen the source of a single file/);
  assert.match(prompt, /You are reading, not deciding/);
});

test('an edge between categories is drawn by name, and one naming a box that is not listed is dropped', () => {
  const prompt = buildPrompt({ question: 'q', context, resume: null });
  assert.match(prompt, /the unnamed group around src\/view\/select\.ts imports Graph engine \(7\)/);
  assert.ok(!prompt.includes('component:gone'));
});

test('a project with no resolved references between categories says so rather than printing an empty heading', () => {
  const prompt = buildPrompt({ question: 'q', context: { ...context, edges: [] }, resume: null });
  assert.match(prompt, /no references between any two of them were resolved/);
});

test('a follow-up sends the question and no categories at all', () => {
  const prompt = buildPrompt({ question: '  Why is view/ so loose?  ', context: null, resume: 'abc' });
  assert.match(prompt, /^Why is view\/ so loose\?/);
  assert.ok(!prompt.includes('Graph engine'));
  assert.ok(!prompt.includes('src/graph/store.ts'));
  // The rules are the part worth restating: a transcript ten turns long drifts.
  assert.match(prompt, /Same rules/);
});

test('a long category is cut, and the prompt says how much it cut', () => {
  const many = Array.from({ length: 45 }, (_, i) => `src/f${i}.ts`);
  const prompt = buildPrompt({
    question: 'q',
    context: { ...context, categories: [category({ id: 'big', name: 'Big', files: many })] },
    resume: null,
  });
  assert.match(prompt, /… and 5 more files/);
  assert.ok(!prompt.includes('src/f44.ts'));
});

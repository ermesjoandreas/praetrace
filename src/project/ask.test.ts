import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPrompt,
  buildProposePrompt,
  displayNames,
  readLine,
  readProposal,
  tooBigToPropose,
  type AskCategory,
  type AskContext,
  type ProposeContext,
} from './ask.js';

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

// --- buildProposePrompt: the other feature ---------------------------------

const propose: ProposeContext = {
  project: 'tasky',
  allPaths: [],
  files: [
    { path: 'src/graph/store.ts', category: 'Graph engine' },
    { path: 'src/graph/resolve.ts', category: 'Graph engine' },
    { path: 'src/view/select.ts', category: null },
    { path: 'src/view/filter.ts', category: null },
  ],
  links: [{ from: 'src/view/select.ts', to: 'src/graph/store.ts', weight: 3 }],
  existing: [{ name: 'Graph engine', files: 2 }],
  fileCount: 6,
  testCount: 2,
};

test('the proposal prompt is the files and the references, not the categories', () => {
  const prompt = buildProposePrompt(propose);

  assert.match(prompt, /project called "tasky"/);
  assert.match(prompt, /4 files to group \(2 of its 6 files are tests and are left out\), with 1 reference/);
  assert.match(prompt, /src\/graph\/store\.ts {2}\[Graph engine\]/);
  assert.match(prompt, /src\/view\/select\.ts$/m);
  assert.match(prompt, /src\/view\/select\.ts -> src\/graph\/store\.ts \(3\)/);
  // The whole point of a second prompt: this one is not told the component
  // diagram, because the project it exists for has no component diagram.
  assert.ok(!prompt.includes('reached from outside'));
});

test('a project nobody has grouped says so, rather than printing an empty heading', () => {
  const prompt = buildProposePrompt({ ...propose, existing: [], files: propose.files.map((file) => ({ ...file, category: null })) });
  assert.match(prompt, /\(none — nobody has grouped this project yet\)/);
  assert.ok(!prompt.includes('[Graph engine]'));
});

test('the model is told the blind spots, and told the numbers are floors', () => {
  const prompt = buildProposePrompt(propose);
  assert.match(prompt, /LOWER BOUND/);
  assert.match(prompt, /two halves of a system that talk over the network look unconnected/i);
  assert.match(prompt, /Test files are left out of the list entirely/);
  // It must not claim its own grouping is good: our number decides that.
  assert.match(prompt, /counted from the references below, before they accept anything/);
  assert.match(prompt, /copied verbatim/);
  // Measured: asked to say what argued for a group, the model wrote counts that
  // were neither the pairs nor the weighted references — and they would have
  // sat on screen beside ours, disagreeing.
  assert.match(prompt, /Put NO counts anywhere you write/);
  // The other measured failure: told that most files were already in a
  // category, the model proposed a group about the leftovers instead of the
  // pieces inside the one that had swallowed the project.
  assert.match(prompt, /Proposing the pieces INSIDE a large category/);
  // And the third: told each group needs three files, it put a file with no
  // references at all into one to reach three, and said so in the note.
  assert.match(prompt, /Never pad a group to reach three files/);
});

test('a project with no resolved references says so rather than leaving the heading bare', () => {
  const prompt = buildProposePrompt({ ...propose, links: [] });
  assert.match(prompt, /\(none were resolved/);
});

// --- tooBigToPropose: the refusal that beats a guess -----------------------

test('a project too big for one prompt is refused by name and by number, before anything is spent', () => {
  const many = Array.from({ length: 601 }, (_, i) => ({ path: `src/f${i}.ts`, category: null }));
  const refusal = tooBigToPropose({ ...propose, files: many });
  assert.match(refusal ?? '', /601 files to group/);
  assert.match(refusal ?? '', /The limit is 600/);
  assert.equal(tooBigToPropose(propose), null);
});

test('a project small enough to list but too tangled to send is refused too', () => {
  const links = Array.from({ length: 3001 }, (_, i) => ({ from: 'a.ts', to: `b${i}.ts`, weight: 1 }));
  assert.match(tooBigToPropose({ ...propose, links }) ?? '', /3001 references .* The limit is 3000/s);
});

// --- readProposal: every path is checked against what was sent -------------

function envelope(answer: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'result', subtype: 'success', total_cost_usd: 0.012, structured_output: answer, ...extra });
}

test('a proposal is read, and a path the project has not got is kept and marked rather than dropped', () => {
  const outcome = readProposal(
    envelope({
      groups: [
        {
          name: 'View layer',
          sentence: 'The slice of the graph that gets drawn.',
          files: ['src/view/select.ts', 'src/view/filter.ts', 'src/view/lanes.ts', 'src/graph/store.ts'],
        },
      ],
    }),
    propose,
    900,
  );

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  const [group] = outcome.groups;
  assert.equal(group?.name, 'View layer');
  assert.deepEqual(group?.files, ['src/view/select.ts', 'src/view/filter.ts', 'src/graph/store.ts']);
  // A model that names a file this project has not got is one to distrust,
  // and the page cannot say so if the path was quietly removed.
  assert.deepEqual(group?.invented, ['src/view/lanes.ts']);
  assert.equal(outcome.costUsd, 0.012);
});

test('a proposal of two real files is not a group, and how many were dropped is reported', () => {
  const outcome = readProposal(
    envelope({
      groups: [
        { name: 'Pair', sentence: 'x', files: ['src/view/select.ts', 'src/view/filter.ts'] },
        { name: 'Invented', sentence: 'x', files: ['a.ts', 'b.ts', 'c.ts'] },
      ],
    }),
    propose,
    10,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.groups, []);
  assert.equal(outcome.dropped, 2);
});

test('a model that says the project does not divide is answering, not failing', () => {
  const outcome = readProposal(
    envelope({ groups: [], note: 'Every file reaches every other; there is no seam here to cut along.' }),
    propose,
    10,
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.groups, []);
  assert.match(outcome.note ?? '', /no seam here/);
});

test('an envelope that is not JSON, or that reports an error, is a named reason and never a throw', () => {
  const notJson = readProposal('Loading…', propose, 1);
  assert.equal(notJson.ok, false);
  if (!notJson.ok) assert.equal(notJson.reason, 'unreadable');

  const loggedOut = readProposal(
    JSON.stringify({ is_error: true, subtype: 'error', result: 'Please run /login to authenticate' }),
    propose,
    1,
  );
  assert.equal(loggedOut.ok, false);
  if (!loggedOut.ok) assert.equal(loggedOut.reason, 'auth');

  const wrongShape = readProposal(envelope({ nothing: true }), propose, 1);
  assert.equal(wrongShape.ok, false);
  if (!wrongShape.ok) assert.equal(wrongShape.reason, 'unreadable');
});

// The review's case: a test file the model names is real, and it is not a
// member. Reported as invented, it appeared on screen beside evidenceFor's
// list — which reads the whole graph, tests included — calling one path two
// different things.
test('a test the model names is dropped, not called invented', () => {
  const context: ProposeContext = {
    ...propose,
    files: [
      { path: 'src/a.ts', category: null },
      { path: 'src/b.ts', category: null },
      { path: 'src/c.ts', category: null },
    ],
    allPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.test.ts'],
  };
  const answer = JSON.stringify({
    structured_output: {
      groups: [
        { name: 'Core', sentence: 'The three of them.', files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/a.test.ts', 'src/nowhere.ts'] },
      ],
    },
    total_cost_usd: 0.01,
  });
  const out = readProposal(answer, context, 100);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  const group = out.groups[0];
  assert.deepEqual(group?.files, ['src/a.ts', 'src/b.ts', 'src/c.ts']);
  // Only the path the project genuinely has no file for.
  assert.deepEqual(group?.invented, ['src/nowhere.ts']);
});


import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '../graph/types.js';
import type { GroupSuggestion } from './groups.js';
import { attributionOf, changeFromHook, couplingNote } from './hook.js';

/** A node named after its id, unless told otherwise: a member's name is bare. */
function node(id: string, kind: NodeKind, filePath: string, name = id.slice(id.indexOf('#') + 1)): GraphNode {
  return { id, kind, name, filePath, range: { startLine: 1, endLine: 1 } };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}

/** This project's own shape: a store four files import and two call into. */
const store = graphOf(
  [
    node('src/graph/store.ts', 'file', 'src/graph/store.ts'),
    node('src/graph/store.ts#createStore', 'function', 'src/graph/store.ts'),
    node('src/graph/store.ts#applyBatch', 'function', 'src/graph/store.ts'),
    node('src/graph/store.ts#derive', 'function', 'src/graph/store.ts'),
    node('src/server/session.ts', 'file', 'src/server/session.ts'),
    node('src/server/session.ts#openSession', 'function', 'src/server/session.ts'),
    node('src/cli/index.ts', 'file', 'src/cli/index.ts'),
    node('src/cli/index.ts#main', 'function', 'src/cli/index.ts'),
    node('src/project/history.ts', 'file', 'src/project/history.ts'),
    node('src/server/live.ts', 'file', 'src/server/live.ts'),
  ],
  [
    { from: 'src/server/session.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/cli/index.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/project/history.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/server/live.ts', to: 'src/graph/store.ts', kind: 'imports' },
    { from: 'src/server/session.ts#openSession', to: 'src/graph/store.ts#createStore', kind: 'calls' },
    { from: 'src/server/session.ts#openSession', to: 'src/graph/store.ts#applyBatch', kind: 'calls' },
    { from: 'src/cli/index.ts#main', to: 'src/graph/store.ts#createStore', kind: 'calls' },
    // Inside the file, so it says nothing about who depends on it.
    { from: 'src/graph/store.ts#applyBatch', to: 'src/graph/store.ts#derive', kind: 'calls' },
  ],
);

test('the note is prose a person would write, and it names both halves', () => {
  assert.equal(
    couplingNote(store, 'src/graph/store.ts'),
    'src/graph/store.ts is imported by 4 files — src/cli/index.ts, src/project/history.ts, ' +
      'src/server/live.ts and src/server/session.ts. applyBatch and createStore are used from ' +
      'outside it.',
  );
});

test('no ratio is offered, because the graph cannot support one', () => {
  // The denominator used to be every non-file node, and it was wrong twice
  // over: an interface's own fields counted as symbols, and members dominate
  // the population while their use from outside is exactly what the graph
  // declines to track. So a file whose only reached symbol is a method must
  // read as one fact, not as one-in-four.
  const members = graphOf(
    [
      node('src/store.ts', 'file', 'src/store.ts'),
      node('src/store.ts#Store', 'class', 'src/store.ts'),
      node('src/store.ts#Store.open', 'method', 'src/store.ts', 'open'),
      node('src/store.ts#Store.path', 'field', 'src/store.ts', 'path'),
      node('src/store.ts#Options', 'interface', 'src/store.ts'),
      node('src/store.ts#Options.root', 'field', 'src/store.ts', 'root'),
      node('src/app.ts', 'file', 'src/app.ts'),
      node('src/app.ts#main', 'function', 'src/app.ts'),
    ],
    [{ from: 'src/app.ts#main', to: 'src/store.ts#Store.open', kind: 'calls' }],
  );

  const note = couplingNote(members, 'src/store.ts');
  assert.equal(note, 'open is used from outside src/store.ts.');
  assert.ok(!/\d+ of /.test(note), `the note still counts against a denominator: ${note}`);
});

test('nothing is said about a file the graph has never seen', () => {
  assert.equal(couplingNote(store, 'src/graph/nowhere.ts'), '');
  // A symbol id is not a file, and neither is a directory the view draws as a box.
  assert.equal(couplingNote(store, 'src/graph/store.ts#createStore'), '');
  assert.equal(couplingNote(store, 'src/graph'), '');
});

test('nothing is said about a file nothing depends on', () => {
  // session.ts imports and calls plenty; the hook still has nothing to tell the
  // agent about editing it, and a hook that always speaks stops being read.
  assert.equal(couplingNote(store, 'src/server/session.ts'), '');
});

test('a file with dependents but no symbols used from outside gets one sentence', () => {
  const onlyImports = graphOf(
    [node('a.ts', 'file', 'a.ts'), node('b.ts', 'file', 'b.ts')],
    [{ from: 'b.ts', to: 'a.ts', kind: 'imports' }],
  );
  assert.equal(couplingNote(onlyImports, 'a.ts'), 'a.ts is imported by 1 file — b.ts.');
});

test('a file nobody imports can still have symbols reached from outside', () => {
  // Go resolves a call through the package, not through a file's own import, so
  // the second sentence has to be able to stand on its own and name the file.
  const pkg = graphOf(
    [
      node('cmd/root.go', 'file', 'cmd/root.go'),
      node('cmd/root.go#Command', 'class', 'cmd/root.go'),
      node('cmd/root.go#Command.Execute', 'method', 'cmd/root.go', 'Execute'),
      node('main.go', 'file', 'main.go'),
      node('main.go#main', 'function', 'main.go'),
    ],
    [{ from: 'main.go#main', to: 'cmd/root.go#Command.Execute', kind: 'calls' }],
  );

  assert.equal(couplingNote(pkg, 'cmd/root.go'), 'Execute is used from outside cmd/root.go.');
});

test('a file is a caller too, and its call counts as a dependent', () => {
  // A call written outside every symbol belongs to the file — see GraphEdge.from
  // — so the edge's source is a file node, and reading its filePath must still
  // answer which file it came from.
  const topLevel = graphOf(
    [
      node('schema.ts', 'file', 'schema.ts'),
      node('schema.ts#object', 'function', 'schema.ts'),
      node('schema.ts#string', 'function', 'schema.ts'),
      node('app.ts', 'file', 'app.ts'),
    ],
    [{ from: 'app.ts', to: 'schema.ts#object', kind: 'calls' }],
  );

  assert.equal(couplingNote(topLevel, 'schema.ts'), 'object is used from outside schema.ts.');
});

test('a file that calls something it declares is not a dependent of itself', () => {
  // The store already refuses to draw that edge; this is the second guard, so a
  // file whose own top-level statement calls its own function is not reported
  // as coupled to itself.
  const selfCall = graphOf(
    [node('a.ts', 'file', 'a.ts'), node('a.ts#helper', 'function', 'a.ts')],
    [{ from: 'a.ts', to: 'a.ts#helper', kind: 'calls' }],
  );
  assert.equal(couplingNote(selfCall, 'a.ts'), '');
});

test('one over the cap is named, and two over are counted', () => {
  const importers = (count: number): Graph =>
    graphOf(
      [node('a.ts', 'file', 'a.ts'), ...Array.from({ length: count }, (_, i) => node(`i${i}.ts`, 'file', `i${i}.ts`))],
      Array.from({ length: count }, (_unused, i) => ({ from: `i${i}.ts`, to: 'a.ts', kind: 'imports' as const })),
    );

  // Four fit, because "and 1 more" costs the room the name would have taken.
  assert.equal(
    couplingNote(importers(4), 'a.ts'),
    'a.ts is imported by 4 files — i0.ts, i1.ts, i2.ts and i3.ts.',
  );
  assert.equal(
    couplingNote(importers(5), 'a.ts'),
    'a.ts is imported by 5 files — i0.ts, i1.ts, i2.ts and 2 more.',
  );
});

test('a long-pathed project loses the paths before it loses the names', () => {
  // A real monorepo path, and both sentences: separately either fits, together
  // they do not.
  const deep = (n: number): string => `packages/some-workspace-package/src/internal/generated/module-${n}.ts`;
  const wide = graphOf(
    [
      node(deep(0), 'file', deep(0)),
      node(`${deep(0)}#parseIncomingRequestBody`, 'function', deep(0)),
      node(`${deep(0)}#serialiseOutgoingResponse`, 'function', deep(0)),
      ...[1, 2, 3, 4].map((n) => node(deep(n), 'file', deep(n))),
      ...[1, 2].map((n) => node(`${deep(n)}#handle`, 'function', deep(n), 'handle')),
    ],
    [
      ...[1, 2, 3, 4].map((n) => ({ from: deep(n), to: deep(0), kind: 'imports' as const })),
      { from: `${deep(1)}#handle`, to: `${deep(0)}#parseIncomingRequestBody`, kind: 'calls' },
      { from: `${deep(2)}#handle`, to: `${deep(0)}#serialiseOutgoingResponse`, kind: 'calls' },
    ],
  );

  const note = couplingNote(wide, deep(0));
  assert.ok(note.length <= 400, `note was ${note.length} characters`);
  // The four paths are what will not fit; the two names cost a tenth as much
  // and are the half the agent could not have worked out from its own edit.
  assert.equal(
    note,
    `${deep(0)} is imported by 4 files. parseIncomingRequestBody and ` +
      'serialiseOutgoingResponse are used from outside it.',
  );
});

test('and when even the names will not fit, it counts them instead', () => {
  const deep = (n: number): string => `packages/some-workspace-package/src/internal/generated/module-${n}.ts`;
  // Generated code, where the name carries the whole contract.
  const long = (n: number): string =>
    `handleIncomingRequestForGeneratedModule${n}WithRetriesAndStructuredLoggingPayload`;
  const wide = graphOf(
    [
      node(deep(0), 'file', deep(0)),
      ...[1, 2, 3, 4, 5].map((n) => node(`${deep(0)}#${long(n)}`, 'function', deep(0), long(n))),
      ...[1, 2, 3, 4].map((n) => node(deep(n), 'file', deep(n))),
      ...[1, 2, 3, 4].map((n) => node(`${deep(n)}#handle`, 'function', deep(n), 'handle')),
    ],
    [
      ...[1, 2, 3, 4].map((n) => ({ from: deep(n), to: deep(0), kind: 'imports' as const })),
      ...[1, 2, 3, 4].map((n) => ({
        from: `${deep(n)}#handle`,
        to: `${deep(0)}#${long(n)}`,
        kind: 'calls' as const,
      })),
    ],
  );

  const note = couplingNote(wide, deep(0));
  assert.ok(note.length <= 400, `note was ${note.length} characters`);
  assert.equal(
    note,
    `${deep(0)} is imported by 4 files. 4 symbols are used from outside it.`,
  );
});

test('a path too long even to count against is silence, not half a sentence', () => {
  const absurd = `${'a/'.repeat(220)}file.ts`;
  const graph = graphOf(
    [node(absurd, 'file', absurd), node('b.ts', 'file', 'b.ts')],
    [{ from: 'b.ts', to: absurd, kind: 'imports' }],
  );
  assert.equal(couplingNote(graph, absurd), '');
});

/** One row of what `/api/clusters` answers, with the defaults an accepted name has. */
function category(name: string | null, files: string[], extra: Partial<GroupSuggestion> = {}): GroupSuggestion {
  return {
    id: `${files[0] ?? ''}~${files.length}`,
    files,
    cohesion: 1,
    name,
    state: name === null ? 'suggested' : 'accepted',
    depth: 0,
    parent: null,
    ...extra,
  };
}

/**
 * Two layers and an edge between them: the architecture a person drew, and one
 * file in the upper layer reaching into the lower one.
 */
const layers = graphOf(
  [
    node('ui/panel.ts', 'file', 'ui/panel.ts'),
    node('ui/panel.ts#render', 'function', 'ui/panel.ts'),
    node('ui/app.ts', 'file', 'ui/app.ts'),
    node('data/store.ts', 'file', 'data/store.ts'),
    node('data/store.ts#save', 'function', 'data/store.ts'),
  ],
  [
    { from: 'ui/app.ts', to: 'ui/panel.ts', kind: 'imports' },
    { from: 'ui/panel.ts', to: 'data/store.ts', kind: 'imports' },
    { from: 'ui/panel.ts#render', to: 'data/store.ts#save', kind: 'calls' },
  ],
);

const uiAndData = [category('UI', ['ui/panel.ts', 'ui/app.ts']), category('Data', ['data/store.ts'])];

test('the note says which category the file is in, and which one it reached into', () => {
  assert.equal(
    couplingNote(layers, 'ui/panel.ts', uiAndData),
    'ui/panel.ts is imported by 1 file — ui/app.ts. It is in the UI category, and reaches into Data.',
  );
});

test('a crossing is a fact and not a verdict', () => {
  // Nobody has declared a rule about which category may reach which, so the
  // sentence says where the edge went and stops. If this ever reads as a
  // judgement, decision 5 has been broken by wording rather than by code.
  const note = couplingNote(layers, 'ui/panel.ts', uiAndData);
  for (const verdict of ['should', 'must', 'violat', 'wrong', 'illegal', 'not allowed']) {
    assert.ok(!note.toLowerCase().includes(verdict), `the note passes judgement: ${note}`);
  }
});

test('a crossing on its own is worth breaking silence for', () => {
  // Nothing imports the file and nothing reaches its symbols, so before
  // categories this was silence. Which category it left is exactly the thing
  // the agent cannot work out from the edit it just made.
  const alone = graphOf(
    [
      node('ui/panel.ts', 'file', 'ui/panel.ts'),
      node('data/store.ts', 'file', 'data/store.ts'),
    ],
    [{ from: 'ui/panel.ts', to: 'data/store.ts', kind: 'imports' }],
  );
  assert.equal(
    couplingNote(alone, 'ui/panel.ts', uiAndData),
    'ui/panel.ts is in the UI category, and reaches into Data.',
  );
});

test('being in a category, with nothing else to say, is not worth saying', () => {
  // ui/app.ts imports inside its own category and nothing depends on it. A
  // hook that announced the category after every edit in a named project would
  // be the noise the ceiling exists to keep out.
  assert.equal(couplingNote(layers, 'ui/app.ts', uiAndData), '');
});

test('a call across the boundary counts, not only an import', () => {
  // Go and Python resolve plenty of edges the import line did not spell, and
  // an `extends` across a boundary is the same crossing an import is.
  const calls = graphOf(
    [
      node('ui/panel.ts', 'file', 'ui/panel.ts'),
      node('ui/panel.ts#render', 'function', 'ui/panel.ts'),
      node('data/store.ts', 'file', 'data/store.ts'),
      node('data/store.ts#save', 'function', 'data/store.ts'),
    ],
    [{ from: 'ui/panel.ts#render', to: 'data/store.ts#save', kind: 'calls' }],
  );
  assert.equal(
    couplingNote(calls, 'ui/panel.ts', uiAndData),
    'ui/panel.ts is in the UI category, and reaches into Data.',
  );
});

test('an unnamed or rejected category is not a category to name', () => {
  // A cluster nobody has named has no name to say, and a rejection is
  // somebody's word that it is not a piece of the architecture.
  const unnamed = [category(null, ['ui/panel.ts', 'ui/app.ts']), category(null, ['data/store.ts'])];
  assert.equal(couplingNote(layers, 'ui/panel.ts', unnamed), 'ui/panel.ts is imported by 1 file — ui/app.ts.');

  const rejected = uiAndData.map((c) => ({ ...c, state: 'rejected' as const }));
  assert.equal(couplingNote(layers, 'ui/panel.ts', rejected), 'ui/panel.ts is imported by 1 file — ui/app.ts.');

  // And with no categories at all the note is what it was before they existed.
  assert.equal(couplingNote(layers, 'ui/panel.ts'), 'ui/panel.ts is imported by 1 file — ui/app.ts.');
});

test('a category found inside another is the one named, because it says more', () => {
  const nested = [
    category('Engine', ['ui/panel.ts', 'ui/app.ts', 'data/store.ts'], { id: 'engine' }),
    category('Parser', ['ui/panel.ts', 'ui/app.ts'], { depth: 1, parent: 'engine' }),
    category('Data', ['data/store.ts']),
  ];
  assert.equal(
    couplingNote(layers, 'ui/panel.ts', nested),
    'ui/panel.ts is imported by 1 file — ui/app.ts. It is in the Parser category, and reaches into Data.',
  );
  // And a file the inner one does not hold falls back to the outer's name.
  assert.equal(
    couplingNote(layers, 'data/store.ts', [nested[0] as GroupSuggestion, nested[1] as GroupSuggestion]),
    'data/store.ts is imported by 1 file — ui/panel.ts. save is used from outside it. ' +
      'It is in the Engine category.',
  );
});

test('a file that reaches into many categories names three and counts the rest', () => {
  // Eleven categories is a real number: ~/Documents/astrup has that many, and
  // a file there that touched six would otherwise spend the whole ceiling on
  // a list nobody reads to the end.
  const names = ['Api', 'Auth', 'Charts', 'Data', 'Email', 'Jobs'];
  const wide = graphOf(
    [node('app.ts', 'file', 'app.ts'), ...names.map((n) => node(`${n}.ts`, 'file', `${n}.ts`))],
    names.map((n) => ({ from: 'app.ts', to: `${n}.ts`, kind: 'imports' as const })),
  );
  const many = [category('Shell', ['app.ts']), ...names.map((n) => category(n, [`${n}.ts`]))];
  assert.equal(
    couplingNote(wide, 'app.ts', many),
    'app.ts is in the Shell category, and reaches into Api, Auth, Charts and 3 more.',
  );
});

test('the category is the last thing dropped, because it is the cheapest', () => {
  // The same monorepo paths as above. Four of them will not fit beside two
  // symbol names; a pair of category names costs a tenth of one path, and is
  // the half the agent has no other way to ask for.
  const deep = (n: number): string => `packages/some-workspace-package/src/internal/generated/module-${n}.ts`;
  const wide = graphOf(
    [
      node(deep(0), 'file', deep(0)),
      node(`${deep(0)}#parseIncomingRequestBody`, 'function', deep(0)),
      node(`${deep(0)}#serialiseOutgoingResponse`, 'function', deep(0)),
      ...[1, 2, 3, 4].map((n) => node(deep(n), 'file', deep(n))),
      ...[1, 2].map((n) => node(`${deep(n)}#handle`, 'function', deep(n), 'handle')),
    ],
    [
      ...[1, 2, 3, 4].map((n) => ({ from: deep(n), to: deep(0), kind: 'imports' as const })),
      { from: deep(0), to: deep(4), kind: 'imports' },
      { from: `${deep(1)}#handle`, to: `${deep(0)}#parseIncomingRequestBody`, kind: 'calls' },
      { from: `${deep(2)}#handle`, to: `${deep(0)}#serialiseOutgoingResponse`, kind: 'calls' },
    ],
  );
  const split = [
    category('Transport', [deep(0), deep(1), deep(2), deep(3)]),
    category('Generated', [deep(4)]),
  ];

  const note = couplingNote(wide, deep(0), split);
  assert.ok(note.length <= 400, `note was ${note.length} characters`);
  assert.equal(
    note,
    `${deep(0)} is imported by 4 files. parseIncomingRequestBody and serialiseOutgoingResponse ` +
      'are used from outside it. It is in the Transport category, and reaches into Generated.',
  );
});

/**
 * `PostToolUse` arrives with a path Claude Code has already resolved, and the
 * server was started on whatever the shell said. On macOS every `/tmp` and
 * `/var` path is one symlink from its real name, so those are two spellings of
 * one directory and `path.relative` between them starts with `..` — the edit
 * reads as being outside the project and is dropped. A whole review ran with
 * the Repository panel reading "Hook ✓ installed" over five hook calls that
 * had every one answered `{"accepted":false}`.
 */
test('a file reached through a symlinked root is still inside the project', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'codemap-hook-'));
  try {
    const real = path.join(base, 'project');
    await mkdir(path.join(real, 'src'), { recursive: true });
    await writeFile(path.join(real, 'src', 'index.ts'), 'export const x = 1;\n');
    const link = path.join(base, 'link');
    await symlink(real, link);

    const resolved = path.join(await realpath(real), 'src', 'index.ts');

    // The agent's spelling of the file, the server's spelling of the root.
    assert.deepEqual(
      await changeFromHook({ tool_input: { file_path: path.join(link, 'src', 'index.ts') } }, real),
      { filePath: 'src/index.ts', absolutePath: resolved, kind: 'changed' },
    );
    // And the other way round, because either side can be the linked one.
    assert.deepEqual(
      await changeFromHook({ tool_input: { file_path: path.join(real, 'src', 'index.ts') } }, link),
      { filePath: 'src/index.ts', absolutePath: resolved, kind: 'changed' },
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('a file deleted through a symlinked root is reported removed, not ignored', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'codemap-hook-'));
  try {
    const real = path.join(base, 'project');
    await mkdir(path.join(real, 'src'), { recursive: true });
    const link = path.join(base, 'link');
    await symlink(real, link);

    // Nothing was ever written there: the directory carries the link, and the
    // file that is gone has no path of its own left to resolve.
    assert.deepEqual(
      await changeFromHook({ tool_input: { file_path: path.join(link, 'src', 'gone.ts') } }, real),
      { filePath: 'src/gone.ts', absolutePath: path.join(await realpath(real), 'src', 'gone.ts'), kind: 'removed' },
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('resolving the links does not widen the project past its own root', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'codemap-hook-'));
  try {
    const real = path.join(base, 'project');
    await mkdir(real, { recursive: true });
    await mkdir(path.join(base, 'elsewhere'), { recursive: true });
    await writeFile(path.join(base, 'elsewhere', 'other.ts'), '');

    assert.equal(
      await changeFromHook({ tool_input: { file_path: path.join(base, 'elsewhere', 'other.ts') } }, real),
      null,
    );
    // A build directory inside the project is still not the project's source.
    await mkdir(path.join(real, 'node_modules', 'dep'), { recursive: true });
    assert.equal(
      await changeFromHook({ tool_input: { file_path: path.join(real, 'node_modules', 'dep', 'index.js') } }, real),
      null,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

/**
 * The payload Claude Code 2.1.263 actually sends, as read out of the binary:
 * the base envelope plus PostToolUse's own fields. Kept whole rather than
 * trimmed to what `attributionOf` reads, because the point of these tests is
 * that a real payload is recognised and a payload that is not one is not.
 */
const claudeCodePayload = {
  session_id: '019R7fpd-phLD-4b6A-1Yr4-iR6c00000000',
  transcript_path: '/Users/x/.claude/projects/-tmp-tasky/019R7fpd.jsonl',
  cwd: '/tmp/tasky',
  permission_mode: 'acceptEdits',
  effort: 'high',
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: '/tmp/tasky/tasky/models.py' },
  tool_response: { filePath: '/tmp/tasky/tasky/models.py', success: true },
  tool_use_id: 'toolu_01ABC',
  duration_ms: 41,
};

test('a real Claude Code payload is recognised, and says what it was recognised by', () => {
  assert.deepEqual(attributionOf(claudeCodePayload), {
    agent: 'Claude Code',
    how: 'recognised',
    tool: 'Edit',
    subagent: null,
    session: '019R7fpd-phLD-4b6A-1Yr4-iR6c00000000',
  });
});

test('a subagent inside the session is named, because the payload names it', () => {
  // agent_type is a real field: Claude Code puts the subagent's type in it
  // when a Task, not the main loop, made the edit.
  assert.equal(
    attributionOf({ ...claudeCodePayload, agent_type: 'code-reviewer' })?.subagent,
    'code-reviewer',
  );
});

test('a caller that names itself is taken at its word, and the word is marked as one', () => {
  assert.deepEqual(attributionOf({ agent: 'Cursor', tool_input: { file_path: '/tmp/a.ts' } }), {
    agent: 'Cursor',
    how: 'declared',
    tool: null,
    subagent: null,
    session: null,
  });
});

test('a declared name wins over the envelope, so a wrapper is not reported as Claude Code', () => {
  // The case this protects: something that forwards Claude Code's payload
  // unchanged but is not Claude Code. It only has to add one field to say so.
  const forwarded = { ...claudeCodePayload, agent: 'my-relay' };
  assert.equal(attributionOf(forwarded)?.agent, 'my-relay');
  assert.equal(attributionOf(forwarded)?.how, 'declared');
});

test('a payload that says nothing about itself attributes nothing', () => {
  // The shape every caller before this change sent, and the shape a minimal
  // third-party integration sends. Accepted as a change, named as nobody.
  assert.equal(attributionOf({ tool_input: { file_path: '/tmp/tasky/tasky/models.py' } }), null);
});

test('half of Claude Code’s envelope is not Claude Code', () => {
  // One field is a shape another tool could arrive at by accident, and the
  // cost of getting this wrong is printing the wrong product's name over
  // somebody's work. Both, or neither.
  assert.equal(attributionOf({ hook_event_name: 'PostToolUse' }), null);
  assert.equal(attributionOf({ session_id: 'abc' }), null);
});

test('a name that is not a name is not one', () => {
  assert.equal(attributionOf({ agent: '   ' }), null);
  assert.equal(attributionOf({ agent: 42 }), null);
  assert.equal(attributionOf({ agent: { name: 'x' } }), null);
  // Whitespace is trimmed rather than carried onto the page.
  assert.equal(attributionOf({ agent: '  Aider  ' })?.agent, 'Aider');
});

test('a name is clipped to a name, not a paragraph', () => {
  const shouting = 'x'.repeat(200);
  assert.equal(attributionOf({ agent: shouting })?.agent.length, 40);
});

test('an empty envelope field is as absent as a missing one', () => {
  // Claude Code always fills both, so this is a foreign caller sending the
  // shape and not the substance.
  assert.equal(attributionOf({ ...claudeCodePayload, session_id: '' }), null);
  assert.equal(attributionOf({ ...claudeCodePayload, hook_event_name: '  ' }), null);
});

// Reported by the review: the hook said one category and the diagram drew
// another. A found group and a hand-drawn one both held render.py, neither
// nested in the other, and the hook's own tie-break took the smaller while
// partitionByCategory takes the first listed. Two names for one file is the
// one thing the hook must never do.
test('the hook names the category the component diagram draws, not a closer-looking one', () => {
  const graph = graphOf(
    [
      node('tasky/render.py', 'file', 'tasky/render.py'),
      node('tasky/cli.py', 'file', 'tasky/cli.py'),
      node('tasky/render.py#line', 'function', 'tasky/render.py'),
    ],
    [{ from: 'tasky/cli.py', to: 'tasky/render.py', kind: 'imports' }],
  );
  // The order /api/clusters answers in: found groups before hand-drawn ones.
  const found = category('Task core', ['tasky/render.py', 'tasky/cli.py', 'tasky/models.py', 'tasky/storage.py', 'tasky/commands.py']);
  const drawn = category('Rendering', ['tasky/render.py', 'tests/test_progress.py'], { origin: 'manual' });

  const note = couplingNote(graph, 'tasky/render.py', [found, drawn]);
  assert.match(note, /Task core/);
  assert.doesNotMatch(note, /Rendering/);
});


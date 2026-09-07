import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GitStatus } from '../git/types.js';
import type { Graph, GraphEdge, GraphNode, NodeKind } from '../graph/types.js';
import type { ProjectFacts } from '../lang/types.js';
import {
  MAX_ROOTS,
  ROOT_WHY,
  TEST_ONLY_WHY,
  overviewOf,
  type AgentCallInput,
  type CategoriesInput,
} from './overview.js';

function node(id: string, kind: NodeKind, extra: Partial<GraphNode> = {}): GraphNode {
  const hash = id.indexOf('#');
  return {
    id,
    kind,
    name: hash === -1 ? id.slice(id.lastIndexOf('/') + 1) : id.slice(hash + 1),
    filePath: hash === -1 ? id : id.slice(0, hash),
    range: { startLine: 1, endLine: 1 },
    ...extra,
  };
}

function graphOf(nodes: GraphNode[], edges: GraphEdge[]): Graph {
  return { nodes: new Map(nodes.map((one) => [one.id, one])), edges };
}

const NO_FACTS: ProjectFacts = { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() };
const NO_CATEGORIES: CategoriesInput = { clusters: [], orphans: [] };

/**
 * A small Next project: a page and a main the manifests name, a script and
 * a config nothing names, a module only its test reaches, a declaration file,
 * and a file reached only through a call from another file's function.
 */
const FIXTURE = graphOf(
  [
    node('src/index.ts', 'file'),
    node('src/a.ts', 'file'),
    node('src/a.ts#fn', 'function'),
    node('src/b.ts', 'file'),
    node('src/b.ts#Klass', 'class'),
    node('src/c.ts', 'file'),
    node('src/c.ts#helper', 'function'),
    node('src/lonely.ts', 'file'),
    node('src/lonely.test.ts', 'file'),
    node('src/config.ts', 'file', { parseError: true }),
    node('scripts/backfill.ts', 'file'),
    node('app/page.tsx', 'file'),
    node('next-env.d.ts', 'file'),
  ],
  [
    { from: 'src/index.ts', to: 'src/a.ts', kind: 'imports' },
    { from: 'src/index.ts', to: 'src/b.ts', kind: 'imports' },
    { from: 'src/a.ts', to: 'src/b.ts', kind: 'imports' },
    { from: 'src/a.ts', to: 'src/a.ts#fn', kind: 'contains' },
    { from: 'src/b.ts', to: 'src/b.ts#Klass', kind: 'contains' },
    { from: 'src/c.ts', to: 'src/c.ts#helper', kind: 'contains' },
    // Reached by a call and by nothing else: still reached.
    { from: 'src/a.ts#fn', to: 'src/c.ts#helper', kind: 'calls' },
    { from: 'src/lonely.test.ts', to: 'src/lonely.ts', kind: 'imports' },
    { from: 'scripts/backfill.ts', to: 'src/a.ts', kind: 'imports' },
    { from: 'scripts/backfill.ts', to: 'src/b.ts', kind: 'imports' },
    // Twice to the same file is one file imported.
    { from: 'scripts/backfill.ts', to: 'src/b.ts', kind: 'imports' },
    { from: 'app/page.tsx', to: 'src/a.ts', kind: 'imports' },
  ],
);

const FACTS: ProjectFacts = {
  ...NO_FACTS,
  entryPoints: [
    { file: 'app/page.tsx', why: 'Next.js page' },
    // Named at boot, gone from the graph since: not a link.
    { file: 'src/gone.ts', why: 'package.json bin' },
    { file: 'src/index.ts', why: 'package.json main' },
  ],
};

test('roots are source files no source reaches, minus what a manifest already names', () => {
  const overview = overviewOf(FIXTURE, FACTS, NO_CATEGORIES, null, [], []);

  assert.deepEqual(overview.entryPoints.manifest, [
    { file: 'app/page.tsx', why: 'Next.js page' },
    { file: 'src/index.ts', why: 'package.json main' },
  ]);

  // Most-importing first; the script pulls in two files, the config none.
  // index.ts is a root too, and is not repeated here because the manifest
  // named it. The test and the declaration file are not candidates at all.
  assert.deepEqual(overview.entryPoints.roots, [
    { file: 'scripts/backfill.ts', why: ROOT_WHY, imports: 2 },
    { file: 'src/config.ts', why: ROOT_WHY, imports: 0 },
    { file: 'src/lonely.ts', why: TEST_ONLY_WHY, imports: 0 },
  ]);
  assert.equal(overview.entryPoints.rootsTotal, 3);
});

test('the project is counted off the graph, and the unreadable census passes through', () => {
  const unreadable = [{ extension: '.sh', files: 3 }];
  const { project } = overviewOf(FIXTURE, NO_FACTS, NO_CATEGORIES, null, [], unreadable);

  // Ten files; the three symbols are nodes and not files.
  assert.equal(project.files, 10);
  assert.equal(project.tests, 1);
  assert.equal(project.parseErrors, 1);
  assert.deepEqual(project.languages, [{ id: 'typescript', label: 'TypeScript', files: 10 }]);
  assert.deepEqual(project.unreadable, unreadable);
  assert.notEqual(project.unreadable, unreadable);
});

test('without gathered facts every root is listed, and the list is capped with its total', () => {
  const many = graphOf(
    Array.from({ length: MAX_ROOTS + 3 }, (_, index) => node(`src/f${String(index).padStart(2, '0')}.ts`, 'file')),
    [],
  );
  const { entryPoints } = overviewOf(many, NO_FACTS, NO_CATEGORIES, null, [], []);

  assert.deepEqual(entryPoints.manifest, []);
  assert.equal(entryPoints.roots.length, MAX_ROOTS);
  assert.equal(entryPoints.rootsTotal, MAX_ROOTS + 3);
  assert.equal(entryPoints.roots[0]?.file, 'src/f00.ts');
});

test('categories: accepted names with their ids, unnamed counted, rejected neither, drawn ones without a cohesion', () => {
  const categories: CategoriesInput = {
    clusters: [
      { id: 'src/a.ts~3', storedId: 'src/a.ts~3', name: 'Core', state: 'accepted', files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], cohesion: 0.8, depth: 0 },
      { id: 'src/x.ts~3', name: null, state: 'suggested', files: ['src/x.ts', 'src/y.ts', 'src/z.ts'], cohesion: 0.5, depth: 0 },
      { id: 'src/x.ts~2', name: null, state: 'suggested', files: ['src/x.ts', 'src/y.ts'], cohesion: 0.5, depth: 1 },
      { id: 'src/r.ts~3', storedId: 'src/r.ts~3', name: 'Old', state: 'rejected', files: ['src/r.ts', 'src/s.ts', 'src/t.ts'], cohesion: 0.4, depth: 0 },
      { id: 'manual:drawn', storedId: 'manual:drawn', name: 'Drawn', state: 'accepted', files: ['src/p.ts', 'src/q.ts'], cohesion: 0, depth: 0, origin: 'manual' },
    ],
    orphans: [{ storedId: 'src/old.ts~4', name: 'Gone', files: ['src/old.ts'] }],
  };
  const overview = overviewOf(FIXTURE, NO_FACTS, categories, null, [], []);

  assert.deepEqual(overview.categories, {
    named: [
      { storedId: 'src/a.ts~3', name: 'Core', files: 3, cohesion: 0.8, depth: 0 },
      { storedId: 'manual:drawn', name: 'Drawn', files: 2, cohesion: null, depth: 0, origin: 'manual' },
    ],
    unnamed: 2,
    orphans: 1,
  });
});

test('changes: counted by status, files the graph holds first, and null outside a repository', () => {
  const git: GitStatus = {
    base: 'abc1234',
    requested: 'HEAD',
    branch: 'main',
    files: { 'README.md': 'modified', 'src/a.ts': 'modified', 'src/new.ts': 'untracked' },
    lines: {},
    totals: { added: 10, deleted: 2 },
  };
  const overview = overviewOf(FIXTURE, NO_FACTS, NO_CATEGORIES, git, [], []);

  assert.deepEqual(overview.changes, {
    base: 'abc1234',
    requested: 'HEAD',
    branch: 'main',
    total: 3,
    byStatus: { modified: 2, added: 0, deleted: 0, untracked: 1, renamed: 0 },
    lines: { added: 10, deleted: 2 },
    files: [
      { file: 'src/a.ts', status: 'modified', inGraph: true },
      { file: 'README.md', status: 'modified', inGraph: false },
      { file: 'src/new.ts', status: 'untracked', inGraph: false },
    ],
  });
  assert.equal(overviewOf(FIXTURE, NO_FACTS, NO_CATEGORIES, null, [], []).changes, null);
});

test('agent: the last call, and the last call that carried a note', () => {
  const calls: AgentCallInput[] = [
    { at: 1, tool: 'describe_file', target: 'src/a.ts' },
    { at: 2, tool: 'note_change', target: null, note: 'moved fn into a.ts', files: ['src/a.ts'] },
    { at: 3, tool: 'search_symbols', target: 'Klass' },
  ];
  const { agent } = overviewOf(FIXTURE, NO_FACTS, NO_CATEGORIES, null, calls, []);

  assert.equal(agent.total, 3);
  assert.equal(agent.lastAt, 3);
  assert.equal(agent.last, calls[2]);
  assert.equal(agent.lastNote, calls[1]);

  const quiet = overviewOf(FIXTURE, NO_FACTS, NO_CATEGORIES, null, [], []).agent;
  assert.deepEqual(quiet, { total: 0, lastAt: null, last: null, lastNote: null });
});

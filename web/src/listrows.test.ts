import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `layout.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no listrows.js for `node --test` to find.
import { holdOrder, letterStatus, nextSort, presentationChip, rowsOf, sortRows, type ListRow } from './listrows.ts';

type Node = Parameters<typeof rowsOf>[0]['nodes'][number];
type Edge = Parameters<typeof rowsOf>[0]['edges'][number];

const file = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  kind: 'file',
  label: id,
  members: [],
  files: [id],
  external: false,
  focused: false,
  gitStatus: null,
  gitChanged: 0,
  language: 'typescript',
  test: false,
  parseError: false,
  ...extra,
});

const folder = (id: string, files: string[], external: boolean): Node => ({
  ...file(id),
  kind: 'folder',
  files,
  external,
  language: null,
});

const edge = (from: string, to: string, weight = 1): Edge => ({ from, to, kind: 'imports', weight });

/**
 * astrupdata's `lib` in miniature: three files inside, a directory outside
 * that two of them import from, and one line out to another outside
 * directory carrying three imports.
 */
const view = {
  nodes: [
    file('lib/a.ts'),
    file('lib/b.ts', { test: true }),
    file('lib/c.ts', { gitStatus: 'modified', gitChanged: 1 }),
    folder('app', ['app/x.ts', 'app/y.ts'], true),
    folder('components', ['components/z.tsx'], true),
  ],
  edges: [
    edge('app', 'lib/a.ts', 2),
    edge('app', 'lib/c.ts'),
    edge('lib/a.ts', 'lib/c.ts'),
    edge('lib/b.ts', 'components', 3),
  ],
};

const ids = (rows: readonly ListRow[]) => rows.map((row) => row.id);

test('a row counts the lines into it and out of it, weight and all, outside boxes included', () => {
  const rows = rowsOf(view);
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.equal(byId.get('lib/c.ts')?.in, 2);
  assert.equal(byId.get('lib/c.ts')?.out, 0);
  assert.equal(byId.get('lib/a.ts')?.in, 2);
  assert.equal(byId.get('lib/a.ts')?.out, 1);
  // The outside directory's line is on the view, so it is counted on both ends.
  assert.equal(byId.get('app')?.out, 3);
  assert.equal(byId.get('components')?.in, 3);
  // A folder counts the files it stands for where a file counts its symbols.
  assert.equal(byId.get('app')?.members, 2);
  assert.equal(byId.get('lib/a.ts')?.members, 0);
});

test('a count sorts biggest first on the first click, a name A to Z, and a second click flips', () => {
  const rows = rowsOf(view);
  assert.deepEqual(ids(sortRows(rows, { key: 'in', dir: 'desc' })).slice(0, 2), ['components', 'lib/a.ts']);
  // Ties fall back to the name, inside before outside: c has 2 in like a, and
  // sorts after it by name; the two zeros are b then app.
  assert.deepEqual(ids(sortRows(rows, { key: 'in', dir: 'desc' })), [
    'components',
    'lib/a.ts',
    'lib/c.ts',
    'lib/b.ts',
    'app',
  ]);
  assert.deepEqual(ids(sortRows(rows, { key: 'name', dir: 'asc' })), [
    'lib/a.ts',
    'lib/b.ts',
    'lib/c.ts',
    'app',
    'components',
  ]);
  assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, 'in'), { key: 'in', dir: 'desc' });
  assert.deepEqual(nextSort({ key: 'in', dir: 'desc' }, 'in'), { key: 'in', dir: 'asc' });
  assert.deepEqual(nextSort({ key: 'in', dir: 'asc' }, 'name'), { key: 'name', dir: 'asc' });
  // git puts the changed file first; test puts the test first.
  assert.equal(ids(sortRows(rows, { key: 'git', dir: 'desc' }))[0], 'lib/c.ts');
  assert.equal(ids(sortRows(rows, { key: 'test', dir: 'desc' }))[0], 'lib/b.ts');
});

test('a live update marks a row and moves none: the held order survives a count that changed', () => {
  const held = ['components', 'lib/a.ts', 'lib/c.ts', 'lib/b.ts', 'app'];
  // The agent's save gave b three more lines in, so the sort would now put
  // it first. The reader's cursor is on the third row, and it stays there.
  const resorted = ['lib/b.ts', 'components', 'lib/a.ts', 'lib/c.ts', 'app'];
  assert.deepEqual(holdOrder(held, resorted), held);
});

test('a new row lands where the sort would put it among the rows already standing', () => {
  const held = ['components', 'lib/a.ts', 'lib/c.ts', 'lib/b.ts', 'app'];
  // A new file with one line in sorts between c (2) and b (0).
  const sorted = ['components', 'lib/a.ts', 'lib/c.ts', 'lib/new.ts', 'lib/b.ts', 'app'];
  assert.deepEqual(holdOrder(held, sorted), ['components', 'lib/a.ts', 'lib/c.ts', 'lib/new.ts', 'lib/b.ts', 'app']);
  // Even when the held order disagrees with the sort: the new row goes after
  // the last standing row that sorts before it, and nothing else moves.
  const shuffled = ['app', 'lib/b.ts', 'components', 'lib/a.ts', 'lib/c.ts'];
  assert.deepEqual(holdOrder(shuffled, sorted), ['app', 'lib/b.ts', 'components', 'lib/a.ts', 'lib/c.ts', 'lib/new.ts']);
  // A row that sorts before everything standing goes to the top.
  assert.deepEqual(holdOrder(['b', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('a row that has gone is dropped, and with nothing held the sort is the order', () => {
  assert.deepEqual(holdOrder(['a', 'b', 'c'], ['c', 'a']), ['a', 'c']);
  assert.deepEqual(holdOrder(null, ['c', 'a']), ['c', 'a']);
  assert.deepEqual(holdOrder(['a'], []), []);
});

test('the chip says how the slice is shown, and only when there is something to say', () => {
  assert.equal(presentationChip(undefined, 'diagram', 12, 30), null);
  const list = presentationChip(undefined, 'list', 106, 30);
  assert.equal(list?.label, '106 boxes — shown as a list');
  assert.equal(list?.action, 'draw');
  assert.equal(list?.warning, false);
  const forced = presentationChip('diagram', 'diagram', 106, 30);
  assert.equal(forced?.label, '106 boxes — drawn anyway');
  assert.equal(forced?.action, 'drop');
  assert.equal(forced?.warning, true);
  assert.equal(presentationChip('diagram', 'diagram', 12, 30)?.warning, false);
  assert.equal(presentationChip('list', 'list', 12, 30)?.action, 'drop');
});

test('under a diff a row wears the diff’s letter where git’s went, and sorts by it', () => {
  const rows = rowsOf({
    nodes: [
      file('lib/same.ts', { gitStatus: 'modified' }),
      file('lib/gone.ts', { change: 'removed' }),
      // git says untracked; the diff says added, and the diff is what is drawn.
      file('lib/new.ts', { change: 'added', gitStatus: 'untracked' }),
      file('lib/moved.ts', { change: 'touched' }),
    ],
    edges: [],
  });
  assert.deepEqual(
    rows.map((row) => letterStatus(row)),
    ['modified', 'deleted', 'added', 'modified'],
  );
  // Changed first, in git's own order of what happened — the diff's letters
  // sorted among git's, not after them.
  assert.deepEqual(ids(sortRows(rows, { key: 'git', dir: 'desc' })), [
    'lib/moved.ts',
    'lib/same.ts',
    'lib/new.ts',
    'lib/gone.ts',
  ]);
});

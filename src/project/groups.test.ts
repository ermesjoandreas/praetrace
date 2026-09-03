import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Cluster } from '../view/cluster.js';
import { applyDecision, mergeGroups, storedIdFor, type NamedGroup } from './groups.js';

const files = (prefix: string, count: number): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}${index + 1}.ts`);

function cluster(members: string[], children: Cluster[] = []): Cluster {
  const sorted = [...members].sort();
  return { id: `${sorted[0]}~${sorted.length}`, files: sorted, cohesion: 0.8, children };
}

function accepted(name: string, members: string[], extra: Partial<NamedGroup> = {}): NamedGroup {
  const sorted = [...members].sort();
  return { name, id: `${sorted[0]}~${sorted.length}`, files: sorted, state: 'accepted', ...extra };
}

test('a group that grew keeps its name: four stored files inside a cluster of seven', () => {
  const viewSelection = accepted('View selection', ['live.ts', 'filter.ts', 'select.ts', 'types.ts']);
  const grown = cluster([...viewSelection.files, 'git-types.ts', 'search.ts', 'detail.ts']);

  const { clusters, orphans } = mergeGroups([grown], [viewSelection]);
  assert.equal(clusters[0]?.name, 'View selection');
  assert.equal(clusters[0]?.storedId, 'filter.ts~4');
  assert.deepEqual(orphans, []);
});

test('a group that changed members keeps its name at 60% overlap, and loses it below', () => {
  const stored = accepted('Parsing', files('p', 10));
  // Eight of ten kept, two new: 8 shared of 12 in the union.
  const drifted = cluster([...files('p', 8), 'x.ts', 'y.ts']);
  assert.equal(mergeGroups([drifted], [stored]).clusters[0]?.name, 'Parsing');

  // Four of ten kept, five new: 4 of 15. (Not five kept: a cluster of ten
  // starting at p1 would wear the stored id and match outright.)
  const gone = cluster([...files('p', 4), ...files('z', 5)]);
  const { clusters, orphans } = mergeGroups([gone], [stored]);
  assert.equal(clusters[0]?.name, null);
  assert.deepEqual(orphans, [{ storedId: 'p1.ts~10', name: 'Parsing', files: [...files('p', 10)].sort() }]);
});

test('a stored group swallowed by a cluster more than twice its size is an orphan, not the name of the whole', () => {
  const watching = accepted('File watching', ['hook.ts', 'walk.ts', 'watch.ts']);
  const blob = cluster([...watching.files, ...files('b', 20)]);

  const { clusters, orphans } = mergeGroups([blob], [watching]);
  assert.equal(clusters[0]?.name, null);
  assert.deepEqual(orphans.map((orphan) => orphan.name), ['File watching']);
});

test('nested groups come out with parent set, each wearing its own name and not its parent\'s', () => {
  const inner = files('a', 8);
  const outer = [...inner, ...files('b', 3)];
  const tree = cluster(outer, [cluster(inner), cluster(files('b', 3))]);
  const stored = [accepted('Graph engine', outer), accepted('Parsing', inner)];

  const { clusters } = mergeGroups([tree], stored);
  assert.deepEqual(
    clusters.map((group) => [group.name, group.depth, group.parent]),
    [
      ['Graph engine', 0, null],
      ['Parsing', 1, 'a1.ts~11'],
      [null, 1, 'a1.ts~11'],
    ],
  );
});

test('a child\'s name is not taken by the parent walked first, even when only the child is stored', () => {
  // The stored child overlaps the outer cluster at 8 of 11 = 73%; its own
  // cluster grew by one, 8 of 9. Best-first pairing gives it to the child.
  const parsing = accepted('Parsing', files('a', 8));
  const child = cluster([...files('a', 8), 'a9.ts']);
  const tree = cluster([...child.files, ...files('b', 2)], [child, cluster(files('b', 2))]);

  const { clusters } = mergeGroups([tree], [parsing]);
  assert.deepEqual(
    clusters.map((group) => group.name),
    [null, 'Parsing', null],
  );
});

test('the same input merges the same way twice', () => {
  const stored = [accepted('One', files('a', 4)), accepted('Two', files('b', 4)), accepted('Old', files('z', 3))];
  const found = [cluster([...files('a', 4), 'c.ts']), cluster([...files('b', 4), 'd.ts'])];
  assert.deepEqual(mergeGroups(found, stored), mergeGroups(found, stored));
  assert.deepEqual(
    mergeGroups(found, stored).orphans.map((orphan) => orphan.name),
    ['Old'],
  );
});

test('a hand-drawn group is never matched, never an orphan, and still listed', () => {
  const drawn: NamedGroup = { name: 'Lang', id: 'manual:lang', files: files('a', 4), state: 'accepted', origin: 'manual' };
  const { clusters, orphans } = mergeGroups([cluster(files('a', 4))], [drawn]);
  assert.deepEqual(
    clusters.map((group) => [group.name, group.origin ?? null]),
    [
      [null, null],
      ['Lang', 'manual'],
    ],
  );
  assert.deepEqual(orphans, []);
});

test('a rejected group that matches nothing is not an orphan: there is no name to show', () => {
  const rejected: NamedGroup = { name: '', id: 'r1.ts~3', files: files('r', 3), state: 'rejected' };
  assert.deepEqual(mergeGroups([cluster(files('a', 3))], [rejected]).orphans, []);
});

test('renaming a drifted group by storedId replaces it in place, never appends', () => {
  const stored = [
    accepted('HTTP surface', files('h', 7)),
    accepted('View selection', ['live.ts', 'filter.ts', 'select.ts', 'types.ts'], { color: 'teal' }),
    accepted('Parsing', files('p', 8)),
  ];
  const grown = [...(stored[1]?.files ?? []), 'git-types.ts', 'search.ts', 'detail.ts'].sort();

  const next = applyDecision(stored, grown, {
    name: 'View layer',
    state: 'accepted',
    id: 'detail.ts~7',
    storedId: 'filter.ts~4',
  });
  assert.equal(next.length, 3);
  assert.deepEqual(
    next.map((group) => [group.name, group.id]),
    [
      ['HTTP surface', 'h1.ts~7'],
      ['View layer', 'detail.ts~7'],
      ['Parsing', 'p1.ts~8'],
    ],
  );
  // A rename is not a decision about the colour.
  assert.equal(next[1]?.color, 'teal');
  assert.deepEqual(next[1]?.files, grown);
});

test('a decision naming a child does not touch the stored parent it overlaps', () => {
  const parent = accepted('Graph engine', files('a', 11));
  const child = files('a', 8);
  const next = applyDecision([parent], child, { name: 'Parsing', state: 'accepted', id: 'a1.ts~8' });
  assert.deepEqual(
    next.map((group) => [group.name, group.files.length]),
    [
      ['Graph engine', 11],
      ['Parsing', 8],
    ],
  );
});

test('storedIdFor settles a decision that arrived with files only, the way the panel would', () => {
  const stored = [accepted('View selection', ['live.ts', 'filter.ts', 'select.ts', 'types.ts'])];
  const grown = cluster([...(stored[0]?.files ?? []), 'git-types.ts', 'search.ts', 'detail.ts']);
  const other = cluster(files('q', 3));

  assert.equal(storedIdFor([grown, other], stored, [...grown.files].reverse()), 'filter.ts~4');
  assert.equal(storedIdFor([grown, other], stored, other.files), undefined);
  // Applied: one entry, renamed and grown, not two.
  const storedId = storedIdFor([grown, other], stored, grown.files);
  const next = applyDecision(stored, grown.files, {
    name: 'View selection',
    state: 'accepted',
    id: grown.id,
    ...(storedId === undefined ? {} : { storedId }),
  });
  assert.equal(next.length, 1);
  assert.equal(next[0]?.id, grown.id);
});

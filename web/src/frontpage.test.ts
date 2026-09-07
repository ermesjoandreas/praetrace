import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `listrows.test.ts` beside it: the page is bundled by vite and never
// compiled into dist/, so there is no frontpage.js for `node --test` to find.
import {
  FOLD_MANIFEST_AT,
  changesSummary,
  homeSearch,
  isFrontPage,
  manifestGroups,
  rootDiagramSearch,
  splitPath,
} from './frontpage.ts';

test('the front page is a bare URL, or one naming only a commit', () => {
  assert.equal(isFrontPage(''), true);
  assert.equal(isFrontPage('?'), true);
  assert.equal(isFrontPage('?at=7fe7f88'), true);
});

test('every URL that names a place, a filter or a presentation is not the front page', () => {
  // The key's presence, not its value: `?scope=` is the root diagram.
  assert.equal(isFrontPage('?scope='), false);
  assert.equal(isFrontPage('?scope=src'), false);
  assert.equal(isFrontPage('?focus=src/a.ts'), false);
  assert.equal(isFrontPage('?category=lib/x.ts~8'), false);
  assert.equal(isFrontPage('?diagram=components'), false);
  assert.equal(isFrontPage('?diff=base'), false);
  assert.equal(isFrontPage('?changed=1'), false);
  assert.equal(isFrontPage('?tests=0'), false);
  assert.equal(isFrontPage('?as=list'), false);
  assert.equal(isFrontPage('?edges=imports,extends,implements,calls'), false);
  assert.equal(isFrontPage('?at=7fe7f88&scope='), false);
});

test('the front page and the root diagram are each other’s way out, and both keep the commit', () => {
  // Home is the bare URL, and a bare URL is home: the two helpers agree with
  // the reader, or a "root" crumb could land somewhere that is not the page.
  assert.equal(homeSearch(null), '');
  assert.equal(isFrontPage(homeSearch(null)), true);
  assert.equal(homeSearch('7fe7f88'), '?at=7fe7f88');
  assert.equal(isFrontPage(homeSearch('7fe7f88')), true);
  // The old root diagram: the key present with nothing after it, drawn
  // whatever its size.
  assert.equal(rootDiagramSearch(null), '?scope=&as=diagram');
  assert.equal(isFrontPage(rootDiagramSearch(null)), false);
  assert.equal(rootDiagramSearch('7fe7f88'), '?scope=&as=diagram&at=7fe7f88');
  assert.equal(isFrontPage(rootDiagramSearch('7fe7f88')), false);
});

test('manifest entries group by why, biggest group first, files in the order given', () => {
  const groups = manifestGroups([
    { file: 'app/a/page.tsx', why: 'Next.js page' },
    { file: 'app/api/x/route.ts', why: 'Next.js route' },
    { file: 'app/b/page.tsx', why: 'Next.js page' },
    { file: 'scripts/one.ts', why: 'package.json script', detail: 'one' },
    { file: 'scripts/two.ts', why: 'package.json script', detail: 'two' },
    { file: 'app/layout.tsx', why: 'Next.js layout' },
  ]);
  assert.deepEqual(
    groups.map((group) => [group.why, group.files.map((entry) => entry.file)]),
    [
      ['Next.js page', ['app/a/page.tsx', 'app/b/page.tsx']],
      ['package.json script', ['scripts/one.ts', 'scripts/two.ts']],
      ['Next.js layout', ['app/layout.tsx']],
      ['Next.js route', ['app/api/x/route.ts']],
    ],
  );
  assert.deepEqual(manifestGroups([]), []);
  // The threshold is a count of entries, and eight rows are read as they are.
  assert.equal(FOLD_MANIFEST_AT, 9);
});

test('a line of changes names the statuses that are non-zero, and nothing else', () => {
  assert.equal(
    changesSummary({ modified: 3, added: 0, deleted: 1, untracked: 2, renamed: 0 }),
    '3 modified · 2 untracked · 1 deleted',
  );
  assert.equal(changesSummary({ modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0 }), '');
});

test('a path splits into its name and where it sits', () => {
  assert.deepEqual(splitPath('lib/db/store.ts'), { name: 'store.ts', where: 'lib/db' });
  assert.deepEqual(splitPath('README.md'), { name: 'README.md', where: '' });
});

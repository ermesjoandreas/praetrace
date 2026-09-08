import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `layout.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no fold.js for `node --test` to find.
import { foldFolders, type FoldableView } from './fold.ts';
import type { ViewEdge, ViewFolder, ViewNode } from './api.ts';

const box = (id: string, inFolder?: string): ViewNode => ({
  id,
  kind: 'file',
  label: id.slice(id.lastIndexOf('/') + 1),
  members: [],
  files: [id],
  external: false,
  focused: false,
  gitStatus: null,
  gitChanged: 0,
  language: null,
  test: false,
  parseError: false,
  ...(inFolder === undefined ? {} : { inFolder }),
});

const frame = (id: string, files: string[], depth = 0, parent: string | null = null): ViewFolder => ({
  id,
  label: id.slice(id.lastIndexOf('/') + 1),
  fileCount: files.length,
  depth,
  parent,
  files,
});

const line = (from: string, to: string, weight = 1): ViewEdge => ({ from, to, kind: 'imports', weight });

/**
 * The project the folder view was argued from: a controller, a model, and two
 * view folders inside a third. Every line crosses a folder wall.
 */
const view: FoldableView = {
  nodes: [
    box('Controllers/Home.cs', 'Controllers'),
    box('Models/Item.cs', 'Models'),
    box('Program.cs'),
    box('Views/Home/Index.cs', 'Views/Home'),
    box('Views/Shared/Layout.cs', 'Views/Shared'),
  ],
  edges: [
    line('Controllers/Home.cs', 'Models/Item.cs'),
    line('Controllers/Home.cs', 'Views/Home/Index.cs'),
    line('Views/Home/Index.cs', 'Views/Shared/Layout.cs'),
    line('Views/Shared/Layout.cs', 'Models/Item.cs'),
    line('Program.cs', 'Controllers/Home.cs'),
  ],
  folders: [
    frame('Controllers', ['Controllers/Home.cs']),
    frame('Models', ['Models/Item.cs']),
    frame('Views', ['Views/Home/Index.cs', 'Views/Shared/Layout.cs']),
    frame('Views/Home', ['Views/Home/Index.cs'], 1, 'Views'),
    frame('Views/Shared', ['Views/Shared/Layout.cs'], 1, 'Views'),
  ],
};

test('nothing shut is the view itself, by identity, arrays and all', () => {
  const same = foldFolders(view, new Set());
  assert.equal(same.nodes, view.nodes);
  assert.equal(same.edges, view.edges);
  assert.deepEqual(same.boxes, []);
  assert.equal(same.swallowed.size, 0);

  // And a view with no folders at all — every flat view the page draws — is
  // handed straight back even with a stale id shut.
  const flat = foldFolders({ nodes: view.nodes, edges: view.edges }, new Set(['Views']));
  assert.equal(flat.nodes, view.nodes);
  assert.deepEqual(flat.folders, []);
});

test('a shut folder becomes one box, and its lines run to it', () => {
  const folded = foldFolders(view, new Set(['Views']));

  assert.deepEqual(folded.nodes.map((node) => node.id), [
    'Controllers/Home.cs',
    'Models/Item.cs',
    'Program.cs',
  ]);
  assert.deepEqual(folded.boxes.map((folder) => [folder.id, folder.files.length]), [['Views', 2]]);
  // The frames inside it went into the box with its files.
  assert.deepEqual(folded.folders.map((folder) => folder.id), ['Controllers', 'Models']);

  assert.deepEqual(
    folded.edges.map((edge) => [edge.from, edge.to, edge.weight]),
    [
      ['Controllers/Home.cs', 'Models/Item.cs', 1],
      ['Controllers/Home.cs', 'Views', 1],
      // The line inside `Views` is gone: both ends are the same box now, and
      // there is nothing to draw it between.
      ['Views', 'Models/Item.cs', 1],
      ['Program.cs', 'Controllers/Home.cs', 1],
    ],
  );
});

test('two lines that now run between the same pair are one line carrying both', () => {
  const twice: FoldableView = {
    ...view,
    edges: [
      line('Views/Home/Index.cs', 'Models/Item.cs', 2),
      { ...line('Views/Shared/Layout.cs', 'Models/Item.cs', 3), guessed: true },
    ],
  };
  const folded = foldFolders(twice, new Set(['Views']));
  assert.deepEqual(folded.edges, [{ from: 'Views', to: 'Models/Item.cs', kind: 'imports', weight: 5 }]);

  // Guessed survives only while every reference behind the line was one.
  const bothGuessed = foldFolders(
    { ...twice, edges: twice.edges.map((edge) => ({ ...edge, guessed: true as const })) },
    new Set(['Views']),
  );
  assert.equal(bothGuessed.edges[0]?.guessed, true);
});

test('a frame holding a shut folder is drawn around the box, not around what went into it', () => {
  const folded = foldFolders(view, new Set(['Views/Home']));

  assert.deepEqual(folded.boxes.map((folder) => folder.id), ['Views/Home']);
  // `Views` still stands, and now lists the box where its inner files were.
  assert.deepEqual(
    folded.folders.find((folder) => folder.id === 'Views')?.files,
    ['Views/Home', 'Views/Shared/Layout.cs'],
  );
  assert.deepEqual(folded.folders.map((folder) => folder.id), [
    'Controllers',
    'Models',
    'Views',
    'Views/Shared',
  ]);
});

test('a fold inside a fold is one box, and the outer one is the box', () => {
  const folded = foldFolders(view, new Set(['Views', 'Views/Home']));
  assert.deepEqual(folded.boxes.map((folder) => folder.id), ['Views']);
  assert.deepEqual(
    [...folded.swallowed.entries()].sort(),
    [
      ['Views/Home/Index.cs', 'Views'],
      ['Views/Shared/Layout.cs', 'Views'],
    ],
  );
});

test('a folder with nothing on the canvas is no box: it would stand for nothing', () => {
  // The filter took both files under `Views`; the frames arrived anyway.
  const emptied: FoldableView = {
    ...view,
    nodes: view.nodes.filter((node) => !node.id.startsWith('Views/')),
    edges: [],
  };
  const folded = foldFolders(emptied, new Set(['Views']));
  assert.deepEqual(folded.boxes, []);
  assert.deepEqual(folded.nodes.map((node) => node.id), [
    'Controllers/Home.cs',
    'Models/Item.cs',
    'Program.cs',
  ]);
});

test('a shut id no folder answers to is ignored, not obeyed', () => {
  // What a page holds after navigating: the folders of the view before.
  const folded = foldFolders(view, new Set(['src/gone', 'Views/Home/Deep']));
  assert.deepEqual(folded.boxes, []);
  assert.equal(folded.nodes.length, view.nodes.length);
  assert.equal(folded.edges.length, view.edges.length);
});

// Reported live on webapp-h26: the frames read ProsjektMVC 11 files, and the
// moment Views was folded they read ProsjektMVC 5 files. No file had gone
// anywhere. `files` is what the frame is drawn around and becomes box ids as
// subfolders shut; the count must not be read off it.
test('folding a subfolder does not shrink what its parent says it holds', () => {
  const nested: FoldableView = {
    nodes: [box('a/x.ts', 'a'), box('a/b/y.ts', 'a/b'), box('a/b/z.ts', 'a/b')],
    edges: [],
    folders: [
      frame('a', ['a/x.ts', 'a/b/y.ts', 'a/b/z.ts']),
      frame('a/b', ['a/b/y.ts', 'a/b/z.ts'], 1, 'a'),
    ],
  };
  const folded = foldFolders(nested, new Set(['a/b']));
  const parent = folded.folders.find((folder) => folder.id === 'a');
  assert.equal(parent?.fileCount, 3);
  // And what it is drawn around did change: two boxes became one.
  assert.deepEqual(parent?.files, ['a/b', 'a/x.ts']);
});


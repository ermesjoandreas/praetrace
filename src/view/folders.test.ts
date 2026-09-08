import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FOLDER_DEPTH, nestByFolder, type ViewFolder } from './folders.js';

/** The frames as a reader would name them: label, depth, parent. */
function shape(folders: readonly ViewFolder[]): [string, string, number, string | null][] {
  return folders.map((folder) => [folder.id, folder.label, folder.depth, folder.parent]);
}

/**
 * The 18 source files of the project this feature was argued from — a first
 * year ASP.NET solution with an MVC half and an SPA half. Its `wwwroot` holds
 * nothing but `js`, its `Controllers` and `Models` hold one file each, and its
 * deepest boxes sit three frames down.
 */
const WEBAPP = [
  'ProsjektMVC/Controllers/HomeController.cs',
  'ProsjektMVC/Models/ErrorViewModel.cs',
  'ProsjektMVC/Program.cs',
  'ProsjektMVC/Views/Home/Index.cshtml',
  'ProsjektMVC/Views/Home/Privacy.cshtml',
  'ProsjektMVC/Views/Shared/Error.cshtml',
  'ProsjektMVC/Views/Shared/_Layout.cshtml',
  'ProsjektMVC/Views/Shared/_ValidationScriptsPartial.cshtml',
  'ProsjektMVC/Views/_ViewImports.cshtml',
  'ProsjektMVC/Views/_ViewStart.cshtml',
  'ProsjektMVC/wwwroot/js/site.js',
  'ProsjektSPA/BackendAPI/Controllers/WeatherForecastController.cs',
  'ProsjektSPA/BackendAPI/Program.cs',
  'ProsjektSPA/BackendAPI/WeatherForecast.cs',
  'ProsjektSPA/FrontendReact/eslint.config.js',
  'ProsjektSPA/FrontendReact/src/App.jsx',
  'ProsjektSPA/FrontendReact/src/main.jsx',
  'ProsjektSPA/FrontendReact/vite.config.js',
];

test('the real project: thirteen folders draw as twelve frames, three levels deep', () => {
  const { folders, holder } = nestByFolder(WEBAPP, '');

  assert.deepEqual(shape(folders), [
    ['ProsjektMVC', 'ProsjektMVC', 0, null],
    ['ProsjektSPA', 'ProsjektSPA', 0, null],
    ['ProsjektMVC/Controllers', 'Controllers', 1, 'ProsjektMVC'],
    ['ProsjektMVC/Models', 'Models', 1, 'ProsjektMVC'],
    ['ProsjektMVC/Views', 'Views', 1, 'ProsjektMVC'],
    // `wwwroot` holds nothing but `js`, so one frame wears both names.
    ['ProsjektMVC/wwwroot/js', 'wwwroot/js', 1, 'ProsjektMVC'],
    ['ProsjektSPA/BackendAPI', 'BackendAPI', 1, 'ProsjektSPA'],
    ['ProsjektSPA/FrontendReact', 'FrontendReact', 1, 'ProsjektSPA'],
    ['ProsjektMVC/Views/Home', 'Home', 2, 'ProsjektMVC/Views'],
    ['ProsjektMVC/Views/Shared', 'Shared', 2, 'ProsjektMVC/Views'],
    ['ProsjektSPA/BackendAPI/Controllers', 'Controllers', 2, 'ProsjektSPA/BackendAPI'],
    ['ProsjektSPA/FrontendReact/src', 'src', 2, 'ProsjektSPA/FrontendReact'],
  ]);

  // Every box lands in a frame: nothing sits loose at this root.
  assert.equal(holder.size, WEBAPP.length);
  assert.equal(holder.get('ProsjektMVC/Views/Home/Index.cshtml'), 'ProsjektMVC/Views/Home');
  // A file directly in a folder that also has subfolders belongs to that folder.
  assert.equal(holder.get('ProsjektMVC/Views/_ViewStart.cshtml'), 'ProsjektMVC/Views');
  assert.equal(holder.get('ProsjektMVC/wwwroot/js/site.js'), 'ProsjektMVC/wwwroot/js');
});

test('a folder holding one file is still a frame — it is the wall the picture is about', () => {
  const { folders } = nestByFolder(WEBAPP, '');
  const controllers = folders.find((folder) => folder.id === 'ProsjektMVC/Controllers');

  assert.deepEqual(controllers?.files, ['ProsjektMVC/Controllers/HomeController.cs']);
  assert.deepEqual(folders.find((folder) => folder.id === 'ProsjektMVC/Models')?.files, [
    'ProsjektMVC/Models/ErrorViewModel.cs',
  ]);
});

test('an outer frame holds the boxes nested inside it, not only its own files', () => {
  const { folders } = nestByFolder(WEBAPP, '');
  const views = folders.find((folder) => folder.id === 'ProsjektMVC/Views');

  assert.deepEqual(views?.files, [
    'ProsjektMVC/Views/Home/Index.cshtml',
    'ProsjektMVC/Views/Home/Privacy.cshtml',
    'ProsjektMVC/Views/Shared/Error.cshtml',
    'ProsjektMVC/Views/Shared/_Layout.cshtml',
    'ProsjektMVC/Views/Shared/_ValidationScriptsPartial.cshtml',
    'ProsjektMVC/Views/_ViewImports.cshtml',
    'ProsjektMVC/Views/_ViewStart.cshtml',
  ]);
  // The whole MVC half, eleven files, is inside the outermost frame.
  assert.equal(folders.find((folder) => folder.id === 'ProsjektMVC')?.files.length, 11);
});

test('a chain of folders that hold nothing but one subfolder is one frame with a joined name', () => {
  const { folders, holder } = nestByFolder(['a/b/c/deep.ts', 'other.ts'], '');

  assert.deepEqual(shape(folders), [['a/b/c', 'a/b/c', 0, null]]);
  // The innermost folder names the frame, so a file added to `a` later leaves
  // this id where it is.
  assert.equal(holder.get('a/b/c/deep.ts'), 'a/b/c');
  assert.equal(holder.get('other.ts'), undefined);
});

test('a file added to the outer end of a chain keeps the inner frame under its own id', () => {
  const before = nestByFolder(
    ['ProsjektMVC/wwwroot/js/site.js', 'ProsjektMVC/Program.cs'],
    'ProsjektMVC',
  );
  const after = nestByFolder(
    ['ProsjektMVC/wwwroot/js/site.js', 'ProsjektMVC/wwwroot/app.js', 'ProsjektMVC/Program.cs'],
    'ProsjektMVC',
  );

  assert.deepEqual(shape(before.folders), [['ProsjektMVC/wwwroot/js', 'wwwroot/js', 0, null]]);
  assert.deepEqual(shape(after.folders), [
    ['ProsjektMVC/wwwroot', 'wwwroot', 0, null],
    // Same id, so the page animates the frame rather than redrawing it; it has
    // gained an ancestor and lost the name it was carrying for it.
    ['ProsjektMVC/wwwroot/js', 'js', 1, 'ProsjektMVC/wwwroot'],
  ]);
});

test('two siblings are two frames, and a file beside them sits in neither', () => {
  const { folders, holder } = nestByFolder(
    ['src/index.ts', 'src/graph/store.ts', 'src/graph/types.ts', 'src/view/select.ts', 'src/view/filter.ts'],
    'src',
  );

  assert.deepEqual(shape(folders), [
    ['src/graph', 'graph', 0, null],
    ['src/view', 'view', 0, null],
  ]);
  assert.equal(holder.get('src/index.ts'), undefined);
  assert.equal(holder.get('src/graph/store.ts'), 'src/graph');
});

test('a folder holding every drawn box is the canvas, and draws no frame', () => {
  // Nothing to separate it from, so a rectangle around the lot says nothing.
  assert.deepEqual(nestByFolder(['src/a.ts', 'src/b.ts'], '').folders, []);
  // The same one box down: `src` and `src/view` both hold everything.
  assert.deepEqual(nestByFolder(['src/view/a.ts', 'src/view/b.ts'], '').folders, []);
  // One box is that rule's smallest case.
  assert.deepEqual(nestByFolder(['a/b/only.ts'], '').folders, []);
});

test('the folder that holds everything steps aside and its children take the top row', () => {
  const { folders } = nestByFolder(['src/graph/store.ts', 'src/view/select.ts'], '');

  // `src` holds both boxes, so it is not framed — but it is not lost either:
  // its name is carried onto the frames that are drawn.
  assert.deepEqual(shape(folders), [
    ['src/graph', 'src/graph', 0, null],
    ['src/view', 'src/view', 0, null],
  ]);
});

test('past the cap nothing below is framed, and its boxes fall to the last frame above', () => {
  const deep = [
    'root.ts',
    'a/a.ts',
    'a/b/b.ts',
    'a/b/c/c.ts',
    'a/b/c/d/d.ts',
    'a/b/c/d/e/e.ts',
    'a/b/c/d/e/f/f.ts',
  ];
  const { folders, holder } = nestByFolder(deep, '');

  assert.deepEqual(
    folders.map((folder) => folder.depth),
    [0, 1, 2, 3],
  );
  assert.equal(folders.length, MAX_FOLDER_DEPTH);
  assert.deepEqual(shape(folders).at(-1), ['a/b/c/d', 'd', 3, 'a/b/c']);

  // The two folders past the cap draw nothing, and their files are held by the
  // deepest frame there is. Their own labels are what still says where they
  // are: the caller names a box relative to the frame holding it, so these read
  // `e/e.ts` and `e/f/f.ts`.
  assert.equal(holder.get('a/b/c/d/e/e.ts'), 'a/b/c/d');
  assert.equal(holder.get('a/b/c/d/e/f/f.ts'), 'a/b/c/d');
  assert.deepEqual(folders.at(-1)?.files, ['a/b/c/d/d.ts', 'a/b/c/d/e/e.ts', 'a/b/c/d/e/f/f.ts']);
});

test('the empty project draws nothing at all', () => {
  assert.deepEqual(nestByFolder([], ''), { folders: [], holder: new Map() });
  assert.deepEqual(nestByFolder([], 'src').folders, []);
});

test('a box outside the scope is skipped, not dragged into a frame', () => {
  // What a caller hands over includes the external boxes it drew to show what
  // the scope connects to. They are outside, and a frame around them would say
  // they are inside.
  const { folders, holder } = nestByFolder(
    ['src/graph/store.ts', 'src/graph/types.ts', 'src/view/select.ts', 'web/src/App.tsx'],
    'src',
  );

  assert.deepEqual(shape(folders), [
    ['src/graph', 'graph', 0, null],
    ['src/view', 'view', 0, null],
  ]);
  assert.equal(holder.get('web/src/App.tsx'), undefined);
  assert.deepEqual(folders[0]?.files, ['src/graph/store.ts', 'src/graph/types.ts']);
});

test('frames come out outermost first, so a consumer can register a parent before its child', () => {
  const { folders } = nestByFolder(WEBAPP, '');

  const seen = new Set<string>();
  for (const folder of folders) {
    assert.equal(folder.parent === null || seen.has(folder.parent), true, folder.id);
    seen.add(folder.id);
  }
  assert.deepEqual(
    folders.map((folder) => folder.depth),
    [...folders.map((folder) => folder.depth)].sort((a, b) => a - b),
  );
});

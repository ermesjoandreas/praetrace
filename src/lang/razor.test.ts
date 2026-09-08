import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type Parser from 'tree-sitter';
import { csharp } from './csharp.js';
import { ACTION_VIEW, razor, resolveActionView } from './razor.js';
import type { ResolveContext } from './types.js';

/**
 * A whole little ASP.NET application, read off disk.
 *
 * The fixture is a directory rather than a string because half of what this
 * reader does is decided by *where* a file is: a partial is searched from the
 * directory that named it, a `_ViewImports.cshtml` applies to everything
 * beneath it, and a page's model is the file beside it. None of that can be
 * tested against a source with no path. `fixtures`, plural, because that is the
 * segment `view/tests.ts` knows.
 */
const FIXTURE = fileURLToPath(new URL('../../src/lang/fixtures/razor', import.meta.url));

// The C# half is parsed by the real reader: what a view can see depends on what
// namespace a class was declared in, and hand-writing that would test this
// against an idea of C# rather than against C#.
const require = createRequire(import.meta.url);
const TreeSitter = require('tree-sitter') as new () => Parser;

interface Project {
  files: Set<string>;
  imports: Map<string, readonly string[]>;
  declarations: Map<string, ReadonlySet<string>>;
  modules: Map<string, string>;
}

function filesUnder(directory: string, prefix = ''): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...filesUnder(directory, relative));
    else found.push(relative);
  }
  return found.sort();
}

function readProject(): Project {
  const project: Project = { files: new Set(), imports: new Map(), declarations: new Map(), modules: new Map() };
  const parser = new TreeSitter();
  parser.setLanguage(csharp.grammar('a.cs') as Parser.Language);

  for (const file of filesUnder(FIXTURE)) {
    const source = readFileSync(path.join(FIXTURE, file), 'utf8');
    project.files.add(file);

    if (file.endsWith('.cshtml')) {
      const parse = razor.scan(source);
      project.imports.set(file, parse.imports);
      project.declarations.set(file, new Set());
      // A view declares nothing the graph models, and its box is empty.
      assert.deepEqual(parse.symbols, [], `${file} declared symbols`);
      continue;
    }

    const parse = csharp.extract(parser.parse(source).rootNode, source);
    project.imports.set(file, parse.imports);
    project.declarations.set(
      file,
      new Set(parse.symbols.filter((symbol) => symbol.owner === undefined).map((symbol) => symbol.name)),
    );
    if (parse.moduleName !== undefined) project.modules.set(file, parse.moduleName);
  }

  return project;
}

const PROJECT = readProject();

function contextIn(project: Project, from: string, specifier: string): ResolveContext {
  return {
    from,
    specifier,
    files: project.files,
    modules: project.modules,
    declarations: project.declarations,
    imports: project.imports,
    facts: { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() },
  };
}

const resolve = (from: string, specifier: string): string | null =>
  razor.resolve(contextIn(PROJECT, from, specifier));

/** What the fixture draws: every view's references, resolved, as `from -> to`. */
function edgesOf(project: Project): string[] {
  const edges: string[] = [];
  for (const [file, references] of project.imports) {
    if (!file.endsWith('.cshtml')) continue;
    for (const specifier of references) {
      const target = razor.resolve(contextIn(project, file, specifier));
      if (target !== null) edges.push(`${file} -> ${target}`);
    }
  }
  return [...new Set(edges)].sort();
}

test('a Razor file is scanned, and a scanner has no syntax errors to report', () => {
  // The whole of the grammar decision, pinned: there is no grammar and no
  // tree, so parseSource cannot set `hasError` and no view wears the badge.
  assert.ok('scan' in razor, 'razor lost its scanner');
  assert.ok(!('grammar' in razor), 'razor grew a grammar; parseSource would parse it and mark errors');
  assert.deepEqual(razor.extensions, ['.cshtml']);
});

test('the forms a view writes, read off a real file', () => {
  const parse = razor.scan(readFileSync(path.join(FIXTURE, 'Views/Home/Index.cshtml'), 'utf8'));
  assert.deepEqual(parse.imports.sort(), [
    'component:CartBadge',
    'view:Components/CartBadge/Default.cshtml',
    'view:_Callout',
    'view:_LoginPartial',
  ]);
  // A partial named inside `@* … *@` is commented out, and is not an edge.
  assert.ok(!parse.imports.includes('view:_NeverRendered'));
});

test('a byte-order mark does not hide the directive behind it', () => {
  const source = readFileSync(path.join(FIXTURE, 'Views/_ViewImports.cshtml'), 'utf8');
  assert.ok(source.startsWith('﻿'), 'the fixture lost its BOM, and this test is checking nothing');
  assert.deepEqual(razor.scan(source).imports, ['using:Shop.Models']);
});

test('a name the source did not write is not a reference', () => {
  // `Layout = null` is a page saying it has no layout, and `name="@Model.X"` is
  // a name built at runtime. Both used to be the shape a scanner invents edges from.
  assert.deepEqual(razor.scan(readFileSync(path.join(FIXTURE, 'Views/Home/Privacy.cshtml'), 'utf8')).imports, []);
  // A directive is the first thing on its line; `@model.Name` in markup is a
  // property read on the model, and the lookahead is what tells them apart.
  assert.deepEqual(razor.scan('<p>@model.Name</p>\n').imports, []);
  // `@using X = Y` is an alias, and an alias names a type as often as a namespace.
  assert.deepEqual(razor.scan('@using Cart = Shop.Models.Basket\n').imports, []);
});

test('an attribute on its own line still belongs to the tag above it', () => {
  // eShopOnWeb writes a `<partial>` over two lines eleven times; a strictly
  // per-line reading loses every one of them.
  const source = readFileSync(path.join(FIXTURE, 'Views/Shared/_Layout.cshtml'), 'utf8');
  assert.deepEqual(razor.scan(source).imports, ['view:_LoginPartial']);
});

test('a partial is looked up the way the view engine looks it up', () => {
  const from = 'Views/Home/Index.cshtml';
  // The directory that named it wins…
  assert.equal(resolve(from, 'view:_Callout'), 'Views/Home/_Callout.cshtml');
  // …and `Shared` beside it is the fallback, one directory up.
  assert.equal(resolve(from, 'view:_LoginPartial'), 'Views/Shared/_LoginPartial.cshtml');
  assert.equal(resolve(from, 'view:_NoSuchPartial'), null);
});

test('a layout named by path is matched against the application root', () => {
  // `/Views/Shared/_Layout.cshtml` is written against the application root,
  // which is not the repository root and is nowhere in the file.
  assert.equal(
    resolve('Pages/Basket/Index.cshtml', 'view:/Views/Shared/_Layout.cshtml'),
    'Views/Shared/_Layout.cshtml',
  );
  assert.equal(resolve('Views/_ViewStart.cshtml', 'view:_Layout'), 'Views/Shared/_Layout.cshtml');
});

test('a model binds only through the namespaces a _ViewImports brought into scope', () => {
  assert.equal(resolve('Views/Shared/Error.cshtml', 'type:ErrorViewModel'), 'Models/ErrorViewModel.cs');

  // The same name from a view no `_ViewImports` sits above reaches nothing.
  // This is the whole of the namespace check: without it any project type
  // named `Options` or `Index` becomes a hub everything appears to depend on.
  const alone = { ...PROJECT, files: new Set([...PROJECT.files, 'Elsewhere/Detached.cshtml']) };
  assert.equal(razor.resolve(contextIn(alone, 'Elsewhere/Detached.cshtml', 'type:ErrorViewModel')), null);

  // A framework type is not in the project, and resolving to nothing is right.
  assert.equal(resolve('Views/Shared/_LoginPartial.cshtml', 'type:SignInManager'), null);
});

test("a page's model is the class beside it", () => {
  const from = 'Pages/Basket/Index.cshtml';
  assert.equal(resolve(from, 'page:'), 'Pages/Basket/Index.cshtml.cs');
  assert.equal(resolve(from, 'type:IndexModel'), 'Pages/Basket/Index.cshtml.cs');
  // A view with no code-behind says so rather than reaching the nearest page model.
  assert.equal(resolve('Views/Home/Index.cshtml', 'page:'), null);
});

test('a component invocation reaches the class that runs and the view it renders', () => {
  const from = 'Views/Home/Index.cshtml';
  assert.equal(resolve(from, 'component:CartBadge'), 'Components/CartBadgeViewComponent.cs');
  assert.equal(
    resolve(from, 'view:Components/CartBadge/Default.cshtml'),
    'Views/Shared/Components/CartBadge/Default.cshtml',
  );
  // Only the framework's own suffix. A class named `CartBadge` that inherits
  // ViewComponent is one too, and a view cannot see a base class to tell it
  // from the `CartBadge` entity next door.
  assert.equal(resolve(from, 'component:Cart'), null);
});

test('the view an action returns, by MVC view-location order', () => {
  const controller = 'Controllers/HomeController.cs';
  const answer = (specifier: string): string | null =>
    resolveActionView(contextIn(PROJECT, controller, `${ACTION_VIEW}${specifier}`));

  assert.equal(answer('Home/Index'), 'Views/Home/Index.cshtml');
  // Views/Home/Error.cshtml does not exist, and Shared is where MVC looks next.
  assert.equal(answer('Home/Error'), 'Views/Shared/Error.cshtml');
  assert.equal(answer('Home/Missing'), null);
  // `View("~/Views/Shared/_Layout.cshtml")`: a name that is a path is that path.
  assert.equal(answer('Home/~/Views/Shared/Error.cshtml'), 'Views/Shared/Error.cshtml');
});

test('a using and a namespace are facts about the file, never edges out of it', () => {
  // Resolving `@using Shop.Models` would draw the whole of a namespace as a
  // dependency on whichever file happens to be named after part of it.
  assert.equal(resolve('Views/Shared/Error.cshtml', 'using:Shop.Models'), null);
  assert.equal(resolve('Pages/Basket/Index.cshtml', 'namespace:Shop.Pages'), null);
  assert.equal(resolve('Views/Home/Index.cshtml', 'addTagHelper:whatever'), null);
});

test('what the fixture draws, whole', () => {
  // The unit tests above each pass while the composition lies. This is the
  // composition: every reference every view writes, resolved.
  assert.deepEqual(edgesOf(PROJECT), [
    'Pages/Basket/Index.cshtml -> Pages/Basket/Index.cshtml.cs',
    'Pages/Basket/Index.cshtml -> Views/Shared/_Layout.cshtml',
    'Views/Home/Index.cshtml -> Components/CartBadgeViewComponent.cs',
    'Views/Home/Index.cshtml -> Views/Home/_Callout.cshtml',
    'Views/Home/Index.cshtml -> Views/Shared/Components/CartBadge/Default.cshtml',
    'Views/Home/Index.cshtml -> Views/Shared/_LoginPartial.cshtml',
    'Views/Shared/Error.cshtml -> Models/ErrorViewModel.cs',
    'Views/Shared/_Layout.cshtml -> Views/Shared/_LoginPartial.cshtml',
    'Views/_ViewStart.cshtml -> Views/Shared/_Layout.cshtml',
  ]);
});

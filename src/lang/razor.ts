import path from 'node:path';
import type { LanguageParse, ResolveContext } from './types.js';

/**
 * Razor — the view half of an ASP.NET application, and the one reader here with
 * no grammar behind it.
 *
 * That is the decision to justify, and it was measured before it was made.
 * There is no usable tree-sitter grammar: the published `tree-sitter-razor` was
 * unpublished on 2025-05-17, and tris203/tree-sitter-razor parses but fails
 * 1 of 7 files in the user's own MVC project, 21 of 48 in eShopOnWeb and 64 of
 * 181 in SimplCommerce. A `<!DOCTYPE html>` line is an ERROR node in every
 * layout, a bare `@page` is an ERROR, and HTML attributes are hidden rules, so
 * the tag-helper rules would need a regex over the source anyway. A line
 * scanner for the forms that matter recovered every edge the grammar found plus
 * every one it lost, across 236 files.
 *
 * So this file reads text. Two consequences follow, and both are deliberate:
 * a scanner has no syntax errors to report, so a Razor file never wears the
 * parse-error badge — `hasError` is the grammar's word, and there is no
 * grammar — and a Razor file declares nothing the graph models, so its box is
 * empty. A view is a file that *reaches* things; it is not a file that *has*
 * things.
 *
 * What makes the edges true is not the scanning. It is that every name a view
 * writes is looked up the way the view engine looks it up: a partial is
 * searched from the directory that named it and upwards, a `@model` binds only
 * through the namespaces the `_ViewImports.cshtml` files above it brought into
 * scope, and a component's view sits where the framework puts it. Those rules
 * are written down and deterministic, which is why an edge from one is not
 * marked `guessed` — see the note on ACTION_VIEW for the one that is a
 * convention rather than a rule, and is refused instead.
 */

/**
 * The facts a Razor file states and the references it makes, and the tags they
 * travel under.
 *
 * They ride in `imports` because that is the only channel a parsed file has to
 * the resolver, which is where they are needed — C# and Go write their
 * un-path-like references the same way. A tag is `word:`, and a Razor name is
 * an identifier or a path, so nothing a project can write is mistaken for one.
 */
/** A namespace the view brought into scope. A fact about the file, never an edge. */
const USING = 'using:';
/** `@namespace`: what the generated class is declared under. Also a fact. */
const DECLARES = 'namespace:';
/** A type the view named: `@model`, `@inject`. */
const TYPE = 'type:';
/** Another view, named the way the view engine looks one up: a layout, a partial. */
const VIEW = 'view:';
/** A view component's class, invoked by the component's name. */
const COMPONENT = 'component:';
/** `@page`, and the whole specifier: what it names is computed from the file's own path. */
const PAGE = 'page:';

/**
 * The view an action returns, as the C# side writes it: `action:Home/Index`.
 *
 * The reference is made in the controller — `return View()` is a C# statement —
 * so it is emitted by whoever parses the controller and resolved here, where
 * the view-location order lives. The form is controller and action rather than
 * a path because that is what the call site knows: `View()` names no file at
 * all, and the file it means is `Views/{Controller}/{Action}.cshtml` by MVC's
 * own convention.
 *
 * Exported with its resolver so `src/lang/csharp.ts` can hand one back without
 * learning where views live.
 */
export const ACTION_VIEW = 'action:';

/** Razor's own comment. Stripped whole, so a commented-out partial is not an edge. */
const RAZOR_COMMENT = /@\*[\s\S]*?\*@/g;

/**
 * A directive, which is the first thing on its line. The lookahead rather than
 * `\b` is what keeps `@model.Name` in markup from reading as a `@model`
 * directive, and `﻿` is here because every Razor file Visual Studio writes
 * starts with a byte-order mark.
 */
const DIRECTIVE = /^[ \t﻿]*@(model|using|inject|namespace|page)(?=[ \t]|$)[ \t]*([^\r\n]*)/gm;

/**
 * `Layout = "_Layout"` inside a code block. `Layout = null` is a page saying it
 * has no layout, and matches nothing here, which is the point.
 */
const LAYOUT = /\bLayout\s*=\s*"([^"]*)"/g;

/**
 * The partial tag helper. `[^>]*` crosses newlines on purpose: eShopOnWeb
 * writes `<partial name="_StatusMessage"` and `for="StatusMessage" />` on two
 * lines, and a strictly per-line reading loses the attribute half the time.
 */
const PARTIAL_TAG = /<partial\b[^>]*?\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** The older spellings, which are a method call rather than a tag. */
const PARTIAL_CALL = /\bHtml\.(?:Partial|PartialAsync|RenderPartial|RenderPartialAsync)\s*\(\s*"([^"]*)"/g;

/**
 * A view component by name. The literal is required: SimplCommerce invokes
 * `Component.InvokeAsync(widgetInstance.ViewComponentName, …)` twice, and the
 * name of that component is a runtime value no static reading can know.
 */
const COMPONENT_CALL = /\bComponent\.InvokeAsync\s*\(\s*"([^"]*)"/g;

/** The tag-helper spelling of the same thing: `<vc:category-menu>` is CategoryMenu. */
const COMPONENT_TAG = /<vc:([a-z0-9-]+)/gi;

/** What a type expression is made of, once the generics and arrays are gone. */
const TYPE_NAME = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

/**
 * The C# built-ins a `@model` or `@inject` can be written with. Not a list of
 * every framework type — an unknown name resolving to nothing is the ordinary
 * answer and costs nothing — only the ones that are keywords, because a
 * keyword is not a name any project file could ever declare.
 */
const KEYWORDS = new Set([
  'bool', 'byte', 'char', 'decimal', 'double', 'dynamic', 'float', 'int', 'long',
  'object', 'sbyte', 'short', 'string', 'uint', 'ulong', 'ushort', 'var', 'void', 'static',
]);

/** Every type name in a type expression, generic arguments included. */
function typeNames(expression: string): string[] {
  return [...expression.matchAll(TYPE_NAME)]
    .map((match) => match[0])
    .filter((name) => !KEYWORDS.has(name));
}

/**
 * The type an `@inject` line declares, without the name it is injected under.
 *
 * `@inject SignInManager<ApplicationUser> SignInManager` declares one and names
 * it the same thing, so the last whitespace-separated token is dropped rather
 * than deduplicated: the local name is not a reference, and letting it through
 * would make every injected service look like a type the view depends on twice.
 */
function injectedType(rest: string): string {
  const at = rest.trimEnd().lastIndexOf(' ');
  return at < 0 ? '' : rest.slice(0, at);
}

function scan(source: string): LanguageParse {
  const text = source.replace(RAZOR_COMMENT, '');
  const references = new Set<string>();

  for (const match of text.matchAll(DIRECTIVE)) {
    const directive = match[1] ?? '';
    const rest = (match[2] ?? '').trim().replace(/;\s*$/, '');

    if (directive === 'page') {
      references.add(PAGE);
    } else if (directive === 'using') {
      // `@using X = Y` is an alias, and an alias is a name for a type as often
      // as for a namespace. Recording it as a namespace would put types in
      // scope that this file cannot see; it is left out, and named as a gap.
      if (rest !== '' && !rest.includes('=')) references.add(USING + rest.replace(/^static\s+/, ''));
    } else if (directive === 'namespace') {
      if (rest !== '') references.add(DECLARES + rest);
    } else {
      const expression = directive === 'inject' ? injectedType(rest) : rest;
      for (const name of typeNames(expression)) references.add(TYPE + name);
    }
  }

  for (const [, name] of text.matchAll(LAYOUT)) addView(references, name);
  for (const [, quoted, single] of text.matchAll(PARTIAL_TAG)) addView(references, quoted ?? single);
  for (const [, name] of text.matchAll(PARTIAL_CALL)) addView(references, name);

  for (const [, name] of text.matchAll(COMPONENT_CALL)) addComponent(references, name ?? '');
  for (const [, tag] of text.matchAll(COMPONENT_TAG)) addComponent(references, pascalCase(tag ?? ''));

  return { imports: [...references], symbols: [] };
}

/**
 * A view named by another view. A name holding `@` is built at runtime —
 * `<partial name="@Model.Template" />` — and there is no file to name.
 */
function addView(references: Set<string>, name: string | undefined): void {
  if (name !== undefined && name !== '' && !name.includes('@')) references.add(VIEW + name);
}

/**
 * Both halves of a component invocation: the class that runs and the view it
 * renders by default. They are two files and two edges, and a reference
 * resolves to one file, so the invocation writes two.
 */
function addComponent(references: Set<string>, name: string): void {
  if (name === '') return;
  references.add(COMPONENT + name);
  references.add(`${VIEW}Components/${name}/Default.cshtml`);
}

/** `category-menu` -> `CategoryMenu`: the tag helper's name for a component. */
function pascalCase(tag: string): string {
  return tag
    .split('-')
    .filter((part) => part !== '')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

/** How many leading directories two paths share. */
function sharedDepth(a: readonly string[], b: readonly string[]): number {
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared += 1;
  return shared;
}

/**
 * The candidate nearest the file that named it, or null when nothing separates
 * two of them.
 *
 * A repository holds more than one application — the user's own holds an MVC
 * project and an API beside it, and SimplCommerce ships three themes that each
 * carry their own copy of `Components/CategoryMenu/Default.cshtml`. The nearest
 * by shared directory is the one the framework would load, and a tie is
 * refused: a missing edge is a gap, a wrong one is a lie.
 */
function nearest(from: string, candidates: readonly string[]): string | null {
  if (candidates.length === 1) return candidates[0] ?? null;
  // The module a file lives in comes first, because that is what the framework
  // searches first — a theme's copy of the same view sits at the same depth
  // and used to win on proximity alone, pointing eight of SimplCommerce's
  // edges at a file the framework would never pick. Narrowed to the same root
  // segment, whatever is left is a real ambiguity and answers null: a missing
  // edge is a gap, a wrong one is a lie.
  const root = from.split('/')[0];
  const own = candidates.filter((file) => file.split('/')[0] === root);
  if (own.length === 1) return own[0] ?? null;
  if (own.length > 1) candidates = own;
  const fromDirectories = path.posix.dirname(from).split('/');
  let best: string | null = null;
  let bestDepth = -1;
  let tied = false;

  for (const file of candidates) {
    const depth = sharedDepth(fromDirectories, path.posix.dirname(file).split('/'));
    if (depth > bestDepth) {
      bestDepth = depth;
      best = file;
      tied = false;
    } else if (depth === bestDepth) tied = true;
  }

  return tied ? null : best;
}

/**
 * Every view in the project, cached against the file set the store builds once
 * per derivation. Without it each of a project's few hundred view references
 * would walk the whole file list.
 */
const viewIndexes = new WeakMap<ReadonlySet<string>, readonly string[]>();

function viewsIn(files: ReadonlySet<string>): readonly string[] {
  const cached = viewIndexes.get(files);
  if (cached) return cached;
  const views = [...files].filter((file) => file.toLowerCase().endsWith('.cshtml'));
  viewIndexes.set(files, views);
  return views;
}

/**
 * A path written against the application root — `/Views/Shared/_Layout.cshtml`
 * — onto a file the scan found.
 *
 * Matched as a suffix, because the application root is not the repository root
 * and nothing in a view says where it is: eShopOnWeb's is `src/Web`, the user's
 * is `ProsjektMVC`, and SimplCommerce has one per module. The suffix is what
 * the framework resolves against, and `nearest` settles a repository that holds
 * two applications.
 */
function bySuffix(context: ResolveContext, suffix: string): string | null {
  const matches = viewsIn(context.files).filter((file) => file === suffix || file.endsWith(`/${suffix}`));
  return matches.length === 0 ? null : nearest(context.from, matches);
}

/** '' , 'src', 'src/Web', … : the directories above a file, outermost first. */
function directoriesAbove(filePath: string): string[] {
  const parts = path.posix.dirname(filePath).split('/').filter((part) => part !== '' && part !== '.');
  return ['', ...parts.map((_, at) => parts.slice(0, at + 1).join('/'))];
}

/**
 * A partial or layout named without a path, looked up the way the view engine
 * looks one up: the directory that named it, then the `Shared` folder beside
 * it, then the same pair one directory up, and so on to the root — with
 * `Views/Shared` tried at each level as the last resort, which is where a
 * Razor Page finds a partial that MVC also uses.
 *
 * Checked against the three corpora: `_ValidationScriptsPartial` from
 * `Areas/Identity/Pages/Account/Login.cshtml` lands on
 * `Areas/Identity/Pages/_ValidationScriptsPartial.cshtml` and from
 * `Views/Manage/ChangePassword.cshtml` on `Views/Shared/` — which is what
 * ASP.NET does with each of them.
 */
function byName(context: ResolveContext, name: string): string | null {
  const directories = directoriesAbove(context.from).reverse();

  for (const directory of directories) {
    const prefix = directory === '' ? '' : `${directory}/`;
    for (const candidate of [
      `${prefix}${name}.cshtml`,
      `${prefix}Shared/${name}.cshtml`,
      `${prefix}Views/Shared/${name}.cshtml`,
    ]) {
      if (context.files.has(candidate)) return candidate;
    }
  }

  return null;
}

/** Whether a view was named by path rather than by name. */
function looksLikePath(name: string): boolean {
  return name.includes('/') || name.toLowerCase().endsWith('.cshtml');
}

function resolveView(context: ResolveContext, name: string): string | null {
  if (!looksLikePath(name)) return byName(context, name);
  const written = name.replace(/^~/, '').replace(/^\/+/, '');
  return bySuffix(context, /\.cshtml$/i.test(written) ? written : `${written}.cshtml`);
}

/** The namespaces `namespace A.B.C` puts in scope: A, A.B and A.B.C. */
function enclosing(namespace: string): string[] {
  const parts = namespace.split('.');
  return parts.map((_, at) => parts.slice(0, at + 1).join('.'));
}

/**
 * Every namespace a bare type name in one view may bind against.
 *
 * This is what makes `@model ErrorViewModel` an edge rather than a guess, and
 * it is the one rule here that a per-file reading cannot supply: a view's
 * `using` directives are mostly not in the view. They are in the
 * `_ViewImports.cshtml` files above it, every one of which applies, and that is
 * why the whole reference table is consulted rather than the file's own list.
 *
 * `@namespace` is read for the same reason. It sets what the generated class is
 * declared under, extended by the path from the file that declared it — so
 * `Pages/Basket/Index.cshtml` under `@namespace Microsoft.eShopWeb.Web.Pages`
 * is in `…Pages.Basket`, and a type declared there needs no directive to be
 * seen.
 */
function reachableFrom(context: ResolveContext): ReadonlySet<string> {
  // The global namespace: a type declared outside any namespace needs no
  // directive, and a project whose files declare none is the ordinary small case.
  const reachable = new Set<string>(['']);
  let declared: string | null = null;
  let declaredIn = '';

  const directories = directoriesAbove(context.from);
  const files = directories.map((directory) => `${directory === '' ? '' : `${directory}/`}_ViewImports.cshtml`);

  for (const [at, file] of [...files, context.from].entries()) {
    for (const reference of context.imports.get(file) ?? []) {
      if (reference.startsWith(USING)) reachable.add(reference.slice(USING.length));
      else if (reference.startsWith(DECLARES)) {
        declared = reference.slice(DECLARES.length);
        // The file's own directive is the last entry, and its directory is the
        // file's own — `at` runs past the end of `directories` for it.
        declaredIn = directories[at] ?? path.posix.dirname(context.from);
      }
    }
  }

  if (declared !== null) {
    const below = path.posix.relative(declaredIn, path.posix.dirname(context.from));
    const namespace = below === '' || below === '.' ? declared : `${declared}.${below.split('/').join('.')}`;
    for (const scope of enclosing(namespace)) reachable.add(scope);
  }

  return reachable;
}

/**
 * Cached against the reference table, which the store builds once per
 * derivation and hands to every resolve call — the same bargain csharp.ts
 * strikes, and for the same reason: without it, a view's scope would be walked
 * once per name it writes.
 */
const scopes = new WeakMap<ReadonlyMap<string, readonly string[]>, Map<string, ReadonlySet<string>>>();

function scopeOf(context: ResolveContext): ReadonlySet<string> {
  let byFile = scopes.get(context.imports);
  if (byFile === undefined) {
    byFile = new Map();
    scopes.set(context.imports, byFile);
  }
  const cached = byFile.get(context.from);
  if (cached) return cached;

  const reachable = reachableFrom(context);
  byFile.set(context.from, reachable);
  return reachable;
}

/** The `.cshtml.cs` beside a view: a Razor Page's model class, by the framework's own naming. */
function besideView(context: ResolveContext): string | null {
  const beside = `${context.from}.cs`;
  return context.files.has(beside) ? beside : null;
}

/**
 * A type a view named, to the file that declares it.
 *
 * Two rules, in order. A Razor Page's model sits in the `.cshtml.cs` beside it
 * — that is the framework's own pairing and needs no namespace check. Anything
 * else is C#'s rule: the file declaring the name, held to a namespace this view
 * actually brought into scope, so `@model ErrorViewModel` cannot land on some
 * other project's `ErrorViewModel` and a view that imported nothing reaches
 * nothing.
 *
 * The candidates come from what files *declare*, not from what they are named,
 * which is the opposite of csharp.ts's index and deliberately so: a view model
 * is a public top-level type, and eShopOnWeb declares four of them in one
 * `OrderViewModel.cs`. The namespace check is what keeps that affordable.
 */
function resolveType(context: ResolveContext, name: string): string | null {
  const dot = name.lastIndexOf('.');
  const tail = name.slice(dot + 1);

  const beside = besideView(context);
  if (beside !== null && context.declarations.get(beside)?.has(tail) === true) return beside;

  // A written qualifier is the whole answer: `@model Web.ViewModels.Order` can
  // only be the Order that namespace declares.
  const wanted = dot < 0 ? scopeOf(context) : new Set([name.slice(0, dot)]);
  const candidates: string[] = [];
  for (const [file, declared] of context.declarations) {
    if (!file.endsWith('.cs') || !declared.has(tail)) continue;
    if (wanted.has(context.modules.get(file) ?? '')) candidates.push(file);
  }

  return nearest(context.from, candidates);
}

/**
 * A view component's name to the class that runs it.
 *
 * Only the `…ViewComponent` spelling, which is the framework's own discovery
 * rule and is unambiguous — nothing else in a project is called that. A class
 * that instead inherits `ViewComponent` under a bare name is a component too,
 * and is refused: eShopOnWeb's `Basket : ViewComponent` shares its name with
 * the `Basket` entity in ApplicationCore, and the base class that tells them
 * apart is not something a view can see. The component's default view is
 * reached by the separate `view:` reference the invocation also writes, so the
 * invocation is not left drawing nothing.
 */
function resolveComponent(context: ResolveContext, name: string): string | null {
  const wanted = `${name}ViewComponent`;
  const candidates: string[] = [];
  for (const [file, declared] of context.declarations) {
    if (file.endsWith('.cs') && declared.has(wanted)) candidates.push(file);
  }
  return nearest(context.from, candidates);
}

/**
 * The view a controller action returns, by MVC's view-location order:
 * `Views/{Controller}/{Action}.cshtml`, then `Views/Shared/{Action}.cshtml`.
 * A name written as a path — `View("~/Views/Foo/Bar.cshtml")` — is that path.
 *
 * Called from csharp.ts, which makes the reference and cannot resolve it: the
 * order is Razor's knowledge, and an area's controller finds its own area's
 * view because the suffix match prefers the nearest one.
 */
export function resolveActionView(context: ResolveContext): string | null {
  const written = context.specifier.slice(ACTION_VIEW.length);
  const slash = written.indexOf('/');
  if (slash < 0) return null;
  const controller = written.slice(0, slash);
  const view = written.slice(slash + 1);
  if (controller === '' || view === '') return null;

  if (looksLikePath(view)) return resolveView(context, view);
  return bySuffix(context, `Views/${controller}/${view}.cshtml`) ?? bySuffix(context, `Views/Shared/${view}.cshtml`);
}

/**
 * Not annotated as a LanguageSupport, because it is not one yet: the contract
 * has `grammar` and `extract`, and this reader has neither. See the note in
 * this round's hand-off for the three lines `src/lang/types.ts`,
 * `src/lang/registry.ts` and `src/parser/extract.ts` need — until they land,
 * this module compiles and is tested but is not wired into the scan.
 */
export const razor = {
  id: 'razor' as const,
  label: 'Razor',
  extensions: ['.cshtml'],

  scan,

  resolve(context: ResolveContext): string | null {
    const { specifier } = context;
    if (specifier === PAGE) return besideView(context);
    if (specifier.startsWith(TYPE)) return resolveType(context, specifier.slice(TYPE.length));
    if (specifier.startsWith(VIEW)) return resolveView(context, specifier.slice(VIEW.length));
    if (specifier.startsWith(COMPONENT)) return resolveComponent(context, specifier.slice(COMPONENT.length));
    if (specifier.startsWith(ACTION_VIEW)) return resolveActionView(context);
    // `using:` and `namespace:` are facts about the file, never edges out of
    // it: resolving a `using` would draw the whole of a namespace as a
    // dependency on whichever file happens to be named after part of it.
    return null;
  },
};

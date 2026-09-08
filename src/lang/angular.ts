import path from 'node:path';

import type { ParsedFile } from '../parser/types.js';
import type { LanguageId, LanguageParse, LanguageSupport, SyntaxNode } from './types.js';

/**
 * Angular is not a language, and this file is the argument for why it still
 * lives here.
 *
 * **NOTHING CALLS IT YET, AND THAT IS THE STATE.** `angular` is not in
 * `LANGUAGES`, `.html` is not an extension the registry claims, and
 * `typescript.extract` does not call `componentTemplates`. The three steps
 * below have to land together, and none of them has; until they do this file
 * is written and tested and draws nothing. Registering it alone would draw
 * every static page in every project, which is the one outcome the argument
 * below exists to refuse.
 *
 * The other six readers in this directory answer "what does this extension
 * mean". That question has no answer for an Angular template, because the
 * extension is `.html` and `.html` means nothing on its own. Measured on
 * angular/components at dd4acb4: 678 `.html` files, of which 659 are a
 * component's view and 19 are not — eight host pages a browser loads
 * (`src/dev-app/index.html` and its like) and eleven dgeni documentation
 * templates under `tools/`. An extension rule would have drawn all 678, and the
 * 19 would have arrived as boxes with no coupling, which is the failure this
 * project cares about most: wrong in a way that reads as authoritative. Every
 * static page in every project would come with them.
 *
 * The size of what is being recovered: `.html` is that repository's **largest**
 * unread kind. `countUnreadable` reports 678 of them against 434 `.scss`, 378
 * `.bazel` and 265 `.css`, on 2 405 files the scan does read.
 *
 * So an `.html` file is a view **only because a component's `templateUrl` names
 * it**, and that name is written down in TypeScript rather than guessed. Which
 * splits Angular support in three, and none of the three is a language:
 *
 *  1. **Reading the name** is a rule in the TypeScript reader — a decorator's
 *     string literal, in a tree `typescript.ts` already walks. It lives here so
 *     that file stays about TypeScript; `typescript.extract` would call
 *     `componentTemplates`.
 *  2. **Turning the name into a file** is the resolver's ordinary relative-path
 *     arithmetic, once `graph/resolve.ts` will try the path as written for an
 *     extension no language rewrites. Today it will not: `candidatesFor` only
 *     appends `.ts`, `.tsx`, … to a base whose extension it does not know, so
 *     `resolveImport('a/hero.ts', './hero.html', {'a/hero.html'})` answers null
 *     with the file sitting in the set. That change and step 3 have to land
 *     together — a template added without it is a box with no edge, and a box
 *     with no edge is the picture this whole directory exists to refuse.
 *  3. **Getting the file into the graph** is a second pass over what the first
 *     pass named: `namedTemplates` says which templates were named, and
 *     `readTemplate` makes each one a file the graph can hold. Never a walk of
 *     `.html`, which is the whole point.
 *
 * A template is **read, not parsed**. There is no tree-sitter grammar for it
 * here, and it needs none: it declares nothing the graph models, so `extract`
 * would have nothing to return but the empty parse `readTemplate` already
 * builds. A scanner has no syntax error to report either, so `hasError` stays
 * absent and the box never wears a badge it did not earn.
 *
 * **The template's box is empty, and its only edge is the one from its
 * component.** That is honest and it is worth saying out loud, because in
 * Angular a template is a sibling of the component that names it — the box
 * appears beside a box that was already there. What it buys: 659 files that
 * were counted under "cannot read" are part of the project instead; a view's
 * git status is on the diagram; and a template nothing names is now
 * distinguishable from one that is a view. What it does not buy is a second
 * edge — see "what a template's own content is worth" below.
 *
 * Two consequences of "claimed by name, never by extension", both of them the
 * price of the rule rather than oversights. The census in `walk.ts` answers one
 * path at a time and so still counts every `.html` as unread: angular/components
 * would draw 659 template boxes and say "not read: .html 678" in the same status
 * bar, and only a caller holding the graph's file set can subtract the one from
 * the other. And the watcher and the hook decide one path at a time too, so a
 * template edited while the app is open is not re-read — the box holds the line
 * count and mtime the boot scan gave it until the project is opened again.
 *
 * ## What a template's own content is worth: nothing, measured
 *
 * The obvious next step is to read `<app-article-list>` out of the template and
 * draw an edge to the component declaring that selector. Both halves of that
 * were measured, and both say no.
 *
 * On gothinkster/angular-realworld-example-app at dd99ed2 — a standalone app,
 * which is how Angular has been written since v14 and the default since v19 —
 * 13 of 13 cross-file selector uses are **already drawn**: a standalone
 * component lists what its template may use in `imports: [FooComponent]`, and
 * that array names a class the file ES-imports, so `typescript.ts` has drawn
 * that edge before this file is opened. The template edge would run from the
 * template instead of from the component beside it — the same coupling, one box
 * further along.
 *
 * On angular/components the rest of the picture is worse. Its 792 selectors are
 * not unique: `mat-icon` is declared in three files, two of which are `.spec`
 * host stubs, and `test-app` in nineteen. A template carries no import line, so
 * there is no binding to resolve a tag through — only a project-wide selector
 * table, which is the whole-table rule, and a whole-table lookup of `mat-icon`
 * picks `src/material/menu/menu.spec.ts`. That is a confident edge into a test
 * stub. A missing edge is a gap; a wrong one is a lie.
 *
 * The half that would be genuinely new is an NgModule app, where the component
 * does not import the component its template uses — the module does. Even there
 * the file-level coupling is usually already drawn, one step coarser:
 * `chips-scene.ts` writes `<mat-chip-listbox>` and imports `MatChipsModule`
 * from `@angular/material/chips`, which that repository's tsconfig maps to
 * `./src/material/chips`, so the edge into the package exists and what a
 * selector table would add is *which file inside it* — the question the
 * `mat-icon` count above says a project-wide table cannot answer. Answering it
 * properly needs the module graph (`declarations`, `exports`, transitively
 * through `imports`) and a selector table scoped to a module. That is a real
 * feature and it is not this one; nothing here pretends to it.
 *
 * ## `styleUrls`, measured and refused
 *
 * angular/components names 530 stylesheets, and 136 of them are not on disk:
 * `styleUrls: ['button-demo.css']` beside a `button-demo.scss`, because the
 * name is the build output and the source is the sibling. Rewriting the
 * extension to find the source would be guessing at a build step this tool does
 * not read. And a stylesheet declares nothing and reaches nothing, so the other
 * 394 would be 394 boxes with exactly one edge each and no second edge ever.
 * The template earns its box by being the view; a stylesheet is how the view
 * looks.
 */

/** The one extension a `templateUrl` names in practice, and the only one taken. */
const TEMPLATE_EXTENSION = '.html';

/**
 * The id a template's file node carries.
 *
 * Asserted rather than written, in one place, because `LanguageId` lives in
 * `types.ts` and this round's registry wiring is what adds `'angular'` to it.
 * When that lands the assertion comes off and nothing else here changes.
 */
const ANGULAR = 'angular' as LanguageId;

/** The decorator that has a view. `@Directive` and `@Pipe` have no template. */
const COMPONENT_DECORATOR = 'Component';

/**
 * The templates a TypeScript file's `@Component` decorators name, as relative
 * specifiers the ordinary resolver can take.
 *
 * Angular resolves `templateUrl` against the directory of the file that wrote
 * it, and it does not require the `./` a module specifier does: 579 of
 * angular/components' 662 template names are written bare, `templateUrl:
 * 'button.html'`, and the other 83 with a `./`. `resolveImport` takes only a
 * specifier that starts with a dot, so normalising here is not a nicety —
 * without it 87% of that repository's views would resolve to nothing. The
 * proportion is the other way round in an application: all 10 of
 * angular-realworld's are written `./`.
 *
 * Read off the tree rather than off the text, and that is load-bearing rather
 * than tidiness. angular/components' own schematics contain
 * `if (propertyName === 'templateUrl' && …)`, which any regexp over the source
 * reads as a component naming its view; a `pair` whose key is `templateUrl`
 * cannot be confused with a string being compared to one.
 *
 * A value that is not a plain string literal — a template literal, a
 * `require(…)`, a constant — is skipped. There were none in either repository
 * measured, and a name this cannot read is a template we do not draw, never a
 * template we draw in the wrong place.
 */
export function componentTemplates(root: SyntaxNode): string[] {
  const found: string[] = [];

  for (const decorator of root.descendantsOfType('decorator')) {
    const call = decorator.namedChildren[0];
    if (!call || call.type !== 'call_expression') continue;
    if (call.childForFieldName('function')?.text !== COMPONENT_DECORATOR) continue;

    const object = call.childForFieldName('arguments')?.namedChildren.find((child) => child.type === 'object');
    if (!object) continue;

    for (const pair of object.namedChildren) {
      if (pair.type !== 'pair') continue;
      if (keyOf(pair) !== 'templateUrl') continue;
      const value = pair.childForFieldName('value');
      const specifier = value && value.type === 'string' ? specifierFor(stringContentOf(value)) : null;
      if (specifier !== null) found.push(specifier);
    }
  }

  return found;
}

/** A property's name, whether it was written bare or quoted. */
function keyOf(pair: SyntaxNode): string | null {
  const key = pair.childForFieldName('key');
  if (!key) return null;
  return key.type === 'string' ? stringContentOf(key) : key.text;
}

/** The text of a string literal, or null when it is not one plain piece. */
function stringContentOf(node: SyntaxNode): string | null {
  const parts = node.namedChildren.filter((child) => child.type === 'string_fragment');
  return parts.length === 1 && parts[0] !== undefined ? parts[0].text : null;
}

/**
 * A `templateUrl` as a relative module specifier, or null when it names
 * something no file in the project could be.
 *
 * A URL and an absolute path are both real things to write — a served template,
 * a path the build maps — and neither is a file this tool walked, so refusing
 * them here keeps them out of the graph rather than out of the count.
 */
function specifierFor(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  if (raw.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return null;
  return raw.startsWith('.') ? raw : `./${raw}`;
}

/**
 * Which templates the project's own files named, project-relative and sorted.
 *
 * The scan's second pass reads this: a file enters the graph here because
 * something named it, and an `.html` file that nothing names is never asked
 * about. Taken off `ParsedFile.imports` rather than off a field of its own,
 * because a name in that list is exactly what "this file reached that one"
 * means everywhere else — and because `import './widget.html'`, which a bundler
 * project writes, is the same claim about the same kind of file.
 *
 * The price of that reuse, stated rather than hidden: such a file is labelled
 * "Angular template" too, because the label comes from the file's language and
 * the specifier does not say which framework wrote it. The status bar would
 * then name Angular in a project that has none. It is the right trade — a
 * bundler's `.html` import is a view being named by code, which is the whole
 * claim — but it is a misattribution and not a rounding error.
 *
 * A specifier that climbs out of the root is dropped: the graph's ids are
 * project-relative paths, and there is no id for a file above the root.
 */
export function namedTemplates(parsed: readonly ParsedFile[]): string[] {
  const named = new Set<string>();

  for (const file of parsed) {
    for (const specifier of file.imports) {
      if (!specifier.startsWith('.')) continue;
      if (!specifier.toLowerCase().endsWith(TEMPLATE_EXTENSION)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file.filePath), specifier));
      if (target.startsWith('..')) continue;
      named.add(target);
    }
  }

  return [...named].sort();
}

/**
 * One template as the graph holds it: a file, its line count, and nothing else.
 *
 * No parse, so no `hasError` — the flag is the grammar's word about a tree, and
 * there is no tree. Absent is the honest answer, and it keeps the box from
 * wearing a syntax-error badge no scanner could have earned.
 */
export function readTemplate(filePath: string, source: string, modifiedAt = 0): ParsedFile {
  return {
    filePath,
    language: ANGULAR,
    imports: [],
    symbols: [],
    lineCount: countLines(source),
    modifiedAt,
  };
}

/**
 * Lines the way `wc -l` counts them, which is how `parser/extract.ts` counts
 * them for every file that is parsed.
 *
 * Copied rather than imported, and the four lines are the cheaper half of the
 * trade: `extract.ts` imports the registry, the registry imports this file, and
 * an import back would put `LANGUAGES` in the middle of a load-time cycle that
 * fails as a bare `ReferenceError`.
 */
function countLines(source: string): number {
  let lines = 0;
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lines++;
  if (source.length > 0 && !source.endsWith('\n')) lines++;
  return lines;
}

/**
 * The language a template's file node claims — registered so the interface can
 * count 659 Angular templates rather than 659 files of no language, and never
 * so that an `.html` file is walked.
 *
 * `registry.ts` keeps this out of `knownExtensions()`, which is what the scan,
 * the watcher and the hook read to decide whether a path is source. That is the
 * whole mechanism: claimed by name, never by extension.
 */
export const angular = {
  id: ANGULAR,
  label: 'Angular template',
  extensions: [TEMPLATE_EXTENSION],

  /**
   * There is none, and this throws rather than returning something that would
   * be handed to `setLanguage`. A wrong grammar there does not fail at the call
   * that was wrong — it fails inside `parse`, or it succeeds and returns a tree
   * of errors, and the box would then carry a syntax-error badge for HTML that
   * is not broken. Unreachable while nothing routes an `.html` file to the
   * parser pool; `readTemplate` is the way in.
   */
  grammar(): never {
    throw new Error('an Angular template is read, not parsed: see readTemplate in src/lang/angular.ts');
  },

  /** A template declares nothing the graph models — see the head of this file. */
  extract(): LanguageParse {
    return { imports: [], symbols: [] };
  },

  /** A template names no other file. What named *it* is the component's edge. */
  resolve(): null {
    return null;
  },
} satisfies LanguageSupport;

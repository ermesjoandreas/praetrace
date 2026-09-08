import type { ParsedSymbol } from '../parser/types.js';
import { typescript, type ModuleParse } from './typescript.js';
import type { LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

/**
 * A Vue single-file component: a template, a script, a style, in one file.
 *
 * **A block splitter, not a grammar, and that was measured rather than
 * assumed.** `tree-sitter-vue` is the only Vue grammar on npm — 0.2.1,
 * published 2021-03-21, and there is no `@tree-sitter-grammars` one — and its
 * binding exports `{ name, nodeTypeInfo }` with no `language` at all, so
 * `setLanguage` on this project's tree-sitter 0.25.1 answers `Invalid language
 * object` for the module and for `.language` alike. There is nothing to load,
 * which is why `package.json` gains no dependency and `RUNTIME_DEPENDENCIES`
 * in scripts/prepare-resources.mjs gains no entry. And there is nothing worth
 * writing by hand either:
 * the script block *is* TypeScript, which this project reads well, and a
 * second-rate reader for it would lose the receivers, the bindings and the
 * re-exports that decide whether a `.vue` file's edges are true.
 *
 * So the script is handed to the TypeScript reader unchanged, and this file
 * does three things around it: find the blocks, keep the line numbers honest,
 * and read the template for the components the file renders.
 *
 * **The line offset is solved by construction, not by arithmetic.** A symbol
 * found at line 3 of a script that starts at line 12 is at line 14, and every
 * id, range and jump-to-source depends on that sum being right everywhere.
 * Rather than shift every number afterwards — one missed range and the panel
 * opens the wrong line — `preprocess` hands the parser a string of exactly the
 * same length as the file, with everything outside the script blanked to
 * spaces and every newline kept. Offsets, rows and columns then *are* the
 * file's, and there is no arithmetic to get wrong. `extract` is given the
 * original source beside the tree, which is where the template still is.
 *
 * **What it does not read**: `<style>`, which declares nothing this graph
 * models; Nuxt's auto-imported components, which is most of elk's template
 * coupling and is deliberate — a tag that matches no import is not an edge,
 * see `renderedComponents`.
 *
 * **Checked against five repositories**, because a language is finished when
 * its edges are, not when it parses: vue-element-admin, elk, element-plus,
 * vitepress and vue-vben-admin — 1 984 components, 0 parse failures, 0 boxes
 * with nothing in them, 0 edges marked `guessed`, and 24 edges read by hand
 * against the source, all true. Before this, every one of those 1 984 files sat
 * under "Cannot read" and was drawn nowhere.
 *
 * The one honest hole the corpus shows is elk, a Nuxt project: 264 components,
 * 1 331 template tags, and 9 of them named by an import. It draws boxes and
 * almost no edges between them, which is the shape CLAUDE.md warns reads as
 * "code with no coupling". Nothing here can fix it — the coupling really is
 * written nowhere in the source, and inventing it from filenames is the one
 * thing this file refuses.
 */

/** One top-level block of a single-file component. */
export interface SfcBlock {
  tag: 'template' | 'script' | 'style';
  /** The open tag's attributes exactly as written: `setup lang="ts"`. */
  attributes: string;
  /** Offsets into the source of the block's content, both tags excluded. */
  start: number;
  end: number;
}

const BLOCK_TAGS = new Set(['template', 'script', 'style']);

/**
 * The top-level blocks, in the order they are written.
 *
 * Top-level is the whole subtlety. `<template>` nests inside itself — every
 * `v-if` on a wrapper is written that way — so its end is found by counting,
 * while `<script>` and `<style>` hold raw text and end at the first closing
 * tag, which is what an HTML parser does with them too: a `'</script>'` inside
 * a string really does end the block, in Vue's own compiler as well as here.
 */
export function blocksOf(source: string): SfcBlock[] {
  const lower = source.toLowerCase();
  const blocks: SfcBlock[] = [];
  let at = 0;

  while (at < source.length) {
    const lt = lower.indexOf('<', at);
    if (lt === -1) break;

    // A comment can hold anything, including the text `<script>`.
    if (lower.startsWith('<!--', lt)) {
      const end = lower.indexOf('-->', lt + 4);
      at = end === -1 ? source.length : end + 3;
      continue;
    }

    const open = openTagAt(source, lt);
    if (open === null || !BLOCK_TAGS.has(open.name)) {
      at = lt + 1;
      continue;
    }

    const tag = open.name as SfcBlock['tag'];
    // `<script src="./x.js" />` has no content and no closing tag to look for.
    const end = open.selfClosing ? open.contentStart : closeOf(lower, tag, open.contentStart);
    blocks.push({ tag, attributes: open.attributes, start: open.contentStart, end });
    // Past the closing tag — `</template>` is the tag's name plus three — but a
    // self-closing block has none, and stepping over one that is not there ate
    // nine characters of markup and with them the <template> that followed.
    at = open.selfClosing ? end : end + tag.length + 3;
  }

  return blocks;
}

interface OpenTag {
  name: string;
  attributes: string;
  contentStart: number;
  selfClosing: boolean;
}

/** The open tag at `at`, or null when that `<` starts something else. */
function openTagAt(source: string, at: number): OpenTag | null {
  let index = at + 1;
  const nameStart = index;
  while (index < source.length && /[A-Za-z]/.test(source[index] ?? '')) index += 1;
  if (index === nameStart) return null;
  const name = source.slice(nameStart, index).toLowerCase();

  // Quotes are tracked because an attribute value may hold a `>`:
  // `<template v-if="a > b">` is one tag, not two.
  const attributeStart = index;
  let quote = '';
  while (index < source.length) {
    const character = source[index] ?? '';
    if (quote !== '') {
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      const attributes = source.slice(attributeStart, index);
      return {
        name,
        attributes,
        contentStart: index + 1,
        selfClosing: attributes.trimEnd().endsWith('/'),
      };
    }
    index += 1;
  }
  return null;
}

/** Where a block's content ends: by depth for a template, by the first close otherwise. */
function closeOf(lower: string, tag: SfcBlock['tag'], from: number): number {
  if (tag !== 'template') {
    const end = lower.indexOf(`</${tag}`, from);
    return end === -1 ? lower.length : end;
  }

  let depth = 1;
  let at = from;
  while (at < lower.length) {
    const close = lower.indexOf('</template', at);
    if (close === -1) return lower.length;
    const open = lower.indexOf('<template', at);
    if (open !== -1 && open < close) {
      depth += 1;
      at = open + '<template'.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) return close;
    at = close + '</template'.length;
  }
  return lower.length;
}

/**
 * The file with everything but its script blocks blanked, character for
 * character. Newlines are kept and everything else becomes a space, so the
 * tree the parser builds carries the .vue file's own rows, columns and byte
 * offsets — see the note at the top of this file about the offset trap.
 */
export function scriptSource(source: string): string {
  const parts: string[] = [];
  let at = 0;
  for (const block of blocksOf(source)) {
    if (block.tag !== 'script') continue;
    parts.push(blank(source.slice(at, block.start)), source.slice(block.start, block.end));
    at = block.end;
  }
  parts.push(blank(source.slice(at)));
  return parts.join('');
}

const blank = (text: string): string => text.replace(/[^\n]/g, ' ');

/**
 * The tag names the template writes, once each.
 *
 * Every tag, not only the ones that look like components: `<sidebar-item>` and
 * `<Logo>` are both how a Vue template names one, and `<div>` is separated
 * from them by what the file imported rather than by its spelling — see
 * `renderedComponents`.
 */
export function templateTags(source: string): string[] {
  const tags = new Set<string>();
  for (const block of blocksOf(source)) {
    if (block.tag !== 'template') continue;
    for (const match of source.slice(block.start, block.end).matchAll(/<([A-Za-z][\w.-]*)/g)) {
      const tag = match[1];
      if (tag !== undefined) tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Every tag name the browser owns, transcribed from `@vue/shared`'s `HTML_TAGS`
 * and `SVG_TAGS` — which is the list Vue's own compiler checks.
 *
 * It exists because a lower-case native tag is *never* a component, whatever
 * the file imported. element-plus's `table.vue` writes `<table>` eight times
 * and imports a **type** called `Table`; matching the tag's PascalCase against
 * the bindings drew a call edge from the table component to itself, and it was
 * the only untrue edge in 2 098 across five repositories. One lie is worth a
 * list: a wrong edge reads as authoritative, a missing one only reads as a gap.
 *
 * `slot` and `template` are in here as HTML elements and are special to the
 * compiler besides; either way they are not components. The SVG half keeps its
 * camel case (`clipPath`, `linearGradient`, `feGaussianBlur`) because Vue
 * matches those exactly, and a tag starting lower-case never reaches the
 * capital-letter shortcut anyway.
 */
const NATIVE_TAGS = new Set(
  (
    'html,body,base,head,link,meta,style,title,address,article,aside,footer,' +
    'header,hgroup,h1,h2,h3,h4,h5,h6,nav,section,div,dd,dl,dt,figcaption,' +
    'figure,picture,hr,img,li,main,ol,p,pre,ul,a,b,abbr,bdi,bdo,br,cite,code,' +
    'data,dfn,em,i,kbd,mark,q,rp,rt,ruby,s,samp,small,span,strong,sub,sup,' +
    'time,u,var,wbr,area,audio,map,track,video,embed,object,param,source,' +
    'canvas,script,noscript,del,ins,caption,col,colgroup,table,thead,tbody,td,' +
    'th,tr,button,datalist,fieldset,form,input,label,legend,meter,optgroup,' +
    'option,output,progress,select,textarea,details,dialog,menu,summary,' +
    'template,blockquote,iframe,tfoot,slot,' +
    'svg,animate,animateMotion,animateTransform,circle,clipPath,color-profile,' +
    'defs,desc,discard,ellipse,feBlend,feColorMatrix,feComponentTransfer,' +
    'feComposite,feConvolveMatrix,feDiffuseLighting,feDisplacementMap,' +
    'feDistantLight,feDropShadow,feFlood,feFuncA,feFuncB,feFuncG,feFuncR,' +
    'feGaussianBlur,feImage,feMerge,feMergeNode,feMorphology,feOffset,' +
    'fePointLight,feSpecularLighting,feSpotLight,feTile,feTurbulence,filter,' +
    'foreignObject,g,hatch,hatchpath,image,line,linearGradient,marker,mask,' +
    'mesh,meshgradient,meshpatch,meshrow,metadata,mpath,path,pattern,polygon,' +
    'polyline,radialGradient,rect,set,solidcolor,stop,switch,symbol,text,' +
    'textPath,tspan,unknown,use,view'
  ).split(','),
);

/** `sidebar-item` and `logo` are both how a template writes `SidebarItem` and `Logo`. */
function pascalCase(tag: string): string {
  return tag
    .split('-')
    .map((part) => (part === '' ? '' : part[0]!.toUpperCase() + part.slice(1)))
    .join('');
}

/**
 * The components the template renders, named as the script bound them.
 *
 * **A tag is an edge only when the file imported something by that name.** Vue
 * matches a tag to a component by name, and a name a file did not bind is not
 * this file's business: `<el-menu>` is element-ui's, `<div>` is the browser's,
 * and in a Nuxt project most tags are auto-imported and named nowhere at all.
 * Matching those against the project by filename would draw the tidy component
 * tree everyone wants and would be a guess — the exact failure this project
 * refuses, since a wrong edge reads as authoritative while a missing one only
 * reads as a gap. Measured on elk, a Nuxt project: 264 components, 1 331
 * template tags, and 9 of them match a binding in the file that wrote them.
 *
 * Both spellings are tried because Vue accepts both, and a project mixes them
 * — vue-element-admin writes `components: { SidebarItem, Logo }` and then
 * `<sidebar-item>` and `<logo>` in the same file. The options API needs no
 * reading of its own for this: all 47 `components:` options in the corpus are
 * the shorthand `{ Name }`, so the registered name is the imported name, which
 * is the name the binding already carries. A renaming registration
 * (`components: { Foo: Bar }`) is a gap, and an honest one — nothing is drawn
 * rather than something wrong.
 *
 * The one exception to "a binding decides" is `NATIVE_TAGS`, and it is Vue's
 * own exception rather than ours: `isComponent` in compiler-core answers no
 * for a lower-case tag the browser already owns, whatever is in scope.
 */
export function renderedComponents(source: string, bound: ReadonlySet<string>): string[] {
  const rendered = new Set<string>();
  for (const tag of templateTags(source)) {
    // `<Foo.Bar />` is a member of an imported namespace, which the graph
    // resolves through the head; the whole name is what it wants.
    if (tag.includes('.')) {
      if (bound.has(tag.slice(0, tag.indexOf('.')))) rendered.add(tag);
      continue;
    }
    if (NATIVE_TAGS.has(tag)) continue;
    for (const candidate of [tag, pascalCase(tag)]) {
      if (bound.has(candidate)) rendered.add(candidate);
    }
  }
  return [...rendered];
}

/**
 * `<script src="./component.js">` and `<template src="./markup.html">`: an SFC
 * may keep a block in another file, and then the coupling is written in the
 * tag rather than in an import statement. `<style src>` is left out — a
 * stylesheet is not a node in this graph.
 */
function srcImports(source: string): string[] {
  const found: string[] = [];
  for (const block of blocksOf(source)) {
    if (block.tag === 'style') continue;
    const src = /(?:^|\s)src\s*=\s*(["'])(.*?)\1/.exec(block.attributes)?.[2];
    if (src !== undefined && src !== '') found.push(src);
  }
  return found;
}

/**
 * The component's name, which the source does not write and Vue takes from the
 * file: `StatusCard.vue` is `StatusCard` however the importer spells it, and
 * `layout/index.vue` is `Layout`, because a directory index is named by its
 * directory in Vue's own convention as in everyone else's.
 *
 * Only a label. Nothing resolves through it — an importer reaches the
 * component as the file's default export, which is what it is.
 */
export function componentName(filePath: string): string {
  const parts = filePath.split('/');
  const base = (parts[parts.length - 1] ?? '').replace(/\.vue$/i, '');
  const named = base.toLowerCase() === 'index' && parts.length > 1 ? (parts[parts.length - 2] ?? base) : base;
  return pascalCase(named.replace(/[^A-Za-z0-9-]/g, '-'));
}

/** Lines the way the file has them; `countLines` lives in the parser, which imports this. */
function lineCount(source: string): number {
  let lines = 0;
  for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) lines += 1;
  return source.length > 0 && !source.endsWith('\n') ? lines + 1 : lines;
}

/**
 * The component itself, as a symbol.
 *
 * An SFC declares exactly one component and never names it — `<script setup>`
 * has no `export default` to write it on, and the compiler supplies one. So
 * the source really does declare a classifier here, and this is the node for
 * it: what the template renders hangs off it, which is the one relationship a
 * component tree is made of, and `<StatusCard />` in another file has
 * something to land on. Without it the render edge cannot be drawn at all,
 * because a file is not a name and the file's own import edge cannot say which
 * of the things it imported it puts on screen.
 *
 * `exported` is false and `defaultExport` names it instead, for the same
 * reason `export default class Foo` does: it leaves the file as `default`, not
 * under its own name.
 */
function componentSymbol(name: string, source: string, calls: string[]): ParsedSymbol {
  return {
    name,
    kind: 'class',
    startLine: 1,
    endLine: Math.max(lineCount(source), 1),
    extends: [],
    implements: [],
    calls,
    exported: false,
  };
}

/**
 * The contract, minus the three things `src/lang/types.ts` has still to admit:
 * `'vue'` as a LanguageId, `preprocess`, and a third `filePath` argument to
 * `extract`. Written here so this file compiles before those land, and it is
 * exactly `LanguageSupport` once they do — delete the alias then and write
 * `satisfies LanguageSupport` like every other language does.
 *
 * Until `parser/extract.ts` calls `preprocess`, nothing here runs: the file
 * would be parsed as markup by a TypeScript grammar and yield nothing. This
 * degrades to an empty box rather than to a wrong one, which is the direction
 * this project errs in, but it is a wiring step and not an option.
 */
type VueSupport = Omit<LanguageSupport, 'id'> & {
  id: 'vue';
  preprocess(source: string): string;
};

export const vue = {
  id: 'vue',
  label: 'Vue',
  extensions: ['.vue'],

  grammar(_filePath: string): unknown {
    // The `tsx` dialect for every SFC, and the choice is measured rather than
    // reasoned: over 2 172 `.vue` files in five repositories the plain
    // TypeScript grammar fails to parse 11 and `tsx` fails 1, while the two
    // agree on every binding and differ by five symbols in `tsx`'s favour. The
    // 11 are all render functions written in JSX with no `lang` to announce it
    // — element-plus's table-v2 examples, vue-element-admin's Sidebar/Item —
    // which is legal Vue and unparseable as TypeScript. The 1 both fail is
    // vitepress's `<script setup<%= useTs ? … %>>`, an EJS scaffold rather
    // than a component.
    //
    // The `lang` attribute cannot decide this, tempting as it is: `grammar` is
    // handed the path and never the source, so the dialect is one answer for
    // the whole language. `tsx`'s own price is the `<T>expr` cast, which is
    // not legal in a `.tsx` file either and appears nowhere in the corpus.
    // Not tree-sitter-javascript, whose class members the TypeScript extractor
    // cannot read — the silent failure javascript.ts exists to avoid.
    return typescript.grammar('sfc.tsx');
  },

  /** See the note at the top of this file: the blanking is what keeps the lines true. */
  preprocess(source: string): string {
    return scriptSource(source);
  },

  /**
   * The script's reading, plus what only the whole file can say.
   *
   * `root` is the tree of the blanked source and `source` is the file as
   * written, so the symbols carry .vue line numbers while the template is
   * still here to be read. `filePath` is what names the component; without it
   * — a caller that has not started passing it — the component gets no node
   * and the template's tags fall back to the file, which is a weaker edge
   * rather than a wrong one.
   */
  extract(root: SyntaxNode, source: string, filePath?: string): ModuleParse {
    const parse = typescript.extract(root, source);
    const bound = new Set(parse.bindings.map((binding) => binding.local));
    const rendered = renderedComponents(source, bound);

    // A component the script declared as a symbol of its own — `export default
    // class Foo` — is the one that renders, and nothing needs inventing.
    // Everything else does: `<script setup>` exports a component it never
    // writes, `export default { … }` and `export default defineComponent(…)`
    // export an object literal, and `const X = defineComponent(…); export
    // default X` binds a name to a call, which is not a symbol either. The
    // last one is why the test is `declared === undefined` and not "no default
    // export": it left vben's descriptions-item.vue as the one empty box in
    // 1 984 components.
    //
    // The name is the source's own when it wrote one, and the file's when it
    // did not — see `componentName`.
    const declared =
      parse.defaultExport === undefined
        ? undefined
        : parse.symbols.find((symbol) => symbol.owner === undefined && symbol.name === parse.defaultExport);
    const component =
      declared === undefined && filePath !== undefined
        ? componentSymbol(parse.defaultExport ?? componentName(filePath), source, rendered)
        : undefined;
    if (declared !== undefined) declared.calls = [...new Set([...declared.calls, ...rendered])];

    return {
      ...parse,
      imports: [...parse.imports, ...srcImports(source)],
      // The component first: it is what the file is, and a box reads top down.
      symbols: component === undefined ? parse.symbols : [component, ...parse.symbols],
      calls:
        component === undefined && declared === undefined
          ? [...new Set([...parse.calls, ...rendered])]
          : parse.calls,
      ...(component === undefined ? {} : { defaultExport: component.name }),
    };
  },

  /**
   * A specifier in an SFC is an ES specifier, so it means what TypeScript says
   * it means — the same argument javascript.ts makes for delegating, and the
   * same risk in copying: two rules for one syntax drift.
   *
   * The one thing .vue adds is that `./Logo` may be `Logo.vue` and `@/layout`
   * may be `layout/index.vue`, and that is extension arithmetic, which lives
   * in graph/resolve.ts where every language shares it.
   */
  resolve(context: ResolveContext): string | null {
    return typescript.resolve(context);
  },
} satisfies VueSupport;

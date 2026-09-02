import { createRequire } from 'node:module';
import path from 'node:path';

import type { ParsedSymbol, SymbolKind } from '../parser/types.js';
import type { LanguageParse, LanguageSupport, ResolveContext, SyntaxNode } from './types.js';

// The grammars are native CommonJS addons with no ESM entry point.
const require = createRequire(import.meta.url);

let loaded: unknown = null;

/** The bare name a path or type node ends in. */
function nameOf(node: SyntaxNode | null): string | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'field_identifier':
      return node.text;
    // `Vec<Str>` — this grammar puts the base type under `type`, not `name`.
    case 'generic_type':
      return nameOf(node.childForFieldName('type'));
    case 'scoped_type_identifier':
    case 'scoped_identifier':
      return nameOf(node.childForFieldName('name'));
    case 'reference_type':
      return nameOf(node.childForFieldName('type'));
    default:
      return null;
  }
}

/** `crate::builder::Arg` -> `['crate', 'builder', 'Arg']`. */
function segmentsOf(node: SyntaxNode | null): string[] | null {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'crate':
    case 'self':
    case 'super':
      return [node.text];
    case 'scoped_identifier':
    case 'scoped_type_identifier': {
      const prefix = segmentsOf(node.childForFieldName('path'));
      const name = node.childForFieldName('name')?.text;
      return prefix && name !== undefined ? [...prefix, name] : null;
    }
    default:
      return null;
  }
}

/**
 * One `use` is any number of references: `use a::{b, c::d}` names two, and each
 * is expanded to its whole path because it is the whole path that decides which
 * file the reference lands in. Recording only the `a::` prefix would draw an
 * edge to the crate root for something that actually reaches into two modules.
 */
function expandUse(node: SyntaxNode, prefix: readonly string[], out: string[][]): void {
  switch (node.type) {
    case 'use_as_clause': {
      const target = node.childForFieldName('path');
      if (target) expandUse(target, prefix, out);
      return;
    }
    case 'use_wildcard': {
      // `use crate::util::*` names the module and nothing in particular, which
      // is exactly what an import edge is drawn from anyway.
      const inner = node.namedChildren[0];
      if (inner) expandUse(inner, prefix, out);
      else out.push([...prefix]);
      return;
    }
    case 'scoped_use_list': {
      const head = segmentsOf(node.childForFieldName('path')) ?? [];
      const list = node.childForFieldName('list');
      if (list) expandUse(list, [...prefix, ...head], out);
      return;
    }
    case 'use_list': {
      for (const item of node.namedChildren) expandUse(item, prefix, out);
      return;
    }
    default: {
      const segments = segmentsOf(node);
      if (segments) out.push([...prefix, ...segments]);
    }
  }
}

/**
 * Re-anchor a path onto the file's own module.
 *
 * `self` and `super` mean different things at different depths inside one file,
 * and the resolver is given a file rather than a position in it. So the depth is
 * spent here, where it is known: inside `#[cfg(test)] mod tests { … }` — 21 of
 * clap's 39 inline modules — `use super::*` names this very file, and reading it
 * as the file's parent would draw an edge the source does not contain.
 */
function anchor(segments: readonly string[], depth: number): string | null {
  if (depth === 0) return segments.join('::');

  const head = segments[0];
  // `crate::` and a crate name are absolute; nesting cannot change them.
  if (head !== 'self' && head !== 'super') return segments.join('::');

  let supers = 0;
  while (segments[supers] === 'super') supers += 1;
  // Not enough `super`s to climb out of the inline modules: still this file.
  if (supers <= depth) return null;
  return segments.slice(depth).join('::');
}

/**
 * Every reference the file makes to another module, as a path rooted at the
 * file's own module.
 *
 * A `mod foo;` is one of them. It is Rust's only statement of file structure —
 * nothing else says that `lib.rs` and `builder/mod.rs` belong to one tree — so
 * without it the module files of a crate would draw as an unconnected pile.
 * Written as `self::foo` so it resolves by the same rule as everything else.
 *
 * The whole tree is searched, not just the top level: a `use` inside a function
 * body or an impl block is scoped to the same module as one at the top of the
 * file, and 166 of clap's 1049 are written that way.
 */
function collectReferences(root: SyntaxNode): string[] {
  const inlineModules = root
    .descendantsOfType('mod_item')
    .filter((node) => node.childForFieldName('body') !== null);
  const depthOf = (node: SyntaxNode): number =>
    inlineModules.filter(
      (scope) => node.startIndex >= scope.startIndex && node.endIndex <= scope.endIndex,
    ).length;

  const out: string[] = [];

  for (const declaration of root.descendantsOfType('use_declaration')) {
    const argument = declaration.childForFieldName('argument');
    if (!argument) continue;
    const paths: string[][] = [];
    expandUse(argument, [], paths);
    const depth = depthOf(declaration);
    for (const segments of paths) {
      const specifier = anchor(segments, depth);
      if (specifier) out.push(specifier);
    }
  }

  for (const declaration of root.descendantsOfType('mod_item')) {
    if (declaration.childForFieldName('body')) continue;
    const name = nameOf(declaration.childForFieldName('name'));
    // A file-less `mod` nested in an inline one names a file two levels down;
    // rare enough that guessing at it would cost more than it is worth.
    if (name && depthOf(declaration) === 0) out.push(`self::${name}`);
  }

  // A path written out where it is used — `crate::builder::Str` in a type, or
  // `super::utils::run()` in a call — is as much a dependency as the `use` that
  // would have shortened it, and 16 of clap's 523 file-to-file edges exist only
  // this way. Only these three heads are taken: they are the only ones that can
  // mean nothing but this project. Admitting any head instead reaches another 26
  // edges, all of them `clap::…` written in full by a test or an example — and
  // costs 2.5x the specifiers, because `std::ffi::OsStr::new()` is written
  // exactly like a module path and only the facts, which extract cannot see,
  // could tell them apart. The store re-resolves every specifier on every save.
  let covered = -1;
  for (const reference of root.descendantsOfType(['scoped_identifier', 'scoped_type_identifier'])) {
    // Pre-order, so the whole path is seen before the prefixes nested in it.
    if (reference.startIndex < covered) continue;
    const segments = segmentsOf(reference);
    const head = segments?.[0];
    if (!segments || (head !== 'crate' && head !== 'self' && head !== 'super')) continue;
    covered = reference.endIndex;
    const specifier = anchor(segments, depthOf(reference));
    if (specifier) out.push(specifier);
  }

  // The same reference written twice — and a `use` path is found by both passes
  // — is one dependency, not two.
  return [...new Set(out)];
}

/**
 * A struct, an enum and a union are all classes.
 *
 * TypeScript's enums are drawn as `type` because they have no operations. Rust's
 * do: `impl ArgAction { … }` is the normal way to give a sum type behaviour, and
 * only a `class` can own a method here — the store keys its owner table by class
 * — so calling an enum a type would silently detach every method written for it
 * and reattach it to the file.
 *
 * A trait is an interface: named operations, no state, implemented by others.
 */
const DECLARATIONS: ReadonlyMap<string, SymbolKind> = new Map([
  ['struct_item', 'class'],
  ['enum_item', 'class'],
  ['union_item', 'class'],
  ['trait_item', 'interface'],
  ['function_item', 'function'],
  ['type_item', 'type'],
  // `macro_rules!` declares something callable by name. Without it a file that
  // is nothing but macros — clap_builder/src/macros.rs is twelve of them — draws
  // as an empty box.
  ['macro_definition', 'function'],
]);

/**
 * Absence is a declaration in Rust, unlike TypeScript where it means public and
 * `public` can also be written. `pub(crate)` and `pub(super)` are neither of the
 * other two: visible across a bounded region and sealed outside it, which is the
 * sense UML's protected carries.
 */
function visibilityOf(node: SyntaxNode): 'public' | 'private' | 'protected' {
  const modifier = node.children.find((child) => child.type === 'visibility_modifier');
  if (!modifier) return 'private';
  return modifier.text === 'pub' ? 'public' : 'protected';
}

/** `Vec<Arg>` is how Rust spells a 1..* association. */
const COLLECTIONS: ReadonlySet<string> = new Set(['Vec', 'VecDeque', 'HashSet', 'BTreeSet']);
/** Wrappers that say how a value is held, not what it is. */
const WRAPPERS: ReadonlySet<string> = new Set(['Option', 'Box', 'Rc', 'Arc', 'Cow']);

/** The first type a generic argument list names, skipping lifetimes. */
function firstArgument(node: SyntaxNode): SyntaxNode | null {
  const args = node.childForFieldName('type_arguments');
  return args?.namedChildren.find((child) => child.type !== 'lifetime') ?? null;
}

/**
 * The declared type of a field, reduced to the one name an association can be
 * drawn to. A primitive is not a classifier, so `count: usize` yields nothing.
 */
function typeOf(node: SyntaxNode | null): { typeName?: string; many?: boolean } {
  if (!node) return {};

  switch (node.type) {
    case 'reference_type':
      return typeOf(node.childForFieldName('type'));
    // `[Id; 3]` and `&[u8]` are both `array_type`; only the element is a name.
    case 'array_type':
      return { ...typeOf(node.childForFieldName('element')), many: true };
    case 'generic_type': {
      const base = nameOf(node.childForFieldName('type'));
      if (base === null) return {};
      if (COLLECTIONS.has(base)) return { ...typeOf(firstArgument(node)), many: true };
      if (WRAPPERS.has(base)) return typeOf(firstArgument(node));
      return { typeName: base };
    }
    default: {
      const name = nameOf(node);
      return name === null ? {} : { typeName: name };
    }
  }
}

/**
 * Names invoked inside a symbol. `exclude` holds subtrees that are symbols in
 * their own right, so a trait does not also claim what its default methods call.
 *
 * `Type::method()` attributes to `Type`, not to `method`: the store keeps
 * methods out of its name table, so the trailing segment could only ever match
 * some unrelated free function of the same name.
 */
function collectCalls(node: SyntaxNode, exclude: readonly SyntaxNode[] = []): string[] {
  const names = new Set<string>();
  const inside = (candidate: SyntaxNode): boolean =>
    exclude.some((skip) => candidate.startIndex >= skip.startIndex && candidate.endIndex <= skip.endIndex);

  const add = (name: string | null): void => {
    // `Self` and `crate` name the caller or its root, never a callee.
    if (name && name !== 'Self' && name !== 'crate' && name !== 'super') names.add(name);
  };

  for (const call of node.descendantsOfType('call_expression')) {
    if (inside(call)) continue;
    let target = call.childForFieldName('function');
    // `foo::<T>()` — the turbofish wraps the name it is applied to.
    if (target?.type === 'generic_function') target = target.childForFieldName('function');
    if (target?.type === 'scoped_identifier') add(nameOf(target.childForFieldName('path')));
    else add(nameOf(target));
  }
  // A struct literal is Rust's constructor call, and a macro is read as a call
  // by anyone writing the code even though the compiler expands it earlier.
  for (const literal of node.descendantsOfType('struct_expression')) {
    if (!inside(literal)) add(nameOf(literal.childForFieldName('name')));
  }
  for (const macro of node.descendantsOfType('macro_invocation')) {
    if (!inside(macro)) add(nameOf(macro.childForFieldName('macro')));
  }

  return [...names];
}

/** Every trait a bound list names, lifetimes dropped. */
function boundNames(node: SyntaxNode | null): string[] {
  if (!node) return [];
  const names: string[] = [];
  for (const child of node.namedChildren) {
    const name = nameOf(child);
    if (name) names.push(name);
  }
  return names;
}

function makeSymbol(node: SyntaxNode, name: string, kind: SymbolKind): ParsedSymbol {
  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    extends: [],
    implements: [],
    calls: [],
  };
}

/** An associated function — no `self` receiver — is UML's static operation. */
function isAssociated(member: SyntaxNode): boolean {
  const parameters = member.childForFieldName('parameters');
  return !parameters?.namedChildren.some((child) => child.type === 'self_parameter');
}

function makeMethod(
  member: SyntaxNode,
  owner: string,
  visibility: ParsedSymbol['visibility'],
): ParsedSymbol | null {
  const name = nameOf(member.childForFieldName('name'));
  if (!name) return null;
  return {
    ...makeSymbol(member, name, 'method'),
    owner,
    calls: collectCalls(member),
    ...(visibility === undefined ? {} : { visibility }),
    ...(isAssociated(member) ? { isStatic: true } : {}),
    // A body-less signature in a trait is the operation the implementors owe.
    ...(member.type === 'function_signature_item' ? { isAbstract: true } : {}),
  };
}

/** A struct's or union's fields, as the attributes of its box. */
function collectFields(declaration: SyntaxNode, owner: string): ParsedSymbol[] {
  const body = declaration.childForFieldName('body');
  if (body?.type !== 'field_declaration_list') return [];

  const fields: ParsedSymbol[] = [];
  for (const member of body.namedChildren) {
    if (member.type !== 'field_declaration') continue;
    const name = nameOf(member.childForFieldName('name'));
    if (!name) continue;
    fields.push({
      ...makeSymbol(member, name, 'field'),
      owner,
      visibility: visibilityOf(member),
      ...typeOf(member.childForFieldName('type')),
    });
  }
  return fields;
}

/**
 * A trait's operations. Returns their subtrees so the trait does not also claim
 * the calls its default methods make.
 */
function collectTraitMembers(
  declaration: SyntaxNode,
  owner: string,
  into: ParsedSymbol[],
): SyntaxNode[] {
  const body = declaration.childForFieldName('body');
  if (!body) return [];

  const bodies: SyntaxNode[] = [];
  for (const member of body.namedChildren) {
    if (member.type !== 'function_item' && member.type !== 'function_signature_item') continue;
    // A trait member has no visibility of its own: it is as public as the trait.
    const method = makeMethod(member, owner, 'public');
    if (!method) continue;
    bodies.push(member);
    into.push(method);
  }
  return bodies;
}

/**
 * What one file declares, before its `impl` blocks are folded in.
 *
 * Keyed by name so an `impl` written anywhere in the file — above the type as
 * often as below it — finds the declaration it belongs to.
 */
interface Declared {
  symbol: ParsedSymbol;
  members: ParsedSymbol[];
}

function collectDeclarations(root: SyntaxNode): Map<string, Declared> {
  const declared = new Map<string, Declared>();

  for (const node of root.namedChildren) {
    const kind = DECLARATIONS.get(node.type);
    if (kind === undefined) continue;
    const name = nameOf(node.childForFieldName('name'));
    if (name === null || declared.has(name)) continue;

    const members: ParsedSymbol[] = [];
    const claimed = kind === 'interface' ? collectTraitMembers(node, name, members) : [];
    if (kind === 'class') members.push(...collectFields(node, name));

    declared.set(name, {
      symbol: {
        ...makeSymbol(node, name, kind),
        // Only a trait carries bounds, and a supertrait is inheritance between
        // interfaces — the one thing in Rust that extends anything.
        extends: boundNames(node.childForFieldName('bounds')),
        calls: collectCalls(node, claimed),
        // `macro_rules!` takes no visibility modifier — `#[macro_export]` is an
        // attribute — so reporting one would be inventing it.
        ...(node.type === 'macro_definition' ? {} : { visibility: visibilityOf(node) }),
      },
      members,
    });
  }

  return declared;
}

/**
 * Fold the `impl` blocks into the types they belong to.
 *
 * This is the reason Rust fits a model built for classes at all: behaviour is
 * declared apart from data, and `owner` is what puts it back. `impl Trait for
 * Foo` is the implements edge; `impl Foo` is Foo's own operations.
 */
function collectImpls(root: SyntaxNode, declared: Map<string, Declared>): ParsedSymbol[] {
  const detached: ParsedSymbol[] = [];

  for (const node of root.namedChildren) {
    if (node.type !== 'impl_item') continue;
    const owner = nameOf(node.childForFieldName('type'));
    if (!owner) continue;

    const target = declared.get(owner);
    const trait = nameOf(node.childForFieldName('trait'));
    // `impl From<A> for Id` and `impl From<B> for Id` are one relationship on a
    // diagram that has no type arguments to tell them apart. clap's Id has eight.
    if (trait && target && !target.symbol.implements.includes(trait)) {
      target.symbol.implements.push(trait);
    }

    const body = node.childForFieldName('body');
    for (const member of body?.namedChildren ?? []) {
      if (member.type !== 'function_item') continue;
      // A trait impl's methods are as visible as the trait; an inherent impl
      // states its own.
      const method = makeMethod(member, owner, trait ? 'public' : visibilityOf(member));
      if (!method) continue;
      // An impl for a type declared elsewhere still says what this file does;
      // the store attaches it to the file when it cannot find the owner.
      if (target) target.members.push(method);
      else detached.push(method);
    }
  }

  return detached;
}

/** The file that stands for a module path, whichever way Rust lets it be spelled. */
function moduleFile(modulePath: string, files: ReadonlySet<string>): string | null {
  if (files.has(`${modulePath}.rs`)) return `${modulePath}.rs`;
  for (const name of ['mod.rs', 'lib.rs', 'main.rs']) {
    const candidate = path.posix.join(modulePath, name);
    if (files.has(candidate)) return candidate;
  }
  return null;
}

interface CrateRoot {
  /** The `lib.rs` / `main.rs` the module tree hangs from. */
  file: string;
  /** Its directory, which is what `crate::` names. */
  directory: string;
}

function crateRootOf(from: string, files: ReadonlySet<string>): CrateRoot {
  let directory = path.posix.dirname(from);
  for (;;) {
    for (const name of ['lib.rs', 'main.rs']) {
      const candidate = path.posix.join(directory, name);
      if (files.has(candidate)) return { file: candidate, directory };
    }
    if (directory === '.' || directory === '') break;
    directory = path.posix.dirname(directory);
  }
  // Cargo compiles every examples/*.rs and benches/*.rs as its own binary, so a
  // file with no lib.rs or main.rs above it is a crate root in its own right.
  return { file: from, directory: path.posix.dirname(from) };
}

/** The directory holding this file's child modules. */
function moduleDirectoryOf(from: string, root: CrateRoot): string {
  const directory = path.posix.dirname(from);
  // A crate root and a `mod.rs` are the module their own directory stands for;
  // any other file opens a directory named after it.
  if (from === root.file || path.posix.basename(from) === 'mod.rs') return directory;
  return path.posix.join(directory, path.posix.basename(from, '.rs'));
}

/**
 * Walk a module path down as far as the project actually has files for.
 *
 * The trailing segments of a `use` are items, not modules — `crate::builder::Str`
 * names one module and one type in it — and nothing says which is which, so the
 * longest prefix that is a file wins. Falling all the way back to the base is
 * what makes `use crate::INTERNAL_ERROR_MSG` an edge to the crate root.
 */
function descend(base: string, segments: readonly string[], files: ReadonlySet<string>): string | null {
  for (let depth = segments.length; depth > 0; depth -= 1) {
    const hit = moduleFile(path.posix.join(base, ...segments.slice(0, depth)), files);
    if (hit) return hit;
  }
  return moduleFile(base, files);
}

export const rust: LanguageSupport = {
  id: 'rust',
  label: 'Rust',
  extensions: ['.rs'],

  grammar(_filePath: string) {
    // The module itself, not its `.language`: the binding reads node-type info
    // off the module, and the bare language crashes inside parse().
    loaded ??= require('tree-sitter-rust');
    return loaded;
  },

  extract(root: SyntaxNode, _source: string): LanguageParse {
    const imports = collectReferences(root);

    const declared = collectDeclarations(root);
    const detached = collectImpls(root, declared);

    // Each type before the members that name it as owner: the store builds its
    // owner table in one pass over this list, so a method arriving first would
    // attach to the file instead of to its type.
    const symbols: ParsedSymbol[] = [];
    for (const { symbol, members } of declared.values()) symbols.push(symbol, ...members);
    symbols.push(...detached);

    return { imports, symbols };
  },

  /**
   * Rust resolves through the module tree, not the filesystem: a path is a walk
   * from a root, and only the root differs. `crate` is this file's own crate,
   * `self` and `super` are positions in it, and a leading name is another crate
   * — one of the workspace's, or `std` and the registry, which resolve to null
   * because they are genuinely not in the project.
   */
  resolve(context: ResolveContext): string | null {
    const { from, specifier, files, facts } = context;
    const segments = specifier.split('::');
    const head = segments[0];
    if (head === undefined) return null;

    const root = crateRootOf(from, files);

    if (head === 'crate') return descend(root.directory, segments.slice(1), files);

    if (head === 'self' || head === 'super') {
      let base = moduleDirectoryOf(from, root);
      let index = head === 'self' ? 1 : 0;
      while (segments[index] === 'super') {
        base = path.posix.dirname(base);
        index += 1;
      }
      return descend(base, segments.slice(index), files);
    }

    const crate = facts.crates.get(head);
    // The facts hand over the directory holding Cargo.toml. Cargo's `[lib] path`
    // can move the sources anywhere, but nothing in the corpus does, and a
    // manifest key the facts do not carry is not worth inventing a fact for.
    if (crate !== undefined) return descend(path.posix.join(crate, 'src'), segments.slice(1), files);

    // Rust 2018 lets a path start at a module in scope with no `self::` in front
    // of it, which is how clap_builder/src/builder/mod.rs writes 40 re-exports
    // (`pub use action::ArgAction;`). Admitted only when that module really is a
    // file here: without the check, `std::io::Write` would fall back to the base
    // and report itself resolved.
    const here = moduleDirectoryOf(from, root);
    if (moduleFile(path.posix.join(here, head), files) === null) return null;
    return descend(here, segments, files);
  },
};

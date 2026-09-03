/**
 * A second opinion on the call graph, from the TypeScript checker.
 *
 * The checker knows what our parser only guesses at: which declaration a name
 * actually reaches, through a barrel, an alias, an inherited member or a
 * `require`. So it can say where our edges are wrong — and that is the only
 * job it has here. **Nothing in the graph comes from it.** It is not in the
 * live path and must not be put there, for four measured reasons:
 *
 * - it costs ten to forty times what we do (zod 4.0 s / 1.4 GB against our
 *   0.3 s / 192 MB, TanStack/query 16.4 s / 2.0 GB against 0.4 s / 193 MB);
 * - it speaks TypeScript and JavaScript, and the tool reads six languages;
 * - it needs the repository installed, which a map of someone's code does not;
 * - it fails silently. A consumer package whose tsconfig lacked `jsx` refused
 *   its dependency's `.tsx` source and cost 37 real edges without a word.
 *
 * That last one is why `readWithChecker` asks for `getSemanticDiagnostics` and
 * compares no file that has one. A checker that cannot see a module answers
 * "no reference here" in exactly the voice it uses for "correct, nothing to
 * report", and a comparison built on that reads as our own recall problem.
 *
 * JavaScript was the hole in that guard, and it was the wide half. `checkJs` is
 * off, so `getSemanticDiagnostics` answers nothing for a `.js` file however
 * blind the program is over it: two files whose every `require` failed to
 * resolve came back "2 compared · 0 skipped", and express printed 141 compared,
 * 0 skipped and a precision of 100% on that footing. So a JavaScript file is
 * asked the resolution question directly — see `unresolvedModuleIn` — and
 * skipped for the same 2307 a TypeScript file would have been skipped for. Its
 * *types* are still unchecked, which is a smaller blindness because a type
 * error costs no edge, and `scripts/oracle.mjs` says so in the report rather
 * than leaving it to be inferred from this comment.
 */

import path from 'node:path';
import ts from 'typescript';
import type { Graph } from '../graph/types.js';

/** The three edge kinds a reference site produces; the rest are not references. */
export type OracleEdgeKind = 'calls' | 'extends' | 'implements';

/**
 * One edge in our own vocabulary: `from` and `to` are GraphNode ids — a file
 * path, `path#Name`, or `path#Owner.member` — so a reading can be set-compared
 * with `Graph.edges` and nothing has to translate in the middle.
 */
export interface OracleEdge {
  from: string;
  to: string;
  kind: OracleEdgeKind;
}

/**
 * Why a reference the checker resolved could not be written as one of our
 * edges. Counted rather than dropped: this is the ranked list of what our
 * model has no way to say, and it is a different thing from an edge we missed.
 */
export type UnnamableReason =
  /** node_modules, a lib, or a file the scan does not read — `.d.ts`, say. */
  | 'the declaration is outside the scanned files'
  /** `const x = compute()` — a value binding is not a symbol in our model. */
  | 'the declaration is a value binding, not a declaration'
  /** A parameter, an enum member, a nested function: real, but never a node. */
  | 'the declaration kind has no node'
  /** An untyped receiver, an IIFE, `any`. The checker knows no more than we do. */
  | 'the checker resolved nothing'
  /** `super()`, which the `extends` edge already says. */
  | 'super(), which extends already draws';

/** A file left out of the comparison, and the first diagnostic that did it. */
export interface SkippedFile {
  file: string;
  code: number;
  message: string;
}

export interface OracleReading {
  /** Project-relative files the checker read, type-checked and found clean. */
  compared: string[];
  /** Files the checker could not vouch for; their edges are in neither set. */
  skipped: SkippedFile[];
  /** Every reference site in `compared`, deduplicated the way the store is. */
  edges: OracleEdge[];
  /** Reason -> sites, commonest first. Sites, not edges: there is no edge. */
  unnamable: [UnnamableReason, number][];
  ms: number;
}

/** Why one side has an edge the other does not. */
export type DifferenceCause =
  /** We have no node for the caller at all, so the edge had nowhere to start. */
  | 'no caller node'
  /** We have no node for the target. */
  | 'no target node'
  /** Both nodes are in the graph; the reference between them is what we lost. */
  | 'both nodes exist, the edge does not';

export interface Difference {
  edge: OracleEdge;
  cause: DifferenceCause;
}

export interface OracleComparison {
  agree: OracleEdge[];
  /** The checker found it and we did not: recall, and where it goes. */
  onlyChecker: Difference[];
  /** We drew it and the checker did not. Every one is a lie until classified. */
  onlyOurs: OracleEdge[];
  precision: number;
  recall: number;
}

/** What a TypeScript program will read. The graph reads more than this. */
const CHECKED_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const EDGE_KINDS = new Set<string>(['calls', 'extends', 'implements'] satisfies OracleEdgeKind[]);

/** Which of the graph's six edge kinds a reference site can produce. */
const isReference = (kind: string): kind is OracleEdgeKind => EDGE_KINDS.has(kind);

/**
 * A file the program parses but never type-checks, `checkJs` being off. Named
 * once because both this module and the report have to know which files a
 * clean bill of health means less for.
 */
export function isUncheckedJavaScript(file: string): boolean {
  return /\.[cm]?jsx?$/i.test(file);
}

/** The files of a scan a TypeScript program can be built over. */
export function checkedFiles(files: readonly string[]): string[] {
  return files.filter(
    (file) => CHECKED_EXTENSIONS.has(path.posix.extname(file)) && !/\.d\.[cm]?ts$/.test(file),
  );
}

/**
 * The compiler options to read a repository with.
 *
 * A repository's own configuration is not usable as given, and the reasons are
 * specific: TanStack/query's root config lists two files, and every package
 * config under it sets `composite` with `emitDeclarationOnly`, which yields a
 * program with no root files — and no error, because nothing was asked to be
 * compiled. So the *file list* is always ours, from the same scan the graph
 * was built from, and only the knobs that decide **resolution** are taken from
 * the repository: `paths`, `baseUrl`, `customConditions`, `moduleResolution`.
 * Those are not guesses — zod reaches its own packages through
 * `customConditions: ['@zod/source']`, and without it 201 of its imports
 * cannot be found.
 *
 * What is forced, and why:
 * - `allowJs`, because the graph reads JavaScript and a TypeScript repository's
 *   config usually does not;
 * - `jsx` when the repository named none, the 37-edge failure above;
 * - `noEmit` and no `composite`/`declaration`, so the program is a reading and
 *   never a build;
 * - `noUnusedLocals` off: an unused import is not a resolution failure, and
 *   leaving it on would exclude the file from the comparison for nothing.
 */
export function compilerOptions(root: string): ts.CompilerOptions {
  const configPath = path.join(root, 'tsconfig.json');
  const read = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  const parsed = ts.parseJsonConfigFileContent(read.config ?? {}, ts.sys, root, undefined, configPath);

  return {
    ...parsed.options,
    allowJs: true,
    // JavaScript is only type-checked when a repository asks for it, so a JS
    // file's clean bill of health means it parsed — not that it was checked.
    // Turning this on instead would be a worse trade: express has no tsconfig
    // and no annotations, so every one of its files would carry a type error
    // and the comparison would be refused whole, over errors that cost no edge.
    // `unresolvedModuleIn` asks the half that does cost edges.
    checkJs: false,
    jsx: parsed.options.jsx ?? ts.JsxEmit.Preserve,
    noEmit: true,
    composite: false,
    declaration: false,
    emitDeclarationOnly: false,
    incremental: false,
    skipLibCheck: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    target: parsed.options.target ?? ts.ScriptTarget.ESNext,
    // A repository that named neither gets the pair that admits `import` and
    // `require` in one program. A graph is read over whatever the repository
    // writes, not over one module system — express is CommonJS and has no
    // tsconfig at all.
    module: parsed.options.module ?? ts.ModuleKind.Preserve,
    moduleResolution: parsed.options.moduleResolution ?? ts.ModuleResolutionKind.Bundler,
  };
}

/** Where a file really is, symlinks followed; see `wanted` below. */
function canonical(file: string): string {
  try {
    return ts.sys.realpath?.(file) ?? file;
  } catch {
    return file;
  }
}

/** The file half of a node id: everything before the first `#`, or all of it. */
function fileOfId(id: string): string {
  const hash = id.indexOf('#');
  return hash === -1 ? id : id.slice(0, hash);
}

/**
 * Every module a file names: an import, an `export … from`, `import()` and
 * `require()`.
 *
 * Walked rather than read off `SourceFile.imports`, which TypeScript does not
 * expose: the list is there, and it is marked internal, so a version bump could
 * take it away without the compiler saying anything.
 */
function moduleSpecifiersOf(source: ts.SourceFile): ts.StringLiteralLike[] {
  const found: ts.StringLiteralLike[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier !== undefined && ts.isStringLiteralLike(specifier)) found.push(specifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = node.moduleReference.expression;
      if (ts.isStringLiteralLike(specifier)) found.push(specifier);
    } else if (ts.isCallExpression(node) && isModuleCall(node)) {
      const first = node.arguments[0];
      if (first !== undefined && ts.isStringLiteralLike(first)) found.push(first);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `import(…)` and `require(…)`; a shadowed `require` is not worth guarding. */
function isModuleCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}

/**
 * The first module a JavaScript file names that the program cannot find, or
 * null when it can find them all.
 *
 * This is the guard `getSemanticDiagnostics` is not allowed to be for an
 * unchecked file, and it holds JavaScript to the same standard TypeScript is
 * already held to: an import that does not resolve is a 2307 and a 2307 skips
 * the file, whichever language wrote it. A bare specifier counts as much as a
 * relative one — `require('http')` in a repository with no `@types/node` is a
 * module the checker cannot see, and a `.ts` file writing the same import is
 * skipped for it today.
 */
function unresolvedModuleIn(
  source: ts.SourceFile,
  program: ts.Program,
  options: ts.CompilerOptions,
  cache: ts.ModuleResolutionCache,
): string | null {
  for (const usage of moduleSpecifiersOf(source)) {
    const mode = program.getModeForUsageLocation(source, usage);
    const resolved = ts.resolveModuleName(usage.text, source.fileName, options, ts.sys, cache, undefined, mode);
    if (resolved.resolvedModule === undefined) return usage.text;
  }
  return null;
}

/**
 * Read the reference sites of a project with the checker, in our own ids.
 *
 * `files` is the scan's file list, so both sides of the comparison are looking
 * at the same project — the checker is never asked about a file the graph
 * never saw, and never gets to answer about one it pulled in itself.
 */
export function readWithChecker(root: string, files: readonly string[]): OracleReading {
  const started = Date.now();
  /**
   * Absolute path -> project-relative, which is what a node id is spelled in.
   *
   * Keyed by the real path, not the written one. A module reached through a
   * symlink resolves to where it really is — every package in a pnpm workspace
   * is one, and on macOS so is `/tmp` — so a table built from the scan's own
   * paths matched none of the declarations the checker pointed at, and 36,475
   * of zod's resolved references read as "outside the scanned files".
   */
  const wanted = new Map<string, string>();
  for (const file of checkedFiles(files)) wanted.set(canonical(path.resolve(root, file)), file);

  const options = compilerOptions(root);
  const program = ts.createProgram({ rootNames: [...wanted.keys()], options });
  const checker = program.getTypeChecker();
  const resolution = ts.createModuleResolutionCache(root, (file) => file, options);

  const compared: string[] = [];
  const skipped: SkippedFile[] = [];
  const edges: OracleEdge[] = [];
  const seen = new Set<string>();
  const unnamable = new Map<UnnamableReason, number>();

  const blame = (reason: UnnamableReason): void => {
    unnamable.set(reason, (unnamable.get(reason) ?? 0) + 1);
  };

  const fileOf = (node: ts.Node): string | null =>
    wanted.get(canonical(path.resolve(node.getSourceFile().fileName))) ?? null;

  /**
   * Whether our parser would have collected this declaration. It reads the top
   * level of a file, the members of a class or interface it found there, and
   * the contents of a namespace — and nothing inside a function body. A
   * `function inner()` written inside another function is its caller's
   * business, never a node of its own.
   */
  const collected = (declaration: ts.Node): boolean => {
    for (let node = declaration.parent; node !== undefined; node = node.parent) {
      if (ts.isSourceFile(node)) return true;
      const passable =
        ts.isVariableDeclaration(node) ||
        ts.isVariableDeclarationList(node) ||
        ts.isVariableStatement(node) ||
        ts.isModuleDeclaration(node) ||
        ts.isModuleBlock(node) ||
        ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isExpressionStatement(node) ||
        ts.isBinaryExpression(node) ||
        ts.isPropertyAccessExpression(node);
      if (!passable) return false;
    }
    return false;
  };

  /** The class or interface a member belongs to, named as our parser names it. */
  const ownerName = (parent: ts.Node): string | null => {
    if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) return parent.name?.text ?? null;
    // `const C = class { … }` is a class declaration with the name moved to the
    // left of the equals sign, and our parser reads it as one.
    if (ts.isClassExpression(parent) && ts.isVariableDeclaration(parent.parent)) {
      const name = parent.parent.name;
      return ts.isIdentifier(name) ? name.text : null;
    }
    return null;
  };

  /** A member's name exactly as written — `#tick` keeps its hash. */
  const memberName = (member: ts.NamedDeclaration): string | null => {
    if (ts.isConstructorDeclaration(member)) return 'constructor';
    const name = member.name;
    if (name === undefined) return null;
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    if (ts.isStringLiteral(name)) return name.text;
    return null;
  };

  const isMember = (node: ts.Node): node is ts.ClassElement | ts.TypeElement =>
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node);

  /** A top-level declaration's name, or null when our model has no node for it. */
  const declaredName = (node: ts.Node): string | null => {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)
    ) {
      return node.name === undefined ? null : node.name.text;
    }
    if (ts.isModuleDeclaration(node)) {
      return ts.isIdentifier(node.name) ? node.name.text : node.name.text;
    }
    // A variable is a symbol only when what it holds is one: an arrow, a
    // function expression or a class. `const rows = load()` is a value, and a
    // value has no node — which is why the calls in it belong to the file.
    if (ts.isVariableDeclaration(node)) {
      const value = node.initializer;
      const isSymbol =
        value !== undefined &&
        (ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isClassExpression(value));
      return isSymbol && ts.isIdentifier(node.name) ? node.name.text : null;
    }
    // `app.init = function () {}` — how a CommonJS module defines its API, and
    // how express writes all 632 lines of application.js. The name is the
    // property exactly as written, which is the only name the file gives it.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const isFunction =
        ts.isArrowFunction(node.right) ||
        ts.isFunctionExpression(node.right) ||
        ts.isClassExpression(node.right);
      if (isFunction && ts.isPropertyAccessExpression(node.left)) return node.left.getText().replace(/\s+/g, '');
    }
    // A reference to one of those arrives naming the left-hand side, because
    // that is where TypeScript puts the declaration of an expando property.
    if (ts.isPropertyAccessExpression(node) && ts.isBinaryExpression(node.parent) && node.parent.left === node) {
      return declaredName(node.parent);
    }
    return null;
  };

  /** The id our graph gives a declaration, or the reason it gives it none. */
  const idOf = (declaration: ts.Node): { id: string } | { reason: UnnamableReason } => {
    const file = fileOf(declaration);
    if (file === null) return { reason: 'the declaration is outside the scanned files' };

    if (isMember(declaration)) {
      const owner = ownerName(declaration.parent);
      const name = memberName(declaration);
      if (owner !== null && name !== null && collected(declaration.parent)) {
        return { id: `${file}#${owner}.${name}` };
      }
      return { reason: 'the declaration kind has no node' };
    }

    const name = declaredName(declaration);
    if (name !== null && collected(declaration)) return { id: `${file}#${name}` };
    if (ts.isVariableDeclaration(declaration) || ts.isBindingElement(declaration)) {
      return { reason: 'the declaration is a value binding, not a declaration' };
    }
    return { reason: 'the declaration kind has no node' };
  };

  /**
   * What our graph would call the symbol a reference names.
   *
   * The alias is followed because that is what our store does through a
   * barrel: a name imported from an index file is usually declared behind it,
   * and the edge belongs on the declaration. A name that stands for a whole
   * module is resolved the same way the store resolves it — CommonJS's
   * `const View = require('./view')` and then `new View()` reaches whatever
   * view.js assigned to `module.exports`.
   */
  const targetOf = (reference: ts.Node): { id: string } | { reason: UnnamableReason } => {
    const symbol = checker.getSymbolAtLocation(reference);
    if (symbol === undefined) return { reason: 'the checker resolved nothing' };

    let resolved = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
    if (resolved.declarations?.some((declaration) => ts.isSourceFile(declaration)) === true) {
      const assigned =
        resolved.exports?.get(ts.InternalSymbolName.ExportEquals) ??
        resolved.exports?.get(ts.InternalSymbolName.Default);
      if (assigned !== undefined) {
        resolved = (assigned.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(assigned) : assigned;
      }
    }

    const declarations = resolved.declarations ?? [];
    if (declarations.length === 0) return { reason: 'the checker resolved nothing' };

    // Overloads: the first declaration our model can name wins, which is the
    // implementation whenever there is one.
    let first: { reason: UnnamableReason } | null = null;
    for (const declaration of declarations) {
      const named = idOf(declaration);
      if ('id' in named) return named;
      first ??= named;
    }
    return first ?? { reason: 'the declaration kind has no node' };
  };

  /**
   * The node our graph hangs a reference on: the innermost declaration around
   * it that our parser collected, and the file itself when there is none.
   *
   * Innermost is the whole rule, and it is our parser's too — a class does not
   * claim what its methods call, and a namespace does not claim what its own
   * declarations call, so the nearest one owns the call.
   */
  const callerOf = (site: ts.Node, file: string): string => {
    for (let node = site.parent; node !== undefined; node = node.parent) {
      if (ts.isSourceFile(node)) break;
      if (isMember(node)) {
        const owner = ownerName(node.parent);
        const name = memberName(node);
        if (owner !== null && name !== null && collected(node.parent)) return `${file}#${owner}.${name}`;
        continue;
      }
      const name = declaredName(node);
      if (name !== null && collected(node)) return `${file}#${name}`;
    }
    return file;
  };

  const record = (from: string, reference: ts.Node, kind: OracleEdgeKind): void => {
    const target = targetOf(reference);
    if ('reason' in target) {
      blame(target.reason);
      return;
    }
    // The store's two rules, mirrored so a difference is never one of them: a
    // self-edge says nothing, and a file never calls what it declares itself —
    // `contains` already says the symbol is there.
    if (from === target.id) return;
    if (from.indexOf('#') === -1 && fileOfId(target.id) === from) return;
    const key = `${from} ${kind} ${target.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to: target.id, kind });
  };

  for (const source of program.getSourceFiles()) {
    const file = wanted.get(canonical(path.resolve(source.fileName)));
    if (file === undefined) continue;

    const diagnostics = program.getSemanticDiagnostics(source);
    const first = diagnostics[0];
    if (first !== undefined) {
      skipped.push({
        file,
        code: first.code,
        message: ts.flattenDiagnosticMessageText(first.messageText, ' '),
      });
      continue;
    }
    // An empty diagnostic list on an unchecked JavaScript file says it parsed
    // and nothing more, so the module question is asked separately. Spelled as
    // TypeScript spells it, so the report groups the two languages' skips on
    // one line rather than inventing a second vocabulary for the same failure.
    const missing = isUncheckedJavaScript(file) ? unresolvedModuleIn(source, program, options, resolution) : null;
    if (missing !== null) {
      skipped.push({
        file,
        code: 2307,
        message: `Cannot find module '${missing}' or its corresponding type declarations.`,
      });
      continue;
    }
    compared.push(file);

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.SuperKeyword) blame('super(), which extends already draws');
        else record(callerOf(node, file), node.expression, 'calls');
      } else if (ts.isHeritageClause(node)) {
        // A class's `implements` is UML's realisation; everything else written
        // in a heritage clause — a class extending a class, an interface
        // extending an interface — is generalisation.
        const kind: OracleEdgeKind = node.token === ts.SyntaxKind.ImplementsKeyword ? 'implements' : 'extends';
        const owner = declaredName(node.parent);
        if (owner !== null) {
          for (const type of node.types) record(`${file}#${owner}`, type.expression, kind);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return {
    compared,
    skipped,
    edges,
    unnamable: [...unnamable].sort((a, b) => b[1] - a[1]),
    ms: Date.now() - started,
  };
}

/**
 * Set-compare our edges with the checker's, over the files it vouched for.
 *
 * Only those files: an edge out of a file the checker could not read is in
 * neither set, on either side, because counting ours while the second opinion
 * is missing would score us against silence.
 */
export function compareEdges(graph: Graph, reading: OracleReading): OracleComparison {
  const compared = new Set(reading.compared);
  /**
   * The `~2` a second symbol of the same name in one file is given is a
   * tie-break, not an identity — it moves the moment the two swap places — and
   * the checker cannot produce one at all, because TypeScript reads the three
   * `refine` overloads zod's ZodType declares as a single symbol. So the join
   * is on the name: an edge onto the third `refine` and an edge onto `refine`
   * are the same claim about the code.
   */
  const key = (edge: OracleEdge): string =>
    `${edge.from.replace(/~\d+$/, '')} ${edge.kind} ${edge.to.replace(/~\d+$/, '')}`;

  const ours = new Map<string, OracleEdge>();
  for (const edge of graph.edges) {
    if (!isReference(edge.kind)) continue;
    const from = graph.nodes.get(edge.from);
    if (from === undefined || !compared.has(from.filePath)) continue;
    const named: OracleEdge = { from: edge.from, to: edge.to, kind: edge.kind };
    ours.set(key(named), named);
  }

  const theirs = new Map(reading.edges.map((edge) => [key(edge), edge]));

  const agree: OracleEdge[] = [];
  const onlyChecker: Difference[] = [];
  for (const [id, edge] of theirs) {
    if (ours.has(id)) {
      agree.push(edge);
      continue;
    }
    const cause: DifferenceCause = !graph.nodes.has(edge.from)
      ? 'no caller node'
      : !graph.nodes.has(edge.to)
        ? 'no target node'
        : 'both nodes exist, the edge does not';
    onlyChecker.push({ edge, cause });
  }

  const onlyOurs = [...ours].filter(([id]) => !theirs.has(id)).map(([, edge]) => edge);

  return {
    agree,
    onlyChecker,
    onlyOurs,
    precision: ours.size === 0 ? 1 : agree.length / ours.size,
    recall: theirs.size === 0 ? 1 : agree.length / theirs.size,
  };
}

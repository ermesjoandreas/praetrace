import path from 'node:path';
import { languageById } from '../lang/registry.js';
import type { ProjectFacts } from '../lang/types.js';
import { QUALIFIED_SEPARATOR, type ParsedFile, type Reexport } from '../parser/types.js';
import type { Graph, GraphDelta, GraphEdge, GraphNode } from './types.js';

/**
 * Holds the graph and the per-file parse results it is derived from.
 *
 * Parsing is incremental — only a changed file is re-parsed — but nodes and
 * edges are re-derived from the stored parse results on every mutation. That is
 * deliberate: derivation is pure in-memory work with no I/O and no AST, and it
 * sidesteps a whole class of stale-cross-reference bugs (a newly added file can
 * satisfy an import that failed to resolve earlier). If it ever shows up in a
 * profile, index the dependents and narrow the recompute.
 */
export interface GraphStore {
  readonly files: Map<string, ParsedFile>;
  graph: Graph;
  /** What the scan learned about the project; see `setProjectFacts`. */
  facts: ProjectFacts;
}

/**
 * A project whose facts have not been read yet. Resolution still works — every
 * relative import resolves on paths alone — so a store is usable the moment it
 * exists, and the aliases and package names arrive when the scan has them.
 */
function noFacts(): ProjectFacts {
  return { tsPaths: new Map(), packages: new Map(), goModule: null, crates: new Map() };
}

/** The directory of a project-relative POSIX path; '' at the root. */
function dirnameOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

export function createStore(): GraphStore {
  return { files: new Map(), graph: { nodes: new Map(), edges: [] }, facts: noFacts() };
}

/**
 * Install what the scan found. Separate from the parse results because it comes
 * from files the graph never parses — tsconfig, package.json, go.mod — and
 * because it changes only when the project does, not when a file is edited.
 */
export function setProjectFacts(store: GraphStore, facts: ProjectFacts): GraphDelta {
  store.facts = facts;
  // An alias table arriving after the files changes which imports resolve, so
  // the graph is only correct once it has been derived again.
  return store.files.size === 0 ? emptyDelta() : commit(store);
}

function commit(store: GraphStore): GraphDelta {
  const before = store.graph;
  store.graph = derive(store.files, store.facts);
  return diff(before, store.graph);
}

const emptyDelta = (): GraphDelta => ({
  upsertedNodes: [],
  removedNodeIds: [],
  addedEdges: [],
  removedEdges: [],
});

/**
 * Two symbols sharing a name in one file are disambiguated by document order.
 * The id stays stable unless their relative order changes.
 */
function uniqueId(base: string, taken: ReadonlyMap<string, unknown>): string {
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}~${suffix}`)) suffix += 1;
  return `${base}~${suffix}`;
}

/**
 * How many re-exports deep a name is followed. A barrel that re-exports a
 * barrel is ordinary; eight in a row is not, and the cap is what makes the
 * export tables below finish in a bounded number of rounds whatever the files
 * say about each other.
 */
const REEXPORT_DEPTH = 8;

/** A re-export whose specifier has already been turned into a file. */
interface ResolvedReexport {
  target: string;
  names: Reexport['names'];
}

/** An import binding whose specifier has already been turned into a file. */
interface ResolvedBinding {
  target: string;
  /** The name to read out of `target`'s export table; `'*'` for the module itself. */
  imported: string;
}

/**
 * filePath -> every name a file answers for, its own exported declarations
 * first and then what it re-exports, each mapped to the node that declares it.
 *
 * This is the other half of the monorepo problem. `@tanstack/query-core`
 * resolves to its index.ts now, and index.ts declares nothing: it is thirty
 * lines of `export { QueryObserver } from './queryObserver'`. Looking the name
 * up in the barrel found nothing, so every `new QueryObserver(` in react-query
 * was an edge to nowhere and the class read as used by three files, all of
 * them its neighbours.
 *
 * Built by rounds rather than by recursion. Each round copies one hop of
 * re-exports into the tables, reading only what the previous round left, so a
 * chain of barrels resolves in as many rounds as it is long — and a cycle, two
 * files that `export *` each other, is just a round that adds nothing. A name
 * a file declares itself is never overwritten, which is the language's rule
 * too: a local declaration shadows a star export of the same name.
 */
function exportTables(
  symbolsByFile: ReadonlyMap<string, ReadonlyMap<string, string>>,
  reexportsByFile: ReadonlyMap<string, readonly ResolvedReexport[]>,
): Map<string, Map<string, string>> {
  const tables = new Map<string, Map<string, string>>();
  for (const [file, byName] of symbolsByFile) tables.set(file, new Map(byName));

  for (let hop = 0; hop < REEXPORT_DEPTH; hop += 1) {
    // Collected first and applied after, so a round sees the tables as the
    // previous round left them and the answer does not depend on which file
    // happened to be visited first.
    const additions: { table: Map<string, string>; name: string; id: string }[] = [];

    for (const [file, reexports] of reexportsByFile) {
      const table = tables.get(file);
      if (!table) continue;
      for (const { target, names } of reexports) {
        const source = tables.get(target);
        if (!source) continue;
        if (names === '*') {
          // `export *` hands on every name but `default`: that is the
          // language's rule, and a default reached through a star would be an
          // edge to something the importer gets as undefined.
          for (const [name, id] of source) {
            if (name !== 'default' && !table.has(name)) additions.push({ table, name, id });
          }
          continue;
        }
        for (const { exported, local } of names) {
          // `export * as ns` stands for a module, not a symbol, and there is
          // no node for a module to land on.
          if (local === '*') continue;
          const id = source.get(local);
          if (id !== undefined && !table.has(exported)) additions.push({ table, name: exported, id });
        }
      }
    }

    let grew = false;
    for (const { table, name, id } of additions) {
      if (table.has(name)) continue;
      table.set(name, id);
      grew = true;
    }
    if (!grew) break;
  }

  return tables;
}

function derive(files: ReadonlyMap<string, ParsedFile>, facts: ProjectFacts): Graph {
  const nodes = new Map<string, GraphNode>();
  const knownFiles = new Set(files.keys());
  /**
   * file -> the package or module it declares itself to be in. Built once for
   * the whole project because that is how the languages that resolve by name
   * ask the question: a Java import names a package, not a path, and the answer
   * is every file that declared it.
   */
  const modules = new Map<string, string>();
  /**
   * file -> the references it made, for a language whose answer to one of them
   * depends on what a *different* file wrote. A C# `global using` is the case:
   * it sits in its own file and decides which namespaces every other file in
   * the compilation can name.
   */
  const references = new Map<string, readonly string[]>();
  for (const parsed of files.values()) {
    if (parsed.moduleName !== undefined) modules.set(parsed.filePath, parsed.moduleName);
    references.set(parsed.filePath, parsed.imports);
  }
  /**
   * file -> the top-level names it declares, for a reference that names no path.
   * Filled in pass 1 from the same table the name lookup uses, so the two cannot
   * disagree about what a file declares.
   */
  const declarations = new Map<string, ReadonlySet<string>>();
  /** filePath -> symbol name -> node id, for resolving references by name. */
  const symbolsByFile = new Map<string, Map<string, string>>();
  /**
   * filePath -> the names other files may reach in it. The same as
   * `symbolsByFile` unless the parser said which declarations were exported,
   * in which case only those: a barrel's `export *` hands on what the file
   * exported, not what it wrote, and a `secret()` that never left its file
   * was reached through the barrel by every importer of it.
   */
  const exportedByFile = new Map<string, Map<string, string>>();
  /** filePath -> node id per symbol, positionally aligned with ParsedFile.symbols. */
  const idsByFile = new Map<string, string[]>();
  /** filePath -> class name -> node id, so a member can be contained by its class. */
  const ownersByFile = new Map<string, Map<string, string>>();
  /**
   * filePath -> owner name -> member name -> node id. The one door into the
   * member namespace, and it opens only for a reference that names the owner
   * too; see `lookupCall` below.
   */
  const membersByFile = new Map<string, Map<string, Map<string, string>>>();

  // Pass 1: every node must exist before edges are resolved, or a reference to a
  // file that happens to be visited later would be dropped.
  for (const parsed of files.values()) {
    nodes.set(parsed.filePath, {
      id: parsed.filePath,
      kind: 'file',
      name: path.posix.basename(parsed.filePath),
      filePath: parsed.filePath,
      range: { startLine: 1, endLine: parsed.lineCount },
      modifiedAt: parsed.modifiedAt,
      ...(parsed.hasError === true ? { parseError: true as const } : {}),
    });

    const byName = new Map<string, string>();
    const exported = new Map<string, string>();
    // A parser that says which declarations were exported says it about every
    // one, so one flagged symbol means the file's export table is to be
    // trusted; none means the parser has not opted in and everything is
    // visible, as it always was.
    const flagged = parsed.symbols.some((symbol) => symbol.exported !== undefined);
    const ids: string[] = [];
    /** Class name -> its node id, so the members that follow can attach to it. */
    const owners = new Map<string, string>();
    const members = new Map<string, Map<string, string>>();

    for (const symbol of parsed.symbols) {
      const base =
        symbol.owner === undefined
          ? `${parsed.filePath}#${symbol.name}`
          : `${parsed.filePath}#${symbol.owner}.${symbol.name}`;
      const id = uniqueId(base, nodes);
      nodes.set(id, {
        id,
        kind: symbol.kind,
        name: symbol.name,
        filePath: parsed.filePath,
        range: { startLine: symbol.startLine, endLine: symbol.endLine },
        ...(symbol.owner === undefined ? {} : { owner: symbol.owner }),
        ...(symbol.visibility === undefined ? {} : { visibility: symbol.visibility }),
        ...(symbol.isStatic === undefined ? {} : { isStatic: symbol.isStatic }),
        ...(symbol.isAbstract === undefined ? {} : { isAbstract: symbol.isAbstract }),
        ...(symbol.many === undefined ? {} : { many: symbol.many }),
      });
      ids.push(id);
      if (symbol.kind === 'class') owners.set(symbol.name, id);
      // Methods stay out of the name table on purpose. A bare name is resolved
      // against it, and `x.map(...)` arrives here as just `map` — so admitting
      // members would invent a call edge to every class that happens to declare
      // one. A missing edge is a gap; a wrong one is a lie.
      if (symbol.owner === undefined) {
        if (!byName.has(symbol.name)) byName.set(symbol.name, id);
        if ((!flagged || symbol.exported === true) && !exported.has(symbol.name)) exported.set(symbol.name, id);
      } else {
        const owned = members.get(symbol.owner) ?? new Map<string, string>();
        if (!owned.has(symbol.name)) owned.set(symbol.name, id);
        members.set(symbol.owner, owned);
      }
    }

    // The default export goes in under the name an importer asks for it by.
    // `default` is a reserved word, so no declaration can be in its way.
    if (parsed.defaultExport !== undefined) {
      const id = byName.get(parsed.defaultExport);
      if (id !== undefined) exported.set('default', id);
    }

    ownersByFile.set(parsed.filePath, owners);
    membersByFile.set(parsed.filePath, members);

    symbolsByFile.set(parsed.filePath, byName);
    exportedByFile.set(parsed.filePath, exported);
    declarations.set(parsed.filePath, new Set(byName.keys()));
    idsByFile.set(parsed.filePath, ids);
  }

  // Whoever parsed the file resolves its references. A specifier means what
  // its own language says it means, and there is no shared fallback: a rule
  // that half applies would invent edges between files that never met.
  const resolveFrom = (parsed: ParsedFile, specifier: string): string | null =>
    languageById(parsed.language)?.resolve({
      from: parsed.filePath,
      specifier,
      files: knownFiles,
      modules,
      declarations,
      imports: references,
      facts,
    }) ?? null;

  /** filePath -> what it re-exports, with each specifier already a file. */
  const reexportsByFile = new Map<string, ResolvedReexport[]>();
  for (const parsed of files.values()) {
    const resolved: ResolvedReexport[] = [];
    for (const { specifier, names } of parsed.reexports ?? []) {
      const target = resolveFrom(parsed, specifier);
      if (target) resolved.push({ target, names });
    }
    if (resolved.length > 0) reexportsByFile.set(parsed.filePath, resolved);
  }
  const exportsByFile = exportTables(exportedByFile, reexportsByFile);

  /**
   * filePath -> local name -> what the file bound it to, for a file whose
   * parser recorded its bindings. A binding whose specifier names nothing in
   * the project is left out, and so binds nothing — which is the point: `map`
   * from lodash must not fall through to the `map` a barrel exports.
   */
  const bindingsByFile = new Map<string, Map<string, ResolvedBinding>>();
  for (const parsed of files.values()) {
    if (parsed.bindings === undefined) continue;
    const bound = new Map<string, ResolvedBinding>();
    for (const { local, specifier, imported } of parsed.bindings) {
      const target = resolveFrom(parsed, specifier);
      if (target && !bound.has(local)) bound.set(local, { target, imported });
    }
    bindingsByFile.set(parsed.filePath, bound);
  }

  // Pass 2: edges.
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  function addEdge(from: string, to: string, kind: GraphEdge['kind']): void {
    // Self-edges (recursion, a file importing itself) carry no structural
    // information and only clutter the diagram.
    if (from === to) return;
    const key = `${from} ${kind} ${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  }

  for (const parsed of files.values()) {
    const importedFiles: string[] = [];
    /** Specifier as written -> the file it resolved to, for Go's qualified references. */
    const importTarget = new Map<string, string>();
    for (const specifier of parsed.imports) {
      const target = resolveFrom(parsed, specifier);
      if (target) {
        importedFiles.push(target);
        importTarget.set(specifier, target);
        addEdge(parsed.filePath, target, 'imports');
      }
    }
    // A barrel depends on what it re-exports whether or not the parser also
    // listed the specifier as an import. Not added to `importedFiles`: a
    // re-export binds nothing in the file that wrote it.
    for (const { target } of reexportsByFile.get(parsed.filePath) ?? []) {
      addEdge(parsed.filePath, target, 'imports');
    }

    /**
     * `name` in the module a namespace import `ns` stands for — `ns.helper`
     * through `import * as ns` — or null when `ns` is not one. The head is
     * resolved through the binding and the tail through the module's export
     * table, never as a bare tail: `z.number()` reaches zod's `number` because
     * `z` was bound to it, and reaches nothing when it was not.
     */
    const throughNamespace = (ns: string, name: string): string | null => {
      const binding = bindingsByFile.get(parsed.filePath)?.get(ns);
      if (binding === undefined || binding.imported !== '*') return null;
      return exportsByFile.get(binding.target)?.get(name) ?? null;
    };

    /**
     * Whether a name is Go's qualified form, `<importPath>#Name` or
     * `<importPath>#T.m`. An ES private member carries the same character,
     * `Observer.#tick`, and is told apart by the dot in front of it: an import
     * path never ends in one.
     */
    const isThroughImport = (name: string): boolean => {
      const hash = name.indexOf(QUALIFIED_SEPARATOR);
      return hash > 0 && name[hash - 1] !== '.';
    };

    /**
     * `<importPath>#Name`: the head is verbatim one of this file's imports,
     * already resolved above to the file that declares Name, so the name is
     * found there and never by bare name — `viper.New()` must not land on a
     * local `New`, and an embedded `base.Server` must not land on whichever
     * file in reach happens to declare a `Server`.
     */
    const throughImport = (name: string): string | null => {
      const target = importTarget.get(name);
      if (target === undefined) return null;
      return symbolsByFile.get(target)?.get(name.slice(name.indexOf(QUALIFIED_SEPARATOR) + 1)) ?? null;
    };

    /**
     * A top-level name as this file may write it. Own file wins.
     *
     * After that a file whose parser recorded its bindings reaches only what
     * it bound, each name read out of its module's export table under the
     * name it was imported as — so a barrel is still followed to the file that
     * declares the name, but nothing is reached that no import said. The old
     * rule, every imported file's whole table, meant that once a barrel
     * exposed a hundred names any bare property call in any importer could
     * land on one of them: zod drew `compiledRows.map(...)` as a call into its
     * own `map()` factory eight times, and `process.hrtime.bigint()` as one
     * into `bigint()` from seven bench files.
     *
     * Go and Java bind one name per reference — a same-package sibling, a
     * single-type import — because that is what their resolvers already
     * answer: the specifier names the one file that declares the name, so a
     * binding under that name is exact where a whole table is not. Before
     * they did, Go listed `path#Name` references ahead of its `package:`
     * siblings and Java its single-type imports ahead of the same-package
     * candidates, so a name declared in the current package was drawn on an
     * unrelated import that happened to declare one too — including Go names
     * the import does not even export.
     *
     * C# and Rust record no bindings and keep the old rule, every imported
     * file's whole table, until their languages opt in.
     */
    const lookup = (name: string): string | null => {
      if (isThroughImport(name)) return throughImport(name);
      const dot = name.indexOf('.');
      if (dot !== -1) {
        const viaModule = throughNamespace(name.slice(0, dot), name.slice(dot + 1));
        if (viaModule !== null) return viaModule;
      }
      const own = symbolsByFile.get(parsed.filePath)?.get(name);
      if (own) return own;
      const bound = bindingsByFile.get(parsed.filePath);
      if (bound !== undefined) {
        const binding = bound.get(name);
        if (binding === undefined) return null;
        // A name standing for a whole module, used bare, is CommonJS calling
        // what the module is: `const View = require('./view')` and then
        // `new View(...)` reaches whatever view.js set `module.exports` to.
        // There is no node for the module itself, so one without a default
        // answers nothing.
        const imported = binding.imported === '*' ? 'default' : binding.imported;
        return exportsByFile.get(binding.target)?.get(imported) ?? null;
      }
      for (const imported of importedFiles) {
        const hit = exportsByFile.get(imported)?.get(name);
        if (hit) return hit;
      }
      return null;
    };

    /**
     * The member `m` of the class or interface `ownerId`, or null. A Go method
     * is declared wherever in the package it is written — cobra's
     * Command.GenBashCompletion lives in bash_completions.go while `type Command`
     * is in command.go — so for a Go owner its own file is tried first and then
     * the other files of the same package: same directory, same declared
     * module. Only for Go. Java and C# declare a module name too, and there a
     * nested class sharing its simple name with one in the next file over is
     * ordinary — Foo.Builder and Bar.Builder in one package — so the same
     * search drew Foo.run's `b.build()` on Bar's Builder.
     */
    const memberOf = (ownerId: string, member: string): string | null => {
      const owner = nodes.get(ownerId);
      if (!owner || (owner.kind !== 'class' && owner.kind !== 'interface')) return null;
      const own = membersByFile.get(owner.filePath)?.get(owner.name)?.get(member);
      if (own) return own;
      if (files.get(owner.filePath)?.language !== 'go') return null;
      const pkg = modules.get(owner.filePath);
      if (pkg === undefined) return null;
      const dir = dirnameOf(owner.filePath);
      for (const [file, members] of membersByFile) {
        if (file === owner.filePath || modules.get(file) !== pkg || dirnameOf(file) !== dir) continue;
        const hit = members.get(owner.name)?.get(member);
        if (hit) return hit;
      }
      return null;
    };

    /**
     * A call is the one reference allowed to name a member, and only as `T.m`:
     * the parser writes that when the receiver's type was written down, `this`
     * inside `T` or a parameter declared `x: T`, and never guesses one. The
     * owner is resolved like any other name, must turn out to be a class or an
     * interface, and must declare `m` itself. A bare `m` still never gets in.
     */
    const lookupCall = (name: string): string | null => {
      // Go's fourth form, `<importPath>#Name` or `<importPath>#T.m`: the owner
      // through the import, the member on it. The first dot after the hash is
      // the split; the path before it may hold dots of its own.
      if (isThroughImport(name)) {
        const dot = name.indexOf('.', name.indexOf(QUALIFIED_SEPARATOR));
        if (dot === -1) return throughImport(name);
        const ownerId = throughImport(name.slice(0, dot));
        return ownerId === null ? null : memberOf(ownerId, name.slice(dot + 1));
      }
      const dot = name.indexOf('.');
      if (dot === -1) return lookup(name);
      // A module first: `ns.helper` is a top-level name reached through a
      // namespace import, and a namespace is never a class.
      const viaModule = throughNamespace(name.slice(0, dot), name.slice(dot + 1));
      if (viaModule !== null) return viaModule;
      // Otherwise the last dot parts owner from member, and the owner is
      // looked up as any name is: `Thing.run` is a member of Thing, and
      // `ns.Thing.run` a member of the Thing a namespace import stands for —
      // which `lookup` reaches through the binding, so `new ns.Thing()` and
      // the `run()` on it land in the same file rather than on whichever
      // Thing the file also bound bare.
      const last = name.lastIndexOf('.');
      const ownerId = lookup(name.slice(0, last));
      return ownerId === null ? null : memberOf(ownerId, name.slice(last + 1));
    };

    const ids = idsByFile.get(parsed.filePath) ?? [];
    parsed.symbols.forEach((symbol, index) => {
      const id = ids[index];
      if (!id) return;

      const owner = symbol.owner === undefined ? null : ownersByFile.get(parsed.filePath)?.get(symbol.owner);
      addEdge(owner ?? parsed.filePath, id, 'contains');

      for (const name of symbol.extends) {
        const target = lookup(name);
        if (target) addEdge(id, target, 'extends');
      }
      for (const name of symbol.implements) {
        const target = lookup(name);
        if (target) addEdge(id, target, 'implements');
      }
      for (const name of symbol.calls) {
        const target = lookupCall(name);
        if (target) addEdge(id, target, 'calls');
      }
      // UML draws an association between the two classifiers, not from the
      // attribute that holds it: the field is how the relationship is spelled,
      // the class is what has it.
      if (symbol.typeName !== undefined && owner) {
        const target = lookup(symbol.typeName);
        if (target) addEdge(owner, target, 'associates');
      }
    });

    // A call written outside every function, class and method is the file's
    // own: there is no symbol to hang it on, so until now the graph had no
    // caller for it at all, and that is where most of what it misses was —
    // 61% of express's absent call edges, 54% of zod's and 73% of
    // TanStack/query's, plus 1439 more in zod written as a top-level `const`
    // bound to something that is not a function. Resolved through the same
    // `lookupCall` a symbol's calls are, because a name means what it means
    // wherever it is written. What the edge claims is in GraphEdge.from.
    for (const name of parsed.calls ?? []) {
      const target = lookupCall(name);
      // A file never calls what it declares itself: `contains` already says
      // the symbol is here, and an edge from a box to a row inside it draws a
      // loop that says nothing. A file node's id is its path, so the same test
      // covers the file reaching itself.
      if (target !== null && nodes.get(target)?.filePath !== parsed.filePath) {
        addEdge(parsed.filePath, target, 'calls');
      }
    }
  }

  return { nodes, edges };
}

function sameNode(a: GraphNode, b: GraphNode): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.range.startLine === b.range.startLine &&
    a.range.endLine === b.range.endLine &&
    a.parseError === b.parseError
  );
}

const edgeKey = (edge: GraphEdge): string => `${edge.from} ${edge.kind} ${edge.to}`;

function diff(before: Graph, after: Graph): GraphDelta {
  const upsertedNodes: GraphNode[] = [];
  for (const [id, node] of after.nodes) {
    const previous = before.nodes.get(id);
    if (!previous || !sameNode(previous, node)) upsertedNodes.push(node);
  }

  const removedNodeIds: string[] = [];
  for (const id of before.nodes.keys()) {
    if (!after.nodes.has(id)) removedNodeIds.push(id);
  }

  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));

  return {
    upsertedNodes,
    removedNodeIds,
    addedEdges: after.edges.filter((edge) => !beforeEdges.has(edgeKey(edge))),
    removedEdges: before.edges.filter((edge) => !afterEdges.has(edgeKey(edge))),
  };
}


/**
 * Apply one batch of file changes and derive once.
 *
 * A batch rather than a call per file because a re-derivation is whole-graph
 * work: an agent touching five files should cost one, not five. Used for the
 * boot scan too, which is just a batch of every file.
 */
export function applyBatch(
  store: GraphStore,
  updated: readonly ParsedFile[],
  removed: readonly string[],
): GraphDelta {
  let touched = false;

  for (const file of updated) {
    store.files.set(file.filePath, file);
    touched = true;
  }
  for (const filePath of removed) {
    if (store.files.delete(filePath)) touched = true;
  }

  if (!touched) return emptyDelta();
  return commit(store);
}

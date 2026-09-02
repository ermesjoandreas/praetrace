import path from 'node:path';
import { languageById } from '../lang/registry.js';
import type { ProjectFacts } from '../lang/types.js';
import type { ParsedFile } from '../parser/types.js';
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
  /** filePath -> node id per symbol, positionally aligned with ParsedFile.symbols. */
  const idsByFile = new Map<string, string[]>();
  /** filePath -> class name -> node id, so a member can be contained by its class. */
  const ownersByFile = new Map<string, Map<string, string>>();

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
    });

    const byName = new Map<string, string>();
    const ids: string[] = [];
    /** Class name -> its node id, so the members that follow can attach to it. */
    const owners = new Map<string, string>();

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
      if (symbol.owner === undefined && !byName.has(symbol.name)) byName.set(symbol.name, id);
    }

    ownersByFile.set(parsed.filePath, owners);

    symbolsByFile.set(parsed.filePath, byName);
    declarations.set(parsed.filePath, new Set(byName.keys()));
    idsByFile.set(parsed.filePath, ids);
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
    // Whoever parsed the file resolves its references. A specifier means what
    // its own language says it means, and there is no shared fallback: a rule
    // that half applies would invent edges between files that never met.
    const language = languageById(parsed.language);

    const importedFiles: string[] = [];
    for (const specifier of parsed.imports) {
      const target = language?.resolve({
        from: parsed.filePath,
        specifier,
        files: knownFiles,
        modules,
        declarations,
        imports: references,
        facts,
      });
      if (target) {
        importedFiles.push(target);
        addEdge(parsed.filePath, target, 'imports');
      }
    }

    /** Own file wins, then whatever it imports. Unresolvable names are dropped. */
    const lookup = (name: string): string | null => {
      const own = symbolsByFile.get(parsed.filePath)?.get(name);
      if (own) return own;
      for (const imported of importedFiles) {
        const hit = symbolsByFile.get(imported)?.get(name);
        if (hit) return hit;
      }
      return null;
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
        const target = lookup(name);
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
  }

  return { nodes, edges };
}

function sameNode(a: GraphNode, b: GraphNode): boolean {
  return (
    a.kind === b.kind &&
    a.name === b.name &&
    a.range.startLine === b.range.startLine &&
    a.range.endLine === b.range.endLine
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

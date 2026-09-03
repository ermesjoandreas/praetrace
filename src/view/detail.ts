import path from 'node:path';
import type { Graph, NodeKind } from '../graph/types.js';

/**
 * Everything about one box that the diagram cannot show.
 *
 * `importedBy` is the point of this module. The graph has always known which
 * files depend on a given one — the edges run both ways — but nothing has ever
 * asked, so the page could show what a file uses and never what uses it.
 */
export interface SymbolDetail {
  name: string;
  kind: NodeKind;
  line: number;
  endLine: number;
}

export interface FileDetail {
  kind: 'file';
  path: string;
  lineCount: number;
  symbols: SymbolDetail[];
  imports: string[];
  importedBy: string[];
}

export interface FolderDetail {
  kind: 'folder';
  path: string;
  files: string[];
  /** Files outside this directory that it imports, and that import it. */
  imports: string[];
  importedBy: string[];
}

export type Detail = FileDetail | FolderDetail;

export function describe(graph: Graph, target: string): Detail | null {
  const file = graph.nodes.get(target);
  if (file?.kind === 'file') return describeFile(graph, target);

  const prefix = `${target}/`;
  const files = [...graph.nodes.values()]
    .filter((node) => node.kind === 'file' && node.filePath.startsWith(prefix))
    .map((node) => node.filePath)
    .sort();

  return files.length > 0 ? describeFolder(graph, target, files) : null;
}

function describeFile(graph: Graph, target: string): FileDetail {
  const symbols: SymbolDetail[] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file' || node.filePath !== target) continue;
    symbols.push({
      name: node.name,
      kind: node.kind,
      line: node.range.startLine,
      endLine: node.range.endLine,
    });
  }

  return {
    kind: 'file',
    path: target,
    lineCount: graph.nodes.get(target)?.range.endLine ?? 0,
    symbols,
    imports: importsOf(graph, (from) => from === target).sort(),
    importedBy: importedByOf(graph, (to) => to === target).sort(),
  };
}

function describeFolder(graph: Graph, target: string, files: string[]): FolderDetail {
  const inside = new Set(files);
  const prefix = `${target}/`;

  // Only what crosses the directory boundary; a file importing its neighbour
  // says nothing about the directory as a unit.
  const imports = new Set(
    importsOf(graph, (from) => inside.has(from)).filter((to) => !to.startsWith(prefix)),
  );
  const importedBy = new Set(
    importedByOf(graph, (to) => inside.has(to)).filter((from) => !from.startsWith(prefix)),
  );

  return {
    kind: 'folder',
    path: target === '' ? '.' : target,
    files,
    imports: [...imports].sort(),
    importedBy: [...importedBy].sort(),
  };
}

function importsOf(graph: Graph, matches: (from: string) => boolean): string[] {
  return graph.edges.filter((edge) => edge.kind === 'imports' && matches(edge.from)).map((e) => e.to);
}

function importedByOf(graph: Graph, matches: (to: string) => boolean): string[] {
  return graph.edges.filter((edge) => edge.kind === 'imports' && matches(edge.to)).map((e) => e.from);
}

/** Directory a path belongs to, for grouping a change feed. */
export function directoryOf(filePath: string): string {
  return path.posix.dirname(filePath);
}

/**
 * What one symbol reaches, and what reaches it.
 *
 * The graph has always held these edges — `calls`, `extends`, `implements` and
 * `associates` all run between symbols — but every drawing collapses them onto
 * the files that hold them, so the page could say two files are coupled and
 * never which two symbols made them so. This is the same question `describe`
 * answers for a file, asked one level down.
 *
 * `contains` and `imports` are left out on purpose: they are structural, and a
 * symbol is related to its file in a way that says nothing about the code.
 */
export interface SymbolRelation {
  /** The other symbol's id, so the page can light the exact row. */
  id: string;
  name: string;
  kind: NodeKind;
  filePath: string;
  line: number;
  /** Which relationship, so a call can read differently from an inheritance. */
  edge: 'calls' | 'extends' | 'implements' | 'associates';
}

export interface SymbolLinks {
  id: string;
  name: string;
  kind: NodeKind;
  filePath: string;
  /** What this symbol reaches out to. */
  uses: SymbolRelation[];
  /** What reaches it. This is the half nothing else in the app can answer. */
  usedBy: SymbolRelation[];
  /**
   * Whether an empty `usedBy` means none, or means the graph cannot tell.
   *
   * A top-level function or class is resolved by name wherever its file is
   * imported, so what the graph found is close to what there was to find —
   * close, because a function handed over as a value, `[1].map(passed)`, is
   * never a call the parser sees. Everything else is partial, each for its
   * own reason. A member is reached through a receiver, and a receiver whose
   * type is not written down is not guessed at — a missing edge is a gap, a
   * wrong one is a lie — so for a method or a field the list holds the typed
   * calls only, and nothing in it can say how many untyped ones there were.
   * cobra's `Command.Execute` answered "0 in" while grep found sixteen
   * callers; the count was not wrong so much as unqualified. A function
   * assigned to a property, express's `app.handle`, is called through the
   * object it hangs off, which the parser does not follow — application.js
   * calls `compileETag(val)` at line 365 and utils.js's `exports.compileETag`
   * answered "0 in, full". And an interface or a type is mostly used in type
   * positions, which are not edges at all.
   */
  coverage: 'full' | 'partial';
  /** The sentence the panel shows beside the count, in the graph's own words. */
  coverageNote: string;
}

const RELATED: ReadonlySet<string> = new Set(['calls', 'extends', 'implements', 'associates']);

type Coverage = Pick<SymbolLinks, 'coverage' | 'coverageNote'>;

const UNTYPED_RECEIVER: Coverage = {
  coverage: 'partial',
  coverageNote:
    'Calls through a receiver whose type is not written down are not tracked, so an empty list means unknown, not none.',
};

const ASSIGNED_PROPERTY: Coverage = {
  coverage: 'partial',
  coverageNote:
    'Called through the object it is assigned to, which is not tracked, so an empty list means unknown, not none.',
};

const TYPE_POSITION: Coverage = {
  coverage: 'partial',
  coverageNote: 'Uses in type positions are not tracked, so an empty list means unknown, not none.',
};

const BY_NAME: Coverage = {
  coverage: 'full',
  coverageNote:
    'References by name are followed across every file that imports this one; a function passed by value is not tracked.',
};

function coverageOf(name: string, kind: NodeKind): Coverage {
  if (kind === 'method' || kind === 'field') return UNTYPED_RECEIVER;
  if (kind === 'interface' || kind === 'type') return TYPE_POSITION;
  // A top-level function or class whose name has a dot in it was assigned to
  // a property: `app.init = function init` in express.
  if (name.includes('.')) return ASSIGNED_PROPERTY;
  return BY_NAME;
}

export function describeSymbol(graph: Graph, id: string): SymbolLinks | null {
  const symbol = graph.nodes.get(id);
  if (!symbol || symbol.kind === 'file') return null;

  const relate = (otherId: string, edge: string): SymbolRelation | null => {
    const other = graph.nodes.get(otherId);
    if (!other || other.kind === 'file') return null;
    return {
      id: other.id,
      name: other.name,
      kind: other.kind,
      filePath: other.filePath,
      line: other.range.startLine,
      edge: edge as SymbolRelation['edge'],
    };
  };

  const uses: SymbolRelation[] = [];
  const usedBy: SymbolRelation[] = [];

  for (const edge of graph.edges) {
    if (!RELATED.has(edge.kind)) continue;
    if (edge.from === id) {
      const found = relate(edge.to, edge.kind);
      if (found) uses.push(found);
    } else if (edge.to === id) {
      const found = relate(edge.from, edge.kind);
      if (found) usedBy.push(found);
    }
  }

  const order = (a: SymbolRelation, b: SymbolRelation): number =>
    a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name);

  return {
    id,
    name: symbol.name,
    kind: symbol.kind,
    filePath: symbol.filePath,
    uses: uses.sort(order),
    usedBy: usedBy.sort(order),
    ...coverageOf(symbol.name, symbol.kind),
  };
}

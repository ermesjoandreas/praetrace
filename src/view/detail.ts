import path from 'node:path';
import { REACHES, type ReachingEdgeKind } from '../graph/edges.js';
import type { Graph, NodeKind } from '../graph/types.js';
import type { Tracking } from './types.js';

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
  /**
   * The sibling this is another name for, when one body was bound to several.
   * Present so the panel can count bodies rather than names — see
   * `GraphNode.aliasOf` — and so a row can say which body it names instead of
   * looking like a second function at the same line.
   */
  aliasOf?: string;
}

export interface FileDetail {
  kind: 'file';
  path: string;
  lineCount: number;
  symbols: SymbolDetail[];
  imports: string[];
  importedBy: string[];
  /**
   * Whether `importedBy` is every file that leans on this one, or the floor it
   * usually is. See `Tracking`, and `passThroughs` for what makes it partial.
   */
  importedByCoverage: Tracking;
  /**
   * The sentence to print beside the count, in the graph's own words.
   *
   * Beside the count and not only when it is partial: "used by (5)" reads as a
   * census in either state, and the reader who is about to change a signature
   * is the one who cannot afford to read it that way.
   */
  importedByNote: string;
  /**
   * Files this one calls into from a statement that belongs to no symbol.
   *
   * A file is the source of a `calls` edge when the call was written outside
   * every function, class and method — see `GraphEdge.from`. Kept beside
   * `imports` rather than folded into it because the two make different
   * claims: an import says this file mentions that one, a call says it runs
   * something in it, and a reader who could not tell them apart would read the
   * stronger claim off the weaker evidence. The overlap is expected — a file
   * nearly always imports what it calls — and listing a path twice under two
   * honest headings is better than picking one and losing the other.
   */
  calls: string[];
  /** Whether `calls` is every call, or the floor it is. See `CALLS`. */
  callsCoverage: Tracking;
  /** The sentence to print beside the list, and beside its order. */
  callsNote: string;
}

export interface FolderDetail {
  kind: 'folder';
  path: string;
  files: string[];
  /** Files outside this directory that it imports, and that import it. */
  imports: string[];
  importedBy: string[];
  /** The same qualification a file's count carries, over the pile. */
  importedByCoverage: Tracking;
  importedByNote: string;
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
      ...(node.aliasOf === undefined ? {} : { aliasOf: node.aliasOf }),
    });
  }

  return {
    kind: 'file',
    path: target,
    lineCount: graph.nodes.get(target)?.range.endLine ?? 0,
    symbols,
    imports: importsOf(graph, (from) => from === target).sort(),
    importedBy: importedByOf(graph, (to) => to === target).sort(),
    calls: callsOf(graph, target),
    callsCoverage: CALLS.coverage,
    callsNote: CALLS.note,
    ...vouchFor(passThroughs(graph, (file) => file === target)),
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
    // A pass-through inside the directory hands a file to its neighbour and
    // says nothing about the directory as a unit, exactly as an import inside
    // it does — `holds` is what leaves those out.
    ...vouchFor(passThroughs(graph, (file) => inside.has(file))),
  };
}

function importsOf(graph: Graph, matches: (from: string) => boolean): string[] {
  return graph.edges.filter((edge) => edge.kind === 'imports' && matches(edge.from)).map((e) => e.to);
}

function importedByOf(graph: Graph, matches: (to: string) => boolean): string[] {
  return graph.edges.filter((edge) => edge.kind === 'imports' && matches(edge.to)).map((e) => e.from);
}

/** One file standing between what it imported and its own importers. */
interface PassThrough {
  filePath: string;
  /** How many files import it — how many dependents it stands in front of. */
  importers: number;
}

/**
 * Files that import one the caller cares about, declare nothing the graph could
 * read, and are imported in turn.
 *
 * A file with no symbols is not where a dependency stops. Whatever it took in,
 * its own importers get — a barrel's `export * from './queryObserver'`,
 * express's `module.exports = require('./lib/express')` — and the graph has an
 * edge for each hop and none for the pair. So a count of importers taken one
 * hop out is a floor wherever one of these stands in between, and it is not a
 * small distance: 258 files import TanStack/query's query-core barrel, 5
 * import the file it hands on.
 *
 * "Declares nothing the graph could read" is the claim, and not "re-exports".
 * The parser knows a real `export *` and the Graph does not carry it, so
 * calling this a re-export would be inventing the stronger fact from the weaker
 * evidence — which is the failure this whole file is about. It is also why a
 * file whose parse hit a syntax error is counted here rather than excused: we
 * cannot read what it declares, so we cannot rule out that it hands this on,
 * and the cautious answer is the one that says the count is a floor.
 * TanStack/query's react-query barrel is exactly that file — 138 importers,
 * `export type *` that tree-sitter stumbles on — and excusing it hid them all.
 *
 * The one shape left out is a file nobody imports: it hands what it took in to
 * nobody, so nothing is standing behind it.
 */
function passThroughs(graph: Graph, holds: (filePath: string) => boolean): PassThrough[] {
  // A file that declares nothing of its own is the plain barrel. One that
  // declares a version constant beside its `export *` hands the name on just
  // the same, and the earlier rule — "declares nothing" — called that file
  // tracked while five importers reached the target through it. What makes a
  // pass-through is having many importers of its own while importing the
  // target, not being empty.
  const declares = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file') declares.add(node.filePath);
  }

  const importers = new Map<string, number>();
  const found = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    importers.set(edge.to, (importers.get(edge.to) ?? 0) + 1);
    // `!holds(edge.from)` is what keeps a file from handing on itself, and a
    // directory's own members from qualifying it.
    if (holds(edge.to) && !holds(edge.from)) found.add(edge.from);
  }

  return [...found]
    // A file with importers of its own is standing in front of the target for
    // them. One nobody imports is an ordinary consumer, whatever it declares.
    .filter((file) => (importers.get(file) ?? 0) > 0)
    .map((filePath) => ({ filePath, importers: importers.get(filePath) ?? 0 }))
    // Widest first. Only one is named, and the one worth naming is the one
    // standing in front of the most: query-core's barrel with its 258
    // importers, not whichever path sorts first.
    .sort((a, b) => b.importers - a.importers || a.filePath.localeCompare(b.filePath));
}

/** The pair a count of dependents carries: how the graph looked, and what it missed. */
function vouchFor(handedOn: PassThrough[]): Pick<FileDetail, 'importedByCoverage' | 'importedByNote'> {
  const where = handedOnBy(handedOn);
  return where === null
    ? {
        importedByCoverage: 'tracked',
        importedByNote:
          'Every import the scan resolved to this is listed, and no file passes it on to importers of its own; a specifier the scan could not place is counted on the file that wrote it, so the count is a floor.',
      }
    : { importedByCoverage: 'partial', importedByNote: `${where} The count is a floor.` };
}

/**
 * The widest pass-through named, the rest counted, and the number of files it
 * stands in front of — or null when nothing hands this on.
 *
 * A line in a panel, not a list: query-core's barrel is the one worth reading
 * and the twenty behind it are noise at the width the note is shown at. The
 * importer count is what turns the caveat into a scale — "5 listed, and 258
 * files sit behind one barrel" is a different sentence from "this may be
 * incomplete".
 */
function handedOnBy(handedOn: readonly PassThrough[]): string | null {
  const [first, ...rest] = handedOn;
  if (first === undefined) return null;
  // The sentence used to say the pass-through "declares nothing the graph could
  // read", which was true only while the rule required an empty file. It does
  // not, and four readers were told that lib/express.js, command.go and
  // solver.py declare nothing while the box beside the sentence listed 1, 202
  // and 49 of their symbols. What the sentence is actually about is the
  // importers on the far side of the file, so that is what it says now.
  const where = rest.length === 0 ? first.filePath : `${first.filePath} and ${rest.length} more`;
  const files = first.importers === 1 ? '1 file' : `${first.importers} files`;
  return `Handed on by ${where}, imported by ${files} — any of them can reach this without naming this file, so the count is a floor.`;
}

/**
 * What every list of calls in this module leaves out, and what its order is not.
 *
 * Both halves are one failure, and both were read wrong on the same question.
 * A reader asked whether flag parsing runs before `PersistentPreRun` and
 * consulted cobra's `Command.execute`: the four persistent hooks were not in
 * the list, because each is reached through a name whose type the parser could
 * not follow, and the rest came back in alphabetical order with nothing saying
 * that is what it was. An omission nobody is told about and an order nobody is
 * told about answer a question about sequence wrong in the same confident
 * voice a true answer would use.
 *
 * The omission has a shape worth naming rather than a hedge, because naming it
 * tells a reader where to look instead: what is dropped is a call through a
 * receiver this file does not type — the result of another call
 * (`c.Root().Traverse(…)`), a struct field, an element of a collection nothing
 * declared. Those are exactly the five that made `getCompletions`'s list of
 * fifteen read as complete.
 *
 * The order is the half that cannot be fixed here at all, and saying so is the
 * whole of what can be done: `ParsedSymbol.calls` is a set of names by the time
 * it leaves the parser, so the line a call is written on never reaches the
 * graph, and there is no source order to sort by. See the note in CLAUDE.md
 * about sequence diagrams — it is the same missing fact.
 */
const CALLS = {
  // Never 'tracked', and a constant rather than a computation, because nothing
  // in the graph could raise it: a list of calls has no equivalent of
  // `passThroughs`, no evidence of its own incompleteness to weigh. It is a
  // pair anyway so that a consumer reads a call list the way it reads the three
  // counts beside it, rather than having to know this one is qualified in prose.
  coverage: 'partial',
  note:
    'Calls through a receiver this file does not type — the result of another call, a struct field, an element of an untyped collection — are not tracked, so this is a floor and not a census. The order is not the source\'s: it is by file and then by name, because the graph keeps which names are called and never the lines they are called on.',
} as const satisfies { coverage: Tracking; note: string };

/**
 * The distinct files `target` calls into with its own top-level statements.
 *
 * Lifted to files because that is the currency the rest of a FileDetail is in,
 * and the only one the panel can act on — a symbol id is not a box to select.
 * A file calling what it declares is already refused by the store; the test
 * here is what keeps an edge whose target the graph has since dropped from
 * putting an empty path in the list.
 */
function callsOf(graph: Graph, target: string): string[] {
  const called = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'calls' || edge.from !== target) continue;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (to !== undefined && to !== target) called.add(to);
  }
  return [...called].sort();
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
  /**
   * `'file'` on a caller, and only there.
   *
   * A call written outside every symbol belongs to the file, so `usedBy` can
   * name a box rather than a row — the file's `name` is its basename and its
   * `line` is 1. It cannot happen on `uses`: a call resolves through the
   * export tables, which hold symbols only, so nothing in the graph calls a
   * file.
   */
  kind: NodeKind;
  filePath: string;
  line: number;
  /** Which relationship, so a call can read differently from an inheritance. */
  edge: ReachingEdgeKind;
}

export interface SymbolLinks {
  id: string;
  name: string;
  kind: NodeKind;
  filePath: string;
  /**
   * What this symbol reaches out to, by file and then by name — see `CALLS`,
   * which is also why that is not the order the calls are written in.
   */
  uses: SymbolRelation[];
  /**
   * How the graph looked for `uses`, and what its order is. The pair `usedBy`
   * carries, asked of the other direction; see `CALLS` for why it is fixed.
   */
  usesCoverage: Tracking;
  usesNote: string;
  /** What reaches it. This is the half nothing else in the app can answer. */
  usedBy: SymbolRelation[];
  /**
   * How the graph looked for `usedBy`, and what that leaves out. Never how
   * complete the list is — see `Tracking`.
   *
   * The word here used to be `full` for a top-level class or function, and it
   * was the one claim in the API a reader could not check. `QueryObserver`
   * answered `full` beside sixteen callers while grep finds 26 non-test sites
   * in 8 packages of TanStack/query: the seven adapters hand the class to
   * `useBaseQuery` rather than calling it, and a value passed to a function is
   * not a call the parser sees.
   *
   * The rest were already partial, each for its own reason. A member is
   * reached through a receiver, and a receiver whose type is not written down
   * is not guessed at — a missing edge is a gap, a wrong one is a lie — so for
   * a method or a field the list holds the typed calls only. cobra's
   * `Command.Execute` answered "0 in" while grep found sixteen callers. A
   * function assigned to a property, express's `app.handle`, is called through
   * the object it hangs off: application.js calls `compileETag(val)` at line
   * 365 and utils.js's `exports.compileETag` answered "0 in, full". And an
   * interface or a type is mostly used in type positions, which are not edges
   * at all.
   */
  coverage: Tracking;
  /** The sentence the panel shows beside the count, in the graph's own words. */
  coverageNote: string;
}

type Coverage = Pick<SymbolLinks, 'coverage' | 'coverageNote'>;

const UNTYPED_RECEIVER: Coverage = {
  coverage: 'partial',
  coverageNote:
    'Calls through a receiver whose type is not written down are not tracked, so the count is a floor and an empty list means unknown, not none.',
};

const ASSIGNED_PROPERTY: Coverage = {
  coverage: 'partial',
  coverageNote:
    'Called through the object it is assigned to, which is not tracked, so the count is a floor and an empty list means unknown, not none.',
};

const TYPE_POSITION: Coverage = {
  coverage: 'partial',
  coverageNote:
    'Uses in type positions are not tracked, so the count is a floor and an empty list means unknown, not none.',
};

const BY_NAME: Coverage = {
  coverage: 'tracked',
  coverageNote:
    'References by name are followed across every file that imports this one; one passed to a function as a value, or written only in a type, is not. The count is a floor.',
};

/**
 * How much of `usedBy` the graph can vouch for.
 *
 * A class and a top-level function are the two that changed. They are values,
 * and the ways a value travels — handed to another function, put in a table,
 * carried on by a file that re-exports it — are not calls, so `full` was never
 * true of them. `tracked` is what is true: the name is followed wherever the
 * file is imported. When the graph can also see a file being handed on, that
 * is evidence of a path it does not follow, and the answer drops to `partial`
 * naming it — which is the QueryObserver case, and the reason this takes a
 * graph rather than a name and a kind.
 */
function coverageOf(graph: Graph, name: string, kind: NodeKind, filePath: string): Coverage {
  if (kind === 'method' || kind === 'field') return UNTYPED_RECEIVER;
  if (kind === 'interface' || kind === 'type') return TYPE_POSITION;
  // A top-level function or class whose name is not a plain identifier was
  // assigned to a property: `app.init = function init`, or express's
  // `app[method] = ...` written once for every HTTP verb. Neither can be
  // reached by name, so neither is tracked — and the subscript form has no dot
  // to spot it by, which read as "nothing references this" over the four
  // busiest methods in express.
  if (/[.[]/.test(name)) return ASSIGNED_PROPERTY;

  const where = handedOnBy(passThroughs(graph, (file) => file === filePath));
  if (where === null) return BY_NAME;
  return {
    coverage: 'partial',
    coverageNote: `${where} One passed to a function as a value is not tracked either. The count is a floor.`,
  };
}

export function describeSymbol(graph: Graph, id: string): SymbolLinks | null {
  const symbol = graph.nodes.get(id);
  if (!symbol || symbol.kind === 'file') return null;

  // A file used to be dropped here, which quietly threw away every caller that
  // was a top-level statement — the largest class of call the graph knows
  // about, 1560 edges on zod. `contains` is the only edge that would put a
  // symbol's own file in this list, and REACHES already leaves it out.
  const relate = (otherId: string, edge: string): SymbolRelation | null => {
    const other = graph.nodes.get(otherId);
    if (!other) return null;
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
    if (!REACHES.has(edge.kind)) continue;
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
    usesCoverage: CALLS.coverage,
    usesNote: CALLS.note,
    ...coverageOf(graph, symbol.name, symbol.kind, symbol.filePath),
  };
}

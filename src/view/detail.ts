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

import type { Graph, GraphNode } from '../graph/types.js';

/**
 * Render the graph as a Mermaid class diagram with one box per file.
 *
 * Files are the boxes because that is the unit a developer navigates; the
 * symbols a file declares are listed inside it. Symbol-level `extends` and
 * `implements` are lifted to the files that hold them, so inheritance stays
 * visible without a node per symbol.
 *
 * `calls` edges are deliberately omitted: at file granularity a call into
 * another file is already implied by the import edge beside it, so drawing both
 * doubles the lines without adding information.
 */
export function toClassDiagram(graph: Graph): string {
  const files = [...graph.nodes.values()]
    .filter((node) => node.kind === 'file')
    .sort((a, b) => a.filePath.localeCompare(b.filePath));

  if (files.length === 0) {
    return 'classDiagram\n  class Empty["no files parsed"]\n';
  }

  const boxIds = assignBoxIds(files.map((file) => file.filePath));
  const symbols = groupSymbolsByFile(graph);

  const lines: string[] = ['classDiagram', '  direction LR', ''];

  for (const file of files) {
    const id = boxIds.get(file.filePath);
    if (!id) continue;

    const members = symbols.get(file.filePath) ?? [];
    if (members.length === 0) {
      lines.push(`  class ${id}["${escapeLabel(file.filePath)}"]`);
      continue;
    }

    lines.push(`  class ${id}["${escapeLabel(file.filePath)}"] {`);
    for (const member of members) lines.push(`    ${memberLine(member)}`);
    lines.push('  }');
  }

  const relations = fileRelations(graph, boxIds);
  if (relations.length > 0) {
    lines.push('');
    lines.push(...relations);
  }

  return `${lines.join('\n')}\n`;
}

/** A function reads as `name()`; everything else is tagged with its kind. */
function memberLine(symbol: GraphNode): string {
  return symbol.kind === 'function' ? `${symbol.name}()` : `«${symbol.kind}» ${symbol.name}`;
}

function groupSymbolsByFile(graph: Graph): Map<string, GraphNode[]> {
  const byFile = new Map<string, GraphNode[]>();
  for (const node of graph.nodes.values()) {
    if (node.kind === 'file') continue;
    const existing = byFile.get(node.filePath);
    if (existing) existing.push(node);
    else byFile.set(node.filePath, [node]);
  }
  return byFile;
}

/** Mermaid ids must be identifier-safe, so paths are sanitised and de-duplicated. */
function assignBoxIds(filePaths: readonly string[]): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();

  for (const filePath of filePaths) {
    const base = filePath.replace(/[^A-Za-z0-9]/g, '_');
    let id = base;
    let suffix = 2;
    while (used.has(id)) {
      id = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(id);
    ids.set(filePath, id);
  }

  return ids;
}

const RELATION_ARROWS = {
  // Mermaid points inheritance arrows at the base, so `to` comes first.
  extends: '<|--',
  implements: '<|..',
  imports: '..>',
} as const;

function fileRelations(graph: Graph, boxIds: ReadonlyMap<string, string>): string[] {
  const drawn = new Set<string>();
  const relations: string[] = [];

  for (const edge of graph.edges) {
    const kind = edge.kind;
    if (kind !== 'extends' && kind !== 'implements' && kind !== 'imports') continue;

    const fromFile = fileOf(graph, edge.from);
    const toFile = fileOf(graph, edge.to);
    if (!fromFile || !toFile || fromFile === toFile) continue;

    const fromId = boxIds.get(fromFile);
    const toId = boxIds.get(toFile);
    if (!fromId || !toId) continue;

    const line = kind === 'imports'
      ? `  ${fromId} ${RELATION_ARROWS.imports} ${toId} : imports`
      : `  ${toId} ${RELATION_ARROWS[kind]} ${fromId} : ${kind}`;

    if (drawn.has(line)) continue;
    drawn.add(line);
    relations.push(line);
  }

  return relations;
}

function fileOf(graph: Graph, nodeId: string): string | null {
  return graph.nodes.get(nodeId)?.filePath ?? null;
}

/** Quotes would terminate the label; paths never legitimately contain them. */
function escapeLabel(text: string): string {
  return text.replace(/"/g, '');
}


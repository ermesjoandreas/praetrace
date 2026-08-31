#!/usr/bin/env node
import path from 'node:path';
import { applyBatch, createStore } from '../graph/store.js';
import type { Graph, GraphEdge, GraphNode } from '../graph/types.js';
import { createParserPool } from '../parser/pool.js';
import { scanProject } from '../project/scan.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.');

  const startedAt = performance.now();
  const pool = createParserPool();
  let scan;
  try {
    scan = await scanProject(pool, root);
  } finally {
    await pool.close();
  }

  if (scan.parsed.length === 0 && scan.failures.length === 0) {
    console.error(`codemap: no TypeScript files under ${root}`);
    process.exitCode = 1;
    return;
  }

  const store = createStore();
  applyBatch(store, scan.parsed, []);
  const elapsedMs = Math.round(performance.now() - startedAt);

  if (asJson) {
    console.log(JSON.stringify({ nodes: [...store.graph.nodes.values()], edges: store.graph.edges }, null, 2));
  } else {
    report(store.graph, root, scan.parsed.length, elapsedMs);
  }

  for (const failure of scan.failures) console.error(`codemap: ${failure}`);
  if (scan.failures.length > 0) process.exitCode = 1;
}

function countBy<T, K extends string>(items: Iterable<T>, key: (item: T) => K): string {
  const counts = new Map<K, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join(' · ');
}

function report(graph: Graph, root: string, fileCount: number, elapsedMs: number): void {
  const nodes = [...graph.nodes.values()];

  console.log(`codemap  ${root}`);
  console.log(`${fileCount} files · ${nodes.length} nodes · ${graph.edges.length} edges · ${elapsedMs} ms`);
  console.log();
  console.log(`nodes  ${countBy(nodes, (node) => node.kind)}`);
  console.log(`edges  ${countBy(graph.edges, (edge) => edge.kind)}`);
  console.log();

  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    if (node.kind === 'file') continue;
    const existing = symbolsByFile.get(node.filePath);
    if (existing) existing.push(node);
    else symbolsByFile.set(node.filePath, [node]);
  }

  for (const filePath of [...symbolsByFile.keys()].sort()) {
    console.log(filePath);
    for (const symbol of symbolsByFile.get(filePath) ?? []) {
      const kind = symbol.kind.padEnd(9);
      console.log(`  ${kind} ${symbol.name.padEnd(28)} L${symbol.range.startLine}-${symbol.range.endLine}`);
    }
  }

  // `contains` is already implied by the listing above.
  const structural = graph.edges.filter((edge) => edge.kind !== 'contains');
  if (structural.length > 0) {
    console.log();
    console.log('edges');
    for (const edge of sortEdges(structural)) {
      console.log(`  ${edge.kind.padEnd(10)} ${edge.from} -> ${edge.to}`);
    }
  }
}

function sortEdges(edges: readonly GraphEdge[]): GraphEdge[] {
  return [...edges].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});

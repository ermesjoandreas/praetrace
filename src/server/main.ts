#!/usr/bin/env node
import path from 'node:path';
import { createStore, setFiles } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
import { scanProject } from '../project/scan.js';
import { buildApp } from './app.js';

const DEFAULT_PORT = 4400;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.');
  const port = readPort(args);

  const pool = createParserPool();
  let scan;
  try {
    scan = await scanProject(pool, root);
  } finally {
    // Nothing re-parses yet, so the workers have no reason to stay alive past
    // the boot scan. Step 3 keeps the pool open for the watcher.
    await pool.close();
  }

  const store = createStore();
  setFiles(store, scan.parsed);

  for (const failure of scan.failures) console.error(`codemap: ${failure}`);

  const app = buildApp({ store, root });
  const address = await app.listen({ port, host: '127.0.0.1' });

  console.log(`codemap  ${root}`);
  console.log(`${scan.parsed.length} files · ${store.graph.nodes.size} nodes · ${store.graph.edges.length} edges`);
  console.log(`\n  ${address}\n`);
}

function readPort(args: readonly string[]): number {
  const flag = args.find((arg) => arg.startsWith('--port='));
  if (!flag) return DEFAULT_PORT;
  const value = Number(flag.slice('--port='.length));
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`invalid --port: ${flag.slice('--port='.length)}`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

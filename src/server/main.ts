#!/usr/bin/env node
import path from 'node:path';
import { applyBatch, createStore } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
import { scanProject } from '../project/scan.js';
import { createUpdater } from '../project/updater.js';
import { watchProject } from '../project/watch.js';
import { buildApp } from './app.js';
import { createLiveHub } from './live.js';

const DEFAULT_PORT = 4400;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.');
  const port = readPort(args);

  // The pool outlives the boot scan: every later change re-parses through it.
  const pool = createParserPool();
  const store = createStore();

  const scan = await scanProject(pool, root);
  applyBatch(store, scan.parsed, []);
  for (const failure of scan.failures) console.error(`codemap: ${failure}`);

  const hub = createLiveHub(store);

  // Both event sources queue here. There is no second pipeline.
  const updater = createUpdater({
    store,
    pool,
    onApplied: (changedFiles) => hub.publish(changedFiles),
    onError: (message) => console.error(`codemap: ${message}`),
  });

  const watcher = watchProject({ root, onChange: (change) => updater.queue(change) });
  const app = buildApp({ store, root, hub, updater });
  const address = await app.listen({ port, host: '127.0.0.1' });

  process.on('SIGINT', () => {
    updater.close();
    void Promise.allSettled([watcher.close(), pool.close(), app.close()]).then(() => {
      process.exit(0);
    });
  });

  console.log(`codemap  ${root}`);
  console.log(`${scan.parsed.length} files · ${store.graph.nodes.size} nodes · ${store.graph.edges.length} edges`);
  console.log(`\n  ${address}\n`);
  console.log(`watching for changes · hook endpoint at ${address}/api/hook\n`);
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

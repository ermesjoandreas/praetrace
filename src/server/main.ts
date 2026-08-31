#!/usr/bin/env node
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { applyBatch, createStore } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
import { scanProject } from '../project/scan.js';
import { createUpdater } from '../project/updater.js';
import { watchProject } from '../project/watch.js';
import { buildApp } from './app.js';
import { createLiveHub } from './live.js';

const DEFAULT_PORT = 4400;

/**
 * The one line a supervising process parses. Everything else on stdout is prose
 * for a human, so the contract is this prefix and nothing else.
 */
const PORT_LINE_PREFIX = 'codemap-port=';

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
  await app.listen({ port, host: '127.0.0.1' });

  const bound = app.server.address() as AddressInfo | null;
  const actualPort = bound?.port ?? port;
  const address = `http://127.0.0.1:${actualPort}`;

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    updater.close();
    void Promise.allSettled([watcher.close(), pool.close(), app.close()]).then(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (args.includes('--exit-on-stdin-close')) {
    // The supervising process holds this pipe open. If it dies without getting
    // to kill us — a crash, a SIGKILL — the pipe closes and we exit rather than
    // becoming an orphan holding a port and a worker pool.
    process.stdin.resume();
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }

  // Written before the prose so a supervisor can stop reading at the first line.
  console.log(`${PORT_LINE_PREFIX}${actualPort}`);
  console.log(`codemap  ${root}`);
  console.log(`${scan.parsed.length} files · ${store.graph.nodes.size} nodes · ${store.graph.edges.length} edges`);
  console.log(`\n  ${address}\n`);
  console.log(`watching for changes · hook endpoint at ${address}/api/hook\n`);
}

/**
 * `--port=0` asks the OS to assign a free one, which is what the desktop shell
 * uses: it cannot assume any particular port is free, and several windows have
 * to coexist. The CLI keeps a fixed default so `npm run serve` stays predictable.
 */
function readPort(args: readonly string[]): number {
  const flag = args.find((arg) => arg.startsWith('--port='));
  if (!flag) return DEFAULT_PORT;

  const raw = flag.slice('--port='.length);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`invalid --port: ${raw}`);
  }
  return value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

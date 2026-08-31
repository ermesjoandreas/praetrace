#!/usr/bin/env node
import path from 'node:path';
import { applyBatch, createStore } from '../graph/store.js';
import { createParserPool } from '../parser/pool.js';
import type { ParsedFile } from '../parser/types.js';
import { scanProject } from '../project/scan.js';
import { watchProject, type FileChange } from '../project/watch.js';
import { buildApp } from './app.js';
import { createLiveHub } from './live.js';

const DEFAULT_PORT = 4400;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = path.resolve(args.find((arg) => !arg.startsWith('--')) ?? '.');
  const port = readPort(args);

  // The pool now outlives the boot scan: the watcher re-parses through it.
  const pool = createParserPool();
  const store = createStore();

  const scan = await scanProject(pool, root);
  applyBatch(store, scan.parsed, []);
  for (const failure of scan.failures) console.error(`codemap: ${failure}`);

  const hub = createLiveHub(store);

  const watcher = watchProject({
    root,
    onBatch: (changes) => {
      void handleChanges(changes).catch((error: unknown) => {
        console.error(`codemap: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  });

  async function handleChanges(changes: readonly FileChange[]): Promise<void> {
    const removed = changes.filter((change) => change.kind === 'removed').map((c) => c.filePath);
    const edited = changes.filter((change) => change.kind === 'changed');

    const results = await Promise.allSettled(
      edited.map((change) => pool.parse(change.filePath, change.absolutePath)),
    );

    const updated: ParsedFile[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') updated.push(result.value);
      else console.error(`codemap: ${String(result.reason)}`);
    }

    applyBatch(store, updated, removed);

    // Published even when the graph is unchanged: a touched file is worth
    // showing, and a comment-only edit still tells you where the agent is.
    hub.publish(changes.map((change) => change.filePath));
  }

  const app = buildApp({ store, root, hub });
  const address = await app.listen({ port, host: '127.0.0.1' });

  process.on('SIGINT', () => {
    void Promise.allSettled([watcher.close(), pool.close(), app.close()]).then(() => {
      process.exit(0);
    });
  });

  console.log(`codemap  ${root}`);
  console.log(`${scan.parsed.length} files · ${store.graph.nodes.size} nodes · ${store.graph.edges.length} edges`);
  console.log(`\n  ${address}\n`);
  console.log('watching for changes…\n');
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

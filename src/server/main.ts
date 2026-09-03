#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { sweepHistoryDirs } from '../project/history.js';
import { createPortFile } from '../project/port-file.js';
import { buildApp } from './app.js';
import { createLiveHub, type LiveHub } from './live.js';
import { startSessionHost, type SessionHost } from './session.js';

const DEFAULT_PORT = 4400;

/**
 * The one line a supervising process parses. Everything else on stdout is prose
 * for a human, so the contract is this prefix and nothing else.
 */
const PORT_LINE_PREFIX = 'codemap-port=';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = readPort(args);

  let host: SessionHost | null = null;
  let hub: LiveHub | null = null;

  // The hub reads the project through the host rather than capturing a store,
  // so a project switch is invisible to it. Nothing here runs before both exist.
  hub = createLiveHub(() => {
    if (!host) throw new Error('no project session');
    return host.current();
  });

  // Leftovers from a commit a previous process was drawing when it was killed.
  void sweepHistoryDirs();
  host = await startSessionHost(await realRoot(args.find((arg) => !arg.startsWith('--')) ?? '.'), {
    onApplied: (changedFiles) => hub?.publish(changedFiles),
    onError: (message) => console.error(`codemap: ${message}`),
    // A commit or a checkout changed what differs from the base. Published with
    // no changed files, because nothing was written: the badges and the chip
    // are new, and pulsing every box a commit touched would say the agent had
    // just been there.
    onGitChanged: () => hub?.publish([]),
  });

  // The port is only known after listen, so the file follows the project
  // through this holder rather than being captured at construction.
  let ports: ReturnType<typeof createPortFile> | null = null;

  const app = buildApp({
    host,
    hub,
    onProjectChanged: async (changedRoot) => {
      await ports?.pointAt(changedRoot);
    },
    onExplainRun: (run) => hub?.explainChanged(run),
    onExplainDelta: (text) => {
      const run = host.current().explainRun();
      if (run !== null) hub?.explainDelta(run.id, text);
    },
  });
  await app.listen({ port, host: '127.0.0.1' });

  const bound = app.server.address() as AddressInfo | null;
  const actualPort = bound?.port ?? port;
  const address = `http://127.0.0.1:${actualPort}`;

  ports = createPortFile(actualPort);
  await ports.pointAt(host.current().root);

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([ports?.clear(), host?.close(), app.close()]).then(() => {
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

  const session = host.current();

  // Written before the prose so a supervisor can stop reading at the first line.
  console.log(`${PORT_LINE_PREFIX}${actualPort}`);
  console.log(`codemap  ${session.root}`);
  console.log(`${session.store.files.size} files · ${session.store.graph.nodes.size} nodes · ${session.store.graph.edges.length} edges`);
  console.log(`\n  ${address}\n`);
  console.log(`watching for changes · hook endpoint at ${address}/api/hook\n`);
}

/**
 * The root as the file system spells it, resolved once at boot so that the
 * watcher, git, the port file, the hook and the line printed below all mean the
 * same directory by the same name.
 *
 * `codemap /tmp/x` and `codemap /private/tmp/x` are the same project on macOS,
 * where every `/tmp` and `/var` path is a symlink — and Claude Code reports the
 * resolved spelling. Starting on the other one is what made every hook call
 * land outside the project; see `changeFromHook`, which resolves both sides
 * again because a project switch does not come through here.
 *
 * A root that does not exist falls through unresolved, so the error naming it
 * is still the session's own.
 */
async function realRoot(root: string): Promise<string> {
  const absolute = path.resolve(root);
  return realpath(absolute).catch(() => absolute);
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

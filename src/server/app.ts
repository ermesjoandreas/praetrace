import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { changeFromHook, type HookPayload } from '../project/hook.js';
import { installHook, readHookStatus } from '../project/hook-install.js';
import { describe } from '../view/detail.js';
import {
  DEFAULT_EDGE_KINDS,
  parseDuration,
  type ViewFilter,
} from '../view/filter.js';
import { search } from '../view/search.js';
import { selectView } from '../view/select.js';
import type { ViewSpec } from '../view/types.js';
import type { LiveHub } from './live.js';
import type { SessionHost } from './session.js';

// Vite builds the page into dist/web, beside this module's dist/server.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_DEPTH = 4;

export interface AppOptions {
  /** Holds the current project. Routes read through it, never around it. */
  host: SessionHost;
  hub: LiveHub;
  /**
   * Called whenever the project changes, or gains a .claude directory, so the
   * port file can follow it. The hook reads that file to find this server.
   */
  onProjectChanged: (root: string) => Promise<void>;
}

export function buildApp({ host, hub, onProjectChanged }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: WEB_DIR });
  app.register(websocket);

  app.get('/api/view', async (request) => {
    const session = host.current();
    return {
      root: session.root,
      // The cutoff for "changed recently" is computed per request, so a stored
      // spec does not freeze time at the moment it was set.
      view: selectView(session.store.graph, toSpec(request.query as Record<string, unknown>), Date.now()),
    };
  });

  app.get('/api/project', async () => ({ root: host.current().root }));

  app.get('/api/detail', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const target = typeof query['path'] === 'string' ? query['path'] : '';
    const detail = describe(host.current().store.graph, target);
    if (!detail) return reply.code(404).send({ error: `nothing known about ${target}` });
    return detail;
  });

  app.get('/api/search', async (request) => {
    const query = request.query as Record<string, unknown>;
    const term = typeof query['q'] === 'string' ? query['q'] : '';
    return { hits: search(host.current().store.graph, term) };
  });

  app.get('/api/changes', async () => ({ changes: [...host.current().history()].reverse() }));

  app.post('/api/project', async (request, reply) => {
    const body = (request.body ?? {}) as { root?: unknown };
    if (typeof body.root !== 'string' || body.root === '') {
      return reply.code(400).send({ error: 'root must be a non-empty string' });
    }

    try {
      const session = await host.switchTo(body.root);
      await onProjectChanged(session.root);
      // Clients are holding specs that name paths in the old project.
      hub.projectChanged();
      return { root: session.root };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/hook-status', async () => readHookStatus(host.current().root));

  app.post('/api/hook-install', async (_request, reply) => {
    const root = host.current().root;
    try {
      const status = await installHook(root);
      // Installing creates .claude/ when it was missing, which is the condition
      // the port file waits for.
      await onProjectChanged(root);
      return status;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post('/api/hook', async (request, reply) => {
    const session = host.current();
    const change = await changeFromHook((request.body ?? {}) as HookPayload, session.root);
    if (change) session.queue(change);
    // A hook must never fail the agent's tool call, so a payload we cannot use
    // is still a success.
    return reply.code(200).send({ accepted: change !== null });
  });

  app.register(async (scoped) => {
    scoped.get('/live', { websocket: true }, (socket) => {
      hub.add(socket, toSpec({}));

      socket.on('message', (raw: Buffer) => {
        // The client tells us which slice it is looking at, so an update can be
        // computed per client rather than broadcast as one shared view.
        try {
          const message = JSON.parse(String(raw)) as { spec?: Record<string, unknown> };
          if (message.spec) hub.setSpec(socket, toSpec(message.spec));
        } catch {
          // A malformed frame is not worth dropping the connection over.
        }
      });

      socket.on('close', () => hub.remove(socket));
    });
  });

  return app;
}

/** Everything here is user input, from a query string or a socket frame. */
function toSpec(raw: Record<string, unknown>): ViewSpec {
  const focus = typeof raw['focus'] === 'string' && raw['focus'] !== '' ? raw['focus'] : null;
  return {
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : '',
    focus,
    depth: readDepth(raw['depth']),
    filter: toFilter(raw),
  };
}

const NODE_KINDS = ['class', 'function', 'interface', 'type'] as const;
const EDGE_KINDS = ['imports', 'extends', 'implements', 'calls'] as const;

/** Every field is user input, from a query string or a socket frame. */
function toFilter(raw: Record<string, unknown>): ViewFilter {
  const edges = readList(raw['edges'], EDGE_KINDS);

  return {
    hidePath: typeof raw['hide'] === 'string' ? raw['hide'] : '',
    onlyPath: typeof raw['only'] === 'string' ? raw['only'] : '',
    kinds: readList(raw['kinds'], NODE_KINDS),
    edgeKinds: edges.length > 0 ? edges : DEFAULT_EDGE_KINDS,
    sinceMs: typeof raw['since'] === 'string' ? parseDuration(raw['since']) : 0,
  };
}

function readList<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (typeof raw !== 'string' || raw === '') return [];
  const wanted = new Set(raw.split(','));
  return allowed.filter((value) => wanted.has(value));
}

function readDepth(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DEPTH);
}

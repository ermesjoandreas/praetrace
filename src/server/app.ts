import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GraphStore } from '../graph/store.js';
import { selectView } from '../view/select.js';
import type { ViewSpec } from '../view/types.js';
import { changeFromHook, type HookPayload } from '../project/hook.js';
import type { ProjectUpdater } from '../project/updater.js';
import type { LiveHub } from './live.js';

// Vite builds the page into dist/web, beside this module's dist/server.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_DEPTH = 4;

export interface AppOptions {
  store: GraphStore;
  /** Absolute path of the scanned project, shown in the page header. */
  root: string;
  hub: LiveHub;
  updater: ProjectUpdater;
}

export function buildApp({ store, root, hub, updater }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: WEB_DIR });
  app.register(websocket);

  app.get('/api/view', async (request) => ({
    root,
    view: selectView(store.graph, toSpec(request.query as Record<string, unknown>)),
  }));

  app.post('/api/hook', async (request, reply) => {
    const change = await changeFromHook((request.body ?? {}) as HookPayload, root);
    if (change) updater.queue(change);
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
  };
}

function readDepth(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DEPTH);
}

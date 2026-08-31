import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { changeFromHook, type HookPayload } from '../project/hook.js';
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
}

export function buildApp({ host, hub }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: WEB_DIR });
  app.register(websocket);

  app.get('/api/view', async (request) => {
    const session = host.current();
    return {
      root: session.root,
      view: selectView(session.store.graph, toSpec(request.query as Record<string, unknown>)),
    };
  });

  app.get('/api/project', async () => ({ root: host.current().root }));

  app.post('/api/project', async (request, reply) => {
    const body = (request.body ?? {}) as { root?: unknown };
    if (typeof body.root !== 'string' || body.root === '') {
      return reply.code(400).send({ error: 'root must be a non-empty string' });
    }

    try {
      const session = await host.switchTo(body.root);
      // Clients are holding specs that name paths in the old project.
      hub.projectChanged();
      return { root: session.root };
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
  };
}

function readDepth(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DEPTH);
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GraphStore } from '../graph/store.js';
import { selectView } from '../view/select.js';
import type { ViewSpec } from '../view/types.js';

// Vite builds the page into dist/web, beside this module's dist/server.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_DEPTH = 4;

export interface AppOptions {
  store: GraphStore;
  /** Absolute path of the scanned project, shown in the page header. */
  root: string;
}

export function buildApp({ store, root }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });

  app.register(fastifyStatic, { root: WEB_DIR });

  app.get('/api/view', async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const spec: ViewSpec = {
      scope: query.scope ?? '',
      focus: query.focus ?? null,
      depth: readDepth(query.depth),
    };

    return { root, view: selectView(store.graph, spec) };
  });

  return app;
}

/** Depth is user input from the URL; anything unusable falls back to one hop. */
function readDepth(raw: string | undefined): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, MAX_DEPTH);
}

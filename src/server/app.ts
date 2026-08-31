import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import type { GraphStore } from '../graph/store.js';
import { toClassDiagram } from '../render/mermaid.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
// Resolved through the package rather than a hard-coded node_modules path, so
// the bundle is found the same way whether codemap is linked or installed.
const MERMAID_BUNDLE = fileURLToPath(import.meta.resolve('mermaid/dist/mermaid.min.js'));

export interface AppOptions {
  store: GraphStore;
  /** Absolute path of the scanned project, shown in the page header. */
  root: string;
}

export function buildApp({ store, root }: AppOptions): FastifyInstance {
  const app = Fastify({ logger: false });
  let mermaidBundle: Buffer | null = null;

  app.get('/', async (_request, reply) => {
    // Read per request: one local user, and it makes the page editable without
    // a restart.
    const html = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.get('/api/diagram', async () => ({
    root,
    source: toClassDiagram(store.graph),
    counts: {
      files: [...store.graph.nodes.values()].filter((node) => node.kind === 'file').length,
      nodes: store.graph.nodes.size,
      edges: store.graph.edges.length,
    },
  }));

  app.get('/vendor/mermaid.min.js', async (_request, reply) => {
    mermaidBundle ??= await readFile(MERMAID_BUNDLE);
    return reply.type('application/javascript; charset=utf-8').send(mermaidBundle);
  });

  return app;
}

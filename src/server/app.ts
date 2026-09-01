import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { changeFromHook, type HookPayload } from '../project/hook.js';
import {
  applyDecision,
  createManualGroup,
  deleteGroup,
  GROUP_COLORS,
  mergeGroups,
  readGroups,
  updateGroup,
  writeGroups,
  type GroupColor,
  type NamedGroup,
} from '../project/groups.js';
import { installHook, readHookStatus } from '../project/hook-install.js';
import { describe } from '../view/detail.js';
import {
  DEFAULT_EDGE_KINDS,
  parseDuration,
  type ViewFilter,
} from '../view/filter.js';
import { clusterFiles, identify } from '../view/cluster.js';
import { search } from '../view/search.js';
import { selectView } from '../view/select.js';
import type { ViewSpec } from '../view/types.js';
import type { LiveHub } from './live.js';
import type { SessionHost } from './session.js';

// Vite builds the page into dist/web, beside this module's dist/server.
const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');

const MAX_DEPTH = 4;

/**
 * The bases worth offering. Not an arbitrary revision string: whatever is picked
 * here reaches `git diff` on the machine, and the three that mean something to
 * someone watching an agent work are "since I last committed", "the commit
 * before that" and "everything on this branch".
 */
const GIT_BASES = ['HEAD', 'HEAD~1', 'branch'] as const;

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

  // The MCP proxy marks its own requests, which is the only way to tell an
  // agent's question from a browser's. One hook, no extra round trip.
  app.addHook('onRequest', async (request) => {
    const tool = request.headers['x-codemap-tool'];
    if (typeof tool !== 'string' || tool === '') return;

    const rawTarget = request.headers['x-codemap-arg'];
    const call = {
      at: Date.now(),
      tool,
      target: typeof rawTarget === 'string' && rawTarget !== '' ? rawTarget : null,
    };
    host.current().recordAgentCall(call);
    hub.agentActed(call);
  });

  app.register(fastifyStatic, { root: WEB_DIR });
  app.register(websocket);

  app.get('/api/view', async (request) => {
    const session = host.current();
    return {
      root: session.root,
      // The cutoff for "changed recently" is computed per request, so a stored
      // spec does not freeze time at the moment it was set.
      view: selectView(
        session.store.graph,
        toSpec(request.query as Record<string, unknown>),
        Date.now(),
        session.gitStatus(),
      ),
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

  app.get('/api/clusters', async () => {
    const session = host.current();
    // The graph decides membership; the stored file only supplies names.
    const clusters = clusterFiles(session.store.graph);
    return { clusters: mergeGroups(clusters, await readGroups(session.root)) };
  });

  app.post('/api/clusters', async (request, reply) => {
    const body = (request.body ?? {}) as {
      files?: unknown;
      name?: unknown;
      state?: unknown;
      id?: unknown;
    };
    const files = Array.isArray(body.files) ? body.files.filter((f) => typeof f === 'string') : [];
    const state = body.state === 'rejected' ? 'rejected' : 'accepted';
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (files.length === 0) return reply.code(400).send({ error: 'files must be a non-empty array' });
    if (state === 'accepted' && name === '') {
      return reply.code(400).send({ error: 'an accepted group needs a name' });
    }

    const root = host.current().root;
    // Derived rather than demanded: a caller that knows only the file list —
    // the MCP tools, for one — should not have to carry an id as well.
    const id = typeof body.id === 'string' ? body.id : identify([...files].sort());
    await writeGroups(
      root,
      applyDecision(await readGroups(root), files, { name, state, id }),
    );
    return { ok: true };
  });

  app.post('/api/groups', async (request, reply) => {
    const root = host.current().root;

    let next: NamedGroup[];
    try {
      next = applyGroupAction(await readGroups(root), (request.body ?? {}) as GroupAction);
    } catch (error) {
      // Every helper refuses bad input by throwing, so one catch covers the lot.
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
    await writeGroups(root, next);

    // Merged rather than returned raw: `mergeGroups` is what pairs a stored name
    // with the cluster the graph currently finds, and it is the only shape the
    // page has a state setter for.
    const session = host.current();
    return { clusters: mergeGroups(clusterFiles(session.store.graph), next) };
  });

  app.get('/api/git', async () => host.current().gitStatus() ?? { available: false });

  app.post('/api/git-base', async (request, reply) => {
    const body = (request.body ?? {}) as { base?: unknown };
    const base = typeof body.base === 'string' ? body.base : '';
    if (!(GIT_BASES as readonly string[]).includes(base)) {
      return reply.code(400).send({ error: `base must be one of ${GIT_BASES.join(', ')}` });
    }

    const status = await host.current().setGitBase(base);
    // Every view carries the status, so until a fresh one is pushed the badges
    // on screen still describe the base that was just replaced.
    hub.publish([]);
    return status ?? { available: false };
  });

  app.get('/api/agent', async () => {
    const calls = [...host.current().agentCalls()].reverse();
    return { calls, lastAt: calls[0]?.at ?? null, total: calls.length };
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
          if (message.spec) hub.setSpec(socket, toSocketSpec(message.spec));
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

/**
 * The socket carries a ViewSpec object; the query string carries flat, shorter
 * keys. They are two wire formats for one type, so they get two readers rather
 * than one that guesses — reading a spec object with the query-string reader
 * looked for `changed` and `edges` at the top level, found neither, and handed
 * back the default filter. Every live push then silently widened the diagram
 * back to the whole scope while the URL and the "filtered" chip still said it
 * was narrowed.
 */
function toSocketSpec(raw: Record<string, unknown>): ViewSpec {
  const filter = isRecord(raw['filter']) ? raw['filter'] : {};
  const edges = readMembers(filter['edgeKinds'], EDGE_KINDS);
  const since = filter['sinceMs'];

  return {
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : '',
    focus: typeof raw['focus'] === 'string' && raw['focus'] !== '' ? raw['focus'] : null,
    depth: readDepth(raw['depth']),
    filter: {
      hidePath: typeof filter['hidePath'] === 'string' ? filter['hidePath'] : '',
      onlyPath: typeof filter['onlyPath'] === 'string' ? filter['onlyPath'] : '',
      kinds: readMembers(filter['kinds'], NODE_KINDS),
      edgeKinds: edges.length > 0 ? edges : DEFAULT_EDGE_KINDS,
      sinceMs: typeof since === 'number' && Number.isFinite(since) && since > 0 ? since : 0,
      onlyChanged: filter['onlyChanged'] === true,
    },
  };
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** The socket sends the kind lists as arrays, where a query string sends CSV. */
function readMembers<T extends string>(raw: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(raw)) return [];
  const wanted = new Set(raw.filter((value): value is string => typeof value === 'string'));
  return allowed.filter((value) => wanted.has(value));
}

const NODE_KINDS = ['class', 'function', 'interface', 'type', 'method'] as const;
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
    // A flag and nothing more: which base it compares against belongs to the
    // session, so a URL cannot narrow the view to a base nobody is looking at.
    onlyChanged: raw['changed'] === '1',
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

/** The wire shape of a group edit. Every field is user input. */
interface GroupAction {
  action?: unknown;
  id?: unknown;
  name?: unknown;
  files?: unknown;
  color?: unknown;
  padding?: unknown;
  geometry?: unknown;
  locked?: unknown;
}

/**
 * One body, three verbs, and one place that decides what each of them means.
 * The helpers in `groups.ts` are pure and throw on anything they will not
 * store, so all that is left here is turning an unknown body into what they
 * take — and a throw is a 400 either way.
 */
function applyGroupAction(stored: readonly NamedGroup[], body: GroupAction): NamedGroup[] {
  const color = readColor(body.color);

  switch (body.action) {
    case 'create':
      return createManualGroup(stored, {
        name: typeof body.name === 'string' ? body.name : '',
        files: readStrings(body.files),
        ...(color === undefined ? {} : { color }),
      });

    case 'update': {
      const name = typeof body.name === 'string' ? body.name.trim() : undefined;
      // A rename to nothing leaves a frame with no label and no way to say which
      // one to rename back.
      if (name === '') throw new Error('a group needs a name');
      const padding = readPadding(body.padding);
      const geometry = readGeometry(body.geometry);
      if (body.locked !== undefined && typeof body.locked !== 'boolean') {
        throw new Error('locked must be a boolean');
      }
      const files = body.files === undefined ? undefined : readStrings(body.files);

      return updateGroup(stored, readId(body.id), {
        ...(name === undefined ? {} : { name }),
        ...(color === undefined ? {} : { color }),
        ...(padding === undefined ? {} : { padding }),
        ...(geometry === undefined ? {} : { geometry }),
        ...(body.locked === undefined ? {} : { locked: body.locked as boolean }),
        ...(files === undefined ? {} : { files }),
      });
    }

    case 'delete':
      return deleteGroup(stored, readId(body.id));

    default:
      throw new Error("action must be 'create', 'update' or 'delete'");
  }
}

function readId(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw new Error('id must be a non-empty string');
  return raw;
}

function readStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((value: unknown): value is string => typeof value === 'string');
}

/**
 * An unknown colour is refused rather than dropped: silently keeping the old one
 * looks to whoever asked like the request worked and the palette is broken.
 */
function readColor(raw: unknown): GroupColor | undefined {
  if (raw === undefined) return undefined;
  // A readonly GroupColor[] has no includes(string) overload, hence the widening.
  if (typeof raw !== 'string' || !(GROUP_COLORS as readonly string[]).includes(raw)) {
    throw new Error(`colour must be one of ${GROUP_COLORS.join(', ')}`);
  }
  return raw as GroupColor;
}

/** A hand-placed frame, in graph coordinates. Same NaN trap as the padding. */
function readGeometry(
  raw: unknown,
): { x: number; y: number; width: number; height: number } | undefined {
  if (raw === undefined) return undefined;
  const { x, y, width, height } = (raw ?? {}) as Record<string, unknown>;
  const finite = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  if (!finite(x) || !finite(y) || !finite(width) || !finite(height)) {
    throw new Error('geometry must be { x, y, width, height } in graph units');
  }
  // A frame with no area cannot be grabbed again to undo it.
  if (width < 40 || height < 30) throw new Error('a frame needs some size to it');
  return { x, y, width, height };
}

function readPadding(raw: unknown): { x: number; y: number } | undefined {
  if (raw === undefined) return undefined;
  const { x, y } = (raw ?? {}) as { x?: unknown; y?: unknown };
  // NaN passes a typeof check and then poisons every frame the layout draws.
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('padding must be { x, y } in pixels');
  }
  return { x, y };
}

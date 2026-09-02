import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Graph, GraphNode } from '../graph/types.js';
import type { Session } from './session.js';
import { LANGUAGES } from '../lang/registry.js';
import {
  fingerprintOf,
  relationsFingerprint,
  type ExplainTarget,
  type Explanation,
} from '../project/explain.js';
import {
  fetchRemote,
  readLog,
  readRemote,
  type Commit,
  type RemoteStatus,
  readBranch,
} from '../project/git.js';
import { changeFromHook, type HookPayload } from '../project/hook.js';
import { portFilePath } from '../project/port-file.js';
import { isIgnoredDirectoryName } from '../project/walk.js';
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
import { installHook, readHookStatus, type HookStatus } from '../project/hook-install.js';
import { describe, describeSymbol, type FileDetail, type SymbolLinks } from '../view/detail.js';
import {
  DEFAULT_EDGE_KINDS,
  parseDuration,
  type ViewFilter,
} from '../view/filter.js';
import { clusterFiles, identify } from '../view/cluster.js';
import { search } from '../view/search.js';
import { projectLanguages, selectView } from '../view/select.js';
import type { LanguageCount, ViewSpec } from '../view/types.js';
import type { LiveHub } from './live.js';
import type { ExplainRun, SessionHost } from './session.js';

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

/**
 * Program text no language here can read.
 *
 * Curated, rather than "every extension nothing claims": a repository is full of
 * JSON, Markdown, lockfiles and images, and counting those as unread would bury
 * the one line that matters under noise nobody expected a diagram of. Every
 * entry below is unambiguously source, so a hit means a real part of the project
 * is missing from the graph — which is the failure this whole thing exists to
 * stop happening in silence. Extend it when a language is worth naming.
 */
const UNREADABLE_EXTENSIONS = new Set([
  '.vue', '.svelte', '.astro',
  '.py', '.rb', '.php', '.lua',
  '.c', '.h', '.cc', '.cpp', '.hpp',
  '.swift', '.kt', '.scala', '.dart',
  '.ex', '.hs', '.elm', '.zig',
]);

/**
 * How a stored explanation stands to the code it describes.
 *
 * Two grades of "out of date" because they mean opposite things to a reader:
 * only `stale` should stop you trusting the words. `none` is the vocabulary's
 * fourth answer and is never sent — an id with nothing stored has no entry, and
 * the panel calls that none.
 */
export type ExplainState = 'none' | 'current' | 'drifted' | 'stale' | 'orphaned' | 'unknown';

export interface ExplainedEntry extends Explanation {
  state: ExplainState;
}

/**
 * The most of one target worth reading off disk. A 2000-line file is not a
 * question, it is a bill.
 *
 * The cut is announced inside the text, because this string is both what the
 * model is shown and what the fingerprint is taken over — a fingerprint of the
 * whole file compared against an excerpt would read as stale for ever.
 * `explain.ts` clips again, tighter, for the prompt itself; the effect is that a
 * change past its cut still shows here as stale, which errs towards re-reading
 * rather than towards trusting words nobody checked.
 */
const MAX_SOURCE_LINES = 400;
const MAX_SOURCE_CHARS = 24_000;

/**
 * Relations per direction, and capped per direction: fifty callers must not
 * push out everything the symbol uses, which is the half that says what it is
 * for rather than who wanted it.
 */
const MAX_CONTEXT = 20;

/**
 * The most log a page can ask for at once. The graph is drawn one row per
 * commit, and a thousand rows is taller than anyone scrolls; past that, the
 * question is a search, not a list.
 */
const MAX_LOG = 1000;

/** What `git log` answers, plus which commit is checked out. */
export interface LogResponse {
  commits: Commit[];
  /**
   * The sha HEAD is at, so the page can select its row when nothing is frozen.
   * '' when no commit in the log is decorated HEAD — a repository with no
   * commits, or one whose HEAD lies further back than the log was asked for.
   */
  head: string;
  /**
   * The branch checked out, or null when HEAD is detached. From git, not from
   * the decorations: `%D` spells a detached HEAD sitting on a branch tip the
   * same way it spells the branch once the arrow is split, so the refs alone
   * cannot say which one the row's target badge belongs to.
   */
  branch: string | null;
}

/**
 * Everything the Repository panel shows, in one answer. Composed here from
 * what already exists rather than fetched as four requests, because the panel
 * is a single thing on screen and the parts arriving at four different moments
 * would draw it four times.
 */
export interface RepoInfo {
  /** The repository's own name: the last segment of the root. */
  name: string;
  root: string;
  /** Source files the graph holds. */
  files: number;
  /** null when the project is not a repository, or has no remote. */
  remote: RemoteStatus | null;
  hook: HookStatus;
  /** Where the hook finds this server; written only while `.claude/` exists. */
  portFile: string;
  agent: { lastAt: number | null; total: number };
  languages: {
    /** What the project is written in, biggest first. */
    found: LanguageCount[];
    /** Source the tool cannot read, biggest first. */
    unreadable: { extension: string; files: number }[];
  };
}

export interface FetchResponse {
  ok: boolean;
  detail: string;
  /** Re-read after the fetch, so ahead/behind describe what just arrived. */
  remote: RemoteStatus | null;
}

export interface AppOptions {
  /** Holds the current project. Routes read through it, never around it. */
  host: SessionHost;
  hub: LiveHub;
  /**
   * Called whenever the project changes, or gains a .claude directory, so the
   * port file can follow it. The hook reads that file to find this server.
   */
  onProjectChanged: (root: string) => Promise<void>;
  /**
   * An explain run ended, a minute or more after the request that started it.
   * The graph did not change, so this belongs on the socket as its own message
   * — the same reason `agentActed` is one — and the hub is outside this change,
   * so it arrives as a callback. Unwired, the page learns the outcome from its
   * next GET /api/explain instead of being told.
   */
  onExplainRun?: (run: ExplainRun) => void;
  /** A few characters of an answer, as it is being written. */
  onExplainDelta?: (text: string) => void;
}

export function buildApp({ host, hub, onProjectChanged, onExplainRun, onExplainDelta }: AppOptions): FastifyInstance {
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

  app.get('/api/view', async (request, reply) => {
    const session = host.current();
    const spec = toSpec(request.query as Record<string, unknown>);

    if (spec.at === null) {
      return {
        root: session.root,
        // The cutoff for "changed recently" is computed per request, so a stored
        // spec does not freeze time at the moment it was set.
        view: selectView(session.store.graph, spec, Date.now(), session.gitStatus()),
      };
    }

    // A commit that cannot be drawn is a 404 and never the live graph: a page
    // showing now under a banner naming a commit is exactly the wrong picture
    // that looks authoritative, and the one thing this feature must not do.
    if (!isCommitId(spec.at)) {
      return reply.code(404).send({ error: `not a commit id: ${spec.at}` });
    }
    const graph = await session.graphAt(spec.at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${spec.at}` });

    // No git status: a past commit has no working tree to differ from a base.
    return { root: session.root, view: selectView(graph, spec, Date.now(), null) };
  });

  app.get('/api/project', async () => ({ root: host.current().root }));

  /**
   * What the tool reads, and what this project holds that it cannot.
   *
   * The breakdown of what *was* parsed rides on every ViewGraph, because it
   * changes whenever the graph does. This is the other half, and it changes only
   * when the project does: which languages exist at all, and how many files were
   * never offered to one. Walked on request rather than remembered from the boot
   * scan because the scan discards these before anyone counts them — and an
   * answer computed now cannot claim a file the agent has since added is absent.
   */
  app.get('/api/languages', async () => ({
    reads: LANGUAGES.map((language) => language.label),
    unreadable: await countUnreadable(host.current().root),
  }));

  app.get('/api/detail', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const target = typeof query['path'] === 'string' ? query['path'] : '';
    const at = readAt(query['at']);
    const graph = await graphFor(host.current(), at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    const detail = describe(graph, target);
    if (!detail) return reply.code(404).send({ error: `nothing known about ${target}` });
    return detail;
  });

  // One symbol's relations. Separate from /api/detail because that answers about
  // a box and this answers about a row inside one, and a caller wants exactly one
  // of the two.
  app.get('/api/symbol', async (request, reply) => {
    const query = request.query as Record<string, unknown>;
    const id = typeof query['id'] === 'string' ? query['id'] : '';
    const at = readAt(query['at']);
    const graph = await graphFor(host.current(), at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    const links = describeSymbol(graph, id);
    if (!links) return reply.code(404).send({ error: `no symbol ${id}` });
    return links;
  });

  /**
   * What has been explained, for the ids the panel is showing.
   *
   * It takes ids on purpose. `state` is computed by re-reading each described
   * file off disk, so an unfiltered answer would read every explained file in
   * the project on every render of a panel showing four. With no ids it is the
   * cheap poll instead: how many exist, and what the run is doing.
   */
  app.get('/api/explain', async (request) => {
    const session = host.current();
    const query = request.query as Record<string, unknown>;
    const wanted = new Set(readCsv(query['ids']));
    const stored = session.explanations();

    return {
      explanations: await Promise.all(
        stored
          .filter((entry) => wanted.has(entry.id))
          .map(async (entry) => explained(session.store.graph, session.root, entry)),
      ),
      total: stored.length,
      run: session.explainRun(),
    };
  });

  /**
   * Spend the user's quota, stop spending it, or throw an answer away.
   *
   * `run` answers 202 and not a byte of the explanation: the subprocess takes a
   * minute or more, which is longer than a browser will hold a fetch open, and
   * a fetch that dies leaves the run with nobody waiting for it. The answer
   * arrives on the socket, and is readable from the GET above either way.
   */
  app.post('/api/explain', async (request, reply) => {
    const session = host.current();
    const body = (request.body ?? {}) as { action?: unknown; ids?: unknown; id?: unknown };

    if (body.action === 'cancel') {
      return { cancelled: session.cancelExplain(), run: session.explainRun() };
    }

    if (body.action === 'forget') {
      const id = typeof body.id === 'string' ? body.id : '';
      if (id === '') return reply.code(400).send({ error: 'id must be a non-empty string' });
      // An explanation can simply be wrong, and hand-editing a committed file is
      // not an answer to that.
      return { forgotten: await session.forgetExplanation(id) };
    }

    if (body.action !== 'run') {
      return reply.code(400).send({ error: "action must be 'run', 'cancel' or 'forget'" });
    }

    const targets: ExplainTarget[] = [];
    for (const id of readStrings(body.ids)) {
      const target = await resolveTarget(session.store.graph, session.root, id);
      if (target) targets.push(target);
    }
    // Not a failed run — nothing was asked. A run that produces no answers is
    // reported as a run; a request naming ids the graph has never heard of is a
    // bad request, and telling them apart is what stops a spinner starting.
    if (targets.length === 0) {
      return reply.code(400).send({ error: 'none of those ids are in the graph' });
    }

    const run = session.startExplain(
      targets,
      (ended) => onExplainRun?.(ended),
      (text) => onExplainDelta?.(text),
    );
    if (!run) {
      return reply.code(409).send({ error: 'a run is already in flight', run: session.explainRun() });
    }
    return reply.code(202).send({ run });
  });

  app.get('/api/search', async (request) => {
    const query = request.query as Record<string, unknown>;
    const term = typeof query['q'] === 'string' ? query['q'] : '';
    return { hits: search(host.current().store.graph, term) };
  });

  app.get('/api/clusters', async (request, reply) => {
    const session = host.current();
    const at = readAt((request.query as Record<string, unknown>)['at']);
    // The graph decides membership; the stored file only supplies names. At a
    // commit it is that commit's graph: a frame on a diagram of last week has
    // to be what last week's imports produced, or it is a tidy lie.
    const graph = await graphFor(session, at);
    if (graph === null) return reply.code(404).send({ error: `unknown commit ${at}` });
    return { clusters: mergeGroups(clusterFiles(graph), await readGroups(session.root)) };
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

  app.get('/api/log', async (request): Promise<LogResponse> => {
    const query = request.query as Record<string, unknown>;
    const limit = readLimit(query['limit']);
    const root = host.current().root;
    const [commits, branch] = await Promise.all([readLog(root, limit ?? undefined), readBranch(root)]);
    return { commits, head: headOf(commits), branch };
  });

  app.get('/api/repo', async (): Promise<RepoInfo> => {
    const session = host.current();
    const root = session.root;
    const [remote, hook, unreadable] = await Promise.all([
      readRemote(root),
      readHookStatus(root),
      countUnreadable(root),
    ]);
    const calls = session.agentCalls();

    return {
      name: path.basename(root),
      root,
      files: session.store.files.size,
      remote,
      hook,
      portFile: portFilePath(root),
      agent: { lastAt: calls[calls.length - 1]?.at ?? null, total: calls.length },
      languages: { found: projectLanguages(session.store.graph), unreadable },
    };
  });

  // The one thing here that talks to a remote, and the only git verb that is
  // not a read. It touches no working tree — an agent may be editing it.
  app.post('/api/fetch', async (): Promise<FetchResponse> => {
    const root = host.current().root;
    const fetched = await fetchRemote(root);
    return { ...fetched, remote: await readRemote(root) };
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

/**
 * Count the source files no language claims, biggest extension first.
 *
 * The same walk `findSourceFiles` does and the same directories it ignores, over
 * the complement of the same question — which is why it belongs beside that walk
 * rather than here, and would cost nothing if the scan counted these on its way
 * past. A directory it cannot read is skipped rather than fatal: an unreadable
 * corner of the tree must not take down the answer for the rest of it.
 */
async function countUnreadable(root: string): Promise<{ extension: string; files: number }[]> {
  const counted = new Map<string, number>();

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!isIgnoredDirectoryName(entry.name)) await visit(path.join(directory, entry.name));
        continue;
      }
      const name = entry.name.toLowerCase();
      const extension = name.slice(name.lastIndexOf('.'));
      if (UNREADABLE_EXTENSIONS.has(extension)) {
        counted.set(extension, (counted.get(extension) ?? 0) + 1);
      }
    }
  }

  await visit(root);

  return [...counted]
    .map(([extension, files]) => ({ extension, files }))
    .sort((a, b) => b.files - a.files || a.extension.localeCompare(b.extension));
}

/**
 * One id — a file path or a symbol id — as something worth sending to a model.
 *
 * The source is read from disk rather than carried on the graph, which holds
 * line ranges and no text. Re-reading is also what makes the fingerprint
 * describe the code as it is at the moment of the run.
 */
async function resolveTarget(
  graph: Graph,
  root: string,
  id: string,
): Promise<ExplainTarget | null> {
  const node = graph.nodes.get(id);
  if (!node) return null;

  const source = await readSource(root, node);
  if (source === null) return null;

  const shared = { id, name: node.name, filePath: node.filePath, source };

  if (node.kind === 'file') {
    const detail = describe(graph, node.filePath);
    return {
      ...shared,
      kind: 'file',
      context: detail?.kind === 'file' ? fileContext(detail) : [],
      // The same list explainState will recompute later, so the two agree.
      related: relatedFilesOf(graph, id),
    };
  }

  const links = describeSymbol(graph, id);
  return {
    ...shared,
    kind: 'symbol',
    context: links ? symbolContext(links) : [],
    related: relatedFilesOf(graph, id),
  };
}

/** One stored explanation, told how it now stands to the code it describes. */
async function explained(
  graph: Graph,
  root: string,
  entry: Explanation,
): Promise<ExplainedEntry> {
  return { ...entry, state: await explainState(graph, root, entry) };
}

async function explainState(
  graph: Graph,
  root: string,
  entry: Explanation,
): Promise<ExplainState> {
  const node = graph.nodes.get(entry.id);
  if (!node) return 'orphaned';

  const source = await readSource(root, node);
  // In the graph and not on disk: a delete the parser has not caught up with,
  // which is the same answer one re-parse early.
  if (source === null) return 'orphaned';

  const fresh = fingerprintOf(source);
  // Read the algorithm back rather than assume it. An entry written by a build
  // that hashed differently cannot be compared with this one's, and saying so is
  // the whole difference between 'unknown' and reporting every old entry stale.
  if (algorithmOf(fresh) !== algorithmOf(entry.fingerprint)) return 'unknown';
  if (fresh !== entry.fingerprint) return 'stale';

  return movedAround(graph, entry) ? 'drifted' : 'current';
}

/**
 * Whether the relations this explanation was written against have changed.
 *
 * Compared as a hash of the relations themselves, not as a timestamp. The first
 * attempt asked whether a related file's mtime was newer than `at`, which is
 * true of every file in a fresh clone — so a committed explanation read as
 * drifted for everyone except its author, defeating the reason it is committed.
 *
 * An entry written before relations were recorded has nothing to compare and is
 * left alone: claiming drift we cannot see is the same kind of lie as missing it.
 */
function movedAround(graph: Graph, entry: Explanation): boolean {
  if (entry.relations === undefined) return false;
  return relationsFingerprint(relatedFilesOf(graph, entry.id)) !== entry.relations;
}

function relatedFilesOf(graph: Graph, id: string): string[] {
  if (graph.nodes.get(id)?.kind === 'file') {
    const detail = describe(graph, id);
    return detail?.kind === 'file' ? [...detail.imports, ...detail.importedBy] : [];
  }
  const links = describeSymbol(graph, id);
  return links ? [...links.uses, ...links.usedBy].map((relation) => relation.filePath) : [];
}

/** The label before the colon in a fingerprint, or '' when there is none. */
function algorithmOf(fingerprint: string): string {
  const colon = fingerprint.indexOf(':');
  return colon === -1 ? '' : fingerprint.slice(0, colon);
}

async function readSource(root: string, node: GraphNode): Promise<string | null> {
  const raw = await readFile(path.join(root, node.filePath), 'utf8').catch(() => null);
  if (raw === null) return null;
  // Ranges are 1-based and inclusive, and a file node spans the whole file.
  return clip(raw.split('\n').slice(node.range.startLine - 1, node.range.endLine));
}

function clip(lines: readonly string[]): string {
  const kept = lines.slice(0, MAX_SOURCE_LINES).join('\n');
  const text = kept.slice(0, MAX_SOURCE_CHARS);
  if (text.length === kept.length && lines.length <= MAX_SOURCE_LINES) return text;
  return `${text}\n… truncated; the original is ${lines.length} lines`;
}

function symbolContext(links: SymbolLinks): string[] {
  return [
    ...links.usedBy.slice(0, MAX_CONTEXT).map((r) => `used by ${r.id} (${r.edge})`),
    ...links.uses.slice(0, MAX_CONTEXT).map((r) => `uses ${r.id} (${r.edge})`),
  ];
}

function fileContext(detail: FileDetail): string[] {
  return [
    ...detail.importedBy.slice(0, MAX_CONTEXT).map((from) => `used by ${from}`),
    ...detail.imports.slice(0, MAX_CONTEXT).map((to) => `uses ${to}`),
  ];
}

/** A comma-separated query parameter. No id in the graph contains a comma. */
function readCsv(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw === '') return [];
  return raw.split(',').filter((value) => value !== '');
}

/** Everything here is user input, from a query string or a socket frame. */
function toSpec(raw: Record<string, unknown>): ViewSpec {
  const focus = typeof raw['focus'] === 'string' && raw['focus'] !== '' ? raw['focus'] : null;
  return {
    scope: typeof raw['scope'] === 'string' ? raw['scope'] : '',
    focus,
    depth: readDepth(raw['depth']),
    filter: toFilter(raw),
    at: readAt(raw['at']),
  };
}

/**
 * Kept as given rather than checked here: an `at` that is not a commit must
 * reach the view route and be refused there, because turning it into null
 * would draw the working tree under a URL that names a commit.
 */
function readAt(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * Abbreviated or full, hex only. A ref name would reach `git archive` as an
 * argument, and a name is a moving target no cache keyed on it could be right
 * about after the next commit.
 */
function isCommitId(at: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(at);
}

/**
 * The graph a request is about: the live one, or a commit's when `at` names
 * one. Everything that describes the diagram — a box's detail, a symbol's
 * relations, the groups — goes through here, so a frozen diagram is never
 * described by the graph it is not showing. Null means the commit cannot be
 * drawn; the caller answers 404, never the live graph under a commit's name.
 */
async function graphFor(session: Session, at: string | null): Promise<Graph | null> {
  if (at === null) return session.store.graph;
  if (!isCommitId(at)) return null;
  return session.graphAt(at);
}

/** The count a page asked for, or null for the log's own default. */
function readLimit(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) return null;
  return Math.min(value, MAX_LOG);
}

/**
 * The commit HEAD decorates. `%D` writes `HEAD -> main` on a branch and a bare
 * `HEAD` when detached, so the token is looked for either way — the first
 * match is the one, because only one commit is ever HEAD.
 */
function headOf(commits: readonly Commit[]): string {
  const isHead = (ref: string): boolean => ref === 'HEAD' || ref.startsWith('HEAD ->');
  return commits.find((commit) => commit.refs.some(isHead))?.sha ?? '';
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
    at: readAt(raw['at']),
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

const NODE_KINDS = ['class', 'function', 'interface', 'type', 'method', 'field'] as const;
const EDGE_KINDS = ['imports', 'extends', 'implements', 'calls', 'associates'] as const;

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

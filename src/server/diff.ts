import type { FastifyInstance } from 'fastify';
import type { GitStatus } from '../git/types.js';
import { diffGraphs, type GraphDiff } from '../graph/diff.js';
import type { GraphStore } from '../graph/store.js';
import type { EdgeKind, Graph, GraphEdge, GraphNode, NodeKind } from '../graph/types.js';
import { resolveCommit } from '../project/git.js';

/**
 * What the route needs of a session: the live graph, the root and the base
 * to resolve `base` against, and the commit cache. Named here rather than as
 * `Session` so this module asks for exactly the four and `app.ts` can hand
 * it `host.current()`, the way the flow route is handed it.
 */
export interface DiffSession {
  readonly root: string;
  readonly store: GraphStore;
  gitStatus(): GitStatus | null;
  graphAt(sha: string): Promise<Graph | null>;
}

/** One end of a diff, as asked for and as it resolved. `sha` is null for the working tree. */
export interface DiffEnd {
  asked: string;
  sha: string | null;
}

export interface DiffEntry {
  id: string;
  name: string;
  kind: NodeKind;
  file: string;
  owner?: string;
}

export interface DiffEdgeEntry {
  from: string;
  to: string;
  kind: EdgeKind;
  guessed?: true;
}

/**
 * GET /api/diff?from=<sha|base>&to=<sha|live>
 *
 * The structural diff as lists and counts, for the panel and the Source
 * Control row; the canvas draws the same diff through `diffView`. Absent
 * `from` is `base`, absent `to` is `live`, so the bare route answers "what
 * has this session done to the shape".
 */
export interface DiffReply {
  from: DiffEnd;
  to: DiffEnd;
  counts: GraphDiff['counts'];
  added: DiffEntry[];
  removed: DiffEntry[];
  touched: DiffEntry[];
  addedEdges: DiffEdgeEntry[];
  removedEdges: DiffEdgeEntry[];
  /** What the ids cannot tell apart, in one sentence the panel prints beside the lists. */
  caveat: string;
}

/**
 * The one thing the diff reads off ids that ids do not promise. Sent with
 * every reply rather than only when a `~2` is in it: a swap of two overloads
 * shows up as edges moving and nothing in the lists says why.
 */
export const DIFF_CAVEAT =
  'Two symbols sharing a name in one file are told apart by document order (name, name~2), ' +
  'so removing or reordering one can read as the other removed and its edges moved.';

/**
 * The two graphs a diff is between, or why there are none.
 *
 * `base` is the session's git base as git resolved it — `HEAD`, `HEAD~1` or
 * the merge base — turned into a full sha *here*, before it reaches
 * `graphAt`: the session remembers every spelling it was asked for against
 * the sha it named at the time, which is right for a sha and wrong for
 * `HEAD`, which names a different commit after every commit. A commit is a
 * hex id, abbreviated or full, as `/api/view?at=` takes it; a ref name is
 * refused for the reason given there. Exported so the view route can draw
 * `?diff=` from the same pair this route lists, and cannot resolve `base`
 * differently.
 */
export async function resolveDiffEnds(
  session: DiffSession,
  from: string,
  to: string,
  // The keys the caller's URL spelled the two ends under, so a refusal names
  // the one that was written: `/api/view` reads them off `diff=` and `at=`,
  // and a 400 saying `from=` there sends the reader to a key it never used.
  keys: { from: string; to: string } = { from: 'from', to: 'to' },
): Promise<
  | { ok: true; before: Graph; after: Graph; from: DiffEnd; to: DiffEnd }
  | { ok: false; status: 400 | 404; error: string }
> {
  const before = await resolveEnd(session, from, 'from', keys.from);
  if (!before.ok) return before;
  const after = await resolveEnd(session, to, 'to', keys.to);
  if (!after.ok) return after;
  return { ok: true, before: before.graph, after: after.graph, from: before.end, to: after.end };
}

async function resolveEnd(
  session: DiffSession,
  asked: string,
  which: 'from' | 'to',
  key: string,
): Promise<{ ok: true; graph: Graph; end: DiffEnd } | { ok: false; status: 400 | 404; error: string }> {
  const spelled = asked.trim().toLowerCase();

  if (which === 'to' && (spelled === '' || spelled === 'live')) {
    return { ok: true, graph: session.store.graph, end: { asked: 'live', sha: null } };
  }

  let ref: string;
  if (which === 'from' && (spelled === '' || spelled === 'base')) {
    const status = session.gitStatus();
    if (status === null) return { ok: false, status: 404, error: 'base names no commit: this project is not a git work tree' };
    ref = status.base;
  } else if (isCommitId(spelled)) {
    ref = spelled;
  } else {
    const takes = which === 'from' ? 'base or a commit id' : 'live or a commit id';
    return { ok: false, status: 400, error: `${key}= takes ${takes} — not ${asked}` };
  }

  const sha = await resolveCommit(session.root, ref);
  if (sha === null) return { ok: false, status: 404, error: `unknown commit ${ref}` };
  const graph = await session.graphAt(sha);
  if (graph === null) return { ok: false, status: 404, error: `unknown commit ${ref}` };
  return { ok: true, graph, end: { asked: spelled === '' ? (which === 'from' ? 'base' : 'live') : spelled, sha } };
}

/** Abbreviated or full, hex only — the same rule `/api/view?at=` applies. */
function isCommitId(at: string): boolean {
  return /^[0-9a-f]{4,40}$/.test(at);
}

/**
 * Registered by `app.ts` beside the flow route. 400 for an end spelled as
 * something neither reader takes, 404 for a commit the repository has not
 * got — never a diff against the live graph under the name of a commit that
 * could not be built, for the reason `/api/view?at=` never draws it.
 */
export function registerDiffRoute(app: FastifyInstance, current: () => DiffSession): void {
  app.get('/api/diff', async (request, reply): Promise<DiffReply | { error: string }> => {
    const query = request.query as Record<string, unknown>;
    const from = typeof query['from'] === 'string' ? query['from'] : '';
    const to = typeof query['to'] === 'string' ? query['to'] : '';

    const ends = await resolveDiffEnds(current(), from, to);
    if (!ends.ok) return reply.code(ends.status).send({ error: ends.error });

    const diff = diffGraphs(ends.before, ends.after);
    return {
      from: ends.from,
      to: ends.to,
      counts: diff.counts,
      added: diff.added.map(entry),
      removed: diff.removed.map(entry),
      touched: diff.touched.map(entry),
      addedEdges: diff.addedEdges.map(edgeEntry),
      removedEdges: diff.removedEdges.map(edgeEntry),
      caveat: DIFF_CAVEAT,
    };
  });
}

function entry(node: GraphNode): DiffEntry {
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    file: node.filePath,
    ...(node.owner === undefined ? {} : { owner: node.owner }),
  };
}

function edgeEntry(edge: GraphEdge): DiffEdgeEntry {
  return {
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    ...(edge.guessed === true ? { guessed: true as const } : {}),
  };
}

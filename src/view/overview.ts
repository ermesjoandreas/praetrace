import type { GitFileStatus, GitStatus } from '../git/types.js';
import type { Graph } from '../graph/types.js';
import type { EntryPoint, ProjectFacts } from '../lang/types.js';
import { projectLanguages } from './select.js';
import { isTestFile } from './tests.js';
import type { LanguageCount } from './types.js';

/**
 * The front page: what a person asks first, answered as a list and not a
 * diagram.
 *
 * A map of everything never works. astrupdata's root is twelve boxes and
 * fine; one level in, `lib` is 106 boxes and 427 edges laid out as a strip
 * zoomed to a smear, and the clustering's answer — "Terminal App, 254 files,
 * 98%" — is the algorithm saying everything imports everything, which is true
 * and worthless. Sourcetrail's answer after years of trying is the one taken
 * here: never land in the big graph. Land on what the project is, where it
 * starts, what it is made of, what changed, and what the agent is doing — and
 * make every line a link into the one view that does work, a symbol and its
 * neighbours. A number that leads nowhere is furniture.
 *
 * Pure. Everything here is read off the graph, the facts the scan gathered,
 * the merged groups, the git status and the agent's calls; the one thing the
 * graph cannot know — what is on disk that no language reads — is handed in.
 */

/** How many roots the front page lists; the total says how many there are. */
export const MAX_ROOTS = 12;
/** How many changed files are named; the total and the counts say the rest. */
export const MAX_CHANGES_SHOWN = 8;

/** What the graph says about a file nothing reaches. */
export const ROOT_WHY = 'nothing imports it';
/** A file only a test reaches: an entry point, or dead code with a test. The graph cannot say which. */
export const TEST_ONLY_WHY = 'only tests import it';

/** A source file no other source file imports. */
export interface Root extends EntryPoint {
  /** Distinct files it imports. Most-importing first is what makes a root read as a start. */
  imports: number;
}

/**
 * The slice of a merged group the overview reads. Spelled here rather than
 * imported from project/groups.ts so the view layer stays pure; the server
 * hands in `MergedGroups`, which satisfies it.
 */
export interface CategoryInput {
  id: string;
  storedId?: string;
  name: string | null;
  state: 'suggested' | 'accepted' | 'rejected';
  files: readonly string[];
  cohesion: number;
  depth: number;
  origin?: 'manual';
}

export interface CategoriesInput {
  clusters: readonly CategoryInput[];
  orphans: readonly { storedId: string; name: string; files: readonly string[] }[];
}

/** One thing the agent asked, in the shape server/session.ts records it. */
export interface AgentCallInput {
  at: number;
  tool: string;
  target: string | null;
  note?: string;
  files?: string[];
}

export interface UnreadableCount {
  extension: string;
  files: number;
}

export interface NamedCategory {
  /** The id a category is addressed by — `?category=<storedId>` — never the cluster's, which embeds its size. */
  storedId: string;
  name: string;
  files: number;
  /** Null for a drawn category: it has no cohesion to report, only "by hand". */
  cohesion: number | null;
  /** 0 for an outer category, 1 for one found inside it. */
  depth: number;
  origin?: 'manual';
}

export interface ChangedFile {
  file: string;
  status: GitFileStatus;
  /** Whether a focus view has somewhere to go. A changed README is a change and not a box. */
  inGraph: boolean;
}

export interface Overview {
  project: {
    files: number;
    /** Of those, tests by path — see view/tests.ts. */
    tests: number;
    /** Files tree-sitter recovered a syntax error in; each lost something. */
    parseErrors: number;
    languages: LanguageCount[];
    /** What no language reads, biggest kind first. */
    unreadable: UnreadableCount[];
  };
  entryPoints: {
    /** What the manifests and the framework conventions name, and why — every one a file the graph holds now. */
    manifest: EntryPoint[];
    /** Source files no other source imports and no manifest named, most-importing first, the first MAX_ROOTS. */
    roots: Root[];
    rootsTotal: number;
  };
  categories: {
    named: NamedCategory[];
    /** Clusters the graph found that nobody has named. Rejected ones are not counted: a rejection is a decision. */
    unnamed: number;
    /** Stored names that match nothing any more. */
    orphans: number;
  };
  /** Null when the project is not a git work tree. */
  changes: {
    base: string;
    requested: string;
    branch: string | null;
    total: number;
    byStatus: Record<GitFileStatus, number>;
    lines: { added: number; deleted: number };
    /** The first MAX_CHANGES_SHOWN, files the graph holds first, then by path. */
    files: ChangedFile[];
  } | null;
  agent: {
    total: number;
    lastAt: number | null;
    last: AgentCallInput | null;
    /** The most recent call that carried the agent's own words; the last call is often a lookup and the note is what it was for. */
    lastNote: AgentCallInput | null;
  };
}

export function overviewOf(
  graph: Graph,
  facts: ProjectFacts,
  categories: CategoriesInput,
  git: GitStatus | null,
  agent: readonly AgentCallInput[],
  unreadable: readonly UnreadableCount[],
): Overview {
  const files = [...graph.nodes.values()].filter((node) => node.kind === 'file');

  // Absent means not gathered — a fixture, a store before its scan — and the
  // graph is what is true now: a page deleted since boot is not a link.
  const manifest = (facts.entryPoints ?? []).filter((entry) => graph.nodes.get(entry.file)?.kind === 'file');

  return {
    project: {
      files: files.length,
      tests: files.filter((node) => isTestFile(node.filePath)).length,
      parseErrors: files.filter((node) => node.parseError === true).length,
      languages: projectLanguages(graph),
      unreadable: [...unreadable],
    },
    entryPoints: {
      manifest,
      ...rootsOf(graph, new Set(manifest.map((entry) => entry.file))),
    },
    categories: categoriesOf(categories),
    changes: changesOf(graph, git),
    agent: agentOf(agent),
  };
}

/**
 * Declaration files declare and never run. `next-env.d.ts` is imported by
 * nothing and is not where anything starts.
 */
function isDeclaration(filePath: string): boolean {
  return /\.d\.[cm]?ts$/.test(filePath);
}

/**
 * The graph's own roots: source files no other source file reaches.
 *
 * Tests do not vote, as in the clustering. A file only its test imports is a
 * root of the program even though the graph holds an edge into it, and it is
 * listed with a different reason so the two are never confused: the first is
 * a start or dead code, the second is dead code with a test — or a start
 * that only a test exercises. `contains` is not reaching; every other kind
 * is, so a file whose only inbound edge is a `calls` from another file is
 * reached.
 *
 * Ranked by how many distinct files each imports, because a root that pulls
 * in twenty files reads as a program and one that pulls in none reads as a
 * config file — which is what the bottom of the list is, and honestly so.
 */
function rootsOf(graph: Graph, named: ReadonlySet<string>): { roots: Root[]; rootsTotal: number } {
  const reachedBySource = new Set<string>();
  const reachedByTest = new Set<string>();
  const imported = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (edge.kind === 'contains') continue;
    const from = graph.nodes.get(edge.from)?.filePath;
    const to = graph.nodes.get(edge.to)?.filePath;
    if (from === undefined || to === undefined || from === to) continue;

    (isTestFile(from) ? reachedByTest : reachedBySource).add(to);
    if (edge.kind === 'imports') {
      const targets = imported.get(from) ?? new Set<string>();
      targets.add(to);
      imported.set(from, targets);
    }
  }

  const roots: Root[] = [];
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file' || reachedBySource.has(node.filePath)) continue;
    if (named.has(node.filePath) || isTestFile(node.filePath) || isDeclaration(node.filePath)) continue;
    roots.push({
      file: node.filePath,
      why: reachedByTest.has(node.filePath) ? TEST_ONLY_WHY : ROOT_WHY,
      imports: imported.get(node.filePath)?.size ?? 0,
    });
  }
  roots.sort((a, b) => b.imports - a.imports || a.file.localeCompare(b.file));

  return { roots: roots.slice(0, MAX_ROOTS), rootsTotal: roots.length };
}

/**
 * Every accepted name, in the order the merge lists them — outer before
 * nested, larger before smaller — so the front page and the Categories
 * section agree. A name without a `storedId` cannot be linked to, and there
 * is none: a group written before ids existed is given one on read.
 */
function categoriesOf(categories: CategoriesInput): Overview['categories'] {
  const named: NamedCategory[] = [];
  let unnamed = 0;
  for (const cluster of categories.clusters) {
    if (cluster.state === 'suggested') {
      unnamed += 1;
      continue;
    }
    if (cluster.state !== 'accepted' || cluster.name === null || cluster.storedId === undefined) continue;
    named.push({
      storedId: cluster.storedId,
      name: cluster.name,
      files: cluster.files.length,
      cohesion: cluster.origin === 'manual' ? null : cluster.cohesion,
      depth: cluster.depth,
      ...(cluster.origin === undefined ? {} : { origin: cluster.origin }),
    });
  }
  return { named, unnamed, orphans: categories.orphans.length };
}

function changesOf(graph: Graph, git: GitStatus | null): Overview['changes'] {
  if (git === null) return null;

  const byStatus: Record<GitFileStatus, number> = { modified: 0, added: 0, deleted: 0, untracked: 0, renamed: 0 };
  const files: ChangedFile[] = [];
  for (const [file, status] of Object.entries(git.files)) {
    byStatus[status] += 1;
    files.push({ file, status, inGraph: graph.nodes.get(file)?.kind === 'file' });
  }
  files.sort((a, b) => Number(b.inGraph) - Number(a.inGraph) || a.file.localeCompare(b.file));

  return {
    base: git.base,
    requested: git.requested,
    branch: git.branch,
    total: files.length,
    byStatus,
    lines: { ...git.totals },
    files: files.slice(0, MAX_CHANGES_SHOWN),
  };
}

function agentOf(calls: readonly AgentCallInput[]): Overview['agent'] {
  const last = calls[calls.length - 1] ?? null;
  let lastNote: AgentCallInput | null = null;
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const call = calls[index];
    if (call?.note !== undefined) {
      lastNote = call;
      break;
    }
  }
  return { total: calls.length, lastAt: last?.at ?? null, last, lastNote };
}

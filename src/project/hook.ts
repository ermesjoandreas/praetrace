import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { REACHES } from '../graph/edges.js';
import type { Graph } from '../graph/types.js';
// A type, so nothing of the file `groups.ts` reads comes with it. The rows are
// the ones `/api/clusters` answers with, because a category the hook names has
// to be the category the page draws — see `categoryOf`.
import type { GroupSuggestion } from './groups.js';
import { isIgnoredDirectoryName, isSourceFileName } from './walk.js';
import type { FileChange } from './watch.js';

/**
 * The part of a Claude Code `PostToolUse` payload this cares about. Write, Edit
 * and MultiEdit all name their target the same way; MultiEdit's `edits` array
 * describes changes within that one file, so the path alone is enough.
 *
 * The identifying half was read out of the installed CLI (2.1.263) rather than
 * remembered: it builds every hook payload from `session_id`, `transcript_path`,
 * `cwd`, `permission_mode`, `agent_id`, `agent_type` and `effort`, and the
 * PostToolUse one adds `hook_event_name`, `tool_name`, `tool_input`,
 * `tool_response`, `tool_use_id` and `duration_ms`. There is no field in it that
 * names the product, which is the fact the whole of `attributionOf` turns on.
 */
export interface HookPayload {
  tool_name?: unknown;
  tool_input?: { file_path?: unknown } | undefined;
  /** Claude Code's envelope — the evidence, not a name. See `attributionOf`. */
  hook_event_name?: unknown;
  session_id?: unknown;
  /** The subagent inside the session, when a Task was what wrote the file. */
  agent_type?: unknown;
  /**
   * The one field this endpoint adds to Claude Code's shape, so that a tool
   * that is not Claude Code can say what it is. See `docs/AGENTS.md`.
   */
  agent?: unknown;
}

/**
 * Who wrote a file, when anything said so.
 *
 * The absence of this is the model's word for "nobody said" — there is
 * deliberately no `{ agent: 'unknown' }` for a renderer to print by accident.
 * A change the watcher noticed carries none of these and never can: a file that
 * changed on disk looks identical whether Cursor, a build script or a person in
 * an editor wrote it, and inventing a name from the path, the clock or the
 * shape of a burst is exactly the authoritative-wrong output this project
 * refuses.
 */
export interface Attribution {
  /** What to call it on screen. */
  agent: string;
  /**
   * How we came to that name, kept so the page can be as careful as the
   * evidence is.
   *
   * `declared` — the caller put its own name in the request body. It is a
   * claim, and the model says so rather than laundering it into a fact.
   * `recognised` — nobody named anything, and the payload is Claude Code's own
   * PostToolUse envelope. That is evidence and not a guess: the envelope is a
   * wire format Claude Code defines, and it arrives because Claude Code ran a
   * command out of its own settings file. It is the same standing as the MCP
   * proxy's `x-codemap-tool` header, which is also only ever a caller
   * describing itself.
   */
  how: 'declared' | 'recognised';
  /** Which tool wrote it — Write, Edit, MultiEdit — when the payload said. */
  tool: string | null;
  /** The subagent inside that agent, when there was one. */
  subagent: string | null;
  /** Which run of that agent, so two working at once can be told apart. */
  session: string | null;
}

/** The name given to a payload wearing Claude Code's envelope and no other name. */
const CLAUDE_CODE = 'Claude Code';

/** A name is a name. Past this it is a paragraph wearing a row's clothes. */
const MAX_AGENT_NAME = 40;

/**
 * What the payload says about who sent it, or null when it says nothing.
 *
 * Two doors, and the order between them is the point. A caller that named
 * itself is taken at its word, because the alternative is worse: the route
 * already believes the caller about *which file changed*, and anything that can
 * make us re-parse a file can already put whatever it likes in the feed. A name
 * is strictly less powerful than that, so refusing one on trust grounds while
 * accepting a path would be incoherent. What it must never be is *inferred* —
 * the rule is not "distrust the caller", it is "never invent" — so a claim is
 * recorded as a claim.
 *
 * Only then, and only for a payload that named nothing, is Claude Code's
 * envelope read as Claude Code. Both `hook_event_name` and `session_id` are
 * required rather than either alone: one field is a shape another tool could
 * arrive at by accident, and the cost of getting this wrong is this tool
 * printing the wrong product's name over somebody's work.
 */
export function attributionOf(payload: HookPayload): Attribution | null {
  const tool = text(payload.tool_name);
  const session = text(payload.session_id);
  const subagent = text(payload.agent_type);

  const declared = text(payload.agent);
  if (declared !== null) {
    return { agent: declared.slice(0, MAX_AGENT_NAME), how: 'declared', tool, subagent, session };
  }

  if (text(payload.hook_event_name) === null || session === null) return null;
  return { agent: CLAUDE_CODE, how: 'recognised', tool, subagent, session };
}

/** A non-empty string, trimmed, or null — the only shape anything here reads. */
function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The primary event source: the agent tells us directly, rather than us noticing
 * afterwards. Produces the same `FileChange` the watcher does, so both converge
 * on one pipeline.
 *
 * Returns null for anything outside the project or not a source file, which is
 * most of what the hook will report.
 *
 * Both sides are resolved before they are compared, and that is not tidiness.
 * Claude Code reports the path it resolved; the server was started on whatever
 * the shell said. On macOS every `/tmp` and `/var` path is one symlink from its
 * real name, so `/private/tmp/x` and `/tmp/x` are two spellings of one
 * directory and `path.relative` between them starts with `..` — the edit reads
 * as being outside the project and is silently dropped. A whole review ran with
 * the Repository panel reading "Hook ✓ installed" over five hook calls that had
 * every one answered `{"accepted":false}`.
 */
export async function changeFromHook(
  payload: HookPayload,
  root: string,
): Promise<FileChange | null> {
  const target = payload.tool_input?.file_path;
  if (typeof target !== 'string' || target === '') return null;

  const projectRoot = await realpath(root).catch(() => path.resolve(root));
  const absolutePath = await resolveLinks(path.resolve(projectRoot, target));
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return null;

  const segments = relative.split(path.sep);
  const name = segments[segments.length - 1];
  if (name === undefined || !isSourceFileName(name)) return null;
  if (segments.slice(0, -1).some(isIgnoredDirectoryName)) return null;

  // The hook fires after the tool ran, so the file's presence tells us whether
  // this was an edit or a removal.
  const exists = await access(absolutePath).then(
    () => true,
    () => false,
  );

  return { filePath: segments.join('/'), absolutePath, kind: exists ? 'changed' : 'removed' };
}

/**
 * A path with the symlinks in its *directories* resolved away, so that two
 * spellings of one file compare equal.
 *
 * The last segment is deliberately left alone. The walk keeps a symlinked
 * source file under the name it is linked at — every package in TanStack/query
 * links its eslint config to the root one — so resolving it would report the
 * edit at a path the graph has never heard of, trading one silent drop for
 * another. Directories are the half that carries `/private`, and the half the
 * walk does not follow.
 *
 * A directory that went with the file resolves to nothing, which is the
 * ordinary answer for a removal rather than a failure.
 */
async function resolveLinks(target: string): Promise<string> {
  const directory = path.dirname(target);
  const resolved = await realpath(directory).catch(() => directory);
  return path.join(resolved, path.basename(target));
}

/** Names in one clause before it stops reading as a sentence. */
const MAX_NAMED = 3;

/**
 * The cap the transport imposes is 10,000 characters. This is far under it
 * because the constraint that matters is attention, not bytes.
 */
const MAX_NOTE = 400;

/**
 * What the graph knows about who depends on one file, in a sentence or two.
 *
 * This is the hook's other half: the graph answering back. A `PostToolUse`
 * hook's stdout reaches the model when it is JSON carrying
 * `hookSpecificOutput.additionalContext`, and that is the one channel this tool
 * has into the agent already working in the project — an MCP server is called
 * *by* an agent and can never call one. So the moment a file is written is also
 * the moment to say what depends on it, which is the half of the question grep
 * cannot answer cheaply.
 *
 * It is prose, and short, on purpose. This lands unbidden in the agent's
 * context after every edit, so a paragraph, a bullet list, or a sentence about
 * every file would be noise the agent learns to skip past — and the feature
 * would be worse than absent.
 *
 * It says what the graph knows, and it names it. It used to end on a ratio, and
 * the ratio was wrong twice over. The denominator counted every non-file node,
 * so an interface's own fields were "symbols": `src/server/session.ts` has 63
 * of them against 14 top-level, and a three-symbol Rust file read as eighteen.
 * The paid verification run had the model object, unprompted, that a file
 * declared four top-level symbols and not five, and it was right. And that
 * population is dominated by methods and fields, whose use from outside the
 * graph explicitly declines to track — see `describeSymbol`'s coverage note —
 * so zod's v4/core/schemas.ts read "43 of its 745 symbols are used from outside
 * it" and invited the conclusion that 94% of the file was internal. A fraction
 * the graph cannot support is exactly the authoritative-wrong output this
 * project exists to refuse. What is left is the two things it can stand behind:
 * which files import this one, and which of its symbols something outside
 * actually reaches, by name. A name is more use to an agent than a ratio in any
 * case.
 *
 * Pure, and handed the graph rather than reaching for one, so the sentence can
 * be read in a test instead of guessed at through a running server.
 *
 * Returns '' — say nothing at all — for a file the graph has never seen, and
 * for one nothing depends on. Silence is the design: a hook that speaks after
 * every edit is a hook whose output stops being read, so it speaks only when
 * the answer is something the agent could not have known.
 *
 * `categories` are the rows `/api/clusters` answers with — the clusters the
 * graph found wearing the names a person or an agent gave them. They add one
 * sentence: which category holds the file, and which categories it reaches out
 * of that one into. A person drew that architecture, and an agent that knows
 * it can write code that fits it; the crossing is the half the agent cannot
 * work out from the edit it just made, because it would have to know where
 * every file it imported lives. Passing none is the honest answer for a
 * project nobody has named anything in, and the note is then exactly what it
 * was before categories existed.
 */
export function couplingNote(
  graph: Graph,
  filePath: string,
  categories: readonly GroupSuggestion[] = [],
): string {
  const file = graph.nodes.get(filePath);
  if (file?.kind !== 'file') return '';

  const declared = new Set<string>();
  for (const node of graph.nodes.values()) {
    if (node.kind !== 'file' && node.filePath === filePath) declared.add(node.id);
  }

  const importers = new Set<string>();
  const reached = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === 'imports') {
      if (edge.to === filePath) importers.add(edge.from);
      continue;
    }
    if (!REACHES.has(edge.kind) || !declared.has(edge.to)) continue;
    // The source of a `calls` edge may itself be a file, and a file node's
    // `filePath` is its own id, so one lookup answers for both.
    const from = graph.nodes.get(edge.from);
    if (from !== undefined && from.filePath !== filePath) reached.add(edge.to);
  }

  const { own, crossed } = categoryFacts(graph, filePath, categories);

  if (importers.size === 0 && reached.size === 0 && crossed.length === 0) return '';

  const files = [...importers].sort();
  const names = [...reached]
    .map((id) => graph.nodes.get(id)?.name ?? id)
    .sort((a, b) => a.localeCompare(b));

  const write = (nameFiles: boolean, nameSymbols: boolean, withCategory: boolean): string => {
    const sentences: string[] = [];
    if (files.length > 0) {
      const plural = files.length === 1 ? 'file' : 'files';
      const opening = `${filePath} is imported by ${files.length} ${plural}`;
      sentences.push(nameFiles ? `${opening} — ${nameList(files)}.` : `${opening}.`);
    }
    if (names.length > 0) {
      const subject = nameSymbols
        ? nameList(names)
        : `${names.length} ${names.length === 1 ? 'symbol' : 'symbols'}`;
      const verb = names.length === 1 ? 'is' : 'are';
      // Standalone, the sentence has to name the file itself; after the first
      // it would be saying the path twice in two lines.
      const where = sentences.length > 0 ? 'it' : filePath;
      sentences.push(`${subject} ${verb} used from outside ${where}.`);
    }
    if (withCategory && own !== null) {
      // The subject again: standalone this is the whole note, and a note that
      // opens on "It" names nothing.
      const subject = sentences.length > 0 ? 'It' : filePath;
      // The categories reached, not the files in them. A category name costs a
      // tenth of a path, and the agent already knows what it just imported —
      // what it cannot know is which piece of the architecture that import
      // landed in. And it is a fact, deliberately: nobody has declared a rule
      // about which category may reach which, so the note says where the edge
      // went and stops. Calling it a violation would be this tool inventing
      // an architecture, which is decision 5's whole subject.
      const reaches = crossed.length === 0 ? '' : `, and reaches into ${nameList(crossed)}`;
      sentences.push(`${subject} is in the ${own} category${reaches}.`);
    }
    return sentences.join(' ');
  };

  // Long paths, not long prose: four of this project's own file names already
  // spend 240 characters between them. So the paths are what goes first, and
  // the symbol names last — a name costs a tenth of a path and is the half the
  // agent could not have worked out from the edit it just made. And if even
  // the counts will not fit, say nothing: a sentence cut off at 400 characters
  // reads as an answer while being half of one, which is the failure this
  // project cares most about.
  //
  // The category clause goes last of all to be dropped, because it is the
  // cheapest sentence here — a handful of names a person chose, against paths
  // that run to sixty characters each — and because it is the one the agent
  // has no other way to ask for.
  const notes = [
    write(true, true, true),
    write(false, true, true),
    write(false, false, true),
    write(false, false, false),
  ];
  return notes.find((note) => note.length <= MAX_NOTE) ?? '';
}

/**
 * Which named category holds this file, and which named categories it reaches
 * out of that one into.
 *
 * **The category, singular.** A file can be listed by more than one — a group
 * the clustering found inside another, or a hand-drawn one overlapping a found
 * one — and the most specific of them is the one worth a sentence: deepest
 * first, then smallest, then by name so the answer is the same every time. It
 * is the name the page shows around that box, which is the point: the hook and
 * the diagram must not tell a person two different things about one file.
 *
 * Only an accepted name counts. A cluster nobody has named has no name to say,
 * and a rejected one is somebody's word that it is *not* a piece of the
 * architecture — the same rule `partitionByCategory` draws by.
 *
 * **Reaching into.** Any edge out of this file, or out of a symbol it declares,
 * that lands in a file some other named category holds. Imports and the
 * `REACHES` kinds both, because an `extends` across a boundary is the same
 * crossing an import is and there is no reason to see one and not the other.
 *
 * It is a fact and never a judgement. Nobody has declared which category may
 * reach which — codemap does not hold such a rule and will not invent one —
 * so this says where the edge went and stops there.
 */
function categoryFacts(
  graph: Graph,
  filePath: string,
  categories: readonly GroupSuggestion[],
): { own: string | null; crossed: string[] } {
  const named = categories.filter(
    (category) => category.state === 'accepted' && (category.name ?? '').trim() !== '',
  );
  if (named.length === 0) return { own: null, crossed: [] };

  // The component diagram's own rule, not a second one: leaves first, in the
  // order the list arrives, and the first to claim a file keeps it
  // (partitionByCategory in view/components.ts). Sorting by depth then size
  // read better and was a lie — on a project where a found group and a
  // hand-drawn one both held render.py, the hook said "Rendering" while the
  // diagram drew it in "Task core". Two names for one file is the one thing
  // the hook must never do.
  const outer = new Set(named.map((category) => category.parent).filter((id) => id !== null));
  const ordered = [...named.filter((category) => !outer.has(category.id)), ...named.filter((category) => outer.has(category.id))];

  const categoryOf = new Map<string, string>();
  for (const category of ordered) {
    const name = (category.name ?? '').trim();
    for (const file of category.files) if (!categoryOf.has(file)) categoryOf.set(file, name);
  }

  const own = categoryOf.get(filePath) ?? null;
  if (own === null) return { own: null, crossed: [] };

  const crossed = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports' && !REACHES.has(edge.kind)) continue;
    // A file node's `filePath` is its own id, so one lookup answers for a file
    // that reached out at top level and for a symbol inside it alike.
    if (graph.nodes.get(edge.from)?.filePath !== filePath) continue;
    const landed = graph.nodes.get(edge.to)?.filePath;
    if (landed === undefined || landed === filePath) continue;
    const there = categoryOf.get(landed);
    if (there !== undefined && there !== own) crossed.add(there);
  }

  return { own, crossed: [...crossed].sort((a, b) => a.localeCompare(b)) };
}

/**
 * `a, b and c`, and `a, b, c and 4 more` past the cap.
 *
 * One over the cap is named rather than counted: "and 1 more" costs the same
 * room as the name it is hiding, and tells the reader less.
 */
function nameList(values: readonly string[]): string {
  const named = values.length <= MAX_NAMED + 1 ? [...values] : values.slice(0, MAX_NAMED);
  const rest = values.length - named.length;
  const parts = rest > 0 ? [...named, `${rest} more`] : named;

  const last = parts[parts.length - 1] ?? '';
  return parts.length === 1 ? last : `${parts.slice(0, -1).join(', ')} and ${last}`;
}

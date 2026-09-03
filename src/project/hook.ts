import { access } from 'node:fs/promises';
import path from 'node:path';
import { REACHES } from '../graph/edges.js';
import type { Graph } from '../graph/types.js';
import { isIgnoredDirectoryName, isSourceFileName } from './walk.js';
import type { FileChange } from './watch.js';

/**
 * The part of a Claude Code `PostToolUse` payload this cares about. Write, Edit
 * and MultiEdit all name their target the same way; MultiEdit's `edits` array
 * describes changes within that one file, so the path alone is enough.
 */
export interface HookPayload {
  tool_name?: unknown;
  tool_input?: { file_path?: unknown } | undefined;
}

/**
 * The primary event source: the agent tells us directly, rather than us noticing
 * afterwards. Produces the same `FileChange` the watcher does, so both converge
 * on one pipeline.
 *
 * Returns null for anything outside the project or not a source file, which is
 * most of what the hook will report.
 */
export async function changeFromHook(
  payload: HookPayload,
  root: string,
): Promise<FileChange | null> {
  const target = payload.tool_input?.file_path;
  if (typeof target !== 'string' || target === '') return null;

  const absolutePath = path.resolve(root, target);
  const relative = path.relative(root, absolutePath);
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
 */
export function couplingNote(graph: Graph, filePath: string): string {
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

  if (importers.size === 0 && reached.size === 0) return '';

  const files = [...importers].sort();
  const names = [...reached]
    .map((id) => graph.nodes.get(id)?.name ?? id)
    .sort((a, b) => a.localeCompare(b));

  const write = (nameFiles: boolean, nameSymbols: boolean): string => {
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
    return sentences.join(' ');
  };

  // Long paths, not long prose: four of this project's own file names already
  // spend 240 characters between them. So the paths are what goes first, and
  // the symbol names last — a name costs a tenth of a path and is the half the
  // agent could not have worked out from the edit it just made. And if even
  // the counts will not fit, say nothing: a sentence cut off at 400 characters
  // reads as an answer while being half of one, which is the failure this
  // project cares most about.
  const notes = [write(true, true), write(false, true), write(false, false)];
  return notes.find((note) => note.length <= MAX_NOTE) ?? '';
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

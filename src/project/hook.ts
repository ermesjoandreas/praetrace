import { access } from 'node:fs/promises';
import path from 'node:path';
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

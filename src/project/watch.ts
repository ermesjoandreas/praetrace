import type { Stats } from 'node:fs';
import path from 'node:path';
import chokidar from 'chokidar';
import { isIgnoredDirectoryName, isSourceFileName } from './walk.js';

export interface FileChange {
  /** POSIX path relative to the root; the graph's file node id. */
  filePath: string;
  absolutePath: string;
  kind: 'changed' | 'removed';
}

export interface WatchOptions {
  root: string;
  /** One raw event per change. Coalescing is the updater's job, not the watcher's. */
  onChange: (change: FileChange) => void;
}

export interface ProjectWatcher {
  close(): Promise<void>;
}

/**
 * The fallback event source: it catches hand edits and agents other than Claude
 * Code. It feeds the same updater as the hook endpoint rather than running a
 * pipeline of its own.
 */
export function watchProject({ root, onChange }: WatchOptions): ProjectWatcher {
  const emit = (absolutePath: string, kind: FileChange['kind']): void => {
    onChange({
      filePath: path.relative(root, absolutePath).split(path.sep).join('/'),
      absolutePath,
      kind,
    });
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (candidate, stats) => shouldIgnore(root, candidate, stats),
  });

  watcher.on('add', (absolutePath) => emit(absolutePath, 'changed'));
  watcher.on('change', (absolutePath) => emit(absolutePath, 'changed'));
  watcher.on('unlink', (absolutePath) => emit(absolutePath, 'removed'));

  return {
    async close() {
      await watcher.close();
    },
  };
}

/**
 * The boot scan's two rules, applied to one path at a time:
 * `isIgnoredDirectoryName` judges a directory, `isSourceFileName` judges a
 * file. What made the two disagree was guessing which of them a path was from
 * its name — a dot read as an extension made `Serilog.Sinks.File` a file that
 * was not source, so 28 of serilog's 63 directories were walked at boot and
 * then invisible here, and no edit under them ever reached the graph.
 *
 * chokidar asks once about a bare path and again once it has stat'ed it, so an
 * answer given without stats only has to be permissive enough to reach that
 * second call. A symlink is left undecided for the same reason: its own stats
 * describe the link rather than what it points at, which chokidar resolves
 * before it asks again.
 */
function shouldIgnore(root: string, candidate: string, stats?: Stats): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..')) return false;

  const segments = relative.split(path.sep);
  const name = segments[segments.length - 1];
  if (name === undefined) return false;

  for (const segment of segments.slice(0, -1)) {
    if (isIgnoredDirectoryName(segment)) return true;
  }

  if (stats === undefined || !stats.isFile()) return isIgnoredDirectoryName(name);
  return !isSourceFileName(name);
}

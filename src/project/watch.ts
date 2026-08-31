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
    ignored: (candidate) => shouldIgnore(root, candidate),
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
 * chokidar asks about paths before it has stat'ed them, so this decides from the
 * name alone: anything with no extension is treated as a directory.
 */
function shouldIgnore(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative === '' || relative.startsWith('..')) return false;

  const segments = relative.split(path.sep);
  const name = segments[segments.length - 1];
  if (name === undefined) return false;

  for (const segment of segments.slice(0, -1)) {
    if (isIgnoredDirectoryName(segment)) return true;
  }

  if (path.extname(name) === '') return isIgnoredDirectoryName(name);
  return !isSourceFileName(name);
}

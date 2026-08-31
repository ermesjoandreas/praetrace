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
  /**
   * An agent writes several files in quick succession, and editors save through
   * a temp file. Coalescing turns that burst into one graph update.
   */
  debounceMs?: number;
  onBatch: (changes: FileChange[]) => void;
}

export interface ProjectWatcher {
  close(): Promise<void>;
}

export function watchProject({ root, debounceMs = 80, onBatch }: WatchOptions): ProjectWatcher {
  const pending = new Map<string, FileChange>();
  let timer: NodeJS.Timeout | null = null;

  const flush = (): void => {
    timer = null;
    if (pending.size === 0) return;
    const batch = [...pending.values()];
    pending.clear();
    onBatch(batch);
  };

  const queue = (absolutePath: string, kind: FileChange['kind']): void => {
    const filePath = path.relative(root, absolutePath).split(path.sep).join('/');
    // A later event for the same file wins: removed-then-added is an add.
    pending.set(filePath, { filePath, absolutePath, kind });
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  };

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    ignored: (candidate) => shouldIgnore(root, candidate),
  });

  watcher.on('add', (absolutePath) => queue(absolutePath, 'changed'));
  watcher.on('change', (absolutePath) => queue(absolutePath, 'changed'));
  watcher.on('unlink', (absolutePath) => queue(absolutePath, 'removed'));

  return {
    async close() {
      if (timer) clearTimeout(timer);
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

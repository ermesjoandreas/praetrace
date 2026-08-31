import { applyBatch, type GraphStore } from '../graph/store.js';
import type { ParserPool } from '../parser/pool.js';
import type { ParsedFile } from '../parser/types.js';
import type { FileChange } from './watch.js';

export interface UpdaterOptions {
  store: GraphStore;
  pool: ParserPool;
  /**
   * An agent writes several files in a row, editors save through temp files, and
   * a hook and the watcher both report the same edit. Coalescing turns all of
   * that into one graph update.
   */
  debounceMs?: number;
  onApplied: (changedFiles: string[]) => void;
  onError?: (message: string) => void;
}

export interface ProjectUpdater {
  queue(change: FileChange): void;
  close(): void;
}

/**
 * The single path from "a file changed" to "the graph is up to date".
 *
 * Both event sources — the Claude Code hook and the file watcher — queue into
 * this. There is deliberately no second pipeline: whichever source notices an
 * edit first, the same batch, parse and publish follow.
 */
export function createUpdater({
  store,
  pool,
  debounceMs = 80,
  onApplied,
  onError,
}: UpdaterOptions): ProjectUpdater {
  const pending = new Map<string, FileChange>();
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let closed = false;

  function schedule(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function flush(): void {
    timer = null;
    // A batch is already in flight; it reschedules itself when it finishes.
    if (closed || running || pending.size === 0) return;

    const batch = [...pending.values()];
    pending.clear();
    running = true;

    void apply(batch).finally(() => {
      running = false;
      if (pending.size > 0) schedule();
    });
  }

  async function apply(batch: readonly FileChange[]): Promise<void> {
    const removed = batch.filter((change) => change.kind === 'removed').map((c) => c.filePath);
    const edited = batch.filter((change) => change.kind === 'changed');

    const results = await Promise.allSettled(
      edited.map((change) => pool.parse(change.filePath, change.absolutePath)),
    );

    const updated: ParsedFile[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') updated.push(result.value);
      else onError?.(result.reason instanceof Error ? result.reason.message : String(result.reason));
    }

    // Re-checked after the await: closing happens while a batch is in flight
    // when a project is switched, and a parse from the abandoned project must
    // not write to anything or announce itself.
    if (closed) return;

    applyBatch(store, updated, removed);

    // Reported even when the graph is unchanged: a touched file is worth
    // showing, and a comment-only edit still says where the agent is working.
    onApplied(batch.map((change) => change.filePath));
  }

  return {
    queue(change) {
      if (closed) return;
      // A later event for the same file wins: removed-then-added is an add.
      pending.set(change.filePath, change);
      schedule();
    },

    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

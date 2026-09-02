import { applyBatch, type GraphStore } from '../graph/store.js';
import type { ParserPool } from '../parser/pool.js';
import type { ParsedFile } from '../parser/types.js';
import { findRevealedDeclaration, isShadowedDeclaration, type SourceFile } from './walk.js';
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
    // What the project will hold once this batch lands. The boot scan drops a
    // `.d.ts` that a sibling implements, but neither source can: the watcher and
    // the hook each decide one path at a time. This is where they converge and
    // the only place holding the file set, so this is where the rule is applied.
    // The batch's own paths count too — a build emits `foo.ts` and `foo.d.ts`
    // together, and the store has seen neither yet.
    const files = new Set(store.files.keys());
    for (const change of batch) {
      if (change.kind === 'removed') files.delete(change.filePath);
      else files.add(change.filePath);
    }

    // The rule is a statement about the project, not about the batch. Writing
    // `foo.ts` beside a `foo.d.ts` the store is already holding shadows a file
    // no event names, and asking only about the batch's own paths leaves both
    // in the graph — every symbol in that module drawn twice until a restart.
    const shadowed = [...store.files.keys()].filter((filePath) =>
      isShadowedDeclaration(filePath, files),
    );
    for (const filePath of shadowed) files.delete(filePath);

    const removals = batch.filter((change) => change.kind === 'removed');
    const removed = new Set([...removals.map((change) => change.filePath), ...shadowed]);

    // The other direction: a removal can reveal a declaration that was dropped
    // for restating it. Two implementations can reveal the same one, so it is
    // keyed by path rather than parsed once per event.
    const revealed = new Map<string, SourceFile>();
    for (const found of await Promise.all(
      removals.map((change) => findRevealedDeclaration(change, files)),
    )) {
      if (found) revealed.set(found.filePath, found);
    }

    const edited = batch.filter(
      (change) => change.kind === 'changed' && !isShadowedDeclaration(change.filePath, files),
    );

    const results = await Promise.allSettled(
      [...edited, ...revealed.values()].map((file) => pool.parse(file.filePath, file.absolutePath)),
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

    // Asked before the store is mutated: a removal only landed if the file was
    // in it. What is published is what the graph now says, not what the batch
    // asked for — a path the tool refused to parse has no box, so reporting it
    // raises a "changes outside" badge that focuses something that cannot exist.
    const landed = [
      ...updated.map((file) => file.filePath),
      ...[...removed].filter((filePath) => store.files.has(filePath)),
    ];

    applyBatch(store, updated, [...removed]);

    // Reported even when the graph is unchanged: a touched file is worth
    // showing, and a comment-only edit still says where the agent is working.
    // Nothing landing at all is a different thing, and says nothing.
    if (landed.length > 0) onApplied(landed);
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

import { checkIgnored } from './git.js';
import { applyBatch, type GraphStore } from '../graph/store.js';
import type { ParserPool } from '../parser/pool.js';
import type { ParsedFile } from '../parser/types.js';
import type { Attribution } from './hook.js';
import { findRevealedDeclaration, isShadowedDeclaration, type SourceFile } from './walk.js';
import type { FileChange } from './watch.js';

export interface UpdaterOptions {
  store: GraphStore;
  pool: ParserPool;
  /**
   * The project root, for asking git which of a batch's files it ignores.
   * The boot scan keeps build output out of the graph; without this the
   * first build after boot would write it straight back in. Absent means
   * nothing is asked, which is what a project without git wants.
   */
  root?: string;
  /**
   * An agent writes several files in a row, editors save through temp files, and
   * a hook and the watcher both report the same edit. Coalescing turns all of
   * that into one graph update.
   */
  debounceMs?: number;
  /**
   * `by` names the files in this batch that something claimed, and only those:
   * a file missing from it was written by nobody we can name. See `Attribution`
   * for why that absence is the model rather than a placeholder name.
   */
  onApplied: (changedFiles: string[], by: ReadonlyMap<string, Attribution>) => void;
  onError?: (message: string) => void;
}

export interface ProjectUpdater {
  /**
   * `by` is what the source said about itself, and only the hook can say
   * anything: the watcher hands this nothing, forever, because it knows
   * nothing.
   */
  queue(change: FileChange, by?: Attribution | null): void;
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
  root,
  debounceMs = 80,
  onApplied,
  onError,
}: UpdaterOptions): ProjectUpdater {
  const pending = new Map<string, FileChange>();

  /**
   * Only ever written to, never cleared by an event that names nobody.
   *
   * The hook and the watcher both report the same edit, and which of them
   * arrives first is not decidable: measured against a real Claude Code
   * payload, the watcher fired 46 ms after the write and the hook's POST landed
   * at 84 ms. So a later unattributed event for a file the hook already claimed
   * is the *second sighting of one edit*, not evidence that nobody wrote it,
   * and letting it overwrite would throw the name away roughly half the time.
   * A genuinely different, named source landing in the same 80 ms window
   * overwrites, which is the only reading of two names that is not a guess.
   */
  const claimed = new Map<string, Attribution>();
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
    const by = new Map(claimed);
    pending.clear();
    claimed.clear();
    running = true;

    void apply(batch, by).finally(() => {
      running = false;
      if (pending.size > 0) schedule();
    });
  }

  async function apply(
    batch: readonly FileChange[],
    by: ReadonlyMap<string, Attribution>,
  ): Promise<void> {
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

    // One git call per batch, not per file: the same rule the boot scan
    // applied, or an esbuild that writes `functions/lib/index.js` on every
    // save would put 184 symbols of bundle into a graph the scan kept clean.
    const candidates = [...edited, ...revealed.values()];
    const ignored = root === undefined ? new Set<string>() : await checkIgnored(root, candidates.map((file) => file.filePath));
    const results = await Promise.allSettled(
      candidates
        .filter((file) => !ignored.has(file.filePath))
        .map((file) => pool.parse(file.filePath, file.absolutePath)),
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

    // Narrowed to what actually landed, for the reason `landed` itself is:
    // a claim about a path the tool refused to parse names a box that does not
    // exist, and a reader would have no way to tell that from a lost name.
    const attributed = new Map<string, Attribution>();
    for (const filePath of landed) {
      const source = by.get(filePath);
      if (source !== undefined) attributed.set(filePath, source);
    }

    // Reported even when the graph is unchanged: a touched file is worth
    // showing, and a comment-only edit still says where the agent is working.
    // Nothing landing at all is a different thing, and says nothing.
    if (landed.length > 0) onApplied(landed, attributed);
  }

  return {
    queue(change, by) {
      if (closed) return;
      // A later event for the same file wins: removed-then-added is an add.
      pending.set(change.filePath, change);
      // The name does not follow that rule — see `claimed`.
      if (by) claimed.set(change.filePath, by);
      schedule();
    },

    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

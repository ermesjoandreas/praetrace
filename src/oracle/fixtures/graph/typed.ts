import { log } from './index.js';
import type { Store } from './store.js';

/** A receiver whose type was written down: `store.put` is Store's, and nothing else's. */
export function save(store: Store, key: string): void {
  log(`save ${key}`);
  store.put(key);
}

/**
 * A receiver with no classifier behind it. `rows.map` is the language's map,
 * not the `map` the barrel above exports — which is what the graph used to
 * say. The checker agrees by having nothing to point at: Array's declaration
 * is outside the files being read.
 */
export function names(rows: string[]): string[] {
  return rows.map((row) => row.trim());
}

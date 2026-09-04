import { log } from './index.js';
import { Store } from './store.js';

/**
 * Calls written outside every function, class and method. There is no symbol
 * to hang them on, so they are the file's own — 61% of express's missing call
 * edges were this shape, 54% of zod's and 73% of TanStack/query's.
 */

log('booting');

/** An exported name bound to something that is not a call earns a node too. */
export const store = new Store();

const first = store.size();

/** An IIFE is top level too, and neither side can name the function it calls. */
export const ready = ((value: number): number => value)(first);

/**
 * A name the file exports, bound to whatever a call returned. The extractors
 * give this one a node — the call says nothing about what it produced, so the
 * name is the whole claim, and an exported name is one another file can write
 * down. The call in its initializer is therefore `sized`'s and not the file's.
 *
 * Here because the checker models what the extractors collect, and when they
 * learned this shape the checker did not: it went on naming the file as the
 * caller, and 726 of zod's 4 409 compared edges disagreed about which end of
 * the same call was the caller. Precision read 80.3% for a graph that had not
 * drawn a single new wrong edge.
 */
export const sized = store.size();

/**
 * The same shape unexported, which is the line the rule draws. No node, so the
 * call inside it stays the file's, exactly as `first` above.
 */
const rendered = store.render();

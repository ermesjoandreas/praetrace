import { log } from './index.js';
import { Store } from './store.js';

/**
 * Calls written outside every function, class and method. There is no symbol
 * to hang them on, so they are the file's own — 61% of express's missing call
 * edges were this shape, 54% of zod's and 73% of TanStack/query's.
 */

log('booting');

/** A constant bound to something that is not a function is not a symbol either. */
export const store = new Store();

const first = store.size();

/** An IIFE is top level too, and neither side can name the function it calls. */
export const ready = ((value: number): number => value)(first);

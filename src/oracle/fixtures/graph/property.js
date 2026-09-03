/**
 * A function with a function hung off it as a property — how a CommonJS module
 * defines its API, and how express writes all 632 lines of lib/application.js.
 * Before the parser read this shape that file drew two symbols.
 *
 * JavaScript, because it is a JavaScript shape: TypeScript rejects an expando
 * property on a typed function, so writing it in a `.ts` file would only test
 * that the oracle skips a file with an error in it.
 */

import { log } from './index.js';

export function app() {
  log('app');
}

app.init = function init() {
  log('init');
};

export function boot() {
  app.init();
}

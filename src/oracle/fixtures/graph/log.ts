/**
 * The leaf everything else reaches, through one hop or several.
 *
 * `record` is deliberately not exported: a barrel's `export *` hands on what a
 * file exported, not what it wrote, and a private helper that travelled
 * through one was reached by every importer of the barrel.
 */

export function log(message: string): void {
  record(message);
}

function record(message: string): void {
  history.push(message);
}

/**
 * A top-level constant bound to a value rather than to a function. Our model
 * has no node for one — on purpose — so nothing can ever be drawn as calling
 * it, and the oracle has to say that rather than count it as a miss.
 */
export const history: string[] = [];

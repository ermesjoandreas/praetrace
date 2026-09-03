/**
 * A `#private` member. The hash is part of the name, not a qualifier — which
 * is why the store tells `Clock.#tick` from Go's `<importPath>#Name` by where
 * the hash sits relative to the first dot.
 */
export class Clock {
  #ticks = 0;

  #tick(): void {
    this.#ticks += 1;
  }

  start(): void {
    this.#tick();
  }
}

import { log } from './index.js';
import { View } from './view.js';

/**
 * A class reached through the barrel, holding a class it declares the type of.
 *
 * The field is not initialised where it is declared, and that is not
 * incidental: a field initialiser's calls are collected onto the field *and*
 * onto the class, so writing one here would put two edges on the diagram for
 * one `new`. Keeping it in the constructor keeps this fixture about the thing
 * it is testing.
 */
export class Store {
  private view: View;

  constructor() {
    this.view = new View();
  }

  put(key: string): void {
    log(`put ${key}`);
    this.render();
  }

  render(): string {
    return this.view.render();
  }

  size(): number {
    return 0;
  }
}

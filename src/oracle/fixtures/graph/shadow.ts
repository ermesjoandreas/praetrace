import { View } from './view.js';
import { Widget } from './widget.js';

/**
 * A name rebound inside a function is that function's, whatever the module
 * imported under the same spelling.
 *
 * express writes this exactly — `var View = this.get('view')` in
 * lib/application.js — and the graph drew `app.render` as a call into
 * lib/view.js for it. Two of the three lies the checker found were this shape.
 */
export function draw(): string {
  const View = new Widget();
  return View.render();
}

/** The same name, unshadowed, so the import's own edges are still expected. */
export function frame(): string {
  return new View().render();
}

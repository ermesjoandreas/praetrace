import { useCallback, useEffect, useRef, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

/**
 * Walking a list with the arrow keys — one home for every list on the page.
 *
 * Changes, the commit graph, Categories, the Declares members, the file lists
 * in the panel: five different shapes, one behaviour. Up and Down move, Home
 * and End jump to the ends, and the row the keyboard lands on is scrolled into
 * sight. Enter is not here at all, and deliberately: every row is already a
 * `<button>`, so Enter and Space already do exactly what a click does, and a
 * handler that repeated that would be a second answer to a question the
 * browser has settled.
 *
 * **A hook rather than a `<List>` component.** The five lists are a div of
 * buttons, a ul of li of button, and a ul whose rows nest a second list
 * inside them — a component that could draw all three would take a render
 * prop per row and be a worse `<ul>`. This adds behaviour to the markup each
 * list already has and changes none of it.
 *
 * **Roving tabindex, which is the whole point.** Every row was already a
 * button, so Tab reached them one at a time: the commit graph draws 300 of
 * them, and getting past the Source Control panel meant 300 presses. VS Code's
 * answer, and this one, is that a list is *one* tab stop — the row you were
 * last on, or the first — and the arrows move inside it. `tabStop` below is
 * that rule as arithmetic, and the test beside this file pins it at 300 rows.
 *
 * **The DOM is the list, not an index the caller keeps.** Rows are found by
 * the `LIST_ROW` mark in document order, so a list whose rows nest (Categories
 * draws a group's files under it) or whose row is swapped for an input while
 * it is renamed needs no arithmetic at the call site, and cannot drift out of
 * step with what is drawn. It is also why the tab stop is written onto the
 * elements rather than rendered: React never sees it, so nothing has to
 * re-render to move it, and a 300-row graph does not re-render to answer an
 * arrow key.
 *
 * **A list never takes a key the page was meant to have.** The handler is the
 * container's, not the window's, so it only ever runs for a press made inside
 * the list; and it bails unless the press came from a row, so an arrow in the
 * rename field inside Categories still moves the caret.
 */

/**
 * The mark a row wears. Spread onto the focusable element that *is* the row —
 * its button — and never onto its wrapper: the tab stop and the focus ring
 * both land on whatever carries this, and the ring belongs on the row's own
 * control, where the stylesheet already draws it inset.
 *
 * A row action beside the row is not a row, and does not wear it.
 */
export const LIST_ROW = { 'data-list-row': '' } as const;

const ROW = '[data-list-row]';

/**
 * The row holding the list's one tab stop.
 *
 * Exactly one, always, which is the property the whole scheme rests on: none
 * and the list cannot be reached by Tab at all, more than one and it is the
 * 300 stops this replaced. So an index from before anything was focused (-1)
 * answers the first row, and an index left over from a longer list answers the
 * last — a list that has just been cut short keeps the keyboard near where it
 * was rather than throwing it back to the top.
 *
 * -1 for an empty list: there is no row to put a stop on.
 */
export function activeRow(active: number, count: number): number {
  if (count <= 0) return -1;
  if (!Number.isInteger(active) || active < 0) return 0;
  if (active >= count) return count - 1;
  return active;
}

/** What one row's `tabIndex` has to be, given where the stop is. */
export function tabStop(index: number, active: number, count: number): 0 | -1 {
  return index === activeRow(active, count) ? 0 : -1;
}

/**
 * Where a key press lands, or null when the list has no answer to that key
 * and the page should keep it.
 *
 * Down at the bottom and Up at the top return the row that is already active
 * rather than null: the press is still the list's, and swallowing it is what
 * stops the sidebar scrolling out from under a list that has simply ended.
 *
 * @param from the row the press was made in. The caller has already found it
 *   in the DOM, so it is a real row or there was no press to answer.
 */
export function nextRow(key: string, from: number, count: number): number | null {
  if (count <= 0) return null;
  const at = activeRow(from, count);
  switch (key) {
    case 'ArrowDown':
      return Math.min(at + 1, count - 1);
    case 'ArrowUp':
      return Math.max(at - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Where the tab stop belongs after a render.
 *
 * `held` is the row that has focus *now*, read back out of the DOM, and it wins
 * whenever there is one. The rows move under the stop — an agent's save inserts
 * a changed file above the row the keyboard is on, and the commit graph redraws
 * on every fetch — so an index remembered from before the render names the
 * neighbour rather than the row the reader is standing on. Focus is the
 * identity the index cannot be.
 *
 * `remembered` is where the keyboard last was, which is all there is to go on
 * for a list nobody is inside; `start` is where a list that has never held
 * focus begins.
 */
export function stopAfterRender(held: number, remembered: number, start: number): number {
  if (held !== -1) return held;
  return remembered === -1 ? start : remembered;
}

/** What a list spreads onto the element that wraps its rows. */
export interface ListKeys {
  ref: (node: HTMLElement | null) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  onFocus: (event: ReactFocusEvent<HTMLElement>) => void;
}

function rowsOf(list: HTMLElement | null): HTMLElement[] {
  return list === null ? [] : Array.from(list.querySelectorAll<HTMLElement>(ROW));
}

/** Where a press was made, or -1 when it was made outside every row. */
function rowAt(rows: readonly HTMLElement[], target: Node): number {
  return rows.findIndex((row) => row.contains(target));
}

function stamp(rows: readonly HTMLElement[], active: number): void {
  rows.forEach((row, index) => {
    const stop = tabStop(index, active, rows.length);
    // Read before written: a button is tabIndex 0 to begin with, so the row
    // that keeps the stop is left alone rather than reassigned on every render.
    if (row.tabIndex !== stop) row.tabIndex = stop;
  });
}

/** A press meant for a field, which owns its own arrows. */
function isField(node: HTMLElement): boolean {
  return node.tagName === 'INPUT' || node.tagName === 'TEXTAREA' || node.isContentEditable;
}

/**
 * @param start which row holds the tab stop before the list has been focused.
 *   The commit graph passes the row the diagram is at, so Tab arrives on the
 *   commit on screen rather than 300 rows away from it; a list with nothing
 *   selected leaves it at the first row.
 */
export function useListKeys(start = 0): ListKeys {
  const list = useRef<HTMLElement | null>(null);
  /** The row the stop is on; -1 until the list has held focus. */
  const active = useRef(-1);

  // After every render, because the rows are what changed: a commit landed, a
  // group was renamed, a file stopped being changed. No dependency list would
  // be true — the rows are read out of the DOM, not out of a prop.
  useEffect(() => {
    const rows = rowsOf(list.current);
    const focused = document.activeElement;
    const held = focused instanceof HTMLElement ? rowAt(rows, focused) : -1;
    if (held !== -1) active.current = held;
    stamp(rows, stopAfterRender(held, active.current, start));
  });

  const ref = useCallback((node: HTMLElement | null) => {
    list.current = node;
  }, []);

  // The stop follows the mouse as well as the keyboard: a click focuses a row,
  // and Tab has to come back to the row that was last used rather than to the
  // top of a list somebody has already walked down.
  const onFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const rows = rowsOf(list.current);
    const at = rowAt(rows, event.target);
    if (at === -1) return;
    active.current = at;
    stamp(rows, at);
  }, []);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || isField(target)) return;
    const rows = rowsOf(list.current);
    const from = rowAt(rows, target);
    if (from === -1) return;
    const next = nextRow(event.key, from, rows.length);
    if (next === null) return;
    const row = rows[next];
    if (row === undefined) return;

    event.preventDefault();
    active.current = next;
    stamp(rows, next);
    // focus() scrolls with its own idea of where the row should end up, which
    // in a panel this short means the row jumps to the middle. 'nearest' moves
    // it as far as it has to and no further, the way a list scrolls.
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }, []);

  return { ref, onKeyDown, onFocus };
}

import type { Menu, MenuItem } from './MenuBar';

/**
 * One row of the command palette.
 *
 * ⌘⇧P runs a thing where ⌘K finds one, and everything it can run is already
 * written down: the menu bar is data, so the palette is that data flattened
 * rather than a second list to keep in step with the first. Nothing is
 * offered here that a menu does not offer, which is the only way the two can
 * never disagree.
 */
export interface Command {
  /** The menu it came from, kept apart from the label so it can be drawn muted. */
  menu: string;
  /** `View: Re-layout` — what is matched, and what is coloured. */
  title: string;
  /** The item itself, so the palette runs exactly what the menu would. */
  item: MenuItem;
}

export interface RankedCommand {
  command: Command;
  /** Where the query's characters landed in `title`, for colouring. */
  positions: number[];
}

/** A run of text, matched or not, so a contiguous hit is one span. */
export interface Segment {
  text: string;
  matched: boolean;
}

/**
 * The bar, flattened. A separator belongs to the item after it rather than
 * being a row of its own, so nothing here is dropped — including the greyed
 * items, which are the whole reason a palette can teach you why something
 * cannot run instead of leaving you unable to find it.
 */
export function flattenCommands(menus: readonly Menu[]): Command[] {
  return menus.flatMap((menu) =>
    menu.items.map((item) => ({
      menu: menu.title,
      // VS Code's own form, "View: Toggle Word Wrap": the menu is part of the
      // name, so typing `view` narrows to a menu and `go back` reads as a
      // sentence.
      title: `${menu.title}: ${item.label}`,
      item,
    })),
  );
}

/**
 * The commands the query matched, best first. No query is the whole bar.
 *
 * Four rules, and the order between them was settled against this app's own
 * menus rather than argued about:
 *
 *   1. the thing actually called what you typed;
 *   2. then the earlier and tighter match, which is ⌘K's own arithmetic;
 *   3. then a match inside the label ahead of one that only reached the menu
 *      prefix;
 *   4. then alphabetical, so the list does not reshuffle between keystrokes.
 *
 * **Three sits below two, and that is the whole of it.** Above the score it
 * looks right and is not: `sel` then answers with "View: Reset layout" — an
 * `s`, an `e` and an `l` scattered through a label — ahead of "Selection:
 * Clear selection", which begins with the letters that were typed. Below the
 * score it decides only ties, and it does decide them: `c` scores "Selection:
 * Clear selection" and "View: Command palette…" exactly alike, and the one
 * whose *label* starts with a c is the answer.
 *
 * A greyed command ranks among the rest and is never pushed down. It is often
 * exactly the one being looked for, and its reason is the answer.
 */
export function rankCommands(commands: readonly Command[], query: string): RankedCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return commands.map((command) => ({ command, positions: [] }));

  const scored: { ranked: RankedCommand; exact: boolean; inLabel: boolean; score: number }[] = [];

  for (const command of commands) {
    const found = match(command.title.toLowerCase(), needle);
    if (found === null) continue;
    scored.push({
      ranked: { command, positions: found.positions },
      score: found.score,
      exact: command.item.label.toLowerCase() === needle,
      // The prefix is `${menu}: `, so anything at or past its length landed in
      // the label itself.
      inLabel: (found.positions[0] ?? 0) >= command.menu.length + 2,
    });
  }

  return scored
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        b.score - a.score ||
        Number(b.inLabel) - Number(a.inLabel) ||
        a.ranked.command.title.localeCompare(b.ranked.command.title),
    )
    .map((entry) => entry.ranked);
}

/**
 * Where a query's characters landed in one string: a contiguous run if there
 * is one, else the leftmost subsequence, and empty when the query is not a
 * subsequence at all.
 *
 * Exported because ⌘⇧P is not the only thing that has to agree with ⌘K about
 * what a match is — ⌘F walks the drawn boxes with it, so `gst` finds
 * `GraphStore` everywhere or nowhere. The needle is lower-cased here so a
 * caller cannot get it wrong in one place and right in another.
 */
export function matchedAt(haystack: string, needle: string): number[] {
  const wanted = needle.toLowerCase();
  if (wanted === '') return [];
  return match(haystack.toLowerCase(), wanted)?.positions ?? [];
}

/**
 * The text broken into matched and unmatched runs, the way Quick Pick colours
 * a match rather than painting behind it. `offset` is where this text starts
 * inside the string the positions were measured against, so a title can be
 * drawn as a muted menu and a plain label and still be coloured from one run
 * of the matcher.
 */
export function segments(text: string, positions: readonly number[], offset = 0): Segment[] {
  const marked = new Set(positions.map((position) => position - offset));
  const out: Segment[] = [];

  for (let index = 0; index < text.length; index++) {
    const matched = marked.has(index);
    const last = out[out.length - 1];
    if (last !== undefined && last.matched === matched) last.text += text[index];
    else out.push({ text: text[index] ?? '', matched });
  }

  return out;
}

/**
 * Higher is better; `null` means the query is not a subsequence at all.
 *
 * The numbers are `src/view/search.ts`'s, copied rather than shared: the
 * command list never leaves the browser, so there is no endpoint to ask, and
 * ⌘⇧P has to behave like ⌘K or the app would hold two different ideas of what
 * a match is. Keep the two in step.
 */
function match(haystack: string, needle: string): { score: number; positions: number[] } | null {
  const exact = haystack.indexOf(needle);
  if (exact !== -1) {
    // A contiguous hit always beats a scattered one, and an earlier one wins.
    return {
      score: 1000 - exact * 2 - (haystack.length - needle.length),
      positions: Array.from({ length: needle.length }, (_, index) => exact + index),
    };
  }

  const positions: number[] = [];
  let at = 0;
  let gaps = 0;
  let first = -1;

  for (const character of needle) {
    const found = haystack.indexOf(character, at);
    if (found === -1) return null;
    if (first === -1) first = found;
    if (found > at) gaps += found - at;
    positions.push(found);
    at = found + 1;
  }

  return { score: 500 - gaps * 3 - first - (haystack.length - needle.length), positions };
}

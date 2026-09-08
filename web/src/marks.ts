/**
 * How long a live signal stays on the diagram, and how it weakens.
 *
 * **The bug this exists for.** The socket was never the problem: a file written
 * by an agent reached the page in about a tenth of a second and the box was
 * redrawn. What was missing was any trace of it a moment later. The mark lived
 * 2 500 ms, and a person watching an agent work is watching their *terminal* —
 * by the time they look back, the mark is gone and the diagram simply has one
 * more box than it had, which reads as "nothing happened until I refreshed".
 *
 * So the duration is decided by the use and not by taste. A real Claude Code
 * session writes a file about every five seconds; a person glances over every
 * minute or two. A mark has to outlast the glance, and several of them have to
 * be tellable apart by age or twenty-five amber boxes are one undifferentiated
 * smear. Hence a life measured in minutes and a band inside it, not a fade: a
 * band is a fact a reader can name ("that one is seconds old, those are from
 * the last burst"), and it changes twice rather than sixty times a second,
 * which matters because every change of it re-renders the canvas.
 *
 * Pure, and tested beside itself: the page owns the timers and the classes,
 * this owns what a mark *is* and when it stops being one.
 */

import type { Attribution } from '../../src/project/hook.js';

/**
 * One file that something did to, recently enough to still say so.
 *
 * `born` is the distinction the canvas was missing entirely: today an added
 * file and an edited one look the same, and "a class appeared" is the single
 * most interesting thing that can happen on this diagram. It is decided from
 * the view the page held a moment ago — a file in the incoming graph that was
 * not in the outgoing one — which is the only honest source for it on the
 * client, and it is sticky: a file that appeared and was then edited twice
 * inside the window is still, to a reader coming back, a new file.
 */
export interface Mark {
  /** When the change landed, by this page's clock. */
  at: number;
  /** The diagram had no box for this file until now. */
  born: boolean;
  /**
   * Who claimed it, when anything did. Null is the word for unattributed and
   * is deliberately not a name: the file watcher cannot tell Cursor from a
   * build script from a person in an editor, so nothing here may guess. See
   * `Attribution` and `docs/AGENTS.md`.
   */
  by: Attribution | null;
}

/** How long a kind of mark stays, and how long it stays at full strength. */
export interface Life {
  /** Below this age the mark is at full strength. */
  fresh: number;
  /** At this age it is gone. */
  gone: number;
}

/**
 * A write, and a question.
 *
 * Two numbers rather than one because they are two facts with two half-lives.
 * A write *is* the code — it is still true two minutes later, and two minutes
 * is about as long as a person is away from the screen without noticing they
 * were. A question is attention, which moves faster than the file does: an
 * agent that read a file a minute ago has moved on, and a diagram still blue
 * where it *used* to be looking would be pointing at the wrong place.
 */
export const WRITTEN: Life = { fresh: 20_000, gone: 120_000 };
export const ASKED: Life = { fresh: 10_000, gone: 60_000 };

/** Full strength, weakened, or over. */
export type Band = 'fresh' | 'cooled';

export function bandOf(at: number, now: number, life: Life): Band | null {
  const age = now - at;
  if (age >= life.gone) return null;
  return age < life.fresh ? 'fresh' : 'cooled';
}

/**
 * Fold a batch of changed files into the marks already standing.
 *
 * `born` is passed per batch rather than per file because that is how the page
 * knows it: one incoming view, one set of files it did not have before. A file
 * already marked keeps the `born` it was first given — see `Mark.born` — and
 * takes the new time and the new claim, because the latest is who last touched
 * it. A batch that names no file returns the map it was given, so a push with
 * nothing in it cannot cost a re-render.
 */
export function addMarks(
  marks: ReadonlyMap<string, Mark>,
  files: readonly string[],
  at: number,
  born: ReadonlySet<string>,
  by: Readonly<Record<string, Attribution>> | undefined,
): ReadonlyMap<string, Mark> {
  if (files.length === 0) return marks;
  const next = new Map(marks);
  for (const file of files) {
    next.set(file, {
      at,
      born: born.has(file) || (next.get(file)?.born ?? false),
      by: by?.[file] ?? null,
    });
  }
  return next;
}

/**
 * The marks still worth drawing. Returns the map it was handed when none has
 * expired, so a sweep that finds nothing to do does not re-render the canvas.
 */
export function liveMarks(
  marks: ReadonlyMap<string, Mark>,
  now: number,
  life: Life,
): ReadonlyMap<string, Mark> {
  let expired = false;
  for (const mark of marks.values()) {
    if (now - mark.at >= life.gone) {
      expired = true;
      break;
    }
  }
  if (!expired) return marks;
  const next = new Map<string, Mark>();
  for (const [file, mark] of marks) if (now - mark.at < life.gone) next.set(file, mark);
  return next;
}

/**
 * When the next thing happens to this set of marks — a fresh one cooling, or
 * the oldest one expiring — in milliseconds from `now`, or null when there is
 * nothing left to wait for.
 *
 * One timer for the whole map rather than one per file, and a timer only when
 * something will actually change: a periodic tick would re-render the canvas
 * every second for two minutes after every save, and the canvas is the one
 * thing on this page that is expensive to re-render.
 */
export function nextChange(
  marks: ReadonlyMap<string, Mark>,
  now: number,
  life: Life,
): number | null {
  let soonest: number | null = null;
  for (const mark of marks.values()) {
    const age = now - mark.at;
    const wait = age < life.fresh ? life.fresh - age : life.gone - age;
    if (wait <= 0) return 0;
    if (soonest === null || wait < soonest) soonest = wait;
  }
  return soonest;
}

/**
 * Above this many boxes a batch is marked but not announced.
 *
 * Forty boxes flashing at once is not information, it is a fault light: no eye
 * can follow forty things, and the animation is what makes a still diagram
 * read as broken. The mark still lands on every one of them — the amber is a
 * heat map and reads fine at any size — and the count of what arrived is in
 * the Activity table, which is a list and can hold forty rows without
 * pretending each is worth a glance.
 */
export const PULSE_MAX = 8;

/**
 * A mark as the things that draw it need it — a box, a list row, a front-page
 * row. They get the answer rather than the timestamp and the clock, so that
 * how long a mark lives is decided in one place and none of them has to hold
 * an opinion about time.
 */
export interface Shown {
  band: Band;
  /** The diagram had no box for this a moment ago. */
  born: boolean;
  /** What it says when hovered: when, and who, or that nobody said. */
  title: string;
}

/** Every mark still standing, as the renderers want it. */
export function shownMarks(
  marks: ReadonlyMap<string, Mark>,
  now: number,
  clock: Intl.DateTimeFormat,
): ReadonlyMap<string, Shown> {
  const shown = new Map<string, Shown>();
  for (const [file, mark] of marks) {
    const band = bandOf(mark.at, now, WRITTEN);
    if (band === null) continue;
    shown.set(file, { band, born: mark.born, title: describeMark(mark, clock) });
  }
  return shown;
}

/**
 * What a mark says about itself, for a tooltip. Deliberately a wall clock and
 * not an age: an age is only true for the second it was rendered, and this
 * page must not re-render the canvas once a second to keep a tooltip honest.
 */
export function describeMark(mark: Mark, clock: Intl.DateTimeFormat): string {
  const what = mark.born ? 'Added' : 'Written';
  const when = clock.format(new Date(mark.at));
  if (mark.by === null) return `${what} at ${when} — unattributed: nothing said who wrote it`;
  const who = mark.by.subagent === null ? mark.by.agent : `${mark.by.agent} · ${mark.by.subagent}`;
  return `${what} at ${when} by ${who}${mark.by.tool === null ? '' : ` (${mark.by.tool})`}`;
}

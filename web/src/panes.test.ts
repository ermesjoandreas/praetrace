import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `layout.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no panes.js for `node --test` to find.
import {
  adoptStack,
  clampLayout,
  defaultLayout,
  defaultStack,
  DEFAULT_WIDTH,
  isDefaultLayout,
  isFolded,
  LAYOUT_VERSION,
  MIN_CANVAS,
  MIN_SECTION,
  MIN_WIDTH,
  parseLayout,
  resetPane,
  resizeBar,
  resizeSection,
  SECTION_HEADER,
  SECTIONS,
  serializeLayout,
  setFolded,
  stackApplies,
  stackOf,
  type Layout,
  type Viewport,
} from './panes.ts';

/** The screen the shares in styles.css were chosen against: 1083px tall, so
 * 1004px of bar between the two 35px/22px chrome rows and the status bar. */
const screen: Viewport = { width: 1440, barHeight: 1004 };

const sum = (sizes: readonly number[]) => sizes.reduce((total, size) => total + size, 0);

test('a first run is today’s numbers, and the stylesheet still owns the stacks', () => {
  const layout = defaultLayout();
  assert.equal(layout.width.leftbar, 300);
  assert.equal(layout.width.sidebar, 330);
  assert.equal(layout.stack.leftbar, null);
  assert.equal(layout.stack.sidebar, null);
  assert.ok(isDefaultLayout(layout), 'nothing has been moved, so Reset layout is greyed');
});

test('the default stack is today’s shares — 45 / 20 / 15 / 20 — and fills the bar exactly', () => {
  const sizes = defaultStack('leftbar', screen.barHeight);
  assert.equal(sum(sizes), screen.barHeight);
  const shares = sizes.map((size) => Math.round((size / screen.barHeight) * 100));
  assert.deepEqual(shares, [45, 20, 15, 20]);
});

// --- dragging a bar ----------------------------------------------------------

test('a bar dragged past its minimum collapses to nothing, and the sash drags it back', () => {
  const closed = resizeBar(defaultLayout(), 'leftbar', 40, screen);
  assert.equal(closed.width.leftbar, 0);
  // The sash is still there because the bar still is, at zero: pulling it out
  // again is an ordinary resize and lands at the minimum, not at nothing.
  assert.equal(resizeBar(closed, 'leftbar', 120, screen).width.leftbar, MIN_WIDTH);
});

test('a bar dragged a little under its minimum rests at the minimum rather than closing', () => {
  // The overshoot of somebody dragging *to* the stop must not close the bar.
  assert.equal(resizeBar(defaultLayout(), 'leftbar', MIN_WIDTH - 4, screen).width.leftbar, MIN_WIDTH);
  assert.equal(resizeBar(defaultLayout(), 'sidebar', 90, screen).width.sidebar, MIN_WIDTH);
});

test('a bar dragged wider stops at the canvas’s minimum instead of squeezing the diagram', () => {
  const narrow: Viewport = { width: 1000, barHeight: 800 };
  const layout = resizeBar(defaultLayout(), 'leftbar', 900, narrow);
  assert.equal(layout.width.leftbar, 1000 - DEFAULT_WIDTH.sidebar - MIN_CANVAS);
  const canvas = narrow.width - layout.width.leftbar - layout.width.sidebar;
  assert.equal(canvas, MIN_CANVAS, 'the canvas gave away a pixel it does not have');
});

test('a bar dragged wider does not move the other bar', () => {
  const layout = resizeBar(defaultLayout(), 'leftbar', 500, screen);
  assert.equal(layout.width.sidebar, DEFAULT_WIDTH.sidebar);
});

// --- dragging a section sash -------------------------------------------------

const adopted = (): Layout => adoptStack(defaultLayout(), 'leftbar', [400, 300, 150, 154], screen);

test('the first drag takes the stack over at the heights the sections actually had', () => {
  assert.deepEqual(adopted().stack.leftbar, [400, 300, 150, 154]);
});

test('a section dragged below its minimum folds to its 22px header, and its neighbour takes the rest', () => {
  const layout = resizeSection(adopted(), 'leftbar', 0, 40, screen);
  const sizes = layout.stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sizes[0], SECTION_HEADER);
  assert.ok(isFolded(sizes[0]), 'the chevron and the sash must agree on what folded is');
  assert.equal(sizes[1], 700 - SECTION_HEADER, 'the pair’s total did not stay put');
  assert.deepEqual(sizes.slice(2), [150, 154], 'a pairwise drag moved a pane it does not touch');
});

test('a section dragged open past its neighbour folds the neighbour, not the section after it', () => {
  const layout = resizeSection(adopted(), 'leftbar', 0, 690, screen);
  const sizes = layout.stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sizes[1], SECTION_HEADER);
  assert.equal(sizes[0], 700 - SECTION_HEADER);
  assert.equal(sum(sizes), screen.barHeight, 'the bar no longer adds up');
});

test('there is no resting place between a folded header and a section that can show a row', () => {
  const sizes = resizeSection(adopted(), 'leftbar', 0, MIN_SECTION - 1, screen).stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sizes[0], SECTION_HEADER);
  const stopped = resizeSection(adopted(), 'leftbar', 0, MIN_SECTION, screen).stack.leftbar;
  assert.ok(stopped !== null && stopped !== undefined);
  assert.equal(stopped[0], MIN_SECTION);
});

test('a sash below the last section does not exist and changes nothing', () => {
  const layout = adopted();
  assert.equal(resizeSection(layout, 'leftbar', SECTIONS.leftbar.length - 1, 300, screen), layout);
});

// --- restoring ---------------------------------------------------------------

test('a layout saved on a wider screen comes back clamped, with the canvas kept whole', () => {
  const narrow: Viewport = { width: 1000, barHeight: 800 };
  const stack = { leftbar: null, sidebar: null };

  const both: Layout = { width: { leftbar: 620, sidebar: 540 }, stack };
  const fitted = clampLayout(both, narrow);
  assert.equal(narrow.width - fitted.width.leftbar - fitted.width.sidebar, MIN_CANVAS, 'the canvas was overrun');
  // Both were too wide, so both give until they are level.
  assert.deepEqual(fitted.width, { leftbar: 340, sidebar: 340 });

  // Only one is too wide: it gives the whole overflow and the narrow bar keeps
  // every pixel it had, rather than being shaved to keep the wide one big.
  const lopsided = clampLayout({ width: { leftbar: 620, sidebar: 200 }, stack }, narrow);
  assert.deepEqual(lopsided.width, { leftbar: 480, sidebar: 200 });
});

test('a stack saved on a taller window is refitted, and a folded section stays folded', () => {
  const tall: Layout = {
    width: { leftbar: 300, sidebar: 330 },
    stack: { leftbar: [SECTION_HEADER, 600, 200, 204], sidebar: null },
  };
  const fitted = clampLayout(tall, { width: 1440, barHeight: 502 });
  const sizes = fitted.stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sum(sizes), 502, 'the stack does not fill the bar it was fitted to');
  assert.equal(sizes[0], SECTION_HEADER, 'a folded section was reopened by a resize');
  // The open three share what the folded header leaves, in proportion to the
  // slack each was carrying above its own header.
  assert.deepEqual(sizes, [22, 277, 101, 102]);
});

test('a stack restored into a window too short for a header each folds everything rather than overflowing', () => {
  const sizes = clampLayout(
    { width: DEFAULT_WIDTH, stack: { leftbar: [400, 300, 150, 154], sidebar: null } },
    { width: 1440, barHeight: 60 },
  ).stack.leftbar;
  assert.deepEqual(sizes, [SECTION_HEADER, SECTION_HEADER, SECTION_HEADER, SECTION_HEADER]);
});

test('a stack where every section is folded stays folded, and leaves the bar half empty', () => {
  // Empty bar under four headers is what VS Code shows when you collapse them
  // all, and it is the only case where a stack does not fill its bar. Sharing
  // the space out instead would reopen four sections nobody opened.
  const shut = [SECTION_HEADER, SECTION_HEADER, SECTION_HEADER, SECTION_HEADER];
  const sizes = clampLayout({ width: DEFAULT_WIDTH, stack: { leftbar: shut, sidebar: null } }, screen).stack.leftbar;
  assert.deepEqual(sizes, shut);
});

test('a side bar drawn without Following has no border inside it to arrange', () => {
  // Measured in the page: `.sidebar` has one child while nothing is followed,
  // because Following renders null. The pair somebody set waits for it.
  assert.equal(stackApplies('sidebar', 1), false);
  assert.equal(stackApplies('sidebar', 2), true);
  assert.equal(stackApplies('leftbar', 4), true);
});

// --- the chevron and the sash ------------------------------------------------

test('folding by chevron and shoving the sash shut leave the same stack', () => {
  const byChevron = setFolded(adopted(), 'repository', true, screen);
  const bySash = resizeSection(adopted(), 'leftbar', 0, 0, screen);
  assert.deepEqual(byChevron.stack.leftbar, bySash.stack.leftbar);
  assert.deepEqual(byChevron.stack.leftbar, [SECTION_HEADER, 700 - SECTION_HEADER, 150, 154]);
});

test('the last section folds through the sash above it, the only one it has', () => {
  const folded = setFolded(adopted(), 'activity', true, screen);
  assert.deepEqual(folded.stack.leftbar, [400, 300, 150 + 154 - SECTION_HEADER, SECTION_HEADER]);
});

test('unfolding gives a section its own share back, out of its neighbour', () => {
  const shut = setFolded(adopted(), 'repository', true, screen);
  const open = setFolded(shut, 'repository', false, screen);
  const sizes = open.stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sizes[0], defaultStack('leftbar', screen.barHeight)[0]);
  assert.deepEqual(sizes.slice(2), [150, 154], 'unfolding reached past its neighbour');
});

test('a folded section can be dragged back open by the sash that shut it', () => {
  const shut = resizeSection(adopted(), 'leftbar', 0, 0, screen);
  assert.deepEqual(resizeSection(shut, 'leftbar', 0, 300, screen).stack.leftbar, [300, 400, 150, 154]);
});

test('a chevron in a bar the stylesheet still owns does not freeze the other sections', () => {
  const layout = defaultLayout();
  assert.equal(setFolded(layout, 'categories', true, screen), layout);
});

// --- storage -----------------------------------------------------------------

test('what is written is what comes back', () => {
  const arranged = resizeSection(resizeBar(defaultLayout(), 'leftbar', 420, screen), 'leftbar', 1, 200, screen);
  assert.deepEqual(parseLayout(serializeLayout(arranged), screen), arranged);
});

test('a layout written by an older version is dropped for the default, not read optimistically', () => {
  const old = JSON.stringify({ version: LAYOUT_VERSION - 1, width: { leftbar: 500, sidebar: 500 }, stack: {} });
  assert.deepEqual(parseLayout(old, screen), defaultLayout());
});

test('a stored value that is not a number at all costs that one value and nothing else', () => {
  const bad = JSON.stringify({
    version: LAYOUT_VERSION,
    width: { leftbar: '420px', sidebar: 360 },
    stack: { leftbar: [400, 'tall', 150, 154], sidebar: null },
  });
  const layout = parseLayout(bad, screen);
  assert.equal(layout.width.leftbar, DEFAULT_WIDTH.leftbar, 'the unreadable width did not fall back');
  assert.equal(layout.width.sidebar, 360, 'a readable width was thrown away with the unreadable one');
  assert.equal(layout.stack.leftbar, null, 'a stack with a string in it was used anyway');
});

test('a stack of the wrong length belongs to a page that no longer exists', () => {
  const stale = JSON.stringify({
    version: LAYOUT_VERSION,
    width: DEFAULT_WIDTH,
    stack: { leftbar: [500, 504], sidebar: null },
  });
  assert.equal(parseLayout(stale, screen).stack.leftbar, null);
});

test('nothing stored, and nothing parseable, are both the default layout and never an error', () => {
  assert.deepEqual(parseLayout(null, screen), defaultLayout());
  assert.deepEqual(parseLayout('', screen), defaultLayout());
  assert.deepEqual(parseLayout('{oh no', screen), defaultLayout());
  assert.deepEqual(parseLayout('[]', screen), defaultLayout());
  assert.deepEqual(parseLayout('"300px"', screen), defaultLayout());
});

// --- the way back ------------------------------------------------------------

test('double-clicking a bar’s sash puts it back to its own width', () => {
  const moved = resizeBar(defaultLayout(), 'sidebar', 600, screen);
  assert.equal(resetPane(moved, 'sidebar', screen).width.sidebar, DEFAULT_WIDTH.sidebar);
});

test('double-clicking a section’s sash resets that pane and leaves the ones beyond it alone', () => {
  const moved = resizeSection(adopted(), 'leftbar', 0, 120, screen);
  const back = resetPane(moved, 'repository', screen);
  const sizes = back.stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sizes[0], defaultStack('leftbar', screen.barHeight)[0]);
  assert.deepEqual(sizes.slice(2), [150, 154], 'the reset reached past the pane it names');
  assert.equal(sum(sizes), screen.barHeight);
});

test('the last section has no sash under it and is reset through the one above', () => {
  const moved = resizeSection(adopted(), 'leftbar', 2, 280, screen);
  const back = resetPane(moved, 'activity', screen);
  const sizes = back.stack.leftbar;
  assert.ok(sizes !== null && sizes !== undefined);
  assert.equal(sizes[3], defaultStack('leftbar', screen.barHeight)[3]);
  assert.equal(sum(sizes), screen.barHeight);
});

test('resetting a pane in a bar nobody has touched changes nothing', () => {
  const layout = defaultLayout();
  assert.equal(resetPane(layout, 'categories', screen), layout);
});

test('Reset layout hands the stacks back to the stylesheet', () => {
  const arranged = resizeSection(resizeBar(defaultLayout(), 'leftbar', 500, screen), 'leftbar', 1, 400, screen);
  assert.equal(isDefaultLayout(arranged), false);
  assert.ok(isDefaultLayout(defaultLayout()));
});

test('a bar nobody has touched still reports a stack, for the keyboard and for a reset', () => {
  assert.deepEqual(stackOf(defaultLayout(), 'sidebar', screen), defaultStack('sidebar', screen.barHeight));
  assert.equal(sum(stackOf(defaultLayout(), 'sidebar', screen)), screen.barHeight);
});

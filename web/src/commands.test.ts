import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is, the same as
// `panes.test.ts` beside it: the page is bundled by vite and never compiled
// into dist/, so there is no commands.js for `node --test` to find.
import { flattenCommands, matchedAt, rankCommands, segments, type Command } from './commands.ts';

const menus = [
  {
    title: 'View',
    items: [
      { label: 'Call edges', checked: true, run: () => undefined },
      { label: 'Re-layout', shortcut: '⇧⌘L', disabledBecause: 'Nothing on the canvas to lay out' },
      { label: 'Fit to screen', shortcut: '⇧⌘F', run: () => undefined },
    ],
  },
  {
    title: 'Go',
    items: [{ label: 'Back to now', shortcut: '⎋', run: () => undefined }],
  },
];

const titlesOf = (ranked: { command: Command }[]) => ranked.map((entry) => entry.command.title);

test('the bar flattens into commands titled the way VS Code titles one', () => {
  const commands = flattenCommands(menus);

  assert.deepEqual(
    commands.map((command) => command.title),
    ['View: Call edges', 'View: Re-layout', 'View: Fit to screen', 'Go: Back to now'],
  );
  assert.equal(commands[0]?.menu, 'View');
  assert.equal(commands[0]?.item.checked, true);
});

test('a command that cannot run is still a command', () => {
  const commands = flattenCommands(menus);
  const relayout = commands.find((command) => command.item.label === 'Re-layout');

  // The one the palette must not drop: the point of listing it is that you
  // learn why it is grey rather than failing to find it at all.
  assert.equal(relayout?.item.disabledBecause, 'Nothing on the canvas to lay out');
  assert.equal(rankCommands(commands, 'relay').length, 1);
});

test('no query is the whole bar, in the order the bar has it', () => {
  const ranked = rankCommands(flattenCommands(menus), '   ');

  assert.deepEqual(titlesOf(ranked), [
    'View: Call edges',
    'View: Re-layout',
    'View: Fit to screen',
    'Go: Back to now',
  ]);
  assert.deepEqual(ranked[0]?.positions, []);
});

test('matching is the subsequence ⌘K uses, and a contiguous hit wins', () => {
  const commands = flattenCommands(menus);

  // `fts` is nobody's substring; it is Fit To Screen.
  assert.deepEqual(titlesOf(rankCommands(commands, 'fts')), ['View: Fit to screen']);

  // Every one of these holds an `e`, so the scattered matches come too — but
  // the command actually called "edges" is the one on top.
  assert.equal(titlesOf(rankCommands(commands, 'edges'))[0], 'View: Call edges');

  assert.deepEqual(rankCommands(commands, 'zzz'), []);
});

test('the menu is matched with the label, so its own name finds it', () => {
  const ranked = rankCommands(flattenCommands(menus), 'go');

  assert.equal(titlesOf(ranked)[0], 'Go: Back to now');
});

test('positions land on the letters that matched', () => {
  const ranked = rankCommands(flattenCommands(menus), 'fit');
  const first = ranked[0];

  assert.equal(first?.command.title, 'View: Fit to screen');
  assert.deepEqual(
    first?.positions.map((position) => first.command.title[position]),
    ['F', 'i', 't'],
  );
});

/** A bar built to tell the ranking rules apart, one pair at a time. */
const rivals = [
  { title: 'Navigation', items: [{ label: 'Back', run: () => undefined }] },
  { title: 'Go', items: [{ label: 'Back to now', run: () => undefined }] },
  { title: 'View', items: [{ label: 'Reset layout', run: () => undefined }] },
  { title: 'Selection', items: [{ label: 'Clear selection', run: () => undefined }] },
];

test('the thing actually called what you typed comes first', () => {
  // On the arithmetic alone "Go: Back to now" wins — it is the shorter title
  // and the match sits further left in it. It is still not what was asked for.
  assert.deepEqual(titlesOf(rankCommands(flattenCommands(rivals), 'back')), [
    'Navigation: Back',
    'Go: Back to now',
  ]);
});

test('a tight match beats one that merely landed in the label', () => {
  // `sel` is the first three letters of "Selection: Clear selection" and three
  // letters scattered through "Reset layout". Preferring a match inside the
  // label over a tighter one puts the scattered answer on top, which is what
  // this ordering is here to stop.
  assert.deepEqual(titlesOf(rankCommands(flattenCommands(rivals), 'sel')), [
    'Selection: Clear selection',
    'View: Reset layout',
  ]);
});

test('the matcher ⌘F borrows is the one ⌘K uses', () => {
  // The line DESIGN.md and CLAUDE.md both quote: a subsequence, the way an
  // editor does it.
  assert.deepEqual(
    matchedAt('GraphStore', 'gst').map((position) => 'GraphStore'[position]),
    ['G', 'S', 't'],
  );

  // A contiguous run beats the scattered one it also contains: `sto` is in
  // `GraphStore` whole, so it is marked whole rather than letter by letter.
  assert.deepEqual(matchedAt('GraphStore', 'sto'), [5, 6, 7]);

  assert.deepEqual(matchedAt('GraphStore', 'zzz'), []);
  assert.deepEqual(matchedAt('GraphStore', ''), []);
  // Case is the caller's to get wrong, so it is not theirs to get wrong.
  assert.deepEqual(matchedAt('GraphStore', 'STORE'), [5, 6, 7, 8, 9]);
});

// --- ranking ------------------------------------------------------------------

test('a command is the menu’s own item, not a copy of it', () => {
  // What a palette row runs and what the menu row runs are the same function,
  // greyed for the same reason, ticked by the same flag. Nothing to keep in
  // step, because there is only one of it.
  assert.equal(flattenCommands(menus)[0]?.item, menus[0]?.items[0]);
});

test('a greyed command is ranked with the rest and never pushed to the bottom', () => {
  const commands = flattenCommands([
    {
      title: 'View',
      items: [
        { label: 'Re-layout', shortcut: '⇧⌘L', disabledBecause: 'Nothing on the canvas to lay out' },
        { label: 'Reset layout', run: () => undefined },
      ],
    },
  ]);

  // Typing `layout` with an empty canvas answers with the one that cannot run,
  // and says why. That is the point of listing it, and it is why nothing in
  // the sort looks at `disabledBecause`.
  assert.deepEqual(titlesOf(rankCommands(commands, 'layout')), [
    'View: Re-layout',
    'View: Reset layout',
  ]);
});

test('two commands that score alike are split by the one matched in its label', () => {
  const commands = flattenCommands([
    { title: 'Selection', items: [{ label: 'Clear selection', run: () => undefined }] },
    { title: 'View', items: [{ label: 'Command palette…', run: () => undefined }] },
  ]);

  // A real tie off the real bar: `c` lands at 4 in one title and 6 in the
  // other, and the lengths make the two scores identical. The `c` you typed is
  // the one that starts a label, not the one inside the menu's own name.
  assert.deepEqual(titlesOf(rankCommands(commands, 'c')), [
    'View: Command palette…',
    'Selection: Clear selection',
  ]);
});

test('an outright tie comes back alphabetically, so the list holds still between keystrokes', () => {
  const commands = flattenCommands([
    {
      title: 'View',
      items: [
        { label: 'Fit to window', run: () => undefined },
        { label: 'Fit to screen', run: () => undefined },
      ],
    },
  ]);

  assert.deepEqual(titlesOf(rankCommands(commands, 'fit')), [
    'View: Fit to screen',
    'View: Fit to window',
  ]);
});

test('a run of matched characters is one segment, not one per letter', () => {
  assert.deepEqual(segments('Fit to screen', [0, 1, 2]), [
    { text: 'Fit', matched: true },
    { text: ' to screen', matched: false },
  ]);

  // The offset is where this text starts inside the string the positions were
  // measured against — the label, drawn after the menu it belongs to.
  assert.deepEqual(segments('Back to now', [4, 5], 4), [
    { text: 'Ba', matched: true },
    { text: 'ck to now', matched: false },
  ]);

  assert.deepEqual(segments('', []), []);
});

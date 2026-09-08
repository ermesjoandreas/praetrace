import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is — the page is
// bundled by vite and never compiled into dist/, so there is no layout.js for
// `node --test` to find. `allowImportingTsExtensions` in web/tsconfig.json is
// what lets typecheck accept it. `npm test` runs it beside the dist/ tests.
import { componentHeight, GRID, frameClusters, keepLayout, layoutNodes, NODE_WIDTH, type Rect } from './layout.ts';
import { applyPlacements } from './placement.ts';

const box = (id: string, height = 80) => ({ id, width: NODE_WIDTH, height });
const at = (x: number, y: number, height = 80): Rect => ({ x, y, width: NODE_WIDTH, height });

/** Two dagre columns: a and b on the left, c to their right, a and b both importing c. */
const diagram = new Map<string, Rect>([
  ['a', at(40, 40)],
  ['b', at(40, 146)],
  ['c', at(400, 93)],
]);
const links = [
  { from: 'a', to: 'c', weight: 1 },
  { from: 'b', to: 'c', weight: 1 },
];

const positionsOf = (placed: { id: string; position: { x: number; y: number } }[]) =>
  new Map(placed.map((node) => [node.id, node.position]));

test('every box that was there stays exactly where it was', () => {
  const placed = keepLayout(diagram, [box('a'), box('b'), box('c'), box('d')], [
    ...links,
    { from: 'd', to: 'a', weight: 1 },
  ]);
  const positions = positionsOf(placed);
  for (const [id, rect] of diagram) {
    assert.deepEqual(positions.get(id), { x: rect.x, y: rect.y }, `${id} moved`);
  }
});

test('a new box lands to the right of its most connected neighbour, on the grid, clear of everything', () => {
  const placed = keepLayout(diagram, [box('a'), box('b'), box('c'), box('d')], [
    ...links,
    { from: 'd', to: 'a', weight: 1 },
    { from: 'd', to: 'c', weight: 3 },
  ]);
  const d = positionsOf(placed).get('d');
  assert.ok(d !== undefined);
  // c is the neighbour, with weight 3 against a's 1: d goes to c's right.
  const c = diagram.get('c')!;
  assert.ok(d.x >= c.x + c.width, 'not to the right of c');
  assert.equal(d.x % GRID, 0);
  assert.equal(d.y % GRID, 0);
  // Top-aligned with the neighbour's row, to the nearest grid line.
  assert.equal(d.y, Math.round(c.y / GRID) * GRID);
  // Nothing overlaps.
  for (const rect of diagram.values()) {
    const apart = d.x >= rect.x + rect.width || rect.x >= d.x + NODE_WIDTH || d.y >= rect.y + rect.height || rect.y >= d.y + 80;
    assert.ok(apart, 'd overlaps an existing box');
  }
});

test('the neighbour is chosen by summed edge weight, and edges count in both directions', () => {
  const placed = keepLayout(diagram, [box('a'), box('b'), box('c'), box('d')], [
    ...links,
    { from: 'a', to: 'd', weight: 2 },
    { from: 'd', to: 'c', weight: 1 },
  ]);
  const d = positionsOf(placed).get('d');
  const a = diagram.get('a')!;
  assert.ok(d !== undefined);
  // a wins with 2 against c's 1, so d sits on a's row — between the columns is
  // too narrow for a box, so it clears c and lands past it.
  assert.equal(d.y, Math.round(a.y / GRID) * GRID);
  assert.ok(d.x >= a.x + a.width);
});

test('when the right is full for four boxes, the new one goes below', () => {
  // A wall of boxes to the right of `a`, spanning the reach.
  const wall = new Map<string, Rect>([['a', at(0, 0)]]);
  for (let i = 0; i < 8; i++) wall.set(`w${i}`, at(NODE_WIDTH + GRID + i * (NODE_WIDTH + GRID), 0));
  const boxes = [...wall.keys()].map((id) => box(id));
  const placed = keepLayout(wall, [...boxes, box('d')], [{ from: 'd', to: 'a', weight: 1 }]);
  const d = positionsOf(placed).get('d');
  assert.ok(d !== undefined);
  assert.equal(d.x, 0);
  assert.ok(d.y >= 80 + GRID, 'not below a');
});

test('a box connected to nothing goes on a new row under the diagram, and the next one beside it', () => {
  const placed = keepLayout(diagram, [box('a'), box('b'), box('c'), box('d'), box('e')], links);
  const positions = positionsOf(placed);
  const d = positions.get('d')!;
  const e = positions.get('e')!;
  const floor = Math.max(...[...diagram.values()].map((rect) => rect.y + rect.height));
  assert.ok(d.y >= floor, 'd is not under the diagram');
  assert.equal(e.y, d.y, 'e is not on the same row as d');
  assert.ok(e.x >= d.x + NODE_WIDTH, 'e is not beside d');
});

test('a new box whose only link is to another new box is placed after it, beside it', () => {
  const placed = keepLayout(diagram, [box('a'), box('b'), box('c'), box('d'), box('e')], [
    ...links,
    { from: 'd', to: 'c', weight: 1 },
    { from: 'e', to: 'd', weight: 1 },
  ]);
  const positions = positionsOf(placed);
  const d = positions.get('d')!;
  const e = positions.get('e')!;
  assert.ok(e.x >= d.x + NODE_WIDTH, 'e is not to the right of d');
  assert.equal(e.y, d.y);
});

test('a box that grew pushes the column under it down by the growth, and a fold pulls it back', () => {
  const grown = keepLayout(diagram, [box('a', 200), box('b'), box('c')], links);
  const positions = positionsOf(grown);
  assert.deepEqual(positions.get('a'), { x: 40, y: 40 });
  assert.deepEqual(positions.get('b'), { x: 40, y: 146 + 120 });
  // c is in another column and is not touched.
  assert.deepEqual(positions.get('c'), { x: 400, y: 93 });

  const after = new Map(grown.map((node) => [node.id, { ...node.position, width: NODE_WIDTH, height: node.height }]));
  const folded = keepLayout(after, [box('a'), box('b'), box('c')], links);
  assert.deepEqual(positionsOf(folded).get('b'), { x: 40, y: 146 });
});

/**
 * The three tests below are the seam between `keepLayout` and a hand placement.
 * The rule they pin is the one App's layout memo has to keep: placements go on
 * *after* the layout and are recorded *into* the cache, so the next save reads
 * where the boxes actually are rather than where the layout thought they were.
 */
test('a hand placement wins over the growth push, so a placed box does not move when its neighbour grows', () => {
  // c sits under a in the same column. a grows by 40, which normally pushes c
  // down by 40 — but c was put where it is by hand.
  const column = new Map<string, Rect>([
    ['a', at(40, 40)],
    ['c', at(40, 160)],
  ]);
  const kept = keepLayout(column, [box('a', 120), box('c')], []);
  assert.deepEqual(positionsOf(kept).get('c'), { x: 40, y: 200 }, 'the growth push did not run');

  const placements = new Map([['c', { x: 40, y: 160 }]]);
  const applied = applyPlacements(kept, placements);
  assert.deepEqual(positionsOf(applied).get('c'), { x: 40, y: 160 }, 'the placement lost to the push');
});

test('a new box lands beside where a placed box actually is, not where the layout put it', () => {
  const placements = new Map([['c', { x: 1200, y: 600 }]]);
  const applied = applyPlacements(keepLayout(diagram, [box('a'), box('b'), box('c')], links), placements);
  // What App records: the applied positions, which is the whole point.
  const rects = new Map<string, Rect>(
    applied.map((node) => [
      node.id,
      { x: node.position.x, y: node.position.y, width: node.width ?? NODE_WIDTH, height: node.height ?? 80 },
    ]),
  );

  const next = keepLayout(rects, [box('a'), box('b'), box('c'), box('d')], [
    ...links,
    { from: 'd', to: 'c', weight: 5 },
  ]);
  const d = positionsOf(next).get('d');
  assert.ok(d !== undefined);
  assert.ok(d.x >= 1200 + NODE_WIDTH, 'd was placed beside where the layout thought c was');
  assert.equal(d.y, 600, "d did not take the placed box's row");
});

test('a frame re-hugs a member that was placed, and a placed box carries its width into the frame', () => {
  const cluster = [{ id: 'g', files: ['a', 'b'], cohesion: 1, depth: 0, parent: null }];
  // `frameClusters` reads React Flow nodes, which carry data; `keepLayout` and
  // `applyPlacements` do not care, so the boxes here are given the one field.
  const node = (id: string) => ({ ...box(id), data: {} });
  const laid = keepLayout(diagram, [node('a'), node('b'), node('c')], links);
  const before = frameClusters(laid, cluster)[0];
  assert.ok(before !== undefined);

  const applied = applyPlacements(laid, new Map([['b', { x: 900, y: 800, width: 480 }]]));
  const after = frameClusters(applied, cluster)[0];
  assert.ok(after !== undefined);
  assert.ok(after.width > before.width && after.height > before.height, 'the frame did not follow its member');
  // The far edge is the placed box's own, at the width it was pulled to.
  assert.ok(after.x + after.width >= 900 + 480, 'the frame cropped the widened box');
});

test('a box that left is simply gone; nothing else moves', () => {
  const placed = keepLayout(diagram, [box('a'), box('c')], links);
  const positions = positionsOf(placed);
  assert.equal(positions.size, 2);
  assert.deepEqual(positions.get('a'), { x: 40, y: 40 });
  assert.deepEqual(positions.get('c'), { x: 400, y: 93 });
});

test('an empty diagram places its first boxes on a row from the origin', () => {
  const placed = keepLayout(new Map(), [box('a'), box('b')], [{ from: 'a', to: 'b', weight: 1 }]);
  const positions = positionsOf(placed);
  assert.deepEqual(positions.get('a'), { x: 0, y: GRID });
  const b = positions.get('b')!;
  assert.ok(b.x >= NODE_WIDTH);
  assert.equal(b.y, GRID);
});

// --- a rank taller than the window ---------------------------------------

const flowNode = (id: string, height = 80) => ({
  id,
  position: { x: 0, y: 0 },
  data: {},
  width: NODE_WIDTH,
  height,
});

/** Boxes that lean on nothing all land in one dagre rank — the 127-box column. */
const loners = (count: number, height = 80) =>
  Array.from({ length: count }, (_, index) => flowNode(`n${index}`, height));

const columnsOf = (placed: { id: string; position: { x: number; y: number } }[]) => {
  const byX = new Map<number, { id: string; y: number }[]>();
  for (const node of placed) {
    const column = byX.get(node.position.x) ?? [];
    column.push({ id: node.id, y: node.position.y });
    byX.set(node.position.x, column);
  }
  return [...byX.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([x, boxes]) => ({ x, boxes: boxes.sort((a, b) => a.y - b.y) }));
};

const extentOf = (boxes: { y: number }[], height = 80) =>
  Math.max(...boxes.map((box) => box.y + height)) - Math.min(...boxes.map((box) => box.y));

test('a rank taller than the window folds into further columns, and every column fits', () => {
  const { nodes } = layoutNodes(loners(20), [], [], 400);
  const columns = columnsOf(nodes);
  assert.ok(columns.length > 1, 'the rank did not fold');
  for (const column of columns) {
    assert.ok(extentOf(column.boxes) <= 400, `a column is ${extentOf(column.boxes)}px in a 400px window`);
  }
  assert.equal(nodes.length, 20, 'a box was lost in the fold');
});

test('a fold keeps the rank in order: down a column, then on to the next', () => {
  const tall = layoutNodes(loners(20), [], [], 0);
  const folded = layoutNodes(loners(20), [], [], 400);
  const before = columnsOf(tall.nodes).flatMap((column) => column.boxes.map((box) => box.id));
  const columns = columnsOf(folded.nodes);
  assert.ok(columns.length > 1, 'nothing folded, so the order proves nothing');
  assert.deepEqual(columns.flatMap((column) => column.boxes.map((box) => box.id)), before);
});

test('a window taller than the rank changes nothing', () => {
  const unknown = layoutNodes(loners(20), [], [], 0);
  const roomy = layoutNodes(loners(20), [], [], 10_000);
  assert.deepEqual(
    roomy.nodes.map((node) => node.position),
    unknown.nodes.map((node) => node.position),
  );
});

test('the ranks right of a fold move over, and no two boxes overlap', () => {
  // Twelve loners in the first rank, and a pair the edge puts in ranks of
  // their own — so there is something to the right of the fold to be pushed.
  const nodes = [...loners(12), flowNode('left'), flowNode('right')];
  const { nodes: placed } = layoutNodes(nodes, [{ id: 'e', source: 'left', target: 'right' }], [], 400);
  const at = new Map(placed.map((node) => [node.id, node.position]));
  const right = at.get('right');
  assert.ok(right !== undefined);

  const folded = placed.filter((node) => node.id.startsWith('n'));
  const rightmostFold = Math.max(...folded.map((node) => node.position.x));
  assert.ok(
    new Set(folded.map((node) => node.position.x)).size > 1,
    'nothing folded, so nothing had to move over',
  );
  assert.ok(right.x > rightmostFold, 'the rank to the right was left inside the fold');

  for (const a of placed) {
    for (const b of placed) {
      if (a.id >= b.id) continue;
      const apart =
        a.position.x + NODE_WIDTH <= b.position.x ||
        b.position.x + NODE_WIDTH <= a.position.x ||
        a.position.y + (a.height ?? 0) <= b.position.y ||
        b.position.y + (b.height ?? 0) <= a.position.y;
      assert.ok(apart, `${a.id} overlaps ${b.id}`);
    }
  }
});

test('a box taller than the whole window still gets a column, rather than none', () => {
  const { nodes } = layoutNodes(loners(3, 500), [], [], 300);
  const columns = columnsOf(nodes);
  assert.equal(columns.length, 3);
  for (const column of columns) assert.equal(column.boxes.length, 1);
});

test('a frame still encloses its members after the rank they were in folded', () => {
  const nodes = loners(20);
  const files = nodes.slice(4, 9).map((node) => node.id);
  const { nodes: placed, clusters } = layoutNodes(
    nodes,
    [],
    [{ id: 'g', files, cohesion: 0.9, depth: 0, parent: null }],
    400,
  );
  const frame = clusters.find((bounds) => bounds.id === 'g');
  assert.ok(frame !== undefined, 'the group lost its frame');
  const at = new Map(placed.map((node) => [node.id, node]));
  for (const file of files) {
    const box = at.get(file)!;
    assert.ok(
      box.position.x >= frame.x &&
        box.position.y >= frame.y &&
        box.position.x + NODE_WIDTH <= frame.x + frame.width &&
        box.position.y + (box.height ?? 0) <= frame.y + frame.height,
      `${file} landed outside its own frame`,
    );
  }
});

test('a component box is measured from the rows it draws, and one that provides nothing still has a row', () => {
  // 38 header + 27 count line + rows × 17 + 5: measured in the browser at
  // 291px for twelve rows and a "+N more", 87px for one.
  assert.equal(componentHeight(12, true), 291);
  assert.equal(componentHeight(1, false), 87);
  assert.equal(componentHeight(0, false), componentHeight(1, false));
  assert.equal(componentHeight(4, false) - componentHeight(3, false), 17);
});

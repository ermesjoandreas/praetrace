import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is — the page is
// bundled by vite and never compiled into dist/, so there is no layout.js for
// `node --test` to find. `allowImportingTsExtensions` in web/tsconfig.json is
// what lets typecheck accept it. `npm test` runs it beside the dist/ tests.
import { GRID, keepLayout, NODE_WIDTH, type Rect } from './layout.ts';

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

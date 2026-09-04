import assert from 'node:assert/strict';
import { test } from 'node:test';
// The `.ts` extension is what lets Node run this file as it is — see
// layout.test.ts, which runs the class diagram's half of the same module.
import { flowBoxSize, layoutFlow, type FlowBox } from './layout.ts';

const box = (id: string, width = 120, height = 28): FlowBox => ({ id, width, height });

/** The shape a `while` makes: header, body, back to the header, and out on `no`. */
const loop = {
  boxes: [box('start', 20, 20), box('loop', 160, 56), box('body'), box('after'), box('end', 24, 24)],
  links: [
    { from: 'start', to: 'loop' },
    { from: 'loop', to: 'body' },
    { from: 'body', to: 'loop' },
    { from: 'loop', to: 'after' },
    { from: 'after', to: 'end' },
  ],
};

test('the flow reads top to bottom: start above every statement, end below them', () => {
  const { positions } = layoutFlow(loop.boxes, loop.links);
  const y = (id: string) => positions.get(id)?.y ?? NaN;
  assert.ok(y('start') < y('loop'), 'start is above the loop');
  assert.ok(y('loop') < y('body'), 'the loop header is above its body');
  assert.ok(y('after') < y('end'), 'end is last');
  assert.equal(positions.size, loop.boxes.length, 'every box is placed');
});

test('a link that runs back up is marked, and only that one', () => {
  const { backward } = layoutFlow(loop.boxes, loop.links);
  assert.deepEqual(backward, [false, false, true, false, false]);
});

test('two cases of a switch landing on one box stay two links', () => {
  const boxes = [box('start', 20, 20), box('switch', 160, 56), box('shared'), box('end', 24, 24)];
  const links = [
    { from: 'start', to: 'switch' },
    { from: 'switch', to: 'shared' },
    { from: 'switch', to: 'shared' },
    { from: 'shared', to: 'end' },
  ];
  const { backward } = layoutFlow(boxes, links);
  assert.equal(backward.length, links.length, 'backward is aligned with the links given, by index');
  assert.deepEqual(backward, [false, false, false, false]);
});

test('a box nothing leads into is still placed, and a link to a box the diagram has not got is ignored', () => {
  const boxes = [box('start', 20, 20), box('a'), box('unreachable'), box('end', 24, 24)];
  const links = [
    { from: 'start', to: 'a' },
    { from: 'a', to: 'end' },
    { from: 'ghost', to: 'a' },
  ];
  const { positions, backward } = layoutFlow(boxes, links);
  assert.ok(positions.has('unreachable'));
  assert.deepEqual(backward, [false, false, false]);
});

test('a diamond is wider and taller than the action holding the same words, and the circles are fixed', () => {
  const action = flowBoxSize('action', 'x > 0');
  const decision = flowBoxSize('decision', 'x > 0');
  assert.ok(decision.width > action.width);
  assert.ok(decision.height > action.height);
  assert.deepEqual(flowBoxSize('start', 'start'), { width: 20, height: 20 });
  assert.deepEqual(flowBoxSize('end', 'end'), { width: 24, height: 24 });
});

test('a label longer than the widest box is capped, and the lines under a box add to its height', () => {
  const long = 'a'.repeat(80);
  assert.equal(flowBoxSize('action', long).width, 320);
  assert.equal(flowBoxSize('action', 'f()').height + 28, flowBoxSize('action', 'f()', 2).height);
});

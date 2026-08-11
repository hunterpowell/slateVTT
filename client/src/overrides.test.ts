// The DM's flood fill: which cells one click of the reveal tool would paint.
//
// This runs on the client and the command carries the cells rather than a seed,
// so the preview and the result are the same array — which makes these tests
// about what the DM is actually committing, not about a preview of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fillFrom } from './overrides.js';
import { crossesWall } from './walls.js';
import type { Wall } from './walls.js';

/** Ten pixels a cell, no offset, so cell `c` spans `10c` to `10c + 10` and its
 *  centre is at `10c + 5`. */
const GRID = { px: 10, offsetX: 0, offsetY: 0 };
/** Five cells by five: centres from 5 to 45, and cell 5 would centre at 55. */
const BOARD = { x: 0, y: 0, w: 50, h: 50 };
const LIMIT = 1000;

function wall(id: string, x1: number, y1: number, x2: number, y2: number): Wall {
  return { id, from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, door: null };
}

function count(cells: number[]): number {
  return cells.length / 2;
}

function set(cells: number[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < cells.length; i += 2) out.add(`${cells[i]},${cells[i + 1]}`);
  return out;
}

test('an untraced board fills to its own edges and no further', () => {
  const filled = fillFrom({ x: 2.5, y: 2.5 }, [], GRID, BOARD, LIMIT);
  assert.equal(count(filled), 25, 'five by five');
  assert.ok(set(filled).has('0,0'));
  assert.ok(set(filled).has('4,4'));
  assert.ok(!set(filled).has('5,0'), 'nothing outside the play area is somewhere to be');
});

test('a traced room fills the room', () => {
  // Walls down x = 20 and along y = 20 box in the four cells at the top left,
  // with the board's own edges closing the other two sides.
  const walls = [wall('east', 20, 0, 20, 20), wall('south', 0, 20, 20, 20)];
  const filled = fillFrom({ x: 0.5, y: 0.5 }, walls, GRID, BOARD, LIMIT);
  assert.deepEqual([...set(filled)].sort(), ['0,0', '0,1', '1,0', '1,1']);
});

test('an open door still bounds a fill, and still lets sight through', () => {
  // The one place a door's state is not read. A dungeon traced for sight leaves
  // its archways open on purpose, so a fill that borrowed the raycast's answer
  // would escape into the whole connected map — and a room that filled cleanly
  // would stop filling the moment the party swung its door.
  const shut = [wall('east', 20, 0, 20, 20), wall('south', 0, 20, 20, 20)];
  const open = shut.map((w) => (w.id === 'east' ? { ...w, door: true } : w));

  assert.deepEqual(
    [...set(fillFrom({ x: 0.5, y: 0.5 }, open, GRID, BOARD, LIMIT))].sort(),
    [...set(fillFrom({ x: 0.5, y: 0.5 }, shut, GRID, BOARD, LIMIT))].sort(),
    'the region a click selects does not depend on play-time state',
  );

  // And the other half of the sentence, which is what makes it worth saying:
  // the same open door is not there at all as far as line of sight goes.
  assert.ok(!crossesWall(open, { x: 15, y: 5 }, { x: 25, y: 5 }));
  assert.ok(crossesWall(shut, { x: 15, y: 5 }, { x: 25, y: 5 }));
});

test('a wall through a cell centre is a dead end rather than a hole', () => {
  // A 45-degree wall hits a centre every other cell, and a chamfered corner is
  // made of those. Such a cell is taken by whichever side reaches it and
  // expanded out of by neither — clicking one fills exactly it.
  const chamfer = [wall('diagonal', 0, 0, 50, 50)];
  const filled = fillFrom({ x: 0.5, y: 0.5 }, chamfer, GRID, BOARD, LIMIT);
  assert.deepEqual([...set(filled)], ['0,0'], 'a strange thing to ask for, honestly answered');
});

test('a diagonal wall is not a hole for the cells beside it either', () => {
  // The fill must not walk through the chamfer and out into the other half.
  const chamfer = [wall('diagonal', 0, 0, 50, 50)];
  const below = set(fillFrom({ x: 0.5, y: 2.5 }, chamfer, GRID, BOARD, LIMIT));
  assert.ok(below.has('0,2'), 'the cell clicked');
  assert.ok(below.has('0,4'), 'and the rest of its side');
  assert.ok(!below.has('4,0'), 'but never the far side of the wall');
  assert.ok(!below.has('2,0'));
});

test('a seed off the board fills nothing', () => {
  assert.deepEqual(fillFrom({ x: 9.5, y: 9.5 }, [], GRID, BOARD, LIMIT), []);
});

test('a grid with no size fills nothing rather than dividing by it', () => {
  assert.deepEqual(fillFrom({ x: 2.5, y: 2.5 }, [], { ...GRID, px: 0 }, BOARD, LIMIT), []);
});

test('a fill that runs away stops, a ring at a time', () => {
  // The bound is checked once per ring rather than per cell, so it overshoots by
  // part of a ring — which is fine, since the point is that the DM sees a fill
  // that plainly ran away instead of a command that comes back as an error.
  const filled = count(fillFrom({ x: 2.5, y: 2.5 }, [], GRID, BOARD, 3));
  assert.ok(filled >= 3, `stopped at ${filled}`);
  assert.ok(filled < 25, 'and well short of the whole board');
});

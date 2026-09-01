// Walls as geometry: the crossing test behind the DM's movement hint, and the
// two bits of arithmetic the wall editor picks corners and segments with.
//
// Everything here is in image pixels — invariant 1's exception, because a wall
// traces the art rather than a cell.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blocksSight, crossesWall, distanceToSegment, snapToCorner, wallAt } from './walls.js';
import type { Wall } from './walls.js';
import { squareGrid } from './coords.js';

const GRID = squareGrid(10, 0, 0);

function wall(id: string, x1: number, y1: number, x2: number, y2: number): Wall {
  return { id, from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, door: null };
}

function door(id: string, open: boolean, x1: number, y1: number, x2: number, y2: number): Wall {
  return { ...wall(id, x1, y1, x2, y2), door: open };
}

/** A vertical wall at x = 20, from y = 0 to y = 40. */
const MASONRY = [wall('w1', 20, 0, 20, 40)];

test('a move through a wall crosses it', () => {
  assert.ok(crossesWall(MASONRY, { x: 10, y: 20 }, { x: 30, y: 20 }));
});

test('a move that stops short of a wall does not', () => {
  assert.ok(!crossesWall(MASONRY, { x: 10, y: 20 }, { x: 19, y: 20 }));
});

test('a move past the end of a wall does not', () => {
  assert.ok(!crossesWall(MASONRY, { x: 10, y: 60 }, { x: 30, y: 60 }));
});

test('a move sliding along a wall has not gone through it', () => {
  assert.ok(!crossesWall(MASONRY, { x: 20, y: 5 }, { x: 20, y: 35 }), 'collinear is not crossing');
});

test('a move setting off from a traced corner has not crossed it', () => {
  // Strict on the endpoints, deliberately: two segments meeting at a corner is
  // most of a dungeon, and a move that starts on one has passed nothing.
  assert.ok(!crossesWall(MASONRY, { x: 20, y: 0 }, { x: 40, y: 30 }));
});

test('an exactly vertical wall needs no special case', () => {
  // Four signed areas and no division, which is the reason to write it that way.
  assert.ok(crossesWall([wall('v', 20, 0, 20, 40)], { x: 0, y: 1 }, { x: 40, y: 1 }));
  assert.ok(crossesWall([wall('h', 0, 20, 40, 20)], { x: 1, y: 0 }, { x: 1, y: 40 }));
});

test('a shut door blocks and an open one does not', () => {
  const shut = [door('d', false, 20, 0, 20, 40)];
  const open = [door('d', true, 20, 0, 20, 40)];
  const from = { x: 10, y: 20 };
  const to = { x: 30, y: 20 };

  assert.ok(crossesWall(shut, from, to));
  assert.ok(!crossesWall(open, from, to), 'the difference the DM is looking at');
  assert.ok(blocksSight(shut[0] as Wall));
  assert.ok(!blocksSight(open[0] as Wall));
});

test('a client holding no walls sees no crossing, without being asked who it is', () => {
  // The whole reason the hint was affordable. A player's scene carries no walls,
  // so their ruler is never amber and no identity check produces that.
  assert.ok(!crossesWall([], { x: 0, y: 0 }, { x: 1000, y: 1000 }));
});

test('a corner snaps to the nearest grid corner, offset and all', () => {
  assert.deepEqual(snapToCorner(GRID, { x: 12, y: 8 }), { x: 10, y: 10 });
  assert.deepEqual(snapToCorner(GRID, { x: -12, y: -8 }), { x: -10, y: -10 });
  assert.deepEqual(snapToCorner(squareGrid(10, 3, 3), { x: 12, y: 6 }), {
    x: 13,
    y: 3,
  });
});

test('distance to a segment is perpendicular in the middle and to an end past it', () => {
  const a = { x: 0, y: 0 };
  const b = { x: 10, y: 0 };
  assert.equal(distanceToSegment({ x: 5, y: 4 }, a, b), 4, 'perpendicular');
  assert.equal(distanceToSegment({ x: 13, y: 4 }, a, b), 5, 'clamped to the far end');
  assert.equal(distanceToSegment({ x: -3, y: 4 }, a, b), 5, 'clamped to the near end');
});

test('a zero-length segment is a point rather than a NaN', () => {
  const p = { x: 3, y: 4 };
  assert.equal(distanceToSegment(p, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
});

test('the wall under the cursor is the nearest one, not the last traced', () => {
  // Walls have no z-order — the list is the order they were traced in and means
  // nothing — so the honest answer at a corner is whichever is closer.
  const walls = [wall('far', 0, 30, 40, 30), wall('near', 0, 10, 40, 10)];
  assert.equal(wallAt(walls, { x: 20, y: 12 }, 8)?.id, 'near');
  assert.equal(wallAt(walls, { x: 20, y: 28 }, 8)?.id, 'far');
});

test('nothing within tolerance is nothing', () => {
  assert.equal(wallAt(MASONRY, { x: 100, y: 100 }, 8), null);
});

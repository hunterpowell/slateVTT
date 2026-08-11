// The four shapes, which are one shape: a kind and two points, one hit test and
// one coverage rule. Everything here is in grid units, so a 20 ft circle stays
// 20 ft across when the DM recalibrates.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONE_HALF_ANGLE,
  canErase,
  clampExtent,
  containsPoint,
  coveredCells,
  feetOf,
  isArea,
  labelFor,
  originCell,
  shapeEnd,
} from './shapes.js';
import { feetMoved } from './ruler.js';

const at = (x: number, y: number) => ({ x, y });
const ORIGIN = at(0, 0);

test('a line encloses nothing, so nothing is ever inside one', () => {
  assert.ok(!containsPoint('line', ORIGIN, at(5, 5), 0, 0));
  assert.ok(!containsPoint('line', ORIGIN, at(5, 5), 2.5, 2.5), 'not even along it');
  assert.ok(!isArea('line'));
  assert.deepEqual(coveredCells('line', ORIGIN, at(5, 5)), [], 'and so it tints nothing');
});

test('a circle reaches exactly as far as its rim', () => {
  const to = at(3, 0);
  assert.ok(containsPoint('circle', ORIGIN, to, 0, 0));
  assert.ok(containsPoint('circle', ORIGIN, to, 3, 0), 'on the rim is inside');
  assert.ok(containsPoint('circle', ORIGIN, to, 0, -3), 'and it is a circle, not a box');
  assert.ok(!containsPoint('circle', ORIGIN, to, 3.01, 0));
  assert.ok(!containsPoint('circle', ORIGIN, to, 2.2, 2.2), '3.11 away');
});

test('a rectangle swept up and left is the same rectangle', () => {
  // `to` is an offset, so a sweep towards the origin gives negative extents and
  // the test has to normalise rather than the caller.
  for (const to of [at(2, 3), at(-2, -3)] as const) {
    const inside = to.x > 0 ? at(1, 1) : at(-1, -1);
    assert.ok(containsPoint('rect', ORIGIN, to, inside.x, inside.y), `${to.x},${to.y}`);
    assert.ok(containsPoint('rect', ORIGIN, to, 0, 0), 'the corner it was swept from');
    assert.ok(containsPoint('rect', ORIGIN, to, to.x, to.y), 'and the one it was swept to');
    assert.ok(!containsPoint('rect', ORIGIN, to, -inside.x * 2, -inside.y * 2));
  }
});

test('a cone contains its own apex', () => {
  // There is no angle from a point to itself, which the arc-cosine this replaced
  // could not say — and a cone whose own square went untinted was the visible
  // half of that.
  assert.ok(containsPoint('cone', ORIGIN, at(5, 0), 0, 0));
});

test('a cone points away from its apex and not behind it', () => {
  assert.ok(!containsPoint('cone', ORIGIN, at(5, 0), -1, 0));
  assert.ok(containsPoint('cone', ORIGIN, at(5, 0), 4, 0), 'down the axis');
});

test('a cone is half as wide as it is long, either side of the axis', () => {
  // `CONE_HALF_ANGLE` is `atan(0.5)`, so the half-width at distance d is d / 2.
  assert.ok(Math.abs(Math.tan(CONE_HALF_ANGLE) - 0.5) < 1e-12);
  assert.ok(containsPoint('cone', ORIGIN, at(5, 0), 4, 1.9), 'inside the wedge');
  assert.ok(!containsPoint('cone', ORIGIN, at(5, 0), 4, 2.1), 'outside it');
  assert.ok(!containsPoint('cone', ORIGIN, at(5, 0), 4, -2.1), 'and symmetric');
});

test('a cone pointing due west needs no special case', () => {
  // Resolved along the cone's own axis rather than into an angle, so nothing
  // here trips over the wrap that subtracting two `atan2` results does.
  assert.ok(containsPoint('cone', ORIGIN, at(-5, 0), -4, 1.9));
  assert.ok(!containsPoint('cone', ORIGIN, at(-5, 0), -4, 2.1));
});

test('a cone with no length is not a shape yet', () => {
  assert.ok(!containsPoint('cone', ORIGIN, at(0, 0), 0, 0));
});

test('slack grows the shape rather than sampling around the point', () => {
  const to = at(3, 0);
  assert.ok(!containsPoint('circle', ORIGIN, to, 3.1, 0, 0));
  assert.ok(containsPoint('circle', ORIGIN, to, 3.1, 0, 0.15));
  // Generous in every direction equally, which is the reason for growing it.
  assert.ok(containsPoint('circle', ORIGIN, to, 0, -3.1, 0.15));
});

test('covered cells are the ones whose centre the shape reaches', () => {
  const cells = pairs(coveredCells('circle', at(0.5, 0.5), at(1, 0)));
  assert.ok(cells.includes('0,0'), 'the cell it was drawn in');
  assert.ok(cells.includes('1,0'), 'and its neighbours a cell away');
  assert.ok(cells.includes('-1,0'));
  assert.ok(cells.includes('0,1'));
  assert.ok(cells.includes('0,-1'));
  assert.ok(!cells.includes('2,0'), 'but not one two cells out');
});

test('coverage is symmetric about the origin', () => {
  // Drawn from the centre of cell (0,0), so the mirror of cell `c` is cell `-c`:
  // both centres sit the same distance either side of 0.5.
  const flat = coveredCells('circle', at(0.5, 0.5), at(2, 0));
  const cells = new Set(pairs(flat));
  for (let i = 0; i < flat.length; i += 2) {
    assert.ok(cells.has(`${-(flat[i] as number)},${flat[i + 1]}`), `mirror of ${flat[i]}`);
  }
  assert.ok(cells.size > 8, 'a two-cell circle covers more than a handful');
});

test('a shape reports a length and a move reports cells crossed, and they differ', () => {
  // The honest inconsistency, and it is documented as one: a circle is a circle,
  // while "everything within 20 ft" of a movement ruler is a square. Different
  // questions, left different on purpose.
  assert.equal(feetOf({ kind: 'circle', at: ORIGIN, to: at(3, 3), color: '' }), 20);
  assert.equal(feetMoved(ORIGIN, at(3, 3), 'equal'), 15);
});

test('a rectangle measures its longer side and labels both', () => {
  const rect = { kind: 'rect', at: ORIGIN, to: at(2, -4), color: '' } as const;
  assert.equal(feetOf(rect), 20);
  assert.equal(labelFor(rect), '10 × 20 ft');
});

test('a sweep is held inside what the server will accept', () => {
  // Clamped rather than merely refused: a sweep sends a frame every 40ms, so a
  // drag past the bound would answer with thirty error banners a second.
  assert.deepEqual(clampExtent(at(40, -40)), { x: 30, y: -30 });
  assert.deepEqual(clampExtent(at(5, -5)), { x: 5, y: -5 });
});

test('a free-placed shape starts at the centre of the cell clicked', () => {
  assert.deepEqual(originCell(at(2.9, 2.1)), { x: 2.5, y: 2.5 });
  assert.deepEqual(originCell(at(-0.1, -2.9)), { x: -0.5, y: -2.5 }, 'below zero too');
});

test('the far point is the origin plus the offset it stored', () => {
  assert.deepEqual(shapeEnd(at(4, 4), at(-1, 2)), { x: 3, y: 6 });
});

test('the DM may erase anything and a player only what they drew', () => {
  const mine = shape({ kind: 'player', id: 'saelyn' });
  const theirs = shape({ kind: 'player', id: 'torrin' });
  const dms = shape({ kind: 'dm' });

  assert.ok(canErase(true, null, theirs));
  assert.ok(canErase(true, null, dms));
  assert.ok(canErase(false, 'saelyn', mine));
  assert.ok(!canErase(false, 'saelyn', theirs));
  assert.ok(!canErase(false, 'saelyn', dms));
});

function shape(by: { kind: 'dm' } | { kind: 'player'; id: string }) {
  return { id: 's1', kind: 'circle' as const, anchor: null, at: ORIGIN, to: at(1, 0), by, color: '' };
}

function pairs(flat: readonly number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(`${flat[i]},${flat[i + 1]}`);
  return out;
}

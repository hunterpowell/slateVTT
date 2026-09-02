// Turning a drag into a grid. The square path is a division; the isometric one
// is where the arithmetic is, and where the fixed shape had to be got right —
// so this is the isometric half.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Box } from './calibrate.js';
import { gridFromEdge, isoDiamond, STANDARD_RATIO } from './calibrate.js';
import type { GridSpec } from './coords.js';
import { shapeOf } from './scene.js';

/** A drag from a corner, by a vector. */
const drag = (dx: number, dy: number, x0 = 0, y0 = 0): Box => ({
  x0,
  y0,
  x1: x0 + dx,
  y1: y0 + dy,
});

/**
 * The value, having asserted it is one.
 *
 * `assert.ok` narrows nothing without `@types/node`, which this project does not
 * have and does not want for one signature — so a refusal is asserted by hand.
 */
function must<T>(value: T | null, what: string): T {
  assert.notEqual(value, null, what);
  return value as T;
}

/** What the wire would carry, which is where the ratio becomes visible. */
const ratioOf = (box: Box, shape: 'iso' | 'iso-fixed'): number | null => {
  const grid = gridFromEdge(box, shape);
  if (grid === null) return null;
  const of = shapeOf(grid);
  return of.kind === 'iso' ? of.ratio : null;
};

const edge = (box: Box, shape: 'iso' | 'iso-fixed'): GridSpec =>
  must(gridFromEdge(box, shape), 'a legal drag');

test('a drag exactly along a 2:1 edge means the same thing under both shapes', () => {
  // The tile is 64 tall and 128 wide, so half its edge is 64 across and 32 down
  // — and a DM who hits it exactly gets what they aimed at either way. The
  // fixed shape is not a different lattice, it is the same one without the
  // aiming.
  const box = drag(64, 32);
  assert.deepEqual(gridFromEdge(box, 'iso-fixed'), gridFromEdge(box, 'iso'));
  assert.equal(ratioOf(box, 'iso-fixed'), STANDARD_RATIO);
});

test('a drag a few pixels off gives exactly 2:1 rather than nearly it', () => {
  // This is the whole feature. Two pixels of slop on a forty-pixel edge is 6%
  // on the ratio under the free shape, which is most of a cell of drift ten
  // cells later; under the fixed one it is nothing at all, because the ratio
  // was never read off the drag.
  for (const box of [drag(66, 31), drag(62, 33), drag(64, 30), drag(65, 32)]) {
    assert.equal(ratioOf(box, 'iso-fixed'), STANDARD_RATIO);
  }
  assert.notEqual(ratioOf(drag(66, 31), 'iso'), STANDARD_RATIO);
});

test('the fixed shape reads the size off the whole drag, not half of it', () => {
  // The projection onto the pinned edge, which is what makes a short drag
  // across come back as a smaller cell rather than as a cell sized by the
  // thirty pixels of vertical it happened to have.
  const perfect = edge(drag(64, 32), 'iso-fixed');
  const shortAcross = edge(drag(60, 32), 'iso-fixed');
  const shortDown = edge(drag(64, 28), 'iso-fixed');
  assert.ok(shortAcross.px < perfect.px, 'a short drag across gives a smaller cell');
  assert.ok(shortDown.px < perfect.px, 'a short drag down gives a smaller cell');
  // Both components move it, and across moves it more, because the pinned edge
  // is twice as wide as it is tall.
  assert.ok(perfect.px - shortAcross.px > perfect.px - shortDown.px);
});

test('scaling a drag scales the cell and leaves the shape alone', () => {
  for (const k of [0.5, 2, 7.25]) {
    const box = drag(64 * k, 32 * k);
    assert.ok(Math.abs(edge(box, 'iso-fixed').px - 64 * k) < 1e-9);
    assert.equal(ratioOf(box, 'iso-fixed'), STANDARD_RATIO);
  }
});

test('a fixed drag cannot be lopsided, so it is never refused for being so', () => {
  // A drag the free shape has to refuse — twenty times as wide as it is tall,
  // well past MAX_GRID_RATIO — is an ordinary 2:1 cell under the fixed one.
  const box = drag(100, 5);
  assert.equal(gridFromEdge(box, 'iso'), null);
  assert.equal(ratioOf(box, 'iso-fixed'), STANDARD_RATIO);
});

test('a stray click and an absurd drag are refused under both shapes', () => {
  for (const shape of ['iso', 'iso-fixed'] as const) {
    assert.equal(isoDiamond(drag(0, 0), shape), null, 'a click');
    assert.equal(gridFromEdge(drag(1, 0.5), shape), null, 'below the minimum cell');
    assert.equal(gridFromEdge(drag(8192, 4096), shape), null, 'past the maximum cell');
    assert.equal(gridFromEdge(drag(NaN, 32), shape), null, 'not a number');
  }
});

test('the diamond drawn is the diamond committed', () => {
  // `drawCalibrationDiamond` draws `isoDiamond` and `gridFromEdge` builds the
  // lattice from it, so the DM aims the thing that gets sent. Two functions
  // deriving it separately is how a preview comes to disagree with its result
  // — which under the fixed shape would be invisible, since the drawn diamond
  // is deliberately not the one under the pointer.
  for (const shape of ['iso', 'iso-fixed'] as const) {
    for (const box of [drag(64, 32), drag(66, 31), drag(-40, 25, 300, 120)]) {
      const diamond = must(isoDiamond(box, shape), 'a legal drag');
      const grid = edge(box, shape);
      assert.ok(Math.abs(grid.px - diamond.halfH * 2) < 1e-9, 'height');
      assert.ok(Math.abs(grid.ax - diamond.halfW) < 1e-9, 'width');
    }
  }
});

test('which way the edge was dragged does not change the lattice', () => {
  // The sign is dropped, so a drag up-left describes the same cells as a drag
  // down-right — and from the same corner, since that corner is what anchors
  // the offset.
  const down = edge(drag(64, 32, 500, 400), 'iso-fixed');
  const up = edge(drag(-64, -32, 500, 400), 'iso-fixed');
  assert.equal(down.px, up.px);
  assert.equal(down.ax, up.ax);
  assert.ok(Math.abs(down.offsetX - up.offsetX) < 1e-9, 'offset x');
  assert.ok(Math.abs(down.offsetY - up.offsetY) < 1e-9, 'offset y');
});

test('a run of edges divides into that many cells', () => {
  // The gesture the count exists for: trace the whole edge of a room and say
  // how many tiles it was, rather than aim at one tile and have the answer
  // replicate across the map. Four cells of a 64-tall tile is a 256 by 128
  // drag, and it has to come back as the one tile.
  const one = edge(drag(64, 32), 'iso-fixed');
  const four = must(gridFromEdge(drag(256, 128), 'iso-fixed', 4), 'four cells');
  assert.deepEqual(four, one);
});

test('the count divides both isometric readings alike', () => {
  // Free reads the ratio off the drag and fixed pins it, but the count is a
  // division either way — so a run of N is the same statement as one edge of
  // the same cell, under both.
  for (const shape of ['iso', 'iso-fixed'] as const) {
    for (const cells of [1, 2, 5, 13]) {
      const run = must(gridFromEdge(drag(66 * cells, 31 * cells), shape, cells), 'a run');
      assert.deepEqual(run, edge(drag(66, 31), shape));
    }
  }
});

test('a count that is not a count is refused rather than divided by', () => {
  const box = drag(256, 128);
  for (const shape of ['iso', 'iso-fixed'] as const) {
    for (const cells of [0, -3, 2.5, NaN, 201]) {
      assert.equal(gridFromEdge(box, shape, cells), null, `${cells} cells`);
    }
  }
  // And a run divided so finely that the cell falls under the floor, which is
  // the same refusal a too-small drag gets.
  assert.equal(gridFromEdge(drag(64, 32), 'iso-fixed', 40), null, 'slivers');
});

test('the count is what the chain of diamonds is drawn from', () => {
  // `drawCalibrationDiamond` steps `cells` diamonds along the drag using this
  // one, so a cell that disagreed with the committed lattice would be a
  // preview that lied over the whole run rather than in one tile.
  const box = drag(256, 128);
  const diamond = must(isoDiamond(box, 'iso-fixed', 4), 'four cells');
  const grid = must(gridFromEdge(box, 'iso-fixed', 4), 'four cells');
  assert.ok(Math.abs(grid.px - diamond.halfH * 2) < 1e-9, 'height');
  assert.ok(Math.abs(grid.ax - diamond.halfW) < 1e-9, 'width');
  // Four of them land on the far end of the drag, which is what makes a wrong
  // count visible against the art.
  assert.ok(Math.abs(diamond.halfW * 4 - 256) < 1e-9, 'the chain spans the drag');
});

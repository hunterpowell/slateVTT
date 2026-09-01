// The three coordinate spaces. CLAUDE.md calls this the hardest part of the
// client and says to verify it standalone; this is that, a milestone late.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gridBounds,
  gridToWorld,
  gridTransform,
  maxSpan,
  minSpan,
  playRect,
  screenToWorld,
  squareGrid,
  worldToGrid,
  worldToScreen,
} from './coords.js';

const CAMERAS = [
  { x: 0, y: 0, zoom: 1 },
  { x: 120, y: -40, zoom: 2 },
  { x: -7.5, y: 900.25, zoom: 0.3 },
];

test('screen and world are inverses at every camera', () => {
  for (const cam of CAMERAS) {
    for (const [sx, sy] of [
      [0, 0],
      [640, 480],
      [-13, 7.5],
    ] as const) {
      const world = screenToWorld(cam, sx, sy);
      const back = worldToScreen(cam, world.x, world.y);
      assert.ok(Math.abs(back.x - sx) < 1e-9, `x at zoom ${cam.zoom}`);
      assert.ok(Math.abs(back.y - sy) < 1e-9, `y at zoom ${cam.zoom}`);
    }
  }
});

test('the camera names the world point at the viewport corner', () => {
  const cam = { x: 120, y: -40, zoom: 2 };
  assert.deepEqual(screenToWorld(cam, 0, 0), { x: 120, y: -40 });
});

test('zoom is screen pixels per world pixel', () => {
  const cam = { x: 0, y: 0, zoom: 2 };
  assert.deepEqual(worldToScreen(cam, 10, 10), { x: 20, y: 20 });
});

test('grid and world are inverses, offset and all', () => {
  const grid = squareGrid(64, 17, -9);
  const world = gridToWorld(grid, 3, 4);
  assert.deepEqual(world, { x: 17 + 192, y: -9 + 256 });
  assert.deepEqual(worldToGrid(grid, world.x, world.y), { x: 3, y: 4 });
});

// The isometric lattice. A diamond grid is an affine image of a square one, so
// the tests below are the square ones asked of a sheared basis — and the square
// ones above still passing is what says the generalisation reduces.

/** A diamond `px` tall and `px * ratio` wide, as `gridBasis` builds one. */
function isoGrid(px: number, ratio: number, offsetX = 0, offsetY = 0) {
  const halfW = (px * ratio) / 2;
  const halfH = px / 2;
  return { px, ax: halfW, ay: halfH, bx: -halfW, by: halfH, offsetX, offsetY };
}

test('grid and world are inverses on a sheared lattice too', () => {
  const grid = isoGrid(64, 2, 11, -5);
  for (const [gx, gy] of [
    [0, 0],
    [3, 4],
    [-2.5, 7.25],
  ] as const) {
    const world = gridToWorld(grid, gx, gy);
    const back = worldToGrid(grid, world.x, world.y);
    assert.ok(Math.abs(back.x - gx) < 1e-9, `x at ${gx},${gy}`);
    assert.ok(Math.abs(back.y - gy) < 1e-9, `y at ${gx},${gy}`);
  }
});

test('an isometric cell is as wide as its ratio and as tall as px', () => {
  // The claim the DM's dragged edge rests on: one step along either axis goes
  // half the width across and half the height down, so the diamond the two span
  // is `px * ratio` by `px`. `fog::basis` on the server says the same thing.
  const grid = isoGrid(64, 2);
  assert.deepEqual(gridToWorld(grid, 1, 0), { x: 64, y: 32 });
  assert.deepEqual(gridToWorld(grid, 0, 1), { x: -64, y: 32 });
  assert.deepEqual(gridToWorld(grid, 1, 1), { x: 0, y: 64 });
});

test('a square grid is the basis it always was', () => {
  // The whole argument that no existing board moved: if this stops matching
  // `offset + n * px`, every token on every saved map is somewhere new.
  const grid = squareGrid(70, 3, -4);
  assert.deepEqual(gridToWorld(grid, 3.5, 12.5), { x: 3 + 245, y: -4 + 875 });
  assert.equal(minSpan(grid), 70);
  assert.equal(maxSpan(grid), 70, 'or every wall cull in the project changes');
});

test('the transform places a cell where gridToWorld says it does', () => {
  // The fog, the override tint, the shape fills and the ruler's trail are all
  // drawn as unit squares under this matrix rather than as rectangles at a
  // corner, so the two have to agree about where a cell is.
  for (const grid of [squareGrid(64, 10, -6), isoGrid(64, 2, 10, -6)]) {
    const [a, b, c, d, e, f] = gridTransform(grid);
    for (const [cx, cy] of [
      [0, 0],
      [2, 3],
      [-1, 4],
    ] as const) {
      const under = { x: a * cx + c * cy + e, y: b * cx + d * cy + f };
      assert.deepEqual(under, gridToWorld(grid, cx, cy), `cell ${cx},${cy}`);
    }
  }
});

test('a cell of grid distance never draws further than maxSpan', () => {
  // What the once-per-source wall culls bound themselves by, here and in
  // `px_per_cell` on the server. Too small and a wall that should block a ray is
  // dropped before it is ever tested.
  const grid = isoGrid(64, 2);
  const scale = maxSpan(grid);
  for (const [gx, gy] of [
    [1, 0],
    [0, 1],
    [0.707, 0.707],
    [0.707, -0.707],
  ] as const) {
    const at = gridToWorld(grid, gx, gy);
    assert.ok(Math.hypot(at.x, at.y) <= scale + 1e-6, `${gx},${gy} drew past the bound`);
  }
});

test('the extent of a rectangle in cells is unrounded on purpose', () => {
  // Its two callers round it differently and conflating them is a real bug, not
  // a tidy-up: ruling the grid wants the whole-numbered lines *inside* the
  // rectangle, and sweeping cells wants every cell it *touches*. Rounding the
  // low end up for the second takes a column off one side of a viewer and not
  // the other, which is what the solo circle test catches downstream.
  const square = squareGrid(64, 0, 0);
  const flat = gridBounds(square, { x: 32, y: 32, w: 128, h: 128 });
  assert.deepEqual(flat, { minX: 0.5, maxX: 2.5, minY: 0.5, maxY: 2.5 });

  // A sheared lattice is the case that says why this takes the corners. The
  // rectangle below is one diamond tall in pixels, and it reaches across *two*
  // rows of cells — because a row of diamonds does not run along the top edge of
  // the rectangle, it runs diagonally through it. Dividing `h` by `px` answers
  // one and is wrong; the four corners answer two.
  const diamond = gridBounds(isoGrid(64, 2), { x: -64, y: 0, w: 128, h: 64 });
  assert.deepEqual(diamond, { minX: -0.5, maxX: 1.5, minY: -0.5, maxY: 1.5 });
  assert.equal(diamond.maxY - diamond.minY, 2, 'two rows, for a rectangle one cell tall');
});

test('a null play area is the whole image', () => {
  assert.deepEqual(playRect(null, 800, 600), { x: 0, y: 0, w: 800, h: 600 });
});

test('a play area is clipped to the image on both sides', () => {
  // Oversized in every direction, which is what a stale save looks like. The
  // renderer rules one grid line per cell across this, so an unclipped one
  // costs frames rather than merely looking wrong.
  assert.deepEqual(playRect({ x: -10, y: -10, w: 1000, h: 1000 }, 50, 50), {
    x: 0,
    y: 0,
    w: 50,
    h: 50,
  });
  assert.deepEqual(playRect({ x: 10, y: 10, w: 1000, h: 1000 }, 50, 50), {
    x: 10,
    y: 10,
    w: 40,
    h: 40,
  });
});

test('a play area entirely off the image has no area rather than a negative one', () => {
  const clipped = playRect({ x: 100, y: 100, w: 10, h: 10 }, 50, 50);
  assert.equal(clipped.w, 0);
  assert.equal(clipped.h, 0);
});


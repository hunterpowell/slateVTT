// The three coordinate spaces. CLAUDE.md calls this the hardest part of the
// client and says to verify it standalone; this is that, a milestone late.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  firstLineAt,
  gridToWorld,
  playRect,
  screenToWorld,
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
  const grid = { px: 64, offsetX: 17, offsetY: -9 };
  const world = gridToWorld(grid, 3, 4);
  assert.deepEqual(world, { x: 17 + 192, y: -9 + 256 });
  assert.deepEqual(worldToGrid(grid, world.x, world.y), { x: 3, y: 4 });
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

test('the first grid line lands at or after the edge, never before it', () => {
  assert.equal(firstLineAt(10, 0, 64), 64);
  assert.equal(firstLineAt(0, 0, 64), 0, 'an exact multiple is already a line');
  assert.equal(firstLineAt(64, 0, 64), 64);
  assert.equal(firstLineAt(-10, 0, 64), 0, 'off the left of the map still rules forwards');
  assert.equal(firstLineAt(10, 17, 64), 17, 'the offset is where the lattice starts');
});

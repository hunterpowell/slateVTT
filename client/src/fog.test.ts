// The half of the fog that does not need a canvas.
//
// `fogFromWire` builds an actual `HTMLCanvasElement` and so belongs to the
// browser drivers; what is testable here is where the fog gets stretched to, and
// the one decision that differs between the two kinds of viewer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { darkFill, fogRect } from './fog.js';

const GRID = { px: 64, offsetX: 10, offsetY: -6 };

test('the fog rectangle lands on the grid it was packed against', () => {
  const rect = fogRect({ x: 2, y: 3, w: 4, h: 5, shade: null }, GRID);
  assert.deepEqual(rect, { x: 10 + 128, y: -6 + 192, w: 256, h: 320 });
});

test('an empty rectangle has no area to stretch anything over', () => {
  const rect = fogRect({ x: 0, y: 0, w: 0, h: 0, shade: null }, GRID);
  assert.equal(rect.w, 0);
  assert.equal(rect.h, 0);
});

test("the DM's board stays legible where the party's goes solid", () => {
  // The same bargain masonry already makes on their screen: a faint wash says
  // "the party cannot see this" without hiding the monster about to be moved
  // into it. It is why the DM is sent the fog at all.
  assert.equal(darkFill(false), 'rgba(11, 13, 16, 1)');
  assert.equal(darkFill(true), 'rgba(11, 13, 16, 0.42)');
});

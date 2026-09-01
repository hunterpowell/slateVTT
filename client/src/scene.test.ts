// `gridBasis` and `shapeOf`, which are the two halves of one conversion: the
// wire carries a shape descriptor and the renderer wants two cell axes.
//
// They are the only place either representation is read, so a disagreement
// between them is a disagreement about where every cell on the board is.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gridBasis, shapeOf } from './scene.js';
import type { WireGridShape, WireMapInfo } from './protocol.js';

function wireMap(grid_px: number, grid_shape: WireGridShape): WireMapInfo {
  return {
    url: '/uploads/map.png',
    grid_px,
    offset_x: 11,
    offset_y: -5,
    grid_color: '#ffffff52',
    play_area: null,
    fog: false,
    vision_ft: 60,
    lighting: 'dynamic',
    grid_shape,
  };
}

test('a square map builds the basis it always had', () => {
  // The whole argument that no existing board moved: a save with no shape on it
  // deserializes as `square`, and this is what that then draws as.
  const grid = gridBasis(wireMap(64, { kind: 'square' }));
  assert.deepEqual(grid, { px: 64, ax: 64, ay: 0, bx: 0, by: 64, offsetX: 11, offsetY: -5 });
});

test('an isometric map builds a diamond of the right proportions', () => {
  // `fog::basis` in Rust says the same thing about the same numbers, and the fog
  // the server packs lands on this basis — so the two agreeing is what stops the
  // shadows falling a cell away from the walls that cast them.
  const grid = gridBasis(wireMap(64, { kind: 'iso', ratio: 2 }));
  assert.deepEqual(grid, { px: 64, ax: 64, ay: 32, bx: -64, by: 32, offsetX: 11, offsetY: -5 });
});

test('a grid survives the round trip through the wire', () => {
  // The client draws with a basis and has to send a *shape* back, so `shapeOf`
  // is `gridBasis` read backwards. Anything that builds a `GridSpec` by hand
  // rather than through `squareGrid` or `gridFromEdge` is what would break it.
  for (const shape of [
    { kind: 'square' },
    { kind: 'iso', ratio: 2 },
    { kind: 'iso', ratio: 0.5 },
  ] as const) {
    const grid = gridBasis(wireMap(48, shape));
    assert.deepEqual(shapeOf(grid), shape);
  }
});

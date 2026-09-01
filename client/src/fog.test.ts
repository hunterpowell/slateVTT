// The half of the fog that does not need a canvas.
//
// `fogFromWire` builds an actual `HTMLCanvasElement` and so belongs to the
// browser drivers; what is testable here is where the fog gets stretched to, and
// the one decision that differs between the two kinds of viewer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { darkFill } from './fog.js';


test("the DM's board stays legible where the party's goes solid", () => {
  // The same bargain masonry already makes on their screen: a faint wash says
  // "the party cannot see this" without hiding the monster about to be moved
  // into it. It is why the DM is sent the fog at all.
  assert.equal(darkFill(false), 'rgba(11, 13, 16, 1)');
  assert.equal(darkFill(true), 'rgba(11, 13, 16, 0.42)');
});

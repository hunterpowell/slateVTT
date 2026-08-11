// The movement ruler: the two diagonal conventions, the trail, and the little
// state machine that decides which rulers are on screen.
//
// The trail tests are the point of this file. `docs/drawings.md` claims the
// trail is "a picture of the number" — that a rasterised line is exactly
// `max + 1` cells against a reading of `max × 5`, from the same two integers,
// so the two cannot disagree. That is an arithmetic identity that was asserted
// only in prose until here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createRulers, feetMoved, rulerAlpha, trailCells } from './ruler.js';

const at = (x: number, y: number) => ({ x, y });
const ORIGIN = at(0, 0);

// Enough vectors to be a property rather than three examples, and fixed rather
// than random so a failure is the same failure tomorrow.
const MOVES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 0], [3, 0], [0, -4], [1, 1], [3, 3], [-2, -2],
  [4, 2], [2, 4], [-5, 3], [7, 1], [6, 6], [9, 4], [-8, -3],
];

test('a straight move costs one cell a square', () => {
  assert.equal(feetMoved(ORIGIN, at(3, 0), 'equal'), 15);
  assert.equal(feetMoved(ORIGIN, at(0, -4), 'equal'), 20);
});

test('equal charges a diagonal step the same as a straight one', () => {
  assert.equal(feetMoved(ORIGIN, at(3, 3), 'equal'), 15);
  assert.equal(feetMoved(ORIGIN, at(4, 2), 'equal'), 20, 'two diagonals then two straight');
});

test('alternating doubles every second diagonal, counted from this reading', () => {
  assert.equal(feetMoved(ORIGIN, at(1, 1), 'alternating'), 5, 'the first diagonal costs five');
  assert.equal(feetMoved(ORIGIN, at(2, 2), 'alternating'), 15);
  assert.equal(feetMoved(ORIGIN, at(3, 3), 'alternating'), 20);
  assert.equal(feetMoved(ORIGIN, at(4, 4), 'alternating'), 30);
});

test('the two conventions agree on anything with no diagonal in it', () => {
  for (const [dx, dy] of MOVES) {
    if (dx !== 0 && dy !== 0) continue;
    assert.equal(
      feetMoved(ORIGIN, at(dx, dy), 'equal'),
      feetMoved(ORIGIN, at(dx, dy), 'alternating'),
    );
  }
});

test('every reading is a multiple of five, which is what the table says out loud', () => {
  for (const [dx, dy] of MOVES) {
    for (const mode of ['equal', 'alternating'] as const) {
      const feet = feetMoved(ORIGIN, at(dx, dy), mode);
      assert.equal(feet % 5, 0, `${dx},${dy} under ${mode} read ${feet}`);
    }
  }
});

test('a part-way drag is rounded to whole cells before it is counted', () => {
  // A drag frame arrives wherever the pointer is, not on a lattice.
  assert.equal(feetMoved(at(1.5, 1.5), at(4.4, 1.6), 'equal'), 15);
  assert.equal(feetMoved(at(1.5, 1.5), at(4.6, 1.4), 'equal'), 15);
});

test('the trail is the reading, drawn: max + 1 cells against max x 5 feet', () => {
  for (const [dx, dy] of MOVES) {
    const from = at(2.5, 2.5);
    const to = at(2.5 + dx, 2.5 + dy);
    const cells = trailCells(from, to).length / 2;
    const feet = feetMoved(from, to, 'equal');
    assert.equal(cells, feet / 5 + 1, `${dx},${dy} lit ${cells} cells for ${feet} ft`);
  }
});

test('a move that goes nowhere leaves no trail', () => {
  assert.deepEqual(trailCells(at(3.5, 3.5), at(3.5, 3.5)), []);
  assert.deepEqual(trailCells(at(3.5, 3.5), at(3.6, 3.4)), [], 'nor does a twitch');
});

test('dragging the same line backwards lights the same squares', () => {
  for (const [dx, dy] of MOVES) {
    const from = at(2.5, 2.5);
    const to = at(2.5 + dx, 2.5 + dy);
    const forward = pairs(trailCells(from, to)).sort().join(' ');
    const back = pairs(trailCells(to, from)).sort().join(' ');
    assert.equal(back, forward, `${dx},${dy}`);
  }
});

test('the trail starts in the cell the token left and ends in the one it reached', () => {
  const cells = pairs(trailCells(at(2.5, 2.5), at(6.5, 4.5)));
  assert.equal(cells[0], '2,2');
  assert.equal(cells[cells.length - 1], '6,4');
});

test('a ruler is solid while it runs and fades once it has landed', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false);
  assert.equal(rulerAlpha(must(rulers.active(0).get('t1'), 'a live ruler'), 0), 1);

  rulers.end('t1', 1_000);
  const landed = must(rulers.active(1_000).get('t1'), 'a landed ruler');
  assert.equal(rulerAlpha(landed, 1_000), 1);
  assert.equal(rulerAlpha(landed, 2_000), 0.5);
  assert.equal(rulerAlpha(landed, 3_000), 0);
});

test('a drop starts a ruler fading rather than deleting it', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false);
  rulers.end('t1', 0);
  assert.ok(rulers.active(1_999).has('t1'), 'still lingering');
  assert.ok(!rulers.active(2_001).has('t1'), 'gone once it has faded');
});

test('a second drop does not restart the fade on a move nobody made', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false);
  rulers.end('t1', 0);
  rulers.end('t1', 1_500);
  assert.ok(!rulers.active(2_001).has('t1'));
});

test('a landed ruler is not also swept as stale', () => {
  // The two clocks. `STALE_MS` is a guess about a client that vanished mid-drag;
  // a ruler that has landed has stopped receiving frames by definition, so
  // applying that guess to it would delete the trail everyone is looking at.
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), false, 0);
  rulers.end('t1', 20_000);
  assert.ok(rulers.active(20_001).has('t1'), 'landed long after the last drag frame');
});

test('a watcher keeps the origin from the first frame it saw', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), false, 0);
  rulers.seen('t1', at(4, 4), false, 100);
  const ruler = rulers.active(100).get('t1');
  assert.deepEqual(ruler?.from, { x: 1, y: 1 }, 'measured from itself otherwise');
});

test('a fresh drag on a still-fading ruler takes the new origin', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), false, 0);
  rulers.end('t1', 100);
  rulers.seen('t1', at(4, 4), false, 200);
  const ruler = rulers.active(200).get('t1');
  assert.deepEqual(ruler?.from, { x: 4, y: 4 });
  assert.equal(ruler?.endedAt, null, 'running again, not still fading');
});

test('a drag nobody has sent a frame for in a long while is dropped', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), false, 0);
  assert.ok(rulers.active(14_999).has('t1'), 'a pause is not a disconnection');
  assert.ok(!rulers.active(15_001).has('t1'));
});

test('our own drag never goes stale, having a pointerup to end it', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false);
  assert.ok(rulers.active(10_000_000).has('t1'));
});

test('a token that vanished mid-drag takes its trail with it', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false);
  rulers.forget('t1');
  assert.ok(!rulers.active(0).has('t1'), 'a line pointing at where it went, otherwise');
});

/** `assert.ok` is declared without `asserts`, deliberately — narrowing would
 *  make every call site need an explicit type annotation. This is the one place
 *  a test wants the narrowing, so it says so. */
function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function pairs(flat: readonly number[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flat.length; i += 2) out.push(`${flat[i]},${flat[i + 1]}`);
  return out;
}

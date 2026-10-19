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

import { createRulers, feetMoved, rulerAlpha, slideDuration, slidePos, trailCells } from './ruler.js';

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
  rulers.begin('t1', at(1, 1), false, true);
  assert.equal(rulerAlpha(must(rulers.active(0).get('t1'), 'a live ruler'), 0), 1);

  rulers.end('t1', at(1, 1), 1_000);
  const landed = must(rulers.active(1_000).get('t1'), 'a landed ruler');
  assert.equal(rulerAlpha(landed, 1_000), 1);
  assert.equal(rulerAlpha(landed, 2_000), 0.5);
  assert.equal(rulerAlpha(landed, 3_000), 0);
});

test('a drop starts a ruler fading rather than deleting it', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false, true);
  rulers.end('t1', at(1, 1), 0);
  assert.ok(rulers.active(1_999).has('t1'), 'still lingering');
  assert.ok(!rulers.active(2_001).has('t1'), 'gone once it has faded');
});

test('a second drop does not restart the fade on a move nobody made', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false, true);
  rulers.end('t1', at(1, 1), 0);
  rulers.end('t1', at(1, 1), 1_500);
  assert.ok(!rulers.active(2_001).has('t1'));
});

test('a landed ruler is not also swept as stale', () => {
  // The two clocks. `STALE_MS` is a guess about a client that vanished mid-drag;
  // a ruler that has landed has stopped receiving frames by definition, so
  // applying that guess to it would delete the trail everyone is looking at.
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), at(1, 1), false, 0);
  rulers.end('t1', at(1, 1), 20_000);
  assert.ok(rulers.active(20_001).has('t1'), 'landed long after the last drag frame');
});

test('a watcher keeps the origin from the first frame it saw', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), at(1, 1), false, 0);
  rulers.seen('t1', at(4, 4), at(4, 4), false, 100);
  const ruler = rulers.active(100).get('t1');
  assert.deepEqual(ruler?.from, { x: 1, y: 1 }, 'measured from itself otherwise');
});

test('a fresh drag on a still-fading ruler takes the new origin', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), at(1, 1), false, 0);
  rulers.end('t1', at(1, 1), 100);
  rulers.seen('t1', at(4, 4), at(4, 4), false, 200);
  const ruler = rulers.active(200).get('t1');
  assert.deepEqual(ruler?.from, { x: 4, y: 4 });
  assert.equal(ruler?.endedAt, null, 'running again, not still fading');
});

test('a drag nobody has sent a frame for in a long while is dropped', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), at(1, 1), false, 0);
  assert.ok(rulers.active(14_999).has('t1'), 'a pause is not a disconnection');
  assert.ok(!rulers.active(15_001).has('t1'));
});

test('our own drag never goes stale, having a pointerup to end it', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false, true);
  assert.ok(rulers.active(10_000_000).has('t1'));
});

test('a token that vanished mid-drag takes its trail with it', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false, true);
  rulers.forget('t1');
  assert.ok(!rulers.active(0).has('t1'), 'a line pointing at where it went, otherwise');
});

test('a watcher ghost follows each frame while the token stays at the origin', () => {
  const rulers = createRulers();
  rulers.seen('t1', at(1, 1), at(2, 1), false, 0);
  rulers.seen('t1', at(1, 1), at(5, 3), false, 100);
  const ruler = must(rulers.active(100).get('t1'), 'a live ruler');
  assert.deepEqual(ruler.from, { x: 1, y: 1 });
  assert.deepEqual(ruler.to, { x: 5, y: 3 }, 'the latest frame');
  assert.equal(ruler.measured, true, 'a watcher measures every token it sees moving');
});

test('our own ghost starts on the token and follows aim', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false, true);
  assert.deepEqual(rulers.active(0).get('t1')?.to, { x: 1, y: 1 });
  rulers.aim('t1', at(3, 4));
  assert.deepEqual(rulers.active(0).get('t1')?.to, { x: 3, y: 4 });
});

test('a group member other than the anchor is a ghost without a reading', () => {
  const rulers = createRulers();
  rulers.begin('anchor', at(1, 1), false, true);
  rulers.begin('other', at(2, 1), false, false);
  assert.equal(rulers.active(0).get('anchor')?.measured, true);
  assert.equal(rulers.active(0).get('other')?.measured, false);
});

test('a drop clears the ghost, and aim cannot bring it back', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(1, 1), false, true);
  rulers.aim('t1', at(3, 1));
  rulers.end('t1', at(1, 1), 0);
  assert.equal(rulers.active(0).get('t1')?.to, null, 'the token is at the far end now');
  rulers.aim('t1', at(6, 1));
  assert.equal(rulers.active(0).get('t1')?.to, null, 'a landed move does not move again');
});

test('a slide takes longer the further it goes, up to a cap', () => {
  assert.equal(slideDuration(at(1.5, 1.5), at(1.5, 1.5)), 0, 'nothing to slide');
  assert.equal(slideDuration(at(1.5, 1.5), at(2.5, 1.5)), 150);
  assert.equal(slideDuration(at(1.5, 1.5), at(4.5, 4.5)), 450, 'a diagonal counts its cells');
  assert.equal(slideDuration(at(1.5, 1.5), at(40.5, 1.5)), 1_500, 'a long dash is capped');
});

test('a landed token slides from its origin to where it is, and stops there', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(0, 0), false, true);
  rulers.end('t1', at(4, 0), 1_000); // 600ms
  const ruler = must(rulers.active(1_000).get('t1'), 'a landed ruler');
  const dest = at(4, 0);

  assert.deepEqual(slidePos(ruler, dest, 1_000), { x: 0, y: 0 }, 'it starts at the origin');
  const half = slidePos(ruler, dest, 1_300).x;
  assert.ok(half > 2 && half < 4, `eases out, so it is past halfway at half time (${half})`);
  assert.deepEqual(slidePos(ruler, dest, 1_600), dest, 'and arrives on time');
  assert.deepEqual(slidePos(ruler, dest, 9_000), dest);
});

test('a token is drawn where it is while its drag still runs', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(0, 0), false, true);
  rulers.aim('t1', at(4, 0));
  const ruler = must(rulers.active(0).get('t1'), 'a live ruler');
  assert.deepEqual(slidePos(ruler, at(0, 0), 0), { x: 0, y: 0 });
});

test('the trail holds while the token slides, and fades once it has arrived', () => {
  const rulers = createRulers();
  rulers.begin('t1', at(0, 0), false, true);
  rulers.end('t1', at(10, 0), 0); // 1500ms
  const ruler = must(rulers.active(0).get('t1'), 'a landed ruler');
  assert.equal(rulerAlpha(ruler, 1_400), 1, 'still sliding');
  assert.equal(rulerAlpha(ruler, 2_500), 0.5, 'halfway through the fade');
  assert.ok(rulers.active(3_400).has('t1'));
  assert.ok(!rulers.active(3_600).has('t1'), 'gone once slide and fade are both over');
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

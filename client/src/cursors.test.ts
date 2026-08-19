// The half of cursors that needs no canvas and no socket: one pointer per
// person, and what stillness does to one.
//
// What is *not* here is the part that matters most and cannot be tested from a
// single process — that the DM's pointer over unexplored ground never reaches a
// player's board. That assertion is a *frame that did not arrive*, so it lives
// in the server suite (`room/tests/cursors.rs`) and in `tools/drive-cursors.mjs`,
// which is the only thing that can ask two real browsers about it at once.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Cursor } from './cursors.js';
import { createCursors, cursorAlpha } from './cursors.js';
import type { Owner } from './protocol.js';

const SAELYN: Owner = { kind: 'player', id: 'saelyn' };
const CLEODARA: Owner = { kind: 'player', id: 'cleodara' };
const DM: Owner = { kind: 'dm' };

/** The one pointer on the board. `assert.ok` does not narrow — see
 *  `testing.d.ts` — so this unwraps by throwing instead. */
function only(cursors: readonly Cursor[]): Cursor {
  const [cursor] = cursors;
  if (cursors.length !== 1 || cursor === undefined) {
    throw new Error(`expected exactly one pointer, found ${cursors.length}`);
  }
  return cursor;
}

test('a second frame from one person moves their pointer rather than adding one', () => {
  const cursors = createCursors();
  cursors.moved(SAELYN, { x: 1, y: 1 }, 0);
  cursors.moved(SAELYN, { x: 4, y: 2 }, 50);

  // The whole difference from a ping, which is an event and accumulates. A hand
  // is somewhere, and it is only ever in one place.
  assert.deepEqual(only(cursors.active(60)).at, { x: 4, y: 2 });
});

test('everybody gets their own', () => {
  const cursors = createCursors();
  cursors.moved(SAELYN, { x: 1, y: 1 }, 0);
  cursors.moved(CLEODARA, { x: 2, y: 2 }, 0);
  cursors.moved(DM, { x: 3, y: 3 }, 0);

  assert.equal(cursors.active(10).length, 3);
});

test('the DM and a player called nothing are not the same pointer', () => {
  // `keyOf` is shared with the presence strip precisely so this cannot drift:
  // one answer to "is this the same person", used by everything that keys on it.
  const cursors = createCursors();
  cursors.moved(DM, { x: 1, y: 1 }, 0);
  cursors.moved({ kind: 'player', id: 'dm' }, { x: 9, y: 9 }, 0);

  assert.equal(cursors.active(10).length, 2);
});

test('stillness ends a pointer, and nothing on the wire has to say so', () => {
  const cursors = createCursors();
  cursors.moved(SAELYN, { x: 1, y: 1 }, 0);

  assert.equal(cursors.active(100).length, 1, 'still fresh');
  assert.equal(cursors.active(10_000).length, 0, 'and gone by itself');
  assert.equal(
    cursors.active(10_050).length,
    0,
    'and it stays gone — a hand that stopped is not a hand that keeps stopping',
  );
});

test('a pointer that comes back is a fresh one', () => {
  // Somebody who read for a while and then moved again. Nothing about the fade
  // it went through is remembered, which is what makes the reappearance a pop
  // rather than a slow return from zero.
  const cursors = createCursors();
  cursors.moved(SAELYN, { x: 1, y: 1 }, 0);
  assert.equal(cursors.active(10_000).length, 0);

  cursors.moved(SAELYN, { x: 5, y: 5 }, 10_100);
  assert.equal(cursorAlpha(only(cursors.active(10_100)), 10_100), 1);
});

test('it fades out rather than vanishing', () => {
  const cursors = createCursors();
  cursors.moved(SAELYN, { x: 1, y: 1 }, 0);

  const at = (now: number): number => cursorAlpha(only(cursors.active(now)), now);
  assert.equal(at(500), 1, 'full while it is fresh');

  const going = at(2200);
  assert.ok(going > 0 && going < 1, `expected a partial fade, got ${going}`);
  assert.ok(at(2400) < going, 'and it keeps going out');
});

test('the switch going off takes every pointer with it', () => {
  // Without this the pointers already on screen would linger for their
  // remaining life after the room said to stop drawing them, which reads as the
  // switch not having worked.
  const cursors = createCursors();
  cursors.moved(SAELYN, { x: 1, y: 1 }, 0);
  cursors.moved(DM, { x: 2, y: 2 }, 0);

  cursors.clear();

  assert.equal(cursors.active(10).length, 0);
});

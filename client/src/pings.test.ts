// The half of ping that does not need a canvas or a socket: the lifecycle of a
// ring, who a ring belongs to, and where one goes when it is off the screen.
//
// What is *not* here is the gesture itself. Separating a hold from a click by
// duration needs real pointer events and a real clock, so that lives in
// `tools/drive-ping.mjs`, which is also the only thing that can see the one
// assertion this feature is actually about — that a second connection got the
// ring.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EdgeMarker, Ping } from './pings.js';
import {
  colourOf,
  createPings,
  edgeMarker,
  GROW_FROM_MS,
  HOLD_MS,
  nameOf,
  PLAYER_HUES,
  ringAlpha,
  ringRadius,
} from './pings.js';
import type { Colours, Owner, RosterEntry } from './protocol.js';

const ME: Owner = { kind: 'player', id: 'saelyn' };
const ROSTER: RosterEntry[] = [
  { id: 'cleodara', name: 'Cleodara' },
  { id: 'saelyn', name: 'Saelyn' },
  { id: 'torrin', name: 'Torrin' },
];

const VIEW = { width: 800, height: 600 };

/** The one ring on the board. `assert.ok` deliberately does not narrow here —
 *  see `testing.d.ts` — so these two unwrap by throwing instead. */
function only(rings: readonly Ping[]): Ping {
  const [ring] = rings;
  if (rings.length !== 1 || ring === undefined) {
    throw new Error(`expected exactly one ring, found ${rings.length}`);
  }
  return ring;
}

function pointer(at: { x: number; y: number }, view = VIEW, inset = 34): EdgeMarker {
  const marker = edgeMarker(at, view, inset);
  if (marker === null) throw new Error('expected an arrow, got none');
  return marker;
}

// --- the hold -------------------------------------------------------------

test('a hold is drawn before it fires, so 400ms of nothing never happens', () => {
  const pings = createPings(ME);
  pings.hold({ x: 3, y: 4 }, 0);

  const held = only(pings.active(GROW_FROM_MS + 50));
  assert.ok(ringRadius(held, GROW_FROM_MS + 50) > 0, 'a hold draws like a ping');
  // And not before: a ring that appeared instantly would flash on every click.
  assert.equal(ringRadius(held, GROW_FROM_MS - 1), 0);
});

test('a hold that is dropped leaves nothing behind', () => {
  const pings = createPings(ME);
  pings.hold({ x: 3, y: 4 }, 0);
  pings.drop();

  assert.equal(pings.active(200).length, 0);
  assert.equal(pings.commit(), null, 'there is nothing left to fire');
});

test('firing does not restart the ring it has been drawing', () => {
  // The whole reason `startedAt` is the button going down rather than the
  // moment it fires: the preview and the landed ring are one drawing, so
  // nothing on screen jumps, blinks or regrows at the instant it commits.
  const pings = createPings(ME);
  pings.hold({ x: 3, y: 4 }, 0);
  const grown = ringRadius(only(pings.active(HOLD_MS)), HOLD_MS);

  assert.deepEqual(pings.commit(), { x: 3, y: 4 });

  const landed = only(pings.active(HOLD_MS));
  assert.equal(ringRadius(landed, HOLD_MS), grown);
  assert.deepEqual(landed.owner, ME, 'our own ring is attributed to us');
});

test('a ring is full size by the time it fires', () => {
  const pings = createPings(ME);
  pings.hold({ x: 0, y: 0 }, 0);
  const held = only(pings.active(HOLD_MS));
  // Not a magic number: whatever the radius is, the growth is over by now, so
  // waiting longer must not make it bigger.
  assert.equal(ringRadius(held, HOLD_MS), ringRadius(held, HOLD_MS + 500));
});

// --- the life of a ring ---------------------------------------------------

test('a ring fades out and is then dropped from the list', () => {
  const pings = createPings(ME);
  pings.add({ kind: 'dm' }, { x: 1, y: 1 }, 0);

  const ring = only(pings.active(1_000));
  assert.equal(ringAlpha(ring, 1_000), 1, 'full for most of its life');

  // Somewhere in the fade: dimmer than full, and still there.
  const dimmed = ringAlpha(ring, 2_400);
  assert.ok(dimmed > 0 && dimmed < 1, `expected a partial fade, got ${dimmed}`);

  assert.equal(pings.active(10_000).length, 0, 'and then it is gone');
});

test('the hold rides along with the rings and does not displace them', () => {
  const pings = createPings(ME);
  pings.add({ kind: 'dm' }, { x: 1, y: 1 }, 0);
  pings.hold({ x: 9, y: 9 }, 0);

  assert.equal(pings.active(200).length, 2);
  pings.commit();
  assert.equal(pings.active(200).length, 2, 'committing moves it, it does not copy it');
});

// --- who a ring belongs to ------------------------------------------------

/** Nobody has picked. The default table, and what a room that predates the
 *  feature holds. */
const UNPICKED: Colours = {};

test('every roster slot gets its own colour and the DM gets a seventh', () => {
  const hues = ROSTER.map((slot) => colourOf({ kind: 'player', id: slot.id }, ROSTER, UNPICKED));
  assert.equal(new Set(hues).size, ROSTER.length, 'no two players share a hue');
  assert.ok(!hues.includes(colourOf({ kind: 'dm' }, ROSTER, UNPICKED)), 'nor does the DM');
});

test('a colour nobody picked is derived, so every client agrees without being told', () => {
  // The argument for indexing the roster rather than putting a colour on the
  // wire: two clients holding the same roster cannot disagree. Still the
  // default, and still what an empty table means.
  const owner: Owner = { kind: 'player', id: 'torrin' };
  assert.equal(colourOf(owner, ROSTER, UNPICKED), colourOf(owner, [...ROSTER], UNPICKED));
});

test('a picked colour wins over the roster position', () => {
  const torrin: Owner = { kind: 'player', id: 'torrin' };
  const saelyn: Owner = { kind: 'player', id: 'saelyn' };
  const picked: Colours = { torrin: 0 };

  assert.equal(colourOf(torrin, ROSTER, picked), PLAYER_HUES[0]);
  assert.notEqual(
    colourOf(torrin, ROSTER, picked),
    colourOf(torrin, ROSTER, UNPICKED),
    'and it is not what their slot would have given them',
  );
  assert.equal(
    colourOf(saelyn, ROSTER, picked),
    colourOf(saelyn, ROSTER, UNPICKED),
    'somebody else picking does not move anybody',
  );
});

test('two people may pick the same colour, and neither is refused it', () => {
  // The name written beside a ring is what tells them apart, which is why
  // nothing on either side of the wire checks for this.
  const picked: Colours = { torrin: 2, saelyn: 2 };
  assert.equal(
    colourOf({ kind: 'player', id: 'torrin' }, ROSTER, picked),
    colourOf({ kind: 'player', id: 'saelyn' }, ROSTER, picked),
  );
});

test('the DM keeps their own hue whatever the table says', () => {
  // The server refuses a `set_colour` from the DM, so no such entry can exist —
  // and this is the other half of that rule, kept where it decides what draws.
  const claimed: Colours = { dm: 0 };
  assert.equal(colourOf({ kind: 'dm' }, ROSTER, claimed), colourOf({ kind: 'dm' }, ROSTER, UNPICKED));
});

test('a ring is labelled with the roster name and not the slug', () => {
  assert.equal(nameOf({ kind: 'player', id: 'saelyn' }, ROSTER), 'Saelyn');
  assert.equal(nameOf({ kind: 'dm' }, ROSTER), 'DM');
  // A sender this client has never heard of still draws, attributed to
  // something rather than to nobody.
  assert.equal(nameOf({ kind: 'player', id: 'stranger' }, ROSTER), 'stranger');
  assert.ok(colourOf({ kind: 'player', id: 'stranger' }, ROSTER, UNPICKED).startsWith('#'));
});

// --- the arrow at the edge ------------------------------------------------

test('a ping on screen gets no arrow, because the ring is doing the work', () => {
  assert.equal(edgeMarker({ x: 400, y: 300 }, VIEW, 34), null);
  assert.equal(edgeMarker({ x: 50, y: 50 }, VIEW, 34), null);
});

test('a ping off the edge is pointed at from inside the edge', () => {
  // Straight up from the middle of the view: the arrow lands at the top,
  // horizontally centred, inset by the room its head needs.
  const up = pointer({ x: 400, y: -5_000 });
  assert.equal(up.at.x, 400);
  assert.equal(up.at.y, 34);
  assert.equal(up.angle, -Math.PI / 2, 'and it points at the ping');
});

test('an arrow leaves by whichever edge the line to the ping actually crosses', () => {
  // Far to the right and slightly down. Bounded by x, so it lands on the right
  // edge rather than in the corner — which is the whole reason the crossing is
  // computed rather than each axis clamped on its own.
  const right = pointer({ x: 10_000, y: 400 });
  assert.equal(right.at.x, VIEW.width - 34);
  assert.ok(right.at.y > 300 && right.at.y < 320, `hugging the middle, got ${right.at.y}`);
});

test('an arrow stays on screen however narrow the window is', () => {
  // An inset wider than the view would turn the rectangle inside out and put
  // every arrow somewhere behind the camera.
  const narrow = pointer({ x: -900, y: 40 }, { width: 40, height: 30 });
  assert.ok(narrow.at.x >= 0 && narrow.at.x <= 40, `x within the view, got ${narrow.at.x}`);
  assert.ok(narrow.at.y >= 0 && narrow.at.y <= 30, `y within the view, got ${narrow.at.y}`);
});

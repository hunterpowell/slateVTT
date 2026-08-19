// Drives the ping: the hold that fires, the clicks that must still work, and
// the ring landing on somebody else's screen.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-ping.mjs                      # or: ... http://host:port secret
//
// It runs against a live room and changes it — nothing here persists, but the
// token it builds does if the run dies before tidying up. Point it at a scratch
// `SLATE_STATE`.
//
// Why a browser, and why two. The gesture separates from an ordinary click by
// **duration**, which no unit test can see: `pings.test.ts` can assert what a
// ring does once it exists, and only a real pointer held down for real
// milliseconds can assert that holding one fires and clicking one does not. And
// the thing the milestone is actually for — six people looking at different
// parts of the map, one of them pointing — exists only on a *second* connection.
// One browser cannot tell a relayed ring from a local one.
//
// The sharpest check here is the fog one, and it is the opposite shape from
// every other negative assertion in these drivers: what is asserted is that
// something the table cannot normally see *does* reach them. A ping is relayed
// wherever it lands, unexplored ground included, and it is safe because there is
// nothing in it to read but a position. See *Ping* in `docs/drawings.md`.

import { open, checks } from './cdp.mjs';
import { latticeOrBail, tokenAt, findToken, emptyCell } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?dm=${secret}`, { port: 9333 });
const player = await open(base, { port: 9334 });
const { check, note, verdict } = checks();

await dm.evaluate('window.confirm = () => true; "ok"');
await dm.wait(2500); // the map image, the socket, and the first frame

await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);
check(
  'the player is on the board',
  await player.evaluate('document.querySelector("#whoami-name").textContent'),
  'Saelyn',
);

const tab = (name) =>
  dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(t => t.textContent.trim().toLowerCase().startsWith('${name}')).click(); "ok"`);

// **Pointers go off for the length of this script**, and it is not tidiness.
// Milestone 28 draws everybody else's cursor on the board, so the DM's dot lands
// on the player's canvas wherever the DM's mouse was last left — which is the
// middle of every pixel box measured below, because the mouse is left exactly
// where the thing being asserted happened. It decays on its own timer, so a
// baseline remembered while it is up and read once it has gone reports a
// difference that has nothing to do with a ring. That is what it did: two checks
// failed the day cursors landed, and both were the dot rather than the ping.
//
// `drive-cursors.mjs` is where the pointer is the subject. Here it is noise, and
// the room has a switch for exactly this.
await tab('table');
const cursorsWere = await dm.evaluate('document.querySelector("#table-cursors").checked');
if (cursorsWere) {
  await dm.evaluate('document.querySelector("#table-cursors").click(); "ok"');
  await dm.wait(600);
}
note(`pointers were ${cursorsWere ? 'on, and are off for this run' : 'already off'}`);

/**
 * Both clients' grids, and the two reasons there are two of them.
 *
 * A ring is made at a place on the *board* and has to be found again on someone
 * else's screen, and the two screens do not agree about where that is: the
 * player has no left rail, so a different canvas and a different framing from
 * the very first frame. A box in the DM's pixels aimed at the player's canvas is
 * the check that passes for the wrong reason — it reads an area where nothing
 * was going to happen and calls the silence a result. A cell is the only thing
 * both clients name identically, so it is what crosses between them here.
 *
 * **Neither is zoomed**, which is the other half. This script's distances are
 * deliberate: a spot far enough from the party to still be dark, and a ring
 * whose size on screen is what `RING_SHARE` was measured against. Zooming in to
 * make a token easier to click would move both, and the fog check — the sharpest
 * one here — would go quiet by skipping itself rather than by failing. Clicking
 * the middle of a *cell* is exact at any zoom, which is all this needs.
 */
const framed = { zoom: false };
const dmGrid = await latticeOrBail(dm, [dm, player], framed);
const playerGrid = await latticeOrBail(player, [dm, player], framed);
note(`the DM: ${dmGrid.describe}`);
note(`the player: ${playerGrid.describe}`);

/** Remembers a rectangle of a canvas so the next call can count what moved.
 *
 *  Differences rather than absolute readings, which is the rule these drivers
 *  learned the hard way: how bright a patch of board *is* depends on what the
 *  map art was painted, and a ring is a thin stroke over whatever was there. */
const remember = (session, x, y, w, h) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    window.__box = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    return 'ok';
  })()`);

const movedSince = (session, x, y, w, h) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const now = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    const was = window.__box;
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - was[i]) + Math.abs(now[i+1] - was[i+1]) + Math.abs(now[i+2] - was[i+2]) > 10) n++;
    }
    return n / (now.length / 4);
  })()`);

const press = (session, x, y) =>
  session.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });

const release = (session, x, y) =>
  session.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });

/** Press, wait past HOLD_MS, release. The gesture, at the only speed that
 *  makes it one. */
const hold = async (session, x, y, ms = 700) => {
  await press(session, x, y);
  await session.wait(ms);
  await release(session, x, y);
};

// A ring is a stroke and a word rather than a filled area, so it moves a small
// share of the box it sits in. Half a percent of a box a little larger than the
// ring is comfortably above the noise of a still canvas, which is zero.
const RING_SHARE = 0.005;
/** A box around the ring: it is 34 screen pixels across with a name under it. */
const BOX = 110;
const boxAt = (x, y) => [x - BOX / 2, y - BOX / 2, BOX, BOX];

// --- a hold pings, and both screens show it ---------------------------------
//
// Fog stays exactly as the room has it. Unlike the ruler driver this one has no
// reason to turn it off, and one very good reason not to: whether the party can
// see the cell being pointed at is the question two checks below.

/** Where a cell falls on one client's screen. */
const at = (grid, cell) => {
  const [x, y] = grid.screenOfCell(cell.x, cell.y);
  return { x, y };
};

// Somewhere with nothing on it, so a hold cannot land on a token and nothing
// else on the board is animating inside the box being measured. The offset is
// still in pixels, because what it wants is a clear patch of *canvas*; what it
// resolves to is a cell, because that is the part the other browser has to
// agree with. Searched outward from there rather than trusted, since where the
// party are standing is a property of whatever room this is pointed at.
const near = await dmGrid.cellUnder(dmGrid.middle.x - 200, dmGrid.middle.y - 160);
const bare = near === null ? null : await emptyCell(dm, dmGrid, near);
if (bare === null) {
  console.log('\nFAILED: no bare board near the middle of the view to ping at');
  dm.close();
  player.close();
  process.exit(1);
}
note(`pinging cell ${bare.x},${bare.y}, which has nothing standing on it`);
check('the square being pinged is on the other screen too', playerGrid.onScreen(bare.x, bare.y, 60), true);

const spot = at(dmGrid, bare);
const playerSpot = at(playerGrid, bare);

await remember(dm, ...boxAt(spot.x, spot.y));
await remember(player, ...boxAt(playerSpot.x, playerSpot.y));

await hold(dm, spot.x, spot.y);
await dm.wait(200);

const dmRing = await movedSince(dm, ...boxAt(spot.x, spot.y));
const playerRing = await movedSince(player, ...boxAt(playerSpot.x, playerSpot.y));
note(`the DM's box changed by ${(dmRing * 100).toFixed(2)}%, the player's by ${(playerRing * 100).toFixed(2)}%`);

check('the hold drew a ring on the screen it was made on', dmRing > RING_SHARE, true);
check('and the same ring reached the other connection', playerRing > RING_SHARE, true);

// The whole feature is ephemeral: nothing ends a ring but the clock, so this is
// the only assertion that it *does* end.
await dm.wait(3200);
const dmFaded = await movedSince(dm, ...boxAt(spot.x, spot.y));
const playerFaded = await movedSince(player, ...boxAt(playerSpot.x, playerSpot.y));
note(`once faded: ${(dmFaded * 100).toFixed(2)}% and ${(playerFaded * 100).toFixed(2)}%`);
check('the ring goes away by itself', dmFaded < RING_SHARE, true);
check('on both screens', playerFaded < RING_SHARE, true);

// --- a short click is not a ping --------------------------------------------

await remember(player, ...boxAt(playerSpot.x, playerSpot.y));
await dm.click(spot.x, spot.y);
await dm.wait(600);
const afterClick = await movedSince(player, ...boxAt(playerSpot.x, playerSpot.y));
note(`a click moved the player's box by ${(afterClick * 100).toFixed(2)}%`);
check('an ordinary click sends no ping at all', afterClick < RING_SHARE, true);

// --- a drag is not a ping either ---------------------------------------------
//
// The other half of "a few pixels of movement cancels it". A pan that happens to
// take three quarters of a second must not fire, or panning around a large map
// would spray rings across the table's screens.

await remember(player, ...boxAt(playerSpot.x, playerSpot.y));
await press(dm, spot.x, spot.y);
await dm.wait(200);
await dm.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x: spot.x + 60, y: spot.y + 40, button: 'left', buttons: 1,
});
await dm.wait(600);
await release(dm, spot.x + 60, spot.y + 40);
await dm.wait(400);

const afterPan = await movedSince(player, ...boxAt(playerSpot.x, playerSpot.y));
note(`a slow pan moved the player's box by ${(afterPan * 100).toFixed(2)}%`);
check('a slow pan is a pan and not a ping', afterPan < RING_SHARE, true);

// The DM's own board did move — it was panned — so put it back where every
// coordinate below was measured from.
await dm.drag(spot.x + 60, spot.y + 40, spot.x, spot.y);
await dm.wait(300);

// --- a hold on a token pings rather than dragging it --------------------------
//
// A drag only begins on movement, so a stationary hold on a creature is free —
// and pointing at one is most of what pinging is for. The branch worth driving
// is the *cleanup*: the press already told the ruler where the drag began, and
// leaving that behind would put a zero-length ruler on the board measuring a
// move nobody made. What is asserted is that the ping went out and the token did
// not budge.

// Built rather than found, because where the party happen to be standing is a
// property of whatever room this is pointed at, and a check that skips itself on
// most maps is not a check. Where it *lands* is the same kind of fact — the
// first free cell out from the middle of the view — so it is looked for below
// rather than assumed to be under the middle of the canvas.
await tab('token');
await dm.evaluate(`(() => {
  const fresh = document.getElementById('token-new');
  if (!fresh.hidden) fresh.click();
  return 'ok';
})()`);
await dm.wait(200);
await dm.evaluate(`document.getElementById('token-name').value = 'Ping Test'; "ok"`);
await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
await dm.wait(800);

const built = await findToken(dm, dmGrid, 'Ping Test');
check('the token this script built is on the board', built !== null, true);
const { x: tcx, y: tcy } = at(dmGrid, built);
const { x: tpx, y: tpy } = at(playerGrid, built);
check('and the panel is describing it', await tokenAt(dm, dmGrid, built), 'Ping Test');

// The cell under the pointer, off the HUD. A press that turned into a drag would
// have panned the board or moved the token, and either shows up here.
const cellUnderPointer = async () => {
  await dm.move(tcx, tcy);
  await dm.wait(80);
  return dm.evaluate('document.querySelector("#hud").textContent');
};

const cellBefore = await cellUnderPointer();

await remember(player, ...boxAt(tpx, tpy));
await hold(dm, tcx, tcy);
await dm.wait(300);

const onToken = await movedSince(player, ...boxAt(tpx, tpy));
note(`a hold on a creature moved the player's box by ${(onToken * 100).toFixed(2)}%`);
check('a hold on a creature pings rather than dragging it', onToken > RING_SHARE, true);

// And nothing was dragged: the same token is still under the same point, which
// would not be true if the press had turned into a move and a drop.
await dm.wait(3200);
check('the pointer is still over the same cell', await cellUnderPointer(), cellBefore);
// Through `tokenAt`, which empties the panel before it clicks: the box already
// said `Ping Test` from the selection above, so reading it back without that
// would be the check answering itself.
check('and the token is still standing in it', await tokenAt(dm, dmGrid, built), 'Ping Test');

// Selected from the click just above, so it can go without hunting for it.
await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
await dm.wait(600);

// The door is the one place in this project where what a click means depends on
// what is under it, and it is why ping had to separate by duration rather than
// by target. It needs no check of its own here: a door swings on a *release*
// before the hold elapses, and the two checks above are exactly that release
// happening and the hold not. Which door is where on a given map is not
// something a driver can know, and `drive-ui.mjs` already swings one.

// --- a ping while a shape tool is armed ---------------------------------------
//
// The decision this milestone made deliberately: ping ignores the draw tool. It
// is the one panel everybody has and it is used mid-fight, so a player who
// leaves it selected between uses must not silently lose the gesture — a dead
// gesture is invisible, and the people least likely to report it are the ones
// this milestone is for. A fast click still erases; a hold pings.

await player.evaluate(`[...document.querySelectorAll('.draw-tool')]
  .find(b => b.textContent.trim() === 'circle').click(); "ok"`);
await player.wait(300);
check(
  'the player has a shape tool in hand',
  await player.evaluate("document.body.classList.contains('drawing')"),
  true,
);

await remember(dm, ...boxAt(spot.x, spot.y));
await hold(player, playerSpot.x, playerSpot.y);
await player.wait(300);

const throughTool = await movedSince(dm, ...boxAt(spot.x, spot.y));
note(`with the circle tool armed, the DM's box changed by ${(throughTool * 100).toFixed(2)}%`);
check('a hold pings even with the draw tool in hand', throughTool > RING_SHARE, true);
check(
  'and the tool is still in hand afterwards',
  await player.evaluate("document.body.classList.contains('drawing')"),
  true,
);

await player.key('Escape', 'Escape', 27);
await player.wait(200);
check(
  'the tool puts down on Escape as it always did',
  await player.evaluate("document.body.classList.contains('drawing')"),
  false,
);

await dm.wait(3200); // let that ring expire before the fog check measures anything

// --- a ping over ground the party has never explored --------------------------
//
// The milestone's one deliberate hole in the fog, and the only assertion in
// these drivers that a client *was* sent something it cannot normally see.
//
// Only meaningful on a fogged map, so it says so rather than passing quietly on
// a room where the lights are on.

await tab('fog');
const fogOn = await dm.evaluate('document.querySelector("#fog-on").checked');
if (!fogOn) {
  await dm.evaluate('document.querySelector("#fog-on").click(); "ok"');
  await dm.wait(800);
}
await tab('map'); // the fog brush arms the left button; ping must not fight it
note(`fog was ${fogOn ? 'already on' : 'turned on for this check'}`);

// Far from the party, who are clustered wherever this room put them. Deep enough
// into the dark that the board there is solid black on the player's screen,
// which is what makes the ring on top of it worth asserting. Named in the DM's
// pixels for the same reason as the bare patch above — the far corner of a
// canvas is a fact about the canvas — and carried to the other screen as the
// cell it lands on, which is the only form the two clients agree about.
const darkCell = await dmGrid.cellUnder(dmGrid.middle.x + 420, dmGrid.middle.y + 300);
const reaches = darkCell !== null && playerGrid.onScreen(darkCell.x, darkCell.y, 60);
const dark = darkCell === null ? null : at(dmGrid, darkCell);
const playerDark = reaches ? at(playerGrid, darkCell) : null;

const litShare = async (spot) =>
  player.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const d = c.getContext('2d').getImageData(
      Math.round(${spot.x - 20} * dpr), Math.round(${spot.y - 20} * dpr),
      Math.round(40 * dpr), Math.round(40 * dpr)).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 90) lit++;
    return lit / (d.length / 4);
  })()`);

const darkness = reaches ? await litShare(playerDark) : null;
if (reaches) note(`${(darkness * 100).toFixed(1)}% of that patch is lit on the player's screen`);

if (!reaches) {
  note('that square is off the edge of the player’s canvas — the fog arm is untested on this room');
} else if (darkness > 0.2) {
  note('that spot is not dark on this map — the fog arm is untested on this room');
} else {
  await remember(player, ...boxAt(playerDark.x, playerDark.y));
  await hold(dm, dark.x, dark.y);
  await dm.wait(300);

  const overDark = await movedSince(player, ...boxAt(playerDark.x, playerDark.y));
  note(`the ring moved ${(overDark * 100).toFixed(2)}% of the player's dark box`);
  check('a ping lands on ground the party has never explored', overDark > RING_SHARE, true);

  // And it lit nothing. A ping is not a torch — the fog is exactly as it was, so
  // the only thing that changed in that box is the ring, which then goes away.
  await player.wait(3200);
  const afterFade = await movedSince(player, ...boxAt(playerDark.x, playerDark.y));
  note(`and ${(afterFade * 100).toFixed(2)}% of it once the ring faded`);
  check('and the ground under it is exactly as dark as it was', afterFade < RING_SHARE, true);
}

// --- put the room back --------------------------------------------------------

if (!fogOn) {
  await tab('fog');
  await dm.evaluate('document.querySelector("#fog-on").click(); "ok"');
  await dm.wait(600);
  check('fog is back off', await dm.evaluate('document.querySelector("#fog-on").checked'), false);
}

if (cursorsWere) {
  await tab('table');
  await dm.evaluate('document.querySelector("#table-cursors").click(); "ok"');
  await dm.wait(600);
  check(
    'and the pointers are back on',
    await dm.evaluate('document.querySelector("#table-cursors").checked'),
    true,
  );
}

const code = verdict(dm);
if (player.errors.length > 0) console.log(`the player page logged: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(code === 0 && player.errors.length === 0 ? 0 : 1);

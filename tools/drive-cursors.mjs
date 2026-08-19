// Drives everybody's pointer on everybody's board: the relay, the one thing it
// withholds, the decay, and the switch.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-cursors.mjs                   # or: ... http://host:port secret
//
// It flips the room's cursor switch and may turn the fog on, both of which
// persist — point `SLATE_STATE` at a scratch file. Everything it changes it puts
// back.
//
// **Why a browser, and why two.** A cursor is a pointer moving in real time and
// a canvas drawing it; `cursors.test.ts` can assert the decay and the one
// pointer per person, and nothing in a single process can assert that moving a
// real mouse in one window drew a dot in another. Two connections is also the
// only place the milestone's filter exists at all — what is asserted is that the
// DM's pointer over unexplored ground *did not arrive*, which one window cannot
// tell from the DM simply not having moved.
//
// The sharpest check is that negative one, and it is the exact opposite of
// `drive-ping.mjs`'s: a ping over the dark is relayed and this is not. The two
// scripts assert opposite outcomes about the same square on purpose — a ping is
// a gesture somebody chose to make, and a cursor is where a hand happens to be
// while its owner works on the ambush.

import { open, checks } from './cdp.mjs';
import { latticeOrBail, emptyCell, findToken } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

// Fixed, like every other driver's: two of these running at once would attach to
// each other's browser, and milestone 26 spent a day on exactly that.
const dm = await open(`${base}/?dm=${secret}`, { port: 9333 });
const player = await open(base, { port: 9334 });
const { check, note, verdict } = checks();

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

// Neither client is zoomed, for `drive-ping.mjs`'s reason: this script needs a
// square the party's light has never reached, and zooming in to make anything
// easier to hit would pull that corner inside the vision radius and turn the
// sharpest check here into a skip.
const framed = { zoom: false };
const dmGrid = await latticeOrBail(dm, [dm, player], framed);
const playerGrid = await latticeOrBail(player, [dm, player], framed);
note(`the DM: ${dmGrid.describe}`);
note(`the player: ${playerGrid.describe}`);

/** Remembers a rectangle of a canvas so the next call can count what moved.
 *
 *  Differences rather than absolute readings — how bright a patch of board *is*
 *  depends on what the map was painted, and a cursor is a small dot at half
 *  strength over whatever was already there. */
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

// A cursor is a 10px dot at 55% with a name under it — much less of the box than
// a ping's ring, and drawn much fainter. A fifth of a percent is still well clear
// of a still canvas, whose noise floor these drivers have measured at zero, and
// the readings that matter come back an order of magnitude above it either way.
const ARROW_SHARE = 0.002;
/** A box around where a pointer lands: the dot, and the name under it. */
const BOX = 90;
const boxAt = (x, y) => [x - BOX / 2, y - BOX / 2 + 10, BOX, BOX];

/** Where a cell falls on one client's screen. */
const at = (grid, cell) => {
  const [x, y] = grid.screenOfCell(cell.x, cell.y);
  return { x, y };
};

/** How long a pointer takes to fade out and be dropped, plus room to spare. */
const DECAY_MS = 3200;

/** The room's cursor switch, read and set through the DM's table panel. */
const switchIs = async (want) => {
  await tab('table');
  const now = await dm.evaluate('document.querySelector("#table-cursors").checked');
  if (now !== want) {
    await dm.evaluate('document.querySelector("#table-cursors").click(); "ok"');
    await dm.wait(500);
  }
  return now;
};

const cursorsWere = await switchIs(true);
note(`the room's pointers were ${cursorsWere ? 'already on' : 'off, and are on for this run'}`);

// --- a pointer reaches the other connection ---------------------------------

// Somewhere with nothing standing on it, so the box being measured holds the
// dot and nothing else that might move. Searched outward rather than assumed:
// where the party are standing is a property of whatever room this is pointed
// at, which is the rule `board.mjs` exists to enforce.
const near = await dmGrid.cellUnder(dmGrid.middle.x - 200, dmGrid.middle.y - 160);
const bare = near === null ? null : await emptyCell(dm, dmGrid, near);
if (bare === null) {
  console.log('\nFAILED: no bare board near the middle of the view to point at');
  dm.close();
  player.close();
  process.exit(1);
}
note(`pointing at cell ${bare.x},${bare.y}, which has nothing standing on it`);
check('the square is on both screens', playerGrid.onScreen(bare.x, bare.y, 60), true);

const dmSpot = at(dmGrid, bare);
const playerSpot = at(playerGrid, bare);

await remember(dm, ...boxAt(dmSpot.x, dmSpot.y));
await player.move(playerSpot.x, playerSpot.y);
await player.wait(400);

const relayed = await movedSince(dm, ...boxAt(dmSpot.x, dmSpot.y));
note(`the player's pointer moved the DM's box by ${(relayed * 100).toFixed(2)}%`);
check("a player's pointer is drawn on the DM's board", relayed > ARROW_SHARE, true);

// --- and goes away by itself ------------------------------------------------
//
// Nothing on the wire ends a pointer: a client that stops moving sends nothing
// at all, and every recipient's own clock does the rest. This is the only
// assertion that the clock is running.

await player.wait(DECAY_MS);
const faded = await movedSince(dm, ...boxAt(dmSpot.x, dmSpot.y));
note(`once still: ${(faded * 100).toFixed(2)}%`);
check('and a hand that stops moving fades off the board', faded < ARROW_SHARE, true);

// --- the filter, which is the milestone -------------------------------------
//
// Only meaningful on a fogged map, so it says so rather than passing quietly in
// a room with the lights on.

await tab('fog');
const fogOn = await dm.evaluate('document.querySelector("#fog-on").checked');
if (!fogOn) {
  await dm.evaluate('document.querySelector("#fog-on").click(); "ok"');
  await dm.wait(900);
}
await tab('table'); // the fog brush arms the left button; nothing here wants it
note(`fog was ${fogOn ? 'already on' : 'turned on for this check'}`);

/** How much of a patch of the player's board is lit — the same reading
 *  `drive-ping.mjs` takes, and the only way to tell explored ground from the
 *  dark without asking the client a question it has no answer to. */
const litShare = (spot) =>
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

const darkCell = await dmGrid.cellUnder(dmGrid.middle.x + 420, dmGrid.middle.y + 300);
const reaches = darkCell !== null && playerGrid.onScreen(darkCell.x, darkCell.y, 60);
const darkness = reaches ? await litShare(at(playerGrid, darkCell)) : null;
if (reaches) note(`${(darkness * 100).toFixed(1)}% of that far patch is lit on the player's screen`);

if (!reaches) {
  note('that square is off the edge of the player’s canvas — the filter is untested on this room');
} else if (darkness > 0.2) {
  note('that spot is not dark on this map — the filter is untested on this room');
} else {
  const dmDark = at(dmGrid, darkCell);
  const playerDark = at(playerGrid, darkCell);

  await remember(player, ...boxAt(playerDark.x, playerDark.y));
  await dm.move(dmDark.x, dmDark.y);
  await dm.wait(500);

  const overDark = await movedSince(player, ...boxAt(playerDark.x, playerDark.y));
  note(`the DM's pointer moved the player's dark box by ${(overDark * 100).toFixed(2)}%`);
  // The whole of milestone 28's filter, and the opposite of the check
  // `drive-ping.mjs` makes over the same kind of square. The DM's hand lingers
  // where the DM is working, which is over the thing the table cannot see.
  check(
    "the DM's pointer over unexplored ground never reaches the table",
    overDark < ARROW_SHARE,
    true,
  );

  // And the positive half, without which the check above would pass just as
  // happily for a room that had lost the feature altogether.
  //
  // The lit square is **built rather than found**, which is `drive-fog.mjs`'s
  // recipe and for its reason: where the party are standing and how far their
  // light reaches are facts about whatever room this is pointed at, and a check
  // that skips itself on most maps is not a check. A token handed to a *player*
  // is a vision source — a monster the DM keeps lights nothing — and it lands in
  // the first free cell out from the middle of the view, which is the one place
  // both clients are certainly looking.
  await tab('token');
  await dm.evaluate(`(() => {
    const fresh = document.getElementById('token-new');
    if (!fresh.hidden) fresh.click();
    return 'ok';
  })()`);
  await dm.wait(200);
  await dm.evaluate(`document.getElementById('token-name').value = 'Cursor Test'; "ok"`);
  await dm.evaluate(`(() => {
    const sel = document.getElementById('token-owner');
    const opt = [...sel.options].find(o => /saelyn/i.test(o.textContent));
    if (opt) sel.value = opt.value;
    return sel.value;
  })()`);
  await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
  await dm.wait(1200);

  const torch = await findToken(dm, dmGrid, 'Cursor Test');
  check('the vision source this script built is on the board', torch !== null, true);
  if (torch !== null) {
    const dmLit = at(dmGrid, torch);
    const playerLit = at(playerGrid, torch);

    // After the fog has opened around it and both boards have settled, so the
    // only thing left to move in this box is the dot.
    await dm.wait(600);
    await remember(player, ...boxAt(playerLit.x, playerLit.y));
    await dm.move(dmLit.x, dmLit.y);
    await dm.wait(500);

    const overLit = await movedSince(player, ...boxAt(playerLit.x, playerLit.y));
    note(`and over the lit square it moved the player's box by ${(overLit * 100).toFixed(2)}%`);
    check('and over ground the party can see it is just a pointer', overLit > ARROW_SHARE, true);

    // Selected by `findToken`'s last click, so it goes without hunting for it.
    await dm.wait(DECAY_MS);
    await tab('token');
    await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
    await dm.wait(700);
    check(
      'and the token it built is gone again',
      await findToken(dm, dmGrid, 'Cursor Test'),
      null,
    );
    await tab('table');
  }
}

await dm.wait(DECAY_MS); // let whatever is on screen expire before the next box

// --- the switch stops the relay ---------------------------------------------
//
// Off means the room relays nothing and every client stops sending its own, so
// what is asserted here is a board that does not move at all.

await switchIs(false);

await remember(dm, ...boxAt(dmSpot.x, dmSpot.y));
await player.move(playerSpot.x + 4, playerSpot.y + 4);
await player.wait(600);

const whileOff = await movedSince(dm, ...boxAt(dmSpot.x, dmSpot.y));
note(`with the switch off, the DM's box moved ${(whileOff * 100).toFixed(2)}%`);
check('nothing is drawn once the table has switched pointers off', whileOff < ARROW_SHARE, true);

await switchIs(true);
await remember(dm, ...boxAt(dmSpot.x, dmSpot.y));
await player.move(playerSpot.x, playerSpot.y);
await player.wait(500);

const backOn = await movedSince(dm, ...boxAt(dmSpot.x, dmSpot.y));
note(`and back on: ${(backOn * 100).toFixed(2)}%`);
check('and they come back when it goes back on', backOn > ARROW_SHARE, true);

// --- put the room back --------------------------------------------------------

await dm.wait(DECAY_MS);
if (!fogOn) {
  await tab('fog');
  await dm.evaluate('document.querySelector("#fog-on").click(); "ok"');
  await dm.wait(700);
  check('fog is back off', await dm.evaluate('document.querySelector("#fog-on").checked'), false);
}
if (!cursorsWere) {
  await switchIs(false);
  check(
    'and the cursor switch is back where it was found',
    await dm.evaluate('document.querySelector("#table-cursors").checked'),
    false,
  );
}

const code = verdict(dm);
if (player.errors.length > 0) console.log(`the player page logged: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(code === 0 && player.errors.length === 0 ? 0 : 1);

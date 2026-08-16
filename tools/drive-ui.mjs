// Drives the wall editor in a real browser, as the DM.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-ui.mjs                       # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — the first thing it does is
// erase every wall on the board. Point it at a scratch `SLATE_STATE`, never at
// the room you are about to play in.
//
// Why a browser at all: the wall editor is a click, a snap, and a line on a
// canvas, and none of those exist in a unit test. Two of the bugs this caught
// were only visible as pixels — a door that swung but did not redraw, and a
// panel that pushed itself off the bottom of the screen. The pixel assertions
// below are there because the DOM could not tell those apart from success.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const session = await open(`${base}/?dm=${secret}`);
const { evaluate, click, move, drag, key, wait } = session;
const { check, note, verdict } = checks();

await wait(2500); // the map image, the socket, and the first frame

const readout = () => evaluate('document.querySelector("#wall-readout").textContent');
const cursor = () => evaluate('document.querySelector("#stage").style.cursor');
const hud = () => evaluate('document.querySelector("#hud").textContent');
const press = (label, panel = '#wall-tools') =>
  evaluate(`[...document.querySelectorAll("${panel} button")]
    .find(b => b.textContent === "${label}").click(); "ok"`);

/**
 * The busiest column of door-amber within a few pixels of `x`, down a fixed
 * band of the map.
 *
 * A shut door draws solid and an open one draws dashed, so this counts as the
 * one thing that tells them apart from outside the client. It scans a spread of
 * columns because the line is three pixels wide and antialiased, and because a
 * wall lights up under the pointer from eight pixels away — the hover is found
 * before the line itself is reached.
 */
const doorPixels = (x) =>
  evaluate(`(() => {
    const c = document.querySelector('#stage');
    const s = c.width / c.getBoundingClientRect().width;   // backing store per CSS px
    const box = c.getContext('2d').getImageData(
      Math.round((${x} - 4) * s), Math.round(285 * s), Math.round(24 * s), Math.round(115 * s));
    const perColumn = new Array(box.width).fill(0);
    for (let i = 0; i < box.data.length; i += 4) {
      const [r, g, b] = [box.data[i], box.data[i + 1], box.data[i + 2]];
      if (r > 200 && g > 150 && g < 235 && b < 150) perColumn[(i / 4) % box.width]++;
    }
    return Math.max(...perColumn);
  })()`);

/** Sweeps the pointer until the cursor says something under it is clickable. */
async function hunt(axis, from, to, fixed) {
  for (let n = from; n <= to; n++) {
    await (axis === 'x' ? move(n, fixed) : move(fixed, n));
    if ((await cursor()) === 'pointer') return n;
  }
  return null;
}

// --- the panel exists at all ------------------------------------------------

/** Opens one of the rail's tabs. See `rail.ts` — only one is up at a time. */
const tab = (label) =>
  evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
    .find(b => b.textContent === "${label}").click(); "ok"`);

// The wall panel is behind a tab now, and nothing below opens it again: the
// only thing that switches tabs on its own is clicking a token, and this script
// never clicks one. `.click()` would fire on a hidden button just the same,
// which is exactly why this is here — driving the panel the way the DM reaches
// it is the difference between testing the editor and testing its handlers.
await tab('walls');
check('the wall panel is on screen for the DM', await evaluate('!document.querySelector("#walltool").hidden'), true);
check('three modes offered', await evaluate('document.querySelectorAll("#wall-tools button").length'), 3);

// Whatever a previous run left behind goes first, which is the clear-all button
// doing its job — confirmation prompt and all.
await evaluate('window.confirm = () => true; document.querySelector("#wall-clear").click(); "ok"');
await wait(400);
check('clear all leaves nothing traced', await readout(), 'nothing traced');

// --- only one tool may hold the left button ---------------------------------

await press('wall');
check('body says it is tracing', await evaluate('document.body.classList.contains("tracing")'), true);
await press('circle', '#draw-tools');
check('arming the draw tool disarms the wall tool', await evaluate('document.body.classList.contains("tracing")'), false);
await press('wall');
check('and back the other way', await evaluate('document.body.classList.contains("drawing")'), false);

// --- a run of three corners becomes two segments ----------------------------

for (const [x, y] of [[300, 300], [460, 300], [460, 420]]) {
  await move(x, y);
  await click(x, y);
}
await click(460, 420, { clickCount: 2 }); // the double-click that ends it
await wait(400);
check('two segments from three corners', await readout(), '2 walls · 0 doors');

// --- a door, hung shut ------------------------------------------------------

await press('door');
for (const y of [300, 420]) {
  await move(600, y);
  await click(600, y);
}
await key('Enter', 'Enter', 13); // the other way to finish a run
await wait(400);
check('the door is hung', await readout(), '2 walls · 1 door');

// --- swinging it, asserted on the pixels ------------------------------------
// The readout cannot tell a swing from an accidental new run: both leave the
// counts alone. Solid versus dashed can.

const doorAt = await hunt('x', 578, 598, 340);
check('the pointer finds the door to swing', doorAt !== null, true);

await move(950, 600); // off the wall: the segment under the pointer draws white
const shut = await doorPixels(doorAt ?? 588);
await click(doorAt ?? 588, 340);
await wait(400);
await move(950, 600);
const opened = await doorPixels(doorAt ?? 588);
note(`door column: ${shut} amber pixels shut, ${opened} open`);
check('swinging a door does not add or remove one', await readout(), '2 walls · 1 door');
check('an open door draws dashed where a shut one draws solid', opened < shut * 0.8, true);
check('and it was solid to begin with', shut > 80, true);

// --- erasing one segment of a run -------------------------------------------

await press('erase');
const segmentAt = await hunt('y', 250, 360, 380);
check('the pointer finds a traced segment to erase', segmentAt !== null, true);
note(`segment found at y = ${segmentAt} (clicked at y = 300, so the corner snapped)`);
if (segmentAt !== null) await click(380, segmentAt);
await wait(400);
check('one segment erased, not the whole run', await readout(), '1 wall · 1 door');

// --- a door swings with no tool in hand -------------------------------------
// The DM mid-fight, dragging monsters, not editing the map.

await press('erase'); // pressing the armed mode puts it away
check('all tools are away', await evaluate('document.body.classList.contains("tracing")'), false);
check('and the draw tool too', await evaluate('document.body.classList.contains("drawing")'), false);

const idleDoor = await hunt('x', 578, 598, 340);
check('an unarmed pointer still finds the door', idleDoor !== null, true);

await move(950, 600);
const before = await doorPixels(idleDoor ?? 588);
await click(idleDoor ?? 588, 340);
await wait(400);
await move(950, 600);
const after = await doorPixels(idleDoor ?? 588);
note(`door column with no tool: ${before} -> ${after}`);
check('clicking a door with no tool in hand swings it', after !== before, true);
check('and does not add or remove a wall', await readout(), '1 wall · 1 door');

// Dragging from that same pixel must still pan, or the map becomes ungrabbable
// wherever a door happens to be.
const camera = await hud();
await drag(idleDoor ?? 588, 340, (idleDoor ?? 588) + 60, 400);
check('dragging from a door pans the map instead of swinging it', camera !== (await hud()), true);

// Panned back, so the door is where it was and the counts are comparable. Had
// either drag swung it, this would be the dashed number.
await drag((idleDoor ?? 588) + 60, 400, idleDoor ?? 588, 340);
await move(950, 600);
check('the pan came back', await hud(), camera);
check('and the door was left alone by both drags', await doorPixels(idleDoor ?? 588), after);

// --- escape is the way out that needs no panel ------------------------------

await press('wall');
await move(300, 300);
await click(300, 300); // a run in progress
await key('Escape', 'Escape', 27);
check('escape abandons the run and keeps the tool', await evaluate('document.body.classList.contains("tracing")'), true);
await key('Escape', 'Escape', 27);
check('escape again puts the tool away', await evaluate('document.body.classList.contains("tracing")'), false);
check('and an abandoned run stored nothing', await readout(), '1 wall · 1 door');

// --- the panel is still the one on screen -----------------------------------
// This script used to end by measuring the rail, back when all four panels were
// stacked and `#tokentool` was squeezed between them. One tab is open at a time
// now, so that whole class of failure belongs to the strip rather than to any
// one panel — it is `drive-rail.mjs`, which measures it there. What is left
// here is the assumption everything above rests on.

check('the walls tab was open throughout', await evaluate('!document.querySelector("#walltool").hidden'), true);
check(
  'and it is the only panel of the three',
  await evaluate(`['maptool','tokentool','walltool']
    .filter(id => !document.getElementById(id).hidden)`),
  ['walltool'],
);

// --- put the room back --------------------------------------------------------
//
// After the readout check above, which is the last thing that reads the trace.
// This script clears on the way in as well, so it does not depend on the tidy-up
// having happened — but the drivers are documented as runnable in any order, and
// masonry left on the board is sight stopping in a room the next one is
// measuring.

await evaluate('document.querySelector("#wall-clear").click(); "ok"');
await wait(400);
check('and the board is left untraced', await readout(), 'nothing traced');

session.close();
process.exit(verdict(session));

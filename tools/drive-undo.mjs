// Drives the DM's undo, with a player watching.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-undo.mjs                      # or: ... http://host:port secret
//
// It runs against a live room and *changes it*. Point it at a scratch
// `SLATE_STATE`. It puts back what it changes, by construction — undoing is the
// thing being driven.
//
// Why a browser, and why two of them. Undo is the second message in this project
// that hands over the whole room, and it lands on connections that were built by
// the *first* one. Two things follow, and neither is visible from the server
// suite:
//
//   - **A restore reaches the table.** The DM presses a button and six other
//     boards change. That is a difference between two connections, which is
//     exactly what one client cannot see.
//   - **A restore must not rebuild the page.** `onWelcome` constructs the
//     panels, the tools and the board once per socket; routing a restore
//     through it would give the DM a second rail, a second draw tool, a second
//     keydown listener on every tool, and a camera back at its opening framing.
//     Counting the furniture and reading the zoom afterwards is the only place
//     that bug would ever show up.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

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

const button = (what) => dm.evaluate(`document.getElementById('undo-button').${what}`);
const press = () => dm.evaluate(`document.getElementById('undo-button').click(); "ok"`);

/** Stashes a canvas so the next call can count what moved. A difference rather
 *  than a reading, for the reason every pixel check in this suite is one. */
const remember = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    window.__before = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return c.width * c.height;
  })()`);

const changed = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const was = window.__before;
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (now[i] !== was[i] || now[i + 1] !== was[i + 1] || now[i + 2] !== was[i + 2]) n++;
    }
    return n;
  })()`);

// --- who has one ------------------------------------------------------------

// Not styled away on a player's screen — never built. The server sends them no
// label, so there is nothing for a control to say.
check(
  'the player has no undo control',
  await player.evaluate('document.querySelector("#undo").hidden'),
  true,
);
check(
  'the DM does',
  await dm.evaluate('document.querySelector("#undo").hidden'),
  false,
);

// --- and what it says ---------------------------------------------------------
//
// **Whatever is on the ring already**, which is a fact about whichever drivers
// ran before this one rather than about undo. So the empty-ring wording is
// asserted only when the ring genuinely is empty, and everything after this is
// written as a *return* to whatever the label was on arrival — the same rule
// `drive-fog` follows about a board it did not trace.

const opening = await button('textContent');
const restedAt = (await button('disabled')) ? null : opening;
if (restedAt === null) {
  check('an untouched room says so rather than sitting there blank', opening, 'nothing to undo');
} else {
  note(`this room already has history — the button reads "${opening}"`);
}

// --- a change the whole table can see ---------------------------------------

await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
  .find(b => b.textContent === 'table').click(); "ok"`);

const rails = await dm.evaluate(`document.querySelectorAll('#rail-tabs .rail-tab').length`);
const zoomBefore = await dm.evaluate(`document.querySelector("#hud").textContent.trim()`);
note(`the rail has ${rails} tabs, and the HUD reads "${zoomBefore}"`);

await remember(dm);
await remember(player);

await dm.evaluate(`document.getElementById('table-names').click(); "ok"`);
await dm.wait(800);

check('the names came off', await dm.evaluate(`document.getElementById('table-names').checked`), false);
const dmOff = await changed(dm);
const playerOff = await changed(player);
note(`the switch moved ${dmOff}px for the DM and ${playerOff}px for the player`);
check("and off the player's board too", playerOff > 200, true);

check('the button now names what it would take', await button('textContent'), 'undo: the name switch');
check('and is armed', await button('disabled'), false);

// --- pressing it ------------------------------------------------------------

await remember(dm);
await remember(player);
await press();
await dm.wait(900);

check(
  'the switch went back',
  await dm.evaluate(`document.getElementById('table-names').checked`),
  true,
);

const dmBack = await changed(dm);
const playerBack = await changed(player);
note(`the restore moved ${dmBack}px for the DM and ${playerBack}px for the player`);
// **The check this driver exists for.** The DM pressed a button and the board on
// a connection they know nothing about changed back.
check("the restore reached the player's board", playerBack > 200, true);
check("and the DM's", dmBack > 200, true);
check(
  'both legs moved the same board',
  Math.abs(playerOff - playerBack) < Math.max(playerOff, playerBack) * 0.25,
  true,
);

// --- the page it landed on ---------------------------------------------------
//
// A restore that had gone through `onWelcome` would have built a second of
// everything. Nothing on the canvas would say so, and the room would agree with
// itself throughout.

check(
  'the rail was not rebuilt',
  await dm.evaluate(`document.querySelectorAll('#rail-tabs .rail-tab').length`),
  rails,
);
check(
  'nor the draw tool',
  await dm.evaluate(`document.querySelectorAll('#drawtool').length`),
  1,
);
check(
  'and the DM is still looking where they were',
  await dm.evaluate(`document.querySelector("#hud").textContent.trim()`),
  zoomBefore,
);
check(
  'the table panel is still the open tab',
  await dm.evaluate(`document.querySelector('#tabletool').hidden`),
  false,
);

// --- and the step it took came off the ring ---------------------------------
//
// Back to whatever the button said on arrival, which on an untouched room is
// the empty-ring wording and otherwise is the previous driver's last command.
// Either way it is the step *before* the one just undone, which is the whole
// assertion: undoing pops, and does not push.

check('the ring gave the step back', await button('textContent'), opening);
check('and is where it started', await button('disabled'), restedAt === null);

// --- the keyboard path ------------------------------------------------------

await dm.evaluate(`document.getElementById('table-names').click(); "ok"`);
await dm.wait(700);
check('something to undo again', await button('disabled'), false);

// A real Ctrl+Z through the browser's input pipeline, not a synthesised event:
// modifiers is CDP's bitfield and 2 is Ctrl.
await dm.key('z', 'KeyZ', 90, 2);
await dm.wait(900);

check(
  'Ctrl+Z undid it',
  await dm.evaluate(`document.getElementById('table-names').checked`),
  true,
);
check('and the ring is back where it started again', await button('textContent'), opening);

// --- and it stands down where the DM is typing ------------------------------
//
// Ctrl+Z in a text field is the browser's own undo. Stealing it there would make
// a name box the one place in this application where the standard shortcut does
// something violent and unrelated.

await dm.evaluate(`document.getElementById('table-names').click(); "ok"`);
await dm.wait(700);
const armed = await button('textContent');
await dm.evaluate(`document.getElementById('init-value').focus(); "ok"`);
await dm.key('z', 'KeyZ', 90, 2);
await dm.wait(600);
check('Ctrl+Z in a text field left the ring alone', await button('textContent'), armed);

// Put the room back: the switch is persisted, and the next driver to run should
// find the board it was written against.
await press();
await dm.wait(800);
check(
  'and the board was left as it was found',
  await dm.evaluate(`document.getElementById('table-names').checked`),
  true,
);

const failures = verdict(dm);
const alsoPlayer = player.errors.length > 0;
if (alsoPlayer) console.log(`the player's page logged errors: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(failures === 0 && !alsoPlayer ? 0 : 1);

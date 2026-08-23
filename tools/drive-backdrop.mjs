// Drives the DM putting a picture in front of the table, with a player watching.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-backdrop.mjs                  # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — the backdrop is persisted and
// is a step on the undo ring. Point it at a scratch `SLATE_STATE`. It puts the
// picture down again at the end.
//
// Why a browser, and why two of them. The whole feature is a claim about what is
// *not* destroyed: covering the board leaves the walls, the drawings and
// everywhere the party has explored exactly where they were, which the server
// suite asserts directly and which nobody can see. What a browser adds is the
// visible half — that the board comes back looking like itself, on a second
// connection the DM's client knows nothing about, and that while the picture is
// up the DM can still be looking at the dungeon they are preparing.

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

/**
 * A cheap fingerprint of what is on a canvas: how many pixels are lit, and how
 * bright they are on average.
 *
 * Two numbers rather than a whole image, because the assertions here are "this
 * is a different picture" and "this is the same picture again" — and the second
 * is the interesting half. A backdrop and a battle map differ enormously; a
 * board before and after being covered must not differ at all.
 */
const fingerprint = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let lit = 0, sum = 0;
    for (let i = 0; i < d.length; i += 4) {
      const v = d[i] + d[i + 1] + d[i + 2];
      if (v > 60) lit++;
      sum += v;
    }
    return { lit, mean: Math.round(sum / (d.length / 4)) };
  })()`);

const differs = (a, b) =>
  Math.abs(a.lit - b.lit) > a.lit * 0.05 || Math.abs(a.mean - b.mean) > 6;

const covered = (session) => session.evaluate('document.body.classList.contains("covered")');

const tableTab = async () => {
  await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
    .find(b => b.textContent === 'table').click(); "ok"`);
  await dm.wait(200);
};

// --- the control ------------------------------------------------------------

await tableTab();
check(
  'the picker is on the table panel, not the map one',
  await dm.evaluate(`document.getElementById('table-backdrop').offsetParent !== null`),
  true,
);
check(
  'and there is nothing to put away yet',
  await dm.evaluate('document.getElementById("table-backdrop-clear").hidden'),
  true,
);
// A player has no panel to reach it from. Not styled away — never built.
check(
  'the player has no table panel at all',
  await player.evaluate('document.querySelector("#tabletool").hidden'),
  true,
);

// --- putting it up ----------------------------------------------------------

const dmBoard = await fingerprint(dm);
const playerBoard = await fingerprint(player);
note(`the board reads ${dmBoard.lit} lit / mean ${dmBoard.mean}`);

await dm.evaluate('document.getElementById("table-backdrop").click(); "ok"');
await dm.wait(700); // the listing request
const files = await dm.evaluate(
  `document.querySelectorAll('#table-backdrop-list button').length`,
);
note(`${files} backdrop(s) in the library`);
check('the library listed something to pick', files > 0, true);

await dm.evaluate(`document.querySelector('#table-backdrop-list button').click(); "ok"`);
await dm.wait(1800); // the pick, the round trip, the image, a frame on both

const dmUp = await fingerprint(dm);
const playerUp = await fingerprint(player);
check("the DM's board is showing something else", differs(dmBoard, dmUp), true);
check("and so is the player's, which is the point", differs(playerBoard, playerUp), true);
check(
  'the DM is told there is one to put away',
  await dm.evaluate('document.getElementById("table-backdrop-clear").hidden'),
  false,
);

// The board is a picture now, so it is not a thing to click on. One CSS rule
// rather than a guard in every handler in `input.ts`.
check("the DM's canvas stopped taking pointer events", await covered(dm), true);
check("and the player's", await covered(player), true);
check(
  'which is a real rule and not just a class',
  await player.evaluate(`getComputedStyle(document.getElementById('stage')).pointerEvents`),
  'none',
);
// And the readouts that describe the board go with it. A zoom percentage and a
// cell coordinate over a campfire are the same lie as a panel describing a
// token that is not on screen.
check(
  'the board readout is not floating over the picture',
  await player.evaluate(`document.getElementById('hud').offsetParent === null`),
  true,
);

// --- preview beats it, and only for the DM ----------------------------------
//
// The case the branch in `shownBackdrop` exists for: the party is roleplaying at
// the campfire while the DM traces the crypt they are about to walk into.

await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
  .find(b => b.textContent === 'map').click(); "ok"`);
await dm.wait(200);
await dm.evaluate('document.querySelector("#map-slot-next").click(); "ok"');
await dm.wait(600);

// A room with an empty slot has nothing to preview, so the branch would pass by
// never firing — which is the way a check rots quietly. One is staged here if
// there is not one already, and put back at the end if this is what staged it.
const stagedItHere =
  (await dm.evaluate('document.querySelector("#map-readout").textContent')) === 'nothing staged';
if (stagedItHere) {
  await dm.evaluate('document.querySelector("#map-library").click(); "ok"');
  await dm.wait(1200);
  const staged = await dm.evaluate(`(() => {
    const b = document.querySelectorAll('#map-library-list button')[1];
    if (b === undefined) return null;
    const name = b.textContent;
    b.click();
    return name;
  })()`);
  note(`staged for the preview check: ${staged}`);
  await dm.wait(2500); // the pick copies the file, then the image loads
}

check(
  'the DM is previewing the map they are preparing',
  await dm.evaluate('document.body.classList.contains("previewing")'),
  true,
);
check('previewing puts the picture away for the DM alone', await covered(dm), false);
check('while the table is still looking at it', await covered(player), true);

if (stagedItHere) {
  await dm.evaluate('document.querySelector("#map-discard").click(); "ok"');
  await dm.wait(900);
}
await dm.evaluate('document.querySelector("#map-slot-live").click(); "ok"');
await dm.wait(1200);
check('and leaving the preview brings it back', await covered(dm), true);

// --- and back to the board --------------------------------------------------
//
// The return leg is the whole claim. If covering the board had swept anything —
// the walls, the drawings, the party's memory of the room — this is where both
// boards would come back looking different from how they went in.

await tableTab();
await dm.evaluate('document.getElementById("table-backdrop-clear").click(); "ok"');
await dm.wait(1200);

check('the picture came down for the DM', await covered(dm), false);
check('and for the table', await covered(player), false);
check(
  'and the put-away button went with it',
  await dm.evaluate('document.getElementById("table-backdrop-clear").hidden'),
  true,
);

const dmBack = await fingerprint(dm);
const playerBack = await fingerprint(player);
note(`the board came back at ${dmBack.lit} lit / mean ${dmBack.mean}`);
check('the DM got the same board back, not a swept one', differs(dmBoard, dmBack), false);
check('and so did the player', differs(playerBoard, playerBack), false);

const failures = verdict(dm);
const alsoPlayer = player.errors.length > 0;
if (alsoPlayer) console.log(`the player's page logged errors: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(failures === 0 && !alsoPlayer ? 0 : 1);

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
//
// It also points at the picture: a ping, a pen stroke and a pointer made in the
// DM's window have to land on the same spot of it in the player's, which is a
// different shape, and the stroke has to be gone once it fades.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
// A taller, narrower window than the DM's, so the two letterbox the picture
// differently and a mark landing on the same spot of it means something.
const player = await open(`${base}/?room=campaign`, { port: 9334, width: 900, height: 1100 });
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);
check(
  'the player is on the board',
  await player.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]'),
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
  `document.querySelectorAll('#table-backdrop-list .map-library-pick').length`,
);
note(`${files} backdrop(s) in the library`);
check('the library listed something to pick', files > 0, true);

// A still, not a looping video: the pointing checks below count pixels that
// changed, and a video changes all of them.
await dm.evaluate(`(() => {
  const picks = [...document.querySelectorAll('#table-backdrop-list .map-library-pick')];
  (picks.find(b => !b.title.endsWith('.webm')) ?? picks[0]).click();
  return "ok";
})()`);
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
// And everything that describes the board goes with it. A zoom percentage and a
// cell coordinate over a campfire are the same lie as a panel describing a
// token that is not on screen, and an offer to frame a board nobody is looking
// at is a third.
check(
  'the board readout is not floating over the picture',
  await player.evaluate(`document.getElementById('hud').offsetParent === null`),
  true,
);
check(
  'and neither is the offer to fit a board that is not on screen',
  await player.evaluate(`document.getElementById('fit-board').offsetParent === null`),
  true,
);

// --- pointing at it ---------------------------------------------------------
//
// A ping, a pen stroke and a pointer on the picture, made in the DM's window and
// looked for in the player's, which is a different shape. A position is a
// fraction of the picture, so each mark has to land on the same spot of it on
// both, wherever the two windows put their letterbox bars.

/**
 * Where the picture is on a canvas, in CSS pixels, found from the pixels: the
 * letterbox bars are `VOID` and the picture is everything else. Read off the
 * screen rather than worked out the way the client does, so a client that got
 * its own arithmetic wrong can't agree with itself here.
 */
const pictureBox = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y += 2) {
      for (let x = 0; x < c.width; x += 2) {
        const i = (y * c.width + x) * 4;
        if (Math.abs(d[i] - 11) + Math.abs(d[i + 1] - 13) + Math.abs(d[i + 2] - 16) <= 6) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const dpr = c.width / c.clientWidth;
    return { x: x0 / dpr, y: y0 / dpr, w: (x1 - x0) / dpr, h: (y1 - y0) / dpr };
  })()`);

/** Where a fraction of the picture is in one window. */
const on = (box, f) => ({ x: box.x + f.x * box.w, y: box.y + f.y * box.h });

/** Keeps this frame in the page, to count what changes against it. */
const remember = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    window.__slateBefore = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    return "ok";
  })()`);

/** How many pixels within `half` CSS pixels of a spot differ from the frame
 *  `remember` kept. A difference, not a reading: the picture's own colours say
 *  nothing about whether a mark is on it. */
const changedNear = (session, at, half = 40) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    const dpr = c.width / c.clientWidth;
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const was = window.__slateBefore.data;
    const x0 = Math.max(0, Math.round((${at.x} - ${half}) * dpr));
    const x1 = Math.min(c.width, Math.round((${at.x} + ${half}) * dpr));
    const y0 = Math.max(0, Math.round((${at.y} - ${half}) * dpr));
    const y1 = Math.min(c.height, Math.round((${at.y} + ${half}) * dpr));
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * c.width + x) * 4;
        const diff = Math.abs(now[i] - was[i]) + Math.abs(now[i + 1] - was[i + 1])
          + Math.abs(now[i + 2] - was[i + 2]);
        if (diff > 60) n++;
      }
    }
    return n;
  })()`);

const mouse = (session, type, at, buttons) =>
  session.send('Input.dispatchMouseEvent', {
    type, x: at.x, y: at.y, button: 'left', buttons, clickCount: 1,
  });

const dmPic = await pictureBox(dm);
const playerPic = await pictureBox(player);
note(
  `the picture is ${Math.round(dmPic.w)}x${Math.round(dmPic.h)} at ${Math.round(dmPic.x)},` +
    `${Math.round(dmPic.y)} for the DM and ${Math.round(playerPic.w)}x${Math.round(playerPic.h)} ` +
    `at ${Math.round(playerPic.x)},${Math.round(playerPic.y)} for the player`,
);
check(
  'the two windows put the picture in different places',
  Math.abs(dmPic.w - playerPic.w) > 50 || Math.abs(dmPic.y - playerPic.y) > 50,
  true,
);

// Clear of the DM's left rail and right-hand column, which sit over the canvas.
const PING = { x: 0.5, y: 0.35 };
const STROKE_FROM = { x: 0.42, y: 0.55 };
const STROKE_TO = { x: 0.62, y: 0.7 };
const STROKE_MID = { x: 0.52, y: 0.625 };
const POINTER = { x: 0.58, y: 0.42 };
// Nowhere anything is drawn, as the baseline every count above is read against.
const QUIET = { x: 0.2, y: 0.85 };

const dmPing = on(dmPic, PING);
check(
  "the backdrop's own element is what is under the DM's hand there",
  await dm.evaluate(`document.elementFromPoint(${dmPing.x}, ${dmPing.y}).id`),
  'pointing',
);

await remember(player);
await mouse(dm, 'mousePressed', dmPing, 1);
await dm.wait(700); // past HOLD_MS
await mouse(dm, 'mouseReleased', dmPing, 0);
await player.wait(250);
const ringThere = await changedNear(player, on(playerPic, PING));
const ringQuiet = await changedNear(player, on(playerPic, QUIET));
note(`the ring changed ${ringThere} pixels where it was aimed and ${ringQuiet} elsewhere`);
check(
  "a hold on the DM's picture rings the same spot of the player's",
  ringThere > 150 && ringQuiet < 10,
  true,
);

await remember(player);
await remember(dm);
await mouse(dm, 'mousePressed', on(dmPic, STROKE_FROM), 1);
for (let i = 1; i <= 8; i++) {
  const t = i / 8;
  await mouse(dm, 'mouseMoved', on(dmPic, {
    x: STROKE_FROM.x + (STROKE_TO.x - STROKE_FROM.x) * t,
    y: STROKE_FROM.y + (STROKE_TO.y - STROKE_FROM.y) * t,
  }), 1);
  await dm.wait(20);
}
await mouse(dm, 'mouseReleased', on(dmPic, STROKE_TO), 0);
await player.wait(250);
const strokeThere = await changedNear(player, on(playerPic, STROKE_MID));
const strokeQuiet = await changedNear(player, on(playerPic, QUIET));
note(`the stroke changed ${strokeThere} pixels across its middle and ${strokeQuiet} elsewhere`);
check(
  "a drag on the DM's picture draws through the same spot of the player's",
  strokeThere > 100 && strokeQuiet < 10,
  true,
);
check(
  'and the DM sees their own, with no tool armed',
  (await changedNear(dm, on(dmPic, STROKE_MID))) > 100,
  true,
);

await player.wait(9000); // the stroke's hold and fade
check(
  "the stroke is gone from the player's picture once it fades",
  (await changedNear(player, on(playerPic, STROKE_MID))) < 10,
  true,
);
check(
  "and from the DM's",
  (await changedNear(dm, on(dmPic, STROKE_MID))) < 10,
  true,
);

await remember(player);
await dm.move(on(dmPic, POINTER).x, on(dmPic, POINTER).y);
await player.wait(200);
check(
  "the DM's pointer shows over the same spot of the player's picture",
  (await changedNear(player, on(playerPic, POINTER), 25)) > 20,
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
    const b = document.querySelectorAll('#map-library-list .map-library-pick')[1];
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

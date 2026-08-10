// Drives the DM's "names under tokens" switch, with a player watching.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-names.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — the switch is persisted. Point
// it at a scratch `SLATE_STATE`.
//
// Why a browser, and why two of them: the whole of this feature is that one
// checkbox on the DM's panel changes what six other people are looking at. The
// DOM cannot see either half — the labels are pixels on a canvas, and the half
// that matters is on a connection the DM's client knows nothing about. So the
// assertion is a pixel count on both canvases at once, taken as a difference
// rather than as a reading, because how much of the board is text depends on how
// many tokens happen to be standing on it.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?dm=${secret}`, { port: 9333 });
const player = await open(base, { port: 9334 });
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

// The player has to claim a slot before they are sent a board at all.
await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);
check(
  'the player is on the board',
  await player.evaluate('document.querySelector("#whoami-name").textContent'),
  'Saelyn',
);

/**
 * Stashes the canvas as it looks now, so the next call can count what moved.
 *
 * A difference rather than an absolute reading, because there is no count of
 * "label pixels" that does not also depend on the map art underneath them —
 * parchment with printed text on it would read as a labelled board whatever the
 * server said. What changed between two frames is the thing being asked about.
 */
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

const flip = () =>
  dm.evaluate(`document.getElementById('token-names').click(); "ok"`);

const boxIs = (want) =>
  dm.evaluate(`document.getElementById('token-names').checked`).then((got) => got === want);

// --- the control itself -----------------------------------------------------

await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
  .find(b => b.textContent === 'token').click(); "ok"`);
check(
  'the switch is on the token panel',
  await dm.evaluate(`document.getElementById('token-names').offsetParent !== null`),
  true,
);
check('and starts on, because the board was already labelled', await boxIs(true), true);

// A player has no panel to hold it. Not styled away — never built.
check(
  'the player has no token panel to flip it from',
  await player.evaluate('document.querySelector("#tokentool").hidden'),
  true,
);

// --- turning them off -------------------------------------------------------

const cells = await remember(dm);
await remember(player);
note(`each board is ${cells} pixels`);

await flip();
await dm.wait(800); // the round trip, then a frame on both clients

check('the checkbox settled off', await boxIs(false), true);

const dmOff = await changed(dm);
const playerOff = await changed(player);
note(`the DM's board changed by ${dmOff}px, the player's by ${playerOff}px`);
check("the names came off the DM's board", dmOff > 200, true);
check("and off the player's, which is the point", playerOff > 200, true);

// --- and back on ------------------------------------------------------------
//
// The return leg is what separates "the switch works" from "something repainted
// once". It also puts the room back the way it was found.

await remember(dm);
await remember(player);
await flip();
await dm.wait(800);

check('the checkbox settled back on', await boxIs(true), true);

const dmOn = await changed(dm);
const playerOn = await changed(player);
note(`coming back: ${dmOn}px and ${playerOn}px`);
check('the names came back for the DM', dmOn > 200, true);
check('and for the player', playerOn > 200, true);

// The same labels, so the two legs should move nearly the same pixels. Loose,
// because the fog and anything mid-animation are free to differ by a little.
check(
  'off and on moved the same board',
  Math.abs(dmOff - dmOn) < Math.max(dmOff, dmOn) * 0.2,
  true,
);

const failures = verdict(dm);
const alsoPlayer = player.errors.length > 0;
if (alsoPlayer) console.log(`the player's page logged errors: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(failures === 0 && !alsoPlayer ? 0 : 1);

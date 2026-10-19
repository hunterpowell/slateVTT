// Drives the ghost: a dragged token stays where it stands while a faint copy
// follows the pointer, moves on the drop, and stays put when Escape calls the
// drag off.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-ghost.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and *changes it*: it builds a token, moves it, and
// undoes a move. Point it at a scratch `SLATE_STATE`.
//
// Two browsers, because the claim is about a watcher. The DM drags; the player
// watches their own token, and every reading is taken on the player's canvas,
// where the only thing that can have moved anything is a frame the room sent.
//
// Every reading is a difference from a snapshot of the same box, never an
// absolute colour: what a cell looks like depends on what the map was painted.

import { open, checks } from './cdp.mjs';
import { latticeOrBail, findToken, tokenAt } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const player = await open(`${base}/?room=campaign`, { port: 9334 });
const { check, note, verdict } = checks();

await dm.evaluate('window.confirm = () => true; "ok"');
await dm.wait(2500);

await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);

const tab = (name) =>
  dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(t => t.textContent.trim().toLowerCase().startsWith('${name}')).click(); "ok"`);

/** Sets a checkbox on the DM's rail and returns what it was, so it can be put back. */
const setBox = async (id, want) => {
  const was = await dm.evaluate(`document.getElementById('${id}').checked`);
  if (was !== want) await dm.evaluate(`document.getElementById('${id}').click(); "ok"`);
  await dm.wait(400);
  return was;
};

// --- a clear board ------------------------------------------------------------
//
// Fog off, because a drop recomputes sight and repaints half the board. Cursors
// off, because the DM's pointer sits exactly where the ghost is and would be
// counted as one.

await tab('fog');
const fogWas = await setBox('fog-on', false);
await tab('table');
const cursorsWere = await setBox('table-cursors', false);
note(`fog was ${fogWas ? 'on' : 'off'}, cursors ${cursorsWere ? 'on' : 'off'}; both off for the run`);

// --- a token the player owns --------------------------------------------------

await tab('token');
await dm.evaluate(`(() => {
  const fresh = document.getElementById('token-new');
  if (!fresh.hidden) fresh.click();
  return 'ok';
})()`);
await dm.wait(200);
await dm.evaluate(`document.getElementById('token-name').value = 'Ghost Test'; "ok"`);
await dm.evaluate(`(() => {
  const sel = document.getElementById('token-owner');
  const opt = [...sel.options].find(o => /saelyn/i.test(o.textContent));
  if (opt) sel.value = opt.value;
  return sel.value;
})()`);
await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
await dm.wait(800);

const framed = { zoom: false };
const dmGrid = await latticeOrBail(dm, [dm, player], framed);
const playerGrid = await latticeOrBail(player, [dm, player], framed);
note(`the DM: ${dmGrid.describe}`);
note(`the player: ${playerGrid.describe}`);

const origin = await findToken(dm, dmGrid, 'Ghost Test');
check('the token this script built is on the board', origin !== null, true);
const dest = { x: origin.x + 3, y: origin.y };
check('the destination is bare board', await tokenAt(dm, dmGrid, dest), null);
check(
  'both cells are on the player\'s screen',
  playerGrid.onScreen(origin.x, origin.y, 40) && playerGrid.onScreen(dest.x, dest.y, 40),
  true,
);

/**
 * The middle of a cell on the player's screen: a square half a cell across,
 * inside the token's disc. The rim, the name under it and the hit point bar
 * over it all fall outside, so what changes here is the art.
 */
const boxOf = (cell) => {
  const [x, y] = playerGrid.screenOfCell(cell.x, cell.y);
  const side = playerGrid.size / 2;
  return [x - side / 2, y - side / 2, side, side];
};

const snapshot = (key, [x, y, w, h]) =>
  player.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    window.__boxes = window.__boxes || {};
    window.__boxes['${key}'] = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    return 'ok';
  })()`);

/** The share of the box's pixels that differ from its snapshot. */
const changed = (key, [x, y, w, h]) =>
  player.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const now = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    const was = window.__boxes['${key}'];
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - was[i]) + Math.abs(now[i+1] - was[i+1]) + Math.abs(now[i+2] - was[i+2]) > 10) n++;
    }
    return n / (now.length / 4);
  })()`);

const pct = (n) => `${(n * 100).toFixed(0)}%`;

/**
 * Starts watching a box on the player's canvas on every animation frame for
 * `ms`, keeping the largest share of it painted the grey a token with no art
 * is filled with (`#5a6472` in render.ts), less the share already that grey
 * when it started. Started before the drop and read after, because a slide
 * lasts less than a second and one reading per round trip would land on either
 * side of it.
 *
 * The token's own colour, not any change: the trail starts fading as the
 * token lands, and a fading wash changes every pixel in the box whether
 * anything slid across it or not.
 */
const watch = (key, [x, y, w, h], ms) =>
  player.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const grey = () => {
      const d = c.getContext('2d').getImageData(
        Math.round(${x} * dpr), Math.round(${y} * dpr),
        Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - 90) < 12 && Math.abs(d[i+1] - 100) < 12 && Math.abs(d[i+2] - 114) < 12) n++;
      }
      return n / (d.length / 4);
    };
    const base = grey();
    window.__most = window.__most || {};
    window.__most['${key}'] = 0;
    const until = performance.now() + ${ms};
    const look = () => {
      window.__most['${key}'] = Math.max(window.__most['${key}'], grey() - base);
      if (performance.now() < until) requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
    return 'ok';
  })()`);
const most = (key) => player.evaluate(`window.__most['${key}']`);

/** Presses on one cell and drags to another on the DM's screen, holding. */
const dragHold = async (from, to) => {
  const [fx, fy] = dmGrid.screenOfCell(from.x, from.y);
  const [tx, ty] = dmGrid.screenOfCell(to.x, to.y);
  await dm.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: fx, y: fy, button: 'left', buttons: 1, clickCount: 1,
  });
  await dm.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: (fx + tx) / 2, y: (fy + ty) / 2, button: 'left', buttons: 1,
  });
  await dm.wait(150);
  await dm.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: tx, y: ty, button: 'left', buttons: 1,
  });
  await dm.wait(500);
  return [tx, ty];
};

const release = async ([x, y]) => {
  await dm.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
};

// Past the slide and `LINGER_MS`, so a reading after a drop isn't of the
// token still travelling or the trail fading.
const LINGER = 3000;
await player.wait(LINGER);

// --- a move: plan, then action ------------------------------------------------

const atOrigin = boxOf(origin);
const atDest = boxOf(dest);
await snapshot('o0', atOrigin);
await snapshot('d0', atDest);

const held = await dragHold(origin, dest);
const originMid = await changed('o0', atOrigin);
const destMid = await changed('d0', atDest);
await snapshot('dMid', atDest);
note(`mid-drag on the player's screen: origin changed ${pct(originMid)}, destination ${pct(destMid)}`);

// The two cells the token passes over on its way. A slide crosses each in two
// or three frames (it eases out, so the first goes quickest), so both are
// watched and the larger reading counts.
const between = [1, 2].map((dx) => boxOf({ x: origin.x + dx, y: origin.y }));
for (const [i, box] of between.entries()) await watch(`between${i}`, box, 1200);

await release(held);
await dm.wait(1300);
const passed = Math.max(await most('between0'), await most('between1'));
note(`while it landed, up to ${pct(passed)} of a cell it crossed turned the token's grey`);
check('the token slides over the cells between instead of appearing at the end', passed > 0.5, true);
await dm.wait(LINGER - 1300);
const originAfter = await changed('o0', atOrigin);
const destSettled = await changed('dMid', atDest);
note(`after the drop: origin changed ${pct(originAfter)}, destination ${pct(destSettled)} from its mid-drag picture`);

check('the token leaves its cell on the drop', originAfter > 0.3, true);
// Against the drop's own reading rather than zero: the ruler's line starts at
// the origin and crosses this box mid-drag, so a little has changed there.
check('and not before it: mid-drag, it is still standing there', originMid < originAfter / 2, true);
check('a ghost is drawn where it is going', destMid > 0.2, true);
check('and the ghost becomes the token when it lands', destSettled > 0.1, true);
check(
  'the move is a step the DM can undo',
  await dm.evaluate('document.getElementById("undo-button").textContent'),
  'undo: moving a token',
);

// --- Escape calls it off ------------------------------------------------------

await snapshot('o1', atOrigin);
await snapshot('d1', atDest);

const heldBack = await dragHold(dest, origin);
const ghostBack = await changed('o1', atOrigin);
note(`dragging back: the origin changed ${pct(ghostBack)}`);
check('dragging it back draws a ghost on the cell it left', ghostBack > 0.2, true);

await dm.key('Escape', 'Escape', 27);
await dm.wait(400);
const ghostGone = await changed('o1', atOrigin);
note(`after Escape: the origin changed ${pct(ghostGone)}`);
check('Escape takes the ghost off the watcher\'s screen', ghostGone < ghostBack / 2, true);

await release(heldBack);
await dm.wait(LINGER);
const stayed = await changed('d1', atDest);
note(`after letting go: the destination changed ${pct(stayed)}`);
check('letting go after Escape does not move the token', stayed < destSettled / 2, true);

// The server half. A drag called off is dropped back on its origin, and that
// drop must not be a step. If it were, this undo would take back the no-op and
// leave the token where it is; it isn't, so the undo takes back the real move.
await dm.evaluate('document.getElementById("undo-button").click(); "ok"');
await dm.wait(LINGER);
const undone = await changed('o1', atOrigin);
note(`after one undo: the origin changed ${pct(undone)}`);
check('one undo takes back the move, not the Escape', undone > 0.3, true);

// --- put the room back ----------------------------------------------------------

check('the token is back on its first cell', await tokenAt(dm, dmGrid, origin), 'Ghost Test');
await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
await dm.wait(600);
check('and it is gone', await tokenAt(dm, dmGrid, origin), null);

await tab('table');
await setBox('table-cursors', cursorsWere);
await tab('fog');
await setBox('fog-on', fogWas);

const code = verdict(dm);
if (player.errors.length > 0) console.log(`the player page logged: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(code === 0 && player.errors.length === 0 ? 0 : 1);

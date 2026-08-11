// Drives the movement trail, the diagonal switch, and the initiative panel.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-ruler.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — the switch is persisted, and so
// is the token it builds if the run dies before tidying up. Point it at a
// scratch `SLATE_STATE`.
//
// Why a browser, and why two of them. Half of this feature is a picture on a
// canvas that no DOM query can see, and the more interesting half exists only on
// a connection the DM's client knows nothing about: every client draws a trail
// for any token it watches move, built from frames the room was already sending.
// One browser cannot tell that arm from a local effect — which is the trap
// ROADMAP.md records milestone 13 falling into and being caught this exact way.
//
// The initiative panel is the opposite and is checked in the DOM, since that is
// what it is made of. The sharpest check there is a negative one: a player's row
// carries no hit points, and not because the panel declines to draw them — their
// copy of the token has none to draw.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?dm=${secret}`, { port: 9333 });
const player = await open(base, { port: 9334 });
const { check, note, verdict } = checks();

// A stray native confirm deadlocks CDP outright, and two things below open one.
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

const centre = () =>
  dm.evaluate(`(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
  })()`);

/** The grid cell under a screen point, read off the HUD. */
const cellUnder = async (session, x, y) => {
  await session.move(x, y);
  await session.wait(60);
  const text = await session.evaluate('document.querySelector("#hud").textContent');
  const m = /cell (-?\d+), (-?\d+)/.exec(text);
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]) };
};

/**
 * What fraction of a screen rectangle is blue.
 *
 * An area rather than a few samples along the line, and that is not fussiness:
 * a new token snaps to the centre of its cell, so a drag begun at the centre of
 * the *view* grabs it with an offset of up to half a cell and the trail runs
 * parallel to the line the script dragged along rather than down it. Three
 * samples on the wrong line miss a trail that is drawn perfectly.
 *
 * Blue is also the one thing this map's art is not — a dungeon floor is grey and
 * brown — so the threshold does not have to be delicate.
 */
const fractionOf = (session, test, x, y, w, h) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const d = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    let hits = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (${test}) hits++;
    }
    return hits / (d.length / 4);
  })()`);

// Both tests are relative rather than absolute, and they have to be: a trail's
// fill goes down at about a sixth alpha, so it is a *wash* over whatever the map
// was painted, never the colour named in render.ts. What survives the blend is
// which channel got pushed up.

/** An ordinary trail. Blue is the one thing a dungeon floor is not. */
const BLUE = 'b > r + 15 && b > g + 5';
/** A trail whose move went through a wall — only ever on the DM's screen. The
 *  map's own browns sit within a few points of grey; this needs twenty. */
const AMBER = 'r - b > 20 && r > g + 5 && g > b';

/** Remembers a rectangle of a canvas so the next call can count what moved. */
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

// --- a token to drag, and a clear board to drag it over ----------------------
//
// Fog is turned off for the duration. Not because the trail cannot cope with it,
// but because a drop recomputes sight and repaints half the board, and a pixel
// that changed for that reason says nothing about a trail.

await tab('fog');
const fogWas = await dm.evaluate('document.querySelector("#fog-on").checked');
await dm.evaluate(`(() => {
  const box = document.querySelector('#fog-on');
  if (box.checked) box.click();
  return box.checked;
})()`);
await dm.wait(600);
note(`fog was ${fogWas ? 'on' : 'off'}; off for the run`);

// Handed to the player, so they hold it and are sent every frame of its drag.
await tab('token');
// Into creation mode first. Without this the panel may still be describing
// whatever was last selected, and saving would quietly *rename* that token
// rather than build a new one — which is a rerun of this script silently
// eating one of the party.
await dm.evaluate(`(() => {
  const fresh = document.getElementById('token-new');
  if (!fresh.hidden) fresh.click();
  return 'ok';
})()`);
await dm.wait(200);
await dm.evaluate(`document.getElementById('token-name').value = 'Ruler Test'; "ok"`);
await dm.evaluate(`(() => {
  const sel = document.getElementById('token-owner');
  const opt = [...sel.options].find(o => /saelyn/i.test(o.textContent));
  if (opt) sel.value = opt.value;
  return sel.value;
})()`);
await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
await dm.wait(800);

// A new token lands at the centre of the view, which is the centre of the
// canvas. Confirmed rather than assumed, because everything below drags from
// that point and a drag that misses the token is a pan — which moves the whole
// board and would fail the pixel checks for an entirely unrelated reason.
const [cx, cy] = await centre();
await dm.click(cx, cy);
await dm.wait(300);
check(
  'the new token is under the centre of the view',
  await dm.evaluate('document.getElementById("token-name").value'),
  'Ruler Test',
);

// --- the trail, watched from the other side ----------------------------------
//
// The drag is measured in cells read off the HUD rather than in pixels, because
// nothing on either page will say how big a cell is on screen and a reading in
// pixels would be a guess about the zoom.

const span = 260; // screen pixels, comfortably several cells at any usable zoom
const from = { x: cx, y: cy };
const to = { x: cx + span, y: cy + span };

const startCell = await cellUnder(dm, from.x, from.y);
const endCell = await cellUnder(dm, to.x, to.y);
const steps = Math.max(Math.abs(endCell.x - startCell.x), Math.abs(endCell.y - startCell.y));
note(`the drag runs from cell ${startCell.x},${startCell.y} to ${endCell.x},${endCell.y} — ${steps} steps`);
check('the drag is long enough to have a trail', steps >= 3, true);

// The DM's board as it stands before anything is dragged over it. The trail's
// colour there depends on whether this room has a wall across this drag, so what
// is asserted is that a trail is *drawn*; which colour it came out is below.
await remember(dm, cx, cy, span, span);

await dm.send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1,
});
// Two moves, not one. The first is what the room relays as a drag frame, and a
// watcher reads its origin off the frame *before* applying it — so the second
// move is the first one that can be measured from anywhere but itself.
await dm.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x: cx + span / 2, y: cy + span / 2, button: 'left', buttons: 1,
});
await dm.wait(150);
await dm.send('Input.dispatchMouseEvent', {
  type: 'mouseMoved', x: to.x, y: to.y, button: 'left', buttons: 1,
});
await dm.wait(500);

// A staircase of `steps + 1` cells covers roughly `(steps + 1) / steps²` of the
// square the drag spans, which is about a fifth of it here. The ruler *line*
// alone is two pixels wide over a diagonal of the same box — about one percent.
// Five percent is comfortably between the two and needs no zoom arithmetic.
const TRAIL_SHARE = 0.05;
const boxOf = (page, test) => fractionOf(page, test, cx, cy, span, span);

const playerBlue = await boxOf(player, BLUE);
note(`${(playerBlue * 100).toFixed(1)}% of the drag's box is blue on the player's screen`);
check(
  'the player sees the trail under a token they are not dragging',
  playerBlue > TRAIL_SHARE,
  true,
);

const dmMoved = await movedSince(dm, cx, cy, span, span);
const dmBlue = await boxOf(dm, BLUE);
const dmAmber = await boxOf(dm, AMBER);
note(`the DM's box changed by ${(dmMoved * 100).toFixed(1)}% — ${(dmBlue * 100).toFixed(1)}% blue, ${(dmAmber * 100).toFixed(1)}% amber`);
check('and so does the DM doing the dragging', dmMoved > TRAIL_SHARE, true);

// The wall hint, and the whole reason it is safe to have one. If this drag did
// cross masonry the DM's trail goes amber — and the player, watching the very
// same frames, still sees blue, because their client holds no walls to test
// against. Nothing had to ask who they were for that to be true.
if (dmAmber > 0.03) {
  note('this drag crosses a wall on the DM\'s screen');
  const playerAmber = await boxOf(player, AMBER);
  note(`${(playerAmber * 100).toFixed(1)}% amber on the player's`);
  check('the wall warning is the DM\'s alone', playerAmber < 0.01, true);
  check('and the player still sees an ordinary trail', playerBlue > TRAIL_SHARE, true);
} else {
  note('this drag crosses no wall; the warning arm is untested on this map');
}

// --- the diagonal switch reaches the watcher mid-drag -------------------------

const readingBefore = await player.evaluate(`(() => {
  const c = document.querySelector('#stage');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.reduce((a, v) => a + v, 0);
})()`);

await tab('token');
await dm.evaluate(`(() => {
  const s = document.querySelector('#token-diagonals');
  s.value = 'alternating';
  s.dispatchEvent(new Event('change'));
  return 'ok';
})()`);
await dm.wait(500);

const readingAfter = await player.evaluate(`(() => {
  const c = document.querySelector('#stage');
  return c.getContext('2d').getImageData(0, 0, c.width, c.height).data.reduce((a, v) => a + v, 0);
})()`);

// The ruler is still on screen on both clients, and under 5-10-5 a diagonal of
// this length reads a different number of feet. The label is the only thing on
// the player's canvas that the DM's dropdown could have changed.
check("the player's reading redrew when the DM flipped the switch", readingBefore !== readingAfter, true);
check(
  "the DM's own dropdown settled on the frame the room sent back",
  await dm.evaluate('document.querySelector("#token-diagonals").value'),
  'alternating',
);

// --- the drop, and the linger ------------------------------------------------

await dm.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
});
await dm.wait(500);

const justAfter = await boxOf(player, BLUE);
note(`${(justAfter * 100).toFixed(1)}% still blue just after the drop`);
check('the trail is still up just after the drop', justAfter > TRAIL_SHARE, true);

await player.wait(2400); // past LINGER_MS
const faded = await boxOf(player, BLUE);
note(`${(faded * 100).toFixed(1)}% blue once it has faded`);
// Not zero: the token itself is drawn there, and one grey disc in a box this
// size clears the blue test on a few of its own pixels.
check('and gone once it has faded', faded < 0.01, true);

await dm.evaluate(`(() => {
  const s = document.querySelector('#token-diagonals');
  s.value = 'equal';
  s.dispatchEvent(new Event('change'));
  return 'ok';
})()`);
await dm.wait(300);

// --- the initiative panel ----------------------------------------------------

const roll = async (name, value) => {
  await dm.evaluate(`(() => {
    const sel = document.querySelector('#init-token');
    const opt = [...sel.options].find(o => o.textContent === ${JSON.stringify(name)});
    if (!opt) return 'missing';
    sel.value = opt.value;
    document.querySelector('#init-value').value = '${value}';
    document.querySelector('#init-add').requestSubmit();
    return 'ok';
  })()`);
  await dm.wait(300);
};

await roll('Saelyn', 18);
await roll('Ruler Test', 12);
await dm.wait(500);

const rows = (page) =>
  page.evaluate(`[...document.querySelectorAll('.init-row')].map(r => ({
    name: r.querySelector('.init-name')?.textContent ?? null,
    art: (r.querySelector('.init-art')?.style.backgroundImage ?? '') !== '',
    hasArtSlot: r.querySelector('.init-art') !== null,
    hp: r.querySelector('.init-hp-text')?.textContent ?? null,
    lookable: r.classList.contains('is-lookable'),
  }))`);

const dmRows = await rows(dm);
const playerRows = await rows(player);
note('DM rows:   ', JSON.stringify(dmRows));
note('player rows:', JSON.stringify(playerRows));

check('the DM sees both rows', dmRows.length, 2);
check('every row has a portrait slot', dmRows.every((r) => r.hasArtSlot), true);
check('the party portrait is loaded', dmRows.find((r) => r.name === 'Saelyn')?.art, true);
// The token this script built has no art, and must degrade to the grey disc
// rather than to an empty box — same failure the canvas already handles.
check('a token with no art still gets its disc', dmRows.find((r) => r.name === 'Ruler Test')?.hasArtSlot, true);
check('and no background image on it', dmRows.find((r) => r.name === 'Ruler Test')?.art, false);
check('every row can be looked at', dmRows.every((r) => r.lookable), true);
check('the player sees both rows too', playerRows.length, 2);

// --- hit points, and who is not sent them ------------------------------------

await tab('token');
// Nine of forty is under a quarter, which is the lowest of the three bands.
await dm.evaluate(`(() => {
  document.getElementById('token-hp').value = '9';
  document.getElementById('token-hp-max').value = '40';
  document.getElementById('token-save').click();
  return 'ok';
})()`);
await dm.wait(600);

const mine = (list) => list.find((r) => r.name === 'Ruler Test');
const dmHp = mine(await rows(dm));
const playerHp = mine(await rows(player));
check("the DM's row shows the total", dmHp?.hp, '9/40');
check('the player is sent no hit points at all', playerHp?.hp, null);

const barColour = await dm.evaluate(`(() => {
  const row = [...document.querySelectorAll('.init-row')]
    .find(r => r.querySelector('.init-name').textContent === 'Ruler Test');
  return row?.querySelector('.init-hp-fill')?.style.backgroundColor ?? null;
})()`);
// The same string `hpColour` hands the canvas, which is the point of sharing it.
check('and the bar is in the low band', barColour, 'rgba(200, 92, 92, 0.95)');

// --- clicking a row looks at that creature -----------------------------------

const hudCell = async (page) => {
  const [mx, my] = await centre();
  return cellUnder(page, mx, my);
};

const clickRow = (name) =>
  dm.evaluate(`[...document.querySelectorAll('.init-row')]
    .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)}).click(); "ok"`);

const cellBefore = await hudCell(dm);
await clickRow('Ruler Test');
await dm.wait(400);
const cellAfter = await hudCell(dm);
note(`the cell at the centre of the view went from ${JSON.stringify(cellBefore)} to ${JSON.stringify(cellAfter)}`);
check(
  'clicking a row moved the camera',
  cellBefore.x !== cellAfter.x || cellBefore.y !== cellAfter.y,
  true,
);

// And landed on the token rather than merely somewhere else: clicking the middle
// of the view now selects it, which is only true if it is what is in the middle.
const [mx, my] = await centre();
await dm.click(mx, my);
await dm.wait(400);
check(
  'and put that token under the centre of the view',
  await dm.evaluate('document.getElementById("token-name").value'),
  'Ruler Test',
);

// The × must not also move the camera on its way out — a click that deletes
// something is the last click that should be doing two things.
const beforeRemove = await hudCell(dm);
await dm.evaluate(`[...document.querySelectorAll('.init-row')]
  .find(r => r.querySelector('.init-name').textContent === 'Saelyn')
  .querySelector('.init-remove').click(); "ok"`);
await dm.wait(500);
const afterRemove = await hudCell(dm);
check(
  'removing a row does not also look at it',
  beforeRemove.x === afterRemove.x && beforeRemove.y === afterRemove.y,
  true,
);
check('and the row is gone', (await rows(dm)).length, 1);

// --- put the room back -------------------------------------------------------
//
// The token is still selected from the centre-of-view click above, which is why
// this can delete it without hunting for it again.

await dm.evaluate('document.querySelector("#init-clear").click(); "ok"');
await dm.wait(300);
check(
  'the panel is describing the token this script built',
  await dm.evaluate('document.getElementById("token-name").value'),
  'Ruler Test',
);
await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
await dm.wait(600);
check(
  'and it is gone',
  await dm.evaluate(`[...document.querySelector('#init-token').options]
    .some(o => o.textContent === 'Ruler Test')`),
  false,
);

await tab('fog');
if (fogWas) {
  await dm.evaluate(`(() => {
    const box = document.querySelector('#fog-on');
    if (!box.checked) box.click();
    return box.checked;
  })()`);
  await dm.wait(500);
  check('fog is back on', await dm.evaluate('document.querySelector("#fog-on").checked'), true);
}

const code = verdict(dm);
if (player.errors.length > 0) console.log(`the player page logged: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(code === 0 && player.errors.length === 0 ? 0 : 1);

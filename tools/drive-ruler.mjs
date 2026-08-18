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
import { latticeOrBail, findToken } from './board.mjs';

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
 * A share of the box, not a verdict. Every caller subtracts what the same box
 * read before anything was drawn on it, because how blue a stretch of board *is*
 * depends on what the map was painted: one dungeon reads two percent blue bare
 * and the next reads four, and a fixed threshold across both is measuring the
 * art rather than the trail.
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

// Where that token *landed*, which is not a thing this script gets to assume: a
// new one goes into the first free cell out from the middle of the view, so on a
// board with something already standing there it is a cell or two over. It used
// to drag from the middle of the canvas and a drag that misses the token is a
// pan — which moves the whole board and fails the pixel checks below for an
// entirely unrelated reason.
//
// Neither client is zoomed. `span` and `TRAIL_SHARE` are pixel quantities tuned
// against the framing the client chooses for itself, and a lattice is only
// needed here to click the right square and to name the same square on the other
// screen. See `board.mjs`.
const framed = { zoom: false };
const dmGrid = await latticeOrBail(dm, [dm, player], framed);
const playerGrid = await latticeOrBail(player, [dm, player], framed);
note(`the DM: ${dmGrid.describe}`);
note(`the player: ${playerGrid.describe}`);

const built = await findToken(dm, dmGrid, 'Ruler Test');
check('the token this script built is on the board', built !== null, true);
const [cx, cy] = dmGrid.screenOfCell(built.x, built.y);

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

/**
 * The square of board the drag crossed, in one client's own pixels.
 *
 * Named by its two *cells* and resolved per screen, because the player's camera
 * is not the DM's — no left rail, so a different canvas and a different framing
 * from the first frame. The DM's rectangle handed to the player's canvas reads
 * an area where nothing was going to happen, and a check written that way passes
 * by measuring the wrong silence.
 */
const boxFor = (grid) => {
  const [x0, y0] = grid.screenOfCell(startCell.x, startCell.y);
  const [x1, y1] = grid.screenOfCell(endCell.x, endCell.y);
  // Inset half a cell at both ends, so the box holds the ground the trail
  // crossed and not the two token discs sitting at its corners.
  const half = grid.size / 2;
  return [x0 + half, y0 + half, x1 - x0 - grid.size, y1 - y0 - grid.size];
};
const dmBox = boxFor(dmGrid);
const playerBox = boxFor(playerGrid);
const boxOf = (page, test) => fractionOf(page, test, ...(page === dm ? dmBox : playerBox));

// The DM's board as it stands before anything is dragged over it. The trail's
// colour there depends on whether this room has a wall across this drag, so what
// is asserted is that a trail is *drawn*; which colour it came out is below.
await remember(dm, ...dmBox);

/**
 * How blue and how amber that square of board already is, with nothing on it.
 *
 * Every reading below is a difference from this rather than from zero, and that
 * is the rule these drivers keep having to relearn: a trail is a *wash* over the
 * map, so what the map was painted decides what an absolute threshold means. A
 * dungeon in blues reads four percent blue with nothing drawn on it — enough to
 * make "the trail faded" fail on one map and pass on the next, having measured
 * the art both times.
 */
const resting = {
  dmBlue: await boxOf(dm, BLUE),
  dmAmber: await boxOf(dm, AMBER),
  playerBlue: await boxOf(player, BLUE),
  playerAmber: await boxOf(player, AMBER),
};
note(
  `the bare board reads ${(resting.dmBlue * 100).toFixed(1)}% blue and ` +
    `${(resting.dmAmber * 100).toFixed(1)}% amber on the DM's screen`,
);

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
//
// The number is *below* that fifth rather than between the two, because what is
// counted is the pixels the wash pushes over the blue test and not the pixels it
// covers: over a dungeon already painted in blues a good many were over it
// already and the tint moves nothing. Six points is what the bluest map to hand
// gives; three is still triple the line on its own, which is the thing this has
// to be able to tell it from.
const TRAIL_SHARE = 0.03;

const playerBlue = (await boxOf(player, BLUE)) - resting.playerBlue;
note(`the drag's box gained ${(playerBlue * 100).toFixed(1)} points of blue on the player's screen`);
check(
  'the player sees the trail under a token they are not dragging',
  playerBlue > TRAIL_SHARE,
  true,
);

const dmMoved = await movedSince(dm, ...dmBox);
const dmBlue = (await boxOf(dm, BLUE)) - resting.dmBlue;
const dmAmber = (await boxOf(dm, AMBER)) - resting.dmAmber;
note(`the DM's box changed by ${(dmMoved * 100).toFixed(1)}% — gaining ${(dmBlue * 100).toFixed(1)} points of blue and ${(dmAmber * 100).toFixed(1)} of amber`);
check('and so does the DM doing the dragging', dmMoved > TRAIL_SHARE, true);

// The wall hint, and the whole reason it is safe to have one. If this drag did
// cross masonry the DM's trail goes amber — and the player, watching the very
// same frames, still sees blue, because their client holds no walls to test
// against. Nothing had to ask who they were for that to be true.
if (dmAmber > 0.03) {
  note('this drag crosses a wall on the DM\'s screen');
  const playerAmber = (await boxOf(player, AMBER)) - resting.playerAmber;
  note(`${(playerAmber * 100).toFixed(1)} points of amber on the player's`);
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

// The table tab, not the token one: the switch moved there with `show_names`,
// because both are room-wide fields and a panel mirrors where its fields live.
await tab('table');
await dm.evaluate(`(() => {
  const s = document.querySelector('#table-diagonals');
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
  await dm.evaluate('document.querySelector("#table-diagonals").value'),
  'alternating',
);

// --- the drop, and the linger ------------------------------------------------

await dm.send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1,
});
await dm.wait(500);

const justAfter = (await boxOf(player, BLUE)) - resting.playerBlue;
note(`${(justAfter * 100).toFixed(1)} points of blue still there just after the drop`);
// Against what the same box read mid-drag rather than against the threshold: the
// claim is that the trail this client was already drawing *survives the drop*,
// and the two readings are the same measurement at two times. The trail has
// begun fading by now, so it is half of it rather than all.
check('the trail is still up just after the drop', justAfter > playerBlue / 2, true);

await player.wait(2400); // past LINGER_MS
const faded = (await boxOf(player, BLUE)) - resting.playerBlue;
note(`${(faded * 100).toFixed(1)} points once it has faded, against ${(justAfter * 100).toFixed(1)} before`);
// Against the reading taken while the trail was up, and not against a number
// picked out of the air. What is left in the box when the trail goes is the map,
// and how blue *that* is depends on what the art was painted — the rule these
// drivers keep relearning. An absolute threshold here is a check that passes on
// a dungeon floor and fails on a river, having measured neither.
check('and gone once it has faded', faded < justAfter / 4, true);

await dm.evaluate(`(() => {
  const s = document.querySelector('#table-diagonals');
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

/**
 * The two rows this script rolled for, out of however many the order holds.
 *
 * Counting the whole panel would be asserting that the room's initiative order
 * was empty when the run started, which is a fact about the room and not about
 * the panel — a scratch state copied from a game in progress fails five checks
 * here with nothing wrong. The same reason the token is looked for rather than
 * assumed to be under the middle of the view.
 */
const MINE = ['Saelyn', 'Ruler Test'];
const ours = (list) => list.filter((row) => MINE.includes(row.name));
const rowFor = (list, name) => list.find((row) => row.name === name);
const placeOf = (list, name) => list.findIndex((row) => row.name === name);

const dmRows = await rows(dm);
const playerRows = await rows(player);
note('DM rows:   ', JSON.stringify(ours(dmRows)));
note('player rows:', JSON.stringify(ours(playerRows)));

check('the DM sees both rows', ours(dmRows).length, 2);
check('every row has a portrait slot', dmRows.every((r) => r.hasArtSlot), true);
check('the party portrait is loaded', dmRows.find((r) => r.name === 'Saelyn')?.art, true);
// The token this script built has no art, and must degrade to the grey disc
// rather than to an empty box — same failure the canvas already handles.
check('a token with no art still gets its disc', dmRows.find((r) => r.name === 'Ruler Test')?.hasArtSlot, true);
check('and no background image on it', dmRows.find((r) => r.name === 'Ruler Test')?.art, false);
check('every row can be looked at', dmRows.every((r) => r.lookable), true);
check('the player sees both rows too', ours(playerRows).length, 2);

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

// --- correcting a roll in place ----------------------------------------------
//
// The dropdown stops offering a token once it is in the order, which is what
// makes the row's own field the way back to its value rather than a convenience.
// It sends `set_initiative`, the same command the form above sends.

check(
  'a token that has rolled is off the dropdown',
  await dm.evaluate(`[...document.querySelector('#init-token').options]
    .some(o => o.textContent === 'Saelyn')`),
  false,
);

const values = (page) =>
  page.evaluate(`[...document.querySelectorAll('.init-row')].map(r => {
    const el = r.querySelector('.init-value');
    return { name: r.querySelector('.init-name').textContent, tag: el.tagName, value: el.value ?? el.textContent };
  })`);

// The number the DM types is not a click on the row, so the camera has to stay
// where it is — the same rule the × already follows, for the same reason.
const cellBeforeEdit = await hudCell(dm);
await dm.evaluate(`[...document.querySelectorAll('.init-row')]
  .find(r => r.querySelector('.init-name').textContent === 'Saelyn')
  .querySelector('.init-value').click(); "ok"`);
await dm.wait(300);
const cellAfterEdit = await hudCell(dm);
check(
  'clicking the number does not also look at the creature',
  cellBeforeEdit.x === cellAfterEdit.x && cellBeforeEdit.y === cellAfterEdit.y,
  true,
);

// 18 down to 7 puts Saelyn under the 12 she was above, so the re-value and the
// re-sort are one assertion.
await dm.evaluate(`(() => {
  const field = [...document.querySelectorAll('.init-row')]
    .find(r => r.querySelector('.init-name').textContent === 'Saelyn')
    .querySelector('.init-value');
  field.value = '7';
  field.dispatchEvent(new Event('change'));
  return 'ok';
})()`);
await dm.wait(500);

const dmValues = await values(dm);
const playerValues = await values(player);
note('DM values:    ', JSON.stringify(dmValues));
note('player values:', JSON.stringify(playerValues));

check('the corrected value took', rowFor(dmValues, 'Saelyn')?.value, '7');
// Their order relative to *each other*, since a room mid-fight has rows above
// and below both of them and 18-down-to-7 says nothing about those.
check(
  'and the order re-sorted under it',
  placeOf(dmValues, 'Ruler Test') < placeOf(dmValues, 'Saelyn'),
  true,
);
// The table is holding the same fight. Their row is a span rather than a field,
// because re-valuing is the DM's and the panel is not the place to say so twice.
check('the table was told', rowFor(playerValues, 'Saelyn')?.value, '7');
check('and has nothing to type in', rowFor(playerValues, 'Saelyn')?.tag, 'SPAN');
check("the DM's is a field", rowFor(dmValues, 'Saelyn')?.tag, 'INPUT');

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
check('and the row is gone', ours(await rows(dm)).map((row) => row.name), ['Ruler Test']);

// --- put the room back -------------------------------------------------------
//
// The token is still selected from the centre-of-view click above, which is why
// this can delete it without hunting for it again — and deleting it takes its
// initiative row with it, which is what makes the row this script rolled its own
// to clean up. `#init-clear` would do it in one click and would also throw away
// a fight the room was in the middle of.

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

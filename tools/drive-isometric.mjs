// Drives calibrating a map to an isometric grid, with a player watching.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-isometric.mjs                 # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — a calibration is persisted, and
// remembered per URL besides. Point it at a scratch `SLATE_STATE`. It puts the
// board back on squares on the way out.
//
// Why a browser: the arithmetic of a diamond lattice is held by unit tests on
// both sides of the wire — `fog::basis` in Rust, `gridBasis` and the coordinate
// round trips in TypeScript. What neither can see is whether those two halves
// still agree once a real `set_map` has crossed the socket and come back, which
// is the only question this asks.
//
// Why a player as well: `grid_shape` rides on `MapInfo` unfiltered, the way `fog`
// does, so the table is looking at the same lattice. A shape the DM could see and
// the players could not would be seven boards disagreeing about which cell a
// token is standing in, and one browser cannot see that.
//
// `board.mjs`'s `lattice` is deliberately not used here. It measures the grid off
// the HUD and asserts the reading is square, which is right for every other
// driver and is the thing this one exists to break.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const player = await open(`${base}/?room=campaign`, { port: 9334 });
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
 * The map panel's readout, which is the only DM-visible statement of the
 * lattice — and, after an apply, a statement about what the *server* sent back:
 * it is rendered from the board, and the board was rebuilt from the frame.
 */
const readout = () => dm.evaluate('document.querySelector("#map-readout").textContent');

/** Stashes a canvas, so the next call can count what moved. A difference rather
 *  than a reading, because how much of a board is grid lines depends entirely on
 *  the art underneath them. */
const remember = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    window.__before = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return c.width * c.height;
  })()`);

/**
 * The board's mean brightness, as a guard on the *play area* rather than the grid.
 *
 * `drawOutsidePlayArea` dims everything outside the playable region, so a rule
 * that wrongly shrinks it takes the whole board dark — which is exactly what the
 * first cut of this feature did: `repreview` derived a play area from the drag,
 * and an isometric drag is one cell's edge rather than a region of the board, so
 * the board collapsed to a sliver the size of one diamond. The readout was
 * perfect throughout, which is why this is measured off the canvas instead.
 */
const brightness = (session) =>
  session.evaluate(`(() => {
    const c = document.getElementById('stage');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
    return Math.round(sum / (d.length / 4) / 3);
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
    return Math.round((n / (c.width * c.height)) * 1000) / 10;
  })()`);

// --- the panel offers the choice -------------------------------------------

await dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
  .find(b => b.dataset.tab === 'map').click(); "ok"`);
await dm.wait(300);

const wasSquare = await readout();
note(`the board starts at: ${wasSquare}`);
check('the board starts on squares', /iso/.test(wasSquare), false);

await dm.evaluate('document.querySelector("#map-calibrate").click(); "ok"');
await dm.wait(200);
check(
  'calibrating offers a cell shape, and opens on the one the board has',
  await dm.evaluate('document.querySelector("#map-shape").value'),
  'square',
);
check(
  'the cell count is on offer while it is square',
  await dm.evaluate('document.querySelector("#map-count").hidden'),
  false,
);

const pickShape = (value) =>
  dm.evaluate(`(() => {
    const s = document.querySelector('#map-shape');
    s.value = '${value}';
    s.dispatchEvent(new Event('change'));
  })(); "ok"`);

await pickShape('iso');
await dm.wait(200);

// The whole-image shortcut proposes a *region*, and an edge gesture has no
// region in it — the rail's rule about a way in to something that can do
// nothing, one level down. The count stays, because "how many cells did that
// drag cross" is a question both gestures ask.
check(
  'choosing isometric puts the whole-image shortcut away',
  await dm.evaluate('document.querySelector("#map-whole").hidden'),
  true,
);
check(
  'and keeps the cell count, which both gestures ask',
  await dm.evaluate('document.querySelector("#map-count").hidden'),
  false,
);
// One drag, one diamond, unless the DM says otherwise: the gesture as it was
// before the count reached it. A 4 carried over from the square path would
// divide the next traced edge into slivers.
check(
  'and starts at one cell rather than the square default',
  await dm.evaluate('document.querySelector("#map-cells").value'),
  '1',
);
check(
  'and the hint asks for an edge rather than a box',
  await dm.evaluate('document.querySelector("#map-hint").textContent'),
  'Drag along that many diamond edges, corner to corner.',
);

// --- one dragged edge is the whole gesture ---------------------------------

// Half a diamond's width across and half its height down, which is a 2:1 cell —
// the common projection. These are screen pixels and the camera scales both, so
// the *ratio* is what survives whatever the zoom happens to be, and the ratio is
// all the assertions below read.
const size = JSON.parse(
  await dm.evaluate(`(() => {
    const c = document.getElementById('stage');
    return JSON.stringify({ w: c.width, h: c.height });
  })()`),
);
const x0 = Math.round(size.w / 2) - 120;
const y0 = Math.round(size.h / 2) - 60;

await remember(dm);
const litBefore = await brightness(dm);
await dm.drag(x0, y0, x0 + 120, y0 + 60);
await dm.wait(300);

// Choosing a cell shape is not choosing a playable region, so the board must be
// as lit after the gesture as before it. A tolerance rather than equality: the
// grid itself redraws, which moves a few pixels either way.
const litAfter = await brightness(dm);
note(`board brightness ${litBefore} -> ${litAfter}`);
check(
  'the drag leaves the playable region alone',
  litAfter > litBefore * 0.9,
  true,
);

check(
  'a dragged edge is kept rather than committed',
  await dm.evaluate('document.querySelector("#map-apply-row").hidden'),
  false,
);
const preview = await readout();
note(`preview reads: ${preview}`);
check('and it previews as a 2:1 diamond', /preview .* iso 2:1/.test(preview), true);
const previewMoved = await changed(dm);
note(`the DM's board moved ${previewMoved}% of its pixels`);
check('the grid redrew under the preview', previewMoved > 1, true);

// --- and it survives the round trip ----------------------------------------

await remember(player);
await dm.evaluate('document.querySelector("#map-apply").click(); "ok"');
await dm.wait(900);

const applied = await readout();
note(`the board came back as: ${applied}`);
// The readout is rendered from the board, and the board was rebuilt from the
// frame the server sent — so this is the whole chain in one string: the gesture,
// `shapeOf`, `set_map`, the server's bounds, `MapInfo`, `gridBasis`, back out.
check('the server accepted the shape and sent it back', /iso 2:1/.test(applied), true);
check('and it is committed rather than previewing', /preview/.test(applied), false);

const moved = await changed(player);
note(`the player's board moved ${moved}% of its pixels`);
check('the table is looking at the same lattice', moved > 1, true);

// --- re-opening the panel opens on what the board is ------------------------

const calibrate = () => dm.evaluate('document.querySelector("#map-calibrate").click(); "ok"');

await calibrate(); // on
await dm.wait(150);
await calibrate(); // off again
await dm.wait(150);
await calibrate(); // and back on, which is the state the rest of this needs
await dm.wait(250);
// And on the entry that *keeps* it where it is: the board came out at 2:1, so
// re-opening on the free gesture would offer to re-aim a ratio that is already
// right, which is the thing the fixed entry exists to stop.
check(
  'the panel re-opens on isometric rather than offering to square it',
  await dm.evaluate('document.querySelector("#map-shape").value'),
  'iso-fixed',
);

// --- the fixed gesture takes the size and not the proportions ---------------

// The same sloppy drag under both isometric entries. It is 120 across by 52
// down, which is 2.3:1 — a couple of pixels off a real tile edge, which is what
// aiming half of one on real art actually looks like. Free believes it; fixed
// projects it onto the 2:1 edge and keeps the ratio, which is the whole feature
// and is the difference between these two checks.
const sloppy = () => dm.drag(x0, y0, x0 + 120, y0 + 52);

await pickShape('iso');
await dm.wait(200);
await sloppy();
await dm.wait(300);
const free = await readout();
note(`the free gesture previews: ${free}`);
check('a sloppy drag read freely is not 2:1', /iso 2:1/.test(free), false);

// Changing the entry abandons the drag, so this is a fresh reading of the same
// gesture rather than the previous one reinterpreted.
await pickShape('iso-fixed');
await dm.wait(200);
check(
  'the fixed entry says which half of the gesture still matters',
  await dm.evaluate('document.querySelector("#map-hint").textContent'),
  'Drag along that many diamond edges — they stay 2:1.',
);
check(
  'and it hides the whole-image shortcut like the free one does',
  await dm.evaluate('document.querySelector("#map-whole").hidden'),
  true,
);
await sloppy();
await dm.wait(300);
const fixed = await readout();
note(`the fixed gesture previews: ${fixed}`);
check('the same drag pinned comes out exactly 2:1', /preview .* iso 2:1/.test(fixed), true);

// --- the count divides a traced run, after the fact --------------------------

// Tracing the whole edge of a room and then saying how many tiles that was is
// the easier gesture — a mistake in it is visible over the run rather than
// hidden in one tile and multiplied across the map. So the count has to be
// correctable *after* the drag, exactly as it is on the square path.
const setCells = (n) =>
  dm.evaluate(`(() => {
    const c = document.querySelector('#map-cells');
    c.value = '${n}';
    c.dispatchEvent(new Event('input'));
  })(); "ok"`);

await dm.drag(x0, y0, x0 + 240, y0 + 104); // twice the sloppy run, still at one
await dm.wait(300);
const undivided = await readout();
note(`the whole run at one cell reads: ${undivided}`);
check('a run read as one cell is twice the cell', undivided !== fixed, true);

await setCells(2);
await dm.wait(300);
const divided = await readout();
note(`the same run split in two reads: ${divided}`);
// The identical string, offsets and all: dividing the drag by two is the same
// statement as the single edge, and the anchor is the corner the drag began on
// either way. Anything less than equality here would be a lattice that moved.
check('correcting the count after the drag divides it exactly', divided, fixed);

// --- put the room back ------------------------------------------------------

await pickShape('square');
await dm.wait(200);
// A box read as four squares and the same box read as one diamond's edge are
// different claims about the map, so the shape switch abandons the drag rather
// than silently making the second one.
check(
  'switching back drops the preview rather than carrying it across',
  await dm.evaluate('document.querySelector("#map-apply-row").hidden'),
  true,
);

// Restored through the whole-image shortcut rather than by dragging, because
// this has to be *exact*: the built-in map is 1664 px across at 26 cells, so
// that count gives 64 px/cell with both offsets wrapping to zero, which is
// `MapInfo::default()` to the pixel. A hand-drawn box lands a fraction off, and
// a fraction is enough to move every cell out from under `drive-fog`'s traced
// walls — drivers may be run in any order, so putting the room back means
// putting it back and not nearly.
await dm.evaluate('document.querySelector("#map-whole").click(); "ok"');
await dm.wait(300);
await dm.evaluate(`(() => {
  const c = document.querySelector('#map-cells');
  c.value = '26';
  c.dispatchEvent(new Event('input'));
})(); "ok"`);
await dm.wait(300);
await dm.evaluate('document.querySelector("#map-apply").click(); "ok"');
await dm.wait(900);

const left = await readout();
note(`the board is left at: ${left}`);
check('the board is left exactly as it was found', left, wasSquare);

const failures = verdict(dm);
const alsoPlayer = player.errors.length > 0;
if (alsoPlayer) console.log(`the player's page logged errors: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(failures === 0 && !alsoPlayer ? 0 : 1);

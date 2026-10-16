// Drives the outgoing map's monsters on a promote: hidden from preview, kept by
// *bring to next map*, removed otherwise.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-encounter.mjs                # or: ... http://host:port secret
//
// It runs against a live room and *changes it*: it discards whatever was staged,
// stages a map, builds two monsters on the board and promotes. Point it at a
// scratch `SLATE_STATE`.
//
// One browser, because every claim here is about the DM's own screen: what
// preview draws, what it lets them grab, and which button the token tab offers.
// What the table is sent on the promote is the server suite's question
// (`a_monster_the_table_never_saw_leaves_without_a_word`).
//
// The paint check is a difference, per `board.mjs`: the kobold's cell is read in
// preview before and after the plan arrives, and only the plan changed between
// the two readings.

import { open, checks } from './cdp.mjs';
import { latticeOrBail, tokenAt, findToken } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`);
const { check, note, verdict } = checks();
await dm.wait(2500);

const run = String(Date.now() % 100000);
const kobold = `Kobold ${run}`;
const gnoll = `Gnoll ${run}`;
const hero = `Hero ${run}`;

const openTab = (name) =>
  dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(b => b.dataset.tab === '${name}').click(); "ok"`);
const clickId = async (id, wait = 400) => {
  await dm.evaluate(`document.getElementById('${id}').click(); "ok"`);
  await dm.wait(wait);
};
const hidden = (id) => dm.evaluate(`document.getElementById('${id}').hidden`);
const previewing = () => dm.evaluate('document.body.classList.contains("previewing")');

const pickMap = (n) =>
  dm.evaluate(`(() => {
    const b = [...document.querySelectorAll('#map-library-list .map-library-pick')][${n}];
    if (b === undefined) return null;
    b.click();
    return b.textContent;
  })()`);
const openLibrary = async () => {
  await clickId('map-library', 1200);
};

/** Remembers a box of the canvas around a screen point. */
const mark = (x, y, r) =>
  dm.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const box = c.getBoundingClientRect();
    const sx = c.width / box.width;
    window.__box = [Math.round((${x} - box.left - ${r}) * sx), Math.round((${y} - box.top - ${r}) * sx),
                    Math.round(${2 * r} * sx)];
    const [bx, by, bw] = window.__box;
    window.__base = c.getContext('2d').getImageData(bx, by, bw, bw).data;
    return window.__base.length;
  })()`);

/** How many pixels in that box changed since `mark`. */
const changed = () =>
  dm.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const [bx, by, bw] = window.__box;
    const now = c.getContext('2d').getImageData(bx, by, bw, bw).data;
    const base = window.__base;
    let moved = 0;
    for (let i = 0; i < now.length; i += 4) {
      const was = (base[i] + base[i + 1] + base[i + 2]) / 3;
      const is = (now[i] + now[i + 1] + now[i + 2]) / 3;
      if (Math.abs(is - was) > 6) moved++;
    }
    return moved;
  })()`);

// --- two different maps: one on the board, one staged ----------------------

await openTab('map');
await clickId('map-slot-next', 300);
await clickId('map-discard', 500);
await clickId('map-slot-live', 300);
await openLibrary();
note(`the board: ${await pickMap(0)}`);
await dm.wait(2500);

// The board framed whole, so the monsters are built near its middle, which is
// where the staged map is most likely to have ground too.
await clickId('fit-board', 600);

// --- two monsters on the board ----------------------------------------------

await openTab('token');
// The hero belongs to the first player on the roster: a party token, which
// always comes along and is offered neither button.
for (const [name, player] of [
  [kobold, false],
  [gnoll, false],
  [hero, true],
]) {
  await dm.evaluate(`(() => {
    const fresh = document.getElementById('token-new');
    if (!fresh.hidden) fresh.click();
    document.getElementById('token-name').value = ${JSON.stringify(name)};
    const owner = document.getElementById('token-owner');
    owner.value = ${player} ? owner.options[1].value : '';
    document.getElementById('token-save').click();
    return 'ok';
  })()`);
  await dm.wait(600);
}

await openTab('map');
await clickId('map-slot-next', 300);
await openLibrary();
note(`staged: ${await pickMap(1)}`);
await dm.wait(2500);
check('the DM is previewing the staged map', await previewing(), true);
await clickId('map-slot-live', 600);
check('and is back on the board', await previewing(), false);

const live = await latticeOrBail(dm, [dm], { zoom: false });
note(`board: ${live.describe}`);
const k = await findToken(dm, live, kobold);
const g = await findToken(dm, live, gnoll);
check('the kobold is on the board', k !== null, true);
check('the gnoll is on the board', g !== null, true);
if (k === null || g === null) {
  dm.close();
  process.exit(verdict(dm) || 1);
}

// --- the token tab offers the button for a monster that would be removed ----

await openTab('token');
const h = await findToken(dm, live, hero);
check('the hero is on the board', h !== null, true);
if (h !== null) {
  check('the hero is selected', await tokenAt(dm, live, h), hero);
  check('a party token is not offered bring', await hidden('token-bring'), true);
  check('nor leave behind', await hidden('token-leave'), true);
}
check('the kobold is selected', await tokenAt(dm, live, k), kobold);
check('bring to next map is offered for it', await hidden('token-bring'), false);
check(
  'and the hint says what happens without it',
  (await dm.evaluate('document.getElementById("token-hint").textContent')).includes('removed on promote'),
  true,
);

// --- preview draws neither monster, until one is brought --------------------
//
// The button is used on the board. Switching slots clears the selection
// (the token tab mustn't describe something not on screen), and preview
// doesn't draw these two, so there is nothing to select there.

const toLive = async () => {
  await openTab('map');
  await clickId('map-slot-live', 600);
  await clickId('fit-board', 600);
};
const toPreview = async () => {
  await openTab('map');
  await clickId('map-slot-next', 600);
  await clickId('fit-board', 600);
};
const bring = async () => {
  await toLive();
  await openTab('token');
  check('the kobold is selected on the board', await tokenAt(dm, live, k), kobold);
  await clickId('token-bring', 800);
  check('the button is gone, since it has a plan now', await hidden('token-bring'), true);
};

await toPreview();
check('previewing again', await previewing(), true);
const next = await latticeOrBail(dm, [dm], { zoom: false });
note(`preview: ${next.describe}`);

if (!next.onScreen(k.x, k.y, 20) || !next.onScreen(g.x, g.y, 20)) {
  note(`the monsters' cells are off the staged map's framing; this map pair can't run the preview checks`);
  await bring();
} else {
  check('the gnoll can not be grabbed in preview', await tokenAt(dm, next, g), null);
  check('nor can the kobold', await tokenAt(dm, next, k), null);

  // The kobold's cell in preview, before it has a plan. Switching slots and
  // back with nothing else done is the control: the reading must survive it,
  // because the real check below makes the same round trip.
  const [x, y] = next.screenOfCell(k.x, k.y);
  await mark(x, y, 14);
  await toLive();
  await toPreview();
  const quiet = await changed();
  check('the kobold cell holds still across a switch', quiet < 5, true);

  await bring();
  await toPreview();
  const drawn = await changed();
  note(`the kobold's cell changed by ${drawn} px once it was brought`);
  check('preview now draws the kobold', drawn > 20, true);
  check('and it can be grabbed there', await tokenAt(dm, next, k), kobold);

  // Leave behind takes the plan away again, and the preview goes back to the
  // reading taken before the kobold was brought.
  await toLive();
  await openTab('token');
  check('the kobold is selected for leaving', await tokenAt(dm, live, k), kobold);
  check('leave behind is offered once it has a plan', await hidden('token-leave'), false);
  check('and bring is not', await hidden('token-bring'), true);
  await clickId('token-leave', 800);
  check('leaving it swaps the buttons back', await hidden('token-bring'), false);
  check('and leave is gone', await hidden('token-leave'), true);
  await toPreview();
  const left = await changed();
  note(`the kobold's cell differs by ${left} px from before it was brought`);
  check('preview stops drawing it', left < 5, true);

  // And back again, so the promote below has something to keep.
  await bring();
}

// --- promote: the brought one stays, the other goes -------------------------

await openTab('map');
await clickId('map-promote', 1500);
check('the promote ended the preview', await previewing(), false);
await clickId('fit-board', 600);
const after = await latticeOrBail(dm, [dm], { zoom: false });
await openTab('token');
check('the kobold followed the party', await tokenAt(dm, after, k), kobold);
check('the gnoll stayed behind with the old map', await tokenAt(dm, after, g), null);
if (h !== null) {
  check('the hero came along without being asked', await tokenAt(dm, after, h), hero);
}

const code = verdict(dm);
dm.close();
process.exit(code);

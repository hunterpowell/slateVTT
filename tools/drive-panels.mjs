// Drives the two things milestone 26 added that only a browser can see: the
// initiative panel folding away, and the DM's solo sight.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-panels.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — it builds two tokens, rolls
// them into the order, advances the turn and turns the fog on. Point it at a
// scratch `SLATE_STATE`. It puts all of it back. Nothing here traces a wall:
// solo sight has a shape without one (a circle of light), which is what makes it
// cheaper to drive than room lighting was.
//
// Why a browser, for each half:
//
// **The fold is a layout fact.** Which rows are on screen cannot be read off the
// state model at all, and `hidden` on a parent is exactly the state the DOM
// reports as present. The fold also lives in `localStorage` rather than in the
// room, so the only honest way to assert that is to reload the page.
//
// **Solo sight is a canvas.** It replaces the table's wash on one client's board
// and touches the room not at all, which makes the negative half of it the
// interesting half: the *other* browser must not move a pixel, and no frame may
// leave the socket. A second connection is the only thing that can say so.

import { open, checks } from './cdp.mjs';
import { latticeOrBail } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const player = await open(`${base}/?room=campaign`, { port: 9334 });
const { check, note, verdict } = checks();

await dm.wait(2500);
await player.wait(2500);

// A player connection has to have claimed a name before it holds anything.
await player.evaluate(`(() => {
  const first = document.querySelector('.picker-choice');
  if (first) first.click();
  return 'ok';
})()`);
await player.wait(1500);

const tab = (page, label) =>
  page.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
    .find(b => b.textContent === "${label}").click(); "ok"`);

// ============================================================================
// The initiative panel folds the list and never the turn
// ============================================================================

/** The rows actually laid out, by name. `offsetParent` is null for anything
 *  inside a hidden panel as well as for anything not rendered at all, which is
 *  the distinction this whole section is about. */
const onScreen = (page) =>
  page.evaluate(`[...document.querySelectorAll('.init-row')]
    .filter(r => r.offsetParent !== null)
    .map(r => r.querySelector('.init-name').textContent)`);

const currentName = (page) =>
  page.evaluate(`(() => {
    const row = document.querySelector('.init-row.is-current .init-name');
    return row === null ? null : row.textContent;
  })()`);

const fold = (page) => page.evaluate(`document.getElementById('init-collapse').click(); "ok"`);

const folded = (page) =>
  page.evaluate(`document.getElementById('init-collapse').getAttribute('aria-expanded') === 'false'`);

// Whatever this room was left in. Two rows are needed for "one row" to mean
// anything, and a current turn is needed for it to be the right one — so this
// rolls its own rather than assuming a fight is already running.
await tab(dm, 'token');
await dm.evaluate(`(() => {
  const fresh = document.getElementById('token-new');
  if (!fresh.hidden) fresh.click();
  return 'ok';
})()`);
await dm.wait(200);

const build = async (name) => {
  await dm.evaluate(`(() => {
    const fresh = document.getElementById('token-new');
    if (!fresh.hidden) fresh.click();
    return 'ok';
  })()`);
  await dm.wait(150);
  await dm.evaluate(`document.getElementById('token-name').value = ${JSON.stringify(name)}; "ok"`);
  await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
  await dm.wait(500);
};

// Named for this run, so a token left behind by a run that failed partway can
// never be mistaken for one of these — two creatures with the same name is a
// driver reading the wrong row and reporting it as a regression, which cost two
// runs before it was noticed. The sweep at the bottom takes every `Panel …`
// whatever run built it, so leftovers do not accumulate either.
const RUN = Date.now().toString(36).slice(-4);
const MINE = [`Panel A ${RUN}`, `Panel B ${RUN}`];
const PANEL_TOKEN = /^Panel [AB] /;
for (const name of MINE) await build(name);

const roll = async (name, value) => {
  const ok = await dm.evaluate(`(() => {
    const sel = document.querySelector('#init-token');
    const opt = [...sel.options].find(o => o.textContent === ${JSON.stringify(name)});
    if (!opt) return 'missing';
    sel.value = opt.value;
    document.querySelector('#init-value').value = '${value}';
    document.querySelector('#init-add').requestSubmit();
    return 'ok';
  })()`);
  await dm.wait(400);
  return ok;
};

check('the driver rolled its first token in', await roll(MINE[0], 19), 'ok');
check('and its second', await roll(MINE[1], 17), 'ok');

// `set_initiative` does not on its own decide whose turn it is on a room that
// was not in combat, so this makes sure there is one to fold down to.
if ((await currentName(dm)) === null) {
  await dm.evaluate(`document.getElementById('init-next').click(); "ok"`);
  await dm.wait(400);
}

const startedFolded = await folded(dm);
if (startedFolded) {
  await fold(dm);
  await dm.wait(200);
}

const up = await currentName(dm);
note(`it is ${up}'s turn`);
const expanded = await onScreen(dm);
check('the whole order is on screen to begin with', expanded.length > 1, true);

await fold(dm);
await dm.wait(250);
const one = await onScreen(dm);
check('folded, the list is one row', one.length, 1);
check('and it is the row whose turn it is', one[0], up);
check('the chevron says so', await folded(dm), true);

// Advancing the turn from a folded panel is most of what folding it is for, so
// the turn buttons stay. The DM's editing controls fold with the rows they edit.
check(
  'the turn buttons are still reachable',
  await dm.evaluate(`document.getElementById('init-next').offsetParent !== null`),
  true,
);
check(
  'the roll form folded with the rows it edits',
  await dm.evaluate(`document.getElementById('init-add').offsetParent === null`),
  true,
);

await dm.evaluate(`document.getElementById('init-next').click(); "ok"`);
await dm.wait(500);
const next = await onScreen(dm);
const nowUp = await currentName(dm);
check('the folded panel still shows exactly one row', next.length, 1);
check('and it followed the turn', next[0], nowUp);
check('which is somebody else now', nowUp !== up, true);

// A per-person screen preference and not a room field, which is the line
// `diagonals` falls on the other side of. Two assertions say so: the table is
// untouched, and a reload remembers.
// The table's own panel, given a beat to catch up: `dm.wait` is one browser's
// clock and says nothing about when the other one finished laying out the frame
// the room sent it.
await player.wait(800);
const playerHeld = await player.evaluate(
  `[...document.querySelectorAll('.init-row .init-name')].map(el => el.textContent)`,
);
const playerRows = await onScreen(player);
note(`the table holds ${JSON.stringify(playerHeld)} and has ${playerRows.length} of them on screen`);
check('the table was not folded along with the DM', playerRows.length > 1, true);

// Back to the *DM* URL rather than `location.reload()`. The secret is stripped
// out of the address bar before anything can screenshot it, so reloading what is
// left reconnects as a player and there is no DM panel left to assert about.
// localStorage is per origin and survives the navigation either way, which is
// the thing actually under test.
await dm.evaluate(`location.href = ${JSON.stringify(`${base}/?room=campaign&dm=${secret}`)}; "ok"`);
await dm.wait(3500);
check('the fold survived a reload', (await onScreen(dm)).length, 1);

await fold(dm);
await dm.wait(250);
check('and unfolding gives the order back', (await onScreen(dm)).length > 1, true);
check(
  'leaving the roll form where it was found',
  await dm.evaluate(`document.getElementById('init-add').offsetParent !== null`),
  true,
);

// ============================================================================
// Solo sight
// ============================================================================

/** How many pixels of a board differ from the frame remembered on it. */
const remember = (page) =>
  page.evaluate(`(() => {
    const c = document.querySelector('#stage');
    window.__before = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return window.__before.length / 4;
  })()`);

const changed = (page) =>
  page.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const was = window.__before;
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (now[i] !== was[i] || now[i + 1] !== was[i + 1] || now[i + 2] !== was[i + 2]) n++;
    }
    return (100 * n) / (now.length / 4);
  })()`);

// A driver may not assume the board it was written against, and it may not erase
// the DM's dungeon to make room for its own — the rule `drive-fog.mjs` learned.
// Solo sight has a shape without walls (a circle of light), so unlike room
// lighting this one does not have to trace anything, and deliberately does not.
const traced = await dm.evaluate(`(() => {
  const el = document.querySelector('#wall-readout');
  return el === null ? '' : el.textContent;
})()`);
note(`the board's wall readout says "${traced.trim()}"`);

const lattice = await latticeOrBail(dm, [dm, player]);
note(lattice.describe);

/**
 * Puts a creature under the middle of the viewport and hands back where to click
 * for it.
 *
 * Clicking its initiative row is what moves the camera, and that is a much
 * better way to find a token than hunting the board with `findToken`: it is one
 * click rather than up to a hundred, it cannot miss, and it leaves no ruler
 * trails behind on every client to settle before a pixel reading means anything.
 * `lattice.middle` is the viewport's centre in screen pixels and so is the one
 * coordinate that does not go stale when the camera moves.
 */
const lookAt = async (name) => {
  const found = await dm.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    if (!row) return 'missing';
    row.click();
    return 'ok';
  })()`);
  if (found !== 'ok') return null;
  await dm.wait(900);

  // The camera has just moved, so any lattice measured before it is stale —
  // hence a fresh one, and `zoom: false` so measuring does not move the camera
  // again on the way. Then click the **centre of the cell** the creature is
  // standing in rather than the middle of the viewport: `look` puts its cell
  // under the middle, and the middle is up to half a cell from the cell's
  // centre — which is enough to hit the neighbour when two creatures are
  // standing side by side, and did.
  const now = await latticeOrBail(dm, [dm, player], { zoom: false });
  const cell = await now.cellUnder(now.middle.x, now.middle.y);
  if (cell === null) return null;
  const [x, y] = now.screenOfCell(cell.x, cell.y);
  return { x, y };
};

// Fog has to be on for the table to have a wash for this to replace. Remembered
// so it goes back.
await tab(dm, 'fog');
await dm.wait(200);
const fogWas = await dm.evaluate(`(() => {
  const box = document.querySelector('#fog-on');
  if (!box.checked) box.click();
  return 'ok';
})()`);
check('fog is on for the run', fogWas, 'ok');
await dm.wait(900);

const sightButton = () => dm.evaluate(`document.querySelector('#fog-sight').textContent.trim()`);

check('the sight check button is there', await sightButton(), 'sight check');
check(
  'and it is reachable on a live board',
  await dm.evaluate(`document.querySelector('#fog-sight').disabled`),
  false,
);

// `Panel A` is the DM's own, which is the point of `anchorTokenAt` rather than
// `tokenAt` in `input.ts` — the interesting question at a table is nearly always
// about a token the DM does *not* own, so the hit test has to reach every token
// on the board rather than only the movable ones.
const target = await lookAt(MINE[0]);

if (target === null) {
  note('could not find the row for the token this driver built — skipping the solo half');
} else {
  // A click on a token is a zero-length drag, so it leaves a ruler and a trail
  // on *every* client, fading over a couple of seconds. Remembering a frame
  // before those have gone measures the fade on both boards and reads it as a
  // leak — the linger `docs/drawings.md` describes, met from the other side.
  await dm.wait(3000);
  await remember(dm);
  await remember(player);

  await dm.evaluate(`document.querySelector('#fog-sight').click(); "ok"`);
  await dm.wait(200);
  check(
    'arming it takes the left button',
    await dm.evaluate(`document.body.classList.contains('checking-sight')`),
    true,
  );

  await dm.click(target.x, target.y);
  await dm.wait(700);

  check(
    'clicking a creature picks it',
    await dm.evaluate(`document.body.classList.contains('solo-sight')`),
    true,
  );
  // Which creature is deliberately not asserted. Where the server drops a new
  // token is a fact about how much of the board is already occupied, and a
  // driver may not assume the room it was written against — so this says the
  // button is naming *a* creature, which is the thing the control promises.
  // Which one it named is in the log.
  const naming = await sightButton();
  note(`the button reads "${naming}"`);
  check('and the button names the creature it picked', /^seeing as .+/.test(naming), true);
  check(
    'the tool disarms itself, because picking one is a one-shot gesture',
    await dm.evaluate(`document.body.classList.contains('checking-sight')`),
    false,
  );
  // `getComputedStyle` rather than `offsetParent`, which is null for a
  // `position: fixed` element whether it is on screen or not — the tag is fixed
  // like the preview one it borrows its treatment from.
  check(
    'and the label says the DM is looking at something nobody else is',
    await dm.evaluate(
      `getComputedStyle(document.querySelector('#sight-tag')).display !== 'none'`,
    ),
    true,
  );

  const dmMoved = await changed(dm);
  const playerMoved = await changed(player);
  note(`solo sight moved the DM's board by ${dmMoved.toFixed(1)}%, the player's by ${playerMoved.toFixed(1)}%`);

  // The DM's faint wash is replaced by the table-strength answer, which is a
  // large change by construction. The player's board is the assertion: this is
  // computed on one client from walls only that client holds, so nothing left
  // the socket and there is nothing for the room to relay.
  check('the DM gets a different board', dmMoved > 2, true);
  check('and the table is told nothing at all', playerMoved < 0.5, true);

  // Putting the tool down gives the answer up with it — one button, and the
  // rail's rule that closing a tab puts down whatever the panel armed.
  await dm.evaluate(`document.querySelector('#fog-sight').click(); "ok"`);
  await dm.wait(600);
  check('clicking it again goes back to the table’s board', await sightButton(), 'sight check');
  check(
    'and the border comes off',
    await dm.evaluate(`document.body.classList.contains('solo-sight')`),
    false,
  );

  // Closing the tab has to do the same thing, which is the rail's rule and the
  // reason `stop()` clears the answer as well as the arming.
  await dm.evaluate(`document.querySelector('#fog-sight').click(); "ok"`);
  await dm.wait(150);
  await dm.click(target.x, target.y);
  await dm.wait(500);
  check('armed and picked again', await dm.evaluate(`document.body.classList.contains('solo-sight')`), true);
  await tab(dm, 'fog');
  await dm.wait(400);
  check(
    'closing the tab puts the answer down with the tool',
    await dm.evaluate(`document.body.classList.contains('solo-sight')`),
    false,
  );
}

// --- put the room back -------------------------------------------------------

await tab(dm, 'fog');
await dm.wait(200);
await dm.evaluate(`(() => {
  const box = document.querySelector('#fog-on');
  if (box.checked) box.click();
  return 'ok';
})()`);
await dm.wait(600);

// Clicking the row *looks* at the creature and does not select it in the panel —
// the two are deliberately different gestures. So this centres the camera on the
// row, then clicks the middle of the view to put that token in the form, and
// only deletes once the form says the right name. Deleting whatever the panel
// happened to be describing is how a cleanup eats a member of the party.
//
// Looped rather than done once per name, because a run that failed partway may
// have left more than one token by the same name behind.
await tab(dm, 'token');
await dm.wait(200);

const rowNames = () =>
  dm.evaluate(`[...document.querySelectorAll('.init-row .init-name')].map(el => el.textContent)`);

for (let attempt = 0; attempt < 12; attempt++) {
  const names = await rowNames();
  const name = names.find((n) => PANEL_TOKEN.test(n));
  if (name === undefined) break;

  const at = await lookAt(name);
  if (at === null) break;

  await dm.click(at.x, at.y);
  await dm.wait(500);
  const inForm = await dm.evaluate(`document.getElementById('token-name').value`);

  // Deleting whatever the form happens to be describing is how a cleanup eats a
  // member of the party, so the guard is on the *name pattern* rather than on
  // the exact row: looking at one of a pair of adjacent creatures can put the
  // other under the middle, and either of those is this driver's to remove.
  if (!PANEL_TOKEN.test(inForm)) {
    note(`the form is describing "${inForm}", which this driver did not build — leaving it alone`);
    break;
  }
  await dm.evaluate(`document.getElementById('token-delete').click(); "ok"`);
  await dm.wait(700);
}

const left = (await rowNames()).filter((n) => PANEL_TOKEN.test(n));
check('the tokens this driver built are gone, and their rows with them', left, []);

process.exit(verdict(dm));

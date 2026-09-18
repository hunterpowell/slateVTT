// Drives the initiative panel folding away, the damage box, and the markers —
// the three things on this panel that only a browser can see.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-panels.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — it builds two tokens, rolls
// them into the order and advances the turn. Point it at a scratch
// `SLATE_STATE`. It puts all of it back.
//
// **The fold is a layout fact.** Which rows are on screen cannot be read off the
// state model at all, and `hidden` on a parent is exactly the state the DOM
// reports as present. The fold also lives in `localStorage` rather than in the
// room, so the only honest way to assert that is to reload the page.
//
// **The other half of milestone 26 is gone from here**, along with the control
// it drove: milestone 34 hid the solo sight check, since player view answers the
// same question about the whole table. What it used to assert — the DM's board
// changing while the *player's* moves by nothing at all — is worth reading in
// `git log` on the day milestone 29 turns the button back on. Until then this
// driver has one subject and a second browser it keeps only to prove the fold is
// one client's own business.

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

const build = async (name, hp = null) => {
  await dm.evaluate(`(() => {
    const fresh = document.getElementById('token-new');
    if (!fresh.hidden) fresh.click();
    return 'ok';
  })()`);
  await dm.wait(150);
  await dm.evaluate(`document.getElementById('token-name').value = ${JSON.stringify(name)}; "ok"`);
  // Hit points are what puts a damage box on the row, so one of the two
  // creatures gets a total and the other deliberately does not — the row with
  // none is what says the box follows `hp` rather than being on every row.
  //
  // Written on every build, including the empty case. The token panel keeps its
  // fields after a create on purpose — six goblins is six clicks — so a total
  // typed for the first creature is still sitting there for the second, and
  // "leave it alone" would silently build two creatures with the same total.
  await dm.evaluate(`(() => {
    document.getElementById('token-hp').value = '${hp === null ? '' : hp}';
    document.getElementById('token-hp-max').value = '${hp === null ? '' : hp}';
    return 'ok';
  })()`);
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
await build(MINE[0], 27);
await build(MINE[1]);

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

// Advanced from the keyboard rather than the button, which is how the DM
// mostly will: bare `n`, the first unmodified letter key in the client. Two
// negatives first — a player's `n` is not bound at all, and inside a field it
// is a letter. The token panel's name box is the field: the panel is folded
// with its own roll form hidden, and the chat box stops every keydown from
// propagating, so a letter typed there proves nothing about `typingIn`.
await player.key('n', 'KeyN', 78);
await player.wait(500);
check("a player's n does not advance the turn", await currentName(dm), up);

check(
  'the name box has focus',
  await dm.evaluate(`document.getElementById('token-name').focus(); document.activeElement.id`),
  'token-name',
);
await dm.key('n', 'KeyN', 78);
await dm.wait(500);
check('n typed into a field does not advance the turn', await currentName(dm), up);
await dm.evaluate(`document.getElementById('token-name').blur(); "ok"`);

await dm.key('n', 'KeyN', 78);
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
// The damage box on a row
// ============================================================================
//
// The arithmetic itself is `parseHpEntry` and is unit-tested in
// `client/src/panel.test.ts`. What only a browser can say is that the box is on
// the row at all, that committing it reaches the room and comes back, that the
// caret survives the rebuild that answer triggers — and that the box is absent
// from the table's copy of the same panel.

const hpText = (page, name) =>
  page.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    if (!row) return 'missing row';
    const el = row.querySelector('.init-hp-text');
    return el === null ? null : el.textContent;
  })()`);

/** Types into a row's box the way a DM does: focus it, then let it commit. */
const damage = async (name, text) => {
  const ok = await dm.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    if (!row) return 'missing row';
    const box = row.querySelector('.init-damage');
    if (!box) return 'no box';
    box.focus();
    box.value = ${JSON.stringify(text)};
    box.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  })()`);
  await dm.wait(600);
  return ok;
};

const HURT = MINE[0];
const NO_TOTAL = MINE[1];

check('the creature with a total starts where it was built', await hpText(dm, HURT), '27/27');
check(
  'a row with no total has no box to type in',
  await dm.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(NO_TOTAL)});
    return row === undefined ? 'missing row' : row.querySelector('.init-damage') === null;
  })()`),
  true,
);

check('a signed entry is damage', await damage(HURT, '-12'), 'ok');
check('and the row came back from the room twelve down', await hpText(dm, HURT), '15/27');

// The caret is the reason this feature needed anything beyond a new element.
// The room's echo of the hit replaces every row in the list, so without the
// restore the second hit on the same creature goes into a box that no longer
// exists.
check(
  'the caret survived the rebuild that answer caused',
  await dm.evaluate(`document.activeElement !== null &&
    document.activeElement.classList.contains('init-damage')`),
  true,
);

check('a plus entry heals', await damage(HURT, '+5'), 'ok');
check('and the row says so', await hpText(dm, HURT), '20/27');

check('a bare entry is the new total', await damage(HURT, '9'), 'ok');
check('and it set rather than subtracted', await hpText(dm, HURT), '9/27');

check('nonsense is accepted by the box', await damage(HURT, 'abc'), 'ok');
check('and changes nothing', await hpText(dm, HURT), '9/27');
check(
  'the box is empty either way, so no entry can be sent twice',
  await dm.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(HURT)});
    return row.querySelector('.init-damage').value;
  })()`),
  '',
);

// The negative assertion, and it is free rather than defended: `view_for`
// redacts `hp` for a player, so their copy of every token carries null and the
// `hp !== null` branch that builds the box never runs. Invariant 4 the safe way
// round — a secret forgotten in `view_for` would go missing from the DM's own
// panel rather than appear here.
await player.wait(800);
check(
  'the table holds the row and none of the numbers',
  await hpText(player, HURT),
  null,
);
check(
  'and has no damage box anywhere on the page',
  await player.evaluate(`document.querySelectorAll('.init-damage').length`),
  0,
);


// ============================================================================
// Markers — the one field on a token that the table is shown
// ============================================================================
//
// Four things only a browser can say, and the first is the one this feature
// would most plausibly have shipped broken:
//
//   * a hit landing on a marked creature leaves the marks alone. `update_token`
//     replaces the token whole, so the damage box has to carry them through, and
//     the failure is silent, a beat later, in a different control.
//   * the toggles are the DM's. Unlike the bar beside them this needs a real
//     check for who is reading it, because markers are *public* — a player's
//     copy of the token genuinely carries them, so there is no null here to make
//     the branch fail safe the way `hp` does.
//   * the pips reach the table's own board, which is the whole difference
//     between this field and `hp` and is pixels on somebody else's canvas.
//   * and taking one off puts that board back.

/** Whether a row's swatch reads as set. A string, so a missing row or a missing
 *  swatch reports as itself rather than as `false`. */
const swatch = (page, name, marker) =>
  page.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    if (!row) return 'missing row';
    const pip = row.querySelector('.marker[data-marker="${marker}"]');
    return pip === null ? 'missing swatch' : pip.getAttribute('aria-pressed');
  })()`);

/** Clicks it. The panel is rebuilt on the room's echo, so every call re-queries
 *  rather than holding an element across one. */
const mark = async (name, marker) => {
  const ok = await dm.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    if (!row) return 'missing row';
    const pip = row.querySelector('.marker[data-marker="${marker}"]');
    if (pip === null) return 'missing swatch';
    pip.click();
    return 'ok';
  })()`);
  await dm.wait(500);
  return ok;
};

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

check('a creature starts unmarked', await swatch(dm, HURT, 'red'), 'false');
check('clicking a swatch marks it', await mark(HURT, 'red'), 'ok');
check('and the room agreed, which is what put it back on the rebuilt row', await swatch(dm, HURT, 'red'), 'true');

// The carry-through. `-3` off 9 is 6, and the mark has to still be there
// afterwards: the damage box builds a whole `update_token` off the token the row
// resolved, so a field left out of it is wiped by the next hit that lands.
check('a hit lands on a marked creature', await damage(HURT, '-3'), 'ok');
check('and the total moved', await hpText(dm, HURT), '6/27');
check('the mark survived the hit', await swatch(dm, HURT, 'red'), 'true');

// The negative assertion, and unlike the damage box above it this one is
// defended rather than free — see the note at the top of this section.
await player.wait(800);
check(
  'the table is not offered the toggles',
  await player.evaluate(`document.querySelectorAll('.marker').length`),
  0,
);

// And the positive one, which is what makes this field different from every
// other DM-only thing on a token. Taken as a difference across the player's
// whole canvas rather than as a reading of a box in the DM's coordinates: the
// two cameras are not the same camera, and a box measured over there names
// nothing.
const boardPixels = await remember(player);
note(`the table's board is ${boardPixels} pixels`);

await mark(HURT, 'blue');
await player.wait(900);
const lit = await changed(player);
note(`${lit} pixels moved on the table's canvas`);
check('a second mark reaches the board the table is looking at', lit > 20, true);

// Against the same baseline, not a fresh one — so this says the board came back
// to where it started rather than merely that it moved again.
await mark(HURT, 'blue');
await player.wait(900);
const back = await changed(player);
note(`${back} pixels differ from the baseline once it is off again`);
check('and taking it off puts their board back where it was', back < 20, true);

// ---------------------------------------------------------------------------
// `dead`, the one mark that is not a colour
// ---------------------------------------------------------------------------
//
// It draws as an X across the portrait rather than as an arc in the band, and
// its swatch is an X rather than a disc — which is a *stylesheet* difference
// over identical markup, so it is exactly the kind of thing milestone 43 already
// shipped broken once. `#initiative button` beat `.marker.is-on` that time and
// no suite could see it, because `aria-pressed` was correct throughout. The
// lesson was to read the computed style when what changed is paint, so that is
// what this does.

const deadGlyph = (page, name) =>
  page.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    if (!row) return 'missing row';
    const pip = row.querySelector('.marker[data-marker="dead"]');
    if (pip === null) return 'missing swatch';
    const before = getComputedStyle(pip, '::before');
    // The content string comes back quoted, and the glyph is U+00D7, not an x.
    return before.content.includes('×') ? 'x' : before.content;
  })()`);

check('the seventh swatch is offered', await swatch(dm, HURT, 'dead'), 'false');
check('and it draws as an X rather than a disc', await deadGlyph(dm, HURT), 'x');

// The board half. Taken against a fresh baseline, and the X is a big mark on a
// small token, so this moves considerably more than an arc does.
await remember(player);
check('marking a creature dead is accepted', await mark(HURT, 'dead'), 'ok');
check('and the room agreed', await swatch(dm, HURT, 'dead'), 'true');
await player.wait(900);
const crossed = await changed(player);
note(`${crossed} pixels moved on the table's canvas`);
check('the X reaches the table, because a mark is public', crossed > 20, true);

// The thing `dead` must *not* do. It is a picture and nothing follows from it —
// the creature still holds its initiative row and still keeps its total — and a
// variant that started skipping turns is where this stops being a mark. Cheap to
// assert and the whole boundary of the feature.
check('a dead creature keeps its initiative row', await hpText(dm, HURT), '6/27');

// Left marked in red on purpose: the sweep at the bottom deletes both creatures,
// so the marks go with them and there is nothing here to put back by hand.

// ============================================================================
// Tidying up, and the one check left about the fog panel
// ============================================================================
//
// The lattice and `lookAt` below outlived the half of this driver that needed
// them for pixels: the cleanup at the bottom has to put the camera on each token
// it built before it can select and delete one, since clicking a row *looks* at
// a creature rather than selecting it.

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

// The one thing left to say about the sight check: it is not on offer. Hidden
// rather than greyed, so the assertion is that the DM cannot reach it at all —
// `hidden` on the element itself, which is what `SOLO_SIGHT` sets and what a
// greyed-out control would *not* report.
//
// The element is still in the document, deliberately: the tool goes on painting
// it, so bringing the feature back is one const rather than a reconstruction.
// This check is what fails on the day that const flips, which is the point of
// having it.
await tab(dm, 'fog');
await dm.wait(200);
check(
  'the sight check is not offered',
  await dm.evaluate(`document.querySelector('#fog-sight').hidden`),
  true,
);
check(
  'and player view is there instead',
  await dm.evaluate(`document.querySelector('#fog-view').hidden`),
  false,
);

// --- put the room back -------------------------------------------------------
//
// Nothing to put back but the tokens now. This used to turn the fog on for the
// wash solo sight replaced, and then off again — which was the one thing here
// that touched a room-wide setting, and it turned it *off* rather than back to
// where it was found.

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

// Drives player view: the DM's own board, showing what the table is looking at.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-mirror.mjs                    # or: ... http://host:port secret
//
// It runs against a live room and *changes it*: it builds a creature, rolls it
// into the order, hides it and turns the fog on. Point it at a scratch
// `SLATE_STATE`, never at the room you are about to play in. Everything it makes
// it takes away again on the last dozen lines.
//
// **One browser, unlike `drive-fog.mjs`, and that is the feature rather than a
// shortcut.** Fog is a difference between two clients and cannot be seen from
// one; this is a difference between two *boards on the same screen*, so a second
// session would have nothing to say. What it cannot do is prove the mirror is
// accurate — that is `mirror.test.ts`, which owns the filter itself. What only a
// browser can answer is whether the button is wired to anything, whether the
// board redraws, whether the panel that is not redrawn every frame keeps up, and
// whether closing the tab puts it down.
//
// The last of those is the one worth the run. A mirror the DM cannot account for
// is worse than no mirror: a monster missing from the board with nothing on
// screen saying why is a bug report about the token panel.

import { findToken, latticeOrBail } from './board.mjs';
import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`);
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

const tab = (name) =>
  dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(b => b.dataset.tab === '${name}').click(); "ok"`);

const mirroring = () => dm.evaluate('document.body.classList.contains("player-view")');
const pressed = () => dm.evaluate('document.querySelector("#fog-view").getAttribute("aria-pressed")');
const toggle = async () => {
  await dm.evaluate('document.querySelector("#fog-view").click(); "ok"');
  await dm.wait(400);
};

/** The rows of the initiative panel, which is where the mirror is visible in the
 *  DOM rather than in pixels. */
const rows = () =>
  dm.evaluate(`[...document.querySelectorAll('.init-row')].map(r => ({
    name: r.querySelector('.init-name')?.textContent ?? null,
    hp: r.querySelector('.init-hp-text')?.textContent ?? null,
  }))`);
const ours = async () => (await rows()).find((r) => r.name === 'Mirror Test') ?? null;

const setFogOn = (want) =>
  dm.evaluate(`(() => {
    const box = document.querySelector('#fog-on');
    if (box.checked !== ${want}) box.click();
    return box.checked;
  })()`);

/** Remembers the canvas, so the next frame can be compared against it. Same
 *  trick `drive-fog.mjs` uses, and for the same reason: how dark a board *is*
 *  depends on the art, and how much it changed depends on the button. */
const mark = () =>
  dm.evaluate(`(() => {
    const c = document.querySelector('#stage');
    window.__mirrorBase = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return window.__mirrorBase.length;
  })()`);

/** What share of the canvas got darker since `mark`, as a percentage. */
const darkened = () =>
  dm.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const base = window.__mirrorBase;
    if (base === undefined || base.length !== now.length) return -1;
    let down = 0;
    let n = 0;
    for (let i = 0; i < now.length; i += 16) {
      const was = (base[i] + base[i + 1] + base[i + 2]) / 3;
      const is = (now[i] + now[i + 1] + now[i + 2]) / 3;
      if (was - is > 6) down++;
      n++;
    }
    return Math.round((down / n) * 1000) / 10;
  })()`);

// --- the button ---------------------------------------------------------------

await tab('fog');
check('the fog panel opens', await dm.evaluate('!document.querySelector("#fogtool").hidden'), true);

// Read before anything is touched, so the tidy-up restores what was actually
// here rather than what a first boot happens to hold.
const fogFound = await dm.evaluate('document.querySelector("#fog-on").checked');
note(`fog was ${fogFound ? 'on' : 'off'}`);

check('nothing is mirrored to begin with', await mirroring(), false);
check('and the button says so', await pressed(), 'false');

await toggle();
check('the button turns the mirror on', await mirroring(), true);
check('and says so', await pressed(), 'true');
check(
  'the board says which board it is',
  await dm.evaluate(
    '(() => { const t = document.querySelector("#table-tag"); return getComputedStyle(t).display !== "none"; })()',
  ),
  true,
);
await toggle();
check('and clicking it again puts it down', await mirroring(), false);

// --- a creature to look for ----------------------------------------------------

await tab('token');
// Into creation mode first, or the panel is still describing whatever was last
// selected and saving *renames* it — a rerun quietly eating one of the party.
await dm.evaluate(`(() => {
  const fresh = document.getElementById('token-new');
  if (!fresh.hidden) fresh.click();
  return 'ok';
})()`);
await dm.wait(200);
await dm.evaluate(`document.getElementById('token-name').value = 'Mirror Test'; "ok"`);
await dm.evaluate(`(() => {
  document.getElementById('token-hp').value = '12';
  document.getElementById('token-hp-max').value = '40';
  document.getElementById('token-save').click();
  return 'ok';
})()`);
await dm.wait(800);

await dm.evaluate(`(() => {
  const sel = document.querySelector('#init-token');
  const opt = [...sel.options].find(o => o.textContent === 'Mirror Test');
  if (!opt) return 'missing';
  sel.value = opt.value;
  document.querySelector('#init-value').value = '7';
  document.querySelector('#init-add').requestSubmit();
  return 'ok';
})()`);
await dm.wait(600);

check('the DM has a row for it', (await ours())?.name, 'Mirror Test');
check('with the hit points on it', (await ours())?.hp, '12/40');

// --- the panel mirrors too -----------------------------------------------------

await tab('fog');
await toggle();
check('the row survives, since the table can see the creature', (await ours())?.name, 'Mirror Test');
check('but the hit points do not', (await ours())?.hp, null);
await toggle();
check('and they come back when the mirror does down', (await ours())?.hp, '12/40');

// --- a creature the table cannot see -------------------------------------------
//
// Hidden rather than in the dark, which is a choice about what this driver can
// promise. Where a new token lands is a fact about the room; `hidden` is a fact
// about the token, so this check means the same thing on every map.
//
// The panel has to be *describing* the creature before a save edits it rather
// than building a second one, and saving does not select what it just made — so
// the token is found on the board, which is what selects it. That is also the
// only reason this driver needs a lattice at all.
const grid = await latticeOrBail(dm, [dm], { zoom: false });
note(grid.describe);
const where = await findToken(dm, grid, 'Mirror Test');
check('the creature is findable on the board', where !== null, true);

await tab('token');
check(
  'and the panel is describing it',
  await dm.evaluate('document.getElementById("token-name").value'),
  'Mirror Test',
);
await dm.evaluate(`(() => {
  const box = document.getElementById('token-hidden');
  if (!box.checked) box.click();
  document.getElementById('token-save').click();
  return box.checked;
})()`);
await dm.wait(700);
check('the DM still has the row', (await ours())?.name, 'Mirror Test');

await tab('fog');
await toggle();
check('and the mirror takes it away', await ours(), null);
await toggle();
check('and hands it back', (await ours())?.name, 'Mirror Test');

// --- the fog draws at the table's strength -------------------------------------

await setFogOn(true);
await dm.wait(900);

// A control first: two frames with nothing touched at all. How much of this
// canvas is even board depends on the framing and on how much of the map the
// room has explored, so a fixed threshold would be a number picked to pass —
// the drivers' recurring lesson, arrived at here from the other side. What the
// number is measured against is a board where nothing happened.
await mark();
await dm.wait(400);
const still = await darkened();
note(`${still}% drifted with nothing touched`);

await mark();
await toggle();
const darker = await darkened();
note(`${darker}% of the canvas darkened`);
check('a board nobody touched holds still', still < 1, true);
// The wash goes from the DM's 0.42 to the table's 1.0 over every unexplored
// cell, which cannot move *nothing* on a board that has any.
check('the fog thickens to what the table is looking at', darker > still + 4, true);

// --- putting it down -----------------------------------------------------------

check('still mirroring', await mirroring(), true);
await dm.evaluate(`document.querySelector('.fog-brush[data-brush="lit"]').click(); "ok"`);
await dm.wait(300);
check('picking up a brush puts the mirror down', await mirroring(), false);
await dm.evaluate(`document.querySelector('.fog-brush[data-brush="lit"]').click(); "ok"`);
await dm.wait(300);

await toggle();
check('mirroring again', await mirroring(), true);
await tab('token');
await dm.wait(300);
// The rail's rule: closing a tab puts down whatever that panel armed. A wash
// nobody can account for is worse than a click nobody can account for.
check('closing the tab puts it down', await mirroring(), false);
check(
  'and the sign goes with it',
  await dm.evaluate(
    '(() => { const t = document.querySelector("#table-tag"); return getComputedStyle(t).display === "none"; })()',
  ),
  true,
);

// --- put the room back ---------------------------------------------------------

// The token is deleted through the panel that describes it, which is what
// `token-delete` acts on — so it is selected off the board again first rather
// than assumed to still be held. Its initiative row goes with it, server-side.
await findToken(dm, grid, 'Mirror Test');
await tab('token');
check(
  'the panel is describing the creature again',
  await dm.evaluate('document.getElementById("token-name").value'),
  'Mirror Test',
);
await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
await dm.wait(800);
check('the creature is put away', await ours(), null);

await tab('fog');
await setFogOn(fogFound);
await dm.wait(700);
check('and the fog switch is back where it was found', await dm.evaluate('document.querySelector("#fog-on").checked'), fogFound);

const code = verdict(dm);
dm.close();
process.exit(code === 0 ? 0 : 1);

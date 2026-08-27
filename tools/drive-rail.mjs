// Drives the left rail's tab strip in a real browser, as the DM.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-rail.mjs                      # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — it arms the wall editor and
// the calibration box. Point it at a scratch `SLATE_STATE`.
//
// Why a browser: the thing the strip was built to fix was a layout failure, and
// the DOM cannot see one. `#tokentool` being squeezed to a scrollbar and a
// heading, and the rail running off the bottom of the viewport, are both states
// in which every panel is present, unhidden and the right size on paper. The
// geometry checks below are the ones that would have caught it.

import { open, checks } from './cdp.mjs';
import { latticeOrBail, findToken } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const session = await open(`${base}/?room=campaign&dm=${secret}`);
const { evaluate, click, wait } = session;
const { check, note, verdict } = checks();

await wait(2500); // the map image, the socket, and the first frame

/** Which tab is open, by its label, or null when the rail is just the strip. */
const openTab = () =>
  evaluate(`(() => {
    const on = document.querySelector('#rail-tabs .rail-tab.is-open');
    return on === null ? null : on.textContent;
  })()`);

/** The labels on the strip, in order. */
const tabs = () =>
  evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')].map(b => b.textContent)`);

/** Which panels are actually on screen, by id. */
const shown = () =>
  evaluate(`['maptool','tokentool','walltool','fogtool','tabletool','drawtool']
    .filter(id => document.getElementById(id).offsetParent !== null)`);

const press = (label) =>
  evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
    .find(b => b.textContent === "${label}").click(); "ok"`);

/** Bottom edge of the rail's last visible child, against the viewport. */
const railBottom = () =>
  evaluate(`(() => {
    const kids = [...document.getElementById('left-rail').children]
      .filter(el => el.offsetParent !== null);
    const low = Math.max(...kids.map(el => el.getBoundingClientRect().bottom));
    return Math.round(low - window.innerHeight);
  })()`);

/** Height of a panel's visible box, or 0 when it is not on screen. */
const heightOf = (id) =>
  evaluate(`(() => {
    const el = document.getElementById('${id}');
    return el.offsetParent === null ? 0 : Math.round(el.getBoundingClientRect().height);
  })()`);

// --- the strip itself -------------------------------------------------------

check('the strip carries the five tabs', await tabs(), ['map', 'token', 'walls', 'fog', 'table']);
// A throwaway profile, so this is a *first* connection in a browser that has
// never held this room. What a browser that has is asserted at the bottom.
check('nothing is open in a fresh browser', await openTab(), null);
check('the draw tool is the only panel up', await shown(), ['drawtool']);

// --- one at a time ----------------------------------------------------------

await press('map');
check('the map tab opens its panel', await shown(), ['maptool', 'drawtool']);
check('and marks itself open', await openTab(), 'map');

await press('walls');
check('a second tab replaces the first', await shown(), ['walltool', 'drawtool']);
check('and the strip follows', await openTab(), 'walls');

await press('walls');
check('clicking the open tab closes it', await shown(), ['drawtool']);
check('leaving nothing marked', await openTab(), null);

// --- closing a panel puts its tool down -------------------------------------
//
// The reason `stop` exists. Both of these take the left mouse button, so an
// armed tool under a hidden panel is a click on the canvas doing something with
// nothing on screen saying why.

await press('walls');
await evaluate(`[...document.querySelectorAll('#wall-tools button')]
  .find(b => b.textContent === 'wall').click(); "ok"`);
check('the wall editor is armed', await evaluate(`document.body.classList.contains('tracing')`), true);
await press('map');
check('and is put down by leaving the tab', await evaluate(`document.body.classList.contains('tracing')`), false);

await evaluate(`document.getElementById('map-calibrate').click(); "ok"`);
check(
  'calibrating is armed',
  await evaluate(`document.getElementById('map-cells-row').hidden`),
  false,
);
await press('token');
await press('map');
check(
  'and is put down by leaving the tab',
  await evaluate(`document.getElementById('map-cells-row').hidden`),
  true,
);

// --- the layout the strip was built for -------------------------------------

await press('token');
const tokenHeight = await heightOf('tokentool');
note(`token panel is ${tokenHeight}px tall at a ${await evaluate('window.innerHeight')}px window`);
check('the token panel opens at its full height, not a scrollbar', tokenHeight > 200, true);
check('and the rail stays inside the viewport', (await railBottom()) <= 0, true);

await press('map');
await evaluate(`document.getElementById('map-library').click(); "ok"`);
await wait(400);
note(`map panel with the library open is ${await heightOf('maptool')}px tall`);
check('the rail holds with the library open too', (await railBottom()) <= 0, true);

// --- the board does not touch the strip -------------------------------------
//
// Clicking a token used to open the token tab, on the argument that picking a
// creature up off the board is the request to edit it. The rail is *where the DM
// is working*, though, and a panel that swaps itself out from under a half-traced
// wall costs more than the click it saved. Selection is the whole of what a board
// click does now, and the strip is the DM's alone.
//
// Where the token *is* has to be established before any of that. A new token
// lands in the first free cell out from the middle of the view, which is the
// middle only if the middle was free — so it is looked for rather than assumed,
// and this used to click the middle of the canvas and fail whenever another map
// put something there.

await press('token');
await evaluate(`document.getElementById('token-name').value = 'Rail Test'; "ok"`);
await evaluate(`document.getElementById('token-save').click(); "ok"`);
await wait(600);

const grid = await latticeOrBail(session, [session]);
note(grid.describe);
const built = await findToken(session, grid, 'Rail Test');
check('the token this script built is on the board', built !== null, true);

await press('walls');
check('a different tab is up before the board is clicked', await openTab(), 'walls');

const [tx, ty] = grid.screenOfCell(built.x, built.y);
await click(tx, ty);
await wait(250);
check('clicking a token leaves the tab where the DM put it', await openTab(), 'walls');
check('and the panel it opened is still the one on screen', await shown(), [
  'walltool',
  'drawtool',
]);
check(
  'while the hidden token panel followed the selection anyway',
  await evaluate(`document.getElementById('token-name').value`),
  'Rail Test',
);

// Put the room back: this script is the only thing that wanted that token. The
// selection is what `token-delete` acts on and the board click above made it,
// so only the panel has to be brought back up.
await press('token');
await evaluate(`window.confirm = () => true;
  document.getElementById('token-delete').click(); "ok"`);
await wait(400);

// --- the rail remembers -----------------------------------------------------
//
// Under test because a dropped socket reloads the page: "nothing open on
// connect" also meant "nothing open after a reconnect", which is a rail that
// empties itself in the middle of a fight.
//
// Back to the *DM* URL rather than `location.reload()`. The secret is stripped
// out of the address bar before anything can screenshot it, so reloading what is
// left reconnects as a player and there is no rail to assert about.
// `localStorage` is per origin and survives the navigation either way, which is
// the thing actually under test.

await press('fog');
check('the fog tab is open before the reload', await openTab(), 'fog');

await evaluate(`location.href = ${JSON.stringify(`${base}/?room=campaign&dm=${secret}`)}; "ok"`);
await wait(3500);
check('the open tab survived a reload', await openTab(), 'fog');
check('and its panel came back up with it', await shown(), ['fogtool', 'drawtool']);

await press('fog');
check('and a closed rail is remembered as well as an open one', await openTab(), null);

process.exitCode = verdict(session);
session.close();

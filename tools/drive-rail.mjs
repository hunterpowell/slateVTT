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
  evaluate(`['maptool','tokentool','walltool','tabletool','drawtool']
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
check('nothing is open on connect', await openTab(), null);
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

// --- clicking a token opens the tab that edits it ---------------------------
//
// The rule that makes "nothing open on connect" liveable: during play the panel
// the DM wants opens itself.
//
// Where the token *is* has to be established before the tab is switched away,
// and both halves of that matter. A new token lands in the first free cell out
// from the middle of the view, which is the middle only if the middle was free —
// so it is looked for rather than assumed, and this used to click the middle of
// the canvas and fail whenever another map put something there. And the looking
// is done from the token tab, because `tokenAt` opens it: doing it afterwards
// would be the very tab switch this section is trying to observe.

await press('token');
await evaluate(`document.getElementById('token-name').value = 'Rail Test'; "ok"`);
await evaluate(`document.getElementById('token-save').click(); "ok"`);
await wait(600);

const grid = await latticeOrBail(session, [session]);
note(grid.describe);
const built = await findToken(session, grid, 'Rail Test');
check('the token this script built is on the board', built !== null, true);

await press('map');
check('a different tab is up before the board is clicked', await openTab(), 'map');

const [tx, ty] = grid.screenOfCell(built.x, built.y);
await click(tx, ty);
check('clicking a token on the board opens the tab that edits it', await openTab(), 'token');
check(
  'and the panel is describing that token',
  await evaluate(`document.getElementById('token-name').value`),
  'Rail Test',
);

// Put the room back: this script is the only thing that wanted that token.
await evaluate(`window.confirm = () => true;
  document.getElementById('token-delete').click(); "ok"`);
await wait(400);

process.exitCode = verdict(session);
session.close();

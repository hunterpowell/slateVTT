// Drives the DM tracing the next dungeon, in two real browsers at once.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-staged.mjs                   # or: ... http://host:port secret
//
// It runs against a live room and *changes it*: it stages a map, traces walls on
// it, paints its fog and then promotes it onto the board. Point it at a scratch
// `SLATE_STATE`, never at the room you are about to play in.
//
// Two sessions, and the reason is milestone 20's whole shape rather than a habit
// picked up from the fog driver. What this feature is *for* is the DM preparing a
// dungeon while the table is looking at another one, so every claim it makes is a
// claim about a difference: masonry on one screen and not the other, a board that
// changed here and did not change there. One browser can watch the DM trace and
// cannot tell a wall correctly withheld from a wall the renderer dropped.
//
// The sharpest check is the one that runs *after* the promote. Up to that moment
// "the player was told nothing" is indistinguishable from "nothing happened at
// all" — so the last thing this does is hand the prepared dungeon over and watch
// their board move, which is what proves the silence beforehand was the filter
// working rather than the commands never landing.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?dm=${secret}`);
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

const openTab = (session, name) =>
  session.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(b => b.dataset.tab === '${name}').click(); "ok"`);

const press = (session, label, panel) =>
  session.evaluate(`[...document.querySelectorAll("${panel} button")]
    .find(b => b.textContent === "${label}").click(); "ok"`);

const text = (session, sel) => session.evaluate(`document.querySelector("${sel}").textContent`);
const disabled = (session, sel) => session.evaluate(`document.querySelector("${sel}").disabled`);

/**
 * Every map image this client has fetched since `forgetFetches`.
 *
 * The one assertion here that cannot be fooled by how the board happens to look.
 * A pixel difference says nothing when both maps are fully fogged — black to
 * black is no change whether the promote landed or never happened — and that is
 * not a contrived state: fog is remembered per map URL, so a board the party has
 * not explored is *already* black before the new one arrives.
 *
 * The browser's resource timeline has no such problem. A client that was never
 * sent a map never requested its bytes, and the record survives whatever the
 * renderer did with it. `drive-fog.mjs` uses the same trick on token art, for
 * the same reason: "correctly withheld" and "sent, and the renderer dropped it"
 * are the same picture and very different bugs.
 *
 * **Since a mark, not for all time**, and that is not tidiness. This script is
 * run repeatedly against a server that holds its room in memory, so a map it
 * stages this time was very likely the live board last time — and a player who
 * fetched it then, honestly, as the map they were playing on, makes a
 * whole-history reading say "they have seen it" about a leak that never
 * happened. The window starts the moment the staging does.
 */
const forgetFetches = (session) =>
  session.evaluate('performance.clearResourceTimings(); "ok"');

const mapsFetched = (session) =>
  session.evaluate(`[...new Set(performance.getEntriesByType('resource')
    .map(e => e.name)
    .filter(n => n.includes('/uploads/')))]`);

/** Remembers the canvas, so the next frame can be compared against it. */
const mark = (session) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    window.__base = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return window.__base.length;
  })()`);

/**
 * What share of the canvas changed since `mark`, as a percentage.
 *
 * A difference against a remembered frame rather than an absolute reading, for
 * the reason `drive-fog.mjs` spells out at length: how dark or busy the board
 * *is* depends on the map art, and how much it *changed* depends only on what
 * the room just said. Unsigned here rather than "brightened", because masonry
 * arriving darkens and an override tint lightens and both are the same news.
 */
const changed = (session) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const base = window.__base;
    if (base === undefined || base.length !== now.length) return -1;
    let moved = 0;
    let n = 0;
    for (let i = 0; i < now.length; i += 16) {
      const was = (base[i] + base[i + 1] + base[i + 2]) / 3;
      const is = (now[i] + now[i + 1] + now[i + 2]) / 3;
      if (Math.abs(is - was) > 6) moved++;
      n++;
    }
    return Math.round((moved / n) * 1000) / 10;
  })()`);

/**
 * Traces a run by clicking each corner and double-clicking the last.
 *
 * The `clickCount: 2` is what actually ends it — the client listens for a real
 * `dblclick`, and two ordinary clicks in one corner are deliberately *one*
 * corner (see `SAME_CORNER_PX`), so a run finished that way stores nothing at
 * all and reads exactly like the tool never being armed.
 */
async function trace(session, corners) {
  for (const [x, y] of corners) {
    await session.move(x, y);
    await session.click(x, y);
  }
  const [x, y] = corners[corners.length - 1];
  await session.click(x, y, { clickCount: 2 });
  await session.wait(500);
}

// --- a player, watching the board they are actually on ----------------------

const player = await open(base, { port: 9334 });
await player.wait(2000);
await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);
check('joined as a player', await player.evaluate('!!document.querySelector("#whoami-name")'), true);

// --- two different maps, so a re-run cannot pass or fail for the wrong reason

/**
 * Picks the nth map out of the library into whichever slot the panel is on.
 *
 * Which map matters, and only because this script is run more than once against
 * the same server. The room lives in memory, so a second run starts on whatever
 * the first one promoted — and staging *that same image* makes the promote a
 * no-op on the table's screen, which reads exactly like the frame never being
 * sent. The last check here would then fail for the one reason it is not
 * looking for. Two distinct maps make the run say the same thing every time.
 */
const pickMap = (session, n) =>
  session.evaluate(`(() => {
    const list = [...document.querySelectorAll('#map-library-list button')];
    const b = list[${n}];
    if (b === undefined) return null;
    const name = b.textContent;
    b.click();
    return name;
  })()`);

const openLibrary = async (session) => {
  await session.evaluate('document.querySelector("#map-library").click(); "ok"');
  await session.wait(1200);
};

await openTab(dm, 'map');
await openLibrary(dm);
const onBoard = await pickMap(dm, 0);
note(`the board: ${onBoard}`);
check('the board is on a known map', onBoard !== null, true);
await dm.wait(2500); // the pick copies the file, then the image loads

// --- the board's own walls, so there is something to confuse them with ------

await openTab(dm, 'walls');
await dm.evaluate('window.confirm = () => true; document.querySelector("#wall-clear").click(); "ok"');
await dm.wait(400);
check('the board starts untraced', await text(dm, '#wall-readout'), 'nothing traced');

await press(dm, 'wall', '#wall-tools');
await trace(dm, [
  [500, 300],
  [500, 460],
]);
const boardTraced = await text(dm, '#wall-readout');
note(`the board reads: ${boardTraced}`);
check('one segment on the board', boardTraced.startsWith('1 wall'), true);
await press(dm, 'wall', '#wall-tools'); // put it down before switching slots

// --- stage a map ------------------------------------------------------------

await openTab(dm, 'map');
await dm.evaluate('document.querySelector("#map-slot-next").click(); "ok"');
await dm.wait(300);
check(
  'the panel is on the staged slot with nothing in it',
  await text(dm, '#map-readout'),
  'nothing staged',
);

// From here on, anything the player's browser asks for is a thing it was told
// about while the DM was preparing the next dungeon — which is the window every
// network check below reads.
await forgetFetches(player);

await openLibrary(dm);
const picked = await pickMap(dm, 1);
note(`staged: ${picked}`);
check('a second, different map came out of the library', picked !== onBoard, true);
await dm.wait(2500); // the pick copies the file, then the image loads

check('the staged slot is filled', (await text(dm, '#map-readout')) !== 'nothing staged', true);
check(
  'and the DM is looking at it',
  await dm.evaluate('document.body.classList.contains("previewing")'),
  true,
);

// --- the wall panel is live over that preview, which is the milestone -------

await openTab(dm, 'walls');
check(
  'the walls tab is not greyed out over a preview',
  await dm.evaluate(`(() => {
    const t = [...document.querySelectorAll('.rail-tab')].find(b => b.dataset.tab === 'walls');
    return getComputedStyle(t).pointerEvents;
  })()`),
  'auto',
);
check(
  'and the panel says which board it is tracing',
  await text(dm, '#wall-hint'),
  'Tracing the map being prepared. Click any door to swing it.',
);
check(
  'the staged map is untraced, which is not the board it just left',
  await text(dm, '#wall-readout'),
  'nothing traced',
);

await mark(player);
await press(dm, 'door', '#wall-tools');
await trace(dm, [
  [560, 320],
  [660, 320],
]);
const stagedTraced = await text(dm, '#wall-readout');
note(`the staged map reads: ${stagedTraced}`);
check('a door hung on the map being prepared', stagedTraced.includes('1 door'), true);
await press(dm, 'door', '#wall-tools');

// The whole point, asked of a real second browser: the table is not told the
// next dungeon exists. `drive-player.mjs` asks whether the panel is absent;
// this asks whether the *board* moved, which is the question a frame arriving
// and being quietly dropped would answer differently.
const playerMoved = await changed(player);
note(`the player's board moved ${playerMoved}% while the DM traced`);
check('the table was shown nothing at all', playerMoved < 1, true);

// And the harder half of the same claim: they were never sent the *image*
// either. The DM has fetched it — they are looking at it — and in the window
// opened when the staging began, the table has asked for nothing at all. The
// promote at the end is what shows this was a filter working rather than a
// command that never landed.
const duringPrep = await mapsFetched(player);
note(`the table requested ${duringPrep.length} map images while the DM prepared one`);
check('and never asked for the next dungeon itself', duringPrep.length, 0);

// --- and the paint on it ----------------------------------------------------

await openTab(dm, 'fog');
check(
  'the fog tab is live over a preview too',
  await dm.evaluate(`(() => {
    const t = [...document.querySelectorAll('.rail-tab')].find(b => b.dataset.tab === 'fog');
    return getComputedStyle(t).pointerEvents;
  })()`),
  'auto',
);
// The switch and the radius are `MapInfo` fields and have staged since fog
// shipped; only the client refused them. This is that refusal being gone.
const staged_fog = await dm.evaluate(`(() => {
  const box = document.querySelector('#fog-on');
  if (!box.checked) box.click();
  return box.checked;
})()`);
await dm.wait(700);
check('the map being prepared can be given fog of its own', staged_fog, true);
check('and a radius with it', await disabled(dm, '#fog-vision'), false);
check(
  'the hint says what painting here means',
  await text(dm, '#fog-hint'),
  'Painting the map being prepared. This is what the party gets when it lands.',
);
// Reset is the one control that stays live-only: half of it is forgetting where
// the *party* explored, and they have not explored this map.
check('reset stays out of reach over a preview', await disabled(dm, '#fog-clear'), true);

await mark(dm);
await mark(player);
await press(dm, 'dark', '#fog-brushes');
await dm.click(700, 400);
await dm.wait(900);

const dmPainted = await changed(dm);
const playerPainted = await changed(player);
note(`after the fill — DM ${dmPainted}%, player ${playerPainted}%`);
check('the DM can see the paint they just laid down', dmPainted > 2, true);
check('and the table still knows nothing about that map', playerPainted < 1, true);
await press(dm, 'dark', '#fog-brushes');

// --- promote, which is where the silence proves itself ----------------------

// The lights go on before the hand-over, and that is about this script rather
// than about the DM: the board the table is on is already fully fogged, so a
// dungeon arriving fogged replaces black with black and the canvas cannot say
// whether anything happened. Unfogged, the promote is unmissable on their
// screen whatever the browser had cached. What the *paint* does on arrival is
// asserted in the server suite, where it can be read directly.
await openTab(dm, 'fog');
await dm.evaluate(`(() => {
  const box = document.querySelector('#fog-on');
  if (box.checked) box.click();
  return box.checked;
})()`);
await dm.wait(700);

await openTab(dm, 'map');
await mark(player);
await dm.evaluate('document.querySelector("#map-promote").click(); "ok"');
await dm.wait(2500); // the new image has to load on both clients

check(
  'the slot emptied and preview ended',
  await dm.evaluate('document.body.classList.contains("previewing")'),
  false,
);

// The check the whole script is built around. Everything above asserts a
// silence, and a silence is only worth anything if the thing being kept quiet
// was real — so the same board is measured once more after the map is handed
// over, and it has to come back the other way.
//
// Deliberately the canvas and not the resource timeline here, which is the
// opposite choice from the one made during the preparation above. A second run
// against the same browser has the promoted image in its cache and issues no
// request for it at all, so the network reading is one-shot; pixels are not.
const playerPromoted = await changed(player);
note(`the player's board moved ${playerPromoted}% on the promote`);
check('the table is handed the new dungeon', playerPromoted > 10, true);

// The walls came across rather than being swept, which is the one thing the
// promote does differently from every other map load.
await openTab(dm, 'walls');
const afterPromote = await text(dm, '#wall-readout');
note(`the board now reads: ${afterPromote}`);
check('the prepared door is on the board', afterPromote.includes('1 door'), true);
check('and the board’s own wall went with the map it traced', afterPromote.includes('0 wall'), true);
check(
  'the panel is back to describing the board',
  await text(dm, '#wall-hint'),
  'Trace walls here. Click any door to swing it.',
);

const code = verdict(dm) + verdict(player);
dm.close();
player.close();
process.exit(code === 0 ? 0 : 1);

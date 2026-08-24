// Drives the scratchpad, with three connections and two people.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-notes.mjs                     # or: ... http://host:port secret
//
// **Why three browsers.** Two of them are the same player, which no other
// driver here needed: a scratchpad's whole audience is its author, so the only
// frame this feature sends is the one that catches up somebody's *other tab*.
// The third is the DM, and its assertions are all negative — this is the first
// state in Slate the DM is not entitled to, and "the paragraph is nowhere in
// the DM's page" is the milestone rather than a tidy extra line.
//
// It writes in boxes that persist, so point `SLATE_STATE` at a scratch file. It
// empties both of them at the end.
//
// The DOM is enough for all of it, like `drive-chat.mjs` and unlike the fog and
// names drivers: this is text in a panel rather than pixels on a canvas.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

// The usual three ports. Two drivers at once would attach to each other's
// browser, so this one runs alone like the rest.
const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const saelyn = await open(`${base}/?room=campaign`, { port: 9334 });
const otherTab = await open(`${base}/?room=campaign`, { port: 9335 });
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

const claim = async (session, name) => {
  await session.evaluate(`[...document.querySelectorAll('.picker-list button')]
    .find(b => b.textContent.includes(${JSON.stringify(name)})).click(); "ok"`);
  await session.wait(1200);
  return session.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]');
};

check('Saelyn is on the board', await claim(saelyn, 'Saelyn'), 'Saelyn');
// The same person in a second browser, which is the only way to see the one
// frame this feature has.
check('and again in another tab', await claim(otherTab, 'Saelyn'), 'Saelyn');

// --- the dock ---------------------------------------------------------------

const tabs = (session) =>
  session.evaluate(`[...document.querySelectorAll('#dock-tabs .dock-tab')]
    .map(b => b.firstChild.textContent)`);

// Everybody's furniture, both of them. The DM's scratchpad is not a different
// panel from anybody else's, which is most of what makes it one.
check('the DM has both dock tabs', await tabs(dm), ['chat', 'notes']);
check('and so does a player', await tabs(saelyn), ['chat', 'notes']);

const openTab = (session, name) =>
  session.evaluate(`[...document.querySelectorAll('#dock-tabs .dock-tab')]
    .find(b => b.firstChild.textContent === ${JSON.stringify(name)}).click(); "ok"`);

const shown = (session, id) => session.evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden`);

check('nothing is open on connect — the board is the point', await shown(saelyn, 'notes'), false);

await openTab(saelyn, 'chat');
await openTab(saelyn, 'notes');
await saelyn.wait(200);

// **The dock is not the rail.** A rail panel is an editing mode and two of them
// would be two meanings for one mouse button; these are both things you read
// while something else is going on, and notes closing the chat would rebuild on
// this edge the complaint that kept the scratchpad off the other one.
check('opening notes leaves the chat open', await shown(saelyn, 'chat'), true);
check('and the notes panel is up beside it', await shown(saelyn, 'notes'), true);

// **The buttons must not move**, which is why the strip is the last child of
// the dock rather than the first. This dock grows upward, so its top edge moves
// on every toggle and its bottom edge never does — a tab strip that slid out
// from under the pointer aiming at it was the first thing wrong with two tabs.
const strip = () =>
  saelyn.evaluate(`(() => {
    const b = document.getElementById('dock-tabs').getBoundingClientRect();
    return [Math.round(b.top), Math.round(b.left), Math.round(b.bottom)];
  })()`);

// All four states, ending where it started so the panels below are on screen —
// a hidden textarea cannot take focus, and the flush check further down is
// about what happens when it loses it.
const anchored = await strip(); // both open
await openTab(saelyn, 'chat');
await saelyn.wait(200);
check('the strip is where it was with one panel open', await strip(), anchored);
await openTab(saelyn, 'notes');
await saelyn.wait(200);
check('and with nothing open at all', await strip(), anchored);
await openTab(saelyn, 'chat');
await saelyn.wait(200);
check('and with the other panel instead', await strip(), anchored);
await openTab(saelyn, 'notes');
await saelyn.wait(200);
check('and back with both', await strip(), anchored);

// **Document order, not the order they were opened.** A dock that stacked by
// press order would put a panel somewhere different every session. Notes above,
// chat against the strip — the box you type into belongs nearest the bottom
// edge, and a log grows downward.
const stacking = () =>
  saelyn.evaluate(`(() => {
    const r = (id) => document.getElementById(id).getBoundingClientRect();
    return r('notes').bottom <= r('chat').top + 1;
  })()`);

check('chat sits below notes', await stacking(), true);
await openTab(saelyn, 'chat'); // notes alone
await openTab(saelyn, 'chat'); // and back, so chat is now the one opened last
await saelyn.wait(250);
check('and still does when it was the one opened last', await stacking(), true);

await openTab(dm, 'notes');
await otherTab.evaluate(`[...document.querySelectorAll('#dock-tabs .dock-tab')]
  .find(b => b.firstChild.textContent === 'notes').click(); "ok"`);
await dm.wait(200);

// --- typing in it -----------------------------------------------------------

// Per-run text, for `drive-chat.mjs`'s reason: the room lives across runs, and
// what matters is that *this* run's paragraph went where it should.
const run = Math.random().toString(36).slice(2, 7);
const MINE = `the door on the left was warm [${run}]`;
const THEIRS = `ambush in the second chamber [${run}]`;

/** Types into a scratchpad the way a person does, then waits out the debounce. */
const type = async (session, text, { blur = false } = {}) => {
  await session.evaluate(`(() => {
    const box = document.getElementById('notes-text');
    box.focus();
    box.value = ${JSON.stringify(text)};
    box.dispatchEvent(new Event('input', { bubbles: true }));
    ${blur ? 'box.blur();' : ''}
    return "ok";
  })()`);
  await session.wait(900); // the 500ms idle timer, and the round trip after it
};

/** Whether this text is anywhere in this client's page at all — a box it is not
 *  looking at included, which is the only way to read a value nobody typed. */
const holds = (session, text) =>
  session.evaluate(`(() => {
    const box = document.getElementById('notes-text');
    const typed = box === null ? '' : box.value;
    return (document.body.innerText + typed).includes(${JSON.stringify(text)});
  })()`);

const box = (session) => session.evaluate('document.getElementById("notes-text").value');

await type(saelyn, MINE);

check('what was typed stayed in the box it was typed in', await box(saelyn), MINE);
// The one frame this feature sends, and the whole reason it is an event: a
// second tab holding a paragraph that no longer exists is the failure it fixes.
check('and caught up the same person’s other tab', await box(otherTab), MINE);

// **This is the milestone.** Not hidden, not styled away, not in a panel that
// happens to be shut — the frame carrying it was never sent, so the text is
// nowhere in that page. Every other asymmetry in this project runs the other
// way, and a scratchpad the DM's client can open is a surveillance feature.
check('and is nowhere in the DM’s page at all', await holds(dm, MINE), false);

await type(dm, THEIRS);

check('the DM has a box like everybody else', await box(dm), THEIRS);
check('and what is in it reaches no player', await holds(saelyn, THEIRS), false);
check('nor their other tab', await holds(otherTab, THEIRS), false);
check('and the player’s own box was not disturbed by any of it', await box(saelyn), MINE);

// --- the pause, and the click away from it ----------------------------------
//
// There is no send button — the text *is* the state — so something has to
// decide when a paragraph is finished. A pause does, and `blur` flushes
// whatever the timer is still holding, which is the case that would otherwise
// lose a sentence: type a line, click straight back onto the board.

const FLUSHED = `and it opened outward [${run}]`;
await saelyn.evaluate(`(() => {
  const b = document.getElementById('notes-text');
  b.focus();
  b.value = ${JSON.stringify(FLUSHED)};
  b.dispatchEvent(new Event('input', { bubbles: true }));
  b.blur();
  return "ok";
})()`);
await saelyn.wait(400); // under the idle timer on purpose: the blur is what sent it
check('clicking away sends what the timer was still holding', await box(otherTab), FLUSHED);

// --- Ctrl+Z belongs to the box ----------------------------------------------
//
// `undo.ts` stands down inside inputs, textareas and selects. This is the one
// place in the application somebody types for a minute at a time with a board
// behind them, so it is the surface that rule was really for.

await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
  .find(b => b.textContent === 'table').click(); "ok"`);
await dm.evaluate(`document.getElementById('table-names').click(); "ok"`);
await dm.wait(800);

const label = () => dm.evaluate('document.getElementById("undo-button").textContent');
check('the DM did something the ring holds', await label(), 'undo: the name switch');

await dm.evaluate(`document.getElementById('notes-text').focus(); "ok"`);
await dm.key('z', 'KeyZ', 90, 2);
await dm.wait(600);
check('Ctrl+Z in a scratchpad left the ring alone', await label(), 'undo: the name switch');

// --- and an undo does not eat a paragraph -----------------------------------
//
// Milestone 22's rule is that the ring may hold state the undoing hand wrote,
// and this is the case it was written for: every scratchpad on that snapshot
// belongs to somebody else, and a restore that took one back would eat a
// paragraph its author cannot recover and was never told about.

await dm.evaluate(`document.getElementById('undo-button').click(); "ok"`);
await dm.wait(900);

check(
  'the undo put the board back',
  await dm.evaluate(`document.getElementById('table-names').checked`),
  true,
);
check('and left the player’s paragraph exactly where it was', await box(saelyn), FLUSHED);
check('and the DM’s own', await box(dm), THEIRS);

// --- and it is still there after a refresh ----------------------------------
//
// Being in the window and surviving a restart is the entire thing this is worth
// over the Notepad window everybody already has open.

await otherTab.send('Page.reload');
await otherTab.wait(2600);
await openTab(otherTab, 'notes');
await otherTab.wait(300);

check('a refresh hands the box back', await box(otherTab), FLUSHED);
check('and hands over nobody else’s', await holds(otherTab, THEIRS), false);
note('the reloaded tab reclaimed its slot from localStorage, as every join does');

// --- putting it back --------------------------------------------------------
//
// Emptying a box removes its entry rather than storing an empty string, so the
// next driver finds the room it was written against and the scratch save file
// carries nothing this run typed.

await type(saelyn, '', { blur: true });
await type(dm, '', { blur: true });
check('the player’s box was left empty', await box(saelyn), '');
check('and the DM’s', await box(dm), '');

const failures = verdict(dm);
const alsoPlayers = saelyn.errors.length > 0 || otherTab.errors.length > 0;
if (alsoPlayers) {
  console.log(`a player's page logged errors: ${[...saelyn.errors, ...otherTab.errors].join(' | ')}`);
}
dm.close();
saelyn.close();
otherTab.close();
process.exit(failures === 0 && !alsoPlayers ? 0 : 1);

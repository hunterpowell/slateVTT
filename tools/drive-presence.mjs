// Drives the presence strip and the colour picker, with three connections.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-presence.mjs                  # or: ... http://host:port secret
//
// **Why three browsers.** Presence is the first feature in Slate whose whole
// subject is *the other connections*, so one browser can see nothing about it —
// a strip that lists yourself proves nothing. Two show a name appearing and, when
// one is closed, dimming on the other. The third is what makes the colour half
// worth driving: a colour has to reach somebody who did not pick it, and with two
// browsers the picker and the observer would be the same window.
//
// It picks a colour, which persists, so point `SLATE_STATE` at a scratch file.
// Nothing else here writes to the room at all — joining and leaving is the whole
// of what it does, and the room is deliberately not told to remember either.
//
// The DOM is enough, like `drive-chat.mjs` and `drive-notes.mjs`: this is chips
// in a panel rather than pixels on a canvas. The one thing it reads off the
// board is a swatch's colour, and that is a style on a button.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

// The usual three ports, fixed like every other driver's. Two drivers at once
// would attach to each other's browser.
const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const saelyn = await open(`${base}/?room=campaign`, { port: 9334 });
const torrin = await open(`${base}/?room=campaign`, { port: 9335 });
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

const claim = async (session, name) => {
  await session.evaluate(`[...document.querySelectorAll('.picker-list button')]
    .find(b => b.textContent.includes(${JSON.stringify(name)})).click(); "ok"`);
  await session.wait(1200);
  return session.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]');
};

/** Every chip on this client's strip, and whether it is dimmed. */
const strip = (session) =>
  session.evaluate(`[...document.querySelectorAll('#presence-chips .presence-chip')]
    .map(c => [c.querySelector('.presence-name').textContent,
               c.classList.contains('is-away') ? 'away' : 'here'])`);

/** Just the names that are not dimmed. */
const here = async (session) => (await strip(session)).filter(([, s]) => s === 'here').map(([n]) => n);

// --- the strip exists before anybody has claimed anything -------------------

// Every roster slot is drawn from the first frame and none of them ever leaves,
// which is what keeps the row from reflowing. So the DM's strip already lists
// seven names with six of them dimmed.
const first = await strip(dm);
check(
  'the strip lists the DM and every roster slot',
  first.map(([name]) => name),
  ['DM', 'cleodara', 'saelyn', 'torrin', 'bronzebeard', 'fernbark', 'ignacio'],
);
check('and only the DM is here yet', await here(dm), ['DM']);

// --- and fills up -----------------------------------------------------------

check('Saelyn is on the board', await claim(saelyn, 'Saelyn'), 'Saelyn');
await dm.wait(400);
check('which the DM was told without asking', await here(dm), ['DM', 'saelyn']);
// The reason this frame carries an `Owner` and not a `RosterSlot`: a list of
// slots cannot say whether the DM is there, and that is the connection a table
// most wants to be sure of.
check('and a player can see the DM is there', await here(saelyn), ['DM', 'saelyn']);

check('Torrin joins too', await claim(torrin, 'Torrin'), 'Torrin');
await dm.wait(400);
check('and everyone sees all three', await here(saelyn), ['DM', 'saelyn', 'torrin']);

// The row must not reflow as people come and go, which is why an absent player
// dims rather than disappearing. Seven chips before anybody arrived, seven now.
check('the row is the same seven chips it always was', (await strip(saelyn)).length, 7);

// --- the chat destinations follow it ----------------------------------------
//
// Whispering an empty chair is the specific failure the strip exists to prevent,
// so the destination chips read the same answer.

const destinations = (session) =>
  session.evaluate(`[...document.querySelectorAll('#chat-to .chat-chip')]
    .map(c => [c.textContent, c.classList.contains('is-away') ? 'away' : 'here'])`);

check('the DM can whisper two people who are here and four who are not', await destinations(dm), [
  ['table', 'here'],
  ['cleodara', 'away'],
  ['saelyn', 'here'],
  ['torrin', 'here'],
  ['bronzebeard', 'away'],
  ['fernbark', 'away'],
  ['ignacio', 'away'],
]);
// The table is everybody and is therefore never away, which is the one case
// that has no person behind it.
check("and a player's two destinations are both live", await destinations(saelyn), [
  ['table', 'here'],
  ['DM', 'here'],
]);

// --- picking a colour -------------------------------------------------------

const swatches = (session) =>
  session.evaluate(`document.querySelectorAll('#presence-swatches .presence-swatch').length`);

// **The DM has no control**, which is not a hidden button: their hue sits
// outside the six on purpose, and the server refuses a `set_colour` from them,
// so a picker on their chip would only ever produce a red banner.
check('the DM has no swatches at all', await swatches(dm), 0);
check('and a player has six', await swatches(saelyn), 6);

/** The colour a client is drawing this person's dot in. */
const dotOf = (session, name) =>
  session.evaluate(`(() => {
    const chip = [...document.querySelectorAll('#presence-chips .presence-chip')]
      .find(c => c.querySelector('.presence-name').textContent === ${JSON.stringify(name)});
    return chip.querySelector('.presence-dot').style.backgroundColor;
  })()`);

const before = await dotOf(torrin, 'saelyn');

// Open the picker on our own chip. A colour persists, so a second run of this
// driver starts from whatever the first one left — the swatch to take is
// therefore *a different one from the current answer*, not a fixed index.
// Without that this check passes once and then reads its own leftovers.
const armed = await saelyn.evaluate(
  `document.querySelector('.presence-swatch.is-armed')?.dataset.colour ?? null`,
);
const want = armed === '0' ? '3' : '0';
note(
  'Saelyn is currently',
  before,
  armed === null ? '— the default their roster position gives them' : `— swatch ${armed}`,
);

await saelyn.evaluate(`document.querySelector('#presence-chips .presence-chip.is-mine').click(); "ok"`);
await saelyn.wait(200);
check(
  'the picker opens on your own chip',
  await saelyn.evaluate('!document.getElementById("presence-swatches").hidden'),
  true,
);

await saelyn.evaluate(`document.querySelector('[data-colour="${want}"]').click(); "ok"`);
await saelyn.wait(600);

const picked = await dotOf(saelyn, 'saelyn');
check('the pick changed their own dot', picked !== before, true);
// **The axis this differs from a scratchpad on.** Both are yours to set; only
// one of them is any use if nobody else can see it — everyone draws everyone
// else's rings and attributes everyone else's lines.
check('and reached a player who did not pick it', await dotOf(torrin, 'saelyn'), picked);
check('and the DM', await dotOf(dm, 'saelyn'), picked);
check('and nobody else moved', await dotOf(torrin, 'torrin'), await dotOf(dm, 'torrin'));

// Nothing is predicted locally, so the armed swatch is the room's answer coming
// back rather than the click.
check(
  'the swatch that came back is the armed one',
  await saelyn.evaluate(`document.querySelector('.presence-swatch.is-armed').dataset.colour`),
  want,
);

// --- and it survives a refresh ----------------------------------------------
//
// Persisted, unlike the chat log: a colour picked once at the start of a
// campaign that had to be picked again every session would not be worth picking.

await saelyn.evaluate('location.reload(); "ok"');
await saelyn.wait(2500);
check('the colour is still theirs after a refresh', await dotOf(saelyn, 'saelyn'), picked);
check('and the strip filled back in', await here(saelyn), ['DM', 'saelyn', 'torrin']);

// --- "it is your turn" --------------------------------------------------------
//
// The other half of milestone 27 that needs more than one browser, and here for
// that reason rather than because it has anything to do with the strip: the
// assertion is that the notice reached *one* of two players, which one window
// cannot show. Client-only — the room does not know this feature exists.

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

/** The line beside the dock, or null when there is nothing to say. */
const notice = (session) =>
  session.evaluate(`(() => {
    const box = document.getElementById('turn-toast');
    return box.hidden ? null : box.textContent;
  })()`);

check('nobody has been told anything yet', await notice(saelyn), null);

await roll('Saelyn', 18);
await roll('Ogre', 9);
await dm.wait(400);

await dm.evaluate(`document.getElementById('init-next').click(); "ok"`);
await dm.wait(600);

check('the player whose turn it is was told', await notice(saelyn), 'Saelyn — your turn');
// Nothing was opened and nothing moved, which is the ping arrow's rule and the
// folded initiative panel's: a reflow under whoever is mid-drag is worse than
// the news is good.
check(
  'and no panel opened to tell them',
  await saelyn.evaluate('document.getElementById("chat").hidden && document.getElementById("notes").hidden'),
  true,
);
check('and the other player was told nothing', await notice(torrin), null);

// The rule that would ruin this feature if it were missing. Adopting state is
// not a turn change: a refresh mid-combat that announced whoever was already up
// would be the notice crying wolf on every reload.
await saelyn.evaluate('location.reload(); "ok"');
await saelyn.wait(2600);
check('a refresh mid-combat announces nothing', await notice(saelyn), null);

// And the same rule for the second frame that hands over a whole room. The DM
// undoing something mid-fight would otherwise nudge six people at once for a
// turn that did not move.
await dm.evaluate(`document.getElementById('undo-button').click(); "ok"`);
await dm.wait(900);
check('and so does a restore', await notice(saelyn), null);

// Put the order back: this driver adds two rows to a room that keeps them.
for (const name of ['Saelyn', 'Ogre']) {
  await dm.evaluate(`(() => {
    const row = [...document.querySelectorAll('.init-row')]
      .find(r => r.querySelector('.init-name').textContent === ${JSON.stringify(name)});
    row?.querySelector('.init-remove')?.click();
    return 'ok';
  })()`);
  await dm.wait(300);
}
check(
  'and the order is empty again',
  await dm.evaluate(`document.querySelectorAll('.init-row').length`),
  0,
);

// --- and somebody leaving -----------------------------------------------------
//
// The half no single browser can see, and the reason this driver opens three.

torrin.close();
await dm.wait(1200);

check('the DM sees Torrin go', await here(dm), ['DM', 'saelyn']);
check('and so does the other player', await here(saelyn), ['DM', 'saelyn']);
check('and their chip dimmed rather than vanishing', (await strip(saelyn)).length, 7);
check(
  'so a whisper to them is still typeable, and marked',
  (await destinations(dm)).find(([name]) => name === 'torrin'),
  ['torrin', 'away'],
);

// The DM's page is what `verdict` checks, so a player's console errors are
// reported here the way `drive-ruler.mjs` reports its second page's. Torrin's
// are gone with the browser, deliberately — closing it is the check above.
const code = verdict(dm);
if (saelyn.errors.length > 0) console.log(`the player page logged: ${saelyn.errors.join(' | ')}`);
dm.close();
saelyn.close();
process.exit(code === 0 && saelyn.errors.length === 0 ? 0 : 1);

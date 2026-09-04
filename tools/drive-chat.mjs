// Drives whisper and shout, with three people in the room.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-chat.mjs                     # or: ... http://host:port secret
//
// It says things in a live room. Nothing it says is persisted — the log is
// session memory and dies with the server — so unlike every other driver here
// this one leaves nothing behind to clean up. Point it at a scratch
// `SLATE_STATE` anyway, out of habit and because a claimed roster slot is not
// the only thing it touches if a check fails halfway.
//
// **Why three browsers.** Every other two-browser driver asks what the DM has
// and the table does not. A whisper is the first thing in this project withheld
// from one *player* and delivered to another, and one player cannot see that
// about another player — so there is a third connection here whose whole job is
// to hold nothing. Its assertions are the interesting ones and they are all
// negative: the text of somebody else's whisper is nowhere in its document, not
// styled away and not off screen.
//
// The DOM is enough for all of it, unlike the fog and names drivers: this
// feature is text in a panel rather than pixels on a canvas.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

// 9333 for the DM, 9334 for a player, 9335 for the second one — the same ports
// `drive-fog.mjs` uses for its latecomer. Two drivers at once would attach to
// each other's browser.
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

check('Saelyn is on the board', await claim(saelyn, 'Saelyn'), 'Saelyn');
check('Torrin is too', await claim(torrin, 'Torrin'), 'Torrin');

// --- the dock ---------------------------------------------------------------

const tabs = (session) =>
  session.evaluate(`[...document.querySelectorAll('#dock-tabs .dock-tab')]
    .map(b => b.firstChild.textContent)`);

// The first time the two sides of this application have had the same furniture.
// Neither of the dock's panels is the DM's, so this is not the rail.
check('the DM has both dock tabs', await tabs(dm), ['chat', 'notes']);
check('and so does a player', await tabs(saelyn), ['chat', 'notes']);

const openDock = (session) =>
  session.evaluate(`[...document.querySelectorAll('#dock-tabs .dock-tab')]
    .find(b => b.firstChild.textContent === 'chat').click(); "ok"`);

check(
  'nothing is open on connect — the board is the point',
  await dm.evaluate('document.getElementById("chat").hidden'),
  true,
);

await openDock(dm);
await openDock(saelyn);
check(
  'clicking the tab opens the panel',
  await dm.evaluate('document.getElementById("chat").hidden'),
  false,
);

// --- where a client may send ------------------------------------------------

const chips = (session) =>
  session.evaluate(`[...document.querySelectorAll('#chat-to .chat-chip')].map(b => b.textContent)`);

// The boundary of the feature, on screen: a player has the table and the DM and
// no third option. There is nothing to pick because there is nobody else to
// pick — no player-to-player message exists to be offered.
check('a player may say it to two places', await chips(saelyn), ['table', 'DM']);
check('the DM has the table and each player', await chips(dm), [
  'table',
  'cleodara',
  'saelyn',
  'torrin',
  'bronzebeard',
  'fernbark',
  'ignacio',
]);

// --- saying something -------------------------------------------------------

const say = async (session, chip, text) => {
  await session.evaluate(`[...document.querySelectorAll('#chat-to .chat-chip')]
    .find(b => b.textContent === ${JSON.stringify(chip)}).click(); "ok"`);
  await session.evaluate(`(() => {
    const box = document.getElementById('chat-text');
    box.value = ${JSON.stringify(text)};
    document.getElementById('chat-form').requestSubmit();
    return "ok";
  })()`);
  await session.wait(500); // the round trip, and the echo that follows it
};

/** Whether this text is anywhere in this client's page at all. */
const holds = (session, text) =>
  session.evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);

const log = (session) =>
  session.evaluate(`[...document.querySelectorAll('#chat-log .chat-line')]
    .map(l => l.textContent)`);

/** This run's lines alone — see the note on `run` below. */
const mine = async (session) => (await log(session)).filter((line) => line.includes(run));

// **Per-run text, for the reason `drive-panels.mjs` uses per-run token names.**
// The log is session memory rather than persisted, which sounds like it makes
// this driver idempotent and does not: the room lives in memory across runs, so
// a second run against the same server counts the first run's lines too. There
// is no command that clears a log — the way to empty it is to restart the
// server — so what this asserts is *this run's* lines rather than how many
// there are.
const run = Math.random().toString(36).slice(2, 7);
const SHOUT = `rolled a 19 [${run}]`;
await say(saelyn, 'table', SHOUT);

// The sender is echoed their own, which no other relayed frame in this project
// is: a log is a sequence, and where a line lands in it is the room's to decide.
check('the shout came back to whoever shouted', await holds(saelyn, SHOUT), true);
check('and reached the DM', await holds(dm, SHOUT), true);
check('and reached the other player', await holds(torrin, SHOUT), true);
check(
  'attributed to the sender, not to the socket that relayed it',
  (await log(dm)).some((line) => line.startsWith('Saelyn') && line.endsWith(SHOUT)),
  true,
);

// --- the assertion this driver exists for -----------------------------------

const WHISPER = `i pick the lock quietly [${run}]`;
await say(saelyn, 'DM', WHISPER);

check('the whisper reached the DM', await holds(dm, WHISPER), true);
check('and stayed with the person who sent it', await holds(saelyn, WHISPER), true);
// Not hidden, not styled away, not off screen: the frame carrying it was never
// sent, so the text is nowhere in that page. This is the whole milestone.
check(
  'and is nowhere in the other player’s page',
  await holds(torrin, WHISPER),
  false,
);
check(
  'the whisper is marked as one on both screens',
  await dm.evaluate(`[...document.querySelectorAll('#chat-log .chat-line.is-whisper')]
    .some(l => l.textContent.includes('→ DM'))`),
  true,
);

const BACK = `the lock gives with a click [${run}]`;
await say(dm, 'torrin', BACK);

check("the DM's whisper reached the player it named", await holds(torrin, BACK), true);
check('and the DM holds their own half of it', await holds(dm, BACK), true);
check(
  'and the player it was not addressed to holds none of it',
  await holds(saelyn, BACK),
  false,
);

// --- the sticky destination -------------------------------------------------
//
// Enter sends where the box is pointed, which is one keystroke each way in a
// back-and-forth and has exactly one failure: forgetting which way it points.
// So the box says it as well as the chip does.

check(
  'the armed chip is the one last picked',
  await dm.evaluate(`document.querySelector('#chat-to .chat-chip.is-armed').textContent`),
  'torrin',
);
check(
  'and the box itself says where it is going',
  await dm.evaluate('document.getElementById("chat-text").placeholder'),
  'whisper Torrin…',
);
check(
  'and is coloured as a whisper rather than a shout',
  await dm.evaluate(`document.getElementById('chat-form').classList.contains('is-whisper')`),
  true,
);

await dm.evaluate(`[...document.querySelectorAll('#chat-to .chat-chip')]
  .find(b => b.textContent === 'table').click(); "ok"`);
check(
  'pointing it back at the table takes the marking off',
  await dm.evaluate(`document.getElementById('chat-form').classList.contains('is-whisper')`),
  false,
);

// --- arriving while nobody is looking ---------------------------------------
//
// Torrin's dock has been shut this whole time, which is the case this half is
// about: a whisper nobody notices is the main way this feature fails a table
// where half the players are not watching the panel.

const badge = () =>
  torrin.evaluate(`(() => {
    const b = document.querySelector('#dock-tabs .dock-badge');
    return b.hidden ? null : b.textContent;
  })()`);

check('a shut dock counted what arrived', await badge(), '2');
check(
  'and the last of it surfaced beside the dock',
  await torrin.evaluate(`(() => {
    const t = document.getElementById('chat-toast');
    return t.hidden ? null : t.textContent.includes(${JSON.stringify(BACK)});
  })()`),
  true,
);
check(
  'without opening the dock under whoever is mid-drag',
  await torrin.evaluate('document.getElementById("chat").hidden'),
  true,
);

await openDock(torrin);
await torrin.wait(200);
check('opening it clears the count', await badge(), null);
check(
  'and everything they were party to is in the log',
  (await mine(torrin)).length,
  2,
);
check(
  'which is two of the three lines the DM is holding',
  (await mine(dm)).length,
  3,
);
check('and Saelyn holds the other two', (await mine(saelyn)).length, 2);

// --- the loaner die ---------------------------------------------------------
//
// The dice ride this file rather than getting their own because a roll *is* a
// line of talk — the three browsers already open here are the rig the private
// half needs, and there is still nothing to put back afterwards.
//
// **Counted rather than matched.** Every other assertion above looks for its
// own text; a roll's text is the room's, and two d20s can legitimately come up
// the same number. So what is counted is `.is-rolled` rows, which cannot
// collide.

const dice = (session) =>
  session.evaluate(`[...document.querySelectorAll('#chat-dice .chat-die')].map(b => b.textContent)`);

check('everybody has the bag, and it is seven dice', await dice(saelyn), [
  'd4',
  'd6',
  'd8',
  'd10',
  'd12',
  'd20',
  'd%',
]);
// The dock is a fixed narrow column and this row is the widest thing in it.
// The DOM is the only place a layout failure like that is visible, which is
// what this driver is for.
check(
  'and the row fits the dock without spilling out of it',
  await saelyn.evaluate(`(() => {
    const row = document.getElementById('chat-dice');
    return row.scrollWidth <= row.clientWidth + 1;
  })()`),
  true,
);

const thrown = (session) =>
  session.evaluate(`document.querySelectorAll('#chat-log .chat-line.is-rolled').length`);

// **Counted as a difference, for the reason the per-run text above exists.**
// The room is memory that outlives a run, so a second run against the same
// server starts with the first run's dice already in the log. An absolute
// count would pass once and then fail forever, which is worse than not
// asserting it.
const before = { dm: await thrown(dm), saelyn: await thrown(saelyn), torrin: await thrown(torrin) };
const since = async (session, who) => (await thrown(session)) - before[who];

const roll = async (session, chip, die) => {
  await session.evaluate(`[...document.querySelectorAll('#chat-to .chat-chip')]
    .find(b => b.textContent === ${JSON.stringify(chip)}).click(); "ok"`);
  await session.evaluate(`[...document.querySelectorAll('#chat-dice .chat-die')]
    .find(b => b.textContent === ${JSON.stringify(die)}).click(); "ok"`);
  await session.wait(500); // the round trip, and the echo that follows it
};

await roll(saelyn, 'table', 'd20');

// **The patterns below use `[0-9]` rather than `\d` deliberately.** These
// template literals are source code on its way to the browser, and `\d` is not
// a recognised escape in one — it arrives as a bare `d`, so the pattern still
// compiles, still runs, and quietly matches nothing. A character class cannot
// be eaten that way.

check('a shouted roll came back to whoever threw it', await since(saelyn, 'saelyn'), 1);
check('and reached the DM', await since(dm, 'dm'), 1);
check('and reached the other player', await since(torrin, 'torrin'), 1);
check(
  'and the room wrote the sentence, not the client',
  await saelyn.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#chat-log .chat-line.is-rolled')];
    return /^Saelyn: d20 → [0-9]+$/.test(rows.at(-1).textContent);
  })()`),
  true,
);

// The half a physical die cannot do, and it needed no picker of its own: the
// destination is the chip that was already armed.
await roll(saelyn, 'DM', 'd20');

check('a roll whispered to the DM reached them', await since(dm, 'dm'), 2);
check('and stayed with the person who threw it', await since(saelyn, 'saelyn'), 2);
// The one that matters: Torrin's count did not move at all.
check('and is nowhere in the other player’s page', await since(torrin, 'torrin'), 1);

// **The DM's own ear, which is the half a server test cannot see.** The room
// allowed this from the day it was written and there was no control for it —
// `the_dm_may_roll_where_only_they_can_see_it` drives `RoomState` directly and
// passed against a feature nobody could reach. This is the assertion that would
// have caught it, and it belongs here rather than there for exactly that reason.

check(
  'only the DM is offered a hidden roll',
  await saelyn.evaluate(`document.querySelectorAll('#chat-dice .chat-hide').length`),
  0,
);
check(
  'and the DM is',
  await dm.evaluate(`document.querySelectorAll('#chat-dice .chat-hide').length`),
  1,
);

// Pointed at the table on purpose: the toggle has to beat the armed chip, or it
// is only a relabelling of the destination strip.
await dm.evaluate(`[...document.querySelectorAll('#chat-to .chat-chip')]
  .find(b => b.textContent === 'table').click(); "ok"`);
await dm.evaluate(`document.querySelector('#chat-dice .chat-hide').click(); "ok"`);
check(
  'arming it marks the dice, not just the button',
  await dm.evaluate(`document.getElementById('chat-dice').classList.contains('is-hidden-roll')`),
  true,
);

const dmOnly = { dm: await thrown(dm), saelyn: await thrown(saelyn), torrin: await thrown(torrin) };
await dm.evaluate(`[...document.querySelectorAll('#chat-dice .chat-die')]
  .find(b => b.textContent === 'd20').click(); "ok"`);
await dm.wait(500);

check('a hidden roll reached the DM', (await thrown(dm)) - dmOnly.dm, 1);
check(
  'and no player was told, though the chip said table',
  (await thrown(saelyn)) - dmOnly.saelyn + ((await thrown(torrin)) - dmOnly.torrin),
  0,
);

// Put it down, or the handful below goes to the DM's own ear and the last check
// reads nothing.
await dm.evaluate(`document.querySelector('#chat-dice .chat-hide').click(); "ok"`);
check(
  'and it can be put back down',
  await dm.evaluate(`document.getElementById('chat-dice').classList.contains('is-hidden-roll')`),
  false,
);

// A handful says what each die did. `d%` is the hundred, which is what keeps
// seven buttons on one row.
await saelyn.evaluate(`(() => {
  document.getElementById('chat-dice-count').value = '3';
  return "ok";
})()`);
await roll(saelyn, 'table', 'd6');
check(
  'three dice report three faces and what they come to',
  await torrin.evaluate(`(() => {
    const rows = [...document.querySelectorAll('#chat-log .chat-line.is-rolled')];
    return /^Saelyn: 3d6 → [0-9]+, [0-9]+, [0-9]+ [(][0-9]+[)]$/.test(rows.at(-1).textContent);
  })()`),
  true,
);

note('nothing here is persisted: the log dies with the server, so there is nothing to put back');

const failures = verdict(dm);
const alsoPlayers = saelyn.errors.length + torrin.errors.length > 0;
if (alsoPlayers) {
  console.log(`a player page logged errors: ${[...saelyn.errors, ...torrin.errors].join(' | ')}`);
}
dm.close();
saelyn.close();
torrin.close();
process.exit(failures === 0 && !alsoPlayers ? 0 : 1);

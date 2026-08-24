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

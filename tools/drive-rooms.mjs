// Two rooms on one server: the picker in front of them, and the fact that one
// room's table is not the other's.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-rooms.mjs                     # or: ... http://host:port secret
//
// **The one driver that does not append `?room=`**, because the screen it
// arrives at is its subject.
//
// The isolation it asserts is read off the presence strip, which is the
// cheapest thing on the page that is computed *per room actor*: the DM sitting
// in the campaign must be drawn as away on a screen looking at the one-shot,
// and the one-shot's player must be absent from the campaign's strip entirely
// — they hold no slot in that room's roster. One browser cannot show either,
// which is why this opens two.
//
// It reads and does not write, so it leaves both rooms as it found them.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const { check, verdict } = checks();

const VISIBLE =
  '#room-picker:not([hidden]) .picker-list button, #picker:not([hidden]) .picker-list button';

/** The labels on whichever picker is showing. */
const choices = (session) =>
  session.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(VISIBLE)})].map(b => b.textContent)`,
  );

const pick = async (session, label) => {
  await session.evaluate(
    `[...document.querySelectorAll(${JSON.stringify(VISIBLE)})].find(b => b.textContent.includes(${JSON.stringify(label)})).click(); "ok"`,
  );
  await session.wait(1600);
};

/** Every chip on this client's strip, and whether it is dimmed. */
const strip = (session) =>
  session.evaluate(`[...document.querySelectorAll('#presence-chips .presence-chip')]
    .map(c => [c.querySelector('.presence-name').textContent, c.classList.contains('is-away') ? 'away' : 'here'])`);

const names = async (session) => (await strip(session)).map(([n]) => n);
const here = async (session) => (await strip(session)).filter(([, s]) => s === 'here').map(([n]) => n);

// --- the picker ---------------------------------------------------------

const player = await open(base, { port: 9334 });
await player.wait(2000);

check(
  'the room picker comes first',
  await player.evaluate('!document.querySelector("#room-picker").hidden'),
  true,
);
check(
  'and the character picker is behind it rather than instead of it',
  await player.evaluate('document.querySelector("#picker").hidden'),
  true,
);

const rooms = await choices(player);
check('both rooms are offered', rooms.length, 2);
check(
  'the campaign among them',
  rooms.some((r) => r.includes('Campaign')),
  true,
);
check(
  'and the one-shot',
  rooms.some((r) => r.includes('Halloween')),
  true,
);

// --- a room's cast is its own -------------------------------------------

await pick(player, 'Halloween');
check(
  'picking a room asks who you are',
  await player.evaluate('!document.querySelector("#picker").hidden'),
  true,
);

const cast = await choices(player);
check('the one-shot has a cast of its own', cast.length > 0, true);
check(
  "and the campaign's party is not in it",
  cast.some((name) => name.includes('Cleodara')),
  false,
);

await pick(player, cast[0]);
check(
  'the room is named beside the character',
  await player.evaluate('document.querySelector("#whoami-name").textContent.includes("Halloween")'),
  true,
);
check(
  'and the board is drawing',
  await player.evaluate('document.querySelector("#hud").textContent.length > 0'),
  true,
);

// --- one room's table is not the other's --------------------------------

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
await dm.wait(2500);

check(
  'a link that names a room skips the picker',
  await dm.evaluate('document.querySelector("#room-picker").hidden'),
  true,
);
check(
  'and lands in the room it named',
  await dm.evaluate('document.querySelector("#whoami-name").textContent.includes("Campaign")'),
  true,
);

// Give both rooms a moment to push their presence frames.
await player.wait(1200);

const campaignStrip = await names(dm);
const halloweenStrip = await names(player);

check("the campaign's strip is the campaign's cast", campaignStrip.includes('cleodara'), true);
check("and the one-shot's is not", halloweenStrip.includes('cleodara'), false);
check(
  'the one-shot draws its own roster instead',
  halloweenStrip.length > 1 && halloweenStrip[0] === 'DM',
  true,
);

// The assertion the whole feature rests on, in both directions.
check(
  'the DM in the campaign is drawn as away in the one-shot',
  (await here(player)).includes('DM'),
  false,
);
check(
  'and the one-shot player is nowhere on the campaign strip',
  campaignStrip.some((n) => halloweenStrip.includes(n) && n !== 'DM'),
  false,
);
check(
  'each is present in their own room',
  [(await here(dm)).includes('DM'), (await here(player)).length > 0],
  [true, true],
);

// --- the DM survives a reload -------------------------------------------

// The half of the reconnect that can be asserted without stopping the server.
// `net.ts` comes back from a dropped socket by calling `location.reload()`, and
// the DM's secret is stripped from the address bar on boot — so if it lives
// only in a closure, the reconnect hands the DM their own character picker in
// the middle of a session. `takeDmSecret` keeps it in `sessionStorage` for the
// life of the tab.
//
// This runs after every presence assertion above, because a reload drops and
// reopens a socket and would perturb the strips it reads.
check(
  'the DM link left no secret in the address bar',
  await dm.evaluate('location.search.includes("dm=")'),
  false,
);

await dm.evaluate('location.reload(); "ok"');
await dm.wait(3000);

check(
  'and the DM comes back as the DM after a reload, not on the picker',
  await dm.evaluate(`[
    document.querySelector('#whoami-name').textContent.includes('DM'),
    document.querySelector('#picker').hidden,
  ]`),
  [true, true],
);
check(
  'still in the room the link named',
  await dm.evaluate('document.querySelector("#whoami-name").textContent.includes("Campaign")'),
  true,
);

// --- switching rooms ----------------------------------------------------

// The DM has none, and now for one reason rather than two: they have no
// character to switch to, which is the whole job of the button. The second
// reason — that a reload demoted them — is what the section above asserts is
// gone. They switch rooms by opening their own link.
check(
  'the DM has no switch button',
  await dm.evaluate('document.querySelector("#whoami-switch").hidden'),
  true,
);

// The player's does work, because re-picking is all they have to do.
check(
  'a player has one',
  await player.evaluate('!document.querySelector("#whoami-switch").hidden'),
  true,
);
await player.evaluate('document.querySelector("#whoami-switch").click(); "ok"');
await player.wait(2500);
check(
  'and it puts them back on the room picker rather than the character one',
  await player.evaluate(`[
    !document.querySelector('#room-picker').hidden,
    document.querySelector('#picker').hidden,
  ]`),
  [true, true],
);

player.close();
dm.close();
process.exit(verdict(player, dm));

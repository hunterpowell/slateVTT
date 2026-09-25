// The DM editing the cast from the table tab, seen from a player's screen.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-roster.mjs                          # the one-shot, on the home site
//   node tools/drive-roster.mjs http://host:port secret  # any server
//
//   cd server && SLATE_SITE=sword-legend SLATE_DM_SECRET=test-secret SLATE_STATE=scratch-sword-legend.json cargo run
//   node tools/drive-roster.mjs                          # a one-room site
//
// Two browsers, because every assertion is a DM's edit arriving somewhere
// else: a slot added on the DM's tab appears on a player's picker, a rename
// reaches the player's strip, and a removal sends that player back to the
// picker. The room's side of it (what it refuses, and what it deletes) is
// `server/src/room/tests/roster.rs`.
//
// On a server with one room it also checks that nobody is shown a room picker,
// and that the DM's switch button is gone. It picks the one-shot on the home
// site, whose seed cast owns no tokens, so no removal is refused for a reason
// this driver isn't about.
//
// It leaves the cast as it found it: the one slot it adds, it removes.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const { check, verdict } = checks();

const rooms = await (await fetch(`${base}/api/rooms`)).json();
const alone = rooms.length === 1;
const room = alone ? rooms[0].id : rooms.some((r) => r.id === 'halloween') ? 'halloween' : rooms[0].id;
// A one-room site is opened the way its players will open it: with no room in
// the link at all.
const link = (extra) => {
  const params = new URLSearchParams(extra);
  if (!alone) params.set('room', room);
  const query = params.toString();
  return `${base}/${query === '' ? '' : `?${query}`}`;
};

// Unique per run, because the room outlives the driver and a second run would
// otherwise find its first run's slot (see the chat notes in the README).
const tag = Date.now().toString(36).slice(-5);
const added = `Driver ${tag}`;
const slug = `driver-${tag}`;
const renamed = `Renamed ${tag}`;

const PICKER = '#picker:not([hidden]) .picker-list button';
const offered = (session) =>
  session.evaluate(`[...document.querySelectorAll(${JSON.stringify(PICKER)})].map(b => b.textContent)`);

const rows = (dm) =>
  dm.evaluate(`[...document.querySelectorAll('#table-roster .table-roster-row')]
    .map(r => [r.querySelector('.table-roster-id').textContent, r.querySelector('input').value])`);

/** This client's presence chip for `id`, as [label, tooltip, away?], or null. */
const chip = (session, id) =>
  session.evaluate(`(() => {
    const chip = [...document.querySelectorAll('#presence-chips .presence-chip')]
      .find(c => c.querySelector('.presence-name').textContent === ${JSON.stringify(id)});
    return chip === undefined ? null : [chip.title, chip.classList.contains('is-away')];
  })()`);

// --- arriving ------------------------------------------------------------

const player = await open(link({}), { port: 9334 });
await player.wait(1500);
// A slot remembered from another driver would skip the picker this is about.
await player.evaluate('localStorage.clear(); location.reload(); "ok"');
await player.wait(2500);

check(
  'the player is asked who they are',
  await player.evaluate('!document.querySelector("#picker").hidden'),
  true,
);
if (alone) {
  check(
    'and, with one room on the server, is never shown a room picker',
    await player.evaluate('document.querySelector("#room-picker").hidden'),
    true,
  );
}
const before = await offered(player);
check('and is not offered the slot this run is about to add', before.includes(added), false);

const dm = await open(link({ dm: secret }), { port: 9333 });
await dm.wait(2500);
check(
  'the DM is in',
  await dm.evaluate('document.querySelector("#whoami-name").textContent.startsWith("DM · ")'),
  true,
);
check(
  alone
    ? 'with nowhere to switch to, the DM has no switch button'
    : 'with other rooms on the server, the DM keeps the switch button',
  await dm.evaluate('document.querySelector("#whoami-switch").hidden'),
  alone,
);

await dm.evaluate(`[...document.querySelectorAll('#rail-tabs .rail-tab')]
  .find(b => b.textContent === 'table').click(); "ok"`);
await dm.wait(300);
const cast = await rows(dm);
check('the table tab lists the cast the picker offers', cast.length, before.length);

// --- adding --------------------------------------------------------------

await dm.evaluate(`(() => {
  const name = document.getElementById('table-roster-name');
  name.value = ${JSON.stringify(added)};
  document.getElementById('table-roster-add').click();
  return 'ok';
})()`);
await dm.wait(1000);

const grown = await rows(dm);
check('the DM sees the new row once the room answers', grown.length, cast.length + 1);
check(
  'with an id made from the name',
  grown.some(([id, name]) => id === slug && name === added),
  true,
);
check(
  'and the box is empty for the next one',
  await dm.evaluate('document.getElementById("table-roster-name").value'),
  '',
);

check(
  'the player, still deciding, is offered it without reloading',
  (await offered(player)).includes(added),
  true,
);

await player.evaluate(`[...document.querySelectorAll(${JSON.stringify(PICKER)})]
  .find(b => b.textContent.includes(${JSON.stringify(added)})).click(); "ok"`);
await player.wait(2000);
check(
  'and is let in as them',
  await player.evaluate(`[
    document.querySelector('#picker').hidden,
    document.querySelector('#whoami-name').textContent.startsWith(${JSON.stringify(slug)}),
  ]`),
  [true, true],
);
check(
  "the DM's strip draws them, here",
  (await chip(dm, slug))?.[1],
  false,
);
check(
  "and the DM's chat can whisper them",
  await dm.evaluate(
    `[...document.querySelectorAll('.chat-chip')].some(c => c.textContent === ${JSON.stringify(slug)})`,
  ),
  true,
);

// --- renaming ------------------------------------------------------------

await dm.evaluate(`(() => {
  const input = document.querySelector('#table-roster input[data-id=${JSON.stringify(slug)}]');
  input.value = ${JSON.stringify(renamed)};
  input.dispatchEvent(new Event('change'));
  return 'ok';
})()`);
await dm.wait(1000);

check(
  "a rename reaches the player's own strip",
  ((await chip(player, slug))?.[0] ?? '').includes(renamed),
  true,
);
check(
  'and keeps the id, so they are still here as themselves',
  await player.evaluate('document.querySelector("#picker").hidden'),
  true,
);

// --- removing ------------------------------------------------------------

// `cdp.mjs` answers every `confirm` with yes.
await dm.evaluate(`document.querySelector('#table-roster input[data-id=${JSON.stringify(slug)}]')
  .closest('.table-roster-row').querySelector('.table-roster-remove').click(); "ok"`);
// The room closes the player's socket; their page backs off, probes, reloads,
// offers the slug it remembered, and is refused.
await dm.wait(4000);

check('the row is gone from the DM’s tab', (await rows(dm)).length, cast.length);
check("and the chip from the DM's strip", await chip(dm, slug), null);
check(
  'the removed player is back on the character picker',
  await player.evaluate('!document.querySelector("#picker").hidden'),
  true,
);
check(
  'which no longer offers the slot they were in',
  (await offered(player)).some((name) => name.includes(tag)),
  false,
);

player.close();
dm.close();
process.exit(verdict(player, dm));

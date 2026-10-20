// Drives split sight with three people in the room: the DM and two players.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-split.mjs                     # or: ... http://host:port secret
//
// It runs against a live room and *changes it*: it turns fog on, moves three
// tokens, adds two initiative rows and flips the sight switch. It puts all of
// that back on the way out. Point it at a scratch `SLATE_STATE` anyway.
//
// **Why three browsers.** Split sight is a line drawn between two *players*:
// Saelyn is sent a monster that Torrin isn't. The DM sees everything either way,
// so two browsers can't show it, which is `drive-chat.mjs`'s reason too.
//
// **Why a raw socket as well.** The checks need a monster near one player and
// far from the other, and a driver may not assume where the server put anyone.
// So the board is arranged by a second DM connection speaking the protocol
// directly: it reads where the tokens are off its `Welcome`, moves three of them
// to known distances, and moves them back at the end. Everything under test (the
// sight switch, player view's picker, the initiative panel) is driven through
// the pages. The arranging socket is setup, not a check.
//
// The sharpest checks are network ones, as in `drive-fog.mjs`: a token the room
// never sent is a token whose art was never fetched, so `performance` says
// whether the monster ever reached a page. That's also why the players open
// *after* the board is arranged and the switch is on. Under party sight Torrin
// would have been sent the monster through Saelyn's eyes, and a fetch can't be
// taken back.
//
// It refuses a board with walls, painted fog, lights or an initiative order
// already running, says so, and exits: each of those changes who can see what,
// and it may not erase the DM's work to make room for its own.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Thirty feet, six cells: near is three cells off, far is twelve or more. */
const VISION_FT = 30;

// --- the arranging socket -----------------------------------------------------

async function dmSocket() {
  const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws?room=campaign`);
  let welcome = null;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'welcome') welcome = msg;
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', dm_secret: secret, player_id: null }));
  for (let i = 0; i < 50 && welcome === null; i++) await wait(100);
  if (welcome === null) throw new Error('the arranging socket was never welcomed');
  return {
    state: welcome.state,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}

const room = await dmSocket();
const { state } = room;

const ownedBy = (slug) =>
  state.tokens.find((t) => t.owner.kind === 'player' && t.owner.id === slug);
const her = ownedBy('saelyn');
const him = ownedBy('torrin');
const monster = state.tokens.find((t) => t.owner.kind === 'dm' && t.img !== '' && !t.hidden);

const refusal =
  her === undefined || him === undefined
    ? 'Saelyn and Torrin each need a token'
    : monster === undefined
      ? 'there is no visible DM token with art to watch'
      : state.walls.length > 0
        ? 'the board has walls traced on it'
        : [...state.overrides.cells].some((c) => c !== '-')
          ? 'the board has fog painted on it'
          : state.tokens.some((t) => t.light_ft !== null)
            ? 'something on the board carries a light'
            : state.initiative.entries.length > 0
              ? 'an initiative order is already running'
              : state.staged !== null
                ? 'a map is staged'
                : null;
if (refusal !== null) {
  console.log(`\nNOT RUN: ${refusal}. This driver needs the room RoomState::hardcoded builds.`);
  room.close();
  process.exit(1);
}

const found = {
  map: state.map,
  vision: state.vision,
  him: { x: him.x, y: him.y },
  monster: { x: monster.x, y: monster.y },
};

const setMap = (map) =>
  room.send({
    type: 'set_map',
    url: map.url,
    grid_px: map.grid_px,
    offset_x: map.offset_x,
    offset_y: map.offset_y,
    grid_color: map.grid_color,
    play_area: map.play_area,
    fog: map.fog,
    vision_ft: map.vision_ft,
    lighting: map.lighting,
    grid_shape: map.grid_shape,
    staged: false,
  });
const place = (token, x, y) =>
  room.send({ type: 'move_token', id: token.id, x, y, dragging: false, staged: false });

// --- the pages ----------------------------------------------------------------

// 9333 for the DM, 9334 and 9335 for the players, as in `drive-chat.mjs`.
const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const { check, note, verdict } = checks();
await dm.wait(2500);

const openTab = (session, name) =>
  session.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(b => b.dataset.tab === '${name}').click(); "ok"`);
const choose = (session, selector, value) =>
  session.evaluate(`(() => {
    const s = document.querySelector('${selector}');
    s.value = '${value}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return s.value;
  })()`);
const rows = (session) =>
  session.evaluate(`[...document.querySelectorAll('#init-list .init-name')].map(n => n.textContent)`);
const fetched = (session, art) =>
  session.evaluate(`performance.getEntriesByType('resource').some(e => e.name.includes(${JSON.stringify(art)}))`);

// The switch, through the table tab.
await openTab(dm, 'table');
await choose(dm, '#table-vision', 'split');
await dm.wait(500);
check('the table tab sends the switch and reads it back', await dm.evaluate('document.querySelector("#table-vision").value'), 'split');

// Fog on at thirty feet, the monster three cells from Saelyn, Torrin fourteen.
setMap({ ...found.map, fog: true, vision_ft: VISION_FT });
place(monster, her.x + 3, her.y);
place(him, her.x + 14, her.y);
room.send({ type: 'set_initiative', token: her.id, value: 18 });
room.send({ type: 'set_initiative', token: monster.id, value: 12 });
await wait(800);

const claim = async (session, name) => {
  await session.evaluate(`[...document.querySelectorAll('.picker-list button')]
    .find(b => b.textContent.includes(${JSON.stringify(name)})).click(); "ok"`);
  await session.wait(1500);
  return session.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]');
};
const saelyn = await open(`${base}/?room=campaign`, { port: 9334 });
const torrin = await open(`${base}/?room=campaign`, { port: 9335 });
await saelyn.wait(2000);
check('Saelyn joins', await claim(saelyn, 'Saelyn'), 'Saelyn');
check('Torrin joins', await claim(torrin, 'Torrin'), 'Torrin');

// --- who was sent the monster ---------------------------------------------------

check(`Saelyn's page fetched the ${monster.name}'s art`, await fetched(saelyn, monster.img), true);
check(`Torrin's page never did`, await fetched(torrin, monster.img), false);
check(`Saelyn's initiative names the ${monster.name}`, (await rows(saelyn)).includes(monster.name), true);
check(
  `Torrin's names Saelyn, though her token isn't on his board, and not the ${monster.name}`,
  await rows(torrin),
  [her.name],
);

// The monster walks over to Torrin.
place(monster, her.x + 12, her.y);
await wait(800);
check(`once it walks to him, Torrin's page fetches it`, await fetched(torrin, monster.img), true);
check(`and his initiative names it`, (await rows(torrin)).includes(monster.name), true);
check(`while Saelyn's no longer does`, (await rows(saelyn)).includes(monster.name), false);

// --- player view, naming a player ----------------------------------------------

await openTab(dm, 'fog');
check('the picker is offered under split sight', await dm.evaluate('!document.querySelector("#fog-view-as").hidden'), true);
const options = await dm.evaluate(`[...document.querySelectorAll('#fog-view-as option')].map(o => o.value)`);
check('and lists the cast', options.includes('saelyn') && options.includes('torrin'), true);

await choose(dm, '#fog-view-as', 'torrin');
await dm.evaluate('document.querySelector("#fog-view").click(); "ok"');
await dm.wait(400);
check('player view as Torrin names him in the hint', (await dm.evaluate('document.querySelector("#fog-hint").textContent')).includes('Torrin'), true);
check(`and the DM's panel shows his rows`, (await rows(dm)).includes(monster.name), true);

await choose(dm, '#fog-view-as', 'saelyn');
await dm.wait(400);
check(`switching to Saelyn takes the ${monster.name} off the panel`, (await rows(dm)).includes(monster.name), false);
check(`and leaves her own row`, (await rows(dm)).includes(her.name), true);

await dm.evaluate('document.querySelector("#fog-view").click(); "ok"');
await dm.wait(300);
check(`leaving player view gives the DM every row back`, (await rows(dm)).includes(monster.name), true);

// --- and back to shared ----------------------------------------------------------

await openTab(dm, 'table');
await choose(dm, '#table-vision', 'party');
await dm.wait(800);
check(`under shared sight Saelyn's initiative names the ${monster.name} again`, (await rows(saelyn)).includes(monster.name), true);
await openTab(dm, 'fog');
check('and the picker goes away', await dm.evaluate('document.querySelector("#fog-view-as").hidden'), true);

// --- putting the room back -------------------------------------------------------

room.send({ type: 'remove_from_initiative', token: her.id });
room.send({ type: 'remove_from_initiative', token: monster.id });
place(monster, found.monster.x, found.monster.y);
place(him, found.him.x, found.him.y);
setMap(found.map);
room.send({ type: 'set_vision', vision: found.vision });
await wait(500);
room.close();
note('put back the map, the two tokens, the switch, and the initiative rows');

const failures = verdict(dm);
const alsoPlayers = saelyn.errors.length + torrin.errors.length > 0;
if (alsoPlayers) {
  console.log(`a player page logged errors: ${[...saelyn.errors, ...torrin.errors].join(' | ')}`);
}
dm.close();
saelyn.close();
torrin.close();
process.exit(failures === 0 && !alsoPlayers ? 0 : 1);

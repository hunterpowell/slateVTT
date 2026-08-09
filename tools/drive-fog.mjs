// Drives fog of war in two real browsers at once — the DM in one, a player in
// the other.
//
//   cd server && SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run
//   node tools/drive-fog.mjs                      # or: ... http://host:port secret
//
// It runs against a live room and *changes it*: it turns fog on and moves the
// vision radius about. Point it at a scratch `SLATE_STATE`, never at the room you
// are about to play in.
//
// Two sessions rather than one, and that is the whole reason this exists. Almost
// everything fog does is a *difference* between what two people are holding, and
// one client cannot see a difference — the DM's board looks much the same whether
// the table has been correctly darkened or has quietly kept the whole dungeon.
// Milestone 13 learned that about the movement ruler, whose one broken arm only
// showed up with two clients running.
//
// The sharpest check here is the network one. A token the room never sent is a
// token whose *art was never fetched*, and the browser keeps that record whether
// or not anything was drawn — so `performance` can answer "was this monster ever
// on this client" in a way no pixel can. Pixels cannot tell "correctly withheld"
// from "sent and the renderer is broken"; the resource timeline can.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

/** Cells the party's torches reach while the interesting checks run. */
const NEAR_FT = '40';

const dm = await open(`${base}/?dm=${secret}`);
const { check, note, verdict } = checks();

await dm.wait(2500); // the map image, the socket, and the first frame

const openTab = (session, name) =>
  session.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(b => b.dataset.tab === '${name}').click(); "ok"`);

const fogOn = (session) => session.evaluate('document.querySelector("#fog-on").checked');
const setFogOn = (session, want) =>
  session.evaluate(`(() => {
    const box = document.querySelector('#fog-on');
    if (box.checked !== ${want}) box.click();
    return box.checked;
  })()`);
const setVision = (session, ft) =>
  session.evaluate(`(() => {
    const v = document.querySelector('#fog-vision');
    v.value = '${ft}';
    v.dispatchEvent(new Event('change', { bubbles: true }));
    return v.value;
  })()`);

/**
 * Whether this client has ever fetched a token's art.
 *
 * The client requests a portrait exactly once, when it first holds a token with
 * that image — so this is the browser's own record of which creatures the room
 * has sent, surviving whatever the renderer did with them afterwards. It is the
 * one assertion here that can tell a monster correctly withheld from a monster
 * sent and not drawn, which are the same picture and very different bugs.
 */
const fetched = (session, art) =>
  session.evaluate(`performance.getEntriesByType('resource')
    .some(e => e.name.includes('${art}'))`);

/** Remembers the canvas, so the next frame can be compared against it. */
const mark = (session) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    window.__fogBase = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return window.__fogBase.length;
  })()`);

/**
 * What share of the canvas got brighter since `mark`, as a percentage.
 *
 * A difference against a remembered frame rather than an absolute reading, and
 * that took two failed runs to arrive at. Fog is a wash of the void colour over
 * the art, so how dark the board *is* depends entirely on how dark the map was
 * painted — a dungeon of black rock reads as fogged whatever the server said.
 * How much the board *changed* when the switch was flipped depends on nothing
 * but the switch.
 */
const brightened = (session) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const base = window.__fogBase;
    if (base === undefined || base.length !== now.length) return -1;
    let up = 0;
    let n = 0;
    for (let i = 0; i < now.length; i += 16) {
      const was = (base[i] + base[i + 1] + base[i + 2]) / 3;
      const is = (now[i] + now[i + 1] + now[i + 2]) / 3;
      if (is - was > 6) up++;
      n++;
    }
    return Math.round((up / n) * 1000) / 10;
  })()`);

// --- the panel ------------------------------------------------------------

await openTab(dm, 'fog');
check('the fog panel opens', await dm.evaluate('!document.querySelector("#fogtool").hidden'), true);

await setFogOn(dm, false);
await dm.wait(500);
check(
  'the radius is locked while fog is off',
  await dm.evaluate('document.querySelector("#fog-vision").disabled'),
  true,
);
check(
  'and the hint says the board is open',
  await dm.evaluate('document.querySelector("#fog-hint").textContent'),
  'The table sees the whole board.',
);

// Fog on and the torches short, *before* the player joins — so what they are
// sent on connect is a filtered snapshot rather than a full one that later
// deltas trimmed. Invariant 3 is exactly this case, and it is the one that
// cannot be checked once the client already holds the world.
check('fog goes on', await setFogOn(dm, true), true);
await dm.wait(600);
check('the map came back fogged', await fogOn(dm), true);
check(
  'the radius unlocks with it',
  await dm.evaluate('document.querySelector("#fog-vision").disabled'),
  false,
);
check('the radius round-trips through the map', await setVision(dm, NEAR_FT), NEAR_FT);
await dm.wait(900);
check(
  'and the hint says how far a torch reaches',
  await dm.evaluate(`document.querySelector("#fog-hint").textContent.includes("${NEAR_FT} ft")`),
  true,
);

// --- a player, joining into the dark --------------------------------------

const player = await open(base, { port: 9334 });
await player.wait(2000);
await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Vex')).click(); "ok"`);
await player.wait(2000);
check(
  'joined as a player',
  await player.evaluate('document.querySelector("#whoami-name").textContent'),
  'Vex',
);

// Not styled away — never built. The rail is the DM's editing surface and a
// player connection does not create one.
check('no fog panel on a player connection', await player.evaluate('document.querySelector("#fogtool").hidden'), true);
check('and no rail at all', await player.evaluate('document.querySelectorAll(".rail-tab").length'), 0);

check('their own token arrived', await fetched(player, 'vex.png'), true);
check('the wraith out in the dark did not', await fetched(player, 'wraith.png'), false);

// --- and the lights coming up ---------------------------------------------
//
// Turning fog off is a monster walking into view for every client at once, which
// is the whole `TokenChanged` path — a creature the table has never held arrives
// as a whole token rather than a move. The art fetch is that path landing.

await mark(player);
await mark(dm);
check('fog goes off again', await setFogOn(dm, false), false);
await dm.wait(1200);

check('the wraith reaches them once the lights are up', await fetched(player, 'wraith.png'), true);

const litPlayer = await brightened(player);
const litDm = await brightened(dm);
note(`board brightened — player ${litPlayer}%, DM ${litDm}%`);
check('the table gets a great deal of board back', litPlayer > 8, true);
// The DM's board lifts too — their wash comes off the same cells — but by less,
// because it was never taken to full darkness in the first place. That asymmetry
// is the feature: they are shown what the table can see without losing the board
// they are playing on.
check('the DM’s board lifts by less, having never been dark', litDm < litPlayer, true);

const code = verdict(dm) + verdict(player);
dm.close();
player.close();
process.exit(code === 0 ? 0 : 1);

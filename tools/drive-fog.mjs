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
//
// It puts the room back on the way out — the switch, the radius, the lighting
// mode and every cell it painted. That is not politeness: the drivers are
// documented as runnable in any order, and a board left fogged with a black band
// across it is exactly what makes `drive-names.mjs` fail a check about labels.
//
// Milestone 21's half traces a wall, which is the one thing here that is not
// self-contained: it runs only on a board with nothing traced on it, erases what
// it traced, and says so and skips when the board already holds a dungeon. A
// driver may not assume the map it was written against, and it may not delete
// the DM's work to make room for its own.

import { findToken, latticeOrBail, tokenAt } from './board.mjs';
import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

/** Cells the party's torches reach while the interesting checks run. */
const NEAR_FT = '40';

const dm = await open(`${base}/?room=campaign&dm=${secret}`);
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

/** Which of the two lighting buttons the panel is showing as the map's — read
 *  off the board that came back, not off anything this script set. */
const lighting = (session) =>
  session.evaluate(`(() => {
    const on = [...document.querySelectorAll('.fog-mode')].find(b => b.classList.contains('is-on'));
    return on === undefined ? null : on.textContent.trim();
  })()`);
const setLighting = (session, label) =>
  session.evaluate(`[...document.querySelectorAll('.fog-mode')]
    .find(b => b.textContent.trim() === '${label}').click(); "ok"`);

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

// Read before anything is touched, so the tidy-up at the bottom restores what
// was actually here rather than what a first boot happens to hold.
const fogFound = await fogOn(dm);
const visionFound = await dm.evaluate('document.querySelector("#fog-vision").value');
const lightingFound = await lighting(dm);
note(
  `found the room with fog ${fogFound ? 'on' : 'off'} at ${visionFound} ft, lit by ${lightingFound}`,
);

await setFogOn(dm, false);
await dm.wait(500);
check(
  'the radius is locked while fog is off',
  await dm.evaluate('document.querySelector("#fog-vision").disabled'),
  true,
);
// The mode greys with it and for the same reason the radius does: it is still
// the map's, and hiding it would make turning fog on look like it had also
// invented an answer.
check(
  'and so is how the map is lit',
  await dm.evaluate('document.querySelector(".fog-mode").disabled'),
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

const player = await open(`${base}/?room=campaign`, { port: 9334 });
await player.wait(2000);
await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(2000);
check(
  'joined as a player',
  await player.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]'),
  'Saelyn',
);

// Not styled away — never built. The rail is the DM's editing surface and a
// player connection does not create one.
check('no fog panel on a player connection', await player.evaluate('document.querySelector("#fogtool").hidden'), true);
check('and no rail at all', await player.evaluate('document.querySelectorAll(".rail-tab").length'), 0);

check('their own token arrived', await fetched(player, 'saelyn.png'), true);
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

// --- 16b: the DM's manual override ----------------------------------------
//
// The fill is the interesting half and it is checked the way everything else
// here is: as a difference. This room has no walls traced, so a fill from
// anywhere floods the whole play area — which is exactly the case worth driving,
// because it is what one missed gap in a real dungeon turns into and it is what
// the preview exists to show the DM before they commit.

const brush = (session, name) =>
  session.evaluate(`(() => {
    const b = document.querySelector('.fog-brush[data-brush="${name}"]');
    b.click();
    return b.classList.contains('is-on');
  })()`);
const armed = (session) => session.evaluate('document.body.classList.contains("painting-fog")');
/** The middle of the viewport, which is over the board and clear of the rail. */
const centre = (session) =>
  session.evaluate('[Math.round(innerWidth / 2), Math.round(innerHeight / 2)]');

check('fog comes back on', await setFogOn(dm, true), true);
await setVision(dm, NEAR_FT);
await dm.wait(900);

check(
  'the four brushes are there',
  await dm.evaluate('document.querySelectorAll(".fog-brush").length'),
  4,
);
check('and they unlocked with the fog', await brush(dm, 'dark'), true);
check('arming one takes the left button', await armed(dm), true);

// Blacking the board out, and the two boards move in *opposite directions* —
// which is the whole shape of the feature in one measurement. The table's goes
// dark. The DM's gets brighter, because what lands on theirs is the override
// tint: the annotation saying "you put this here", which is the only way to tell
// a blacked-out room from a wall's shadow on a board where both are just dark.
// A player is sent no such frame, so there is nothing on theirs to brighten.
const [cx, cy] = await centre(dm);
await mark(player);
await mark(dm);
await dm.click(cx, cy);
await dm.wait(1200);

const darkPlayer = await brightened(player);
const darkDm = await brightened(dm);
note(`filled dark — player brightened ${darkPlayer}%, DM ${darkDm}%`);
check('a fill takes the board away from the table', darkPlayer < 1, true);
check('and marks it up on the DM’s, who is the only one told', darkDm > 8, true);

// Handing it back, which is a removal rather than a fourth state — and the whole
// reason the override is a mask over the rays instead of a write into what the
// party remembers.
await mark(player);
check('the clear brush arms', await brush(dm, 'clear'), true);
await dm.click(cx, cy);
await dm.wait(1200);
const backPlayer = await brightened(player);
note(`handed back — player brightened ${backPlayer}%`);
check('line of sight decides the board again', backPlayer > 3, true);

// And forcing it lit, which is the brush that reaches past terrain into who is
// standing on it.
await mark(player);
check('the lit brush arms', await brush(dm, 'lit'), true);
await dm.click(cx, cy);
await dm.wait(1200);
const litUp = await brightened(player);
note(`filled lit — player brightened ${litUp}%`);
check('the table is handed the whole dungeon', litUp > 8, true);

// The sharpest check of the three, and the one no pixel could make: a client
// joining *now* is sent the wraith, which means the snapshot went through the
// same mask the deltas did. That is invariant 3 asked of the override — filter
// every delta correctly and then hand over the whole world on connect is the
// most common way this goes wrong.
const latecomer = await open(`${base}/?room=campaign`, { port: 9335 });
await latecomer.wait(2000);
await latecomer.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Cleodara')).click(); "ok"`);
await latecomer.wait(2500);
check(
  'a client joining into a forced-lit board is sent the wraith',
  await fetched(latecomer, 'wraith.png'),
  true,
);

// Resetting every override at once. Behind a confirm, which CDP deadlocks on
// unless it is stubbed — see `#wall-clear` in drive-ui.mjs.
await mark(latecomer);
await latecomer.evaluate('void 0');
await dm.evaluate('window.confirm = () => true; document.querySelector("#fog-clear").click(); "ok"');
await dm.wait(1200);
const afterReset = await brightened(latecomer);
note(`reset all — latecomer brightened ${afterReset}%`);
check('the dungeon goes back to what the torches reach', afterReset < 1, true);

// The other gesture. A stroke is a drag rather than a click, and it goes out as
// one command however many squares it crossed — a frame per cell would be a
// hundred of them across one drag.
await dm.evaluate(`document.querySelector('#fog-gesture').click(); "ok"`);
check(
  'the gesture toggles to painting',
  await dm.evaluate('document.querySelector("#fog-gesture").textContent.trim()'),
  'paint',
);
await brush(dm, 'dark');
await mark(dm);
await dm.drag(cx - 120, cy, cx + 120, cy);
await dm.wait(1000);
const stroked = await brightened(dm);
note(`painted a stroke — DM brightened ${stroked}%`);
// Both halves matter. It has to mark *something*, and it has to be nothing like
// the fill above — a stroke takes the squares the pointer crossed and stops,
// which is the whole reason the tool has a second gesture at all.
check('a stroke marks up the squares it crossed', stroked > 0.05, true);
check('and stops there rather than taking the room', stroked < darkDm / 4, true);

// And the brush is a tool like any other, so it puts down the way they do.
await dm.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); "ok"`);
await dm.wait(300);
check('Escape puts the brush down', await armed(dm), false);

// --- 21: room lighting ------------------------------------------------------
//
// The panel half first, which is true on any map: the mode is the map's, so what
// the buttons show is what came back from the room rather than what was clicked.

await dm.evaluate('document.querySelector("#fog-clear").click(); "ok"');
await dm.wait(900);

check(
  'two lighting modes, both named',
  await dm.evaluate('document.querySelectorAll(".fog-mode").length'),
  2,
);
await setLighting(dm, 'room');
await dm.wait(900);
check('the mode round-trips through the map', await lighting(dm), 'room');
check(
  'and the hint says what a torch does now',
  await dm.evaluate('document.querySelector("#fog-hint").textContent.includes("the room they are in")'),
  true,
);

// And the half that needs geometry: a wall the party can walk round is a wall
// that stops sight and does not stop light.
//
// Only on a board with nothing traced on it. Erasing somebody's dungeon to make
// room for a five-cell spur is not a tidy-up any driver is allowed, and leaving
// the spur behind is worse — so a traced board skips this and says so, the way
// drive-ruler.mjs skips its amber arm on a map with no wall to cross.
await openTab(dm, 'walls');
const traced = await dm.evaluate('document.querySelector("#wall-readout").textContent');

if (traced !== 'nothing traced') {
  note(`this board already has walls (${traced}); the room-lighting shape is untested here`);
} else {
  // A torch of this driver's own, rather than hunting the board for one of the
  // party. Where the six of them are standing is a fact about whatever room this
  // is, and a search wide enough to find one costs a click per square; a token
  // the DM builds lands in the first free cell out from the middle of the view,
  // which is the one place both clients are certainly looking at. It is handed
  // to a player because **vision comes from tokens a player owns** — a monster
  // the DM keeps lights nothing.
  await openTab(dm, 'token');
  await dm.evaluate(`(() => {
    const fresh = document.getElementById('token-new');
    if (!fresh.hidden) fresh.click();
    return 'ok';
  })()`);
  await dm.wait(200);
  await dm.evaluate(`document.getElementById('token-name').value = 'Lighting Test'; "ok"`);
  await dm.evaluate(`(() => {
    const sel = document.getElementById('token-owner');
    const opt = [...sel.options].find(o => /saelyn/i.test(o.textContent));
    if (opt) sel.value = opt.value;
    return sel.value;
  })()`);
  await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
  await dm.wait(800);

  // Neither client is zoomed: they frame the board the same way they framed it
  // for every check above, and the spur has to stay several cells across on the
  // player's screen for the reading at the bottom to mean anything.
  const framed = { zoom: false };
  const grid = await latticeOrBail(dm, [dm, player, latecomer], framed);
  const view = await latticeOrBail(player, [dm, player, latecomer], framed);
  note(`DM: ${grid.describe}`);

  const party = await findToken(dm, grid, 'Lighting Test');
  await openTab(dm, 'walls');

  // The spur, and the ground behind it: both have to be on the DM's screen to
  // click and on the player's to measure, and two clients frame the same board
  // differently.
  const reachable =
    party !== null &&
    [
      [party.x + 2, party.y - 3],
      [party.x + 2, party.y + 3],
      [party.x + 5, party.y],
    ].every(([x, y]) => grid.onScreen(x, y, 40) && view.onScreen(x, y, 40));

  if (!reachable) {
    note('no room on both screens for a spur beside the torch; the shape is untested here');
  } else {
    const corner = (x, y) => {
      const [sx, sy] = grid.screenOfCell(x, y);
      return [Math.round(sx - grid.size / 2), Math.round(sy - grid.size / 2)];
    };

    await dm.evaluate(`[...document.querySelectorAll("#wall-tools button")]
      .find(b => b.textContent === "wall").click(); "ok"`);
    const [ax, ay] = corner(party.x + 2, party.y - 3);
    const [bx, by] = corner(party.x + 2, party.y + 3);
    await dm.move(ax, ay);
    await dm.click(ax, ay);
    await dm.move(bx, by);
    await dm.click(bx, by);
    await dm.click(bx, by, { clickCount: 2 });
    await dm.wait(500);
    check(
      'a spur is traced beside the party',
      await dm.evaluate('document.querySelector("#wall-readout").textContent'),
      '1 wall · 0 doors',
    );

    // Back to line of sight and start the map over, so what is measured is this
    // wall's shadow rather than everywhere the party has ever been. The reverse
    // switch is deliberately not the assertion: `revealed` is memory, so going
    // back to sight leaves the ground the room already handed over on their
    // board, dimmed. Forgetting is what `reset all` is for.
    await openTab(dm, 'fog');
    await setLighting(dm, 'sight');
    await dm.wait(700);
    await dm.evaluate('document.querySelector("#fog-clear").click(); "ok"');
    await dm.wait(1000);

    await mark(player);
    await setLighting(dm, 'room');
    await dm.wait(1200);

    const round = await brightened(player);
    note(`the room came on — player brightened ${round}%`);
    check('the ground the spur was hiding arrives on the table', round > 0.5, true);
  }

  // The spur and the torch both go, in that order: `#wall-clear` is behind the
  // confirm stubbed out further up, and the token is deleted through the panel
  // that built it — selected by clicking its own square, since `token-delete`
  // acts on whatever the panel is describing.
  await openTab(dm, 'walls');
  await dm.evaluate('document.querySelector("#wall-clear").click(); "ok"');
  await dm.wait(600);
  if (party !== null) {
    check('the driver’s torch is put away', await tokenAt(dm, grid, party), 'Lighting Test');
    await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
    await dm.wait(600);
  }
  await openTab(dm, 'fog');
}

await setLighting(dm, lightingFound);
await dm.wait(700);
check('the mode goes back where it was found', await lighting(dm), lightingFound);

// --- put the room back --------------------------------------------------------
//
// In this order and not another. `#fog-clear` and the radius are both locked
// while the fog is off, so the paint comes off and the radius goes back while
// the lights are still down, and the switch is the last thing moved.

await dm.evaluate('document.querySelector("#fog-clear").click(); "ok"');
await dm.wait(900);
await setVision(dm, visionFound);
await dm.wait(600);
check('the radius is back where it was found', await dm.evaluate('document.querySelector("#fog-vision").value'), visionFound);
check('and the switch with it', await setFogOn(dm, fogFound), fogFound);

const code = verdict(dm) + verdict(player) + verdict(latecomer);
dm.close();
player.close();
latecomer.close();
process.exit(code === 0 ? 0 : 1);

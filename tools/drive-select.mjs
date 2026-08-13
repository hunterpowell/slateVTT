// Drives shift-click selection and the group move it exists for.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-select.mjs                    # or: ... http://host:port secret
//
// It runs against a live room and *changes it* — two tokens are built and are
// only tidied away if the run reaches the end. Point it at a scratch
// `SLATE_STATE`.
//
// Why a browser. The whole feature is a pointer gesture over a canvas: there is
// no pure function in it for `npm test` to reach, no new command on the wire,
// and nothing on the server at all. A group move is N ordinary `move_token`s,
// which is what makes it cheap and also what makes it invisible to every other
// kind of test — the room cannot tell one group drag from six separate ones, so
// the only place the feature exists is the client.
//
// Why two browsers. Two checks below are about what did *not* happen, and a
// second connection is the only thing that can see it: a shift-click must put
// nothing on the wire, and the token it lands on must not move. One browser
// cannot tell "sent nothing" from "sent something and drew the same thing".
//
// Everything here is measured in *grid cells* read off the HUD rather than in
// screen pixels, and that is not fussiness. A new token lands in the cell
// containing the centre of the view, so its centre is up to half a cell from
// where this script would guess; at the zoom a whole dungeon is framed at, half
// a cell is most of a token's radius and a click meant for it becomes a pan.
// `screenOfCell` below is the fix, and it makes every check exact.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

/** CDP's modifier bitmask. Shift is the only one this script needs. */
const SHIFT = 8;

const dm = await open(`${base}/?dm=${secret}`, { port: 9333 });
const player = await open(base, { port: 9334 });
const { check, note, verdict } = checks();

await dm.evaluate('window.confirm = () => true; "ok"');
await dm.wait(2500); // the map image, the socket, and the first frame

await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);
check(
  'the player is on the board',
  await player.evaluate('document.querySelector("#whoami-name").textContent'),
  'Saelyn',
);

const tab = (name) =>
  dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
    .find(t => t.textContent.trim().toLowerCase().startsWith('${name}')).click(); "ok"`);

const [cx, cy] = await dm.evaluate(`(() => {
  const r = document.getElementById('stage').getBoundingClientRect();
  return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
})()`);

/** The grid cell under a screen point, read off the HUD. */
const cellUnder = async (x, y) => {
  await dm.move(x, y);
  await dm.wait(50);
  const text = await dm.evaluate('document.querySelector("#hud").textContent');
  const m = /cell (-?\d+), (-?\d+)/.exec(text);
  return m === null ? null : { x: Number(m[1]), y: Number(m[2]) };
};

// --- zoom in, then learn the lattice -----------------------------------------
//
// Zoomed out to frame a whole dungeon a token is about twenty pixels across, and
// every check here is a click that has to land on one. Three notches of wheel
// put it somewhere comfortable; the calibration below then works at whatever
// zoom this actually produced rather than assuming it worked.

for (let i = 0; i < 3; i++) {
  await dm.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -300,
  });
  await dm.wait(120);
}
await dm.wait(300);
note(`zoom is now ${(await dm.evaluate('document.querySelector("#hud").textContent')).trim().split('·')[0].trim()}`);

/**
 * Screen coordinates of the centre of a grid cell.
 *
 * Two HUD readings a long way apart give the cell size — a division rather than
 * a scan, so it costs two round trips instead of a hundred — and a short scan
 * across one boundary gives the phase. Everything after this is exact.
 */
const calibrate = async (axis) => {
  const at = (d) => (axis === 'x' ? cellUnder(cx + d, cy) : cellUnder(cx, cy + d));
  const near = await at(0);
  if (near === null) throw new Error('the centre of the view is not over the map');

  // The span shrinks until it lands somewhere the HUD will name a cell for. Off
  // the edge of the map it names none, and how far the edge is depends on the
  // map, the zoom and where the rail has pushed the canvas — none of which this
  // script is entitled to assume.
  let span = null;
  let far = null;
  for (const candidate of [400, 300, 220, 160, 120]) {
    far = await at(candidate);
    if (far !== null && far[axis] > near[axis]) {
      span = candidate;
      break;
    }
  }
  if (span === null) throw new Error(`could not calibrate ${axis} anywhere along the axis`);

  const cells = far[axis] - near[axis];
  const size = span / cells;

  // Where the next cell along begins, to within three pixels.
  let edge = null;
  for (let d = 0; d <= Math.ceil(size) + 6 && edge === null; d += 3) {
    const c = await at(d);
    if (c[axis] === near[axis] + 1) edge = d;
  }
  if (edge === null) throw new Error(`could not find the ${axis} boundary`);
  return { size, index: near[axis] + 1, at: (axis === 'x' ? cx : cy) + edge + size / 2 };
};

const gx = await calibrate('x');
const gy = await calibrate('y');
note(`a cell is ${gx.size.toFixed(1)} × ${gy.size.toFixed(1)} screen pixels`);

const screenOfCell = (i, j) => [
  Math.round(gx.at + (i - gx.index) * gx.size),
  Math.round(gy.at + (j - gy.index) * gy.size),
];

const origin = await cellUnder(cx, cy);
note(`the centre of the view is cell ${origin.x}, ${origin.y}`);

/** Clicks the centre of a cell and reports the token it selected, or null. */
const tokenIn = async (i, j) => {
  // Into creation mode first, so the box is empty unless this click actually
  // selected something — otherwise the previous token's name answers for it.
  await dm.evaluate(`(() => {
    const f = document.getElementById('token-new');
    if (!f.hidden) f.click();
    return 'ok';
  })()`);
  await dm.wait(120);
  const [x, y] = screenOfCell(i, j);
  await dm.click(x, y);
  await dm.wait(250);
  const name = await dm.evaluate('document.getElementById("token-name").value');
  return name === '' ? null : name;
};

/** Where a freshly built token actually landed. `spaceFor` puts it in the first
 *  free cell out from the centre of the view, so this looks outward from there
 *  rather than assuming the centre was free. */
const findNear = async (name) => {
  for (let r = 0; r <= 3; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if ((await tokenIn(origin.x + dx, origin.y + dy)) === name) {
          return { x: origin.x + dx, y: origin.y + dy };
        }
      }
    }
  }
  return null;
};

// The player's canvas is measured *whole*, and that is not laziness. Their
// camera is not the DM's — they have no left rail, so their canvas is a
// different size, their view was framed differently from the first frame, and
// this script zoomed only the DM in. A box in the DM's screen coordinates names
// nothing in particular over there, and a check written that way passes for the
// wrong reason: it reads an area where nothing was ever going to happen and
// calls the silence a result.
const rememberAll = (session) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    window.__all = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return 'ok';
  })()`);

const movedSinceAll = (session) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const now = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const was = window.__all;
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - was[i]) + Math.abs(now[i+1] - was[i+1]) + Math.abs(now[i+2] - was[i+2]) > 10) n++;
    }
    return n / (now.length / 4);
  })()`);

const remember = (session, x, y, w, h) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    window.__box = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    return 'ok';
  })()`);

const movedSince = (session, x, y, w, h) =>
  session.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const now = c.getContext('2d').getImageData(
      Math.round(${x} * dpr), Math.round(${y} * dpr),
      Math.round(${w} * dpr), Math.round(${h} * dpr)).data;
    const was = window.__box;
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - was[i]) + Math.abs(now[i+1] - was[i+1]) + Math.abs(now[i+2] - was[i+2]) > 10) n++;
    }
    return n / (now.length / 4);
  })()`);

const build = async (name) => {
  await dm.evaluate(`(() => {
    const f = document.getElementById('token-new');
    if (!f.hidden) f.click();
    return 'ok';
  })()`);
  await dm.wait(200);
  await dm.evaluate(`document.getElementById('token-name').value = ${JSON.stringify(name)}; "ok"`);
  await dm.evaluate(`document.getElementById('token-save').click(); "ok"`);
  await dm.wait(900);
};

/** Drags whatever is in one cell to another. */
const dragCell = async (from, to) => {
  const [x0, y0] = screenOfCell(from.x, from.y);
  const [x1, y1] = screenOfCell(to.x, to.y);
  await dm.drag(x0, y0, x1, y1);
  await dm.wait(700);
};

// --- two tokens, a known distance apart --------------------------------------
//
// Fog off for the run: a drop recomputes sight and repaints half the board, and
// a pixel that changed for that reason says nothing about whether a token moved.

await tab('fog');
const fogWas = await dm.evaluate('document.querySelector("#fog-on").checked');
await dm.evaluate(`(() => {
  const box = document.querySelector('#fog-on');
  if (box.checked) box.click();
  return box.checked;
})()`);
await dm.wait(600);
note(`fog was ${fogWas ? 'on' : 'off'}; off for the run`);

await tab('token');

await build('Group A');
const builtA = await findNear('Group A');
check('token A was built and found', builtA !== null, true);

// Out of the way, so the next one is not built on top of it and so the two are
// far enough apart that no click can be ambiguous between them.
const homeA = { x: origin.x - 3, y: origin.y };
await dragCell(builtA, homeA);
check('token A is where it was dragged', await tokenIn(homeA.x, homeA.y), 'Group A');

await build('Group B');
const homeB = await findNear('Group B');
check('token B was built and found', homeB !== null, true);
note(`A is at ${homeA.x},${homeA.y}; B is at ${homeB.x},${homeB.y}`);

// --- a shift-click is local, and silent --------------------------------------
//
// The sharpest check in this file. A shift-click has to gather a token without
// moving it and without pinging — and a ping is the gesture it sits nearest,
// since both are a press on a token that is not a drag. What separates them here
// is that one reaches the table and the other never leaves the page.

const HALO = 100; // a box around a token, wide enough to hold its selection ring
const boxAt = (cell) => {
  const [x, y] = screenOfCell(cell.x, cell.y);
  return [x - HALO / 2, y - HALO / 2, HALO, HALO];
};

await remember(dm, ...boxAt(homeA));
await rememberAll(player);

const [ax, ay] = screenOfCell(homeA.x, homeA.y);
await dm.click(ax, ay, { modifiers: SHIFT });
await dm.wait(600);

const dmRing = await movedSince(dm, ...boxAt(homeA));
const playerRing = await movedSinceAll(player);
note(`shift-click changed ${(dmRing * 100).toFixed(2)}% of the DM's box and ${(playerRing * 100).toFixed(2)}% of the player's whole screen`);
check("a shift-click draws a selection ring on the DM's screen", dmRing > 0.01, true);
check('and puts nothing on the wire — the player sees nothing at all', playerRing < 0.001, true);
// A plain click, and A stays in the group through it: grabbing a member is
// grabbing the group, and a grab that goes nowhere puts it back down where it
// was. Only a click on *empty map* gives up a group, which is what the last
// section of this script leans on.
check('the token it landed on has not moved', await tokenIn(homeA.x, homeA.y), 'Group A');

// So A is already gathered, and this is the second half of the gesture.
await dm.click(...screenOfCell(homeB.x, homeB.y), { modifiers: SHIFT });
await dm.wait(400);

// --- the group moves as one --------------------------------------------------

const STEP = { x: 4, y: 3 };
const movedA = { x: homeA.x + STEP.x, y: homeA.y + STEP.y };
const movedB = { x: homeB.x + STEP.x, y: homeB.y + STEP.y };

await rememberAll(player);

// Dragging B, which is a member — so A comes with it, keeping the gap between
// them. The offsets are captured at pointerdown, which is what makes the group a
// rigid body rather than a pile that collapses onto the cursor.
await dragCell(homeB, movedB);

check('the token that was dragged landed where it was dropped', await tokenIn(movedB.x, movedB.y), 'Group B');
check('and the one that was only selected moved by the same delta', await tokenIn(movedA.x, movedA.y), 'Group A');
// This one does double duty: it is a click on empty map, which is how a group
// is put down, so everything below it is testing the ungrouped gesture.
check('nothing was left behind where the group started', await tokenIn(homeB.x, homeB.y), null);

// Against the silence measured for the shift-click above, not against a
// threshold picked out of the air: the same screen, the same metric, one gesture
// that stayed on the DM's page and one that did not.
const playerSaw = await movedSinceAll(player);
note(`the group's departure changed ${(playerSaw * 100).toFixed(2)}% of the player's whole screen, against ${(playerRing * 100).toFixed(2)}% for the shift-click`);
// Two tokens twenty pixels across, moving a few cells on a screen framing the
// whole map, come to about a sixth of a percent of it. The floor is only there
// so a ratio against a measured zero cannot pass on nothing at all; the ratio is
// the assertion.
check('the table was sent the move for a token nobody dragged', playerSaw > playerRing * 10 && playerSaw > 0.0005, true);

// --- Escape puts it down too -------------------------------------------------
//
// The other way out, and the one that needs no empty square to click on. Built
// back up first, since the checks above have just given the group away.

await dm.click(...screenOfCell(movedA.x, movedA.y), { modifiers: SHIFT });
await dm.wait(250);
await dm.click(...screenOfCell(movedB.x, movedB.y), { modifiers: SHIFT });
await dm.wait(250);

await remember(dm, ...boxAt(movedA));
await dm.key('Escape', 'Escape', 27);
await dm.wait(400);
const afterEscape = await movedSince(dm, ...boxAt(movedA));
note(`Escape changed ${(afterEscape * 100).toFixed(2)}% of the box around a member`);
check('Escape takes the selection rings off', afterEscape > 0.01, true);

// And it really dropped the group rather than only stopping it being drawn:
// dragging what was a member now moves that one alone.
// Upward, not down: the group has already travelled three cells that way and
// another two would put this off the bottom of the canvas, where a drag lands on
// nothing and the failure looks like a selection bug.
const strayB = { x: movedB.x, y: movedB.y - 2 };
await dragCell(movedB, strayB);
check('after Escape a drag moves only what was grabbed', await tokenIn(strayB.x, strayB.y), 'Group B');
check('and the other former member stayed put', await tokenIn(movedA.x, movedA.y), 'Group A');

// Put B back, so the checks below read the same as they did before this section.
await dragCell(strayB, movedB);
check('B is back where the group left it', await tokenIn(movedB.x, movedB.y), 'Group B');

// --- and a plain click puts it down ------------------------------------------
//
// The regression this feature must not cause. A group is something you build
// deliberately; grabbing anything outside one has to stay the gesture it always
// was, or every ordinary token drag in the project now has a second meaning.

check('a plain click selects the token under it as it always did', await tokenIn(movedA.x, movedA.y), 'Group A');

const aloneA = { x: movedA.x, y: movedA.y - 2 };
await dragCell(movedA, aloneA);

check('a plain click drops the group, so only what was grabbed moves', await tokenIn(aloneA.x, aloneA.y), 'Group A');
check('and the other one stayed exactly where it was', await tokenIn(movedB.x, movedB.y), 'Group B');

// --- put the room back -------------------------------------------------------

for (const [name, cell] of [['Group A', aloneA], ['Group B', movedB]]) {
  check(`the panel is describing ${name}`, await tokenIn(cell.x, cell.y), name);
  await dm.evaluate('document.getElementById("token-delete").click(); "ok"');
  await dm.wait(700);
}
check(
  'both tokens are gone',
  await dm.evaluate(`[...document.querySelector('#init-token').options]
    .some(o => /^Group [AB]$/.test(o.textContent))`),
  false,
);

await tab('fog');
if (fogWas) {
  await dm.evaluate(`(() => {
    const box = document.querySelector('#fog-on');
    if (!box.checked) box.click();
    return box.checked;
  })()`);
  await dm.wait(500);
  check('fog is back on', await dm.evaluate('document.querySelector("#fog-on").checked'), true);
}

const code = verdict(dm);
if (player.errors.length > 0) console.log(`the player page logged: ${player.errors.join(' | ')}`);
dm.close();
player.close();
process.exit(code === 0 && player.errors.length === 0 ? 0 : 1);

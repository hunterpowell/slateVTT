// Drives the line and pen tools: what each one sends, what reaches the other
// connection and when, and erasing a stroke by clicking beside it.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-draw.mjs                      # or: ... http://host:port secret
//
// It runs against a live room and changes it, though it erases what it draws.
// Point it at a scratch `SLATE_STATE`.
//
// Why a browser, and why two. The pen's rule is about *timing* on a *second*
// connection: nothing reaches anyone while the pen is down, and the whole
// stroke arrives when it comes up. Neither suite can see that. So both pages
// are reloaded with their socket wrapped, and every frame each one sends and
// receives is counted. See *Kept lines and freehand* in `docs/drawings.md`.

import { open, checks } from './cdp.mjs';
import { latticeOrBail, emptyCell } from './board.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const player = await open(`${base}/?room=campaign`, { port: 9334 });
const { check, note, verdict } = checks();

await dm.wait(2500);
await player.evaluate(`[...document.querySelectorAll('.picker-list button')]
  .find(b => b.textContent.includes('Saelyn')).click(); "ok"`);
await player.wait(1500);

// Every frame in and out, kept on the page. Installed before the document's
// own scripts, then both pages reloaded so the client's socket is the wrapped
// one. The DM comes back as the DM from `localStorage`, and the player as
// Saelyn, the same way a dropped connection does.
const tap = `(() => {
  const Real = window.WebSocket;
  window.__in = [];
  window.__out = [];
  window.WebSocket = class extends Real {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        try { window.__in.push(JSON.parse(e.data)); } catch {}
      });
    }
    send(data) {
      try { window.__out.push(JSON.parse(data)); } catch {}
      return super.send(data);
    }
  };
})();`;
for (const session of [dm, player]) {
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: tap });
  await session.send('Page.reload');
}
await dm.wait(3000);
check(
  'the player came back as Saelyn',
  await player.evaluate('document.querySelector("#whoami-name").textContent.split(" · ")[0]'),
  'Saelyn',
);

/** Frames since the last `mark`, by type. */
const mark = (s) => s.evaluate('window.__in.length = 0; window.__out.length = 0; "ok"');
const sent = (s, type) => s.evaluate(`window.__out.filter(m => m.type === '${type}')`);
const got = (s, type) => s.evaluate(`window.__in.filter(m => m.type === '${type}')`);
/** The room's shapes as the last `shapes_changed` this page received said. */
const lastShapes = async (s) => {
  const frames = await got(s, 'shapes_changed');
  return frames.at(-1)?.shapes ?? null;
};

const tool = (name) =>
  player.evaluate(`[...document.querySelectorAll('#draw-tools button')]
    .find(b => b.textContent === '${name}').click(); "ok"`);

// Pointers off, so the DM's dot isn't in the player's pixel box. See
// drive-ping.mjs, which found out the hard way.
await dm.evaluate(`[...document.querySelectorAll('.rail-tab')]
  .find(t => t.textContent.trim().toLowerCase().startsWith('table')).click(); "ok"`);
if (await dm.evaluate('document.querySelector("#table-cursors").checked')) {
  await dm.evaluate('document.querySelector("#table-cursors").click(); "ok"');
  await dm.wait(400);
}

const framed = { zoom: false };
const dmGrid = await latticeOrBail(dm, [dm, player], framed);
const playerGrid = await latticeOrBail(player, [dm, player], framed);
note(`the player: ${playerGrid.describe}`);

// Bare board, found by the DM (only the DM's panel can say what's standing on
// a cell), with three clear cells to its right for the line.
const near = await dmGrid.cellUnder(dmGrid.middle.x - 150, dmGrid.middle.y - 120);
const bare = near === null ? null : await emptyCell(dm, dmGrid, near);
if (bare === null || !(await playerGrid.clear(bare.x + 3, bare.y, 10))) {
  console.log('\nFAILED: no bare board on both screens to draw on');
  dm.close();
  player.close();
  process.exit(1);
}
note(`drawing from cell ${bare.x},${bare.y}`);
const [x0, y0] = playerGrid.screenOfCell(bare.x, bare.y);
const [x3] = playerGrid.screenOfCell(bare.x + 3, bare.y);
const cell = (x3 - x0) / 3;

const button = (type, x, y) =>
  player.send('Input.dispatchMouseEvent', {
    type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  });

// --- the pen --------------------------------------------------------------

await mark(dm);
await mark(player);
await tool('pen');
check('the swatches are live for the pen', await player.evaluate(
  'document.querySelector("#draw-swatches").classList.contains("is-inert")'), false);

// A zigzag across two cells and back, slowly enough to be many frames.
const zig = Array.from({ length: 24 }, (_, i) => [
  x0 + (i / 23) * cell * 2.5,
  y0 + (i % 2 === 0 ? -0.4 : 0.4) * cell,
]);
await button('mousePressed', x0, y0);
for (const [x, y] of zig) {
  await button('mouseMoved', x, y);
  await player.wait(25);
}
await player.wait(300);
check('nothing went out while the pen was down',
  await player.evaluate('window.__out.filter(m => m.type !== "move_cursor").length'), 0);
check('and the DM was told nothing', (await lastShapes(dm)) === null && (await got(dm, 'sketch')).length === 0, true);

await button('mouseReleased', ...zig.at(-1));
await player.wait(600);

const pens = await sent(player, 'add_shape');
check('the release sent one shape', pens.length, 1);
check('a path', pens[0]?.kind, 'path');
note(`with ${pens[0]?.points?.length} corners, from ${zig.length} pointer moves`);
check('with its corners', (pens[0]?.points?.length ?? 0) > 2, true);
check('and never a sketch', (await sent(player, 'sketch')).length, 0);
check('the DM was never sent a sketch of it', (await got(dm, 'sketch')).length, 0);
const dmPaths = (await lastShapes(dm))?.filter((s) => s.kind === 'path') ?? [];
check('the DM has the path, corners and all',
  dmPaths.length === 1 && dmPaths[0].points.length === pens[0]?.points?.length, true);
const path = dmPaths[0];

// --- the line -------------------------------------------------------------

await mark(dm);
await mark(player);
await tool('line');
const [, yLine] = playerGrid.screenOfCell(bare.x, bare.y + 2);
await player.drag(x0, yLine, x3, yLine);
await player.wait(400);

const lines = await sent(player, 'add_shape');
check('a line is kept', lines.length === 1 && lines[0].kind === 'line', true);
check('and was watched while it was swept', (await got(dm, 'sketch')).length > 0, true);
check('the DM has it', ((await lastShapes(dm)) ?? []).some((s) => s.kind === 'line'), true);
const line = ((await lastShapes(dm)) ?? []).find((s) => s.kind === 'line');

// --- measuring still keeps nothing ------------------------------------------

await mark(player);
await tool('measure');
check('the swatches go inert for the measure tool', await player.evaluate(
  'document.querySelector("#draw-swatches").classList.contains("is-inert")'), true);
await player.drag(x0, yLine + cell, x3, yLine + cell);
await player.wait(400);
check('measuring sends sketches', (await sent(player, 'sketch')).length > 0, true);
check('and keeps nothing', (await sent(player, 'add_shape')).length, 0);

// --- erasing a stroke by clicking beside it ---------------------------------

await tool('line');
await mark(player);
await player.click((x0 + x3) / 2, yLine + cell * 0.6);
await player.wait(400);
check('a click half a cell off the line erases nothing', (await sent(player, 'remove_shape')).length, 0);

await mark(player);
await player.click((x0 + x3) / 2, yLine + cell * 0.15);
await player.wait(400);
const erased = await sent(player, 'remove_shape');
check('a click just beside the line erases it', erased.length === 1 && erased[0].id === line?.id, true);

await mark(player);
const [px, py] = zig[6];
await player.click(px, py + cell * 0.1);
await player.wait(400);
const erasedPath = await sent(player, 'remove_shape');
check('and a click beside the path erases that', erasedPath.length === 1 && erasedPath[0].id === path?.id, true);

await player.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"');
check('neither page threw', [...dm.errors, ...player.errors], []);

dm.close();
player.close();
process.exit(verdict(dm));

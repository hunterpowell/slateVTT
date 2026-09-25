// Drives the fit-board control — the way back after panning off the edge of the
// map, which nothing else in this client offers.
//
//   cd server && SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-fit.mjs                        # or: ... http://host:port secret
//
// It moves two cameras and changes nothing else: the camera is per client and
// never on the wire, so this is the one driver that leaves the room exactly as
// it found it and needs no sweep at the bottom.
//
// **Everything here is a layout fact.** Where a camera is sitting cannot be read
// off the state model, because the state model does not have one — `Stage.fit`
// is reached through a callback for precisely that reason, and the HUD's zoom
// percentage is the only thing that reports the answer.
//
// The second browser is not decoration. This control is **everybody's**, unlike
// almost everything else with a button: a player who has zoomed into a corner is
// exactly as lost as the DM, and the failure this guards against is it being
// built inside the DM-only half of `onWelcome` where nearly every other control
// lives.

import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9333 });
const player = await open(`${base}/?room=campaign`, { port: 9334 });
const { check, note, verdict } = checks();

await dm.wait(2500);
await player.wait(2500);

await player.evaluate(`(() => {
  const first = document.querySelector('.picker-choice');
  if (first) first.click();
  return 'ok';
})()`);
await player.wait(1500);

// The HUD reads "NNN% · cell x, y", so the leading number is the zoom. Written
// as a character class rather than `\d`: these template literals are JS on its
// way to the browser, and `\d` is not an escape a template literal recognises —
// it arrives as a bare `d` and the pattern silently never matches.
const zoom = (page) =>
  page.evaluate(`(() => {
    const m = document.getElementById('hud').textContent.match(/^([0-9]+)%/);
    return m === null ? null : Number(m[1]);
  })()`);

const middle = (page) =>
  page.evaluate(`(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);

const zoomIn = async (page, notches) => {
  const at = await middle(page);
  for (let i = 0; i < notches; i++) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: at.x,
      y: at.y,
      deltaX: 0,
      deltaY: -120,
    });
    await page.wait(50);
  }
  await page.wait(400);
};

/** Drags the board out from under itself several times, so "fit" has something
 *  to undo besides the zoom. */
const panAway = async (page) => {
  const at = await middle(page);
  for (let i = 0; i < 4; i++) {
    await page.drag(at.x + 200, at.y + 200, at.x - 250, at.y - 250, { button: 'right' });
    await page.wait(120);
  }
  await page.wait(400);
};

const home = (page) =>
  page.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Home',
    code: 'Home',
    windowsVirtualKeyCode: 36,
  });

// ============================================================================
// It is everybody's
// ============================================================================

check(
  'the DM has a fit control',
  await dm.evaluate(`document.getElementById('fit-board') !== null`),
  true,
);
check(
  'and so does a player, because the camera is per client and so is being lost',
  await player.evaluate(`document.getElementById('fit-board') !== null`),
  true,
);

// ============================================================================
// The button and the key are one control
// ============================================================================

const fitted = await zoom(dm);
note(`the board fits at ${fitted}%`);

await zoomIn(dm, 10);
const close = await zoom(dm);
note(`wheeled in to ${close}%`);
check('wheeling in moved the camera, so there is something to undo', close > fitted, true);

await panAway(dm);
await dm.evaluate(`document.getElementById('fit-board').click(); "ok"`);
await dm.wait(500);
check('the button frames the board again', await zoom(dm), fitted);

await zoomIn(dm, 10);
check('wheeled in a second time', (await zoom(dm)) > fitted, true);
await panAway(dm);
await home(dm);
await dm.wait(500);
check('and Home does the same thing', await zoom(dm), fitted);

// The player's camera is not the DM's — a different canvas width and its own
// framing — so this is asked of it separately rather than assumed to follow.
const theirs = await zoom(player);
note(`the table's board fits at ${theirs}%`);
await zoomIn(player, 10);
await panAway(player);
await player.evaluate(`document.getElementById('fit-board').click(); "ok"`);
await player.wait(500);
check('and it works on the camera the table is holding', await zoom(player), theirs);

// ============================================================================
// Home means start-of-line while somebody is typing
// ============================================================================
//
// The one thing this control can do that is actively annoying: a board that
// jumps while a whisper is half typed. `typingIn` is what stops it, shared with
// the undo shortcut rather than written twice.

await zoomIn(dm, 8);
const held = await zoom(dm);

await dm.evaluate(`document.querySelector('#dock-tabs button').click(); "ok"`);
await dm.wait(400);
check(
  'the chat box has the caret',
  await dm.evaluate(`(() => {
    const box = document.getElementById('chat-text');
    if (box === null) return 'no box';
    box.focus();
    box.value = 'half a sentence';
    return document.activeElement === box;
  })()`),
  true,
);

await home(dm);
await dm.wait(400);
check('Home in the chat box leaves the board where it was', await zoom(dm), held);

// Put the camera back, so a run leaves both screens as it found them.
await dm.evaluate(`document.getElementById('fit-board').click(); "ok"`);
await dm.wait(300);

process.exitCode = verdict(dm);
await dm.close();
await player.close();

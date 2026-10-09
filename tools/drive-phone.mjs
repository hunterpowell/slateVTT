// Drives a player's screen on a phone: the narrow layout, the folding draw
// panel, two-finger zoom, and the one-finger gestures that were already there.
//
//   cd server && SLATE_STATE=/tmp/scratch.json SLATE_DM_SECRET=test-secret cargo run
//   node tools/drive-phone.mjs                      # or: ... http://host:port secret
//
// It changes nothing in the room except a ping, which isn't kept. The camera is
// per client and the draw fold is in `localStorage`.
//
// Headless Chrome emulating a phone is not a phone. It can see the layout and
// fire touch events, and it cannot see iOS Safari's keyboard, which is the
// main thing left to check by hand. See `docs/frontend.md`, *A player's phone*.

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, checks } from './cdp.mjs';

const [, , base = 'http://127.0.0.1:3000', secret = 'test-secret'] = process.argv;

const WIDTH = 390;
const HEIGHT = 844;

const phone = await open(`${base}/?room=campaign`, { port: 9335, width: WIDTH, height: HEIGHT });
const dm = await open(`${base}/?room=campaign&dm=${secret}`, { port: 9336 });
const { check, note, verdict } = checks();

await phone.send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 3,
  mobile: true,
});
await phone.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
// The media features a phone reports. Touch emulation alone doesn't always
// change them in headless Chrome, and the rules under test are keyed on them.
await phone.send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'pointer', value: 'coarse' },
    { name: 'hover', value: 'none' },
  ],
});

await phone.wait(2500);
await dm.wait(2500);
await phone.evaluate(`(() => {
  const first = document.querySelector('.picker-choice');
  if (first) first.click();
  return 'ok';
})()`);
await phone.wait(1500);

// ============================================================================
// Scoped to players
// ============================================================================

check('the phone is a player', await phone.evaluate(`document.body.classList.contains('player')`), true);
check('the DM is not', await dm.evaluate(`document.body.classList.contains('player')`), false);
check(
  "the DM's draw panel has no fold button showing",
  await dm.evaluate(`getComputedStyle(document.getElementById('draw-fold')).display`),
  'none',
);

// ============================================================================
// The board is visible
// ============================================================================

check(
  'nothing scrolls sideways',
  await phone.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
  true,
);

/** What is on top at a point, by id or tag. */
const topAt = (x, y) =>
  phone.evaluate(`(() => {
    const el = document.elementFromPoint(${x}, ${y});
    return el === null ? null : (el.id || el.tagName.toLowerCase());
  })()`);

check('the middle of the screen is board', await topAt(WIDTH / 2, HEIGHT / 2), 'stage');
check('so is a point a third of the way down', await topAt(WIDTH / 2, HEIGHT / 3), 'stage');

// Every panel stays inside the screen.
const outside = await phone.evaluate(`(() => {
  const ids = ['whoami', 'corner', 'presence', 'initiative', 'dock', 'drawtool'];
  return ids.filter((id) => {
    const el = document.getElementById(id);
    if (el === null || el.hidden) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0) return false;
    return r.left < 0 || r.right > window.innerWidth || r.top < 0 || r.bottom > window.innerHeight;
  });
})()`);
check('every panel fits on the screen', outside, []);

check(
  'the gesture hint is gone on a touchscreen',
  await phone.evaluate(`getComputedStyle(document.getElementById('hint')).display`),
  'none',
);

// ============================================================================
// The draw panel folds, and says what is armed
// ============================================================================

const toolsShown = () =>
  phone.evaluate(`getComputedStyle(document.getElementById('draw-tools')).display !== 'none'`);
const foldText = () => phone.evaluate(`document.getElementById('draw-fold').textContent`);

check('the draw panel starts folded', await toolsShown(), false);
check('its button says draw', await foldText(), 'draw');

const foldRect = await phone.evaluate(`(() => {
  const r = document.getElementById('draw-fold').getBoundingClientRect();
  const s = document.getElementById('dock-tabs').getBoundingClientRect();
  return { foldBottom: Math.round(r.bottom), stripBottom: Math.round(s.bottom), height: r.height };
})()`);
note(`fold button ${JSON.stringify(foldRect)}`);
check('the fold button sits in the bottom row with the dock tabs',
  Math.abs(foldRect.foldBottom - foldRect.stripBottom) <= 2, true);
check('and is big enough for a finger', foldRect.height >= 40, true);

await phone.evaluate(`document.getElementById('draw-fold').click(); 'ok'`);
await phone.wait(100);
check('a tap opens it', await toolsShown(), true);

await phone.evaluate(`[...document.querySelectorAll('.draw-tool')]
  .find((b) => b.textContent === 'measure').click(); 'ok'`);
await phone.evaluate(`document.getElementById('draw-fold').click(); 'ok'`);
await phone.wait(100);
check('folding it again hides the tools', await toolsShown(), false);
check('and does not put the tool down', await phone.evaluate(`document.body.classList.contains('drawing')`), true);
check('the button says what is in hand', await foldText(), 'draw · measure');

// Put it down again so a finger on the board pans.
await phone.evaluate(`document.getElementById('draw-fold').click(); 'ok'`);
await phone.evaluate(`[...document.querySelectorAll('.draw-tool')]
  .find((b) => b.textContent === 'measure').click(); 'ok'`);
await phone.evaluate(`document.getElementById('draw-fold').click(); 'ok'`);
check('the tool is put down', await phone.evaluate(`document.body.classList.contains('drawing')`), false);

// ============================================================================
// Two fingers zoom; one finger pans
// ============================================================================

// The HUD is hidden on a phone but still written, and its leading number is
// the zoom. A character class, not `\d`: see `drive-fit.mjs`.
const zoom = () =>
  phone.evaluate(`(() => {
    const m = document.getElementById('hud').textContent.match(/^([0-9]+)%/);
    return m === null ? null : Number(m[1]);
  })()`);

const touch = (type, points) =>
  phone.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(([x, y], id) => ({ x, y, id })),
  });

const cx = WIDTH / 2;
const cy = HEIGHT / 2;

const before = await zoom();
await touch('touchStart', [[cx - 30, cy]]);
await touch('touchStart', [[cx - 30, cy], [cx + 30, cy]]);
for (let step = 1; step <= 6; step++) {
  await touch('touchMove', [[cx - 30 - step * 15, cy], [cx + 30 + step * 15, cy]]);
  await phone.wait(30);
}
await touch('touchEnd', []);
await phone.wait(300);
const after = await zoom();
note(`pinch: ${before}% -> ${after}%`);
check('spreading two fingers zooms in', after !== null && before !== null && after > before, true);

for (let step = 1; step <= 6; step++) {
  await touch(step === 1 ? 'touchStart' : 'touchMove', [[cx - 120 + step * 10, cy], [cx + 120 - step * 10, cy]]);
  await phone.wait(30);
}
await touch('touchEnd', []);
await phone.wait(300);
const pinchedOut = await zoom();
note(`pinch back: ${after}% -> ${pinchedOut}%`);
check('closing them zooms out', pinchedOut !== null && pinchedOut < after, true);

// ============================================================================
// One finger pans, and a long press still pings
// ============================================================================

const BOX = 110;
const remember = () =>
  phone.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    window.__box = c.getContext('2d').getImageData(
      Math.round(${cx - BOX / 2} * dpr), Math.round(${cy - BOX / 2} * dpr),
      Math.round(${BOX} * dpr), Math.round(${BOX} * dpr)).data;
    return 'ok';
  })()`);
const movedSince = () =>
  phone.evaluate(`(() => {
    const c = document.querySelector('#stage');
    const dpr = c.width / c.clientWidth;
    const now = c.getContext('2d').getImageData(
      Math.round(${cx - BOX / 2} * dpr), Math.round(${cy - BOX / 2} * dpr),
      Math.round(${BOX} * dpr), Math.round(${BOX} * dpr)).data;
    const was = window.__box;
    let n = 0;
    for (let i = 0; i < now.length; i += 4) {
      if (Math.abs(now[i] - was[i]) + Math.abs(now[i+1] - was[i+1]) + Math.abs(now[i+2] - was[i+2]) > 10) n++;
    }
    return n / (now.length / 4);
  })()`);

// One finger on bare board: the picture under it moves.
await phone.wait(2500); // let the last gestures settle
await remember();
await touch('touchStart', [[cx, cy]]);
for (let step = 1; step <= 5; step++) {
  await touch('touchMove', [[cx + step * 30, cy + step * 30]]);
  await phone.wait(30);
}
await touch('touchEnd', []);
await phone.wait(300);
const panned = await movedSince();
note(`one finger changed ${(panned * 100).toFixed(2)}% of the box`);
check('one finger still pans', panned > 0.2, true);

await phone.wait(2500); // let the last gestures' rings and cursors fade
await remember();
await touch('touchStart', [[cx, cy]]);
await phone.wait(700);
await touch('touchEnd', []);
await phone.wait(200);
const ring = await movedSince();
note(`long press changed ${(ring * 100).toFixed(2)}% of the box`);
check('a long press pings', ring > 0.005, true);

// ============================================================================

const shot = await phone.send('Page.captureScreenshot', { format: 'png' });
const path = process.env.SHOT ?? join(tmpdir(), 'slate-drive-phone.png');
writeFileSync(path, Buffer.from(shot.data, 'base64'));
note(`screenshot saved to ${path}`);

const code = verdict(phone);
phone.close();
dm.close();
process.exit(code);

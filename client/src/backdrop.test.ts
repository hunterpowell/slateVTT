// The half of pointing at the backdrop that needs no canvas: where the picture
// sits in a window, and the conversion both ways between that window and a
// fraction of the picture.
//
// The part that matters most is two windows of different shapes agreeing on a
// spot, which one process can't show. `tools/drive-backdrop.mjs` asks that of
// two real browsers. What this checks is the arithmetic both of them run.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Stroke } from './backdrop.js';
import {
  backdropFit,
  clampToPicture,
  createBackdropMarks,
  fracToScreen,
  onPicture,
  screenToFrac,
  strokeAlpha,
} from './backdrop.js';
import type { Rect } from './coords.js';

const PICTURE = { width: 1600, height: 900 };

function fitOf(view: { width: number; height: number }): Rect {
  const fit = backdropFit(view, PICTURE);
  if (fit === null) throw new Error('a picture with a size has a fit');
  return fit;
}

function near(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual} is not ${expected}`);
}

test('a wide window letterboxes the sides and a tall one the top and bottom', () => {
  const wide = fitOf({ width: 2000, height: 900 });
  assert.deepEqual(wide, { x: 200, y: 0, w: 1600, h: 900 });

  const tall = fitOf({ width: 800, height: 1000 });
  assert.deepEqual(tall, { x: 0, y: 275, w: 800, h: 450 });
});

test('a fraction round-trips through a wide window and a tall one', () => {
  for (const view of [
    { width: 2000, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const fit = fitOf(view);
    for (const at of [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0.37, y: 0.81 },
    ]) {
      const back = screenToFrac(fit, fracToScreen(fit, at));
      near(back.x, at.x, `x in ${view.width}x${view.height}`);
      near(back.y, at.y, `y in ${view.width}x${view.height}`);
    }
  }
});

test('the same spot of the picture in two windows is the same fraction', () => {
  // What every gesture relies on: a phone and a monitor land a mark on one
  // window of the building, not on one pixel of their screens.
  const monitor = fitOf({ width: 2560, height: 1300 });
  const phone = fitOf({ width: 390, height: 700 });
  const at = { x: 0.62, y: 0.3 };
  const onPhone = screenToFrac(phone, fracToScreen(phone, at));
  const onMonitor = screenToFrac(monitor, fracToScreen(monitor, at));
  near(onPhone.x, onMonitor.x, 'x');
  near(onPhone.y, onMonitor.y, 'y');
});

test('the letterbox bars are off the picture', () => {
  const fit = fitOf({ width: 2000, height: 900 });
  assert.equal(onPicture(screenToFrac(fit, { x: 100, y: 450 })), false);
  assert.equal(onPicture(screenToFrac(fit, { x: 1000, y: 450 })), true);
  assert.deepEqual(clampToPicture({ x: -0.2, y: 1.4 }), { x: 0, y: 1 });
});

test('a picture with no size has nowhere to be drawn', () => {
  assert.equal(backdropFit({ width: 800, height: 600 }, { width: 0, height: 0 }), null);
});

test('a stroke holds, then fades, then is gone', () => {
  const stroke: Stroke = { owner: { kind: 'dm' }, points: [], endedAt: 1000 };
  assert.equal(strokeAlpha(stroke, 1000), 1);
  assert.equal(strokeAlpha(stroke, 6900), 1);
  const fading = strokeAlpha(stroke, 8000);
  assert.ok(fading > 0 && fading < 1, `half way through the fade it is ${fading}`);
  assert.equal(strokeAlpha(stroke, 9000), 0);

  const marks = createBackdropMarks({ kind: 'dm' });
  marks.addStroke({ kind: 'dm' }, [], 1000);
  assert.equal(marks.strokes(5000).length, 1);
  assert.equal(marks.strokes(9500).length, 0, 'a faded stroke is dropped');
});

test('clearing drops every mark, for a picture that came down', () => {
  const marks = createBackdropMarks({ kind: 'dm' });
  marks.addStroke({ kind: 'dm' }, [], 0);
  marks.pings.add({ kind: 'dm' }, { x: 0.5, y: 0.5 }, 0);
  marks.cursors.moved({ kind: 'player', id: 'saelyn' }, { x: 0.5, y: 0.5 }, 0);
  marks.drawing = [{ x: 0, y: 0 }];

  marks.clear();

  assert.equal(marks.strokes(1).length, 0);
  assert.equal(marks.pings.active(1).length, 0);
  assert.equal(marks.cursors.active(1).length, 0);
  assert.equal(marks.drawing, null);
});

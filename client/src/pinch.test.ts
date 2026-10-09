// The two-finger gesture on a touchscreen. The fingers themselves are
// `drive-phone.mjs`'s; this is the camera they produce.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { screenToWorld, worldToScreen } from './coords.js';
import { pinchCamera, startPinch } from './pinch.js';

const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('spreading the fingers zooms in about their midpoint', () => {
  const cam = { x: 100, y: 50, zoom: 1 };
  const start = startPinch(cam, { x: 100, y: 200 }, { x: 200, y: 200 });
  const next = pinchCamera(start, { x: 50, y: 200 }, { x: 250, y: 200 }, 0.1, 4);
  close(next.zoom, 2);
  // The world point that was under the midpoint is still under it.
  const held = worldToScreen(next, start.anchor.x, start.anchor.y);
  close(held.x, 150);
  close(held.y, 200);
});

test('moving both fingers together pans without zooming', () => {
  const cam = { x: 0, y: 0, zoom: 2 };
  const start = startPinch(cam, { x: 100, y: 100 }, { x: 200, y: 100 });
  const next = pinchCamera(start, { x: 130, y: 60 }, { x: 230, y: 60 }, 0.1, 4);
  close(next.zoom, 2);
  // The board moved with the fingers: what was at (150, 100) is at (180, 60).
  const was = screenToWorld(cam, 150, 100);
  const now = screenToWorld(next, 180, 60);
  close(now.x, was.x);
  close(now.y, was.y);
});

test('zoom is clamped and the anchor still holds', () => {
  const cam = { x: 0, y: 0, zoom: 3 };
  const start = startPinch(cam, { x: 100, y: 100 }, { x: 110, y: 100 });
  const next = pinchCamera(start, { x: 0, y: 100 }, { x: 210, y: 100 }, 0.1, 4);
  close(next.zoom, 4);
  const held = worldToScreen(next, start.anchor.x, start.anchor.y);
  close(held.x, 105);
  close(held.y, 100);
});

test('two touches on one pixel do not divide by zero', () => {
  const start = startPinch({ x: 0, y: 0, zoom: 1 }, { x: 5, y: 5 }, { x: 5, y: 5 });
  const next = pinchCamera(start, { x: 0, y: 5 }, { x: 10, y: 5 }, 0.1, 4);
  assert.ok(Number.isFinite(next.x) && Number.isFinite(next.zoom));
});

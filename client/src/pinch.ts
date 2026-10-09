// Two fingers on a touchscreen: zoom by how far apart they are, pan by where
// their midpoint goes. One function does both, so a pinch that drifts sideways
// does what the hand did.
//
// The camera math is the wheel zoom's in `input.ts`: whatever world point is
// held under a screen point stays there. Here the screen point moves too.

import type { Camera, Vec2 } from './coords.js';
import { screenToWorld } from './coords.js';

/** What a pinch remembers from the moment the second finger landed. */
export interface PinchStart {
  /** The world point under the fingers' midpoint at the start. */
  anchor: Vec2;
  zoom: number;
  /** Screen pixels between the two fingers. Never zero; see `startPinch`. */
  dist: number;
}

export function startPinch(cam: Camera, a: Vec2, b: Vec2): PinchStart {
  const mid = midpoint(a, b);
  return {
    anchor: screenToWorld(cam, mid.x, mid.y),
    zoom: cam.zoom,
    // Two touches reported at the same pixel would divide by zero on the
    // first move and put the camera at infinity.
    dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
  };
}

/** The camera that keeps `start.anchor` under the fingers' current midpoint. */
export function pinchCamera(
  start: PinchStart,
  a: Vec2,
  b: Vec2,
  minZoom: number,
  maxZoom: number,
): Camera {
  const mid = midpoint(a, b);
  const dist = Math.hypot(a.x - b.x, a.y - b.y);
  const zoom = Math.min(maxZoom, Math.max(minZoom, (start.zoom * dist) / start.dist));
  return { x: start.anchor.x - mid.x / zoom, y: start.anchor.y - mid.y / zoom, zoom };
}

function midpoint(a: Vec2, b: Vec2): Vec2 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

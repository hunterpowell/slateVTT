// What the client renders. The server is authoritative: this is only ever built
// from a Welcome frame and mutated by deltas or by local prediction.

import type { GridSpec, Rect } from './coords.js';
import type { Owner, WireRoomView } from './protocol.js';

export interface Token {
  id: string;
  name: string;
  /** Cell centre, in grid units. Never pixels — invariant 1. */
  x: number;
  y: number;
  owner: Owner;
  img: string;
}

export interface Scene {
  mapUrl: string;
  grid: GridSpec;
  /** The overlay colour as `#rrggbbaa`. Not part of `GridSpec`, which is
   *  geometry — this is only ever read by the renderer. */
  gridColor: string;
  /** The playable region, or null for the whole image. */
  playArea: Rect | null;
  /** Draw order; later entries render on top and win hit-tests. */
  tokens: Token[];
}

/**
 * The server sends tokens in a stable order, and that order is z-order, so it
 * is preserved verbatim here.
 */
export function sceneFromView(view: WireRoomView): Scene {
  return {
    mapUrl: view.map.url,
    grid: { px: view.map.grid_px, offsetX: view.map.offset_x, offsetY: view.map.offset_y },
    gridColor: view.map.grid_color,
    playArea: view.map.play_area,
    tokens: view.tokens.map((t) => ({
      id: t.id,
      name: t.name,
      x: t.x,
      y: t.y,
      owner: t.owner,
      img: t.img,
    })),
  };
}

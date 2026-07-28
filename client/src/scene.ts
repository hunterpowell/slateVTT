// What the client renders. The server is authoritative: this is only ever built
// from a Welcome frame and mutated by deltas or by local prediction.

import type { GridSpec, Rect } from './coords.js';
import type { Owner, WireRoomView, WireToken } from './protocol.js';

export interface Token {
  id: string;
  name: string;
  /** Cell centre, in grid units. Never pixels — invariant 1. */
  x: number;
  y: number;
  owner: Owner;
  /** Empty for a token with no art; the renderer draws a named disc. */
  img: string;
  /** Width and height in grid cells. */
  size: number;
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
    tokens: view.tokens.map(tokenFromWire),
  };
}

function tokenFromWire(t: WireToken): Token {
  return { id: t.id, name: t.name, x: t.x, y: t.y, owner: t.owner, img: t.img, size: t.size };
}

/**
 * Takes an incoming token as the truth for its id, creating it if this client
 * has not seen it before.
 *
 * The re-sort is what keeps every client agreeing about z-order: the server
 * sorts a join snapshot by id, so a client that learned about this token from a
 * delta has to end up in the same order as one that joined afterwards. Returns
 * whether the token is new, which is what decides if its art needs fetching.
 */
export function upsertToken(scene: Scene, wire: WireToken): boolean {
  const token = tokenFromWire(wire);
  const at = scene.tokens.findIndex((t) => t.id === token.id);

  if (at !== -1) {
    scene.tokens[at] = token;
    return false;
  }

  scene.tokens.push(token);
  scene.tokens.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return true;
}

export function removeToken(scene: Scene, id: string): void {
  const at = scene.tokens.findIndex((t) => t.id === id);
  if (at !== -1) scene.tokens.splice(at, 1);
}

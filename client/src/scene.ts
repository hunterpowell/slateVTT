// What the client renders. The server is authoritative: this is only ever built
// from a Welcome frame and mutated by deltas or by local prediction.

import type { GridSpec, Rect } from './coords.js';
import type { Hp, Owner, WireMapInfo, WireRoomView, WireToken } from './protocol.js';

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
  /** The table cannot see this one. Only ever true on the DM's client — a
   *  player is never sent a hidden token, so nothing here has to defend
   *  against drawing one. The DM's board marks it instead. */
  hidden: boolean;
  /** The DM's running total, or null. Null on every token for a player. */
  hp: Hp | null;
}

/** One map image and how the grid sits on it. Live and staged are the same shape. */
export interface Board {
  mapUrl: string;
  grid: GridSpec;
  /** The overlay colour as `#rrggbbaa`. Not part of `GridSpec`, which is
   *  geometry — this is only ever read by the renderer. */
  gridColor: string;
  /** The playable region, or null for the whole image. */
  playArea: Rect | null;
}

export interface Scene {
  /** What the table is looking at. */
  live: Board;
  /** The map the DM is preparing, or null. Always null for a player: the
   *  server never sends them one. */
  staged: Board | null;
  /** The DM is looking at `staged` instead of `live`. Purely local — no
   *  command, no event, nothing persisted, and nobody else can tell. */
  previewing: boolean;
  /** Draw order; later entries render on top and win hit-tests. */
  tokens: Token[];
}

/**
 * The board on screen. Everything that draws or hit-tests goes through this
 * rather than reaching for `scene.live`, which is what keeps preview mode from
 * being a special case in each of them.
 */
export function shownBoard(scene: Scene): Board {
  return scene.previewing && scene.staged !== null ? scene.staged : scene.live;
}

/**
 * The server sends tokens in a stable order, and that order is z-order, so it
 * is preserved verbatim here.
 */
export function sceneFromView(view: WireRoomView): Scene {
  return {
    live: boardFromWire(view.map),
    staged: view.staged === null ? null : boardFromWire(view.staged),
    previewing: false,
    tokens: view.tokens.map(tokenFromWire),
  };
}

export function boardFromWire(map: WireMapInfo): Board {
  return {
    mapUrl: map.url,
    grid: { px: map.grid_px, offsetX: map.offset_x, offsetY: map.offset_y },
    gridColor: map.grid_color,
    playArea: map.play_area,
  };
}

function tokenFromWire(t: WireToken): Token {
  return {
    id: t.id,
    name: t.name,
    x: t.x,
    y: t.y,
    owner: t.owner,
    img: t.img,
    size: t.size,
    hidden: t.hidden,
    hp: t.hp,
  };
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

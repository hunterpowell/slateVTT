// What the client renders. The server is authoritative: this is only ever built
// from a Welcome frame and mutated by deltas or by local prediction.

import type { GridSpec, Rect, Vec2 } from './coords.js';
import type { Fog } from './fog.js';
import { fogFromWire } from './fog.js';
import type { Hp, Owner, WireMapInfo, WireRoomView, WireToken } from './protocol.js';
import type { Shape } from './shapes.js';
import { shapeFromWire } from './shapes.js';
import type { Wall } from './walls.js';
import { wallFromWire } from './walls.js';

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
  /** Where this token lands when the staged map is promoted, or null for one
   *  staying put. Null on every token for a player. In grid units like `x, y` —
   *  a plan is a cell, which is what makes recalibrating the staged map after
   *  placing monsters safe. */
  stagedPos: Vec2 | null;
  /** Built on the map the DM is preparing and not on the board yet. Only ever
   *  true on the DM's client, and absent from their live board as much as from
   *  everyone else's: `Map` mode has to show what the table is looking at. */
  stagedOnly: boolean;
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
  /** Whether the party's sight is limited on this map. Per map, and remembered
   *  per URL with the rest of the calibration. */
  fog: boolean;
  /** How far a player-owned token sees, in feet. Only read when `fog` is on. */
  visionFt: number;
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
  /** What is drawn on the board, in draw order. Belongs to the live board
   *  alone — there is nothing to draw on a map the table has not been shown, so
   *  unlike tokens these do not fork. Replaced wholesale by every
   *  `shapes_changed`, which is why nothing here is predicted locally. */
  shapes: Shape[];
  /** The traced walls and doors, in image pixels rather than grid units — they
   *  are anchored to the art, not to a cell. Always empty for a player: the
   *  server sends them none, and empty is also what an untraced map looks like.
   *
   *  Belongs to the live board like the shapes do. There are no staged walls;
   *  walls prepared alongside a map is the scene concept Slate does not build. */
  walls: Wall[];
  /** What the party can see, or null on a map with fog turned off.
   *
   *  Unlike the walls above it, everyone holds this and everyone holds the same
   *  one — fog is party-shared, so there is a single answer, and the DM's copy
   *  differs only in how faintly it draws.
   *
   *  It is not a filter. A creature the table cannot see is absent from `tokens`
   *  entirely; this is the *terrain*, and nothing here decides who is drawn. */
  fog: Fog | null;
}

/**
 * Whether the board on screen is the staged one. `shownBoard` answers which
 * board to draw on; this is the same question as a yes or no, for the callers
 * that compare it against something rather than draw on it.
 */
export function showingStaged(scene: Scene): boolean {
  return scene.previewing && scene.staged !== null;
}

/**
 * The board on screen. Everything that draws or hit-tests goes through this
 * rather than reaching for `scene.live`, which is what keeps preview mode from
 * being a special case in each of them.
 */
export function shownBoard(scene: Scene): Board {
  // Spelled out rather than asking `showingStaged`, whose answer does not narrow
  // `staged` away from null for the type checker.
  return scene.previewing && scene.staged !== null ? scene.staged : scene.live;
}

/**
 * Where a token draws, given which board is on screen — or null when it is not
 * on that board at all.
 *
 * The token-shaped twin of `shownBoard`, and for the same reason: without one
 * function answering this, a planned position gets written into the live one by
 * a single missing branch, and a token that does not exist yet gets drawn on the
 * board the table is looking at. Every draw and every hit-test goes through it.
 *
 * A token with no plan shows at its own position while previewing, because that
 * is where it lands on a promote — tokens keep their cells.
 */
export function shownPos(scene: Scene, token: Token): Vec2 | null {
  if (scene.previewing && scene.staged !== null) {
    return token.stagedPos ?? { x: token.x, y: token.y };
  }
  return token.stagedOnly ? null : { x: token.x, y: token.y };
}

/**
 * The server sends tokens in a stable order, and that order is z-order, so it
 * is preserved verbatim here.
 */
export function sceneFromView(view: WireRoomView, isDm: boolean): Scene {
  return {
    live: boardFromWire(view.map),
    staged: view.staged === null ? null : boardFromWire(view.staged),
    previewing: false,
    tokens: view.tokens.map(tokenFromWire),
    shapes: view.shapes.map(shapeFromWire),
    walls: view.walls.map(wallFromWire),
    fog: fogFromWire(view.fog, isDm),
  };
}

export function boardFromWire(map: WireMapInfo): Board {
  return {
    mapUrl: map.url,
    grid: { px: map.grid_px, offsetX: map.offset_x, offsetY: map.offset_y },
    gridColor: map.grid_color,
    playArea: map.play_area,
    fog: map.fog,
    visionFt: map.vision_ft,
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
    stagedPos: t.staged_pos,
    stagedOnly: t.staged_only,
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

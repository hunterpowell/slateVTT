// What the client renders. The server is authoritative: this is only ever built
// from a Welcome frame and mutated by deltas or by local prediction.

import type { GridSpec, Rect, Vec2 } from './coords.js';
import type { Fog } from './fog.js';
import { fogFromWire } from './fog.js';
import type { Overrides } from './overrides.js';
import { overridesFromWire } from './overrides.js';
import type {
  Diagonals,
  Hp,
  Lighting,
  Owner,
  WireGridShape,
  WireMapInfo,
  WireRoomView,
  WireStaged,
  WireToken,
} from './protocol.js';
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
  /** How far this token lights the board, in feet, or null for one carrying no
   *  light. Null on every token for a player, like `hp`.
   *
   *  Almost nothing on this side computes with it: the fog it casts is worked
   *  out in the room and arrives already packed. `solo.ts` is the one reader,
   *  because the DM's sight check casts rays of its own. */
  lightFt: number | null;
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
  /** Line of sight, or the room a token is standing in. Read by the fog panel
   *  and by nothing that draws: what arrives is a `Fog` either way. */
  lighting: Lighting;
}

/**
 * The staged slot: the map the DM is preparing, and what they have prepared on
 * it.
 *
 * `Board`'s superset rather than a second shape, so everything that draws or
 * hit-tests can go on reading a `Board` through `shownBoard` and only the three
 * things that fork have to know this exists.
 *
 * There is no `fog` here beside the walls and the overrides, and that is the
 * one deliberate hole: nothing raycasts the staged board. The DM is deciding
 * what the party will be handed when it lands, not looking at what they will
 * see — "will they spot the dragon when the door opens" is a second raycast and
 * is out of scope. See `docs/fog.md`.
 */
export interface StagedBoard extends Board {
  /** Traced on the next dungeon, in image pixels like the live board's. Empty
   *  until the DM traces something, which is also what a player would hold if
   *  they were ever sent one of these. They are not. */
  walls: Wall[];
  /** Painted on it by hand, and promoted with it. */
  overrides: Overrides;
}

export interface Scene {
  /** What the table is looking at. */
  live: Board;
  /** The map the DM is preparing with its walls and its paint, or null. Always
   *  null for a player: the server never sends them one, and one null withholds
   *  all three. */
  staged: StagedBoard | null;
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
   *  **The live board's.** The staged one carries its own; read `shownWalls`
   *  rather than this, exactly as everything reads `shownBoard` rather than
   *  `live`. Still one slot and not the scene concept — a promote moves one
   *  list into the other rather than a list existing per map. */
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
  /** The cells the DM has painted over that fog by hand. Always empty for a
   *  player, like `walls` two fields up rather than like `fog` between them —
   *  the walls and this are what the DM authored, and the fog is what the table
   *  gets to see of both.
   *
   *  **The live board's**, like `walls` above and read through
   *  `shownOverrides`. The staged board carries its own — there is no fog on it
   *  to be masked, but what is painted there is what the party is handed the
   *  moment it is promoted. */
  overrides: Overrides;
  /** Whether the board writes each token's name under it. The DM's to set and
   *  everyone's to hold, so this is the same for every client — a board labelled
   *  one way for the DM and another for the table is the thing it prevents.
   *
   *  Room-wide, so it is here rather than on `Board`: it applies to the map
   *  being previewed as much as to the one on screen. */
  showNames: boolean;
  /** How the movement ruler charges a diagonal. Room-wide and the same for every
   *  client, exactly like the switch above it — and here rather than on `Board`
   *  for the same reason too: it is how the table counts, not a property of the
   *  image they are counting over. */
  diagonals: Diagonals;
  /** Whether everybody's pointer is drawn on everybody's board. Room-wide and
   *  the same for every client, exactly like the two switches above it — and
   *  here rather than on `Board` for their reason too.
   *
   *  The one of the three that `input.ts` reads as well as the renderer: with it
   *  off the room relays nothing, so a client that went on sending its own
   *  pointer would be paying the whole cost of a feature nobody can see. */
  showCursors: boolean;
  /** Whether the DM's own pointer is drawn on the players' boards. Room-wide
   *  and the same for every client like the switch above it.
   *
   *  The renderer never reads this and neither does `input.ts`: the room drops
   *  the DM's frames itself, so a player is sent this and does nothing with it.
   *  What reads it is the table panel, putting the DM's own checkbox back. */
  showDmCursor: boolean;
  /** The picture in front of the table, or null when they are looking at the
   *  board.
   *
   *  Room-wide and the same for every client like the three switches above it,
   *  and here rather than on `Board` for a stronger version of their reason:
   *  it is not a property of either board, it is what is being shown *instead*
   *  of one. Everything on `Board` — the grid, the walls, the fog, the tokens
   *  standing on it — is still exactly as it was while this is set, which is
   *  why putting the picture away needs nothing from the server. */
  backdrop: string | null;
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
 * The walls of the board on screen, and the paint on it.
 *
 * `shownBoard`'s twins, for the two things that live beside a board rather than
 * on it. Everything that draws, hit-tests or sends a wall command reads these
 * rather than `scene.walls` — the milestone-10 shape for the third time, and
 * the same argument each time: without one function answering it, a single
 * missing branch traces the next dungeon's masonry across the board the table
 * is looking at.
 *
 * Empty when nothing is staged, which is what an untraced map looks like too.
 */
export function shownWalls(scene: Scene): Wall[] {
  return scene.previewing && scene.staged !== null ? scene.staged.walls : scene.walls;
}

export function shownOverrides(scene: Scene): Overrides {
  return scene.previewing && scene.staged !== null ? scene.staged.overrides : scene.overrides;
}

/**
 * The picture to draw instead of the board, or null to draw the board.
 *
 * `shownBoard`'s fourth twin, and the one that answers a question one step
 * earlier than the other three: they pick *which* board, this decides whether a
 * board is drawn at all.
 *
 * **Preview wins**, which is the whole of the branch. A backdrop is what the
 * *table* is looking at, and the DM previewing the staged map is asking to see
 * the next dungeon — so the party can roleplay at the campfire while the DM
 * traces the crypt they are about to walk into. Without this line the DM would
 * have to take the picture off six other screens to get any work done.
 */
export function shownBackdrop(scene: Scene): string | null {
  return showingStaged(scene) ? null : scene.backdrop;
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
 * Everything about a scene that comes off the wire — which is every field but
 * `previewing`, and the `Omit` is what says so.
 *
 * It exists so `sceneFromView` and `adoptView` share one field list. Two lists
 * would rot in the direction that fails silently: a field added to `Scene` and
 * built here but forgotten in the adopt path is a restore that quietly keeps
 * the stale value, which looks like a server bug rather than a missing line.
 *
 * The server sends tokens in a stable order, and that order is z-order, so it
 * is preserved verbatim.
 */
function fromView(view: WireRoomView, isDm: boolean): Omit<Scene, 'previewing'> {
  return {
    live: boardFromWire(view.map),
    staged: stagedFromWire(view.staged),
    tokens: view.tokens.map(tokenFromWire),
    shapes: view.shapes.map(shapeFromWire),
    walls: view.walls.map(wallFromWire),
    fog: fogFromWire(view.fog, isDm),
    overrides: overridesFromWire(view.overrides),
    showNames: view.show_names,
    diagonals: view.diagonals,
    showCursors: view.show_cursors,
    showDmCursor: view.show_dm_cursor,
    backdrop: view.backdrop,
  };
}

export function sceneFromView(view: WireRoomView, isDm: boolean): Scene {
  return { ...fromView(view, isDm), previewing: false };
}

/**
 * Takes a whole `RoomView` as the truth for a scene that already exists —
 * `sceneFromView` for the second and later ones.
 *
 * **In place, and that is the entire point.** The board captured this object
 * when it started and draws from it every frame; the panels were handed it
 * once. Assigning a *new* scene over `room.scene` would leave the renderer
 * drawing the old one forever, which is why a restore cannot simply rebuild
 * what `Welcome` built.
 *
 * `previewing` survives, which the type enforces rather than the author
 * remembering: it is local state about where the DM is looking, and a frame
 * from the room has no opinion about that. If the restore empties the staged
 * slot, `shownBoard` falls back to the live board on its own and the map tool
 * reports the mode change, exactly as a discard already does.
 */
export function adoptView(scene: Scene, view: WireRoomView, isDm: boolean): void {
  Object.assign(scene, fromView(view, isDm));
}

/**
 * The staged slot off the wire, or null for an empty one — which is also what a
 * player is always sent, indistinguishably.
 *
 * The map's fields sit directly on the frame beside `walls` and `overrides`
 * (that is `#[serde(flatten)]` on the server), so `boardFromWire` reads it
 * unchanged and this only has to add the two.
 */
export function stagedFromWire(wire: WireStaged | null): StagedBoard | null {
  if (wire === null) return null;
  return {
    ...boardFromWire(wire),
    walls: wire.walls.map(wallFromWire),
    overrides: overridesFromWire(wire.overrides),
  };
}

/**
 * The two cell axes in world pixels: where `(1, 0)` and `(0, 1)` land.
 *
 * **The one place `WireGridShape` is read.** An isometric grid is an affine image
 * of a square one, so everything downstream goes on asking its questions of a
 * lattice and none of them learns there is more than one shape — the same
 * discipline `shownBoard` keeps over which of the two boards is on screen.
 * `fog::basis` in `server/src/fog.rs` is its twin and the two must agree exactly,
 * or the fog the server packs lands somewhere else on the client's board.
 *
 * The square case is `(px, 0)` and `(0, px)`, which reduces `gridToWorld` to the
 * arithmetic it held before there was a basis.
 */
export function gridBasis(map: WireMapInfo): GridSpec {
  const shape = map.grid_shape;
  const offsetX = map.offset_x;
  const offsetY = map.offset_y;
  if (shape.kind === 'iso') {
    // A diamond `grid_px` tall and `grid_px * ratio` wide, so the two axes run
    // to its right-hand and left-hand corners. Mirrored about vertical rather
    // than free, which is what makes one dragged edge enough to calibrate one.
    const halfW = (map.grid_px * shape.ratio) / 2;
    const halfH = map.grid_px / 2;
    return { px: map.grid_px, ax: halfW, ay: halfH, bx: -halfW, by: halfH, offsetX, offsetY };
  }
  return { px: map.grid_px, ax: map.grid_px, ay: 0, bx: 0, by: map.grid_px, offsetX, offsetY };
}

/**
 * The shape a `GridSpec` describes — `gridBasis` read backwards.
 *
 * The client builds a basis to draw with and has to send a *shape* back, because
 * the wire carries the descriptor. The two are exact inverses for the only two
 * lattices that exist, which is what `a_grid_survives_the_round_trip_through_the_wire`
 * holds; anything that constructs a `GridSpec` by hand rather than through
 * `squareGrid` or `gridFromEdge` is what would break it.
 */
export function shapeOf(grid: GridSpec): WireGridShape {
  // A square's second axis has no horizontal component and its first none
  // vertical. Nothing else the client builds looks like that.
  if (grid.ay === 0 && grid.bx === 0) return { kind: 'square' };
  return { kind: 'iso', ratio: (grid.ax * 2) / grid.px };
}

export function boardFromWire(map: WireMapInfo): Board {
  return {
    mapUrl: map.url,
    grid: gridBasis(map),
    gridColor: map.grid_color,
    playArea: map.play_area,
    fog: map.fog,
    visionFt: map.vision_ft,
    lighting: map.lighting,
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
    lightFt: t.light_ft,
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

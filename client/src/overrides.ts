// The DM's manual fog override, on the reading side.
//
// The counterpart of `fog.ts`, and worth reading with it. The fog is what the
// table can see, it reaches everybody, and nobody decides it directly. This is
// what the DM decided, it reaches nobody else, and the fog is its result, so a
// player's copy of this is always empty, like their wall list.
//
// Nothing here is a visibility decision either. A cell the party can't see is
// already dark in the fog frame; this only says which of those cells are dark
// because somebody painted them, which the DM can't otherwise tell. Without it
// a wall's shadow and a blacked-out room look the same on their screen.
//
// Packed into a canvas like the fog, for the same reason: a filled dungeon room
// is a few thousand cells, and a `fillRect` per cell per frame is too slow.
//
// The flood fill is here too, at the bottom, because it produces one of these.
// It runs on the client, not the server; see `fillFrom`.
//
// Read `docs/fog.md` before changing any of it.

import type { GridSpec, Rect, Vec2 } from './coords.js';
import { gridToWorld, minSpan, worldToGrid } from './coords.js';
import type { FogPaint, WireOverrides } from './protocol.js';
import type { Wall } from './walls.js';

/** No override: a hole in the rectangle, and the only state with no colour. */
const AUTO = '-';

/**
 * What each brush paints, at full strength. The renderer fades the whole layer
 * instead of these being pre-faded, so opening the fog tab doesn't rebuild the
 * canvas; it changes one `globalAlpha`.
 *
 * Three hues, not three alphas of one, because the DM has to tell them apart
 * at a glance on a board that already has a grid, walls, auras and a fog wash
 * on it.
 */
const PAINT: Record<string, [number, number, number]> = {
  // Forced explored: the ground handed over, without the creatures on it.
  o: [86, 132, 214],
  // Forced in sight: the ground and whatever is standing on it.
  '*': [232, 190, 92],
  // Forced dark. Red because it is the destructive one.
  '#': [206, 84, 96],
};

/**
 * The overrides as this client holds them: the server's rectangle, plus the
 * little canvas built from it.
 *
 * Built once per `overrides_changed`, not per frame, which is why this is a
 * type and not a bare `WireOverrides`.
 */
export interface Overrides {
  /** Cell coordinates of the rectangle's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * One pixel per cell, transparent where nothing is painted.
   *
   * Null when nothing is painted at all, which is what a player's copy always
   * is and what a map the DM has not touched packs to.
   */
  tint: HTMLCanvasElement | null;
}

/** How solidly the layer draws: faint while the DM is playing, stronger while
 *  the fog tab is open and they are painting.
 *
 *  Walls are drawn the same way (always, but faint until the editor is armed),
 *  for the same reason. A DM mid-fight wants to know a room is blacked out,
 *  without the tint covering their board. */
export const OVERRIDE_ALPHA = { idle: 0.15, armed: 0.4 } as const;

/** Builds the drawable override layer from a frame off the wire. */
export function overridesFromWire(wire: WireOverrides): Overrides {
  const layer: Overrides = { x: wire.x, y: wire.y, w: wire.w, h: wire.h, tint: null };
  if (wire.w === 0 || wire.h === 0) return layer;

  const canvas = document.createElement('canvas');
  canvas.width = wire.w;
  canvas.height = wire.h;
  const ctx = canvas.getContext('2d');
  // Unavailable only in a browser that can't draw the board either. Returning
  // the layer without one leaves the DM's own annotation undrawn, which costs
  // them a hint and the table nothing: this is not a filter.
  if (ctx === null) return layer;

  const image = ctx.createImageData(wire.w, wire.h);
  for (let i = 0; i < wire.w * wire.h; i++) {
    const rgb = PAINT[wire.cells[i] ?? AUTO];
    if (rgb === undefined) continue;
    image.data[i * 4] = rgb[0];
    image.data[i * 4 + 1] = rgb[1];
    image.data[i * 4 + 2] = rgb[2];
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  layer.tint = canvas;
  return layer;
}

/** The colour a brush paints in, for the panel's own swatches and for the fill
 *  preview, so the preview is drawn in the colour the commit will land in. */
export function paintColor(paint: FogPaint | null): string {
  const glyph = paint === 'explored' ? 'o' : paint === 'lit' ? '*' : paint === 'dark' ? '#' : '';
  const rgb = PAINT[glyph];
  // Handing cells back has no colour of its own, so its preview is drawn in a
  // neutral one.
  return rgb === undefined ? 'rgb(180, 186, 198)' : `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/**
 * Every cell reachable from `seed` without crossing anything the DM traced.
 *
 * The fill runs here and the command carries the cells it found. The DM's
 * client already holds the walls and has to compute this anyway to draw the
 * preview, so sending the previewed cells makes the preview and the result the
 * same data, instead of two implementations that would have to agree. The DM
 * may reveal whatever they like, so the server has no answer of its own to
 * check, only a size to bound and a board to clip against.
 *
 * It is not the raycast written twice. That asks whether a viewer can see a
 * cell; this asks whether two cells are connected. They read the same walls
 * but answer different questions, and a fill that squeezes through a gap the
 * DM traced badly is what the preview is there to show before they commit.
 *
 * **Every traced segment bounds a fill, open or shut.** Doors are where the
 * two questions differ. A dungeon traced for sight leaves its archways open,
 * so a fill that let open doors through would escape into the whole connected
 * map, and a room that filled cleanly would stop filling once the party opened
 * its door. So an open door blocks nothing the party does and still bounds
 * this, which lets an archway be traced as a boundary without blinding anyone
 * standing in it. A room plus the corridor past its open door then takes two
 * clicks.
 *
 * Four neighbours, not eight, which is the conservative choice: a wall traced
 * corner to corner leaves a diagonal a fill would otherwise leak through, and
 * a fill that stops short costs a second click, while one that escapes costs a
 * repaint.
 *
 * A corner-to-corner wall can also run through cell centres, and those cells
 * are dead ends here, not holes (see `cutByWall`). See `docs/fog.md`.
 */
export function fillFrom(
  seed: Vec2,
  walls: readonly Wall[],
  grid: GridSpec,
  /** The play area in image pixels, or the whole image. The party can't be
   *  anywhere outside it, and the server clips to the same bound. */
  board: Rect,
  /** Where to give up. Matches `MAX_OVERRIDE_CELLS` on the server, which refuses
   *  anything past it. Stopping here shows the DM a fill that obviously ran
   *  away, instead of a command that comes back as an error. */
  limit: number,
  /**
   * A circle the fill may not leave, in cells and measured from `seed`, or
   * nothing for the DM's reveal tool, which is bounded only by walls and the
   * board.
   *
   * This is `Room` lighting's bound, not the paint's: a pure fill ignores
   * corners, so a winding corridor would light to its far end around every
   * bend. The server's `lit_cells` bounds by `vision_ft` for that reason, and
   * `solo.ts` asks the same question of the same walls on the client. Measured
   * Euclidean from the source like the raycast's radius, and applied where a
   * cell is entered, not where it is taken, so a fill stops at the circle
   * instead of one cell past it.
   *
   * **In cells, not pixels.** A radius set in feet is a whole number of cells,
   * so the cells due east and due west of the viewer sit exactly on it. Scaled
   * into pixels, the two sides of that tie round differently and the circle
   * loses a cell off one edge. See `visible_cells` in `fog.rs`.
   */
  withinCells?: number,
): number[] {
  const centre = (cx: number, cy: number): Vec2 => gridToWorld(grid, cx + 0.5, cy + 0.5);
  const onBoard = (p: Vec2): boolean =>
    p.x >= board.x && p.x <= board.x + board.w && p.y >= board.y && p.y <= board.y + board.h;

  const start = { x: Math.floor(seed.x), y: Math.floor(seed.y) };
  if (grid.px <= 0 || !onBoard(centre(start.x, start.y))) return [];

  const blockers = index(walls, grid);
  const found: number[] = [];
  const seen = new Set<number>([key(start.x, start.y)]);
  let queue: Vec2[] = [start];

  while (queue.length > 0 && found.length / 2 < limit) {
    const next: Vec2[] = [];
    for (const cell of queue) {
      found.push(cell.x, cell.y);
      const from = centre(cell.x, cell.y);
      // A cell a wall runs through belongs to the fill that reached it and to
      // nothing past it: taken, and never expanded out of. See `cutByWall`.
      if (cutByWall(blockers, cell, from)) continue;
      for (const [dx, dy] of NEIGHBOURS) {
        const to = { x: cell.x + dx, y: cell.y + dy };
        const id = key(to.x, to.y);
        if (seen.has(id)) continue;
        if (
          withinCells !== undefined &&
          Math.hypot(to.x + 0.5 - seed.x, to.y + 0.5 - seed.y) > withinCells
        ) {
          continue;
        }
        const at = centre(to.x, to.y);
        if (!onBoard(at)) continue;
        if (blocked(blockers, cell, to, from, at)) continue;
        seen.add(id);
        next.push(to);
      }
    }
    queue = next;
  }
  return found;
}

const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** A cell as one number, so the visited set is a `Set<number>` instead of a set
 *  of strings. The board is bounded well inside this. */
function key(x: number, y: number): number {
  return (x + 65536) * 262144 + (y + 65536);
}

/**
 * Which walls could possibly bound a step out of each cell.
 *
 * Every one of them, doors included, open or shut. See `fillFrom` for why this
 * is the one place a door's state isn't read.
 *
 * Without this the fill tests every cell against every wall: a few thousand
 * cells against a few hundred segments, four times over, recomputed as the
 * pointer crosses into a new cell. Registering each segment into the cells it
 * passes through and their neighbours makes each step a lookup instead of a
 * scan, and misses nothing: the line between two adjacent cell centres stays
 * inside those two cells, so anything crossing it passes through one of them.
 */
function index(walls: readonly Wall[], grid: GridSpec): Map<number, Wall[]> {
  const buckets = new Map<number, Wall[]>();

  for (const wall of walls) {
    const dx = wall.to.x - wall.from.x;
    const dy = wall.to.y - wall.from.y;
    // Half a cell at a time, so no cell the segment passes through is skipped,
    // and half of the *shortest* a cell measures, so a diamond isn't stepped
    // over the short way across.
    const steps = Math.ceil((Math.hypot(dx, dy) / minSpan(grid)) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cell = worldToGrid(grid, wall.from.x + dx * t, wall.from.y + dy * t);
      const cx = Math.floor(cell.x);
      const cy = Math.floor(cell.y);
      // And its eight neighbours: a wall running exactly along a cell boundary
      // (the common case, because of `snapToCorner`) belongs to the cells on
      // both sides of it, and floating point picks one of them arbitrarily.
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const id = key(cx + ox, cy + oy);
          const bucket = buckets.get(id);
          if (bucket === undefined) buckets.set(id, [wall]);
          else if (!bucket.includes(wall)) bucket.push(wall);
        }
      }
    }
  }
  return buckets;
}

/**
 * Whether a wall runs straight through this cell's centre, which makes it a
 * dead end for the fill: taken by whichever side reaches it, expanded out of by
 * neither.
 *
 * **Every 45-degree wall does this, not just the odd one.** A corner-snapped
 * wall on a horizontal or vertical line runs between cell centres, never
 * through one, whatever the grid offset. A wall at 45 degrees hits a centre
 * every other cell, and a chamfered room corner is made of those, so this
 * matters most on carefully traced maps.
 *
 * Such a cell is half in and half out, and neither answer is right. Taking it
 * and stopping gets two things right: the room's fill covers its own corner
 * instead of leaving a ragged square the DM has to notice and paint, and the
 * fill can't walk through the wall. Without this check every step touching
 * such a cell ties at one end or the other, and the fill leaks out through it.
 *
 * The seed isn't special-cased. Clicking exactly on a chamfer fills that one
 * square; letting a seed expand would put both sides of the wall in one fill.
 */
function cutByWall(buckets: Map<number, Wall[]>, cell: Vec2, centre: Vec2): boolean {
  for (const wall of buckets.get(key(cell.x, cell.y)) ?? []) {
    // On the wall's line, and between its ends, not past them.
    if (side(wall.from, wall.to, centre) === 0 && within(wall.from, wall.to, centre)) {
      return true;
    }
  }
  return false;
}

/** Whether anything stands between two neighbouring cell centres. */
function blocked(
  buckets: Map<number, Wall[]>,
  a: Vec2,
  b: Vec2,
  from: Vec2,
  to: Vec2,
): boolean {
  for (const cell of [a, b]) {
    for (const wall of buckets.get(key(cell.x, cell.y)) ?? []) {
      if (crosses(from, to, wall.from, wall.to)) return true;
    }
  }
  return false;
}

/**
 * Whether two segments cross, for the purpose of stopping a fill.
 *
 * The same shape as `crosses` in `fog.rs`, though it needn't agree with it:
 * this is a selection gesture, not a visibility rule, and whatever it decides
 * is what the DM sees in the preview before committing. Written the same way
 * anyway, so a fill stops where the DM expects from watching the fog.
 *
 * **A tie at either end of the step is contact, not a crossing**, as in the
 * raycast. A step that ends on a wall is a step into a cell the wall runs
 * through, and `cutByWall` has already decided that the fill takes that cell
 * and stops inside it. Answering "blocked" here as well would make the cell
 * unreachable from both sides, leaving a ragged chamfer.
 *
 * Don't rely on this alone to stop the fill: a tie lets the fill in from one
 * side and straight out the other, so without `cutByWall` a single cell on a
 * 45-degree wall leaks the fill across the whole map.
 */
function crosses(p: Vec2, q: Vec2, a: Vec2, b: Vec2): boolean {
  const d1 = side(a, b, p);
  const d2 = side(a, b, q);
  if (d1 === 0 || d2 === 0 || d1 > 0 === d2 > 0) return false;

  const d3 = side(p, q, a);
  const d4 = side(p, q, b);
  if (d3 === 0) return within(p, q, a);
  if (d4 === 0) return within(p, q, b);
  return d3 > 0 !== d4 > 0;
}

/** Which side of the line `u`→`v` the point `w` falls on: the sign is the side,
 *  and zero is exactly on it. */
function side(u: Vec2, v: Vec2, w: Vec2): number {
  return (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
}

/** Whether `c`, already known to be on the line through `p` and `q`, is between
 *  them. Collinear, so the bounding box is the whole question. */
function within(p: Vec2, q: Vec2, c: Vec2): boolean {
  return (
    c.x >= Math.min(p.x, q.x) &&
    c.x <= Math.max(p.x, q.x) &&
    c.y >= Math.min(p.y, q.y) &&
    c.y <= Math.max(p.y, q.y)
  );
}

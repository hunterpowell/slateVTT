// The DM's manual fog override, on the reading side.
//
// The mirror of `fog.ts` next door, and the two are worth reading together
// because they are opposites. The fog is what the *table* can see, it reaches
// everybody, and nothing about it is a decision. This is what the DM *decided*,
// it reaches nobody else, and the fog is the shadow it casts — so a player's copy
// of this is always empty, exactly as their wall list is.
//
// Nothing here is a visibility decision either. A cell the party cannot see is
// already dark in the fog frame; this only says which of those cells got that way
// because somebody painted them, which is a thing the DM needs to know and cannot
// otherwise tell. Without it a wall's shadow and a blacked-out room look the same
// on their screen, and with no undo that is the difference between correcting a
// fill and repainting the map.
//
// The packing trick is the fog's, for the fog's reason: a filled dungeon room is
// a few thousand cells, and a `fillRect` per cell per frame is a slideshow.
//
// The flood fill is here too, at the bottom, because it is what *produces* one of
// these. It runs on this side rather than the server's, which is the one
// structural decision in this file — see `fillFrom`.
//
// Read `docs/fog.md` before changing any of it.

import type { GridSpec, Rect, Vec2 } from './coords.js';
import type { FogPaint, WireOverrides } from './protocol.js';
import type { Wall } from './walls.js';

/** No override — the hole in the rectangle, and the only state with no colour. */
const AUTO = '-';

/**
 * What each brush paints, at full strength. The renderer fades the whole layer
 * rather than these being pre-faded, so opening the fog tab does not rebuild the
 * canvas — it changes one `globalAlpha`.
 *
 * Three hues rather than three alphas of one, because the DM is being asked to
 * tell them apart at a glance on a board that already has a grid, walls, auras
 * and a fog wash on it. Warm for the two that give something to the table, cold
 * for the one that takes it away.
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
 * Built once per `overrides_changed` rather than per frame, which is the whole
 * reason this is a type and not a bare `WireOverrides`.
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
 *  the fog tab is open and they are actually painting.
 *
 *  The same bargain masonry makes — drawn always, faint until the editor is
 *  armed — and for the same reason. A DM mid-fight wants to know a room is
 *  blacked out; they do not want their board wearing it. */
export const OVERRIDE_ALPHA = { idle: 0.15, armed: 0.4 } as const;

/** Builds the drawable override layer from a frame off the wire. */
export function overridesFromWire(wire: WireOverrides): Overrides {
  const layer: Overrides = { x: wire.x, y: wire.y, w: wire.w, h: wire.h, tint: null };
  if (wire.w === 0 || wire.h === 0) return layer;

  const canvas = document.createElement('canvas');
  canvas.width = wire.w;
  canvas.height = wire.h;
  const ctx = canvas.getContext('2d');
  // Unavailable only in a browser that cannot draw the board either. Returning
  // the layer without one leaves the DM's own annotation undrawn, which costs
  // them a hint and costs the table nothing — this is not a filter.
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

/** The rectangle the tint covers, in world pixels. `fogRect`'s twin. */
export function overrideRect(
  layer: Overrides,
  grid: GridSpec,
): { x: number; y: number; w: number; h: number } {
  return {
    x: grid.offsetX + layer.x * grid.px,
    y: grid.offsetY + layer.y * grid.px,
    w: layer.w * grid.px,
    h: layer.h * grid.px,
  };
}

/** The colour a brush paints in, for the panel's own swatches and for the fill
 *  preview — so the preview is drawn in the colour the commit will land in. */
export function paintColor(paint: FogPaint | null): string {
  const glyph = paint === 'explored' ? 'o' : paint === 'lit' ? '*' : paint === 'dark' ? '#' : '';
  const rgb = PAINT[glyph];
  // Handing cells back has no colour of its own, so the preview for it is drawn
  // in a neutral one — there is nothing to show the result *as*.
  return rgb === undefined ? 'rgb(180, 186, 198)' : `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/**
 * Every cell reachable from `seed` without crossing anything the DM traced.
 *
 * **The fill runs here and the command carries the cells it found.** That is the
 * one structural decision in this file and it is worth the paragraph. The DM's
 * client already holds the walls, and it has to compute this anyway to draw the
 * preview — so sending the previewed cells makes the preview and the result *the
 * same object* rather than two runs of two implementations that would have to
 * agree. Nothing is being adjudicated: the DM may reveal whatever they like, so
 * the server has no answer of its own to defend, only a size to bound and a board
 * to clip against.
 *
 * It is deliberately **not** the raycast written twice. That asks whether a
 * viewer can see a cell; this asks whether two cells are connected. They consult
 * the same walls and are different questions, and a fill that squeezes through a
 * gap the DM traced badly is exactly what the preview exists to show them before
 * they commit. One click through a missed gap otherwise reveals the whole dungeon
 * and there is no undo.
 *
 * **Doors are where the two questions part company, and every traced segment
 * bounds a fill whether it is open or not.** A door borrowed the raycast's answer
 * once and it was wrong twice over. A dungeon traced for sight leaves its
 * archways open on purpose, so a fill of any room reached through one escapes
 * into the whole connected map — and worse, a room that filled cleanly stopped
 * filling the moment the party swung its door, which made the region a click
 * selects depend on play-time state that has nothing to do with which cells make
 * up the room. So an open door blocks nothing the party does and still bounds
 * this, which makes an archway traceable as a boundary without blinding anyone
 * standing in it. The cost is that a room plus the corridor past its open door is
 * two clicks, and that is the conservative side again: a fill that stops short is
 * a second click, one that escapes is a repaint.
 *
 * Four-neighbour rather than eight, which is the conservative reading: a wall
 * traced corner to corner leaves a diagonal a fill would otherwise leak through,
 * and a fill that stops short is a second click, while one that escapes is a
 * repaint.
 */
export function fillFrom(
  seed: Vec2,
  walls: readonly Wall[],
  grid: GridSpec,
  /** The play area in image pixels, or the whole image. Nothing outside it is
   *  somewhere the party can be, which is the same bound the server clips to. */
  board: Rect,
  /** Where to give up. Matches `MAX_OVERRIDE_CELLS` on the server, which refuses
   *  anything past it — stopping here means the DM sees a fill that plainly ran
   *  away rather than a command that comes back as an error. */
  limit: number,
): number[] {
  const centre = (cx: number, cy: number): Vec2 => ({
    x: grid.offsetX + (cx + 0.5) * grid.px,
    y: grid.offsetY + (cy + 0.5) * grid.px,
  });
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
      for (const [dx, dy] of NEIGHBOURS) {
        const to = { x: cell.x + dx, y: cell.y + dy };
        const id = key(to.x, to.y);
        if (seen.has(id)) continue;
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

/** A cell as one number, so the visited set is a `Set<number>` rather than a set
 *  of strings. The board is bounded well inside this. */
function key(x: number, y: number): number {
  return (x + 65536) * 262144 + (y + 65536);
}

/**
 * Which walls could possibly bound a step out of each cell.
 *
 * Every one of them, doors included and whatever they are swung to — see
 * `fillFrom` for why this is the one place a door's state is not read.
 *
 * Without this the fill is every cell times every wall — a few thousand cells
 * against a few hundred segments, four times over, recomputed as the pointer
 * crosses into a new cell. Registering each segment into the cells it passes
 * through and their neighbours makes each step a lookup instead of a scan, and it
 * is total: the line between two adjacent cell centres stays inside those two
 * cells, so anything crossing it passes through one of them.
 */
function index(walls: readonly Wall[], grid: GridSpec): Map<number, Wall[]> {
  const buckets = new Map<number, Wall[]>();

  for (const wall of walls) {
    const dx = wall.to.x - wall.from.x;
    const dy = wall.to.y - wall.from.y;
    // Half a cell at a time, so no cell the segment passes through is skipped.
    const steps = Math.ceil((Math.hypot(dx, dy) / grid.px) * 2) + 1;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.floor((wall.from.x + dx * t - grid.offsetX) / grid.px);
      const cy = Math.floor((wall.from.y + dy * t - grid.offsetY) / grid.px);
      // And its eight neighbours: a wall running exactly along a cell boundary —
      // which `snapToCorner` makes the common case — belongs to the cells on
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
 * The same shape as `crosses` in `fog.rs`, and it does not have to agree with it
 * exactly — this is a selection gesture rather than a visibility rule, and
 * whatever it decides is what the DM sees in the preview and commits or does not.
 * Written the same way anyway, so a fill stops where the DM's intuition from
 * watching the fog says it should.
 *
 * **The one place it deliberately disagrees is a tie at the step's own ends**, and
 * that is the second thing 16b got wrong. The raycast is permissive there so a
 * creature standing on a wall is not blinded by it, and this copied the rule
 * without the creature. It has none: a step is not a viewer, and a cell whose
 * centre sits exactly on a wall let the fill walk in from one side and straight
 * out of the other, because *every* step touching that cell ties. One such cell
 * is a hole in the wall, and a hole is the whole map.
 *
 * Corner-snapped masonry cannot produce one — a wall on the corner lattice runs
 * between cell centres, never through them. **A wall at 45 degrees runs through
 * them every other cell**, which is what a chamfered room corner is made of, so
 * this is systematic on exactly the maps that look most carefully traced.
 *
 * A cell the wall passes through is genuinely half in and half out, and no single
 * answer for it is right — so it is neither side's, and the fill leaves it alone.
 * That costs a ragged cell at each chamfer, which is a click of the paint brush;
 * the other answer costs the dungeon.
 */
function crosses(p: Vec2, q: Vec2, a: Vec2, b: Vec2): boolean {
  const side = (u: Vec2, v: Vec2, w: Vec2): number =>
    (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);

  const d1 = side(a, b, p);
  const d2 = side(a, b, q);
  // `within` because the tie can be anywhere on the wall's infinite line, and a
  // cell centre level with a wall thirty feet away is not touching it.
  if (d1 === 0 || d2 === 0) {
    return (d1 === 0 && within(a, b, p)) || (d2 === 0 && within(a, b, q));
  }
  if (d1 > 0 === d2 > 0) return false;

  const d3 = side(p, q, a);
  const d4 = side(p, q, b);
  if (d3 === 0) return within(p, q, a);
  if (d4 === 0) return within(p, q, b);
  return d3 > 0 !== d4 > 0;
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

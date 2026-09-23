// Turning a box the DM dragged across the map into a grid.
//
// The one part of calibration that is arithmetic, not DOM or canvas, so it
// lives apart from both and can be read on its own.

import type { GridSpec, Rect } from './coords.js';
import { squareGrid } from './coords.js';

/** A drag rectangle in world units. Corners in whichever order they were dragged. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Mirrors the bounds room.rs enforces. The server is still the authority. */
export const MIN_GRID_PX = 4;
export const MAX_GRID_PX = 4096;
/** Nobody calibrates across more than a few dozen squares, and the renderer
 *  draws a division line per cell. */
export const MAX_CELLS = 200;
/** How far from square an isometric diamond may be: its width over its height.
 *  Mirrors `MIN_GRID_RATIO`/`MAX_GRID_RATIO` in room.rs; the server is still the
 *  authority. `2.0` is the common projection and sits well inside them. */
export const MIN_GRID_RATIO = 0.25;
export const MAX_GRID_RATIO = 4;

/**
 * The proportions the fixed isometric gesture pins a diamond to: twice as wide
 * as it is tall.
 *
 * Almost every isometric tileset is drawn on it, so on that art the DM
 * shouldn't have to aim at the ratio; only the size is in question. The other
 * standard is true isometric, a projected cube with edges at 30° and a ratio
 * of √3; that is what a rendered map gives you, not what the art this table
 * plays on is drawn on. One preset, because a second one nobody picks is a
 * menu.
 */
export const STANDARD_RATIO = 2;

/**
 * Which lattice a drag is being read as.
 *
 * The two isometric entries are one gesture (a cell edge, corner to
 * corner), differing only in whether the diamond's proportions are read off
 * the drag or pinned to `STANDARD_RATIO`. `iso-fixed` produces an ordinary
 * `Iso { ratio }`, and nothing downstream of `gridFromEdge` can tell which of
 * the two made it.
 */
export type CalShape = 'square' | 'iso' | 'iso-fixed';
/** The shapes the edge gesture covers, which is both isometric ones. */
export type IsoShape = Exclude<CalShape, 'square'>;

/**
 * What input.ts and render.ts need from the calibration tool. Both hold it
 * read-only; only the tool itself changes any of this.
 */
export interface Calibration {
  /** Calibrate mode is on, so a left-drag on the canvas draws a reference box. */
  readonly active: boolean;
  /** The box on screen: being dragged, or kept afterwards for tuning. */
  readonly box: Box | null;
  /** How many whole squares the DM says that box spans. Square gesture only. */
  readonly cells: number;
  /** Which gesture is being made, so the overlay can draw the right thing: a
   *  box of squares, or the one diamond an edge describes. */
  readonly shape: CalShape;
  /** Pointer moved mid-drag. */
  drag(box: Box): void;
  /**
   * The DM let go. Not a commit: the box is kept so the cell count can be
   * corrected against it, and nothing is sent until the DM applies.
   */
  release(box: Box): void;
}

/**
 * Derives a grid from a box dragged across `cells` whole squares.
 *
 * Only the width sets the cell size: cells are square, and asking for one count
 * instead of two saves the DM from having to drag an exact rectangle. The box's
 * top edge still anchors the vertical offset, so a box one square tall
 * calibrates y correctly.
 *
 * Returns null, not a nonsense grid, when the drag was too small to have
 * meant anything, which is what a stray click looks like.
 */
export function gridFromBox(box: Box, cells: number): GridSpec | null {
  if (!Number.isInteger(cells) || cells < 1 || cells > MAX_CELLS) return null;

  const px = Math.abs(box.x1 - box.x0) / cells;
  if (!Number.isFinite(px) || px < MIN_GRID_PX || px > MAX_GRID_PX) return null;

  const grid = squareGrid(px);
  const corner = anchor(grid, Math.min(box.x0, box.x1), Math.min(box.y0, box.y1));
  return { ...grid, offsetX: corner.x, offsetY: corner.y };
}

/**
 * The half-width and half-height of the diamond a drag describes.
 *
 * The one place the two isometric gestures differ, and the only place the
 * ratio is decided. `gridFromEdge` builds the lattice from this and
 * `drawCalibrationDiamond` draws it, so the diamond the DM is aiming and the
 * diamond that gets committed come from the same call, not from two functions
 * that have to agree.
 *
 * Free reads the drag as-is: it runs from a diamond's top corner to one of its
 * side corners, so it spans half the width and half the height. Which side
 * corner doesn't matter: the sign is dropped, and a drag up-left describes the
 * same lattice as a drag down-right.
 *
 * **Fixed keeps the ratio and takes only the size from the drag**, by
 * projecting it onto the edge that ratio describes. That is the least-squares
 * fit of the drag to the locked direction, so a drag along a tile edge gives
 * that tile and one a few pixels off gives the same tile, not a lattice a few
 * percent out. That matters because 3% out on the ratio is a cell and a half
 * of drift twenty cells later. Both components are used, because half a tile
 * height is the smaller and harder-to-aim of the two, and reading the size off
 * it alone would throw away the better half of the gesture.
 *
 * `cells` is how many diamonds the drag ran along, the edge gesture's version
 * of the count the square path asks for with its box: it is often easier to
 * trace the whole edge of a room and say how many tiles that was than to aim
 * at one tile and have the answer replicate across the map. It only divides:
 * both readings below are linear in the drag, so dividing the vector once here
 * is the same as dividing the cell afterwards.
 *
 * Null for a degenerate drag or an invalid count, which is what a stray click
 * looks like. Both gestures require both components, not just the one fixed
 * needs: they are the same gesture, so a horizontal swipe is as much a slip on
 * one as on the other.
 */
export function isoDiamond(
  box: Box,
  shape: IsoShape,
  cells = 1,
): { halfW: number; halfH: number } | null {
  if (!Number.isInteger(cells) || cells < 1 || cells > MAX_CELLS) return null;

  const dx = Math.abs(box.x1 - box.x0) / cells;
  const dy = Math.abs(box.y1 - box.y0) / cells;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx <= 0 || dy <= 0) return null;

  if (shape === 'iso') return { halfW: dx, halfH: dy };

  const r = STANDARD_RATIO;
  const halfH = (dx * r + dy) / (r * r + 1);
  return { halfW: halfH * r, halfH };
}

/**
 * Derives an isometric grid from one edge of one diamond, dragged corner to
 * corner.
 *
 * **One drag, not two.** Real isometric art is symmetric about vertical, so
 * the second axis is this one mirrored and a second gesture would add nothing.
 * It also means the drag is the same drag the square path already sends:
 * `input.ts` hands over a box either way, and this reads it as a vector where
 * `gridFromBox` reads it as a rectangle, so the canvas side needs nothing
 * extra.
 *
 * `isoDiamond` reads the diamond from the drag (including how many of them it
 * ran along), and that is also what the overlay draws; this turns that one
 * diamond into a lattice. So neither the fixed gesture nor the count needs
 * anything here: both produce an `Iso { ratio }` like any other, and the
 * bounds below still get the last word.
 *
 * Null for a drag too small or too lopsided to have meant anything, which is
 * what a stray click looks like. Same rule as `gridFromBox`, against bounds the
 * server enforces again.
 */
export function gridFromEdge(box: Box, shape: IsoShape = 'iso', cells = 1): GridSpec | null {
  const diamond = isoDiamond(box, shape, cells);
  if (diamond === null) return null;
  const { halfW, halfH } = diamond;

  const px = halfH * 2;
  if (px < MIN_GRID_PX || px > MAX_GRID_PX) return null;

  const ratio = halfW / halfH;
  if (ratio < MIN_GRID_RATIO || ratio > MAX_GRID_RATIO) return null;

  const grid: GridSpec = {
    px,
    ax: halfW,
    ay: halfH,
    bx: -halfW,
    by: halfH,
    offsetX: 0,
    offsetY: 0,
  };
  // Anchored on the corner the drag started from, which is a lattice point
  // because it is the corner of a diamond the DM pointed at.
  const corner = anchor(grid, box.x0, box.y0);
  return { ...grid, offsetX: corner.x, offsetY: corner.y };
}

/**
 * The play area a box describes: the box itself, with its height rounded to a
 * whole number of cells.
 *
 * The width needs no rounding (`gridFromBox` divided it by the cell count, so
 * it is already an exact multiple), and the left and top edges fall on grid
 * lines because the offsets were derived from them. Only the height is
 * arbitrary, and a play area ending halfway down a row of squares looks like a
 * mistake.
 */
export function playAreaFromBox(box: Box, grid: GridSpec): Rect {
  const rows = Math.max(1, Math.round(Math.abs(box.y1 - box.y0) / grid.px));
  return {
    x: Math.min(box.x0, box.x1),
    y: Math.min(box.y0, box.y1),
    w: Math.abs(box.x1 - box.x0),
    h: rows * grid.px,
  };
}

/**
 * A lattice point reduced into the cell at the origin.
 *
 * The grid repeats, so every cell corner describes the same set of overlay
 * lines; keeping the offset inside one cell makes it a number the DM can glance
 * at and sanity-check. On a square grid this is `value % px` on each axis, held
 * in `[0, px)`. Plain `%` keeps the sign of the dividend and would hand back a
 * negative offset for a box dragged off the left edge of the map; taking the
 * fractional part below avoids that on either lattice.
 */
function anchor(grid: GridSpec, x: number, y: number): { x: number; y: number } {
  const det = grid.ax * grid.by - grid.ay * grid.bx;
  if (det === 0) return { x, y };
  // Where the point falls in cells, with no offset applied yet, and then just
  // the part of that inside its own cell.
  const gx = (x * grid.by - y * grid.bx) / det;
  const gy = (y * grid.ax - x * grid.ay) / det;
  const fx = gx - Math.floor(gx);
  const fy = gy - Math.floor(gy);
  return { x: fx * grid.ax + fy * grid.bx, y: fx * grid.ay + fy * grid.by };
}

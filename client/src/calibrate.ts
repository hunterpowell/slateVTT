// Turning a box the DM dragged across the map into a grid.
//
// The one part of calibration that is arithmetic rather than DOM or canvas, so
// it lives apart from both and can be read on its own.

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
/** How far from square an isometric diamond may be — its width over its height.
 *  Mirrors `MIN_GRID_RATIO`/`MAX_GRID_RATIO` in room.rs; the server is still the
 *  authority. `2.0` is the common projection and sits well inside them. */
export const MIN_GRID_RATIO = 0.25;
export const MAX_GRID_RATIO = 4;

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
  readonly shape: 'square' | 'iso';
  /** Pointer moved mid-drag. */
  drag(box: Box): void;
  /**
   * The DM let go. Deliberately not a commit: the box is kept so the cell count
   * can be corrected against it, and nothing is sent until the DM applies.
   */
  release(box: Box): void;
}

/**
 * Derives a grid from a box dragged across `cells` whole squares.
 *
 * Only the width sets the cell size: cells are square, and asking for one count
 * rather than two saves the DM from having to drag an exact rectangle. The
 * height is not wasted, though — the box's top edge anchors the vertical
 * offset, so a box one square tall still calibrates y correctly.
 *
 * Returns null rather than a nonsense grid when the drag was too small to have
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
 * Derives an isometric grid from one edge of one diamond, dragged corner to
 * corner.
 *
 * **One drag and not two.** Real isometric art is symmetric about vertical, so
 * the second axis is this one mirrored and there is nothing for a second gesture
 * to say. It also means the drag is the same drag the square path already sends
 * — `input.ts` hands over a box either way, and this reads it as a vector where
 * `gridFromBox` reads it as a rectangle, so the gesture cost nothing on the
 * canvas side.
 *
 * The dragged edge runs from a diamond's top corner to one of its side corners,
 * so it spans half the width and half the height: a cell is `2 * |dy|` tall and
 * `2 * |dx|` wide. Which side corner does not matter — the sign is dropped, and
 * a drag up-left describes the same lattice as a drag down-right.
 *
 * Null for a drag too small or too lopsided to have meant anything, which is
 * what a stray click looks like — `gridFromBox`'s rule, against bounds the
 * server enforces again.
 */
export function gridFromEdge(box: Box): GridSpec | null {
  const halfW = Math.abs(box.x1 - box.x0);
  const halfH = Math.abs(box.y1 - box.y0);
  if (!Number.isFinite(halfW) || !Number.isFinite(halfH)) return null;
  if (halfW <= 0 || halfH <= 0) return null;

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
  // Anchored on the corner the drag started from, which is a lattice point by
  // construction: it is the corner of a diamond the DM pointed at.
  const corner = anchor(grid, box.x0, box.y0);
  return { ...grid, offsetX: corner.x, offsetY: corner.y };
}

/**
 * The play area a box describes: the box itself, with its height rounded to a
 * whole number of cells.
 *
 * The width needs no rounding — `gridFromBox` divided it by the cell count, so
 * it is already an exact multiple — and the left and top edges fall on grid
 * lines by construction, since the offsets were derived from them. Only the
 * height is arbitrary, and a play area ending halfway down a row of squares
 * looks like a mistake.
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
 * in `[0, px)` — plain `%` keeps the sign of the dividend and would hand back a
 * negative offset for a box dragged off the left edge of the map, and taking the
 * fractional part below is what avoids that on either lattice.
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

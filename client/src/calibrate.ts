// Turning a box the DM dragged across the map into a grid.
//
// The one part of calibration that is arithmetic rather than DOM or canvas, so
// it lives apart from both and can be read on its own.

import type { GridSpec, Rect } from './coords.js';

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

/**
 * What input.ts and render.ts need from the calibration tool. Both hold it
 * read-only; only the tool itself changes any of this.
 */
export interface Calibration {
  /** Calibrate mode is on, so a left-drag on the canvas draws a reference box. */
  readonly active: boolean;
  /** The box on screen: being dragged, or kept afterwards for tuning. */
  readonly box: Box | null;
  /** How many whole squares the DM says that box spans. */
  readonly cells: number;
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

  return {
    px,
    offsetX: wrap(Math.min(box.x0, box.x1), px),
    offsetY: wrap(Math.min(box.y0, box.y1), px),
  };
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
 * Into [0, px). The grid repeats, so every cell corner describes the same set of
 * overlay lines; keeping the offset small makes it a number the DM can glance
 * at and sanity-check. Plain `%` would keep the sign of the dividend and hand
 * back a negative offset for a box dragged off the left edge of the map.
 */
function wrap(value: number, px: number): number {
  return ((value % px) + px) % px;
}

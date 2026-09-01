// Every coordinate conversion in the client lives in this file. Nothing else
// multiplies by zoom, adds a camera offset, or divides by grid size.
//
// Three spaces, in order of derivation:
//
//   screen  CSS pixels, origin at the canvas top-left. What pointer events speak.
//   world   map-image pixels, origin at the map's top-left. What we render in.
//   grid    map squares. What a token's position is *stored* in — see invariant 1.
//
// Device pixel ratio is deliberately absent here. It is folded into the canvas
// transform in render.ts and nowhere else, so `screen` is always CSS pixels.

export interface Vec2 {
  x: number;
  y: number;
}

/** `x`/`y` are the world point at the viewport's top-left corner. `zoom` is screen px per world px. */
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}

/**
 * Where the map's grid sits in world space, and what shape its cells are.
 *
 * **The two axes are the whole of the shape.** A square grid is `(px, 0)` and
 * `(0, px)`; an isometric one is a diamond's two half-diagonals. Everything
 * downstream places things through `gridToWorld`, so nothing but this file and
 * `gridBasis` in `scene.ts` knows there is more than one kind of lattice.
 *
 * `px` is carried alongside rather than derived at each use, and it is the
 * server's `grid_px`: **the size of a cell, for sizing things that stand on the
 * grid — never for placing them.** A token's diameter and the zoom at which the
 * grid's halo is worth drawing are what it is for. Anything that computes a
 * *position* from it is assuming squares.
 */
export interface GridSpec {
  px: number;
  /** Where cell `(1, 0)` falls, relative to the origin, in world pixels. */
  ax: number;
  ay: number;
  /** Where cell `(0, 1)` falls. */
  bx: number;
  by: number;
  offsetX: number;
  offsetY: number;
}

/** An axis-aligned rectangle in world units. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The playable region as actual numbers, clipped to the image.
 *
 * `null` means the whole image — the server cannot say it any other way, since
 * it never sees the image. Clipping is not cosmetic: the renderer rules one
 * grid line per cell across this rectangle, so a stale or oversized one from a
 * save would otherwise cost frames.
 */
export function playRect(area: Rect | null, mapW: number, mapH: number): Rect {
  if (area === null) return { x: 0, y: 0, w: mapW, h: mapH };

  const x = Math.max(0, area.x);
  const y = Math.max(0, area.y);
  return {
    x,
    y,
    w: Math.max(0, Math.min(mapW, area.x + area.w) - x),
    h: Math.max(0, Math.min(mapH, area.y + area.h) - y),
  };
}

export function screenToWorld(cam: Camera, sx: number, sy: number): Vec2 {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): Vec2 {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

/**
 * A square grid — the shape every map had before there were two, and still the
 * default. Named so that a square lattice is a thing said out loud rather than
 * four numbers a reader has to recognise.
 */
export function squareGrid(px: number, offsetX = 0, offsetY = 0): GridSpec {
  return { px, ax: px, ay: 0, bx: 0, by: px, offsetX, offsetY };
}

export function gridToWorld(grid: GridSpec, gx: number, gy: number): Vec2 {
  return {
    x: grid.offsetX + gx * grid.ax + gy * grid.bx,
    y: grid.offsetY + gx * grid.ay + gy * grid.by,
  };
}

export function worldToGrid(grid: GridSpec, wx: number, wy: number): Vec2 {
  const det = grid.ax * grid.by - grid.ay * grid.bx;
  // Non-zero for any grid the server would accept: `grid_px` is bounded away
  // from zero and so is an isometric ratio. Answering the origin rather than
  // `NaN` keeps a degenerate grid a visible bug instead of a silent one that
  // poisons every downstream number.
  if (det === 0) return { x: 0, y: 0 };
  const dx = wx - grid.offsetX;
  const dy = wy - grid.offsetY;
  return {
    x: (dx * grid.by - dy * grid.bx) / det,
    y: (dy * grid.ax - dx * grid.ay) / det,
  };
}

/**
 * The canvas transform that puts the renderer in grid space, as the six numbers
 * `ctx.transform` takes.
 *
 * Drawing a cell is then `ctx.rect(cx, cy, 1, 1)` — one unit square per cell,
 * sheared into the right parallelogram by the matrix — which is why the fog, the
 * override paint, the shape fills and the ruler's trail got *shorter* when the
 * lattice stopped being square. A per-cell bitmap `drawImage`d under it lands
 * exactly right for the same reason.
 *
 * Two things do not survive the transform: `lineWidth` is in transformed units,
 * so strokes belong outside it, and so does any text.
 */
export function gridTransform(grid: GridSpec): [number, number, number, number, number, number] {
  return [grid.ax, grid.ay, grid.bx, grid.by, grid.offsetX, grid.offsetY];
}

/**
 * The shortest a cell can measure in world pixels.
 *
 * What a step size or a legibility threshold wants, as against `px`, which is
 * what a *creature* is sized by. On a square grid the two are the same number,
 * which is why nothing needed to tell them apart before.
 */
export function minSpan(grid: GridSpec): number {
  return Math.min(Math.hypot(grid.ax, grid.ay), Math.hypot(grid.bx, grid.by));
}

/**
 * The furthest one cell of grid distance can reach in world pixels.
 *
 * `px_per_cell` in `server/src/fog.rs` is its twin, and both exist for the same
 * caller: a wall further from the eye than `n` cells cannot be crossed by a ray
 * `n` cells long, whichever direction it is cast, so this is what a once-per-
 * source wall cull bounds itself by. On a square grid it is `px`, which is what
 * keeps those culls dropping exactly the walls they always did.
 *
 * The largest singular value of the basis. Not `|u| + |v|`, which is also safe
 * and is looser — on a square grid that would be `2 * px` and would quietly
 * halve the culling on every map in the project.
 */
export function maxSpan(grid: GridSpec): number {
  const frobenius = grid.ax ** 2 + grid.ay ** 2 + grid.bx ** 2 + grid.by ** 2;
  const det = Math.abs(grid.ax * grid.by - grid.ay * grid.bx);
  // Zero for a square grid and non-negative for any basis; the clamp is float
  // slop rather than a real case.
  const gap = Math.max(0, frobenius ** 2 - 4 * det ** 2);
  return Math.sqrt((frobenius + Math.sqrt(gap)) / 2);
}

/**
 * How far a world-space rectangle reaches in grid units: the bounding box of its
 * four corners, in grid space, **unrounded**.
 *
 * On a square grid this is the rectangle's own edges divided through. On a
 * sheared one the two spaces disagree about which way is along, and taking the
 * corners is what says how far it actually reaches. Callers clip or test against
 * the rectangle itself afterwards, so an over-estimate costs nothing.
 *
 * Deliberately not rounded here, because its two callers round differently and
 * conflating them is a bug rather than a tidy-up. Ruling the grid wants the
 * whole-numbered *lines* inside the rectangle, so it rounds inward — `ceil` the
 * low end, `floor` the high. Sweeping cells wants every cell the rectangle
 * *touches*, so it floors both ends: the cell containing the low edge is
 * partly inside, and dropping it takes a column off one side of the viewer and
 * not the other.
 */
export function gridBounds(
  grid: GridSpec,
  area: Rect,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  const corners = [
    worldToGrid(grid, area.x, area.y),
    worldToGrid(grid, right, area.y),
    worldToGrid(grid, area.x, bottom),
    worldToGrid(grid, right, bottom),
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

// Snapping to the nearest cell centre deliberately does NOT live here. The
// server applies it on the drop frame and echoes the settled position back;
// duplicating the rule in TypeScript would let the two drift apart.

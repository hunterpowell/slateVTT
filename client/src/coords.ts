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

/** Where the map's grid sits in world space. Milestone 6 makes this editable. */
export interface GridSpec {
  px: number;
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

/** The first grid line at or after `from`. */
export function firstLineAt(from: number, offset: number, px: number): number {
  return offset + Math.ceil((from - offset) / px) * px;
}

export function screenToWorld(cam: Camera, sx: number, sy: number): Vec2 {
  return { x: sx / cam.zoom + cam.x, y: sy / cam.zoom + cam.y };
}

export function worldToScreen(cam: Camera, wx: number, wy: number): Vec2 {
  return { x: (wx - cam.x) * cam.zoom, y: (wy - cam.y) * cam.zoom };
}

export function gridToWorld(grid: GridSpec, gx: number, gy: number): Vec2 {
  return { x: grid.offsetX + gx * grid.px, y: grid.offsetY + gy * grid.px };
}

export function worldToGrid(grid: GridSpec, wx: number, wy: number): Vec2 {
  return { x: (wx - grid.offsetX) / grid.px, y: (wy - grid.offsetY) / grid.px };
}

// Snapping to the nearest cell centre deliberately does NOT live here. The
// server applies it on the drop frame and echoes the settled position back;
// duplicating the rule in TypeScript would let the two drift apart.

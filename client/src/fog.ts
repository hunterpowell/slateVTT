// Fog of war, on the reading side.
//
// The server decides everything here: which cells the party can see, which they
// have explored, and — separately, through the tokens it simply does not send —
// who is standing in them. **Nothing in this file is a visibility decision.** A
// creature the table cannot see is absent from `scene.tokens` rather than drawn
// and painted over, because painting over it would put the data on the client
// and invariant 4 is about what a client may *know*.
//
// What this file does is turn a packed string into something a renderer can draw
// in one call. That matters more than it sounds: a fogged board is a few thousand
// cells, and a `fillRect` per cell per frame is a slideshow. The answer is a
// canvas one pixel per cell, painted when the fog changes and stretched over the
// board every frame — so the per-frame cost is a single `drawImage` whatever the
// dungeon looks like.
//
// Read `docs/fog.md` before changing how any of that works.

import type { GridSpec } from './coords.js';
import type { WireFog } from './protocol.js';

/** Never seen, and drawn solid. Also every cell outside the packed rectangle. */
const DARK = '#';
/** Explored, not in sight now. The map is remembered; who is on it is not. */
const KNOWN = 'o';

/**
 * The fog as this client holds it: the server's rectangle, plus the little
 * canvas built from it.
 *
 * The canvas is built once per `fog_changed` rather than per frame, which is the
 * whole reason this is a type and not a bare `WireFog`.
 */
export interface Fog {
  /** Cell coordinates of the rectangle's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * One pixel per cell, already carrying the alpha each state should draw at.
   *
   * Null when the rectangle is empty, which is what an unexplored map packs to —
   * there is nothing to stretch, and the caller fills the whole board instead.
   */
  shade: HTMLCanvasElement | null;
}

/**
 * How solidly each state draws, for a player and for the DM.
 *
 * The DM's board stays legible: a faint wash says "the party cannot see this"
 * without hiding the monster the DM is about to move into it. That is the same
 * bargain masonry already makes on their screen — drawn always, faint until the
 * editor is armed — and it is why the DM is sent the fog at all.
 *
 * Explored terrain is dimmed rather than hidden for both, because that is what
 * the two sets are *for*: terrain gates on what has been explored and creatures
 * gate on what is in sight, so the remembered map stays on screen and the things
 * standing on it do not.
 */
const SHADE = {
  player: { [DARK]: 1, [KNOWN]: 0.62 },
  dm: { [DARK]: 0.42, [KNOWN]: 0.18 },
} as const;

/** The colour the fog is painted in — the same void the board sits on. */
const FOG_RGB = '11, 13, 16';

/**
 * Pixels per cell in the shade canvas, which is what softens the fog edge.
 *
 * The canvas used to be one pixel per cell and was stretched with smoothing
 * *off*, so that the edge landed exactly on the cell boundary the server
 * decided. The hard line is the thing worth revisiting rather than the
 * placement: a fog edge is an approximation of where a wall is, and a crisp
 * boundary claims a precision the raycast does not have — feathering it
 * understates it instead, which is the more honest picture.
 *
 * Smoothing a one-pixel-per-cell canvas does not give that. Bilinear sampling
 * anchors on pixel *centres*, so a 1px cell stretched to fifty ramps across the
 * whole square and shifts the boundary half a cell off where the server put it,
 * which is precisely the correctness the old comment was defending. Drawing each
 * cell as a solid block first and stretching *that* keeps the boundary where it
 * belongs and confines the ramp to one sub-pixel — a quarter of a cell here.
 *
 * Four rather than two because the ramp should read as a soft edge rather than
 * as a second shade of grey, and rather than eight because this canvas is
 * rebuilt on every `fog_changed` and sixteen times the pixels buys nothing the
 * eye can find. The board is a few thousand cells; this is a few tens of
 * thousands of bytes.
 *
 * The override tint next door is deliberately *not* built this way. A fog edge
 * approximates a wall; an override edge is exactly the squares the DM clicked,
 * and softening it would misreport their own paint back to them.
 */
const SUBCELLS = 4;

/**
 * Builds the drawable fog from a frame off the wire, or null for an unfogged
 * map.
 *
 * `isDm` is baked in here rather than read at draw time because it cannot change
 * within a connection — identity is settled by the Welcome frame and dies with
 * the socket — so the choice belongs where the canvas is built.
 */
export function fogFromWire(wire: WireFog | null, isDm: boolean): Fog | null {
  if (wire === null) return null;

  const fog: Fog = { x: wire.x, y: wire.y, w: wire.w, h: wire.h, shade: null };
  if (wire.w === 0 || wire.h === 0) return fog;

  const canvas = document.createElement('canvas');
  canvas.width = wire.w * SUBCELLS;
  canvas.height = wire.h * SUBCELLS;
  const ctx = canvas.getContext('2d');
  // A context is only ever unavailable in a browser that cannot draw the board
  // either. Returning the fog without one leaves the caller filling the whole
  // board dark, which fails closed.
  if (ctx === null) return fog;

  const alpha = isDm ? SHADE.dm : SHADE.player;
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let cy = 0; cy < wire.h; cy++) {
    for (let cx = 0; cx < wire.w; cx++) {
      const cell = wire.cells[cy * wire.w + cx] ?? DARK;
      // Anything that is neither dark nor explored is in sight, and in sight is
      // clear. Written this way round so an unknown character fails towards
      // showing the board rather than towards a black rectangle nobody can
      // explain.
      const a = cell === DARK ? alpha[DARK] : cell === KNOWN ? alpha[KNOWN] : 0;
      const value = Math.round(a * 255);
      // One solid block per cell, so the ramp the stretch adds lands between
      // blocks rather than across a whole square. See `SUBCELLS`.
      for (let sy = 0; sy < SUBCELLS; sy++) {
        const row = (cy * SUBCELLS + sy) * canvas.width;
        for (let sx = 0; sx < SUBCELLS; sx++) {
          const i = (row + cx * SUBCELLS + sx) * 4;
          image.data[i] = 11;
          image.data[i + 1] = 13;
          image.data[i + 2] = 16;
          image.data[i + 3] = value;
        }
      }
    }
  }
  ctx.putImageData(image, 0, 0);

  fog.shade = canvas;
  return fog;
}

/** The wash covering every cell outside the packed rectangle. */
export function darkFill(isDm: boolean): string {
  return `rgba(${FOG_RGB}, ${isDm ? SHADE.dm[DARK] : SHADE.player[DARK]})`;
}

/** The rectangle the fog canvas covers, in world pixels. */
export function fogRect(fog: Fog, grid: GridSpec): { x: number; y: number; w: number; h: number } {
  return {
    x: grid.offsetX + fog.x * grid.px,
    y: grid.offsetY + fog.y * grid.px,
    w: fog.w * grid.px,
    h: fog.h * grid.px,
  };
}

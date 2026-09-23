// Fog of war, on the reading side.
//
// The server decides everything here: which cells the party can see, which they
// have explored, and (separately, through the tokens it doesn't send) who is
// standing in them. **Nothing in this file is a visibility decision.** A
// creature the table can't see is absent from `scene.tokens`, not drawn and
// painted over, because painting over it would put the data on the client and
// invariant 4 is about what a client may *know*.
//
// This file turns a packed string into something a renderer can draw in one
// call. That matters: a fogged board is a few thousand cells, and a `fillRect`
// per cell per frame is a slideshow. Instead a small canvas (a few pixels per
// cell, see `SUBCELLS`) is painted when the fog changes and stretched over the
// board every frame, so the per-frame cost is a single `drawImage` whatever the
// dungeon looks like.
//
// Read `docs/fog.md` before changing how any of that works.

import type { WireFog } from './protocol.js';

/** Never seen, and drawn solid. Also every cell outside the packed rectangle. */
const DARK = '#';
/** Explored, not in sight now. The map is remembered; who is on it is not. */
const KNOWN = 'o';

/**
 * The fog as this client holds it: the server's rectangle, plus the little
 * canvas built from it.
 *
 * The canvas is built once per `fog_changed`, not per frame, which is why this
 * is a type and not a bare `WireFog`.
 */
export interface Fog {
  /** Cell coordinates of the rectangle's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /**
   * The packed frame as it arrived, one character per cell.
   *
   * Kept after the canvas is built, because a canvas answers "how dark is this
   * square" and the DM's client also has to ask "can the table see what is
   * standing on it", a different question about the same characters.
   * `cellVisible` and `cellKnown` are the only readers; see `mirror.ts`.
   */
  cells: string;
  /**
   * `SUBCELLS` pixels per cell on each side, already carrying the alpha each
   * state should draw at.
   *
   * Null when the rectangle is empty, which is what an unexplored map packs to:
   * there is nothing to stretch, and the caller fills the whole board instead.
   */
  shade: HTMLCanvasElement | null;
  /**
   * The same cells at the *table's* strength, for the DM's player view.
   *
   * Null on a client that is already drawing at that strength. A player's own
   * fog is the table's fog, so there is nothing for them to switch to, and the
   * renderer falls back to `shade` without asking who it is drawing for. Built
   * here, not on demand, because it is built once per `fog_changed` and the
   * alternative is rebuilding a few thousand cells inside a frame.
   */
  table: HTMLCanvasElement | null;
}

/**
 * How solidly each state draws, for a player and for the DM.
 *
 * The DM's board stays legible: a faint wash says "the party can't see this"
 * without hiding the monster the DM is about to move into it. Walls make the
 * same trade on the DM's screen (always drawn, faint until the editor is
 * armed), and this is why the DM is sent the fog at all.
 *
 * Explored terrain is dimmed, not hidden, for both, because that is what the
 * two sets are *for*: terrain gates on what has been explored and creatures
 * gate on what is in sight, so the remembered map stays on screen and the
 * things standing on it don't.
 */
const SHADE = {
  player: { [DARK]: 1, [KNOWN]: 0.62 },
  dm: { [DARK]: 0.42, [KNOWN]: 0.18 },
} as const;

/** The colour the fog is painted in: the same background the board sits on. */
const FOG_RGB = '11, 13, 16';

/**
 * Pixels per cell in the shade canvas, which is what softens the fog edge.
 *
 * The edge sits on the cell boundary the server decided, but is feathered, not
 * crisp. A fog edge approximates where a wall is, and a crisp boundary claims
 * a precision the raycast doesn't have; a soft one understates it, which is
 * the more accurate picture.
 *
 * **Don't get the softness by smoothing a one-pixel-per-cell canvas.**
 * Bilinear sampling anchors on pixel *centres*, so a 1px cell stretched to
 * fifty ramps across the whole square and shifts the boundary half a cell off
 * where the server put it. Drawing each cell as a solid block first and
 * stretching *that* keeps the boundary where it belongs and confines the ramp
 * to one sub-pixel, a quarter of a cell here.
 *
 * Four, not two, because the ramp should read as a soft edge, not as a second
 * shade of grey; and not eight, because this canvas is rebuilt on every
 * `fog_changed` and sixteen times the pixels buys nothing the eye can find.
 * The board is a few thousand cells; this is a few tens of thousands of bytes.
 *
 * The override tint is *not* built this way. A fog edge approximates a wall;
 * an override edge is the squares the DM clicked, and softening it would
 * misreport their own paint back to them.
 */
const SUBCELLS = 4;

/**
 * Builds the drawable fog from a frame off the wire, or null for an unfogged
 * map.
 *
 * `isDm` is applied here, not read at draw time, because it can't change
 * within a connection (identity is settled by the Welcome frame and ends with
 * the socket), so the choice belongs where the canvas is built.
 */
export function fogFromWire(wire: WireFog | null, isDm: boolean): Fog | null {
  if (wire === null) return null;

  const fog: Fog = {
    x: wire.x,
    y: wire.y,
    w: wire.w,
    h: wire.h,
    cells: wire.cells,
    shade: null,
    table: null,
  };
  if (wire.w === 0 || wire.h === 0) return fog;

  fog.shade = shadeCanvas(wire, isDm ? SHADE.dm : SHADE.player);
  // Only for the DM, and only because they are the only client that can ask to
  // see the board the way the table does. A player switching to it would be
  // switching to what they are already looking at.
  if (isDm) fog.table = shadeCanvas(wire, SHADE.player);
  return fog;
}

/** How solidly each state draws: one of the two entries in `SHADE`. */
type Shade = (typeof SHADE)[keyof typeof SHADE];

/** The small canvas for one frame at one strength. Null when the browser
 *  can't give a context, in which case it can't draw the board either; the
 *  caller then fills the whole board dark, which fails closed. */
function shadeCanvas(wire: WireFog, alpha: Shade): HTMLCanvasElement | null {
  const canvas = document.createElement('canvas');
  canvas.width = wire.w * SUBCELLS;
  canvas.height = wire.h * SUBCELLS;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;

  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let cy = 0; cy < wire.h; cy++) {
    for (let cx = 0; cx < wire.w; cx++) {
      const cell = wire.cells[cy * wire.w + cx] ?? DARK;
      // Anything that is neither dark nor explored is in sight, and in sight is
      // clear. Written this way round so an unknown character fails towards
      // showing the board, not towards a black rectangle nobody can explain.
      const a = cell === DARK ? alpha[DARK] : cell === KNOWN ? alpha[KNOWN] : 0;
      const value = Math.round(a * 255);
      // One solid block per cell, so the ramp the stretch adds lands between
      // blocks instead of across a whole square. See `SUBCELLS`.
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
  return canvas;
}

/**
 * Which state a cell is in, for the two readers that ask about one square
 * instead of the whole picture.
 *
 * Outside the packed rectangle is dark, which is what the rectangle's own edge
 * means anyway: it is only ever as big as what has been explored.
 */
function stateAt(fog: Fog, cx: number, cy: number): string {
  const x = cx - fog.x;
  const y = cy - fog.y;
  if (x < 0 || y < 0 || x >= fog.w || y >= fog.h) return DARK;
  return fog.cells[y * fog.w + x] ?? DARK;
}

/**
 * Whether the party has sight of this cell *now*: the client's copy of
 * `visible` on the server, which is what creatures gate on.
 *
 * Written as "neither dark nor only explored", not as a test for the lit
 * character, so an unknown one fails towards visible. This decides what the
 * DM's player view hides, and a mirror that wrongly hides a creature leads the
 * DM to misread the table's board.
 */
export function cellVisible(fog: Fog, cx: number, cy: number): boolean {
  const state = stateAt(fog, cx, cy);
  return state !== DARK && state !== KNOWN;
}

/** Whether the party has ever had sight of this cell: `known` on the server,
 *  which is what terrain gates on. Fringe included: the widening happened
 *  before this was packed. */
export function cellKnown(fog: Fog, cx: number, cy: number): boolean {
  return stateAt(fog, cx, cy) !== DARK;
}

/** The wash covering every cell outside the packed rectangle. */
export function darkFill(isDm: boolean): string {
  return `rgba(${FOG_RGB}, ${isDm ? SHADE.dm[DARK] : SHADE.player[DARK]})`;
}


// Solo sight: what one creature can see, on the DM's screen and nobody else's.
//
// The DM's adjudication view: can the rogue see it. The table's fog stays
// party-shared (per-player fog is `ROADMAP.md` milestone 29); this answers the
// narrower question for one creature. Hidden behind `SOLO_SIGHT` in
// `fogtool.ts` while player view (`mirror.ts`) covers the same need.
//
// **Client-only, and nothing goes in the room.** This is a second raycast over
// data the DM's client already holds (the walls, the radius, the mode and where
// everybody is standing), so it needs no command, no event and no filter. It
// can't leak because a player's scene carries no walls, so their client could
// not compute this if it tried. `crossesWall` makes the same argument for the
// movement hint. A geometry rule may live in both languages, as `shape_covers`
// already does.
//
// Two things it does not do:
//
// - No memory. The question is what this creature's eyes reach *now*, not what
//   the party remembers, so there are two states: in sight, or dark. Nothing
//   here reads `revealed`.
// - No overrides. Folding in the DM's mask would answer "what would the table
//   be shown" instead of "what can this creature see". The DM knows what they
//   painted, and the panel's hint says which question this answers.
//
// It also does not run over a preview. Nothing raycasts a board the table
// hasn't been shown, the same rule that greys `ResetFog`. See `docs/fog.md`,
// *Solo sight*.

import type { Rect, Vec2 } from './coords.js';
import { gridBounds, gridToWorld, maxSpan, playRect } from './coords.js';
import { fillFrom } from './overrides.js';
import type { WireFog } from './protocol.js';
import type { Board, Token } from './scene.js';
import type { Wall } from './walls.js';
import { crossesWall, distanceToSegment } from './walls.js';

/** A grid cell is five feet, everywhere in this project. */
const FEET_PER_CELL = 5;

/** A ceiling for the same reason as `MAX_FILL_CELLS` in `fogtool.ts`, though a
 *  larger one: a fill that reaches it has escaped through a gap the DM traced
 *  badly, and stopping is how they see that. */
const MAX_FILL_CELLS = 50_000;

/**
 * What `token` can see on `board`, packed the way the server packs the real fog.
 *
 * A `WireFog` instead of a `Fog`, so `fogFromWire` builds the canvas. There is
 * no second rendering path to keep in step, and the wash looks the same as the
 * real fog's.
 *
 * Two states, so every cell is `#` or `.` and never `o` (see the header). The
 * rectangle is the token's reach clipped to the board, and everything outside it
 * is dark, as with the real fog's rectangle. That lets the caller fill the four
 * bands around it flat.
 *
 * Null when there is nothing to answer with: no map size to clip against, or a
 * grid that has not been calibrated.
 */
export function soloSight(
  token: Token,
  board: Board,
  walls: readonly Wall[],
  /** The map image's natural size, for a board with no play area. Read lazily,
   *  as the fog and map panels do, because the image can change under it. */
  mapSize: { w: number; h: number } | null,
): WireFog | null {
  const grid = board.grid;
  if (grid.px <= 0 || mapSize === null) return null;

  const area: Rect = playRect(board.playArea, mapSize.w, mapSize.h);
  // In cells for the reach test and in pixels for the window and the wall cull,
  // the same split as `visible_cells` on the server: a radius set in feet is a
  // whole number of cells, and the cells sitting exactly on it must land the
  // same way on both sides of the viewer.
  // This token's own light if it carries one, otherwise the map's radius. This
  // repeats `fog::Source::radius_cells` on the server, and the two have to
  // agree, or the sight check answers a different question from the fog.
  const radiusCells = (token.lightFt ?? board.visionFt) / FEET_PER_CELL;
  // `maxSpan`, not the cell size, because the pixel radius bounds the wall
  // cull, and a ray of `n` cells reaches furthest along the lattice's longest
  // axis. On a square grid the two are the same number.
  const radiusPx = radiusCells * maxSpan(grid);
  if (radiusPx <= 0) return null;

  // The viewer's centre, which is what the server casts from too. A token's
  // footprint decides whether it can be *seen*, never what it can see.
  const eye = gridToWorld(grid, token.x, token.y);

  // The reach as whole cells, then clipped to the board: the party can't be
  // past the play area, and a rectangle running off the map is characters
  // spent for nothing.
  // Both rectangles are axis-aligned in *pixels*, so each is turned into the
  // cells it reaches and the two are intersected in grid space. That stays
  // correct on an isometric grid, where the two spaces disagree about which
  // way is along.
  const reach = gridBounds(grid, {
    x: eye.x - radiusPx,
    y: eye.y - radiusPx,
    w: radiusPx * 2,
    h: radiusPx * 2,
  });
  const within = gridBounds(grid, area);
  // Floored at both ends: these are the cells each rectangle *touches*, and the
  // cell holding the low edge is half inside it. Rounding that end up instead
  // takes a column off one side of the viewer and not the other, the asymmetry
  // the circle test downstream exists to catch.
  const x0 = Math.max(Math.floor(reach.minX), Math.floor(within.minX));
  const y0 = Math.max(Math.floor(reach.minY), Math.floor(within.minY));
  const x1 = Math.min(Math.floor(reach.maxX), Math.floor(within.maxX));
  const y1 = Math.min(Math.floor(reach.maxY), Math.floor(within.maxY));

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return { x: x0, y: y0, w: 0, h: 0, cells: '' };

  const centreOf = (cx: number, cy: number): Vec2 => gridToWorld(grid, cx + 0.5, cy + 0.5);

  // Culled once per source instead of once per cell, the same bound `fog.rs`
  // takes: a wall further from the eye than the radius cannot be crossed by any
  // ray this loop casts, and `crossesWall` has no index to make the scan cheap.
  // Without the cull, six hundred cells against every segment on a traced
  // dungeon is a recompute the DM feels while dragging the creature.
  const near = walls.filter((wall) => distanceToSegment(eye, wall.from, wall.to) <= radiusPx);

  const lit = new Set<number>();
  const at = (cx: number, cy: number): number => (cy - y0) * w + (cx - x0);

  // `Dynamic`, the default mode: a cell is visible when the straight line from
  // the viewer's centre to its centre crosses no solid wall and no shut door.
  // `crossesWall` already filters to those; it is the movement hint's test and
  // matches `Wall::blocks` on the server.
  //
  // Euclidean, so the reach is a circle. It agrees with a drawn circle and not
  // with the movement ruler; `docs/fog.md` and `docs/drawings.md` both keep
  // that disagreement. A radius of light is a circle.
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (Math.hypot(cx + 0.5 - token.x, cy + 0.5 - token.y) > radiusCells) continue;
      const c = centreOf(cx, cy);
      if (crossesWall(near, eye, c)) continue;
      lit.add(at(cx, cy));
    }
  }

  // `Room` is the flood **unioned** with the rays, never the flood alone: you
  // see the whole room you are standing in, plus whatever you have a straight
  // line to. The union means an open door shows the wedge visible through it
  // instead of the whole room behind it, and this mode never shows less than
  // `Dynamic` would.
  //
  // The flood is bounded by every traced segment, open or shut (an archway is
  // a door left open), which is `fillFrom`'s own rule. Only the rays read
  // whether a door is open.
  if (board.lighting === 'room') {
    const flood = fillFrom(
      { x: token.x, y: token.y },
      walls,
      grid,
      area,
      MAX_FILL_CELLS,
      radiusCells,
    );
    for (let i = 0; i < flood.length; i += 2) {
      const cx = flood[i] ?? 0;
      const cy = flood[i + 1] ?? 0;
      if (cx < x0 || cx > x1 || cy < y0 || cy > y1) continue;
      lit.add(at(cx, cy));
    }
  }

  let cells = '';
  for (let i = 0; i < w * h; i++) cells += lit.has(i) ? '.' : '#';

  return { x: x0, y: y0, w, h, cells };
}

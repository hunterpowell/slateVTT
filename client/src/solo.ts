// Solo sight: what one creature can see, on the DM's screen and nobody else's.
//
// The adjudication view, and the useful slice of a question this project has
// answered "no" to twice — per-player fog. The table's fog stays party-shared,
// because six people narrating to each other get nothing from five answers but
// confusion, and because there is no defensible thing for the *DM's* board to
// show once there are five. What the DM actually wants at the table is narrower
// and has one answer: **can the rogue see it.**
//
// **Client-only, and nothing goes in the room.** This is a second raycast over
// data the DM's client already holds — the walls, the radius, the mode and where
// everybody is standing — so it needs no command, no event and no filter. It is
// leak-proof by construction rather than by a check, which is `crossesWall`'s
// argument for the movement hint word for word: a player's scene carries no
// walls, so their client could not compute this if it tried, and nothing here has
// to ask who is reading it. `docs/fog.md` sets the precedent under *No staged
// fog* — a geometry rule is allowed to live in two languages, and `shape_covers`
// already does.
//
// Two things it deliberately does not do:
//
// - **No memory.** The question is what this creature's eyes reach *now*, not
//   what the party remembers, so there are two states rather than three: in
//   sight, or dark. Nothing here reads `revealed`.
// - **No overrides.** The DM's mask is the DM's own hand, and folding it in would
//   answer a different question — "what would the table be shown" rather than
//   "what can this creature see". They know what they painted; the panel's hint
//   says which of the two this is.
//
// It also does not run over a preview. Nothing raycasts a board nobody has been
// shown, which is the rule `ResetFog` already greys itself for.

import type { Rect, Vec2 } from './coords.js';
import { gridBounds, gridToWorld, maxSpan, playRect } from './coords.js';
import { fillFrom } from './overrides.js';
import type { WireFog } from './protocol.js';
import type { Board, Token } from './scene.js';
import type { Wall } from './walls.js';
import { crossesWall, distanceToSegment } from './walls.js';

/** A grid cell is five feet, everywhere in this project. */
const FEET_PER_CELL = 5;

/** The same ceiling `fillFrom`'s other caller uses, for the same reason: a fill
 *  that reaches it has escaped through a gap the DM traced badly, and stopping is
 *  how they see that. */
const MAX_FILL_CELLS = 50_000;

/**
 * What `token` can see on `board`, packed the way the server packs the real fog.
 *
 * A `WireFog` rather than a `Fog`, so `fogFromWire` builds the canvas: reusing
 * that function is the point of the shape. There is no second rendering path to
 * keep in step, and the wash is guaranteed to look like the one this is standing
 * in for.
 *
 * Two states, so every cell is `#` or `.` and never `o` — see the header. The
 * rectangle is the token's reach clipped to the board, and everything outside it
 * is dark by definition, which is the same thing the real rectangle means and
 * what lets the caller fill the four bands around it flat.
 *
 * Null when there is nothing to answer with: no map size to clip against, or a
 * grid that has not been calibrated.
 */
export function soloSight(
  token: Token,
  board: Board,
  walls: readonly Wall[],
  /** The map image's natural size, for a board with no play area — the same
   *  lazy read the fog and map panels make, because the image changes under it. */
  mapSize: { w: number; h: number } | null,
): WireFog | null {
  const grid = board.grid;
  if (grid.px <= 0 || mapSize === null) return null;

  const area: Rect = playRect(board.playArea, mapSize.w, mapSize.h);
  // In cells for the reach test and in pixels for the window and the wall cull,
  // which is `visible_cells`'s split on the server and is there for its reason:
  // a radius set in feet is a whole number of cells, and the cells sitting
  // exactly on it must land the same way on both sides of the viewer.
  // This token's own lantern if it carries one, and the map's number if it does
  // not — `fog::Source::radius_cells` on the server, said again here because
  // this is a second raycast over the same data. The two have to agree, or the
  // sight check answers a different question from the fog it stands in for.
  const radiusCells = (token.lightFt ?? board.visionFt) / FEET_PER_CELL;
  // `maxSpan` rather than the cell size, because what the pixel radius bounds is
  // the wall cull, and a ray of `n` cells reaches furthest along the lattice's
  // longest axis. On a square grid the two are the same number.
  const radiusPx = radiusCells * maxSpan(grid);
  if (radiusPx <= 0) return null;

  // The viewer's centre, which is what the server casts from too. A token's
  // footprint decides whether it can be *seen*, never what it can see.
  const eye = gridToWorld(grid, token.x, token.y);

  // The reach as whole cells, then clipped to the board: nothing past the play
  // area is somewhere the party can be, and a rectangle running off into the
  // void is the whole map's worth of characters for nothing.
  // Both rectangles are axis-aligned in *pixels*, so each is turned into the
  // cells it reaches and the two are intersected there — which is the same
  // sentence as before on a square grid, and the only one that stays true when
  // the two spaces disagree about which way is along.
  const reach = gridBounds(grid, {
    x: eye.x - radiusPx,
    y: eye.y - radiusPx,
    w: radiusPx * 2,
    h: radiusPx * 2,
  });
  const within = gridBounds(grid, area);
  // Floored at both ends: these are the cells each rectangle *touches*, and the
  // cell holding the low edge is half inside it. Rounding that end up instead
  // takes a column off one side of the viewer and not the other, which is
  // exactly the asymmetry the circle test downstream exists to catch.
  const x0 = Math.max(Math.floor(reach.minX), Math.floor(within.minX));
  const y0 = Math.max(Math.floor(reach.minY), Math.floor(within.minY));
  const x1 = Math.min(Math.floor(reach.maxX), Math.floor(within.maxX));
  const y1 = Math.min(Math.floor(reach.maxY), Math.floor(within.maxY));

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w <= 0 || h <= 0) return { x: x0, y: y0, w: 0, h: 0, cells: '' };

  const centreOf = (cx: number, cy: number): Vec2 => gridToWorld(grid, cx + 0.5, cy + 0.5);

  // Culled once per source rather than once per cell, which is the same bound
  // `fog.rs` takes and for the same reason: a wall further from the eye than the
  // radius cannot be crossed by any ray this loop casts, and `crossesWall` has
  // no index to make the scan cheap. Six hundred cells against every segment on
  // a traced dungeon is the difference between a recompute the DM feels while
  // dragging the creature and one they do not.
  const near = walls.filter((wall) => distanceToSegment(eye, wall.from, wall.to) <= radiusPx);

  const lit = new Set<number>();
  const at = (cx: number, cy: number): number => (cy - y0) * w + (cx - x0);

  // `Dynamic`, which is what every map did before there were two modes: a cell
  // is visible when the straight line from the viewer's centre to its centre
  // crosses no solid wall and no shut door. `crossesWall` already filters to
  // exactly those, being the movement hint's test and `Wall::blocks`'s twin.
  //
  // Euclidean, so the reach is a circle — agreeing with a drawn circle and not
  // with the movement ruler, which is the disagreement `docs/fog.md` and
  // `docs/drawings.md` both name and leave standing. A radius of light is a
  // circle.
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
  // line to. That union is what lets an open door hand over the wedge visible
  // through it rather than the room behind it, and it is why this mode can never
  // show less than `Dynamic` would.
  //
  // The flood bounds on every traced segment, open or shut — an archway is a
  // door left open — which is `fillFrom`'s own rule and the one place the two
  // questions agree about doors. Only sight reads what a door is swung to.
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

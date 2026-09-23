// Walls and doors: the geometry the DM traces over the map image.
//
// The server reads them: they cull the raycast that decides what the party can
// see, and the fog is the only form in which any of it reaches a player. On this
// side there is one reader, `crossesWall`, and only the DM's client uses it: it
// colours their movement ruler when a drag passes through a wall. That is a
// hint and never a refusal; see `docs/drawings.md` on why blocking the move
// would reveal the floor plan to anybody willing to drag a token about.
//
// **Everything here is in image pixels**, which is `world` on this side. A wall
// traces a feature painted on the map, so it is anchored to the art, not to a
// cell (the exception to invariant 1). Stored in grid units, every wall would
// slide off the wall it was tracing the moment the DM corrected the grid.
// Calibrate first, then trace.

import type { GridSpec, Vec2 } from './coords.js';
import { gridToWorld, worldToGrid } from './coords.js';
import type { WireWall } from './protocol.js';

/** One traced segment. Flat, not the run it was drawn as: the run is only how
 *  the DM drew it, and isn't stored. */
export interface Wall {
  id: string;
  /** Image pixels, like `to`. */
  from: Vec2;
  to: Vec2;
  /**
   * Null for a solid wall; true or false for a door and whether it stands open.
   *
   * One field instead of `isDoor` beside `isOpen`, mirroring `WallKind` on the
   * server, so "a solid wall that is open" can't be represented.
   */
  door: boolean | null;
}

export function wallFromWire(wire: WireWall): Wall {
  return {
    id: wire.id,
    from: { x: wire.from.x, y: wire.from.y },
    to: { x: wire.to.x, y: wire.to.y },
    door: wire.kind.kind === 'door' ? wire.kind.open : null,
  };
}

/**
 * The nearest grid corner to a world point.
 *
 * The third snapping rule that runs on the client, for the same reason as
 * `snapOrigin`: a run is drawn one click at a time and the DM has to watch each
 * corner land where it will sit, with the segment to the cursor drawn from it.
 * A snap applied on the server would arrive after the polyline had already
 * been drawn somewhere else, and the whole trace would jump on release.
 *
 * It isn't a copy of the token rule. `snap_to_cell` settles a token by how
 * wide it is, onto cell centres or the corners between them; a wall has no
 * width and always wants the corner, because that is where the DM sees the
 * line painted on the map.
 */
export function snapToCorner(grid: GridSpec, at: Vec2): Vec2 {
  // Out to cells, rounded, and back. On a square grid that is plain rounding
  // per axis; on a sheared one a corner is still a whole-numbered point of the
  // lattice, and only the two conversions know the difference.
  const cell = worldToGrid(grid, at.x, at.y);
  return gridToWorld(grid, Math.round(cell.x), Math.round(cell.y));
}

/**
 * The wall nearest a world point, within `tolerance` world pixels, or null.
 *
 * Nearest, not topmost as for a token: walls have no z-order (the list is the
 * order they were traced in and means nothing), so the answer to "which one
 * did they click" is the closest one. It matters where two segments meet at a
 * corner, which is most of them.
 */
export function wallAt(walls: Wall[], at: Vec2, tolerance: number): Wall | null {
  let best: Wall | null = null;
  let bestDistance = tolerance;

  for (const wall of walls) {
    const distance = distanceToSegment(at, wall.from, wall.to);
    if (distance <= bestDistance) {
      best = wall;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Whether this wall stops sight: a solid wall always, a door only while shut.
 *
 * A second copy of `Wall::blocks` on the server, because the two callers are
 * in two languages: that one culls the raycast, this one colours a ruler. Two
 * copies are acceptable for the same reason as `shape_covers`: a disagreement
 * changes what a line looks like on one screen, never what anybody is
 * permitted to see.
 */
export function blocksSight(wall: Wall): boolean {
  return wall.door !== true;
}

/**
 * Whether a wall stands between two points: the DM's movement hint, and the
 * only thing in this client that reads a wall as geometry instead of drawing
 * it. See `docs/drawings.md`.
 *
 * It can't leak, and not because of a check: a player's scene carries no walls
 * at all, so their client has nothing to test against and this returns false
 * for them without ever being told who they are. That only holds because it
 * is a warning colour, not a refusal. The server is never asked whether a move
 * is legal, and an answer would reveal the floor plan to anyone who dragged a
 * token around and watched.
 *
 * Strict on the endpoints: a line that only touches a corner isn't crossing
 * anything. Doors count as walls while shut and stop counting the moment the
 * DM opens one, since that is the difference the DM is looking at.
 */
export function crossesWall(walls: readonly Wall[], from: Vec2, to: Vec2): boolean {
  for (const wall of walls) {
    if (!blocksSight(wall)) continue;
    if (segmentsCross(from, to, wall.from, wall.to)) return true;
  }
  return false;
}

/** Which side of the line `a`→`b` the point `p` falls on, as a signed area. */
function side(a: Vec2, b: Vec2, p: Vec2): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

/**
 * Whether two segments properly cross.
 *
 * Each segment has to straddle the other's line, which is four signed areas and
 * no division, so a vertical wall needs no special case, as a slope-based test
 * would. Collinear overlap reads as false: a move sliding *along* a wall hasn't
 * gone through it.
 */
function segmentsCross(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): boolean {
  const d1 = side(b1, b2, a1);
  const d2 = side(b1, b2, a2);
  const d3 = side(a1, a2, b1);
  const d4 = side(a1, a2, b2);
  return d1 > 0 !== d2 > 0 && d3 > 0 !== d4 > 0;
}

/** Perpendicular distance from a point to a segment, clamped to its ends. */
export function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  // A zero-length segment can't be traced (two clicks in the same corner make
  // no run), but the division below would be NaN if one ever arrived.
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  const along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const t = along < 0 ? 0 : along > 1 ? 1 : along;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

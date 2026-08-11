// Walls and doors: the geometry the DM traces over the map image.
//
// The server reads them: they cull the raycast that decides what the party can
// see, and the fog is the only form in which any of it reaches a player. On this
// side there is one reader, `crossesWall`, and it belongs to the DM alone — it
// colours their movement ruler when a drag passes through masonry. That is a
// hint and never a refusal; see `ROADMAP.md` on why blocking the move instead
// would hand the floor plan to anybody willing to drag a token about.
//
// **Everything here is in image pixels**, which is `world` on this side. A wall
// traces a feature painted on the map, so it is anchored to the art rather than
// to a cell — see invariant 1, whose exception this is. Stored in grid units,
// every wall would slide off the wall it was tracing the moment the DM corrected
// the grid. Calibrate first, then trace.

import type { GridSpec, Vec2 } from './coords.js';
import type { WireWall } from './protocol.js';

/** One traced segment. Flat, not the run it was drawn as — the run was how the
 *  DM authored, and it stopped existing the moment the segments were stored. */
export interface Wall {
  id: string;
  /** Image pixels, like `to`. */
  from: Vec2;
  to: Vec2;
  /**
   * Null for masonry; true or false for a door and whether it stands open.
   *
   * One field rather than `isDoor` beside `isOpen`, mirroring `WallKind` on the
   * server: "a solid wall that is open" is a state that cannot be written down.
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
 * The second snapping rule that lives in the client rather than on the server,
 * and it is here for `originCell`'s reason rather than despite it: a run is
 * authored one click at a time and the DM has to watch each corner land where
 * it will actually sit, with the segment to the cursor drawn from it. A snap
 * applied on the server would arrive after the polyline had already been drawn
 * somewhere else, and the whole trace would jump on release.
 *
 * It is also not the token rule twice over. `snap_to_cell` settles a token by
 * how wide it is, onto cell centres or the corners between them; a wall has no
 * width and always wants the corner, because that is where the DM sees the line
 * painted on the map.
 */
export function snapToCorner(grid: GridSpec, at: Vec2): Vec2 {
  return {
    x: grid.offsetX + Math.round((at.x - grid.offsetX) / grid.px) * grid.px,
    y: grid.offsetY + Math.round((at.y - grid.offsetY) / grid.px) * grid.px,
  };
}

/**
 * The wall nearest a world point, within `tolerance` world pixels, or null.
 *
 * Nearest rather than topmost, unlike a token: walls have no z-order — the list
 * is the order they were traced in and means nothing — so the honest answer to
 * "which one did they click" is the closest one. It matters where two segments
 * meet at a corner, which is most of them.
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
 * Whether this wall stops sight: masonry always, a door only while it is shut.
 *
 * `Wall::blocks` on the server, written a second time because the two callers
 * are in two languages — that one culls the raycast, this one colours a ruler.
 * They are allowed to be two copies for the reason `shape_covers` is: a
 * disagreement changes what a line looks like on one screen, never what anybody
 * is permitted to see.
 */
export function blocksSight(wall: Wall): boolean {
  return wall.door !== true;
}

/**
 * Whether a wall stands between two points — the movement hint `ROADMAP.md`
 * asked for, and the only thing in this client that reads a wall as geometry
 * rather than drawing it.
 *
 * It cannot leak, and not because of a check: a player's scene carries no walls
 * at all, so their client has nothing to test against and this returns false for
 * them without ever being told who they are. That is the whole reason the hint
 * was affordable — it is a warning colour rather than a refusal, so the server
 * is never asked whether a move is legal and never answers, which is what would
 * hand the floor plan to anyone who dragged a token around and watched.
 *
 * Strict on the endpoints: a line that merely touches a corner is not crossing
 * anything. Doors count as walls while they are shut, and stop counting the
 * moment the DM swings one — which is the point, since that is the difference
 * the DM is looking at.
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
 * no division — so a wall traced exactly vertical needs no special case, the way
 * a slope-based test would. Collinear overlap reads as false, deliberately: a
 * move sliding *along* a wall has not gone through it.
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
  // A zero-length segment cannot be traced — two clicks in the same corner make
  // no run — but the division below would be NaN if one ever arrived.
  if (lengthSquared === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  const along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  const t = along < 0 ? 0 : along > 1 ? 1 : along;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

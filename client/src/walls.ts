// Walls and doors: the geometry the DM traces over the map image.
//
// Nothing reads these yet. They block line of sight once there is line of sight
// to block, and until then a wall is a line on the DM's screen and a row in the
// save file. That is deliberate — the editor is worth building before the thing
// it feeds, because per-segment click-drag across a two-hundred-segment dungeon
// is what makes people quietly stop using fog of war.
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

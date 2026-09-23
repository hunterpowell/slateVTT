// The movement ruler: how far the token being dragged has come from where its
// drag began. No command, no event, nothing persisted: the feature is this
// file, four calls into it, and one drawing pass.
//
// Every client draws one for any token it sees moving, not only the dragger,
// and that costs nothing on the wire: `TokenMoved` already says whether a frame
// is a drag or a drop, and a watcher's copy of a token sits at its settled
// position until the first drag frame lands. That position *is* the origin, so
// `seen` takes it from before the frame is applied and ignores it after that.
// Captured a frame later it would be the token mid-drag, and a ruler measuring
// from itself always reads zero.
//
// Nothing here can leak. The frames a ruler is built from are the ones the room
// already decided to send: a hidden token's are dropped for players, and a plan
// being dragged reaches the DM alone.

import type { Vec2 } from './coords.js';
import type { Diagonals } from './protocol.js';

/** A grid cell is five feet. `shapes.ts` holds the same constant. */
const FEET_PER_CELL = 5;

/**
 * How long a ruler survives without a fresh drag frame.
 *
 * A drop frame normally ends one. This is only for the client that vanishes
 * mid-drag and never sends it, leaving a line stranded on five other screens
 * until somebody reloads.
 *
 * It has to be generous: frames come from `pointermove`, so a drag that pauses
 * sends nothing at all. Silence means "they stopped moving the mouse" far more
 * often than "they are gone", and a DM who holds a token still while working
 * out where it goes must not have their ruler disappear from the table's
 * screens. Nothing is lost by waiting: the line is still drawn against the
 * position everyone can see.
 */
const STALE_MS = 15_000;

/**
 * How long a ruler stays on screen after the drop that ended it.
 *
 * A different clock from `STALE_MS` above, for a different purpose: that one
 * guesses that a client vanished, this one is a pause. The drop is the moment
 * everyone looks up, and a line that disappears on the frame it lands is a
 * line nobody read. Short, because it is the only thing on the board drawn for
 * a move that has already happened.
 */
const LINGER_MS = 2_000;

export interface Ruler {
  /** Where the token stood when its drag began, in grid units. */
  from: Vec2;
  /**
   * Which of the token's two positions is being dragged: its plan for the
   * staged map, or its position on the board. Only the board on screen draws,
   * or a live drag measures itself across a map nobody is looking at.
   */
  staged: boolean;
  /**
   * When the last drag frame for it arrived, or null for the drag this client is
   * performing itself, which ends on pointerup and can't go stale.
   */
  seenAt: number | null;
  /**
   * When the drop landed, or null while the drag is still running.
   *
   * Non-null means the ruler is fading, not live, and that is the only
   * difference between the two states. It is still measured against the same
   * origin, and the token has stopped moving, so the reading and the trail stay
   * still without anything having to freeze them.
   */
  endedAt: number | null;
}

export interface Rulers {
  /** The drag this client is performing. `from` is where the token sits on
   *  whichever board that drag is happening on. */
  begin(id: string, from: Vec2, staged: boolean): void;
  /** A drag frame for somebody else's token, with our copy's position from
   *  *before* it is applied. Only the first frame's origin is kept. */
  seen(id: string, from: Vec2, staged: boolean, now: number): void;
  /** The drop frame. Starts the ruler fading instead of removing it: the move
   *  it describes is the one worth looking at. A no-op for an id with no ruler. */
  end(id: string, now: number): void;
  /** The token going away: deleted, or hidden from us mid-drag. Unlike a drop
   *  this takes the ruler with it, since a trail left behind by a token that
   *  just vanished is a line pointing at where it went. */
  forget(id: string): void;
  /** `forget` for everything not in `keep`, which is what an undo needs: a
   *  restore can take several tokens off the board at once and there is no
   *  per-token frame to call `forget` from. The reason is the same as for
   *  `forget`: a trail left by a vanished token points at where it went. */
  forgetExcept(keep: ReadonlySet<string>): void;
  /** Every live ruler, having dropped the ones that have finished fading and the
   *  ones nothing has moved for a while. */
  active(now: number): ReadonlyMap<string, Ruler>;
}

export function createRulers(): Rulers {
  const live = new Map<string, Ruler>();

  return {
    begin(id, from, staged) {
      live.set(id, { from: { x: from.x, y: from.y }, staged, seenAt: null, endedAt: null });
    },

    seen(id, from, staged, now) {
      const ruler = live.get(id);
      // Nothing here, or the one still fading from this token's last move: both
      // are a fresh drag, and the fading one has to give up its origin or the
      // new ruler measures from where the previous move began.
      if (ruler === undefined || ruler.endedAt !== null) {
        live.set(id, { from: { x: from.x, y: from.y }, staged, seenAt: now, endedAt: null });
        return;
      }
      ruler.seenAt = now;
    },

    end(id, now) {
      const ruler = live.get(id);
      // Only the first drop counts. A second one for a ruler already fading
      // would restart the fade on a move nobody made.
      if (ruler === undefined || ruler.endedAt !== null) return;
      ruler.endedAt = now;
    },

    forget(id) {
      live.delete(id);
    },

    forgetExcept(keep) {
      for (const id of [...live.keys()]) {
        if (!keep.has(id)) live.delete(id);
      }
    },

    active(now) {
      for (const [id, ruler] of live) {
        if (ruler.endedAt !== null) {
          if (now - ruler.endedAt > LINGER_MS) live.delete(id);
          // Still fading, and the stale check below must not also fire on it:
          // a ruler that has landed has stopped receiving frames by definition.
          continue;
        }
        if (ruler.seenAt !== null && now - ruler.seenAt > STALE_MS) live.delete(id);
      }
      return live;
    },
  };
}

/**
 * How far a token has come, in feet, counted the way the table counts.
 *
 * The delta is rounded to whole cells first, and that needs no knowledge of
 * where a token settles: a drag starts from a settled position, the lattice a
 * token settles on is spaced one cell apart whatever its size, so the difference
 * between the two ends is a whole number of cells. Which cell it lands *in* is
 * decided by `snap_to_cell`, which stays on the server as the only copy of that
 * rule.
 *
 * The move is then `straight` orthogonal steps and `diagonal` diagonal ones,
 * which is the only decomposition of a straight line on a king-move lattice,
 * and the two conventions differ only in what a diagonal step costs:
 *
 *   equal        every step is one cell. A 3-cell diagonal is 15 ft.
 *   alternating  every *second* diagonal costs two. A 3-cell diagonal is 20 ft.
 *
 * `⌊diagonal / 2⌋` is where the doubling lands. It counts from the start of
 * this reading, so the first diagonal of anything anybody measures costs five.
 * Nothing here holds a creature's movement budget to carry a remainder in, and
 * a number that depended on how far you had already come this turn couldn't be
 * checked by looking at it.
 *
 * Both stay multiples of five, which is worth protecting: it is what the table
 * says out loud. The distance a *shape* reports is Euclidean and disagrees
 * with both (see `feetOf` in shapes.ts).
 */
export function feetMoved(from: Vec2, to: Vec2, diagonals: Diagonals): number {
  const dx = Math.abs(Math.round(to.x - from.x));
  const dy = Math.abs(Math.round(to.y - from.y));

  const diagonal = Math.min(dx, dy);
  const straight = Math.max(dx, dy) - diagonal;
  const surcharge = diagonals === 'alternating' ? Math.floor(diagonal / 2) : 0;

  return (straight + diagonal + surcharge) * FEET_PER_CELL;
}

/**
 * How solidly a ruler draws: full while the drag runs, fading out over
 * `LINGER_MS` once it has landed.
 *
 * One number for the line, the reading and the trail alike. They are three
 * parts of one annotation, and fading them on separate clocks would only make
 * the last one left look like a bug.
 */
export function rulerAlpha(ruler: Ruler, now: number): number {
  if (ruler.endedAt === null) return 1;
  const gone = (now - ruler.endedAt) / LINGER_MS;
  return gone >= 1 ? 0 : 1 - gone;
}

/**
 * The cells a move crossed, as flat pairs, the way `coveredCells` returns them
 * and for the same reason: this is rebuilt every frame of every drag on screen.
 *
 * The straight line from origin to destination, not the path the mouse took,
 * so the trail is the reading drawn on the board. Stepped over the rounded
 * delta, so it lands `feetMoved / 5` steps away and yields that many cells plus
 * the one it started in. The picture and the number can't disagree, because
 * they are computed from the same two integers.
 *
 * It also costs nothing on the wire and nothing in state: `from` is already on
 * the ruler and `to` is where the token is, both of which every client watching
 * the drag already holds. All six screens rasterise the same line.
 *
 * A wide token traces its centre, one cell across whatever its size. The trail
 * answers "which way did it come", and a 4×4 footprint swept over four cells of
 * travel is a smear, not a path.
 *
 * A step can land on a cell boundary (four across and two down does it twice),
 * and `floor` takes the later cell. Either is defensible when the line runs
 * down the join; what matters is that it is the same answer everywhere, since
 * the same two integers go in on every client. Reversing the drag lights the
 * same squares too, since the ties fall on whole numbers, which floor to
 * themselves from both directions.
 */
export function trailCells(from: Vec2, to: Vec2): number[] {
  const dx = Math.round(to.x - from.x);
  const dy = Math.round(to.y - from.y);
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  if (steps === 0) return [];

  const cells: number[] = [];
  for (let i = 0; i <= steps; i++) {
    cells.push(
      Math.floor(from.x + (dx * i) / steps),
      Math.floor(from.y + (dy * i) / steps),
    );
  }
  return cells;
}

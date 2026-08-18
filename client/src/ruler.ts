// The movement ruler: how far the token being dragged has come from where its
// drag began. No command, no event, nothing persisted — the whole feature is
// this file, four calls into it, and one drawing pass.
//
// It is not the dragger's alone, though. Every client draws one for any token it
// sees moving, and that costs nothing on the wire: `TokenMoved` already says
// whether a frame is a drag or a drop, and a watcher's copy of a token sits at
// its settled position until the first drag frame lands. That position *is* the
// origin, which is why `seen` takes it from before the frame is applied and
// ignores it thereafter — captured a frame later it would be the token
// mid-drag, and a ruler measuring from itself always reads zero.
//
// Nothing here can leak. The frames a ruler is built from are the ones the room
// already decided to send: a hidden token's are dropped for players, and a plan
// being dragged reaches the DM alone.

import type { Vec2 } from './coords.js';
import type { Diagonals } from './protocol.js';

/** A grid cell is five feet. The only place this project converts. */
const FEET_PER_CELL = 5;

/**
 * How long a ruler survives without a fresh drag frame.
 *
 * A drop frame is what normally ends one. This is only for the client that
 * vanishes mid-drag and never sends it, leaving a line stranded on five other
 * screens until somebody reloads.
 *
 * Generous on purpose, and it has to be: frames come from `pointermove`, so a
 * drag that pauses sends nothing at all. Silence means "they stopped moving the
 * mouse" far more often than it means "they are gone", and a DM who holds a
 * token still while working out where it goes must not have their ruler
 * evaporate on the table's screens. Nothing is lost by waiting — the line is
 * still drawn against the position everyone can see.
 */
const STALE_MS = 15_000;

/**
 * How long a ruler stays on screen after the drop that ended it.
 *
 * A different clock from `STALE_MS` above, for a different failure — that one is
 * a guess about a client that vanished, this one is a deliberate pause. The drop
 * is the moment everyone looks up, and a line that disappears on the same frame
 * as it lands is a line nobody read. Short, because it is the only thing on the
 * board drawn for a move that has already happened.
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
   * performing itself — that one ends on pointerup and cannot go stale.
   */
  seenAt: number | null;
  /**
   * When the drop landed, or null while the drag is still running.
   *
   * Non-null means the ruler is fading rather than live, which is the only
   * difference between the two states — it is still measured against the same
   * origin, and the token has stopped moving, so the reading and the trail are
   * frozen without anything having to freeze them.
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
  /** The drop frame. Starts the ruler fading rather than removing it — the move
   *  it describes is the one worth looking at. A no-op for an id with no ruler. */
  end(id: string, now: number): void;
  /** The token going away: deleted, or hidden from us mid-drag. Unlike a drop
   *  this takes the ruler with it, since a trail left behind by a token that
   *  just vanished is a line pointing at where it went. */
  forget(id: string): void;
  /** `forget` for everything not in `keep`, which is what an undo needs: a
   *  restore can take several tokens off the board at once and there is no
   *  per-token frame to hang a `forget` on. Same argument as that one — a trail
   *  left by a token that just vanished points at where it went. */
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
 * `snap_to_cell`'s business, and stays on the server as the only copy of that
 * rule.
 *
 * The move is then `straight` orthogonal steps and `diagonal` diagonal ones,
 * which is the only decomposition of a straight line on a king-move lattice —
 * and the two conventions differ solely in what the second sort costs:
 *
 *   equal        every step is one cell. A 3-cell diagonal is 15 ft.
 *   alternating  every *second* diagonal costs two. A 3-cell diagonal is 20 ft.
 *
 * `⌊diagonal / 2⌋` is where the doubling lands, and it is what makes the second
 * convention free of history: it counts from the start of this reading, so the
 * first diagonal of anything anybody measures costs five. Nothing here holds a
 * creature's movement budget to carry a remainder in, and a number that depended
 * on how far you had already come this turn could not be checked by looking at
 * it.
 *
 * Both stay multiples of five, which is the property worth protecting: it is
 * what the table says out loud. The distance a *shape* reports is Euclidean and
 * disagrees with both — see `feetOf` in shapes.ts, which argues it there.
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
 * halves of one annotation and fading them on separate clocks would only make
 * the last one left look like a bug.
 */
export function rulerAlpha(ruler: Ruler, now: number): number {
  if (ruler.endedAt === null) return 1;
  const gone = (now - ruler.endedAt) / LINGER_MS;
  return gone >= 1 ? 0 : 1 - gone;
}

/**
 * The cells a move crossed, as flat pairs — the way `coveredCells` returns them,
 * and for the same reason: this is rebuilt every frame of every drag on screen.
 *
 * The straight line from origin to destination rather than the path the mouse
 * actually took, and that is what makes it *the reading, drawn*. Stepped over
 * the rounded delta, so it lands exactly `feetMoved / 5` steps away and yields
 * exactly that many cells plus the one it started in. The picture and the number
 * cannot disagree, because they are computed from the same two integers.
 *
 * It also costs nothing on the wire and nothing in state: `from` is already on
 * the ruler and `to` is where the token is, both of which every client watching
 * the drag already holds. All six screens rasterise the same line.
 *
 * A wide token traces its centre, one cell across whatever it is — the trail
 * answers "which way did it come", and a 4×4 footprint swept over four cells of
 * travel is a smear rather than a path.
 *
 * A step can land exactly on a cell boundary — four across and two down does it
 * twice — and `floor` takes the later cell. Either is defensible when the line
 * runs down the join, and what matters is that it is the same answer everywhere:
 * the same two integers go in on every client, and the same square lights up.
 * Reversing the drag lights the same squares too, since the ties fall on whole
 * numbers, which floor to themselves from both directions.
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

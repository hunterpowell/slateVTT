// The movement ruler: how far the token being dragged is going from where it
// stands. No command, no event, nothing persisted: the feature is this file, a
// few calls into it, and the drawing passes.
//
// A ruler also holds the ghost: where the token is going while the drag runs.
// The token itself stays put on every screen until the drop, so a move reads as
// a plan and then an action. That is why a ruler is per token and not per drag:
// a group has one ghost per member, though the dragger measures only one of
// them (`measured`).
//
// Every client draws one for any token it sees moving, not only the dragger,
// and that costs nothing on the wire: `TokenMoved` already says whether a frame
// is a drag or a drop, and a watcher's copy of a token stays at its settled
// position until the drop, since drag frames move the ghost and not the token.
// That position *is* the origin.
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

/**
 * How long a landed token takes to slide from where it stood to where it was
 * dropped, per cell crossed, and the most any slide takes.
 *
 * By distance rather than a fixed time, so a one-square step is a blink and a
 * long dash still finishes in under two seconds. Counted in cells the way the
 * trail counts them, so the slide and the trail agree about how far it went.
 */
const SLIDE_MS_PER_CELL = 150;
const SLIDE_MAX_MS = 1_500;

export interface Ruler {
  /** Where the token stood when its drag began, in grid units. */
  from: Vec2;
  /**
   * The ghost: where the token is going, in grid units, while the drag runs.
   * Null once it has landed, when the token itself is at the far end and the
   * line measures to that instead.
   */
  to: Vec2 | null;
  /**
   * Whether this ruler draws its line, trail and reading, or only its ghost.
   * False for the members of our own group drag other than the one the pointer
   * went down on: six lines with six labels is unreadable, and the question is
   * about one creature. Everyone else's rulers are all measured, since nothing
   * on the wire says which token was grabbed.
   */
  measured: boolean;
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
  /**
   * How long the token takes to slide to where it landed, set by the drop. Zero
   * while the drag runs. The fade starts once the slide is over, so the trail
   * is still there when the token reaches the end of it.
   */
  slideMs: number;
}

export interface Rulers {
  /** The drag this client is performing, one call per token held. `from` is
   *  where the token sits on whichever board that drag is happening on, and the
   *  ghost starts there. */
  begin(id: string, from: Vec2, staged: boolean, measured: boolean): void;
  /** Our own drag has moved: the ghost goes to `to`. A no-op for an id with no
   *  running ruler. */
  aim(id: string, to: Vec2): void;
  /** A drag frame for somebody else's token: `from` is where our copy stands,
   *  `to` is where the frame says it is going. Only the first frame's origin is
   *  kept. */
  seen(id: string, from: Vec2, to: Vec2, staged: boolean, now: number): void;
  /** The drop, landing at `to`. Clears the ghost, starts the token sliding
   *  there, and then the ruler fading instead of removing it: the move it
   *  describes is the one worth looking at. A no-op for an id with no ruler. */
  end(id: string, to: Vec2, now: number): void;
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
    begin(id, from, staged, measured) {
      live.set(id, {
        from: { x: from.x, y: from.y },
        to: { x: from.x, y: from.y },
        measured,
        staged,
        seenAt: null,
        endedAt: null,
        slideMs: 0,
      });
    },

    aim(id, to) {
      const ruler = live.get(id);
      if (ruler === undefined || ruler.endedAt !== null) return;
      ruler.to = { x: to.x, y: to.y };
    },

    seen(id, from, to, staged, now) {
      const ruler = live.get(id);
      // Nothing here, or the one still fading from this token's last move: both
      // are a fresh drag, and the fading one has to give up its origin or the
      // new ruler measures from where the previous move began.
      if (ruler === undefined || ruler.endedAt !== null) {
        live.set(id, {
          from: { x: from.x, y: from.y },
          to: { x: to.x, y: to.y },
          measured: true,
          staged,
          seenAt: now,
          endedAt: null,
          slideMs: 0,
        });
        return;
      }
      ruler.to = { x: to.x, y: to.y };
      ruler.seenAt = now;
    },

    end(id, to, now) {
      const ruler = live.get(id);
      // Only the first drop counts. A second one for a ruler already fading
      // would restart the fade on a move nobody made.
      if (ruler === undefined || ruler.endedAt !== null) return;
      ruler.to = null;
      ruler.endedAt = now;
      ruler.slideMs = slideDuration(ruler.from, to);
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
          if (now - ruler.endedAt > ruler.slideMs + LINGER_MS) live.delete(id);
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

/** How long a slide from `from` to `to` takes: per cell crossed, capped. */
export function slideDuration(from: Vec2, to: Vec2): number {
  const cells = Math.max(Math.abs(Math.round(to.x - from.x)), Math.abs(Math.round(to.y - from.y)));
  return Math.min(cells * SLIDE_MS_PER_CELL, SLIDE_MAX_MS);
}

/**
 * Where to draw a token whose drop has landed: partway along the straight line
 * from where its drag began to `at`, where it really is, easing out as it
 * arrives. `at` itself once the slide is over, and while the drag still runs
 * (the token stays at its origin then, and `at` is that origin).
 *
 * Drawing only. Hit-testing, fog and everything else read `at`: the room put
 * the token there on the drop, and a click on a sliding token picks it up
 * where it is, not where it appears to be.
 */
export function slidePos(ruler: Ruler, at: Vec2, now: number): Vec2 {
  if (ruler.endedAt === null || ruler.slideMs === 0) return at;
  const t = (now - ruler.endedAt) / ruler.slideMs;
  if (t >= 1) return at;
  const eased = 1 - (1 - Math.max(t, 0)) ** 3;
  return {
    x: ruler.from.x + (at.x - ruler.from.x) * eased,
    y: ruler.from.y + (at.y - ruler.from.y) * eased,
  };
}

/**
 * How solidly a ruler draws: full while the drag runs and while the token
 * slides, fading out over `LINGER_MS` once it has arrived.
 *
 * One number for the line, the reading and the trail alike. They are three
 * parts of one annotation, and fading them on separate clocks would only make
 * the last one left look like a bug.
 */
export function rulerAlpha(ruler: Ruler, now: number): number {
  if (ruler.endedAt === null) return 1;
  const gone = (now - ruler.endedAt - ruler.slideMs) / LINGER_MS;
  if (gone <= 0) return 1;
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
 * It also costs nothing on the wire and nothing in state: `from` and the ghost
 * are already on the ruler, and every client watching the drag holds both. All
 * six screens rasterise the same line.
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

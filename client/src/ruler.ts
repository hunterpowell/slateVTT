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
}

export interface Rulers {
  /** The drag this client is performing. `from` is where the token sits on
   *  whichever board that drag is happening on. */
  begin(id: string, from: Vec2, staged: boolean): void;
  /** A drag frame for somebody else's token, with our copy's position from
   *  *before* it is applied. Only the first frame's origin is kept. */
  seen(id: string, from: Vec2, staged: boolean, now: number): void;
  /** The drop frame, or the token going away. A no-op for an id with no ruler. */
  end(id: string): void;
  /** Every live ruler, having dropped the ones nothing has moved for a while. */
  active(now: number): ReadonlyMap<string, Ruler>;
}

export function createRulers(): Rulers {
  const live = new Map<string, Ruler>();

  return {
    begin(id, from, staged) {
      live.set(id, { from: { x: from.x, y: from.y }, staged, seenAt: null });
    },

    seen(id, from, staged, now) {
      const ruler = live.get(id);
      if (ruler === undefined) {
        live.set(id, { from: { x: from.x, y: from.y }, staged, seenAt: now });
        return;
      }
      ruler.seenAt = now;
    },

    end(id) {
      live.delete(id);
    },

    active(now) {
      for (const [id, ruler] of live) {
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
 * A diagonal step then costs what an orthogonal one costs, so every reading is a
 * multiple of five and matches the move that actually happened rather than the
 * unsnapped pixel the cursor is over.
 */
export function feetMoved(from: Vec2, to: Vec2): number {
  const dx = Math.abs(Math.round(to.x - from.x));
  const dy = Math.abs(Math.round(to.y - from.y));
  return Math.max(dx, dy) * FEET_PER_CELL;
}

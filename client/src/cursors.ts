/**
 * Everybody else's pointer, and how long one stays on the board after it stops
 * arriving.
 *
 * `pings.ts` with two things changed and everything else the same. One is that
 * this holds **one pointer per person** rather than a list of events: a ring is
 * something somebody did and two of them can be on screen at once, while a hand
 * is somewhere, and the next frame from that hand replaces the last. The other
 * is that nothing here is ever ours — our own pointer is drawn by the operating
 * system, which is why there is no `hold`, no `commit` and no preview.
 *
 * **Stillness is what ends one, and it ends it here rather than on the wire.**
 * There is no frame that says a pointer stopped: a client that is not moving
 * sends nothing at all, and every recipient's own clock does the rest. That is
 * also what makes a dropped socket cost nothing — somebody who closed their
 * laptop fades out on the same timer as somebody who let go of the mouse.
 *
 * The decay is the dial. `ROADMAP.md` says so in as many words: seven pointers
 * over a board that already carries tokens, nameplates, hit point bars, rulers,
 * trails, shapes and fog is a real cost, and if the board reads badly this is
 * the number to turn down before anything else is reconsidered.
 */

import type { Vec2 } from './coords.js';
import { keyOf } from './presence.js';
import type { Owner } from './protocol.js';

/**
 * How long a pointer stays on the board after the last frame from it.
 *
 * Long enough that the ~33ms between throttled frames is invisible, short
 * enough that a room of people reading rather than pointing goes quiet. A
 * pointer parked while its owner reads *does* fade out and come back on the
 * next nudge, and that is the intended reading: this shows where hands are
 * working, not where seven chairs are.
 */
const LIFE_MS = 2500;

/** How long it takes to fade at the end of that. Longer than a ping's, because
 *  a pointer that vanished at full strength would read as a client dropping
 *  rather than as a hand going still. */
const FADE_MS = 700;

/** Somebody's pointer, as of the last frame from it. */
export interface Cursor {
  owner: Owner;
  /** In grid units, like everything else this client holds a position for —
   *  so a recalibration under a pointer moves it with the map rather than
   *  leaving it pointing at a different square. Invariant 1. */
  at: Vec2;
  /** `performance.now()` when that frame arrived. */
  seenAt: number;
}

export interface Cursors {
  /** A frame from somebody. Replaces whatever that person's pointer was. */
  moved(owner: Owner, at: Vec2, now: number): void;
  /** Every pointer to draw, having dropped the faded. */
  active(now: number): readonly Cursor[];
  /** Everything, at once — for the switch going off. Without this the pointers
   *  already on screen would linger for their remaining life after the room
   *  said to stop drawing them, which reads as the switch not working. */
  clear(): void;
}

export function createCursors(): Cursors {
  const live = new Map<string, Cursor>();

  return {
    moved(owner, at, now) {
      // A fresh object rather than a mutation: the renderer reads the array
      // `active` hands it and nothing else holds one of these, so there is
      // nothing to keep alive across frames.
      live.set(keyOf(owner), { owner, at: { x: at.x, y: at.y }, seenAt: now });
    },

    active(now) {
      // The idle case is nearly every frame of every session, and it allocates
      // nothing: an empty map returns the same empty array it returned last
      // time round.
      if (live.size === 0) return EMPTY;
      const out: Cursor[] = [];
      for (const [key, cursor] of live) {
        if (now - cursor.seenAt >= LIFE_MS) {
          live.delete(key);
          continue;
        }
        out.push(cursor);
      }
      return out;
    },

    clear() {
      live.clear();
    },
  };
}

const EMPTY: readonly Cursor[] = [];

/**
 * How solidly a pointer draws: full until the last `FADE_MS` of its life, then
 * out.
 *
 * One number for the dot and the name under it, on `ringAlpha`'s argument —
 * they are one annotation, and a name outliving its pointer by a frame reads as
 * a rendering fault. What it is *not* is the resting opacity: that is
 * `CURSOR_ALPHA` in `render.ts`, multiplied on top of this, because how loud a
 * mark is at full strength is a drawing decision and this is a lifetime.
 */
export function cursorAlpha(cursor: Cursor, now: number): number {
  const left = LIFE_MS - (now - cursor.seenAt);
  if (left <= 0) return 0;
  return left >= FADE_MS ? 1 : left / FADE_MS;
}

/**
 * Everybody else's pointer, and how long one stays on the board after it stops
 * arriving.
 *
 * Like `pings.ts`, with two differences. This holds one pointer per person,
 * not a list of events: two pings from one person can be on screen at once,
 * but a pointer is in one place, and the next frame replaces the last. And
 * nothing here is ever ours: our own pointer is drawn by the operating system,
 * so there is no `hold`, no `commit` and no preview.
 *
 * A pointer ends when it goes still, and that is decided here, not on the
 * wire. No frame says a pointer stopped: a client that isn't moving sends
 * nothing, and each recipient's own clock does the rest. So a dropped socket
 * needs no handling: somebody who closed their laptop fades out on the same
 * timer as somebody who let go of the mouse.
 *
 * If the board looks cluttered with seven pointers over the tokens,
 * nameplates, hit point bars, rulers, trails, shapes and fog, shorten
 * `LIFE_MS` before reconsidering anything else. See `docs/presence.md`.
 */

import type { Vec2 } from './coords.js';
import { keyOf } from './presence.js';
import type { Owner } from './protocol.js';

/**
 * How long a pointer stays on the board after the last frame from it.
 *
 * Long enough that the ~33ms between throttled frames is invisible, short
 * enough that a room of people reading instead of pointing goes quiet. A
 * pointer left still while its owner reads fades out and comes back on the
 * next nudge. That is intended: this shows where people are pointing, not
 * who is present.
 */
const LIFE_MS = 2500;

/** How long it takes to fade at the end of that. Longer than a ping's, because
 *  a pointer that vanished at full strength would look like a client dropping,
 *  not a hand going still. */
const FADE_MS = 700;

/** Somebody's pointer, as of the last frame from it. */
export interface Cursor {
  owner: Owner;
  /** In grid units, like every other position this client holds, so a
   *  recalibration moves a pointer with the map instead of leaving it on a
   *  different square. Invariant 1. */
  at: Vec2;
  /** `performance.now()` when that frame arrived. */
  seenAt: number;
}

export interface Cursors {
  /** A frame from somebody. Replaces whatever that person's pointer was. */
  moved(owner: Owner, at: Vec2, now: number): void;
  /** Every pointer to draw, having dropped the faded. */
  active(now: number): readonly Cursor[];
  /** Drops every pointer, for when the switch goes off. Without this, the
   *  pointers already on screen would linger for their remaining life after
   *  the room said to stop drawing them, which looks like the switch not
   *  working. */
  clear(): void;
}

export function createCursors(): Cursors {
  const live = new Map<string, Cursor>();

  return {
    moved(owner, at, now) {
      // A fresh object, not a mutation: the renderer reads the array `active`
      // hands it and nothing else holds one of these, so there is nothing to
      // keep alive across frames.
      live.set(keyOf(owner), { owner, at: { x: at.x, y: at.y }, seenAt: now });
    },

    active(now) {
      // The idle case is nearly every frame of every session, and it allocates
      // nothing: an empty map returns the same empty array every time.
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
 * One number for the dot and the name under it, as with `ringAlpha`: they are
 * one mark, and a name outliving its pointer by a frame looks like a rendering
 * fault. This isn't the resting opacity: that is `CURSOR_ALPHA` in
 * `render.ts`, multiplied on top of this, because how strong a mark is at full
 * strength is a drawing decision and this is a lifetime.
 */
export function cursorAlpha(cursor: Cursor, now: number): number {
  const left = LIFE_MS - (now - cursor.seenAt);
  if (left <= 0) return 0;
  return left >= FADE_MS ? 1 : left / FADE_MS;
}

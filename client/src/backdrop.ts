/**
 * Where the backdrop sits in a window, and the marks people make on it.
 *
 * The pure half of pointing at the backdrop; the gesture itself is in
 * `pointing.ts` and the drawing in `drawBackdrop`. See *Pointing at it* in
 * `docs/maps.md`.
 *
 * Every position here is a `Frac`: a fraction of the picture's natural width
 * and height. The backdrop has no grid and no camera, and each window
 * letterboxes it differently, so that is the one position seven screens agree
 * on. `backdropFit` is the only place a window's letterbox is worked out, and
 * `drawBackdrop` and the gesture both go through it, so a mark lands on the
 * pixel of the picture it was made on.
 *
 * **Nothing here is room state.** A stroke fades on each screen on its own
 * clock and the room never holds one, so a latecomer misses it the way they
 * miss a ping, and there is nothing to save, undo or erase.
 */

import type { Rect, Vec2 } from './coords.js';
import type { Cursors } from './cursors.js';
import { createCursors } from './cursors.js';
import type { Pings } from './pings.js';
import { createPings } from './pings.js';
import type { Frac, Owner } from './protocol.js';

/**
 * How long a finished stroke stays at full strength, and then how long it takes
 * to fade. About eight seconds in all: long enough to say "that window" and be
 * looked at, short enough that nobody needs to rub it out. Tune in play.
 */
const STROKE_HOLD_MS = 6000;
const STROKE_FADE_MS = 2000;

/**
 * Where the picture is drawn in a window, in CSS pixels: as large as fits,
 * centred, never cropped. Null for a picture with no size, which is a broken
 * one and is drawn as nothing.
 */
export function backdropFit(
  view: { width: number; height: number },
  picture: { width: number; height: number },
): Rect | null {
  if (picture.width <= 0 || picture.height <= 0) return null;
  const scale = Math.min(view.width / picture.width, view.height / picture.height);
  const w = picture.width * scale;
  const h = picture.height * scale;
  return { x: (view.width - w) / 2, y: (view.height - h) / 2, w, h };
}

/** A point on the picture to where it is in this window, in CSS pixels. */
export function fracToScreen(fit: Rect, at: Frac): Vec2 {
  return { x: fit.x + at.x * fit.w, y: fit.y + at.y * fit.h };
}

/**
 * A point in this window to where it is on the picture. Not clamped: a point
 * over the letterbox bars comes back outside `0..1`, and the caller decides
 * (`onPicture`, `clampToPicture`).
 */
export function screenToFrac(fit: Rect, p: Vec2): Frac {
  return { x: (p.x - fit.x) / fit.w, y: (p.y - fit.y) / fit.h };
}

/** Whether a point is on the picture, which is all the room accepts. */
export function onPicture(at: Frac): boolean {
  return at.x >= 0 && at.x <= 1 && at.y >= 0 && at.y <= 1;
}

/** The nearest point on the picture, for a stroke that wanders over the bars. */
export function clampToPicture(at: Frac): Frac {
  return { x: Math.min(1, Math.max(0, at.x)), y: Math.min(1, Math.max(0, at.y)) };
}

/** A pen stroke on the backdrop, ours or somebody else's. */
export interface Stroke {
  owner: Owner;
  points: readonly Frac[];
  /** `performance.now()` when it was finished: released, or arrived. */
  endedAt: number;
}

/** How solidly a finished stroke draws: full, then out over `STROKE_FADE_MS`. */
export function strokeAlpha(stroke: Stroke, now: number): number {
  const left = STROKE_HOLD_MS + STROKE_FADE_MS - (now - stroke.endedAt);
  if (left <= 0) return 0;
  return left >= STROKE_FADE_MS ? 1 : left / STROKE_FADE_MS;
}

/**
 * Everything on the backdrop: rings, pointers and strokes.
 *
 * The rings and pointers are the board's own `Pings` and `Cursors`, holding
 * fractions instead of grid units. They are separate instances from the
 * board's, so nothing on the picture can end up drawn on the board.
 */
export interface BackdropMarks {
  /** Whose our own strokes and rings are. */
  readonly me: Owner;
  readonly pings: Pings;
  readonly cursors: Cursors;
  /** A finished stroke, ours on release or somebody else's on arrival. */
  addStroke(owner: Owner, points: readonly Frac[], now: number): void;
  /** Our stroke while the pen is down, or null. Drawn, never sent. */
  drawing: Frac[] | null;
  /** Every finished stroke still visible, having dropped the faded. */
  strokes(now: number): readonly Stroke[];
  /**
   * Drops everything, for a backdrop that came down or changed. A stroke made
   * on the last picture means nothing on the next one.
   */
  clear(): void;
}

export function createBackdropMarks(me: Owner): BackdropMarks {
  let live: Stroke[] = [];
  const marks: BackdropMarks = {
    me,
    pings: createPings(me),
    cursors: createCursors(),
    drawing: null,
    addStroke(owner, points, now) {
      live.push({ owner, points, endedAt: now });
    },
    strokes(now) {
      if (live.length > 0) live = live.filter((s) => strokeAlpha(s, now) > 0);
      return live;
    },
    clear() {
      live = [];
      marks.drawing = null;
      marks.pings.clear();
      marks.cursors.clear();
    },
  };
  return marks;
}

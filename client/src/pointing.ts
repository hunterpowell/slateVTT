/**
 * Pointing at the backdrop: ping, pointer and pen, on a transparent element
 * over the stage that is shown only while a picture covers the board.
 *
 * **The board's `pointer-events: none` rule stays.** It is why no handler in
 * `input.ts` has to know a backdrop exists, so the picture gets this small
 * handler of its own instead of a branch in each of those. See *Pointing at
 * it* in `docs/maps.md`.
 *
 * No tool needs arming. On a picture there is nothing else a drag could mean
 * (no pan, no token, no selection), so the left button pings on a hold and
 * draws on a drag, whatever the draw panel has in hand. The right and middle
 * buttons, which pan the board, do nothing here. A finger is the left button,
 * and a second finger is ignored: the backdrop has no camera to pinch.
 */

import type { BackdropMarks } from './backdrop.js';
import { clampToPicture, onPicture, screenToFrac } from './backdrop.js';
import type { Rect, Vec2 } from './coords.js';
import { CURSOR_SEND_INTERVAL_MS, HOLD_SLOP_PX } from './input.js';
import { HOLD_MS } from './pings.js';
import type { ClientMsg, Frac } from './protocol.js';
import { MAX_PATH_POINTS, simplifyLine } from './shapes.js';

/** How far the pen travels between kept points, in screen pixels. */
const STROKE_STEP_PX = 3;
/**
 * How far a simplified stroke may stray from what was drawn, as a fraction of
 * the picture: about two pixels on a picture a thousand wide. Doubled until the
 * stroke fits the cap, as `simplifyPath` does.
 */
const STROKE_TOLERANCE = 0.002;

export interface Pointing {
  /** Abandons whatever the button is doing, for a picture that came down or
   *  changed under it. Sends nothing. */
  reset(): void;
}

export function createPointing(
  overlay: HTMLElement,
  /** The stage underneath, whose box the fit rectangle is measured in. */
  canvas: HTMLCanvasElement,
  marks: BackdropMarks,
  /** Where the picture is drawn now, or null with none up. */
  fit: () => Rect | null,
  /** The room's pointer switch, read at each send as `input.ts` reads it. */
  showCursors: () => boolean,
  send: (msg: ClientMsg) => void,
): Pointing {
  /** The left button, from going down until it comes up. */
  let press: {
    pointerId: number;
    from: Vec2;
    /** The last point kept, in screen pixels. */
    last: Vec2;
    /** The ping being timed, or null once it fired or the press moved. */
    timer: number | null;
    /** The ping fired, so the rest of the press is spent. */
    fired: boolean;
  } | null = null;
  let lastCursorSentAt = -Infinity;

  const local = (e: PointerEvent): Vec2 => {
    const box = canvas.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  };

  const fracAt = (p: Vec2): Frac | null => {
    const f = fit();
    return f === null ? null : screenToFrac(f, p);
  };

  const end = (): void => {
    if (press === null) return;
    if (press.timer !== null) window.clearTimeout(press.timer);
    if (overlay.hasPointerCapture(press.pointerId)) overlay.releasePointerCapture(press.pointerId);
    marks.pings.drop();
    marks.drawing = null;
    press = null;
  };

  const firePing = (): void => {
    if (press === null) return;
    press.timer = null;
    press.fired = true;
    const at = marks.pings.commit();
    if (at !== null) send({ type: 'point', gesture: { kind: 'ping', at: { x: at.x, y: at.y } } });
  };

  overlay.addEventListener('contextmenu', (e) => e.preventDefault());

  overlay.addEventListener('pointerdown', (e) => {
    if (press !== null) return;
    if (e.button !== 0) {
      // The middle button would otherwise start autoscroll.
      e.preventDefault();
      return;
    }
    const p = local(e);
    const at = fracAt(p);
    // A press on the letterbox bars points at nothing.
    if (at === null || !onPicture(at)) return;
    e.preventDefault();
    overlay.setPointerCapture(e.pointerId);
    marks.pings.hold(at, performance.now());
    press = {
      pointerId: e.pointerId,
      from: p,
      last: p,
      timer: window.setTimeout(firePing, HOLD_MS),
      fired: false,
    };
  });

  overlay.addEventListener('pointermove', (e) => {
    const p = local(e);
    const at = fracAt(p);
    if (at === null) return;

    // Before the pen, as on the board: where a hand is doesn't depend on what
    // it's doing. Leading edge only, for `sendCursor`'s reason in `input.ts`.
    const now = performance.now();
    if (showCursors() && onPicture(at) && now - lastCursorSentAt >= CURSOR_SEND_INTERVAL_MS) {
      lastCursorSentAt = now;
      send({ type: 'point', gesture: { kind: 'cursor', at: { x: at.x, y: at.y } } });
    }

    if (press === null || e.pointerId !== press.pointerId || press.fired) return;
    if (marks.drawing === null) {
      // Still a hold until it moves past the board's slop, and then a stroke
      // for good: the ring is dropped and can't fire under the pen.
      if (Math.hypot(p.x - press.from.x, p.y - press.from.y) <= HOLD_SLOP_PX) return;
      if (press.timer !== null) window.clearTimeout(press.timer);
      press.timer = null;
      marks.pings.drop();
      const from = fracAt(press.from);
      if (from === null) return;
      marks.drawing = [clampToPicture(from), clampToPicture(at)];
      press.last = p;
      return;
    }
    if (Math.hypot(p.x - press.last.x, p.y - press.last.y) < STROKE_STEP_PX) return;
    marks.drawing.push(clampToPicture(at));
    press.last = p;
  });

  overlay.addEventListener('pointerup', (e) => {
    if (press === null || e.pointerId !== press.pointerId) return;
    const drawn = marks.drawing;
    if (drawn !== null) {
      // Sent whole on release, like a freehand path, and never sketched.
      const at = fracAt(local(e));
      if (at !== null) drawn.push(clampToPicture(at));
      const points = simplifyLine(drawn, STROKE_TOLERANCE, MAX_PATH_POINTS).map((q) => ({
        x: q.x,
        y: q.y,
      }));
      if (points.length >= 2) {
        send({ type: 'point', gesture: { kind: 'stroke', at: points } });
        marks.addStroke(marks.me, points, performance.now());
      }
    }
    // A hold released early is a click on a picture, which means nothing.
    end();
  });

  overlay.addEventListener('pointercancel', (e) => {
    if (press !== null && e.pointerId === press.pointerId) end();
  });

  return { reset: end };
}

import type { Calibration } from './calibrate.js';
import type { Camera, Vec2 } from './coords.js';
import { gridToWorld, screenToWorld, worldToGrid } from './coords.js';
import type { Identity } from './identity.js';
import { canMove } from './identity.js';
import type { ClientMsg } from './protocol.js';
import type { Scene, Token } from './scene.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_SENSITIVITY = 0.0015;
/** Firefox reports wheel deltas in lines; treat one line as this many pixels. */
const LINE_HEIGHT_PX = 16;
/** ~25 Hz. Smooth enough to watch, far below what the room needs to absorb. */
const DRAG_SEND_INTERVAL_MS = 40;

type Drag =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; moved: boolean }
  | { kind: 'token'; pointerId: number; token: Token; grabDX: number; grabDY: number }
  | { kind: 'calibrate'; pointerId: number; x0: number; y0: number };

export interface InputState {
  /** Non-null while a token is being dragged. Drives the drag highlight. */
  readonly draggingId: string | null;
  /** Pointer position in grid units, or null when the pointer is off-canvas. */
  readonly cursorGrid: Vec2 | null;
}

/**
 * Wires pointer and wheel handling onto the canvas. `cam` is mutated in place,
 * as are the dragged token's coordinates — the client predicts locally rather
 * than waiting for the round trip.
 *
 *   left-drag on a token you own   move it
 *   left-drag on anything else     pan
 *   middle-drag                    pan
 *   wheel                          zoom, anchored on the cursor
 *
 * While the DM has calibrate mode on, left-drag draws a grid reference box
 * instead. Middle-drag still pans, so the map can be moved without leaving it.
 *
 * Tokens that are not yours are transparent to the pointer, so dragging across
 * one pans the map instead of feeling broken. The server re-checks regardless;
 * this is an affordance, not the permission boundary.
 */
export function attachInput(
  canvas: HTMLCanvasElement,
  cam: Camera,
  scene: Scene,
  identity: Identity,
  send: (msg: ClientMsg) => void,
  /** The DM's calibration tool. Null for players, who have no such mode. */
  calibration: Calibration | null,
  /**
   * Told which token the DM has picked up, or null when a click lands on empty
   * map. Null for players, who have nothing to select tokens for.
   */
  onSelect: ((id: string | null) => void) | null,
): InputState {
  let drag: Drag | null = null;
  let lastDragSentAt = 0;
  let trailingSend: number | null = null;
  const state = { draggingId: null as string | null, cursorGrid: null as Vec2 | null };

  const localPoint = (e: PointerEvent | WheelEvent): Vec2 => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const sendMove = (token: Token, dragging: boolean): void => {
    send({ type: 'move_token', id: token.id, x: token.x, y: token.y, dragging });
  };

  const cancelTrailingSend = (): void => {
    if (trailingSend === null) return;
    window.clearTimeout(trailingSend);
    trailingSend = null;
  };

  /**
   * Leading-and-trailing throttle. The trailing edge is not optional: without
   * it, a drag that stops moving leaves every other client rendering the last
   * frame that happened to fall on an interval boundary, which can be most of a
   * cell behind the cursor, until the drop corrects it.
   */
  const sendDragFrame = (token: Token): void => {
    const now = performance.now();
    const sinceLast = now - lastDragSentAt;

    if (sinceLast >= DRAG_SEND_INTERVAL_MS) {
      cancelTrailingSend();
      lastDragSentAt = now;
      sendMove(token, true);
      return;
    }

    if (trailingSend !== null) return; // one is already pending
    trailingSend = window.setTimeout(() => {
      trailingSend = null;
      lastDragSentAt = performance.now();
      sendMove(token, true); // reads the token's position as of *now*
    }, DRAG_SEND_INTERVAL_MS - sinceLast);
  };

  /** What the cursor should be when nothing is being dragged. */
  const restingCursor = (w: Vec2): string => {
    if (calibration !== null && calibration.active) return 'crosshair';
    return tokenAt(scene, identity, w.x, w.y) !== null ? 'pointer' : 'grab';
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (drag !== null) return;
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault(); // middle button would otherwise start autoscroll

    const p = localPoint(e);
    const w = screenToWorld(cam, p.x, p.y);

    // Calibrating takes the left button over entirely: no token is grabbable
    // and no pan starts, because the box has to be able to begin anywhere.
    if (calibration !== null && calibration.active && e.button === 0) {
      drag = { kind: 'calibrate', pointerId: e.pointerId, x0: w.x, y0: w.y };
      calibration.drag({ x0: w.x, y0: w.y, x1: w.x, y1: w.y });
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'crosshair';
      return;
    }

    const hit = e.button === 0 ? tokenAt(scene, identity, w.x, w.y) : null;

    if (hit !== null) {
      // Grab offset keeps the token from snapping its centre to the cursor.
      const g = worldToGrid(scene.grid, w.x, w.y);
      drag = { kind: 'token', pointerId: e.pointerId, token: hit, grabDX: hit.x - g.x, grabDY: hit.y - g.y };
      state.draggingId = hit.id;
      onSelect?.(hit.id);
      cancelTrailingSend();
      lastDragSentAt = 0; // let the first move through immediately
    } else {
      drag = { kind: 'pan', pointerId: e.pointerId, lastX: p.x, lastY: p.y, moved: false };
    }

    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localPoint(e);
    const w = screenToWorld(cam, p.x, p.y);
    state.cursorGrid = worldToGrid(scene.grid, w.x, w.y);

    if (drag === null) {
      canvas.style.cursor = restingCursor(w);
      return;
    }
    if (drag.pointerId !== e.pointerId) return;

    if (drag.kind === 'calibrate') {
      calibration?.drag({ x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y });
      return;
    }

    if (drag.kind === 'pan') {
      // Panning is purely local — the camera is not shared state.
      cam.x -= (p.x - drag.lastX) / cam.zoom;
      cam.y -= (p.y - drag.lastY) / cam.zoom;
      if (p.x !== drag.lastX || p.y !== drag.lastY) drag.moved = true;
      drag.lastX = p.x;
      drag.lastY = p.y;
      return;
    }

    const g = worldToGrid(scene.grid, w.x, w.y);
    drag.token.x = g.x + drag.grabDX;
    drag.token.y = g.y + drag.grabDY;
    sendDragFrame(drag.token);
  });

  const endDrag = (e: PointerEvent): void => {
    if (drag === null || drag.pointerId !== e.pointerId) return;

    const p = localPoint(e);
    const w = screenToWorld(cam, p.x, p.y);

    if (drag.kind === 'token') {
      // Order matters: a pending trailing frame would otherwise land *after*
      // the drop and put the token back at an unsnapped position.
      cancelTrailingSend();
      // Always sent, never throttled: this frame carries the final position and
      // is what the server snaps to the grid and echoes back.
      sendMove(drag.token, false);
    } else if (drag.kind === 'calibrate') {
      // Not a commit — the tool keeps the box so the cell count can be tuned
      // against it, and stays in calibrate mode until the DM applies.
      calibration?.release({ x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y });
    } else if (!drag.moved) {
      // A click on empty map, as opposed to a pan. Panning is constant, so
      // losing the selection every time the board moves would be maddening.
      onSelect?.(null);
    }

    drag = null;
    state.draggingId = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = restingCursor(w);
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('pointerleave', () => {
    if (drag === null) state.cursorGrid = null;
  });

  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = localPoint(e);
      const delta = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * LINE_HEIGHT_PX : e.deltaY;

      // Anchor the zoom: whatever world point is under the cursor stays there.
      const anchor = screenToWorld(cam, p.x, p.y);
      cam.zoom = clamp(cam.zoom * Math.exp(-delta * ZOOM_SENSITIVITY), MIN_ZOOM, MAX_ZOOM);
      cam.x = anchor.x - p.x / cam.zoom;
      cam.y = anchor.y - p.y / cam.zoom;
    },
    { passive: false },
  );

  return state;
}

/**
 * Topmost *grabbable* token under a world point, or null. Iterates in reverse
 * draw order. Tokens you cannot move are skipped rather than returned-and-
 * rejected, so a token sitting on top of yours never blocks you from grabbing
 * your own.
 */
function tokenAt(scene: Scene, identity: Identity, wx: number, wy: number): Token | null {
  for (let i = scene.tokens.length - 1; i >= 0; i--) {
    const token = scene.tokens[i];
    if (token === undefined) continue;
    if (!canMove(identity, token)) continue;
    const radius = (scene.grid.px * token.size) / 2;
    const centre = gridToWorld(scene.grid, token.x, token.y);
    if (Math.hypot(wx - centre.x, wy - centre.y) <= radius) return token;
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

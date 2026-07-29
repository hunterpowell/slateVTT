import type { Calibration } from './calibrate.js';
import type { Camera, Vec2 } from './coords.js';
import { gridToWorld, screenToWorld, worldToGrid } from './coords.js';
import type { DrawTool } from './drawtool.js';
import type { Identity } from './identity.js';
import { canMove } from './identity.js';
import type { ClientMsg, ShapeKind, WireOrigin } from './protocol.js';
import type { Rulers } from './ruler.js';
import type { Scene, Token } from './scene.js';
import { shownBoard, shownPos, showingStaged } from './scene.js';
import type { Sketches } from './shapes.js';
import { anchorable, clampExtent, erasableAt, originCell } from './shapes.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_SENSITIVITY = 0.0015;
/** Firefox reports wheel deltas in lines; treat one line as this many pixels. */
const LINE_HEIGHT_PX = 16;
/** ~25 Hz. Smooth enough to watch, far below what the room needs to absorb. */
const DRAG_SEND_INTERVAL_MS = 40;
/** How far the pointer may wander during a click on a shape before it counts as
 *  a sweep instead. A hand on a mouse is never perfectly still. */
const DRAW_CLICK_SLOP_PX = 4;

type Drag =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; moved: boolean }
  | {
      kind: 'token';
      pointerId: number;
      token: Token;
      grabDX: number;
      grabDY: number;
      /**
       * This drag writes the token's plan for the staged map rather than its
       * position. Fixed when the token is picked up rather than read per frame,
       * so a drag cannot change which of the two it is halfway through.
       */
      staged: boolean;
    }
  | { kind: 'calibrate'; pointerId: number; x0: number; y0: number }
  | {
      kind: 'draw';
      pointerId: number;
      /**
       * What is being swept, and whether letting go keeps it.
       *
       * Held on the drag rather than read off the tool per frame, for the reason
       * a token drag holds its `staged` flag: a sweep cannot change into another
       * shape halfway through. It also has to survive the tool being *put away*
       * mid-sweep — Escape sets the tool to null, and a release frame that never
       * went out leaves a line stranded on five other screens.
       */
      tool: ShapeKind;
      keeps: boolean;
      color: string;
      /** Where the sweep began, in grid units: the centre of the cell it
       *  started in, or the anchor token's own position. */
      at: Vec2;
      /** Where the pointer went down, in screen pixels. What separates a sweep
       *  from a click — see `moved`. */
      fromX: number;
      fromY: number;
      /** How far it has been swept, as an offset from `at` — the same offset
       *  the shape is stored as. Kept on the drag rather than passed around so
       *  a throttled trailing frame carries where the sweep is *now*, which is
       *  the same reason a token drag reads its position back off the token. */
      to: Vec2;
      /** The token it will anchor to when kept, or null. Fixed at pointerdown
       *  rather than read per frame, so a sweep that happens to pass over a
       *  creature does not adopt it halfway through. */
      anchor: string | null;
      /**
       * Whether the pointer has actually gone anywhere. A sweep that never
       * moves is a click, and a click is how a shape gets erased.
       *
       * Measured in screen pixels against where the button went down, and not —
       * as it was before the origin snapped — by asking whether the offset is
       * still zero. Snapping the origin to a cell centre means the offset is up
       * to half a cell the moment the pointer twitches, so that test would turn
       * every erase into a small kept circle.
       */
      moved: boolean;
    };

export interface InputState {
  /** Non-null while a token is being dragged. Drives the drag highlight. */
  readonly draggingId: string | null;
  /** Pointer position in grid units, or null when the pointer is off-canvas. */
  readonly cursorGrid: Vec2 | null;
  /** The shape a click would erase, while the draw tool is in hand. */
  readonly hoveredShapeId: string | null;
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
 * While the DM is previewing a staged map, tokens drag exactly as they do on
 * the board — everything you do in preview happens on promote. What changes is
 * only which position the drag writes: the plan, not the token. Routing it is
 * one flag on the command and one branch here.
 *
 * Tokens that are not yours are transparent to the pointer, so dragging across
 * one pans the map instead of feeling broken. The server re-checks regardless;
 * this is an affordance, not the permission boundary.
 *
 * While a shape tool is in hand the left button is taken over the same way
 * calibrate takes it: left-drag sweeps a shape and left-click erases one, so
 * nothing can be grabbed or panned by accident. Middle-drag still pans, which is
 * what makes drawing across a map larger than the window bearable.
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
  /**
   * Movement rulers. This is where our own drag's origin is captured — nothing
   * on the wire says where a drag began, and by the time the first frame is sent
   * the token has already moved.
   */
  rulers: Rulers,
  /** The shape tool, and where our own in-progress sweep is kept so the
   *  renderer can draw it without waiting for a round trip. */
  drawTool: DrawTool,
  sketches: Sketches,
): InputState {
  let drag: Drag | null = null;
  let lastDragSentAt = 0;
  let trailingSend: number | null = null;
  const state = {
    draggingId: null as string | null,
    cursorGrid: null as Vec2 | null,
    hoveredShapeId: null as string | null,
  };

  const localPoint = (e: PointerEvent | WheelEvent): Vec2 => {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  /** Whether what is on screen is the staged map, and so what a drag writes. */
  const previewing = (): boolean => showingStaged(scene);

  /**
   * Whether the left button belongs to a shape tool right now.
   *
   * Never over a staged map. Shapes belong to the board, and the map being
   * prepared has none — so rather than sweep one that would land somewhere
   * nobody is looking, the pointer goes back to being a pointer and preview
   * behaves exactly as it did before this milestone.
   */
  const sweeping = (): boolean => drawTool.kind !== null && !previewing();

  /** Moves a token, or its plan, to a cell — the local prediction half. */
  const predict = (drag: Extract<Drag, { kind: 'token' }>, x: number, y: number): void => {
    if (drag.staged) {
      drag.token.stagedPos = { x, y };
    } else {
      drag.token.x = x;
      drag.token.y = y;
    }
  };

  const sendMove = (drag: Extract<Drag, { kind: 'token' }>, dragging: boolean): void => {
    // Read back off the token rather than passed in, so the trailing frame
    // below sends where the token is *now* rather than where it was queued.
    const at = drag.staged ? drag.token.stagedPos : drag.token;
    // Null is a token in preview that has not actually been dragged anywhere:
    // clicking one to edit it in the panel must not plan a move it did not
    // make. There is no command to un-plan, so an accidental plan would stay.
    if (at === null) return;
    send({
      type: 'move_token',
      id: drag.token.id,
      x: at.x,
      y: at.y,
      dragging,
      staged: drag.staged,
    });
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
  const sendDragFrame = (drag: Extract<Drag, { kind: 'token' }>): void => {
    const now = performance.now();
    const sinceLast = now - lastDragSentAt;

    if (sinceLast >= DRAG_SEND_INTERVAL_MS) {
      cancelTrailingSend();
      lastDragSentAt = now;
      sendMove(drag, true);
      return;
    }

    if (trailingSend !== null) return; // one is already pending
    trailingSend = window.setTimeout(() => {
      trailingSend = null;
      lastDragSentAt = performance.now();
      sendMove(drag, true); // reads the position as of *now*
    }, DRAG_SEND_INTERVAL_MS - sinceLast);
  };

  /**
   * A sweep frame, throttled exactly as a token drag is and for the same
   * reason: it lands on five other screens, and `pointermove` fires far faster
   * than anybody needs to watch a circle grow.
   *
   * The trailing edge matters more here than it does for a token, because a
   * sweep usually *ends* by stopping: let go a frame after the last interval
   * boundary and every watcher is left holding a circle a cell short of the one
   * that got kept.
   */
  const sendSketchFrame = (d: Extract<Drag, { kind: 'draw' }>): void => {
    // Read off the drag rather than passed in, so a trailing frame carries
    // where the sweep is *now* rather than where it was when it was queued.
    const emit = (): void => {
      send({ type: 'sketch', kind: d.tool, at: d.at, to: d.to, color: d.color, drawing: true });
    };

    const now = performance.now();
    const sinceLast = now - lastDragSentAt;
    if (sinceLast >= DRAG_SEND_INTERVAL_MS) {
      cancelTrailingSend();
      lastDragSentAt = now;
      emit();
      return;
    }
    if (trailingSend !== null) return;
    trailingSend = window.setTimeout(() => {
      trailingSend = null;
      lastDragSentAt = performance.now();
      emit();
    }, DRAG_SEND_INTERVAL_MS - sinceLast);
  };

  /** Our own copy of the sweep, so it draws under the cursor without waiting
   *  for a round trip the server would not send us anyway. */
  const showOwnSketch = (d: Extract<Drag, { kind: 'draw' }>): void => {
    sketches.own({ kind: d.tool, at: d.at, to: d.to, color: d.color });
  };

  /** What the cursor should be when nothing is being dragged. */
  const restingCursor = (w: Vec2): string => {
    if (calibration !== null && calibration.active) return 'crosshair';
    if (sweeping()) return state.hoveredShapeId !== null ? 'pointer' : 'crosshair';
    return tokenAt(scene, identity, w.x, w.y) !== null ? 'pointer' : 'grab';
  };

  /** Grid units under a screen point, on whichever board is being shown. */
  const gridUnder = (w: Vec2): Vec2 => worldToGrid(shownBoard(scene).grid, w.x, w.y);

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

    // And so does a shape tool, for the same reason: a circle has to be able to
    // start on top of a creature, which is exactly where most of them start.
    const tool = drawTool.kind;
    if (tool !== null && sweeping() && e.button === 0) {
      // Starting on a token anchors to it, so an aura follows whoever it
      // belongs to. Alt sweeps straight through, for the circle that happens to
      // be centred on somebody without being about them.
      const on = e.altKey ? null : anchorTokenAt(scene, w.x, w.y);
      drag = {
        kind: 'draw',
        pointerId: e.pointerId,
        tool,
        keeps: drawTool.keeps,
        color: drawTool.color,
        // A free-placed sweep starts at the centre of the cell it began in, so
        // a circle is centred on a square rather than on wherever in it the
        // pointer happened to land. An anchored one starts at the token's own
        // position instead — an aura is centred on the creature, including a
        // wide one whose centre is a corner where four cells meet.
        at: on === null ? originCell(gridUnder(w)) : { x: on.x, y: on.y },
        anchor: on?.id ?? null,
        to: { x: 0, y: 0 },
        fromX: p.x,
        fromY: p.y,
        moved: false,
      };
      // Nothing is drawn yet. Until the pointer has actually gone somewhere
      // this may still be a click on a shape, and a zero-size sweep under the
      // cursor is a dot and a "0 ft" that flash on every erase.
      cancelTrailingSend();
      lastDragSentAt = 0; // let the first frame through immediately
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'crosshair';
      return;
    }

    const hit = e.button === 0 ? tokenAt(scene, identity, w.x, w.y) : null;

    if (hit !== null) {
      // Grab offset keeps the token from snapping its centre to the cursor, and
      // is measured from wherever the token is *on this board* — its plan while
      // previewing, its own cell otherwise.
      const g = gridUnder(w);
      const from = shownPos(scene, hit) ?? { x: hit.x, y: hit.y };
      drag = {
        kind: 'token',
        pointerId: e.pointerId,
        token: hit,
        grabDX: from.x - g.x,
        grabDY: from.y - g.y,
        staged: previewing(),
      };
      // The same settled position the grab offset is measured from, and the
      // last moment it is knowable: the next pointermove overwrites it.
      rulers.begin(hit.id, from, drag.staged);
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
    state.cursorGrid = gridUnder(w);

    if (drag === null) {
      // What a click would erase, which the renderer draws brighter and the
      // cursor turns into a pointer over. Only asked while a tool is in hand:
      // clicking a shape means nothing otherwise, and hit-testing every shape
      // on every mouse move to light up something unclickable is work spent to
      // mislead.
      state.hoveredShapeId = !sweeping()
        ? null
        : (erasableAt(scene, identity.isDm, identity.playerId, gridUnder(w))?.id ?? null);
      canvas.style.cursor = restingCursor(w);
      return;
    }
    if (drag.pointerId !== e.pointerId) return;

    if (drag.kind === 'calibrate') {
      calibration?.drag({ x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y });
      return;
    }

    if (drag.kind === 'draw') {
      const g = gridUnder(w);
      drag.to = clampExtent({ x: g.x - drag.at.x, y: g.y - drag.at.y });
      // A pointer that has barely left where it went down is still a click, and
      // a click erases. Nothing is sent until it is a sweep, so an erase costs
      // the room no frames at all.
      if (Math.hypot(p.x - drag.fromX, p.y - drag.fromY) > DRAW_CLICK_SLOP_PX) drag.moved = true;
      if (drag.moved) {
        showOwnSketch(drag);
        sendSketchFrame(drag);
      }
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

    const g = gridUnder(w);
    predict(drag, g.x + drag.grabDX, g.y + drag.grabDY);
    sendDragFrame(drag);
  });

  /**
   * Letting go of a sweep. Three things can have happened.
   *
   * A sweep that never moved is a click, and a click on a shape erases it —
   * which is why the coverage rule and the hit test are one function.
   *
   * A sweep that moved always ends with a release frame, so the line comes off
   * everyone else's screen at the same moment it comes off ours. Whether an
   * `add_shape` follows is the only place in this project that knows a measuring
   * line is not a spell area.
   */
  const endSweep = (d: Extract<Drag, { kind: 'draw' }>, at: Vec2): void => {
    sketches.own(null);

    if (!d.moved) {
      // No frame was ever sent for this one, so there is no release to send.
      const shape = erasableAt(scene, identity.isDm, identity.playerId, at);
      if (shape !== null) send({ type: 'remove_shape', id: shape.id });
      return;
    }

    // Order matters, exactly as it does on a token drop: a queued trailing frame
    // landing after the release would leave a line on five screens with nothing
    // left to end it.
    cancelTrailingSend();
    send({ type: 'sketch', kind: d.tool, at: d.at, to: d.to, color: d.color, drawing: false });

    if (!d.keeps) return;
    const from: WireOrigin =
      d.anchor === null ? { kind: 'point', at: d.at } : { kind: 'token', at: d.anchor };
    send({ type: 'add_shape', kind: d.tool, from, to: d.to, color: d.color });
  };

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
      sendMove(drag, false);
      // The measuring is over the moment the token is let go. Everyone else
      // drops theirs on the drop frame this just sent.
      rulers.end(drag.token.id);
    } else if (drag.kind === 'calibrate') {
      // Not a commit — the tool keeps the box so the cell count can be tuned
      // against it, and stays in calibrate mode until the DM applies.
      calibration?.release({ x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y });
    } else if (drag.kind === 'draw') {
      endSweep(drag, gridUnder(w));
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
    if (drag === null) {
      state.cursorGrid = null;
      state.hoveredShapeId = null;
    }
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
 *
 * Hit-testing runs against `shownPos`, exactly as drawing does — the pointer has
 * to agree with the picture, and a token absent from this board is not under the
 * cursor whatever its other position happens to be.
 */
function tokenAt(scene: Scene, identity: Identity, wx: number, wy: number): Token | null {
  const board = shownBoard(scene);

  for (let i = scene.tokens.length - 1; i >= 0; i--) {
    const token = scene.tokens[i];
    if (token === undefined) continue;
    if (!canMove(identity, token)) continue;
    const at = shownPos(scene, token);
    if (at === null) continue;
    const radius = (board.grid.px * token.size) / 2;
    const centre = gridToWorld(board.grid, at.x, at.y);
    if (Math.hypot(wx - centre.x, wy - centre.y) <= radius) return token;
  }
  return null;
}

/**
 * The topmost token a shape could anchor to under a world point, or null.
 *
 * Deliberately not `tokenAt`: anchoring is not moving, so a player may hang an
 * aura on the paladin they do not own, or on the ogre. Any token they can see is
 * a token they can draw on — the server checks visibility, not ownership.
 *
 * Staged-only tokens are skipped because they have no live position to follow,
 * which is the same reason they are not on the live board at all.
 */
function anchorTokenAt(scene: Scene, wx: number, wy: number): Token | null {
  const board = shownBoard(scene);

  for (let i = scene.tokens.length - 1; i >= 0; i--) {
    const token = scene.tokens[i];
    if (token === undefined || !anchorable(token)) continue;
    const radius = (board.grid.px * token.size) / 2;
    const centre = gridToWorld(board.grid, token.x, token.y);
    if (Math.hypot(wx - centre.x, wy - centre.y) <= radius) return token;
  }
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

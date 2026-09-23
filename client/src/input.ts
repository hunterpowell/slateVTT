import type { Calibration } from './calibrate.js';
import type { Camera, Vec2 } from './coords.js';
import { gridToWorld, screenToWorld, worldToGrid } from './coords.js';
import type { DrawTool } from './drawtool.js';
import type { FogTool } from './fogtool.js';
import type { Identity } from './identity.js';
import { canMove } from './identity.js';
import type { Pings } from './pings.js';
import { HOLD_MS } from './pings.js';
import type { ClientMsg, ShapeKind, WireOrigin } from './protocol.js';
import type { Rulers } from './ruler.js';
import type { Scene, Token } from './scene.js';
import { shownBoard, shownPos, shownWalls, showingStaged } from './scene.js';
import type { Sketches } from './shapes.js';
import { anchorable, clampExtent, erasableAt, hasExtent, snapExtent, snapOrigin } from './shapes.js';
import type { WallTool } from './walltool.js';
import { snapToCorner, wallAt } from './walls.js';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const ZOOM_SENSITIVITY = 0.0015;
/** Firefox reports wheel deltas in lines; treat one line as this many pixels. */
const LINE_HEIGHT_PX = 16;
/** ~25 Hz. Smooth enough to watch, far below what the room needs to absorb. */
const DRAG_SEND_INTERVAL_MS = 40;
/**
 * How often our own pointer goes out, in milliseconds (~30Hz).
 *
 * Faster than a drag frame. Don't slow it to match on the grounds that a
 * pointer is ambient and the busiest message in the protocol: at half this
 * rate it stuttered in play. A token drag is a slow object everybody watches
 * land, while a hand moves quickly, so a rate that looks fine on a token looks
 * jerky on a cursor.
 *
 * Seven clients make this affordable. If it ever isn't, the room's
 * `show_cursors` switch is the coarse control and this number the fine one.
 */
const CURSOR_SEND_INTERVAL_MS = 33;
/** How far the pointer may wander during a click on a shape before it counts as
 *  a sweep instead. A hand on a mouse is never perfectly still. */
const DRAW_CLICK_SLOP_PX = 4;
/**
 * How far a press may wander and still be a hold that pings.
 *
 * **Must equal the slop above.** A press with a shape tool in hand is measured
 * against both at once: past this it is no longer a hold, and past that it is a
 * sweep that has started sending frames. If this were larger, a press could
 * start sweeping and then still fire, killing a sketch that five other screens
 * had already been shown, with no release frame to remove it from them. Equal,
 * and checked first on every move, means a ping can never fire after a sketch
 * frame has gone out.
 */
const HOLD_SLOP_PX = DRAW_CLICK_SLOP_PX;
/** How near a wall a click has to land to hit it, in *screen* pixels, so a
 *  segment stays as easy to hit zoomed out as zoomed in. */
const WALL_HIT_PX = 8;

type Drag =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; moved: boolean }
  | {
      kind: 'token';
      pointerId: number;
      /**
       * Every token this drag moves, each with its own offset from the pointer.
       *
       * Usually one. A group selected with shift-click moves as a rigid body:
       * the offsets are captured once at pointerdown, so the group keeps its
       * formation however far the pointer travels.
       *
       * Each token still lands on its own cell. The offsets are in grid units
       * and the server snaps every token separately, so a group of mixed sizes
       * can settle half a cell off the spacing it started with. Don't snap the
       * group here: `snap_to_cell` depends on token width and is the only copy
       * of that rule.
       */
      tokens: readonly Grabbed[];
      /**
       * The one the pointer went down on. It is the only member with a ruler
       * (see `rulers.begin` at the grab), and the panel's selection follows it.
       */
      anchorId: string;
      /**
       * This drag writes the tokens' plans for the staged map, not their
       * positions. Fixed at pickup instead of read per frame, so a drag can't
       * switch between the two halfway through.
       */
      staged: boolean;
    }
  | { kind: 'calibrate'; pointerId: number; x0: number; y0: number }
  /**
   * The DM painting cells of the fog override by hand.
   *
   * The simplest of the five: nothing to predict, nothing to throttle, and no
   * frame goes out until the button is released. The stroke accumulates on the
   * tool and is sent as one command, because a frame per cell would be a
   * hundred of them across one drag. A fill is a click, and is handled without
   * a drag.
   */
  | { kind: 'fog'; pointerId: number }
  | {
      kind: 'draw';
      pointerId: number;
      /**
       * What is being swept, and whether letting go keeps it.
       *
       * Held on the drag instead of read off the tool per frame, like a token
       * drag's `staged` flag, so a sweep can't change shape halfway through. It
       * also has to survive the tool being put away mid-sweep: Escape sets the
       * tool to null, and a release frame that never went out leaves a line
       * stranded on five other screens.
       */
      tool: ShapeKind;
      keeps: boolean;
      color: string;
      /** Where the sweep began, in grid units: the centre of the cell it
       *  started in, or the anchor token's own position. */
      at: Vec2;
      /** Where the pointer went down, in screen pixels. Separates a sweep from
       *  a click (see `moved`). */
      fromX: number;
      fromY: number;
      /** How far it has been swept, as an offset from `at` (the same offset the
       *  shape is stored as). Kept on the drag so a throttled trailing frame
       *  carries where the sweep is now, as a token drag reads its position
       *  back off the token. */
      to: Vec2;
      /** The token it will anchor to when kept, or null. Fixed at pointerdown,
       *  so a sweep that passes over a creature doesn't adopt it halfway
       *  through. */
      anchor: string | null;
      /**
       * Whether the pointer has gone anywhere. A sweep that never moves is a
       * click, and a click erases a shape.
       *
       * Measured in screen pixels against where the button went down. Don't
       * test whether the offset is still zero: the origin snaps to a cell
       * centre, so the offset is up to half a cell the moment the pointer
       * twitches, and that test would turn every erase into a small kept
       * circle.
       */
      moved: boolean;
    };

/** One token held by a drag, and where it sits relative to the pointer. */
interface Grabbed {
  token: Token;
  grabDX: number;
  grabDY: number;
}

export interface InputState {
  /** Every token currently being dragged. Drives the drag highlight. A set
   *  because a shift-click group moves together. Empty when nothing is being
   *  dragged. */
  readonly draggingIds: ReadonlySet<string>;
  /**
   * The tokens shift-click has gathered into a group, which a drag on any one
   * of them moves together.
   *
   * Empty is the ordinary case and means "no group": a plain click drags
   * whatever it landed on and nothing else. Only shift-clicking puts anything
   * in here, so no gesture without the modifier is affected.
   *
   * It can only hold tokens this client may move, with no rule of its own:
   * membership comes from `tokenAt`, which already ignores everybody else's
   * tokens. A player grouping their own two summons is ordinary `can_move`.
   */
  readonly selection: ReadonlySet<string>;
  /** Pointer position in grid units, or null when the pointer is off-canvas. */
  readonly cursorGrid: Vec2 | null;
  /** The shape a click would erase, while the draw tool is in hand. */
  readonly hoveredShapeId: string | null;
}

/**
 * Wires pointer and wheel handling onto the canvas. `cam` is mutated in place,
 * as are the dragged token's coordinates: the client predicts locally instead
 * of waiting for the round trip.
 *
 *   left-drag on a token you own   move it
 *   left-drag on anything else     pan
 *   middle-drag                    pan
 *   wheel                          zoom, anchored on the cursor
 *
 * While the DM has calibrate mode on, left-drag draws a grid reference box
 * instead. Middle-drag still pans, so the map can be moved without leaving it.
 *
 * While the DM is previewing a staged map, tokens drag as they do on the
 * board, and everything done in preview takes effect on promote. The only
 * difference is which position the drag writes: the plan, not the token. That
 * is one flag on the command and one branch here.
 *
 * Tokens that are not yours are transparent to the pointer, so dragging across
 * one pans the map instead of doing nothing. The server re-checks regardless;
 * this is an affordance, not the permission boundary.
 *
 * While a shape tool is in hand it takes the left button as calibrate does:
 * left-drag sweeps a shape and left-click erases one, so nothing can be
 * grabbed or panned by accident. Middle-drag still pans, so a shape can be
 * drawn across a map larger than the window.
 *
 * The wall editor is the fourth thing that can hold the left button, and the
 * only one with no drag: a click places a corner and a double-click ends the
 * run. Nothing is captured, so nothing has to be released, and a browser that
 * closes mid-trace leaves nothing on anyone else's screen (unlike a sketch or
 * a drag).
 *
 * The fog brush is the fifth, with two gestures: a fill is a click that commits
 * the region already being previewed, and a paint stroke is a drag whose cells
 * accumulate on the tool and go out as one command when the button comes up.
 * Nothing is predicted or throttled, because the preview has already shown the
 * result and there is no round trip to hide.
 *
 * Only one of the five can be armed at a time. Calibrate wins over the wall
 * editor, the wall editor over the fog brush, and the fog brush over a shape
 * tool, in the order they are tested below; the panels also put each other away,
 * so that ordering should never decide anything in practice.
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
   * Movement rulers. Our own drag's origin is captured here: nothing on the
   * wire says where a drag began, and by the time the first frame is sent the
   * token has already moved.
   */
  rulers: Rulers,
  /** The shape tool, and where our own in-progress sweep is kept so the
   *  renderer can draw it without waiting for a round trip. */
  drawTool: DrawTool,
  sketches: Sketches,
  /** The DM's wall editor. Null for players, who have no such panel and are
   *  never sent a wall to click on in the first place. */
  wallTool: WallTool | null,
  /** The DM's fog brush. Null for players, who have no such panel and no
   *  overrides in their scene for one to edit. */
  fogTool: FogTool | null,
  /** The rings. Everybody has these. Our own hold is timed, previewed and
   *  fired from here. */
  pings: Pings,
): InputState {
  let drag: Drag | null = null;
  let lastDragSentAt = 0;
  let lastCursorSentAt = 0;
  let trailingSend: number | null = null;
  const state = {
    draggingIds: new Set<string>(),
    selection: new Set<string>(),
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
   * Never over a staged map. Shapes belong to the board and the map being
   * prepared has none, so over it the pointer behaves as it would with no tool
   * armed, instead of sweeping a shape somewhere nobody is looking.
   */
  const sweeping = (): boolean => drawTool.kind !== null && !previewing();

  /**
   * Whether the left button belongs to the wall editor right now.
   *
   * Armed over either board, unlike `sweeping`: the staged map has walls of
   * its own, so tracing one there is real. A sweep belongs to the board alone
   * because there are no staged shapes.
   */
  const tracing = (): boolean => wallTool !== null && wallTool.mode !== null;

  /**
   * Whether the left button belongs to the fog brush right now.
   *
   * Armed over either board, like the wall editor and for the same reason: the
   * staged map has a mask of its own. It has no fog, so what the DM paints
   * there is the mask the party will be given, not a preview of what they will
   * see.
   */
  const painting = (): boolean => fogTool !== null && fogTool.brush !== null;

  /** How near a wall counts as on it, in world units at this zoom. */
  const wallSlack = (): number => WALL_HIT_PX / cam.zoom;

  /** The wall under a world point, or null. Walls are in image pixels, which is
   *  world space, so there is no conversion.
   *
   *  Through `shownWalls`, so a click hit-tests the walls of the board on
   *  screen, which may be the staged one. */
  const wallUnder = (w: Vec2) => wallAt(shownWalls(scene), w, wallSlack());

  /**
   * A door the DM could swing right now, with no tool in hand at all.
   *
   * Opening a door happens mid-fight, several times an evening, while the DM
   * is dragging monsters around. Requiring the wall editor to be armed first
   * would put a modal tool in the way every time the party opens a door.
   *
   * So this ignores the wall editor's mode and is available whenever nothing
   * else has claimed the left button. Calibrating, a shape tool and the wall
   * editor each give a click its own meaning, and none of them should also
   * swing a door.
   *
   * Only the DM, and only doors: solid walls aren't interactive, and
   * `shownWalls` is empty on a player's client anyway, so this is an
   * affordance, not the permission boundary. The server refuses it from anyone
   * else regardless.
   *
   * Also available over the staged board. There a swing sets which doors the
   * party finds open, instead of being play. The click is the same because a
   * door should always be clickable.
   */
  const swingableDoorUnder = (w: Vec2) => {
    if (!identity.isDm) return null;
    if (tracing() || sweeping()) return null;
    if (calibration !== null && calibration.active) return null;
    const wall = wallUnder(w);
    return wall !== null && wall.door !== null ? wall : null;
  };

  /**
   * Where a corner would land: the nearest grid corner, or where the pointer
   * is when Alt is down.
   *
   * Free placement is what makes a diagonal cave wall traceable on a square
   * grid. Alt means what it means to the draw tool: don't snap to what this
   * would otherwise attach to.
   */
  const cornerAt = (w: Vec2, free: boolean): Vec2 =>
    free ? w : snapToCorner(shownBoard(scene).grid, w);

  /** Moves every held token, or its plan, to where the pointer now puts it:
   *  the local prediction. Each keeps the offset it was grabbed at. */
  const predict = (drag: Extract<Drag, { kind: 'token' }>, g: Vec2): void => {
    for (const held of drag.tokens) {
      const x = g.x + held.grabDX;
      const y = g.y + held.grabDY;
      if (drag.staged) {
        held.token.stagedPos = { x, y };
      } else {
        held.token.x = x;
        held.token.y = y;
      }
    }
  };

  /**
   * One `move_token` per held token. A group is N ordinary commands, not a
   * batched one, so the room needs nothing new: it takes these one at a time,
   * checks `can_move` on each, and snaps each to its own cell.
   *
   * The throttle is per drag, not per token, so a group of six sends six frames
   * on each tick instead of six independent streams. The room sees one token's
   * rate multiplied by the size of the group.
   */
  const sendMove = (drag: Extract<Drag, { kind: 'token' }>, dragging: boolean): void => {
    for (const held of drag.tokens) {
      // Read back off the token instead of passed in, so the trailing frame
      // below sends where the token is now, not where it was when queued.
      const at = drag.staged ? held.token.stagedPos : held.token;
      // Null is a token in preview that hasn't been dragged anywhere: clicking
      // one to edit it in the panel must not plan a move it didn't make. There
      // is no command to un-plan, so an accidental plan would stay.
      if (at === null) continue;
      send({
        type: 'move_token',
        id: held.token.id,
        x: at.x,
        y: at.y,
        dragging,
        staged: drag.staged,
      });
    }
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
   * A sweep frame, throttled as a token drag is and for the same reason: it
   * lands on five other screens, and `pointermove` fires far faster than
   * anybody needs to watch a circle grow.
   *
   * The trailing edge matters more here than for a token, because a sweep
   * usually ends by stopping. Without it, letting go a frame after the last
   * interval boundary leaves every watcher with a circle a cell short of the
   * one that was kept.
   */
  const sendSketchFrame = (d: Extract<Drag, { kind: 'draw' }>): void => {
    // Read off the drag instead of passed in, so a trailing frame carries
    // where the sweep is now, not where it was when queued.
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

  /**
   * Where our pointer is, for everybody else's board.
   *
   * Leading edge only, with no trailing send, unlike the two throttles above.
   * Theirs exists because a drag or a sweep ends by stopping and leaves
   * something behind that has to be right; a pointer leaves nothing behind.
   * Without a trailing frame, a hand that stops just after an interval boundary
   * sits up to 33ms stale on other screens until it fades, which nobody can
   * see and no later frame needs to correct.
   *
   * Two guards, both to avoid sending what nobody would see. The room's switch
   * is read here as well as in `message_for`: the server would drop every one
   * of these, so sending would waste 30Hz of frames. And nothing goes out while
   * the DM is previewing the staged map, because a position on that board is
   * in a different map's grid units: the table would see a pointer moving over
   * cells nobody is pointing at. Preview draws no pings or shapes for the same
   * reason.
   */
  const sendCursor = (g: Vec2): void => {
    if (!scene.showCursors || previewing()) return;
    const now = performance.now();
    if (now - lastCursorSentAt < CURSOR_SEND_INTERVAL_MS) return;
    lastCursorSentAt = now;
    send({ type: 'move_cursor', at: { x: g.x, y: g.y } });
  };

  /** Our own copy of the sweep, so it draws under the cursor. The server
   *  doesn't echo sketches to their sender. */
  const showOwnSketch = (d: Extract<Drag, { kind: 'draw' }>): void => {
    sketches.own({ kind: d.tool, at: d.at, to: d.to, color: d.color });
  };

  /**
   * A press being timed to see whether it is a ping.
   *
   * Not a sixth `Drag`. Each `Drag` variant is something the left button is
   * doing; this is an open question about the button, and it runs alongside
   * whichever drag the press also started. A ping is told apart from other
   * presses by **duration, not target**, so it needs no target of its own and
   * doors still swing.
   */
  let hold: {
    pointerId: number;
    /** Where the button went down, in screen pixels. The slop is measured
     *  against it, as a sweep measures its own. */
    fromX: number;
    fromY: number;
    timer: number;
  } | null = null;

  /**
   * The pointer whose release the ping has already eaten, or null.
   *
   * Firing consumes the gesture: the button is still down at that moment, and
   * the `pointerup` that follows must not also drop a token, erase a shape, or
   * swing a door. A flag, not just nulling `drag`, because the release still
   * has to release the pointer capture and restore the cursor.
   */
  let consumed: number | null = null;

  /** Cancels a press being timed without firing it. Safe to call when nothing
   *  is being timed. */
  const cancelHold = (): void => {
    if (hold === null) return;
    window.clearTimeout(hold.timer);
    hold = null;
    pings.drop();
  };

  /**
   * The press lasted. Ping, and take back whatever else the press had started.
   *
   * A press on a token has already called `rulers.begin`, and leaving it would
   * put a zero-length ruler on the board for a move nobody made. A press with a
   * shape tool in hand has a `draw` drag open, which has sent nothing (`moved`
   * is false, or the hold would have been cancelled; see `HOLD_SLOP_PX`), so it
   * needs no release frame, only its local preview cleared. A pan has nothing
   * to take back.
   *
   * The DM's selection is left alone. It happened on the way down, it is
   * visible on the board, and un-selecting a creature somebody just pointed at
   * is the opposite of what they meant.
   */
  const firePing = (): void => {
    if (hold === null) return;
    consumed = hold.pointerId;
    window.clearTimeout(hold.timer);
    hold = null;

    const at = pings.commit();
    if (at !== null) send({ type: 'ping', at: { x: at.x, y: at.y } });

    if (drag === null || drag.pointerId !== consumed) return;
    if (drag.kind === 'token') rulers.forget(drag.anchorId);
    if (drag.kind === 'draw') sketches.own(null);
    drag = null;
    state.draggingIds.clear();
  };

  /**
   * Start timing a press, if a press here could be a ping at all.
   *
   * Nothing while previewing, as with a sweep: the staged map is not the board
   * anyone else is looking at, and a position in its grid units lands somewhere
   * arbitrary on theirs. The three modal tools don't reach here (they return
   * out of `pointerdown` first), but the draw tool does: everybody has it, it
   * is used mid-fight, and a player who leaves it armed between uses must
   * still be able to ping.
   */
  const beginHold = (e: PointerEvent, p: Vec2, at: Vec2): void => {
    if (e.button !== 0 || previewing()) return;
    pings.hold(at, performance.now());
    hold = {
      pointerId: e.pointerId,
      fromX: p.x,
      fromY: p.y,
      timer: window.setTimeout(firePing, HOLD_MS),
    };
  };

  /** What the cursor should be when nothing is being dragged. */
  const restingCursor = (w: Vec2): string => {
    if (calibration !== null && calibration.active) return 'crosshair';
    if (painting()) return 'crosshair';
    if (tracing()) return wallTool?.hovered !== null ? 'pointer' : 'crosshair';
    if (sweeping()) return state.hoveredShapeId !== null ? 'pointer' : 'crosshair';
    if (tokenAt(scene, identity, w.x, w.y) !== null) return 'pointer';
    // Asked after the token, because a token standing in a doorway is what
    // gets grabbed. The door is behind it.
    return swingableDoorUnder(w) !== null ? 'pointer' : 'grab';
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

    // The wall editor takes it too, with no drag: a run is a polyline, so a
    // click is the whole gesture. Nothing is captured, so nothing has to be
    // released.
    if (wallTool !== null && tracing() && e.button === 0) {
      const mode = wallTool.mode;
      const hit = mode === 'wall' ? null : wallUnder(w);

      // A click on an existing door swings it instead of starting a trace on
      // top of it. Only with no run open: mid-trace every click is a corner,
      // so a run can be carried straight over a doorway.
      const swinging =
        mode === 'door' && wallTool.run.length === 0 && hit !== null && hit.door !== null;

      // Both name the slot the editor is on, which is the slot `wallUnder` just
      // hit-tested. Reading it off the tool instead of asking `previewing()`
      // again keeps the hit test and the command from disagreeing.
      const staged = wallTool.staged;
      if (mode === 'erase') {
        if (hit !== null) send({ type: 'remove_wall', id: hit.id, staged });
      } else if (swinging && hit !== null) {
        send({ type: 'toggle_door', id: hit.id, staged });
      } else {
        wallTool.place(cornerAt(w, e.altKey));
      }
      canvas.style.cursor = 'crosshair';
      return;
    }

    // Solo sight, armed from the same panel as the brush. Arming either puts
    // the other down, so at most one of these two blocks can fire.
    //
    // `anchorTokenAt`, not `tokenAt`: the question is what a creature can see,
    // and the interesting one is nearly always a player's. `tokenAt` ignores
    // tokens you can't move, which would let the DM check only their own
    // monsters. Widening it grants nothing: this reads walls the DM already
    // holds and sends nothing.
    if (fogTool !== null && fogTool.checking && e.button === 0) {
      fogTool.check(anchorTokenAt(scene, w.x, w.y));
      canvas.style.cursor = 'crosshair';
      return;
    }

    // The fog brush takes the button the same way. A room to black out usually
    // has creatures standing in it, so nothing under the pointer may be
    // grabbable while the brush is in hand.
    //
    // A fill is a click and commits what the preview is already showing; a
    // paint stroke is a drag, and only it needs capturing.
    if (fogTool !== null && painting() && e.button === 0) {
      const g = gridUnder(w);
      if (fogTool.gesture === 'fill') {
        fogTool.apply(g);
        canvas.style.cursor = 'crosshair';
        return;
      }
      drag = { kind: 'fog', pointerId: e.pointerId };
      fogTool.apply(g);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'crosshair';
      return;
    }

    // Shift-click gathers a token into the group, or drops it back out of one.
    //
    // Above the hold because it can't become anything else: it commits on the
    // way down, has no drag, and must not ping (holding a modifier isn't
    // pointing at the board). It is below the three modal tools, and
    // `sweeping()` keeps it below the shape tool, because an armed tool takes
    // the button first. Ping is the only exception to that.
    //
    // Nothing here calls `onSelect`. The panel edits one token and this gesture
    // is about several, so building a group leaves the form showing whatever
    // was last plain-clicked instead of swapping it out mid-edit.
    if (e.button === 0 && e.shiftKey && !sweeping()) {
      const hit = tokenAt(scene, identity, w.x, w.y);
      if (hit !== null) {
        if (!state.selection.delete(hit.id)) state.selection.add(hit.id);
        return;
      }
    }

    // Past the three modal tools, so anything below this line is a press that
    // could still turn out to be a ping. Started before the branches instead
    // of inside each: a hold on a token, with a shape tool, or on empty map is
    // the same gesture, and separating by duration means none of the branches
    // needs to know about it.
    beginHold(e, p, gridUnder(w));

    // A shape tool takes the button too: a circle has to be able to start on
    // top of a creature, which is where most of them start.
    const tool = drawTool.kind;
    if (tool !== null && sweeping() && e.button === 0) {
      // Starting on a token anchors to it, so an aura follows its creature.
      // Alt skips the anchor, for a circle centred on somebody without being
      // about them.
      const on = e.altKey ? null : anchorTokenAt(scene, w.x, w.y);
      drag = {
        kind: 'draw',
        pointerId: e.pointerId,
        tool,
        keeps: drawTool.keeps,
        color: drawTool.color,
        // An unanchored sweep starts on the nearest point of the half-cell
        // lattice (a centre, a corner or the middle of an edge), so a circle
        // is centred on a square or an intersection, not wherever in the cell
        // the pointer landed. Alt doesn't skip this: on this event it already
        // means "don't anchor", and nobody wants the origin off the grid. An
        // anchored sweep starts at the token's position instead, so an aura is
        // centred on the creature, including a wide one whose centre is a
        // corner where four cells meet.
        at: on === null ? snapOrigin(gridUnder(w)) : { x: on.x, y: on.y },
        anchor: on?.id ?? null,
        to: { x: 0, y: 0 },
        fromX: p.x,
        fromY: p.y,
        moved: false,
      };
      // Nothing is drawn yet. Until the pointer has gone somewhere this may
      // still be a click on a shape, and a zero-size sweep under the cursor
      // would flash a dot and a "0 ft" on every erase.
      cancelTrailingSend();
      lastDragSentAt = 0; // let the first frame through immediately
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'crosshair';
      return;
    }

    const hit = e.button === 0 ? tokenAt(scene, identity, w.x, w.y) : null;

    if (hit !== null) {
      const g = gridUnder(w);
      const staged = previewing();

      // Grabbing a member of the group takes the whole group; grabbing anything
      // else clears the group first, so a plain click on a token outside the
      // group drags only that token.
      const held = state.selection.has(hit.id)
        ? scene.tokens.filter((t) => state.selection.has(t.id))
        : [hit];
      if (!state.selection.has(hit.id)) state.selection.clear();

      // Grab offsets keep the tokens from snapping their centres to the cursor.
      // Each is measured from where the token is on this board: its plan while
      // previewing, its own cell otherwise. A member with no position on this
      // board isn't on it to be dragged.
      const grabbed: Grabbed[] = [];
      for (const token of held) {
        const at = shownPos(scene, token);
        if (at === null) continue;
        grabbed.push({ token, grabDX: at.x - g.x, grabDY: at.y - g.y });
      }

      const from = shownPos(scene, hit) ?? { x: hit.x, y: hit.y };
      drag = {
        kind: 'token',
        pointerId: e.pointerId,
        tokens: grabbed,
        anchorId: hit.id,
        staged,
      };
      // The anchor's alone, from the same settled position its grab offset is
      // measured from. This is the last moment it is known, since the next
      // pointermove overwrites it.
      //
      // One ruler for a group of six, not six: six lines with six labels is
      // unreadable, and the question is about one creature. This decides only
      // the dragger's screen. Every other client builds its rulers from the
      // `TokenMoved` frames it receives, and nothing on the wire says which
      // token was grabbed, so the table sees one ruler per moving token. Don't
      // add the anchor to the wire for this: it would be a field for a display
      // hint that no command checks and nothing saves.
      rulers.begin(hit.id, from, staged);
      for (const one of grabbed) state.draggingIds.add(one.token.id);
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
    // Before and outside every branch below: where a hand is doesn't depend on
    // what it is holding. A pointer goes out while a token is being dragged,
    // while a wall is being traced and while nothing is happening.
    sendCursor(state.cursorGrid);

    // Before every branch below, because `HOLD_SLOP_PX` depends on this order:
    // a press that has wandered far enough to be a sweep has also stopped being
    // a hold, and that is decided here, before the branch that would send the
    // first sketch frame. A few pixels of drift means the hand was going
    // somewhere, which is a pan or a drag and never a ping.
    if (hold !== null && hold.pointerId === e.pointerId) {
      if (Math.hypot(p.x - hold.fromX, p.y - hold.fromY) > HOLD_SLOP_PX) cancelHold();
    }

    if (drag === null && tracing() && wallTool !== null) {
      // The rubber band from the last corner, and what a click would erase or
      // swing. Both are updated on every move because both are drawn: the DM
      // has to see where the next corner lands before committing to it, which
      // is why the snap happens on the client.
      wallTool.point(cornerAt(w, e.altKey));
      const hit = wallTool.mode === 'wall' ? null : wallUnder(w);
      wallTool.hover(
        // In door mode only a door is clickable. A solid wall under the pointer
        // is somewhere a corner can be placed, not something to highlight.
        hit === null || (wallTool.mode === 'door' && hit.door === null) ? null : hit.id,
      );
      canvas.style.cursor = restingCursor(w);
      return;
    }

    if (drag === null && painting() && fogTool !== null) {
      // What a fill would cover, which the renderer draws in the colour it
      // would land in. The tool only re-floods when this crosses into a
      // different cell, which makes a few thousand cells affordable on a
      // pointer move.
      fogTool.point(gridUnder(w));
      canvas.style.cursor = 'crosshair';
      return;
    }

    if (drag === null) {
      // What a click would erase, which the renderer draws brighter and the
      // cursor turns into a pointer over. Only while a tool is in hand:
      // clicking a shape does nothing otherwise, and highlighting it would
      // suggest it does.
      state.hoveredShapeId = !sweeping()
        ? null
        : (erasableAt(scene, identity.isDm, identity.playerId, gridUnder(w))?.id ?? null);
      // A door the DM could swing lights up with no tool in hand, for the same
      // reason: a click that does something should show it first. It goes
      // through the wall editor's `hovered`, which is where the renderer reads
      // it. The tool can hold a highlight while put away.
      wallTool?.hover(swingableDoorUnder(w)?.id ?? null);
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
      const reach = { x: g.x - drag.at.x, y: g.y - drag.at.y };
      // Snapped to whole cells, so what is drawn matches the label. Alt sweeps
      // free, as it places a wall corner freely. It is read here on each move,
      // not latched at pointerdown with the tool and colour, so it doesn't
      // collide with what Alt means at pointerdown: holding it to skip the
      // anchor doesn't also commit the whole sweep to being unsnapped.
      drag.to = clampExtent(e.altKey ? reach : snapExtent(drag.tool, reach));
      // A pointer that has barely left where it went down is still a click, and
      // a click erases. Nothing is sent until it is a sweep, so an erase sends
      // the room no frames.
      if (Math.hypot(p.x - drag.fromX, p.y - drag.fromY) > DRAW_CLICK_SLOP_PX) drag.moved = true;
      if (drag.moved) {
        showOwnSketch(drag);
        sendSketchFrame(drag);
      }
      return;
    }


    if (drag.kind === 'fog') {
      // Every cell the pointer crosses, and the tool drops the repeats. Nothing
      // is sent until the button comes up.
      fogTool?.apply(gridUnder(w));
      return;
    }

    if (drag.kind === 'pan') {
      // Panning is purely local: the camera is not shared state.
      cam.x -= (p.x - drag.lastX) / cam.zoom;
      cam.y -= (p.y - drag.lastY) / cam.zoom;
      if (p.x !== drag.lastX || p.y !== drag.lastY) drag.moved = true;
      drag.lastX = p.x;
      drag.lastY = p.y;
      return;
    }

    predict(drag, gridUnder(w));
    sendDragFrame(drag);
  });

  /**
   * Letting go of a sweep. Three things can have happened.
   *
   * A sweep that never moved is a click, and a click on a shape erases it,
   * using the same function as the coverage rule.
   *
   * A sweep that moved always ends with a release frame, so the line comes off
   * everyone else's screen at the same moment it comes off ours. Whether an
   * `add_shape` follows is the only place in the project that distinguishes a
   * measuring line from a spell area.
   */
  const endSweep = (d: Extract<Drag, { kind: 'draw' }>, at: Vec2): void => {
    sketches.own(null);

    if (!d.moved) {
      // No frame was ever sent for this one, so there is no release to send.
      const shape = erasableAt(scene, identity.isDm, identity.playerId, at);
      if (shape !== null) send({ type: 'remove_shape', id: shape.id });
      return;
    }

    // Order matters, as on a token drop: a queued trailing frame landing after
    // the release would leave a line on five screens with nothing to end it.
    cancelTrailingSend();
    send({ type: 'sketch', kind: d.tool, at: d.at, to: d.to, color: d.color, drawing: false });

    // A sweep that snapped to nothing keeps nothing. The release above still
    // goes out, because five other screens were shown the sketch, but a shape
    // with no extent can't be seen and can only be erased by clicking the
    // square it is hiding in. `hasExtent` decides what counts as nothing,
    // because a rectangle can be zero on one axis alone, and that shape is
    // unclickable though still visible.
    if (!d.keeps || !hasExtent(d.tool, d.to)) return;
    const from: WireOrigin =
      d.anchor === null ? { kind: 'point', at: d.at } : { kind: 'token', at: d.anchor };
    send({ type: 'add_shape', kind: d.tool, from, to: d.to, color: d.color });
  };

  const endDrag = (e: PointerEvent): void => {
    const p = localPoint(e);
    const w = screenToWorld(cam, p.x, p.y);

    // An early release abandons the hold and the click underneath it runs as
    // normal, so a door still swings, a shape still erases, and a token still
    // drops.
    if (hold !== null && hold.pointerId === e.pointerId) cancelHold();

    // If the ping already fired, the release does nothing except let the
    // pointer go and restore the cursor. `drag` was emptied when it fired, so
    // every branch below would be skipped anyway; this is here to release the
    // capture, which they would not.
    if (consumed === e.pointerId) {
      consumed = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = restingCursor(w);
      return;
    }

    if (drag === null || drag.pointerId !== e.pointerId) return;

    if (drag.kind === 'token') {
      // Order matters: a pending trailing frame would otherwise land after the
      // drop and put the token back at an unsnapped position.
      cancelTrailingSend();
      // Always sent, never throttled: these frames carry the final positions,
      // which the server snaps to the grid and echoes back. One per held token,
      // so a group of six drops as six snaps and six sight recomputes
      // (`moves_sight` is per command, and a drop is what triggers it).
      sendMove(drag, false);
      // The measuring ends when the tokens are let go, and the line fades from
      // here instead of vanishing. Everyone else starts theirs fading on the
      // drop frames just sent.
      rulers.end(drag.anchorId, performance.now());
    } else if (drag.kind === 'calibrate') {
      // Not a commit. The tool keeps the box so the cell count can be tuned
      // against it, and stays in calibrate mode until the DM applies.
      calibration?.release({ x0: drag.x0, y0: drag.y0, x1: w.x, y1: w.y });
    } else if (drag.kind === 'draw') {
      endSweep(drag, gridUnder(w));
    } else if (drag.kind === 'fog') {
      // One command for the whole stroke, however many cells it crossed.
      fogTool?.endStroke();
    } else if (!drag.moved) {
      // A click on empty map, as opposed to a pan. Panning is constant, so
      // losing the selection every time the board moves would be maddening.
      //
      // A door under that click swings instead. It reads off the pan drag
      // instead of starting a drag of its own, which keeps both gestures:
      // click a door to open it, drag from a door to move the map. A token on
      // top of one wins, because it was grabbed at pointerdown and this branch
      // is never reached.
      const door = swingableDoorUnder(w);
      if (door !== null) {
        // The board it was found on, which is the board on screen. On the live
        // one this is the party opening a door; over a preview it is the DM
        // setting it to be found open.
        send({ type: 'toggle_door', id: door.id, staged: previewing() });
      } else {
        onSelect?.(null);
        // The group is cleared too. A click on empty map puts everything down,
        // as it clears the panel.
        state.selection.clear();
      }
    }

    drag = null;
    state.draggingIds.clear();
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = restingCursor(w);
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Ends a run without the keyboard. The second click of the pair has already
  // landed on the corner the first one placed, and the tool drops it: two
  // clicks in one corner are one corner.
  canvas.addEventListener('dblclick', (e) => {
    if (!tracing()) return;
    e.preventDefault();
    wallTool?.finish();
  });

  canvas.addEventListener('pointerleave', () => {
    if (drag === null) {
      state.cursorGrid = null;
      state.hoveredShapeId = null;
      // The rubber band would otherwise hang off the last place the pointer was
      // seen, pointing at nothing.
      wallTool?.point(null);
      wallTool?.hover(null);
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

  // Escape clears the group, as it puts away every tool in the rail. Clicking
  // empty map does it too; this works on a board with no empty space to click.
  //
  // A drag already under way is unaffected: it captured its members at
  // pointerdown and moves as one from then on. Escaping mid-drag and letting go
  // still lands the move, as it does for one token.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.selection.size === 0) return;
    state.selection.clear();
  });

  return state;
}

/**
 * Topmost *grabbable* token under a world point, or null. Iterates in reverse
 * draw order. Tokens you can't move are skipped, not returned and rejected, so
 * a token sitting on top of yours never blocks you from grabbing your own.
 *
 * Hit-tests against `shownPos`, as drawing does, so the pointer agrees with
 * the picture. A token absent from this board is not under the cursor,
 * whatever its other position is.
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
 * Not `tokenAt`: anchoring is not moving, so a player may hang an aura on a
 * paladin they don't own, or on the ogre. Any token they can see is a token
 * they can draw on; the server checks visibility, not ownership.
 *
 * Staged-only tokens are skipped because they have no live position to follow.
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

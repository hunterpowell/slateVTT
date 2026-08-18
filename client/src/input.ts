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
import { anchorable, clampExtent, erasableAt, originCell } from './shapes.js';
import type { WallTool } from './walltool.js';
import { snapToCorner, wallAt } from './walls.js';

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
/**
 * How far a press may wander and still be a hold that pings.
 *
 * Deliberately *the same number* as the slop above rather than a value of its
 * own, and the equality is load-bearing rather than tidy. A press with a shape
 * tool in hand is being measured against both at once: past this it is a hold no
 * longer, and past that it is a sweep that has started sending frames. Were this
 * the larger of the two, a press could cross into sweeping and then still fire —
 * killing a sketch that five other screens had already been shown, with no
 * release frame to take it back off them. Equal, and checked first on every
 * move, means a ping can never fire after a sketch frame has gone out.
 */
const HOLD_SLOP_PX = DRAW_CLICK_SLOP_PX;
/** How near a wall a click has to land to be about it, in *screen* pixels — so
 *  a segment stays as easy to hit zoomed out as zoomed in. */
const WALL_HIT_PX = 8;

type Drag =
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; moved: boolean }
  | {
      kind: 'token';
      pointerId: number;
      /**
       * Every token this drag moves, each with its own offset from the pointer.
       *
       * Usually one. A group selected with shift-click moves as a rigid body,
       * which is the whole of what those offsets are for: they are captured once
       * at pointerdown, so the formation on the board is the formation that
       * lands however far the pointer travels.
       *
       * Each token still lands on its *own* cell, though — the offsets are held
       * in grid units and the server snaps every token separately, so a group of
       * mixed sizes can settle half a cell off the spacing it started with.
       * `snap_to_cell` depends on how wide a token is and is the server's only
       * copy of that rule; a group snap here would be a second one.
       */
      tokens: readonly Grabbed[];
      /**
       * The one the pointer actually went down on. It is the only member with a
       * ruler — see `rulers.begin` at the grab — and it is what the panel's
       * selection follows.
       */
      anchorId: string;
      /**
       * This drag writes the tokens' plans for the staged map rather than their
       * positions. Fixed when they are picked up rather than read per frame, so
       * a drag cannot change which of the two it is halfway through.
       */
      staged: boolean;
    }
  | { kind: 'calibrate'; pointerId: number; x0: number; y0: number }
  /**
   * The DM painting cells of the fog override by hand.
   *
   * The simplest of the five: there is nothing to predict, nothing to throttle,
   * and no frame goes out until the button is released — the stroke accumulates
   * on the tool and is sent as one command, because a frame per cell would be a
   * hundred of them across one drag. A fill is not this; a fill is a click, and
   * clicks are handled without a drag at all.
   */
  | { kind: 'fog'; pointerId: number }
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

/** One token held by a drag, and where it sits relative to the pointer. */
interface Grabbed {
  token: Token;
  grabDX: number;
  grabDY: number;
}

export interface InputState {
  /** Every token currently being dragged. Drives the drag highlight — a set
   *  rather than an id because a shift-click group moves together. Empty when
   *  nothing is being dragged. */
  readonly draggingIds: ReadonlySet<string>;
  /**
   * The tokens shift-click has gathered into a group, which a drag on any one
   * of them moves together.
   *
   * Empty is the ordinary case and means "no group": a plain click drags
   * whatever it landed on and nothing else, exactly as it did before this
   * existed. Only shift-clicking puts anything in here, so every gesture that
   * does not use the modifier behaves as it always has.
   *
   * It can only ever hold tokens this client may move, and that needs no rule of
   * its own — membership comes from `tokenAt`, which is already blind to
   * everybody else's tokens. The permission question answers itself, and a
   * player gathering their own two summons is `can_move` doing its usual job.
   */
  readonly selection: ReadonlySet<string>;
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
 *
 * The wall editor is the fourth thing that can hold the left button, and the
 * only one that wants no drag at all: a click places a corner and a double-click
 * ends the run. Nothing is captured, so nothing has to be released — which is
 * also why a browser that closes mid-trace leaves nothing behind on anyone
 * else's screen, unlike a sketch or a drag.
 *
 * The fog brush is the fifth, and it is two gestures rather than one: a fill is
 * a click that commits the region already being previewed, and a paint stroke is
 * a drag whose cells accumulate on the tool and go out as a single command when
 * the button comes up. Nothing is predicted and nothing is throttled — there is
 * no round trip anybody can feel, because the preview has already shown the
 * answer.
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
   * Movement rulers. This is where our own drag's origin is captured — nothing
   * on the wire says where a drag began, and by the time the first frame is sent
   * the token has already moved.
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
  /** The rings. Everybody has these — where our own hold is timed, previewed
   *  and fired from. */
  pings: Pings,
): InputState {
  let drag: Drag | null = null;
  let lastDragSentAt = 0;
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
   * Never over a staged map. Shapes belong to the board, and the map being
   * prepared has none — so rather than sweep one that would land somewhere
   * nobody is looking, the pointer goes back to being a pointer and preview
   * behaves exactly as it did before this milestone.
   */
  const sweeping = (): boolean => drawTool.kind !== null && !previewing();

  /**
   * Whether the left button belongs to the wall editor right now.
   *
   * **Armed over either board**, unlike the sweep above it, and that is
   * milestone 20 in one line: the staged map has walls of its own now, so
   * tracing one there lands somewhere real rather than nowhere. The rule that
   * remains is a shape's — a sweep still belongs to the board alone, because
   * there are still no staged shapes.
   */
  const tracing = (): boolean => wallTool !== null && wallTool.mode !== null;

  /**
   * Whether the left button belongs to the fog brush right now.
   *
   * Armed over either board, like the wall editor and for the same reason: the
   * staged map has a mask of its own. What it does *not* have is fog, so what
   * the DM is painting there is what the party will be handed rather than a
   * preview of what they will see.
   */
  const painting = (): boolean => fogTool !== null && fogTool.brush !== null;

  /** How near a wall counts as on it, in world units at this zoom. */
  const wallSlack = (): number => WALL_HIT_PX / cam.zoom;

  /** The wall under a world point, or null. Walls are in image pixels, which is
   *  world space, so there is no conversion here at all.
   *
   *  Through `shownWalls`, so a click hit-tests the masonry of the board it
   *  landed on rather than the board the room happens to call live. */
  const wallUnder = (w: Vec2) => wallAt(shownWalls(scene), w, wallSlack());

  /**
   * A door the DM could swing right now, with no tool in hand at all.
   *
   * Opening a door is not editing the map — it is a thing that happens in the
   * middle of a fight, several times an evening, while the DM is dragging
   * monsters around. Making them arm the wall editor first would put a modal
   * tool between them and the board every time the party opens a door, which is
   * how a feature ends up unused.
   *
   * So this asks nothing about the wall editor's mode: it is available whenever
   * nothing *else* has claimed the left button. The three that can claim it —
   * calibrating, a shape tool, the wall editor — each mean something specific by
   * a click, and none of them should quietly also mean "and swing that door".
   *
   * Only the DM, and only doors: masonry is not interactive, and `shownWalls`
   * is empty on a player's client anyway, so this is an affordance rather than
   * the permission boundary. The server refuses it from anyone else regardless.
   *
   * **Available over the staged board too**, where the same gesture means
   * something different: on the board a swing is play, and there it is
   * authoring — the DM deciding which doors the party finds open. Same click,
   * because a door being clickable is what makes it a door.
   */
  const swingableDoorUnder = (w: Vec2) => {
    if (!identity.isDm) return null;
    if (tracing() || sweeping()) return null;
    if (calibration !== null && calibration.active) return null;
    const wall = wallUnder(w);
    return wall !== null && wall.door !== null ? wall : null;
  };

  /**
   * Where a corner would land: the nearest grid corner, or exactly where the
   * pointer is when Alt is down.
   *
   * The free-placement modifier is the roadmap's, and it is what makes a
   * diagonal cave wall traceable on a square lattice. Alt means the same thing
   * it means to the draw tool — ignore what this would otherwise attach itself
   * to — which is why it is that key and not another.
   */
  const cornerAt = (w: Vec2, free: boolean): Vec2 =>
    free ? w : snapToCorner(shownBoard(scene).grid, w);

  /** Moves every held token, or its plan, to where the pointer now puts it —
   *  the local prediction half. Each keeps the offset it was grabbed at. */
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
   * One `move_token` per held token. A group is N ordinary commands rather than
   * a batched one, which is what makes this feature cost the room nothing: the
   * server has always taken these one at a time, checks `can_move` on each, and
   * snaps each to its own cell.
   *
   * The throttle above is per *drag*, not per token, so a group of six sends six
   * frames on a tick rather than six independent streams — the rate the room
   * sees is the rate one token has always produced, multiplied by the size of
   * the group and not by anything else.
   */
  const sendMove = (drag: Extract<Drag, { kind: 'token' }>, dragging: boolean): void => {
    for (const held of drag.tokens) {
      // Read back off the token rather than passed in, so the trailing frame
      // below sends where the token is *now* rather than where it was queued.
      const at = drag.staged ? held.token.stagedPos : held.token;
      // Null is a token in preview that has not actually been dragged anywhere:
      // clicking one to edit it in the panel must not plan a move it did not
      // make. There is no command to un-plan, so an accidental plan would stay.
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

  /**
   * A press being timed to see whether it is a ping.
   *
   * Deliberately not a sixth `Drag`. Every variant of that enum is a thing the
   * left button is *doing*; this is a question about the button that has not
   * been answered yet, and it runs *alongside* whichever of them the press also
   * started. That is the whole trick: ping separates from what the button
   * already does by **duration rather than by target**, so it never had to be
   * given a target of its own and doors still swing.
   */
  let hold: {
    pointerId: number;
    /** Where the button went down, in screen pixels — what the slop is
     *  measured against, exactly as a sweep measures its own. */
    fromX: number;
    fromY: number;
    timer: number;
  } | null = null;

  /**
   * The pointer whose release the ping has already eaten, or null.
   *
   * Firing consumes the gesture: the button is still down at that moment, and
   * the `pointerup` that follows must not also drop a token, erase a shape, or
   * swing a door. This is how it is told to do nothing — a flag rather than
   * simply nulling `drag`, because the release still has to release the pointer
   * capture and put the cursor back.
   */
  let consumed: number | null = null;

  /** Puts a press being timed back down without firing it. Whether anything is
   *  being timed at all is this function's business and no caller's. */
  const cancelHold = (): void => {
    if (hold === null) return;
    window.clearTimeout(hold.timer);
    hold = null;
    pings.drop();
  };

  /**
   * The press lasted. Ping, and take back whatever else the press had started.
   *
   * The taking-back is the part worth reading. A press on a token has already
   * called `rulers.begin`, and leaving that would put a zero-length ruler on the
   * board measuring a move nobody made; a press with a shape tool in hand has a
   * `draw` drag open, which has sent nothing (`moved` is false, or the hold
   * would have been cancelled — see `HOLD_SLOP_PX`) and so needs no release
   * frame, only its local preview cleared. A pan has nothing to take back.
   *
   * The DM's *selection* is deliberately left alone. It happened on the way
   * down, it is visible on the board, and un-selecting a creature somebody just
   * pointed at is the opposite of what they meant.
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
   * Nothing while previewing, for the reason a sweep and a trace are nothing
   * there: the staged map is not the board anyone else is looking at, and a
   * position in its grid units lands somewhere arbitrary on theirs. The three
   * modal tools do not reach here — they return out of `pointerdown` above —
   * and the draw tool deliberately does: it is the one panel everybody has, it
   * is used in the middle of a fight, and a player who leaves it armed between
   * uses must not silently lose the gesture this milestone is for.
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
    // Asked after the token, because a token standing in a doorway is the thing
    // being grabbed — the door is behind it and the swing is still a mode away.
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

    // The wall editor takes it too, and unlike the two around it there is no
    // drag here at all: a click is the whole gesture, which is what the run
    // being a polyline buys. Nothing is captured, so nothing has to be released.
    if (wallTool !== null && tracing() && e.button === 0) {
      const mode = wallTool.mode;
      const hit = mode === 'wall' ? null : wallUnder(w);

      // A click on a door you have already hung swings it, rather than starting
      // a trace on top of it. Only with no run open: mid-trace every click is a
      // corner, so a run can be carried straight over a doorway.
      const swinging =
        mode === 'door' && wallTool.run.length === 0 && hit !== null && hit.door !== null;

      // Both name the slot the editor is on, which is the slot `wallUnder` just
      // hit-tested. Taking it off the tool rather than asking `previewing()`
      // again is what keeps the hit test and the command from ever disagreeing.
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

    // Solo sight, armed from the same panel and above the brush because arming
    // either puts the other down — so at most one of these two blocks can fire.
    //
    // `anchorTokenAt` rather than `tokenAt`: the question is what a creature can
    // see, and the interesting one is nearly always a player's. `tokenAt` is
    // blind to tokens you cannot *move*, which is the wrong boundary here and
    // would leave the DM able to check their own monsters and nobody else's.
    // There is no permission to lose by widening it: this reads walls the DM
    // already holds and sends nothing.
    if (fogTool !== null && fogTool.checking && e.button === 0) {
      fogTool.check(anchorTokenAt(scene, w.x, w.y));
      canvas.style.cursor = 'crosshair';
      return;
    }

    // The fog brush is the fourth, and it takes the button the same way — a
    // room to black out is usually a room with creatures standing in it, so
    // nothing under the pointer may be grabbable while it is in hand.
    //
    // A fill is a click and commits what the preview is already showing; a paint
    // stroke is a drag, which is the one of the two that needs capturing.
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
    // Above the hold rather than below it because it is not a press that can
    // become anything else: it commits on the way down, has no drag, and must
    // not ping — a modifier held deliberately is not somebody pointing at the
    // board. It is below the three modal tools for the opposite reason, and
    // `sweeping()` keeps it below the fourth: an armed tool takes the button
    // first, and ping is the one exception this project has decided to have.
    //
    // Nothing here calls `onSelect`. The panel edits one token and this gesture
    // is about several, so building a group leaves the form showing whatever was
    // last plain-clicked rather than swapping it out from under an edit.
    if (e.button === 0 && e.shiftKey && !sweeping()) {
      const hit = tokenAt(scene, identity, w.x, w.y);
      if (hit !== null) {
        if (!state.selection.delete(hit.id)) state.selection.add(hit.id);
        return;
      }
    }

    // Past the three modal tools, so anything below this line is a press that
    // could still turn out to be a ping. Started *before* the branches rather
    // than repeated inside each of them: a hold on a token, on a shape tool, and
    // on empty map are the same gesture, and the whole point of separating by
    // duration is that none of them had to learn about it.
    beginHold(e, p, gridUnder(w));

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
      const g = gridUnder(w);
      const staged = previewing();

      // Grabbing a member of the group takes the whole group; grabbing anything
      // else puts the group down first. That second half is what keeps a plain
      // click on a plain token exactly the gesture it has always been — the
      // group is a thing you have to have deliberately built to be holding.
      const held = state.selection.has(hit.id)
        ? scene.tokens.filter((t) => state.selection.has(t.id))
        : [hit];
      if (!state.selection.has(hit.id)) state.selection.clear();

      // Grab offsets keep the tokens from snapping their centres to the cursor,
      // and are measured from wherever each token is *on this board* — its plan
      // while previewing, its own cell otherwise. A member with no position on
      // this board is not on it to be dragged.
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
      // The anchor's alone, and the same settled position its grab offset is
      // measured from — the last moment it is knowable, since the next
      // pointermove overwrites it.
      //
      // One ruler for a group of six, not six: the reading is a single
      // creature's question and six lines with six labels is a board nobody can
      // read. It is the dragger's screen that this decides, and only that. Every
      // other client builds its rulers from the `TokenMoved` frames it receives
      // and nothing on the wire says which token was grabbed, so the table sees
      // one ruler per moving token. Marking the anchor on the wire for a hint
      // that refuses a command and persists nothing is the trade this declines.
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

    // Before every branch below, which is the ordering `HOLD_SLOP_PX` depends
    // on: a press that has wandered far enough to be a sweep has already
    // wandered far enough to stop being a hold, and this is where that is
    // decided — one move earlier than the branch that would send the first
    // sketch frame. A few pixels of drift means the hand was on its way
    // somewhere, which is a pan or a drag and never a ping.
    if (hold !== null && hold.pointerId === e.pointerId) {
      if (Math.hypot(p.x - hold.fromX, p.y - hold.fromY) > HOLD_SLOP_PX) cancelHold();
    }

    if (drag === null && tracing() && wallTool !== null) {
      // The rubber band from the last corner, and what a click would erase or
      // swing. Both are asked on every move because both are drawn: the DM has
      // to see where the next corner lands *before* committing to it, which is
      // the whole reason the snap is on this side of the wire.
      wallTool.point(cornerAt(w, e.altKey));
      const hit = wallTool.mode === 'wall' ? null : wallUnder(w);
      wallTool.hover(
        // In door mode only a door is clickable — masonry under the pointer is
        // something a corner can be placed on top of, not something to light up.
        hit === null || (wallTool.mode === 'door' && hit.door === null) ? null : hit.id,
      );
      canvas.style.cursor = restingCursor(w);
      return;
    }

    if (drag === null && painting() && fogTool !== null) {
      // What a fill would take, which the renderer draws in the colour it would
      // land in. The tool itself only re-floods when this crosses into a
      // different cell, which is what makes a few thousand cells affordable on a
      // pointer move.
      fogTool.point(gridUnder(w));
      canvas.style.cursor = 'crosshair';
      return;
    }

    if (drag === null) {
      // What a click would erase, which the renderer draws brighter and the
      // cursor turns into a pointer over. Only asked while a tool is in hand:
      // clicking a shape means nothing otherwise, and hit-testing every shape
      // on every mouse move to light up something unclickable is work spent to
      // mislead.
      state.hoveredShapeId = !sweeping()
        ? null
        : (erasableAt(scene, identity.isDm, identity.playerId, gridUnder(w))?.id ?? null);
      // A door the DM could swing lights up with no tool in hand, by the same
      // argument: a click that means something has to say so first. It goes
      // through the wall editor's own `hovered`, which is where the renderer
      // reads it — the tool being put away does not stop it holding a highlight.
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


    if (drag.kind === 'fog') {
      // Every cell the pointer crosses, and the tool drops the repeats. Nothing
      // is sent until the button comes up.
      fogTool?.apply(gridUnder(w));
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

    predict(drag, gridUnder(w));
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
    const p = localPoint(e);
    const w = screenToWorld(cam, p.x, p.y);

    // An early release is what makes this gesture cost nothing: the hold is
    // abandoned and the click underneath it runs exactly as it always did, so a
    // door still swings, a shape still erases, and a token still drops.
    if (hold !== null && hold.pointerId === e.pointerId) cancelHold();

    // Unless it already fired, in which case the release means nothing and the
    // only thing left to do is let the pointer go and put the cursor back.
    // `drag` was emptied when it fired, so every branch below would be skipped
    // regardless — this is here to release the capture, which they would not.
    if (consumed === e.pointerId) {
      consumed = null;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = restingCursor(w);
      return;
    }

    if (drag === null || drag.pointerId !== e.pointerId) return;

    if (drag.kind === 'token') {
      // Order matters: a pending trailing frame would otherwise land *after*
      // the drop and put the token back at an unsnapped position.
      cancelTrailingSend();
      // Always sent, never throttled: these frames carry the final positions and
      // are what the server snaps to the grid and echoes back. One per held
      // token, so a group of six drops as six snaps and six sight recomputes —
      // `moves_sight` is per command and a drop is the one that fires it.
      sendMove(drag, false);
      // The measuring is over the moment the tokens are let go, and the line
      // fades from here rather than vanishing. Everyone else starts theirs
      // fading on the drop frames this just sent.
      rulers.end(drag.anchorId, performance.now());
    } else if (drag.kind === 'calibrate') {
      // Not a commit — the tool keeps the box so the cell count can be tuned
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
      // A door under that click swings instead. It reads off the *pan* drag
      // rather than starting a drag of its own, which is what keeps both
      // gestures: click a door to open it, drag from a door to move the map. A
      // token on top of one wins, because it was grabbed at pointerdown and
      // this branch is never reached.
      const door = swingableDoorUnder(w);
      if (door !== null) {
        // The board it was found on, which is the board on screen. On the live
        // one this is the party opening a door; over a preview it is the DM
        // deciding they will find it open.
        send({ type: 'toggle_door', id: door.id, staged: previewing() });
      } else {
        onSelect?.(null);
        // And the group goes with it. A click on empty map is how you put
        // everything down — the same gesture that clears the panel, since both
        // are "never mind this token".
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

  // How a run ends without reaching for the keyboard. The second click of the
  // pair has already landed on the corner the first one placed, and the tool
  // drops it — two clicks in one corner are one corner, whoever meant what.
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

  // Escape puts the group down, which is what Escape means to every tool in the
  // rail — a group is a thing being held, and the way out of anything being held
  // here is the same key. Clicking empty map does it too; this is the way that
  // does not need somewhere empty to click, on a board where there may not be
  // one.
  //
  // A drag already under way is deliberately unaffected: it captured its
  // members at pointerdown and is a rigid body from then on, so there is nothing
  // left for this to take out of it. Escaping mid-drag and letting go still
  // lands the move — the same as it has always been for one token.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || state.selection.size === 0) return;
    state.selection.clear();
  });

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

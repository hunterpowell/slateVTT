import type { Box, CalShape, IsoShape } from './calibrate.js';
import { isoDiamond } from './calibrate.js';
import type { Camera, GridSpec, Rect, Vec2 } from './coords.js';
import {
  gridBounds,
  gridToWorld,
  gridTransform,
  minSpan,
  playRect,
  worldToScreen,
} from './coords.js';
import type { Fog } from './fog.js';
import { darkFill } from './fog.js';
import type { Identity } from './identity.js';
import { ownsToken } from './identity.js';
import { OVERRIDE_ALPHA, paintColor } from './overrides.js';
import type { Cursor } from './cursors.js';
import { cursorAlpha } from './cursors.js';
import { isColour, MARKER_HUES, MARKERS } from './markers.js';
import type { Ping } from './pings.js';
import { colourOf, EDGE_INSET_PX, edgeMarker, nameOf, ringAlpha, ringRadius } from './pings.js';
import type { Colours, FogPaint, Hp, Marker, RosterEntry } from './protocol.js';
import type { Ruler } from './ruler.js';
import { feetMoved, rulerAlpha, trailCells } from './ruler.js';
import type { Board, Scene, Token } from './scene.js';
import { shownBoard, shownOverrides, shownPos, shownWalls, showingStaged } from './scene.js';
import type { Shape, Sketch } from './shapes.js';
import { CONE_HALF_ANGLE, coveredCells, isArea, labelFor, shapeEnd, shapeOrigin } from './shapes.js';
import { crossesWall } from './walls.js';

const TAU = Math.PI * 2;

const VOID = '#0b0d10';
/** How strong the halo is relative to the line it sits under. */
const HALO_ALPHA_RATIO = 0.8;
/**
 * Halo and core widths, in screen pixels. The halo has to be wide enough to
 * leave pixels covered by it and *not* by the core: on a mid-grey map the two
 * otherwise land on the same pixels and partly cancel, which is the one
 * background a single stroke and a narrow halo both struggle with.
 */
const GRID_HALO_WIDTH = 4;
const GRID_CORE_WIDTH = 1;
/**
 * Below this many screen pixels per cell the halo is dropped. Four pixels of
 * halo on cells six pixels apart reads as a dark wash, and zoomed out that far
 * the grid is for orientation, not for measuring against.
 */
const HALO_MIN_CELL_PX = 14;
/** Laid over the parts of the image outside the play area. */
const OUTSIDE_PLAY_AREA = 'rgba(11, 13, 16, 0.55)';
/** The fill a click would commit, before it is committed. Translucent, and
 *  outlined at full strength: the outline is the region and the fill is what it
 *  would become, the same split a drawn shape makes. */
const PREVIEW_FILL_ALPHA = 0.3;
const TOKEN_RIM = 'rgba(0, 0, 0, 0.55)';
/** Yours. Warm, so it never reads as the blue "being dragged" state. */
const OWNED_RING = 'rgba(240, 212, 140, 0.9)';
const DRAG_RING = 'rgba(120, 190, 255, 0.95)';
/** The token the DM's panel is editing. Dashed, so it cannot be mistaken for
 *  ownership or for whose turn it is, both of which are solid rings. */
const SELECTED_RING = 'rgba(120, 190, 255, 0.9)';
/** Acting this turn. Neutral white, so it reads against every token hue and
 *  never competes with the ownership ring it sits outside of. */
const TURN_RING = 'rgba(255, 255, 255, 0.95)';
const LABEL_TEXT = '#e8e6e1';
const LABEL_HALO = 'rgba(0, 0, 0, 0.85)';
/**
 * The marker band, in screen pixels so it keeps its weight as the camera
 * zooms, like every ring on a token.
 *
 * `MARKER_BAND_W` is how thick the arcs are stroked and the band is centred
 * that far inside the token's own rim, where nothing else on a token draws.
 * Everything that means something about *state* (gold for yours, white for the
 * turn, dashed blue for the selection) is outside the rim, which keeps a
 * yellow arc from reading as ownership.
 */
const MARKER_BAND_W = 4;
/** Between two arcs, in radians, so a band of three reads as three. */
const MARKER_ARC_GAP = 0.16;
/** A continuous dark track under the arcs, like the one under the hit point
 *  bar. It does what a halo would, and also makes the *gaps* read as gaps
 *  instead of as portrait showing through. */
const MARKER_TRACK = 'rgba(0, 0, 0, 0.6)';
/** How far across the portrait the X reaches, as a fraction of the radius, and
 *  how thickly. Screen pixels for the second, like everything above. */
const DEAD_X_REACH = 0.62;
const DEAD_X_W = 3.5;
/** The calibration box, in the same blue as a drag: both mean "in progress". */
const CAL_FILL = 'rgba(120, 190, 255, 0.10)';
const CAL_EDGE = 'rgba(120, 190, 255, 0.95)';
const CAL_DIVISION = 'rgba(120, 190, 255, 0.55)';
/**
 * How solidly a token the table cannot see draws on the DM's board. Faded and
 * dashed together, because faded alone is what a slow-loading portrait looks
 * like and dashed alone is what the selection already is.
 */
const HIDDEN_ALPHA = 0.55;
/** Hidden. Violet, so it collides with nothing the ring colours already mean:
 *  gold is yours, blue is in progress, white is the turn. */
const HIDDEN_RING = 'rgba(178, 156, 232, 0.95)';
/**
 * Does not exist on the board yet, only on the map being prepared. Teal, the
 * last hue the ring colours have left, and solid: this token is as draggable
 * as any other.
 *
 * Don't fade tokens over a staged map. Fading means "not a piece", and
 * everything on that board is a piece; what is worth drawing is which of them
 * are on the live board yet. Hidden still fades and still dashes, so a monster
 * built on the next map *and* hidden reads as teal, faint and dashed: three
 * marks for three independent facts, none of which cancels another.
 */
const STAGED_ONLY_RING = 'rgba(96, 200, 190, 0.95)';

/**
 * The movement ruler, in the same blue as a drag: it only exists during one,
 * and it means "in progress". Haloed like the labels, because it has to read on
 * parchment and on a cave floor alike.
 */
const RULER_LINE = 'rgba(120, 190, 255, 0.95)';
const RULER_HALO = 'rgba(0, 0, 0, 0.65)';
const RULER_WIDTH = 2;
const RULER_HALO_WIDTH = 4;
/** The dot left on the cell the drag began in. */
const RULER_ORIGIN_R = 3.5;
const RULER_FONT = '600 12px ui-sans-serif, system-ui, sans-serif';
/** Between the token's edge and the reading, which sits beside the token: above
 *  and below are taken by the hit point bar and the name. */
const RULER_TEXT_GAP = 10;

/**
 * The squares the move crossed, in the ruler's own blue: it is the same
 * annotation, and a second colour would imply a second thing being said.
 *
 * Fainter than a drawn shape's tint, because a shape is what the table is
 * looking at and this is background information. The outline makes the
 * individual squares countable at a glance, which is why they are drawn at all
 * and not just the line; it is ruled at a constant screen width like the fog
 * preview's.
 */
const TRAIL_FILL = 'rgba(120, 190, 255, 0.9)';
const TRAIL_FILL_ALPHA = 0.16;
const TRAIL_EDGE_ALPHA = 0.45;

/**
 * The ruler when the move it measures passes through a wall or a shut door.
 *
 * **Only ever on the DM's screen**, with no check needed: a player's scene
 * holds no walls, so there is nothing for `crossesWall` to find. It is a hint
 * and never a refusal: nothing is blocked, no command is rejected, and the DM
 * says "there is a wall there" as they would at a table. Blocking the move
 * would be a leak; see `docs/drawings.md`.
 *
 * Amber, which the board already uses for a door (walls and doors are what
 * this line is about) and which the ring colours leave alone.
 */
const RULER_BLOCKED = 'rgba(255, 176, 74, 0.95)';

/** The hit point bar, in screen pixels: it does not scale with the camera, for
 *  the same reason a name does not. */
const HP_BAR_H = 5;
const HP_BAR_MIN_W = 30;
const HP_BAR_MAX_W = 92;
/** Between the token's edge and the bar, and between the bar and the numbers. */
const HP_BAR_GAP = 6;
const HP_TEXT_GAP = 2;
/**
 * Nothing stacks above the hit point numerals: markers are drawn on the token
 * itself, so the column over a token is a bar and a total, and no other code
 * needs to know how tall it is.
 */
const HP_FONT = '600 11px ui-sans-serif, system-ui, sans-serif';
const HP_TRACK = 'rgba(0, 0, 0, 0.55)';
const HP_EDGE = 'rgba(0, 0, 0, 0.85)';
/** Three bands, not a gradient: a DM glancing at six monsters wants to sort
 *  them, not read a percentage. Nothing here knows what "bloodied" means. */
const HP_HEALTHY = 'rgba(122, 184, 116, 0.95)';
const HP_HURT = 'rgba(214, 173, 84, 0.95)';
const HP_LOW = 'rgba(200, 92, 92, 0.95)';

/**
 * How solidly a drawn shape's outline and its cell tint go down.
 *
 * The colour on the wire carries its own alpha, and these multiply it: an
 * outline is meant to be read and a fill is meant to be seen through, because
 * whatever is standing under a spell area is what everyone is looking at. A
 * sketch is drawn fainter still: it is a proposal, not a fact.
 */
const SHAPE_FILL_ALPHA = 0.24;
const SHAPE_EDGE_ALPHA = 1;
const SKETCH_ALPHA = 0.75;
const SHAPE_EDGE_WIDTH = 2;
/** The shape the pointer would erase, so a click is never a surprise. */
const SHAPE_HOVER_ALPHA = 0.4;
const SHAPE_FONT = '600 12px ui-sans-serif, system-ui, sans-serif';
/** The ping ring and the arrow that stands in for one off screen. Both drawn in
 *  the sender's own colour, which is why neither has a colour constant here. */
const PING_WIDTH = 3;
const PING_HALO_WIDTH = 6;
const PING_HALO = 'rgba(0, 0, 0, 0.6)';
/** Between the ring and the name written under it. */
const PING_TEXT_GAP = 7;
const PING_FONT = '600 12px ui-sans-serif, system-ui, sans-serif';
/** How long the arrow's head is, in screen pixels. */
const PING_ARROW_PX = 13;
/**
 * A pointer's dot and the name under it, both in screen pixels: a cursor that
 * shrank as the camera pulled back would stop reading as a cursor (the same
 * argument as `ringRadius`).
 *
 * A dot, not an arrow. An arrow is what a desktop draws under your own hand,
 * and seven of them on a board already carrying tokens, nameplates, hit point
 * bars, rulers, trails, shapes and fog read as seven things asking to be
 * clicked. A dot marks a spot and says a hand is *here*, not that it is about
 * to do something.
 *
 * Smaller and quieter than a ping's ring, and quieter again through
 * `CURSOR_ALPHA`, because a ping is the gesture that means "look here" and a
 * cursor is not.
 */
const CURSOR_R_PX = 5;
const CURSOR_HALO_WIDTH = 2;
const CURSOR_FONT = '600 11px ui-sans-serif, system-ui, sans-serif';
/** Between the dot and the name under it. */
const CURSOR_TEXT_GAP = 5;
/**
 * How solidly a pointer draws at rest, on top of its own fade.
 *
 * The one constant here that is a *volume* and not a size. Everything else on
 * this canvas is something somebody decided (a token is where it was put, a
 * ring is where somebody pointed), and a cursor is the only mark nobody chose
 * to make. It should be legible when looked for and easy to ignore when not.
 * If cursors are too loud, turn this down before shortening the decay.
 */
const CURSOR_ALPHA = 0.55;
/** Between a shape's far point and its reading. */
const SHAPE_TEXT_GAP = 8;

/**
 * Traced walls, and the doors hung in them.
 *
 * Rose and amber, which the board uses for nothing else: the ring colours are
 * gold, blue, white, violet and teal, and the drawing palette avoids all five.
 * Hue tells a door from a wall, and dash tells whether it is open: solid
 * blocks sight, dashed does not.
 */
const WALL_LINE = 'rgba(255, 110, 160, 0.95)';
const DOOR_LINE = 'rgba(255, 200, 90, 0.95)';
const WALL_HALO = 'rgba(0, 0, 0, 0.65)';
const WALL_WIDTH = 3;
const WALL_HALO_WIDTH = 6;
/**
 * How solidly *masonry* draws when the editor is put away.
 *
 * Walls are always on the DM's screen and never on anybody else's, so the
 * question is only how loudly. Faint is enough to answer "have I traced this
 * room" at a glance during a fight; the editor brings them up to full when the
 * DM is working on them.
 *
 * Doors are exempt and stay at full strength always, because the DM can swing
 * one at any time with no tool in hand. What can be clicked is drawn like it.
 */
const WALL_IDLE_ALPHA = 0.35;
/** The segment a click would erase or swing, so it is never a surprise. */
const WALL_HOVER = 'rgba(255, 255, 255, 0.95)';
/** The run being traced, in the same blue as every other in-progress thing. */
const WALL_RUN = 'rgba(120, 190, 255, 0.95)';
const WALL_CORNER_R = 3.5;
/** Dash lengths in screen pixels, for an open door and for the rubber band. */
const DOOR_OPEN_DASH = 5;
const WALL_AIM_DASH = 6;

/** Canvas size in CSS pixels, plus the backing-store scale factor. */
export interface Viewport {
  width: number;
  height: number;
  dpr: number;
}

export interface Frame {
  cam: Camera;
  scene: Scene;
  identity: Identity;
  map: HTMLImageElement;
  /** `performance.now()` for this frame. The only clock the renderer reads, and
   *  it reads it for one thing: how far a landed ruler has faded. */
  now: number;
  /** Token art, keyed by image URL. See `loadArt` in main.ts. */
  tokenImages: Map<string, HTMLImageElement>;
  /** Every token being dragged right now. More than one is a shift-click group
   *  moving together. */
  draggingIds: ReadonlySet<string>;
  /** Movement rulers by token id, ours and everyone else's alike. */
  rulers: ReadonlyMap<string, Ruler>;
  /** The token the DM has selected for editing. Null for everyone else. */
  selectedId: string | null;
  /** The tokens shift-click has gathered, which drag together. Empty unless a
   *  group has been built. See `selection` in input.ts. */
  selection: ReadonlySet<string>;
  /** Every sweep in progress, ours and everyone else's. */
  sketches: readonly Sketch[];
  /** The shape the pointer is over and could erase, or null. Only ever set
   *  while the draw tool is in hand, since that is the only time clicking a
   *  shape means anything. */
  hoveredShapeId: string | null;
  /** Token acting this turn, or null when combat is not running. */
  currentTurn: string | null;
  /** Every ring on the board, ours and everyone else's, plus the one still
   *  being held down if there is one. */
  pings: readonly Ping[];
  /** Everybody else's pointer. Never our own: the OS is already drawing that
   *  one, and a second pointer a round trip behind it is the rubber-banding a
   *  token drag avoids by not echoing. */
  cursors: readonly Cursor[];
  /** The cast list, so a ring can be attributed to a name and a colour. Held
   *  by every client since `Welcome` and not a secret: it is the same list
   *  everyone was offered at the identity picker. */
  roster: readonly RosterEntry[];
  /** What each of those names picked to draw in. Held beside the roster because
   *  the two answer one question together: the roster gives the default and
   *  this overrides it. */
  colours: Colours;
  /** The DM's in-progress grid reference box. Null for everyone else. */
  calibration: { box: Box; cells: number; shape: CalShape } | null;
  /** The wall editor's state: whether it is armed, the run being traced, where
   *  the next corner would land, and which segment the pointer is over.
   *
   *  Null for a player, but that is not what keeps walls off their screen:
   *  the walls are absent from their scene. This is editor state, not the
   *  secret. */
  walls: {
    armed: boolean;
    run: readonly Vec2[];
    aim: Vec2 | null;
    hovered: string | null;
  } | null;
  /** The fog tool's state: whether the panel is open, what the brush is loaded
   *  with, and the cells a fill would take if the DM clicked now.
   *
   *  Null for a player, who has no panel and, as with the walls, no overrides
   *  in their scene to draw either way. `armed` only decides how strongly the
   *  layer washes, because unlike the wall editor this tool has nothing to draw
   *  that is not already on the board. */
  fog: {
    armed: boolean;
    paint: FogPaint | null;
    /** Flat pairs, the way `coveredCells` returns them: this can be a few
     *  thousand cells and it is rebuilt as the pointer crosses into a new one. */
    preview: readonly number[];
  } | null;
  /**
   * One creature's line of sight, drawn *instead of* the table's fog while the
   * DM is checking it. Null the rest of the time and always for a player, whose
   * client holds no walls to compute one from.
   *
   * It replaces the wash instead of joining it because the two answer different
   * questions and overlaying them would answer neither. See `solo.ts`.
   */
  solo: Fog | null;
  /**
   * The DM is looking at the board as the table sees it.
   *
   * The scene has already been narrowed by `asTable` before it reaches here, so
   * nothing below draws a wall or a monster it should not. This flag carries
   * the one thing a filtered scene cannot say: how *dark* the fog should be.
   * Always false for a player, whose board is already the table's.
   */
  playerView: boolean;
}

/**
 * Draws a picture over the whole canvas, instead of the board.
 *
 * **Screen space, not world space.** It never touches the camera, so there is
 * no pan, no zoom, no grid, no hit test and nothing to keep in step with
 * `coords.ts`; `main.ts` calls this *instead of* `render`, not as a layer
 * inside it. A board drawn under a picture nobody can see would only be a way
 * for the two to disagree.
 *
 * Contained, not covered, unlike a token's portrait: the DM picked this image
 * to be looked at, so it must not crop the top off a treeline to fill a wide
 * window. Letterbox bars are `VOID`, which is what surrounds a map too, so the
 * window does not change colour when the picture goes up.
 */
export function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  img: HTMLImageElement,
): void {
  const w = view.width * view.dpr;
  const h = view.height * view.dpr;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = VOID;
  ctx.fillRect(0, 0, w, h);

  // A zero-sized image is a broken one; `drawImage` would throw on the divide.
  if (img.width === 0 || img.height === 0) return;

  const scale = Math.min(w / img.width, h / img.height);
  const drawn = { w: img.width * scale, h: img.height * scale };
  ctx.drawImage(img, (w - drawn.w) / 2, (h - drawn.h) / 2, drawn.w, drawn.h);
}

export function render(ctx: CanvasRenderingContext2D, view: Viewport, frame: Frame): void {
  const { cam, map } = frame;
  // The staged map while the DM is previewing, the live one otherwise. Read
  // once and passed down, so no two things in a frame can disagree about which
  // map they are drawing on. Where each *token* sits on it is `shownPos`, asked
  // per token for the same reason.
  const board = shownBoard(frame.scene);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = VOID;
  ctx.fillRect(0, 0, view.width * view.dpr, view.height * view.dpr);

  // The single place device pixel ratio enters the coordinate chain. Everything
  // below draws in world units and is unaware of it.
  const s = cam.zoom * view.dpr;
  ctx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s);

  ctx.drawImage(map, 0, 0);

  const area = playRect(board.playArea, map.width, map.height);
  // Before the grid and the tokens: the board should read as lit, and a token
  // staged off the board should stay perfectly legible.
  if (board.playArea !== null) drawOutsidePlayArea(ctx, area, map.width, map.height);
  drawGrid(ctx, frame, board, area);

  // Over the terrain and under everything standing on it.
  //
  // Under the tokens, so the DM's monsters stay at full strength over a faint
  // wash: the board they are playing on stays legible while it also says what
  // the table can see. A player has no token in the dark to be washed out
  // (every one they hold is a vision source, or is standing where one is
  // looking), so the order costs them nothing.
  //
  // Nothing while previewing: the staged map has no fog. The bitsets are the
  // party's memory and line of sight, and neither means anything on a map they
  // have not been shown, since no ray has been cast on it. Previewing the
  // staged map's fog is a second raycast and is out of scope; see
  // `docs/fog.md`.
  if (!showingStaged(frame.scene)) drawFog(ctx, frame, board, area);

  // Directly over the fog, because it annotates the fog: which parts of that
  // wash the DM put there by hand, as opposed to the walls casting it. A
  // player's scene has none, so this draws nothing for them without needing to
  // ask who they are.
  //
  // Drawn over either board, unlike the wash: the staged one carries a mask of
  // its own. There it is the only thing on screen, with no fog underneath,
  // which is why the panel's hint says in words what the board cannot.
  drawOverrides(ctx, frame, board);

  // Under the tokens, unlike the ruler's line that measures the same move: the
  // squares are terrain being pointed at, and the creature standing on them is
  // what everyone is looking at. The shapes below are drawn over the tokens for
  // the opposite reason.
  drawTrails(ctx, frame, board);

  drawTokens(ctx, frame, board);

  // Over the tokens. A spell area is being asked about *now* (where it reaches
  // and who is caught in it), so it has to read across the creatures inside it
  // instead of being hidden by them. The fill is translucent enough that a
  // token under one is still a token, and its name and hit points are drawn
  // later, in screen space, so nothing a shape covers becomes unreadable.
  //
  // Nothing is drawn while previewing. Shapes belong to the live board, the
  // staged map has none, and painting the live board's onto the map being
  // prepared would put a fireball on a dungeon it was never cast in.
  if (!showingStaged(frame.scene)) drawShapes(ctx, frame, board);

  // Over everything on the board, for a different reason than the shapes: a
  // wall is the room the tokens are standing *in*, and it has to be traceable
  // across a crowded board. Over either board, since each carries its own
  // walls, unlike the shapes.
  drawWalls(ctx, frame);

  if (frame.calibration !== null) drawCalibration(ctx, cam, frame.calibration);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(view.dpr, view.dpr);
  // Under the chrome: a name or a hit point bar is worth more than the line
  // that happens to be passing behind it.
  if (!showingStaged(frame.scene)) drawShapeLabels(ctx, frame, board);
  drawRulers(ctx, frame, board);
  drawTokenChrome(ctx, frame, board);

  // Under the pings and over everything else: a ping is somebody asking for
  // attention and a pointer is only somebody's hand. Nothing while previewing,
  // for the pings' reason below.
  if (!showingStaged(frame.scene)) drawCursors(ctx, frame, board);
  // Last, over everything including the names and the hit point bars, and the
  // only thing in this function drawn that high. A ping is somebody at the
  // table saying *look here*: it is worth more for the two seconds it lasts
  // than anything it covers, and it uncovers it again by itself.
  //
  // Nothing while previewing, as with the shapes: a ping's position is in the
  // live board's grid units, and painting it onto the map being prepared would
  // put the ring in a cell nobody pointed at. The DM misses pings while
  // preparing the next room, the same trade preview makes with everything else
  // on the live board.
  if (!showingStaged(frame.scene)) drawPings(ctx, view, frame, board);
}

/**
 * How solidly a token draws. One reason to fade now: the table cannot see it.
 *
 * `globalAlpha` is canvas state, not an argument, so every caller pairs its set
 * with a `restore`. Left set, it survives into the next frame and washes out
 * the map itself, including the fill meant to clear the previous one.
 */
function alphaFor(token: Token): number {
  return token.hidden ? HIDDEN_ALPHA : 1;
}

/**
 * The grid, drawn as a contrasting halo with the chosen colour on top.
 *
 * A single translucent stroke only works against backgrounds it happens to
 * contrast with: white at 10% is fine on a cave floor and invisible on
 * parchment. Two strokes of the same path fix that cheaply: whichever of the
 * pair the map does not match is the one you see. The token labels do the same
 * for text.
 */
function drawGrid(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  board: Board,
  area: Rect,
): void {
  const { grid } = board;
  const halo = haloFor(board.gridColor);
  if (halo === null) return; // fully transparent: the DM turned the grid off
  if (grid.px <= 0 || area.w <= 0 || area.h <= 0) return;

  // Two families of parallel lines: the ones along which `x` is a whole number,
  // and the ones along which `y` is. On a square grid they come out vertical and
  // horizontal; on an isometric one they lean, and the play area no longer
  // bounds either family axis by axis.
  //
  // So the extent is taken in *grid* space (the bounding box of the play area's
  // four corners, which says how many lines of each family reach it) and the
  // play area does the trimming as a clip. Intersecting each line with the
  // rectangle by hand would be the same picture and much more arithmetic.
  // Inward: the whole-numbered lines *inside* the play area. The slack absorbs
  // float error, which is why this is not a bare ceil/floor: an edge landing
  // on an exact multiple is the common case, and dropping its line looks like a
  // bug.
  const reach = gridBounds(grid, area);
  const slack = 1e-6;
  const fromX = Math.ceil(reach.minX - slack);
  const toX = Math.floor(reach.maxX + slack);
  const fromY = Math.ceil(reach.minY - slack);
  const toY = Math.floor(reach.maxY + slack);

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();

  ctx.beginPath();
  for (let x = fromX; x <= toX; x++) {
    const a = gridToWorld(grid, x, fromY);
    const b = gridToWorld(grid, x, toY);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (let y = fromY; y <= toY; y++) {
    const a = gridToWorld(grid, fromX, y);
    const b = gridToWorld(grid, toX, y);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }

  // Both widths stay constant on screen at any zoom: the transform scales world
  // units by cam.zoom, so n/zoom world units is always n CSS pixels.
  //
  // `minSpan`, not `px`, because what decides whether a halo is legible is the
  // *shortest* a cell measures on screen: the same number on a square grid, and
  // the diamond's height on an isometric one.
  if (minSpan(grid) * frame.cam.zoom >= HALO_MIN_CELL_PX) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = GRID_HALO_WIDTH / frame.cam.zoom;
    ctx.stroke();
  }

  // The same path, stroked again, so it is built only once.
  ctx.strokeStyle = board.gridColor;
  ctx.lineWidth = GRID_CORE_WIDTH / frame.cam.zoom;
  ctx.stroke();
  ctx.restore();
}

/**
 * The fog: dark where the party has never been, dim where they have been and
 * are not, and clear where they are looking.
 *
 * One `drawImage`, whatever the dungeon looks like. The fog arrives as a
 * rectangle of cells and `fog.ts` has already turned it into a canvas, so this
 * stretches that over the board instead of filling a few thousand rectangles
 * every frame. Smoothing is left on to feather the edge; see the comment above
 * the `drawImage` for why that doesn't move it.
 *
 * Everything outside that rectangle is dark (the rectangle is only as big as
 * what has been explored), so the four bands around it are filled flat,
 * clipped to the board. The play-area dim below works the same way, and here
 * it lets the packed frame shrink to the explored part of a large map.
 *
 * Nothing here is a visibility decision. A creature the table cannot see is
 * absent from the scene, not painted over: drawing it and covering it would
 * put the position on the client, which invariant 4 forbids.
 */
function drawFog(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  board: Board,
  area: Rect,
): void {
  // Solo sight wins where it is set: it is what the DM asked to look at, and
  // drawing the table's wash underneath or over it would make neither readable.
  const fog = frame.solo ?? frame.scene.fog;
  // Solo sight draws at the *table's* strength, not the DM's faint one. The
  // faint wash exists so the DM can still play on a board that also says what
  // the party can see; solo sight is a question the DM asked, and the answer
  // has to be legible.
  //
  // Player view asks the same about the whole board, so it also draws at full
  // strength: a board the DM can see through is not what the table sees. This
  // is the only line in the renderer that reads the flag; everything else was
  // decided by `asTable` before the frame was built.
  const faint = frame.solo === null && frame.identity.isDm && !frame.playerView;
  if (fog === null || area.w <= 0 || area.h <= 0) return;

  ctx.save();
  // Clipped so the bands below can be drawn generously without darkening the
  // margin outside the board, which has its own dim and its own reason for it.
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.fillStyle = darkFill(faint);

  // Nothing explored at all: the whole board is dark, and there is no rectangle
  // to cut out of it.
  if (fog.shade === null) {
    ctx.fillRect(area.x, area.y, area.w, area.h);
    ctx.restore();
    return;
  }

  // Into grid space, where the packed rectangle's coordinates are cells and the
  // fog canvas stretches over it as a plain image. On a sheared lattice the
  // matrix turns both into the right parallelograms; on a square one it is a
  // scale and an offset.
  //
  // The clip above stays in world space, outside the transform, because it is
  // the play area and the play area is a rectangle on the image.
  ctx.transform(...gridTransform(board.grid));

  // The four bands around the explored rectangle. Drawn out to the play area's
  // own extent and padded a cell, which overshoots in both directions on a
  // sheared grid. The clip makes the overshoot harmless.
  const reach = gridBounds(board.grid, area);
  const outLeft = Math.floor(reach.minX) - 1;
  const outRight = Math.floor(reach.maxX) + 2;
  const outTop = Math.floor(reach.minY) - 1;
  const outBottom = Math.floor(reach.maxY) + 2;
  const seenRight = fog.x + fog.w;
  const seenBottom = fog.y + fog.h;
  const across = outRight - outLeft;
  ctx.fillRect(outLeft, outTop, across, fog.y - outTop);
  ctx.fillRect(outLeft, seenBottom, across, outBottom - seenBottom);
  ctx.fillRect(outLeft, fog.y, fog.x - outLeft, fog.h);
  ctx.fillRect(seenRight, fog.y, outRight - seenRight, fog.h);

  // Smoothing left *on*, which feathers the fog edge. It is safe to interpolate
  // here only because `fogFromWire` draws each cell as a solid block of
  // `SUBCELLS` pixels: the boundary stays where the server put it and the ramp
  // is confined to a quarter of a cell. Don't feed this a one-pixel-per-cell
  // canvas: interpolating it would ramp across the whole square and move the
  // edge half a cell. The override tint below keeps its hard edge; see
  // `SUBCELLS` in `fog.ts` for why the two differ.
  //
  // The table's own canvas when this is not the faint wash, falling back to the
  // one canvas a player or a solo answer has. That fallback is why nothing here
  // asks who is reading: the four cases (the DM playing, the DM mirroring, the
  // DM checking one creature, and a player) pick the right shade from `faint`
  // alone.
  ctx.drawImage(faint ? fog.shade : (fog.table ?? fog.shade), fog.x, fog.y, fog.w, fog.h);
  ctx.restore();
}

/**
 * The DM's manual override, and the fill they are about to commit.
 *
 * Two layers with one thing in common: neither is a visibility decision. The
 * board is already dark where the party cannot see; this says which of that the
 * DM *decided*. Without it they cannot tell a blacked-out room from a wall's
 * shadow, and without undo that difference is what makes the tool usable.
 *
 * One `drawImage`, like the fog, because a filled dungeon room is a few
 * thousand cells. Unlike the fog, smoothing goes off: the tint is one pixel per
 * cell, and its edge belongs on the cell boundary that was painted.
 *
 * Faint while the DM is playing, stronger while the panel is open, like the
 * walls. That is why this is one `globalAlpha` and not two canvases.
 */
function drawOverrides(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const overrides = shownOverrides(frame.scene);
  const tool = frame.fog;

  if (overrides.tint !== null) {
    ctx.save();
    // In grid space, like the fog above: the tint is one pixel per cell, and
    // the matrix turns those pixels into cells.
    ctx.transform(...gridTransform(board.grid));
    ctx.globalAlpha = tool?.armed === true ? OVERRIDE_ALPHA.armed : OVERRIDE_ALPHA.idle;
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(overrides.tint, overrides.x, overrides.y, overrides.w, overrides.h);
    ctx.imageSmoothingEnabled = smoothing;
    ctx.restore();
  }

  // The fill the DM has not committed yet, in the colour it would commit in.
  // Drawn as one path of a few thousand `rect`s, as the shape tint is, because
  // a `fillRect` each would be a few thousand calls a frame.
  if (tool === null || tool.preview.length === 0) return;
  const { grid } = board;
  ctx.save();
  // In grid space, so a cell is the unit square and the lattice's own shear puts
  // it where it belongs. `cellPath` builds it; the transform is not left on
  // because of the stroke below, whose `lineWidth` would be sheared with it.
  const path = cellPath(grid, tool.preview);
  ctx.globalAlpha = PREVIEW_FILL_ALPHA;
  ctx.fillStyle = paintColor(tool.paint);
  ctx.fill(path);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = paintColor(tool.paint);
  ctx.lineWidth = 1 / frame.cam.zoom;
  ctx.stroke(path);
  ctx.restore();
}

/**
 * A path covering the given cells, in world coordinates.
 *
 * `cells` is a flat `[x, y, x, y, …]`, which is what the fog tool and the shape
 * coverage rule both hand over. One `Path2D` of many cells and one `fill` keeps
 * a filled dungeon room cheap; a `fillRect` each would be a few thousand calls
 * a frame.
 *
 * Built through the grid transform, not by adding `grid.px` to a corner, which
 * only works on a square grid: under the matrix, one cell is the unit square at
 * `(cx, cy)` whatever shape the lattice is. Returned as a `Path2D` so the
 * caller can stroke it *outside* the transform, where `lineWidth` still means
 * screen pixels.
 */
function cellPath(grid: GridSpec, cells: readonly number[]): Path2D {
  const inGrid = new Path2D();
  for (let i = 0; i < cells.length; i += 2) {
    inGrid.rect(cells[i] ?? 0, cells[i + 1] ?? 0, 1, 1);
  }
  const path = new Path2D();
  const [a, b, c, d, e, f] = gridTransform(grid);
  path.addPath(inGrid, { a, b, c, d, e, f });
  return path;
}

/**
 * Dims the image outside the play area, so the board reads as the board.
 *
 * Four rectangles around it instead of one fill with a hole: the alternative
 * is an even-odd path, which is more machinery for the same result.
 */
function drawOutsidePlayArea(
  ctx: CanvasRenderingContext2D,
  area: Rect,
  mapW: number,
  mapH: number,
): void {
  const right = area.x + area.w;
  const bottom = area.y + area.h;

  ctx.fillStyle = OUTSIDE_PLAY_AREA;
  ctx.fillRect(0, 0, mapW, area.y);
  ctx.fillRect(0, bottom, mapW, mapH - bottom);
  ctx.fillRect(0, area.y, area.x, area.h);
  ctx.fillRect(right, area.y, mapW - right, area.h);
}

/**
 * A halo in whichever direction the line itself is not, so the pair reads on
 * any background. Null when the colour is fully transparent: there is nothing
 * to outline, and the DM asked for no grid at all.
 *
 * `color` is `#rrggbbaa`; the server accepts no other shape.
 */
function haloFor(color: string): string | null {
  const alpha = parseInt(color.slice(7, 9), 16) / 255;
  if (!Number.isFinite(alpha) || alpha === 0) return null;

  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  // Rec. 601 luma, which is plenty to tell a light line from a dark one.
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;

  return `rgba(${light ? '0, 0, 0' : '255, 255, 255'}, ${alpha * HALO_ALPHA_RATIO})`;
}

/**
 * Everything drawn on the board, and every sweep in progress on top of it.
 *
 * Kept shapes and sketches go through one function because they are the same
 * picture. The only difference is that a sketch is somebody's mouse still being
 * held down, which is what the dash says.
 */
function drawShapes(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene } = frame;

  for (const shape of scene.shapes) {
    // Null is an anchor we do not hold, which the room should never let happen.
    // Drawing nothing beats drawing it at cell zero.
    const origin = shapeOrigin(scene, shape);
    if (origin === null) continue;
    const fill = shape.id === frame.hoveredShapeId ? SHAPE_HOVER_ALPHA : SHAPE_FILL_ALPHA;
    paintShape(ctx, frame, board, shape.kind, origin, shape.to, shape.color, fill, 1, false);
  }

  for (const sketch of frame.sketches) {
    paintShape(
      ctx,
      frame,
      board,
      sketch.kind,
      sketch.at,
      sketch.to,
      sketch.color,
      SHAPE_FILL_ALPHA,
      SKETCH_ALPHA,
      true,
    );
  }
}

/**
 * One shape in world space: the cells it covers, then its outline.
 *
 * `globalAlpha` multiplies whatever alpha the colour already carries, which is
 * how one palette entry gives a readable edge and a fill you can see a goblin
 * through without the wire format carrying two colours.
 */
function paintShape(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  board: Board,
  kind: Shape['kind'],
  origin: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  fillAlpha: number,
  alpha: number,
  dashed: boolean,
): void {
  const { grid } = board;
  const o = gridToWorld(grid, origin.x, origin.y);
  const end = shapeEnd(origin, to);
  const e = gridToWorld(grid, end.x, end.y);

  ctx.save();

  if (isArea(kind)) {
    // Every cell whose centre falls inside, as one path and one fill. A rect per
    // cell would be a few hundred fill calls a frame on a large area; a few
    // hundred `rect`s into one path is the same picture for one of them.
    const cells = coveredCells(kind, origin, to);
    if (cells.length > 0) {
      ctx.globalAlpha = alpha * fillAlpha;
      ctx.fillStyle = color;
      ctx.fill(cellPath(grid, cells));
    }
  }

  ctx.globalAlpha = alpha * SHAPE_EDGE_ALPHA;
  ctx.strokeStyle = color;
  // Constant on screen at any zoom, like the grid and the rings.
  ctx.lineWidth = SHAPE_EDGE_WIDTH / frame.cam.zoom;
  if (dashed) ctx.setLineDash([7 / frame.cam.zoom, 5 / frame.cam.zoom]);
  ctx.lineJoin = 'round';

  ctx.beginPath();
  switch (kind) {
    case 'line':
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(e.x, e.y);
      break;

    case 'circle':
      ctx.arc(o.x, o.y, Math.hypot(e.x - o.x, e.y - o.y), 0, TAU);
      break;

    case 'rect':
      ctx.rect(o.x, o.y, e.x - o.x, e.y - o.y);
      break;

    case 'cone': {
      // Apex, out along one edge, round the far end, back along the other. An
      // arc, not a flat base, because a cone's length is measured from the apex,
      // so its far edge is every point at that distance.
      const length = Math.hypot(e.x - o.x, e.y - o.y);
      const heading = Math.atan2(e.y - o.y, e.x - o.x);
      ctx.moveTo(o.x, o.y);
      ctx.arc(o.x, o.y, length, heading - CONE_HALF_ANGLE, heading + CONE_HALF_ANGLE);
      ctx.closePath();
      break;
    }
  }
  ctx.stroke();

  ctx.restore();
}

/**
 * What each shape measures, beside its far point.
 *
 * Screen space, like the token names and the movement ruler, and for the same
 * reason: it is an annotation on the board, not something painted on the map,
 * so it keeps its size as the camera moves.
 */
function drawShapeLabels(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene, cam } = frame;

  ctx.save();
  ctx.font = SHAPE_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;

  const label = (shape: Shape | Sketch, origin: { x: number; y: number }): void => {
    // Nothing has been swept yet. The movement ruler drops its reading at zero
    // for the same reason: a "0 ft" flashing under the cursor is noise.
    if (shape.to.x === 0 && shape.to.y === 0) return;
    const end = shapeEnd(origin, shape.to);
    const world = gridToWorld(board.grid, end.x, end.y);
    const at = worldToScreen(cam, world.x, world.y);
    const text = labelFor(shape);
    ctx.strokeStyle = LABEL_HALO;
    ctx.strokeText(text, at.x + SHAPE_TEXT_GAP, at.y);
    ctx.fillStyle = LABEL_TEXT;
    ctx.fillText(text, at.x + SHAPE_TEXT_GAP, at.y);
  };

  for (const shape of scene.shapes) {
    const origin = shapeOrigin(scene, shape);
    if (origin !== null) label(shape, origin);
  }
  for (const sketch of frame.sketches) label(sketch, sketch.at);

  ctx.restore();
}

function drawTokens(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene, tokenImages, draggingIds, cam, identity, currentTurn, selectedId } = frame;

  for (const token of scene.tokens) {
    // Null is a token that is not on this board: one built on the map being
    // prepared, seen from the live one. Absent, not faint.
    const at = shownPos(scene, token);
    if (at === null) continue;

    // Per token, not per map: a token is `size` cells across, so a 2×2 fills
    // the four cells its centre sits at the corner of.
    const radius = (board.grid.px * token.size) / 2;
    const centre = gridToWorld(board.grid, at.x, at.y);
    const img = tokenImages.get(token.img);

    // Wraps the rings as well as the art: a hidden token must not have a faded
    // picture inside a full-strength outline.
    ctx.save();
    ctx.globalAlpha = alphaFor(token);

    ctx.save();

    if (draggingIds.has(token.id)) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = radius * 0.5;
    }

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, TAU);
    ctx.clip();

    if (img) {
      ctx.drawImage(img, centre.x - radius, centre.y - radius, radius * 2, radius * 2);
    } else {
      // Still loading, or a broken URL. A token that exists must be visible and
      // draggable regardless.
      ctx.fillStyle = '#5a6472';
      ctx.fill();
    }

    ctx.restore();

    // Over the art and inside the rim, which is why it is here and not in
    // `drawTokenChrome` with the name and the numerals: a mark is a property of
    // the creature, so it is drawn on the creature. Everything below is a
    // property of the *situation* (being dragged, whose turn it is, what this
    // gesture is about), and all of it draws outside.
    if (token.markers.length > 0) {
      drawMarks(ctx, centre, radius, cam.zoom, token.markers);
    }

    // One ring, five meanings: being dragged, not on the board yet, hidden,
    // yours, or none of them. The dash is separate from the colour and says
    // hidden on its own, so a token that is both teal and dashed reads as both,
    // not as whichever the precedence picked.
    const dragging = draggingIds.has(token.id);
    const mine = ownsToken(identity, token);

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, TAU);
    ctx.lineWidth =
      (dragging || mine || token.hidden || token.stagedOnly ? 2.5 : 1.5) / cam.zoom;
    ctx.strokeStyle = dragging
      ? DRAG_RING
      : token.stagedOnly
        ? STAGED_ONLY_RING
        : token.hidden
          ? HIDDEN_RING
          : mine
            ? OWNED_RING
            : TOKEN_RIM;
    if (token.hidden) ctx.setLineDash([6 / cam.zoom, 4 / cam.zoom]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Whose turn it is sits on its own ring outside the others, so a token can
    // be yours *and* acting without the two states fighting for one outline.
    if (token.id === currentTurn) {
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + 5 / cam.zoom, 0, TAU);
      ctx.lineWidth = 3 / cam.zoom;
      ctx.strokeStyle = TURN_RING;
      ctx.stroke();
    }

    // Further out again, and dashed. Two things land on this ring: the token the
    // DM is editing, and every member of a shift-click group. One ring for both
    // because they answer one question (which tokens is this gesture about),
    // and on a token that is both, two rings at the same radius would be one
    // ring drawn twice.
    //
    // The group is empty until somebody builds one, so a client that never
    // shift-clicks sees only the DM's edit ring, and for a player no ring at
    // all.
    if (token.id === selectedId || frame.selection.has(token.id)) {
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + 10 / cam.zoom, 0, TAU);
      ctx.lineWidth = 1.5 / cam.zoom;
      ctx.strokeStyle = SELECTED_RING;
      ctx.setLineDash([5 / cam.zoom, 4 / cam.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }
}

/**
 * The traced walls, and the run being traced over them.
 *
 * In world units, because a wall *is* a mark on the map image, unlike a name or
 * a ruler, which are annotations and keep their weight at every zoom. The
 * strokes are the exception: their widths are divided by zoom so a wall stays
 * three pixels of line whether the DM is tracing a doorway up close or checking
 * a whole floor at once.
 *
 * Nothing here is gated on identity. `shownWalls` is empty for a player because
 * the server sent them none, which is where that decision belongs: invariant 4
 * is about what a client holds, not about what it draws. It is also empty over
 * a preview for a DM who has not traced the next dungeon yet.
 */
function drawWalls(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { scene, cam, walls: editor } = frame;
  const traced = shownWalls(scene);
  if (traced.length === 0 && (editor === null || editor.run.length === 0)) return;

  const scale = 1 / cam.zoom;
  const armed = editor?.armed === true;
  ctx.save();
  ctx.lineCap = 'round';

  for (const wall of traced) {
    const open = wall.door === true;

    // Full strength while the editor is in hand, faint the rest of the time,
    // except for doors, which always stay legible because the DM can swing one
    // with no tool in hand at any point in the evening. Anything clickable is
    // drawn at full strength; plain walls, which are not, fade into the map.
    ctx.globalAlpha = armed || wall.door !== null ? 1 : WALL_IDLE_ALPHA;

    // Haloed like the grid and the rulers, and for the same reason: a rose line
    // on a rose-lit map would disappear. The halo is skipped for an open door,
    // which should read as a gap, not as structure.
    if (!open) {
      ctx.beginPath();
      ctx.moveTo(wall.from.x, wall.from.y);
      ctx.lineTo(wall.to.x, wall.to.y);
      ctx.setLineDash([]);
      ctx.strokeStyle = WALL_HALO;
      ctx.lineWidth = WALL_HALO_WIDTH * scale;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(wall.from.x, wall.from.y);
    ctx.lineTo(wall.to.x, wall.to.y);
    ctx.setLineDash(open ? [DOOR_OPEN_DASH * scale, DOOR_OPEN_DASH * scale] : []);
    ctx.strokeStyle =
      wall.id === editor?.hovered ? WALL_HOVER : wall.door === null ? WALL_LINE : DOOR_LINE;
    ctx.lineWidth = WALL_WIDTH * scale;
    ctx.stroke();
  }

  ctx.setLineDash([]);
  if (editor !== null && editor.run.length > 0) drawWallRun(ctx, scale, editor);
  ctx.restore();
}

/**
 * The corners placed so far and the rubber band to where the next one would go.
 *
 * Blue, like every other in-progress thing on this board: a calibration box, a
 * token being dragged, a movement ruler. It is drawn at full strength whatever
 * the walls under it are doing, because it is the thing being worked on.
 *
 * The band is dashed for the same reason it is blue: it is a proposal. It
 * exists only on this client until the run is finished, so a browser that
 * closes mid-trace leaves nothing behind to clean up.
 */
function drawWallRun(
  ctx: CanvasRenderingContext2D,
  scale: number,
  editor: NonNullable<Frame['walls']>,
): void {
  const { run, aim } = editor;
  ctx.globalAlpha = 1;
  ctx.strokeStyle = WALL_RUN;
  ctx.fillStyle = WALL_RUN;
  ctx.lineWidth = WALL_WIDTH * scale;

  const first = run[0];
  if (first === undefined) return;

  ctx.beginPath();
  ctx.moveTo(first.x, first.y);
  for (const corner of run.slice(1)) ctx.lineTo(corner.x, corner.y);
  ctx.stroke();

  const last = run[run.length - 1];
  if (aim !== null && last !== undefined) {
    ctx.beginPath();
    ctx.setLineDash([WALL_AIM_DASH * scale, WALL_AIM_DASH * scale]);
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(aim.x, aim.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // A dot on every corner placed, so a run doubling back on itself is still
  // countable, and so the DM can see that the click landed at all.
  for (const corner of run) {
    ctx.beginPath();
    ctx.arc(corner.x, corner.y, WALL_CORNER_R * scale, 0, TAU);
    ctx.fill();
  }
}

/**
 * The reference box the DM is dragging, with the grid it implies drawn inside
 * it. Those divisions are the real feedback: when the cell count is right they
 * land on the map's own printed lines, and the DM can see it before releasing.
 */
function drawCalibration(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  { box, cells, shape }: { box: Box; cells: number; shape: CalShape },
): void {
  // The isometric gesture is one cell *edge*, so the overlay is the diamond that
  // edge describes, not a box of squares. A box would suggest the DM is
  // selecting a region, which is the wrong thing to aim, and aiming is the hard
  // part of this gesture on art whose tiles are a few dozen pixels across.
  if (shape !== 'square') {
    drawCalibrationDiamond(ctx, cam, box, shape, cells);
    return;
  }

  const left = Math.min(box.x0, box.x1);
  const top = Math.min(box.y0, box.y1);
  const width = Math.abs(box.x1 - box.x0);
  const height = Math.abs(box.y1 - box.y0);

  ctx.fillStyle = CAL_FILL;
  ctx.fillRect(left, top, width, height);

  // The divisions are square, so the horizontal ones use the width-derived cell
  // size too, which is what makes a wrong cell count visible.
  const px = width / cells;
  if (px > 0) {
    ctx.beginPath();
    ctx.lineWidth = 1 / cam.zoom;
    ctx.strokeStyle = CAL_DIVISION;
    for (let i = 1; i < cells; i++) {
      ctx.moveTo(left + i * px, top);
      ctx.lineTo(left + i * px, top + height);
    }
    for (let y = top + px; y < top + height; y += px) {
      ctx.moveTo(left, y);
      ctx.lineTo(left + width, y);
    }
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.lineWidth = 2 / cam.zoom;
  ctx.strokeStyle = CAL_EDGE;
  ctx.strokeRect(left, top, width, height);
}

/**
 * The chain of diamonds a dragged edge describes, drawn where it was dragged.
 *
 * The drag runs corner to corner along one lattice direction, so it spans
 * `cells` whole cells; each is half a cell's width across and half its height
 * down from the last, and the other edges of each are that vector mirrored.
 * Drawn from the *start* of the drag, not from a bounding box, because the
 * corner the DM began on is what they are aiming.
 *
 * The chain is the feedback the count needs, like the divisions the square
 * path rules inside its box: with the count right, the diamonds land on the
 * tiles printed on the art, and the DM can see that before releasing. Dragging
 * along a whole room and dividing it is easier than aiming one tile, because a
 * mistake shows over the whole run instead of hiding in one tile and being
 * multiplied later.
 *
 * **The diamond comes from `isoDiamond`**, which `gridFromEdge` also builds the
 * lattice from. Under the fixed shape the drawn diamond is the pinned one, not
 * the loose one under the pointer, so the DM aims what they are about to
 * commit. If the two derived it separately, the preview could disagree with
 * the result.
 */
function drawCalibrationDiamond(
  ctx: CanvasRenderingContext2D,
  cam: Camera,
  box: Box,
  shape: IsoShape,
  cells: number,
): void {
  const diamond = isoDiamond(box, shape, cells);
  if (diamond === null) return;
  const { halfW, halfH } = diamond;

  // One cell along the drag: the step from one diamond in the chain to the
  // next. Its horizontal sign is whichever way the DM dragged; its
  // vertical is why the anchor below has two cases.
  const stepX = box.x1 >= box.x0 ? halfW : -halfW;
  const down = box.y1 >= box.y0;

  // Anchored on the corner the drag *began* on, which the DM aimed at a real
  // corner and which `gridFromEdge` reduces into the origin cell. Dragging
  // down from it makes it the first diamond's top corner and dragging up makes
  // it the bottom one. It is the same lattice either way, since all four
  // corners of a diamond are points of it, and the same lattice as the one
  // being committed even under the fixed shape, where the far end of the drag
  // is no longer a corner of anything.
  const apex = { x: box.x0, y: down ? box.y0 : box.y0 - halfH * 2 };

  ctx.beginPath();
  for (let i = 0; i < cells; i++) {
    const x = apex.x + i * stepX;
    const y = apex.y + i * (down ? halfH : -halfH);
    ctx.moveTo(x, y);
    ctx.lineTo(x + halfW, y + halfH);
    ctx.lineTo(x, y + halfH * 2);
    ctx.lineTo(x - halfW, y + halfH);
    ctx.closePath();
  }

  ctx.fillStyle = CAL_FILL;
  ctx.fill();
  ctx.lineWidth = 2 / cam.zoom;
  ctx.strokeStyle = CAL_EDGE;
  ctx.stroke();
}

/**
 * Whether this move passes through something that stops sight, which only the
 * DM's client can answer: a player holds no walls.
 *
 * **Asked of the board on screen**, through `shownWalls`. Over a staged map a
 * plan is measured against the staged walls, the dungeon it is a plan for;
 * testing it against the live board's walls would warn about a wall that is
 * not there.
 *
 * Recomputed per frame per ruler, not cached. It is a couple of hundred
 * segments against one line, the walls can change under it when a door swings,
 * and a cache would have to be invalidated by the one event most likely to be
 * the reason the DM is looking.
 */
function rulerBlocked(scene: Scene, board: Board, ruler: Ruler, at: Vec2): boolean {
  const walls = shownWalls(scene);
  if (walls.length === 0) return false;
  const from = gridToWorld(board.grid, ruler.from.x, ruler.from.y);
  const to = gridToWorld(board.grid, at.x, at.y);
  return crossesWall(walls, from, to);
}

/**
 * The squares each move crossed: the ruler's reading, drawn on the ground.
 *
 * World space, unlike the ruler's line and label, because these are cells and a
 * cell is a thing on the map: it has to sit on the grid at every zoom, the
 * opposite requirement from a label that must not shrink.
 *
 * One `cellPath` and one `fill`, as in `paintShape` and the fog preview: a move
 * is at most a few dozen squares, but there can be one of these per token in
 * flight, and a `fillRect` each would be a few hundred calls a frame.
 *
 * Every skip here must match `drawRulers`: the two are one annotation drawn in
 * two coordinate spaces, and a trail drawn on a frame where its reading was
 * skipped is a path with no number on the end of it.
 */
function drawTrails(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene, cam, rulers, now } = frame;
  if (rulers.size === 0) return;
  const staged = showingStaged(scene);
  const { grid } = board;

  ctx.save();
  for (const [id, ruler] of rulers) {
    if (ruler.staged !== staged) continue;

    const token = scene.tokens.find((t) => t.id === id);
    if (token === undefined) continue;
    const at = shownPos(scene, token);
    if (at === null) continue;

    const cells = trailCells(ruler.from, at);
    // Still in the cell it was picked up from: the same case the reading skips
    // on when it computes zero feet.
    if (cells.length === 0) continue;

    const alpha = rulerAlpha(ruler, now);
    if (alpha <= 0) continue;

    // The whole trail, not the squares either side of the wall: the DM is
    // being told this move went through something, and the hint isn't precise
    // enough to say which step did it.
    const colour = rulerBlocked(scene, board, ruler, at) ? RULER_BLOCKED : TRAIL_FILL;

    const path = cellPath(grid, cells);
    ctx.fillStyle = colour;
    ctx.strokeStyle = colour;
    ctx.globalAlpha = alpha * TRAIL_FILL_ALPHA;
    ctx.fill(path);
    ctx.globalAlpha = alpha * TRAIL_EDGE_ALPHA;
    ctx.lineWidth = 1 / cam.zoom;
    ctx.stroke(path);
  }
  ctx.restore();
}

/**
 * How far each token being dragged has come from where its drag began: ours as
 * we drag it, and everyone else's as their frames arrive.
 *
 * Screen space like the names and the hit point bars: a ruler is an annotation
 * on the board, not something painted on the map, so it keeps its weight at
 * every zoom. It is not faded for a hidden token the way the token chrome is:
 * it lasts a couple of seconds and exists to be read.
 */
function drawRulers(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene, cam, rulers } = frame;
  if (rulers.size === 0) return;
  const staged = showingStaged(scene);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.font = RULER_FONT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (const [id, ruler] of rulers) {
    // A ruler belongs to one of the two boards, and only the one on screen
    // draws: a live drag measured over a staged map is a line between two cells
    // nobody is looking at.
    if (ruler.staged !== staged) continue;

    const token = scene.tokens.find((t) => t.id === id);
    if (token === undefined) continue;
    const at = shownPos(scene, token);
    if (at === null) continue;

    const feet = feetMoved(ruler.from, at, scene.diagonals);
    // Still in the cell it was picked up from. There is nothing to report, and
    // a "0 ft" flashing under the cursor on every click is noise.
    if (feet === 0) continue;

    // Full while the drag runs, fading once it has landed. Set on the context
    // instead of folded into each colour, so the halo, the line and the text
    // fade together: they are one annotation, and a halo outliving its line by
    // a frame reads as a rendering fault.
    // `frame.now`, not destructured: the local `now` just below is where the
    // token is *now*, which pairs with `start` and reads better there.
    const alpha = rulerAlpha(ruler, frame.now);
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;

    const start = gridToWorld(board.grid, ruler.from.x, ruler.from.y);
    const now = gridToWorld(board.grid, at.x, at.y);
    const from = worldToScreen(cam, start.x, start.y);
    const to = worldToScreen(cam, now.x, now.y);
    const radius = (board.grid.px * token.size * cam.zoom) / 2;

    // Stopped at the token's edge instead of run under it, so the line points
    // at what is moving instead of crossing the art. A 4×4 dragged one cell has
    // not left its own radius, and gets the reading without the line.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);

    ctx.beginPath();
    ctx.arc(from.x, from.y, RULER_ORIGIN_R, 0, TAU);
    if (len > radius) {
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x - (dx / len) * radius, to.y - (dy / len) * radius);
    }
    ctx.strokeStyle = RULER_HALO;
    ctx.lineWidth = RULER_HALO_WIDTH;
    ctx.stroke();
    // Amber where the move went through a wall. The DM's screen only, and
    // without asking who they are: a player's scene carries no walls to hit.
    ctx.strokeStyle = rulerBlocked(scene, board, ruler, at) ? RULER_BLOCKED : RULER_LINE;
    ctx.lineWidth = RULER_WIDTH;
    ctx.stroke();

    // Beside the token, not above or below it, where the hit point bar and the
    // name already are.
    const text = `${feet} ft`;
    ctx.lineWidth = 3;
    ctx.strokeStyle = LABEL_HALO;
    ctx.strokeText(text, to.x + radius + RULER_TEXT_GAP, to.y);
    ctx.fillStyle = LABEL_TEXT;
    ctx.fillText(text, to.x + radius + RULER_TEXT_GAP, to.y);
  }

  ctx.restore();
}

/**
 * Every ring on the board, and an arrow at the edge for each one that is not.
 *
 * In screen space and sized in screen pixels: a ring measured in cells
 * vanishes when the camera pulls back, and pulling back to see the whole
 * dungeon is when somebody needs to point at a corner of it. Only its *anchor*
 * is world-space.
 *
 * There is no visibility test in this function. A ping is drawn wherever it
 * landed: over explored ground, over the fog, and over ground the party has
 * never seen. It carries a position and a name and nothing else (a ring over
 * black says somebody is pointing there, not what is standing there), and the
 * server relays it unfiltered for the same reason. See *Ping* in
 * `docs/drawings.md`.
 */
function drawPings(
  ctx: CanvasRenderingContext2D,
  view: Viewport,
  frame: Frame,
  board: Board,
): void {
  const { cam, pings, roster, colours, now } = frame;
  if (pings.length === 0) return;

  ctx.save();
  ctx.font = PING_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const ping of pings) {
    const alpha = ringAlpha(ping, now);
    const radius = ringRadius(ping, now);
    // A ring still inside its first 150ms, or one that has finished fading and
    // is about to be dropped from the list. Neither is a thing to draw.
    if (alpha <= 0 || radius <= 0) continue;

    const world = gridToWorld(board.grid, ping.at.x, ping.at.y);
    const at = worldToScreen(cam, world.x, world.y);
    const colour = colourOf(ping.owner, roster, colours);
    const name = nameOf(ping.owner, roster);

    ctx.globalAlpha = alpha;

    // Off the edge of the view: an arrow instead of a ring, because six people
    // looking at different parts of the map is the normal case and a ping
    // nobody sees is worse than no ping at all. Never a camera pan; see
    // `edgeMarker`.
    const edge = edgeMarker(at, view, EDGE_INSET_PX);
    if (edge !== null) {
      drawPingArrow(ctx, edge.at, edge.angle, colour);
      label(ctx, name, edge.at.x, edge.at.y + PING_ARROW_PX, colour);
      continue;
    }

    ctx.beginPath();
    ctx.arc(at.x, at.y, radius, 0, TAU);
    ctx.strokeStyle = PING_HALO;
    ctx.lineWidth = PING_HALO_WIDTH;
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = PING_WIDTH;
    ctx.stroke();

    // Under the ring, not inside it. A name in the middle competes with
    // whatever is being pointed at, which the gesture exists to make legible.
    label(ctx, name, at.x, at.y + radius + PING_TEXT_GAP, colour);
  }

  ctx.restore();
}

/**
 * Everybody else's pointer, in their own colour with their name beside it.
 *
 * No visibility test here either, but for a different reason from
 * `drawPings`. A ping is drawn unfiltered because it is relayed unfiltered;
 * a cursor is drawn unfiltered because the *room* has already filtered it
 * (`cursor_seen`): the DM's pointer over ground the party has not explored
 * never arrives, so there is nothing on this side to withhold. A client cannot
 * draw what it was not sent (invariant 4).
 *
 * Off the edge of the view, nothing is drawn, unlike a ping. A ping gets an
 * edge arrow because it is a deliberate gesture that would otherwise be
 * missed; seven permanent markers around the border for hands that are simply
 * elsewhere would be clutter. The canvas clips these for free.
 */
function drawCursors(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { cam, cursors, roster, colours, now } = frame;
  if (cursors.length === 0) return;

  ctx.save();
  ctx.font = CURSOR_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';

  for (const cursor of cursors) {
    const alpha = cursorAlpha(cursor, now);
    if (alpha <= 0) continue;

    const world = gridToWorld(board.grid, cursor.at.x, cursor.at.y);
    const at = worldToScreen(cam, world.x, world.y);
    const colour = colourOf(cursor.owner, roster, colours);

    ctx.globalAlpha = alpha * CURSOR_ALPHA;
    drawDot(ctx, at, colour);
    // Under it, like a ping's name and for the same reason: a mark on the board
    // must not cover what it is marking.
    label(
      ctx,
      nameOf(cursor.owner, roster),
      at.x,
      at.y + CURSOR_R_PX + CURSOR_TEXT_GAP,
      colour,
    );
  }

  ctx.restore();
}

/** The pointer glyph: a small filled dot on the spot, with the dark halo every
 *  other mark on this canvas gets. Without it a coloured circle is a smudge on
 *  a parchment map and invisible on a cave floor. */
function drawDot(ctx: CanvasRenderingContext2D, at: Vec2, colour: string): void {
  ctx.beginPath();
  ctx.arc(at.x, at.y, CURSOR_R_PX, 0, TAU);
  ctx.strokeStyle = PING_HALO;
  ctx.lineWidth = CURSOR_HALO_WIDTH;
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
}

/** A filled triangle pointing along `angle`, in the sender's colour with the
 *  same dark halo the ring gets, so a cursor-sized arrow still reads on a light
 *  map. */
function drawPingArrow(
  ctx: CanvasRenderingContext2D,
  at: Vec2,
  angle: number,
  colour: string,
): void {
  ctx.save();
  ctx.translate(at.x, at.y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(PING_ARROW_PX, 0);
  ctx.lineTo(-PING_ARROW_PX * 0.7, PING_ARROW_PX * 0.75);
  ctx.lineTo(-PING_ARROW_PX * 0.7, -PING_ARROW_PX * 0.75);
  ctx.closePath();
  ctx.strokeStyle = PING_HALO;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
  ctx.restore();
}

/** Text with the halo every other label on this canvas gets, so a name is
 *  legible over a cave floor and over parchment alike. The colour is the
 *  sender's, because a name and a ring in different colours read as two people
 *  at a glance. */
function label(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  colour: string,
): void {
  ctx.lineWidth = 3;
  ctx.strokeStyle = LABEL_HALO;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = colour;
  ctx.fillText(text, x, y);
}

/**
 * The name under each token and the DM's hit point bar over it, both in screen
 * space so they keep a fixed size as the camera zooms.
 *
 * `scene.showNames` puts the names away for everyone at once. It is the DM's
 * switch and the same value on every client, so this is not a visibility
 * decision and there is nothing here to filter. It doesn't affect the bar: a
 * running total is not a label, it already reaches nobody but the DM, and a
 * switch that hid it as well would be two features on one checkbox.
 */
function drawTokenChrome(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene, cam } = frame;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';

  for (const token of scene.tokens) {
    // The same skip as `drawTokens`: a token with no name drawn under it is
    // better than a name floating over a board the token is not on.
    const at = shownPos(scene, token);
    if (at === null) continue;

    ctx.globalAlpha = alphaFor(token);

    const centre = gridToWorld(board.grid, at.x, at.y);
    const radius = (board.grid.px * token.size) / 2;

    if (token.hp !== null) {
      drawHitPoints(ctx, worldToScreen(cam, centre.x, centre.y - radius), radius * cam.zoom, token.hp);
    }

    if (!scene.showNames) continue;

    // Under the token's own edge, so a name does not land inside a big one.
    const p = worldToScreen(cam, centre.x, centre.y + radius);
    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.lineWidth = 3;
    ctx.strokeStyle = LABEL_HALO;
    ctx.fillStyle = LABEL_TEXT;
    ctx.strokeText(token.name, p.x, p.y + 4);
    ctx.fillText(token.name, p.x, p.y + 4);
  }

  ctx.restore();
}

/**
 * The DM's running total: a bar to sort six monsters by at a glance, and the
 * numbers to subtract the next hit from.
 *
 * This never runs on a player's screen, and not because of a check here: `hp`
 * is redacted server-side, so their copy of the token carries null and there is
 * nothing to decline to draw (invariant 4).
 *
 * `top` is the middle of the token's upper edge in screen pixels, `radius` its
 * radius in the same.
 */
function drawHitPoints(
  ctx: CanvasRenderingContext2D,
  top: { x: number; y: number },
  radius: number,
  hp: Hp,
): void {
  const width = clamp(radius * 2, HP_BAR_MIN_W, HP_BAR_MAX_W);
  const left = top.x - width / 2;
  const y = top.y - HP_BAR_GAP - HP_BAR_H;
  // A maximum of zero has no ratio to draw. The numbers below still say what
  // happened, which is why the bar is allowed to be the part that gives up.
  const filled = hpFilled(hp);

  ctx.fillStyle = HP_TRACK;
  ctx.fillRect(left, y, width, HP_BAR_H);
  if (filled > 0) {
    ctx.fillStyle = hpColour(filled);
    ctx.fillRect(left, y, width * filled, HP_BAR_H);
  }
  // Half-pixel inset so a 1px stroke lands on pixels instead of straddling two.
  ctx.lineWidth = 1;
  ctx.strokeStyle = HP_EDGE;
  ctx.strokeRect(left + 0.5, y + 0.5, width - 1, HP_BAR_H - 1);

  // Haloed like the name below, and for the same reason: it has to read on
  // parchment and on a cave floor without the DM thinking about it.
  const text = `${hp.current}/${hp.max}`;
  ctx.font = HP_FONT;
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = LABEL_HALO;
  ctx.strokeText(text, top.x, y - HP_TEXT_GAP);
  ctx.fillStyle = LABEL_TEXT;
  ctx.fillText(text, top.x, y - HP_TEXT_GAP);
}

/**
 * The DM's marks on a creature: a band of arcs stroked inside the token's own
 * rim, and an X across the portrait for `dead`.
 *
 * **Rules-neutral**: this draws arcs and two lines, and there is nowhere in it
 * for a rule to live. Nothing here knows what any mark means, including
 * `dead`, which changes nothing about how the token behaves and is a picture
 * like the other six. Keep it that way; see the non-goal in
 * `.claude/CLAUDE.md`.
 *
 * No check for who is reading it, unlike the hit point bar and like the name.
 * Markers are public: `view_for` copies them for everybody, so a player's copy
 * of a token carries the same list and draws the same band. A mark the table
 * cannot see would be useless.
 *
 * World space, unlike the name and the numerals, because these are drawn *on*
 * the token, not pinned above it; the widths divide by `zoom` so they keep a
 * constant weight on screen, as the rings do. The caller has already set
 * `globalAlpha`, so a hidden creature's marks fade with the rest of it.
 */
function drawMarks(
  ctx: CanvasRenderingContext2D,
  centre: Vec2,
  radius: number,
  zoom: number,
  markers: readonly Marker[],
): void {
  // **Sorted into `MARKERS` order, not the order the DM added them in.** The
  // room stores the list unsorted, so two creatures carrying red and blue can
  // carry them either way round. The band has to be in a fixed order so the
  // same marks look the same on two monsters at a glance.
  const arcs = markers
    .filter(isColour)
    .sort((a, b) => MARKERS.indexOf(a) - MARKERS.indexOf(b));

  ctx.save();

  if (arcs.length > 0) {
    // Centred half a band's width inside the rim, so the band's outer edge
    // meets it and the two read as one edge, not as two rings.
    const r = radius - MARKER_BAND_W / 2 / zoom;
    // A 0.5-cell token zoomed a long way out has a radius smaller than the band
    // is thick, and an arc at a negative radius throws.
    if (r > 0) {
      ctx.lineWidth = (MARKER_BAND_W + 2) / zoom;
      ctx.strokeStyle = MARKER_TRACK;
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, r, 0, TAU);
      ctx.stroke();

      // One mark takes the whole band and there is no gap to leave; two or more
      // divide it evenly from twelve o'clock clockwise. Dividing, not stacking,
      // keeps the footprint identical whether a creature carries one mark or
      // six. Don't draw a ring per marker: the token would grow with each mark.
      ctx.lineWidth = MARKER_BAND_W / zoom;
      const step = TAU / arcs.length;
      const gap = arcs.length > 1 ? MARKER_ARC_GAP : 0;

      arcs.forEach((marker, i) => {
        const from = -Math.PI / 2 + i * step + gap / 2;
        ctx.beginPath();
        ctx.arc(centre.x, centre.y, r, from, from + step - gap);
        ctx.strokeStyle = MARKER_HUES[marker];
        ctx.stroke();
      });
    }
  }

  // Across the portrait, not round it, because it is not one of the arcs and
  // must not be mistaken for one. Haloed the way a name is, the convention on
  // this canvas for anything that has to read on parchment and on a cave floor
  // alike, which makes the X look like a label and the arcs like a ring.
  if (markers.includes('dead')) {
    const reach = radius * DEAD_X_REACH;
    ctx.lineCap = 'round';
    for (const [w, colour] of [
      [DEAD_X_W + 3, LABEL_HALO],
      [DEAD_X_W, MARKER_HUES.dead],
    ] as const) {
      ctx.lineWidth = w / zoom;
      ctx.strokeStyle = colour;
      ctx.beginPath();
      ctx.moveTo(centre.x - reach, centre.y - reach);
      ctx.lineTo(centre.x + reach, centre.y + reach);
      ctx.moveTo(centre.x + reach, centre.y - reach);
      ctx.lineTo(centre.x - reach, centre.y + reach);
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * How full a hit point bar is, 0 to 1.
 *
 * A maximum of zero has no ratio to draw. The numbers beside the bar still say
 * what happened, which is why the bar is allowed to be the part that gives up.
 */
export function hpFilled(hp: Hp): number {
  return hp.max > 0 ? clamp(hp.current / hp.max, 0, 1) : 0;
}

/**
 * The colour a bar that full is drawn in.
 *
 * Exported with `hpFilled` for the initiative panel, which draws the same bar
 * in DOM. Two copies of these three numbers would let the board and the panel
 * disagree about which monster is nearly down. Three bands, not a gradient,
 * for the reason given where the colours are defined: a DM glancing at six
 * monsters is sorting them, not reading a percentage.
 */
export function hpColour(filled: number): string {
  return filled > 0.5 ? HP_HEALTHY : filled > 0.25 ? HP_HURT : HP_LOW;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

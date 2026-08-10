import type { Box } from './calibrate.js';
import type { Camera, Rect, Vec2 } from './coords.js';
import { firstLineAt, gridToWorld, playRect, worldToScreen } from './coords.js';
import { darkFill, fogRect } from './fog.js';
import type { Identity } from './identity.js';
import { ownsToken } from './identity.js';
import { OVERRIDE_ALPHA, overrideRect, paintColor } from './overrides.js';
import type { FogPaint, Hp } from './protocol.js';
import type { Ruler } from './ruler.js';
import { feetMoved } from './ruler.js';
import type { Board, Scene, Token } from './scene.js';
import { shownBoard, shownPos, showingStaged } from './scene.js';
import type { Shape, Sketch } from './shapes.js';
import { CONE_HALF_ANGLE, coveredCells, isArea, labelFor, shapeEnd, shapeOrigin } from './shapes.js';

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
 * halo on cells six pixels apart is not a grid, it is a dark wash — and zoomed
 * out that far the grid is orientation, not something anyone measures against.
 */
const HALO_MIN_CELL_PX = 14;
/** Laid over the parts of the image outside the play area. */
const OUTSIDE_PLAY_AREA = 'rgba(11, 13, 16, 0.55)';
/** The fill a click would commit, before it is committed. Translucent, and
 *  outlined at full strength — the outline is the region and the fill is what it
 *  would become, which is the same split a drawn shape makes. */
const PREVIEW_FILL_ALPHA = 0.3;
const TOKEN_RIM = 'rgba(0, 0, 0, 0.55)';
/** Yours. Warm, so it never reads as the blue "being dragged" state. */
const OWNED_RING = 'rgba(240, 212, 140, 0.9)';
const DRAG_RING = 'rgba(120, 190, 255, 0.95)';
/** The token the DM's panel is editing. Dashed, so it cannot be mistaken for
 *  ownership or for whose turn it is — both of which are solid rings. */
const SELECTED_RING = 'rgba(120, 190, 255, 0.9)';
/** Acting this turn. Neutral white, so it reads against every token hue and
 *  never competes with the ownership ring it sits outside of. */
const TURN_RING = 'rgba(255, 255, 255, 0.95)';
const LABEL_TEXT = '#e8e6e1';
const LABEL_HALO = 'rgba(0, 0, 0, 0.85)';
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
/** Hidden. Violet, so it collides with nothing the ring vocabulary already
 *  means: gold is yours, blue is in progress, white is the turn. */
const HIDDEN_RING = 'rgba(178, 156, 232, 0.95)';
/**
 * Does not exist on the board yet — only on the map being prepared. Teal, the
 * last hue the ring vocabulary has left, and solid: this token is as draggable
 * as any other, which is the whole of what replaced ghosting.
 *
 * Tokens no longer fade over a staged map. Fading meant "not a piece", and
 * everything on that board is a piece now; what is worth drawing instead is
 * which of them are real yet. Hidden still fades and still dashes, so a monster
 * built on the next map *and* hidden reads as teal, faint and dashed — three
 * marks for three independent facts, none of which cancels another.
 */
const STAGED_ONLY_RING = 'rgba(96, 200, 190, 0.95)';

/**
 * The movement ruler, in the same blue as a drag — it only ever exists during
 * one, and "in progress" is exactly what it means. Haloed like the labels are,
 * because it has to read on parchment and on a cave floor alike.
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

/** The hit point bar, in screen pixels — it does not scale with the camera, for
 *  the same reason a name does not. */
const HP_BAR_H = 5;
const HP_BAR_MIN_W = 30;
const HP_BAR_MAX_W = 92;
/** Between the token's edge and the bar, and between the bar and the numbers. */
const HP_BAR_GAP = 6;
const HP_TEXT_GAP = 2;
const HP_FONT = '600 11px ui-sans-serif, system-ui, sans-serif';
const HP_TRACK = 'rgba(0, 0, 0, 0.55)';
const HP_EDGE = 'rgba(0, 0, 0, 0.85)';
/** Three bands rather than a gradient: a DM glancing at six monsters wants to
 *  sort them, not read a percentage. Nothing here knows what "bloodied" means. */
const HP_HEALTHY = 'rgba(122, 184, 116, 0.95)';
const HP_HURT = 'rgba(214, 173, 84, 0.95)';
const HP_LOW = 'rgba(200, 92, 92, 0.95)';

/**
 * How solidly a drawn shape's outline and its cell tint go down.
 *
 * The colour on the wire carries its own alpha, and these multiply it: an
 * outline is meant to be read and a fill is meant to be seen through, because
 * whatever is standing under a spell area is the thing anyone is actually
 * looking at. A sketch is drawn fainter still — it is a proposal, not a fact.
 */
const SHAPE_FILL_ALPHA = 0.24;
const SHAPE_EDGE_ALPHA = 1;
const SKETCH_ALPHA = 0.75;
const SHAPE_EDGE_WIDTH = 2;
/** The shape the pointer would erase, so a click is never a surprise. */
const SHAPE_HOVER_ALPHA = 0.4;
const SHAPE_FONT = '600 12px ui-sans-serif, system-ui, sans-serif';
/** Between a shape's far point and its reading. */
const SHAPE_TEXT_GAP = 8;

/**
 * Traced walls, and the doors hung in them.
 *
 * Rose and amber, neither of which the board says anything else with — the ring
 * vocabulary is gold, blue, white, violet and teal, and the drawing palette
 * avoids all five. A door is told from a wall by hue and by whether it is open
 * by dash: solid blocks, dashed does not, which is the same thing the line is
 * about to mean once there is sight to block.
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
 * DM is actually working on them.
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
  /** Token art, keyed by image URL — see `loadArt` in main.ts. */
  tokenImages: Map<string, HTMLImageElement>;
  draggingId: string | null;
  /** Movement rulers by token id — ours and everyone else's alike. */
  rulers: ReadonlyMap<string, Ruler>;
  /** The token the DM has selected for editing. Null for everyone else. */
  selectedId: string | null;
  /** Every sweep in progress — ours and everyone else's. */
  sketches: readonly Sketch[];
  /** The shape the pointer is over and could erase, or null. Only ever set
   *  while the draw tool is in hand, since that is the only time clicking a
   *  shape means anything. */
  hoveredShapeId: string | null;
  /** Token acting this turn, or null when combat is not running. */
  currentTurn: string | null;
  /** The DM's in-progress grid reference box. Null for everyone else. */
  calibration: { box: Box; cells: number } | null;
  /** The wall editor's state: whether it is armed, the run being traced, where
   *  the next corner would land, and which segment the pointer is over.
   *
   *  Null for a player — but the walls themselves are gated by being absent
   *  from their scene rather than by this, which is the difference between a
   *  secret and a widget. */
  walls: {
    armed: boolean;
    run: readonly Vec2[];
    aim: Vec2 | null;
    hovered: string | null;
  } | null;
  /** The fog tool's state: whether the panel is open, what the brush is loaded
   *  with, and the cells a fill would take if the DM clicked now.
   *
   *  Null for a player, who has no panel and — like the walls above — no
   *  overrides in their scene to draw either way. `armed` only decides how
   *  strongly the layer washes, because unlike the wall editor this tool has
   *  nothing to draw that is not already on the board. */
  fog: {
    armed: boolean;
    paint: FogPaint | null;
    /** Flat pairs, the way `coveredCells` returns them: this can be a few
     *  thousand cells and it is rebuilt as the pointer crosses into a new one. */
    preview: readonly number[];
  } | null;
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
  // Under the tokens, and that is the DM's half of the feature: their monsters
  // stay at full strength over a faint wash, so the board they are playing on is
  // still legible while it also says what the table can see. A player has no
  // token in the dark to be washed out — every one they hold is a vision source,
  // or is standing where one is looking — so the order costs them nothing.
  //
  // Nothing while previewing. The staged map has no fog: the bitsets belong to
  // the board, exactly as the walls and the shapes do.
  if (!showingStaged(frame.scene)) drawFog(ctx, frame, board, area);

  // And directly over it, because it is an annotation *on* the fog: which parts
  // of that wash the DM put there by hand rather than the walls casting. A
  // player's scene has none, so this draws nothing for them without needing to
  // ask who they are.
  if (!showingStaged(frame.scene)) drawOverrides(ctx, frame, board);

  drawTokens(ctx, frame, board);

  // Over the tokens, not under them. A spell area is being asked about *now* —
  // where it reaches and who is caught in it — so it has to read across the
  // creatures inside it rather than being hidden by the two of them standing on
  // top. The fill is translucent enough that a token under one is still a
  // token, and its name and hit points are drawn later still, in screen space,
  // so nothing a shape covers becomes unreadable.
  //
  // Nothing is drawn while previewing. Shapes belong to the board, the staged
  // map has none, and painting the board's onto the map being prepared would
  // put a fireball on a dungeon it was never cast in.
  if (!showingStaged(frame.scene)) drawShapes(ctx, frame, board);

  // Over everything on the board, and for a different reason than the shapes
  // are: a wall is not about what is standing on it, it is the room the tokens
  // are standing *in*, and it has to be traceable across a crowded board. The
  // staged map is not this map, so nothing here belongs on it — the same rule
  // the drawings follow one line up.
  if (!showingStaged(frame.scene)) drawWalls(ctx, frame);

  if (frame.calibration !== null) drawCalibration(ctx, cam, frame.calibration);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(view.dpr, view.dpr);
  // Under the chrome: a name or a hit point bar is worth more than the line
  // that happens to be passing behind it.
  if (!showingStaged(frame.scene)) drawShapeLabels(ctx, frame, board);
  drawRulers(ctx, frame, board);
  drawTokenChrome(ctx, frame, board);
}

/**
 * How solidly a token draws. One reason to fade now: the table cannot see it.
 *
 * `globalAlpha` is canvas state rather than an argument, so every caller pairs
 * its set with a `restore`. Left set, it survives into the next frame and washes
 * out the map itself — including the fill meant to clear the previous one.
 */
function alphaFor(token: Token): number {
  return token.hidden ? HIDDEN_ALPHA : 1;
}

/**
 * The grid, drawn as a contrasting halo with the chosen colour on top.
 *
 * A single translucent stroke can only work against backgrounds it happens to
 * contrast with — white at 10% is fine on a cave floor and invisible on
 * parchment. Two strokes of the same path fix that for nothing: whichever of
 * the pair the map does not match is the one you see. It is the same trick the
 * token labels already use for text.
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

  // Lines fall on `offset + n * px` wherever the play area happens to start, so
  // moving the board around never shifts the grid off the cells it describes.
  // The slack on the far edge is float slop — the right and bottom edges are
  // usually exact multiples, and dropping their line looks like a bug.
  const right = area.x + area.w;
  const bottom = area.y + area.h;
  const slack = grid.px * 1e-6;

  ctx.beginPath();
  for (let x = firstLineAt(area.x, grid.offsetX, grid.px); x <= right + slack; x += grid.px) {
    ctx.moveTo(x, area.y);
    ctx.lineTo(x, bottom);
  }
  for (let y = firstLineAt(area.y, grid.offsetY, grid.px); y <= bottom + slack; y += grid.px) {
    ctx.moveTo(area.x, y);
    ctx.lineTo(right, y);
  }

  // Both widths stay constant on screen at any zoom: the transform scales world
  // units by cam.zoom, so n/zoom world units is always n CSS pixels.
  if (grid.px * frame.cam.zoom >= HALO_MIN_CELL_PX) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = GRID_HALO_WIDTH / frame.cam.zoom;
    ctx.stroke();
  }

  // The same path, stroked again — building it twice would be the only cost.
  ctx.strokeStyle = board.gridColor;
  ctx.lineWidth = GRID_CORE_WIDTH / frame.cam.zoom;
  ctx.stroke();
}

/**
 * The fog: dark where the party has never been, dim where they have been and
 * are not, and clear where they are looking.
 *
 * **One `drawImage`, whatever the dungeon looks like.** The fog arrives as a
 * rectangle of cells and `fog.ts` has already turned it into a canvas one pixel
 * per cell, so this stretches that over the board instead of filling a few
 * thousand rectangles every frame. Smoothing is off, which is what keeps the
 * edge on the cell boundary the server actually decided rather than half a cell
 * either side of it.
 *
 * Everything outside that rectangle is dark by definition — the rectangle is
 * only as big as what has been explored — so the four bands around it are filled
 * flat, clipped to the board. Same trick as the play-area dim below, and here it
 * is what lets the packed frame shrink to the interesting part of a large map.
 *
 * Nothing here is a visibility decision. A creature the table cannot see is
 * absent from the scene rather than painted over: drawing it and covering it
 * would put the position on the client, which is what invariant 4 forbids.
 */
function drawFog(
  ctx: CanvasRenderingContext2D,
  frame: Frame,
  board: Board,
  area: Rect,
): void {
  const { fog } = frame.scene;
  if (fog === null || area.w <= 0 || area.h <= 0) return;

  const right = area.x + area.w;
  const bottom = area.y + area.h;

  ctx.save();
  // Clipped so the bands below can be drawn generously without darkening the
  // margin outside the board, which has its own dim and its own reason for it.
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.fillStyle = darkFill(frame.identity.isDm);

  // Nothing explored at all: the whole board is dark, and there is no rectangle
  // to cut out of it.
  if (fog.shade === null) {
    ctx.fillRect(area.x, area.y, area.w, area.h);
    ctx.restore();
    return;
  }

  const seen = fogRect(fog, board.grid);
  const seenRight = seen.x + seen.w;
  const seenBottom = seen.y + seen.h;
  ctx.fillRect(area.x, area.y, area.w, seen.y - area.y);
  ctx.fillRect(area.x, seenBottom, area.w, bottom - seenBottom);
  ctx.fillRect(area.x, seen.y, seen.x - area.x, seen.h);
  ctx.fillRect(seenRight, seen.y, right - seenRight, seen.h);

  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(fog.shade, seen.x, seen.y, seen.w, seen.h);
  ctx.imageSmoothingEnabled = smoothing;
  ctx.restore();
}

/**
 * The DM's manual override, and the fill they are about to commit.
 *
 * Two layers with one thing in common: neither is a visibility decision. The
 * board is already dark where the party cannot see; this says which of that the
 * DM *decided*, which they cannot otherwise tell a blacked-out room from a wall's
 * shadow. With no undo, that difference is the whole usability of the tool.
 *
 * The same `drawImage` trick the fog uses, for the same reason — a filled dungeon
 * room is a few thousand cells — and the same reason smoothing goes off: the edge
 * belongs on the cell boundary that was actually painted.
 *
 * Faint while the DM is playing, stronger while the panel is open. Masonry's
 * bargain, and it is why this is one `globalAlpha` rather than two canvases.
 */
function drawOverrides(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { overrides } = frame.scene;
  const tool = frame.fog;

  if (overrides.tint !== null) {
    const at = overrideRect(overrides, board.grid);
    ctx.save();
    ctx.globalAlpha = tool?.armed === true ? OVERRIDE_ALPHA.armed : OVERRIDE_ALPHA.idle;
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(overrides.tint, at.x, at.y, at.w, at.h);
    ctx.imageSmoothingEnabled = smoothing;
    ctx.restore();
  }

  // The fill the DM has not committed yet, in the colour it would commit in.
  // Drawn as one path of a few thousand `rect`s, which is what the shape tint
  // already does and for the same reason a `fillRect` each would not be.
  if (tool === null || tool.preview.length === 0) return;
  const { grid } = board;
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < tool.preview.length; i += 2) {
    const corner = gridToWorld(grid, tool.preview[i] ?? 0, tool.preview[i + 1] ?? 0);
    ctx.rect(corner.x, corner.y, grid.px, grid.px);
  }
  ctx.globalAlpha = PREVIEW_FILL_ALPHA;
  ctx.fillStyle = paintColor(tool.paint);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = paintColor(tool.paint);
  ctx.lineWidth = 1 / frame.cam.zoom;
  ctx.stroke();
  ctx.restore();
}

/**
 * Dims the image outside the play area, so the board reads as the board.
 *
 * Four rectangles around it rather than one fill with a hole: the alternative
 * is an even-odd path, which is more machinery to say the same thing.
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
 * any background. Null when the colour is fully transparent — there is nothing
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
 * picture — the only difference is that one of them is a fact and the other is
 * somebody's mouse still being held down, which is what the dash says.
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
      ctx.beginPath();
      for (let i = 0; i < cells.length; i += 2) {
        const cx = cells[i] ?? 0;
        const cy = cells[i + 1] ?? 0;
        const corner = gridToWorld(grid, cx, cy);
        ctx.rect(corner.x, corner.y, grid.px, grid.px);
      }
      ctx.globalAlpha = alpha * fillAlpha;
      ctx.fillStyle = color;
      ctx.fill();
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
      // Apex, out along one edge, round the far end, back along the other. The
      // arc rather than a flat base because the far edge of a wedge is every
      // point at the same distance from the apex, which is what it is measured
      // in — the same reason a circle is not a square.
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
 * reason: it is an annotation on the board rather than something painted on the
 * map, so it keeps its size as the camera moves.
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
  const { scene, tokenImages, draggingId, cam, identity, currentTurn, selectedId } = frame;

  for (const token of scene.tokens) {
    // Null is a token that is not on this board — one built on the map being
    // prepared, seen from the live one. Absent, not faint.
    const at = shownPos(scene, token);
    if (at === null) continue;

    // Per token, not per map: a token is `size` cells across, so a 2×2 fills
    // the four cells its centre sits at the corner of.
    const radius = (board.grid.px * token.size) / 2;
    const centre = gridToWorld(board.grid, at.x, at.y);
    const img = tokenImages.get(token.img);

    // Wraps the rings as well as the art: fading only the picture and leaving a
    // full-strength outline round it is what a hidden token must not look like.
    ctx.save();
    ctx.globalAlpha = alphaFor(token);

    ctx.save();

    if (token.id === draggingId) {
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

    // One ring, five meanings now: being dragged, not on the board yet, hidden,
    // yours, or none of them. The dash is separate from the colour and says
    // hidden on its own, so a token that is both teal and dashed reads as both
    // rather than as whichever the precedence happened to pick.
    const dragging = token.id === draggingId;
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

    // Further out again, and dashed. Only the DM ever has a selection, and it
    // has to survive being drawn on a token that is also owned and also acting.
    if (token.id === selectedId) {
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
 * In world units, because a wall *is* a mark on the map image — unlike a name or
 * a ruler, which are annotations and keep their weight at every zoom. The
 * strokes are the exception: their widths are divided by zoom so a wall stays
 * three pixels of line whether the DM is tracing a doorway up close or checking
 * a whole floor at once.
 *
 * Nothing here is gated on identity. `scene.walls` is empty for a player because
 * the server sent them none, which is where that decision belongs — invariant 4
 * is about what a client holds, not about what it draws.
 */
function drawWalls(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { scene, cam, walls: editor } = frame;
  if (scene.walls.length === 0 && (editor === null || editor.run.length === 0)) return;

  const scale = 1 / cam.zoom;
  const armed = editor?.armed === true;
  ctx.save();
  ctx.lineCap = 'round';

  for (const wall of scene.walls) {
    const open = wall.door === true;

    // Full strength while the editor is in hand, faint the rest of the time —
    // except for doors, which stay legible always, because the DM can swing one
    // with no tool in hand at any point in the evening. Anything clickable is
    // drawn like it is; masonry, which is not, recedes into the map.
    ctx.globalAlpha = armed || wall.door !== null ? 1 : WALL_IDLE_ALPHA;

    // Haloed like the grid and the rulers, and for the same reason: a rose line
    // on a rose-lit map is not a line. The halo is skipped for an open door,
    // which is meant to read as absence rather than as structure.
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
 * Blue, like every other in-progress thing on this board — a calibration box, a
 * token being dragged, a movement ruler. It is drawn at full strength whatever
 * the walls under it are doing, because it is the thing being worked on.
 *
 * The band is dashed for the reason it is blue: it is a proposal. Nothing about
 * it exists anywhere but this client until the run is finished, which is also
 * why a browser that closes mid-trace leaves nothing behind to clean up.
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
  // countable — and so the DM can see that the click landed at all.
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
  { box, cells }: { box: Box; cells: number },
): void {
  const left = Math.min(box.x0, box.x1);
  const top = Math.min(box.y0, box.y1);
  const width = Math.abs(box.x1 - box.x0);
  const height = Math.abs(box.y1 - box.y0);

  ctx.fillStyle = CAL_FILL;
  ctx.fillRect(left, top, width, height);

  // The divisions are square, so the horizontal ones use the width-derived cell
  // size too — which is exactly what makes a wrong cell count visible.
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
 * How far each token being dragged has come from where its drag began — ours as
 * we drag it, and everyone else's as their frames arrive.
 *
 * Screen space like the names and the hit point bars: a ruler is an annotation
 * on the board rather than something painted on the map, so it keeps its weight
 * at every zoom. It is deliberately not faded for a hidden token the way the
 * chrome above it is — it lasts a couple of seconds and its entire job is to be
 * read.
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

    const feet = feetMoved(ruler.from, at);
    // Still in the cell it was picked up from. There is nothing to report, and
    // a "0 ft" flashing under the cursor on every click is noise.
    if (feet === 0) continue;

    const start = gridToWorld(board.grid, ruler.from.x, ruler.from.y);
    const now = gridToWorld(board.grid, at.x, at.y);
    const from = worldToScreen(cam, start.x, start.y);
    const to = worldToScreen(cam, now.x, now.y);
    const radius = (board.grid.px * token.size * cam.zoom) / 2;

    // Stopped at the token's edge rather than run under it, so the line points
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
    ctx.strokeStyle = RULER_LINE;
    ctx.lineWidth = RULER_WIDTH;
    ctx.stroke();

    // Beside the token rather than above or below it, where the hit point bar
    // and the name already are.
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
 * The name under each token and the DM's hit point bar over it, both in screen
 * space so they keep a fixed size as the camera zooms — the things on the map
 * that should not scale with the world.
 *
 * `scene.showNames` puts the names away, for everyone at once — it is the DM's
 * switch and the same value on every client, so this is not a visibility
 * decision and there is nothing here to filter. The bar is untouched by it: a
 * running total is not a label, it already reaches nobody but the DM, and a
 * switch that took it away as well would be two features on one checkbox.
 */
function drawTokenChrome(ctx: CanvasRenderingContext2D, frame: Frame, board: Board): void {
  const { scene, cam } = frame;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';

  for (const token of scene.tokens) {
    // Same question, same answer, same skip: a token with no name drawn under
    // it is better than one whose name floats over a board it is not on.
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
 * This never runs on a player's screen, and not because of a check here — `hp`
 * is redacted server-side, so their copy of the token carries null and there is
 * nothing to decline to draw. That is invariant 4's whole shape.
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
  const filled = hp.max > 0 ? clamp(hp.current / hp.max, 0, 1) : 0;

  ctx.fillStyle = HP_TRACK;
  ctx.fillRect(left, y, width, HP_BAR_H);
  if (filled > 0) {
    ctx.fillStyle = filled > 0.5 ? HP_HEALTHY : filled > 0.25 ? HP_HURT : HP_LOW;
    ctx.fillRect(left, y, width * filled, HP_BAR_H);
  }
  // Half-pixel inset so a 1px stroke lands on pixels rather than straddling two.
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

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

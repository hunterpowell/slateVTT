import type { Box } from './calibrate.js';
import type { Camera, Rect } from './coords.js';
import { firstLineAt, gridToWorld, playRect, worldToScreen } from './coords.js';
import type { Identity } from './identity.js';
import { ownsToken } from './identity.js';
import type { Scene } from './scene.js';

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
  /** The token the DM has selected for editing. Null for everyone else. */
  selectedId: string | null;
  /** Token acting this turn, or null when combat is not running. */
  currentTurn: string | null;
  /** The DM's in-progress grid reference box. Null for everyone else. */
  calibration: { box: Box; cells: number } | null;
}

export function render(ctx: CanvasRenderingContext2D, view: Viewport, frame: Frame): void {
  const { cam, map } = frame;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = VOID;
  ctx.fillRect(0, 0, view.width * view.dpr, view.height * view.dpr);

  // The single place device pixel ratio enters the coordinate chain. Everything
  // below draws in world units and is unaware of it.
  const s = cam.zoom * view.dpr;
  ctx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s);

  ctx.drawImage(map, 0, 0);

  const area = playRect(frame.scene.playArea, map.width, map.height);
  // Before the grid and the tokens: the board should read as lit, and a token
  // staged off the board should stay perfectly legible.
  if (frame.scene.playArea !== null) drawOutsidePlayArea(ctx, area, map.width, map.height);
  drawGrid(ctx, frame, area);
  drawTokens(ctx, frame);
  if (frame.calibration !== null) drawCalibration(ctx, cam, frame.calibration);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.scale(view.dpr, view.dpr);
  drawLabels(ctx, frame);
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
function drawGrid(ctx: CanvasRenderingContext2D, frame: Frame, area: Rect): void {
  const { grid } = frame.scene;
  const halo = haloFor(frame.scene.gridColor);
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
  ctx.strokeStyle = frame.scene.gridColor;
  ctx.lineWidth = GRID_CORE_WIDTH / frame.cam.zoom;
  ctx.stroke();
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

function drawTokens(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { scene, tokenImages, draggingId, cam, identity, currentTurn, selectedId } = frame;

  for (const token of scene.tokens) {
    // Per token, not per map: a token is `size` cells across, so a 2×2 fills
    // the four cells its centre sits at the corner of.
    const radius = (scene.grid.px * token.size) / 2;
    const centre = gridToWorld(scene.grid, token.x, token.y);
    const img = tokenImages.get(token.img);

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

    // One ring, three meanings: being dragged, yours, or neither.
    const dragging = token.id === draggingId;
    const mine = ownsToken(identity, token);

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, TAU);
    ctx.lineWidth = (dragging || mine ? 2.5 : 1.5) / cam.zoom;
    ctx.strokeStyle = dragging ? DRAG_RING : mine ? OWNED_RING : TOKEN_RIM;
    ctx.stroke();

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
      ctx.save();
      ctx.beginPath();
      ctx.arc(centre.x, centre.y, radius + 10 / cam.zoom, 0, TAU);
      ctx.lineWidth = 1.5 / cam.zoom;
      ctx.strokeStyle = SELECTED_RING;
      ctx.setLineDash([5 / cam.zoom, 4 / cam.zoom]);
      ctx.stroke();
      ctx.restore();
    }
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
 * Labels are drawn in screen space so they keep a fixed size as the camera
 * zooms — the one thing on the map that should not scale with the world.
 */
function drawLabels(ctx: CanvasRenderingContext2D, frame: Frame): void {
  const { scene, cam } = frame;

  ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = LABEL_HALO;
  ctx.fillStyle = LABEL_TEXT;

  for (const token of scene.tokens) {
    const centre = gridToWorld(scene.grid, token.x, token.y);
    // Under the token's own edge, so a name does not land inside a big one.
    const p = worldToScreen(cam, centre.x, centre.y + (scene.grid.px * token.size) / 2);
    ctx.strokeText(token.name, p.x, p.y + 4);
    ctx.fillText(token.name, p.x, p.y + 4);
  }
}

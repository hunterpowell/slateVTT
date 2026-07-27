// The DM's map panel: upload an image, calibrate the grid to it, and set how
// the overlay is drawn.
//
// Calibration is a two-step: dragging a box only *proposes* a grid, which is
// previewed locally so the count can be corrected against it, and nothing
// reaches the table or the save file until the DM applies. That local preview
// is ordinary client-side prediction — the same thing a token drag does — so it
// works by writing straight to `scene.grid` and keeping the confirmed value to
// roll back to. Everything that reads the grid, including the cell readout in
// the HUD, then agrees with what is on screen.
//
// Players never see this. It is only created for a DM connection, and the
// server re-checks every set_map regardless.

import type { Box, Calibration } from './calibrate.js';
import { gridFromBox, MAX_CELLS, MIN_GRID_PX, playAreaFromBox } from './calibrate.js';
import type { GridSpec, Rect } from './coords.js';
import type { ClientMsg } from './protocol.js';
import type { Scene } from './scene.js';

export interface MapToolUi {
  root: HTMLElement;
  file: HTMLInputElement;
  uploadText: HTMLElement;
  calibrate: HTMLButtonElement;
  cellsRow: HTMLElement;
  cells: HTMLInputElement;
  cellsDown: HTMLButtonElement;
  cellsUp: HTMLButtonElement;
  wholeMap: HTMLButtonElement;
  hint: HTMLElement;
  applyRow: HTMLElement;
  apply: HTMLButtonElement;
  cancel: HTMLButtonElement;
  color: HTMLInputElement;
  alpha: HTMLInputElement;
  alphaLabel: HTMLElement;
  readout: HTMLElement;
}

export interface MapTool extends Calibration {
  /** Called once on Welcome, then on every map_changed. */
  update(scene: Scene): void;
  /** Offers the whole image as the reference box. See below. */
  proposeWholeMap(): void;
}

const DEFAULT_ALPHA_PCT = 32;
const DRAG_HINT = 'Drag a box across that many whole squares.';
/** Where the count starts for a box drawn by hand, as opposed to the image. */
const HAND_DRAWN_CELLS = 4;

export function createMapTool(
  ui: MapToolUi,
  dmSecret: string,
  send: (msg: ClientMsg) => void,
  report: (message: string) => void,
  /** Pixel size of the map image on screen, or null before one has loaded. */
  mapSize: () => { width: number; height: number } | null,
): MapTool {
  // The live scene object, so reading through it always gives the map as it
  // stands. Assigned before the panel is ever shown.
  let scene: Scene | null = null;
  /** What the server last confirmed. Where a cancelled preview goes back to. */
  let confirmed: { grid: GridSpec; area: Rect | null } | null = null;

  let active = false;
  /** Mid-drag. */
  let dragBox: Box | null = null;
  /** Released and being tuned. Non-null means a preview is on screen. */
  let pending: Box | null = null;
  /** The pending box is the whole image, so the play area should be too. */
  let pendingWholeImage = false;
  /**
   * The count in the box was worked out for the whole image rather than chosen
   * for a hand-drawn one, so the next hand-drawn box must not inherit it.
   */
  let countFromWholeImage = false;

  // --- the grid colour ------------------------------------------------------

  const composeColor = (): string => {
    const byte = Math.round((Number(ui.alpha.value) / 100) * 255);
    const hex = Math.min(255, Math.max(0, byte)).toString(16).padStart(2, '0');
    return `${ui.color.value}${hex}`;
  };

  const showColor = (color: string): void => {
    const alpha = parseInt(color.slice(7, 9), 16);
    const pct = Number.isFinite(alpha) ? Math.round((alpha / 255) * 100) : DEFAULT_ALPHA_PCT;
    ui.color.value = color.slice(0, 7);
    ui.alpha.value = String(pct);
    ui.alphaLabel.textContent = `${pct}%`;
  };

  // Dragging the slider repaints locally on every step; only letting go sends.
  // Same split as a token drag, and for the same reason — the table does not
  // need to watch someone hunt for a shade.
  const previewColor = (): void => {
    if (scene === null) return;
    scene.gridColor = composeColor();
    ui.alphaLabel.textContent = `${ui.alpha.value}%`;
  };

  const sendColor = (): void => {
    // Deliberately the *confirmed* state, not what is on screen: an unapplied
    // calibration preview must not be committed by a fiddle with the colour.
    if (scene !== null && confirmed !== null) {
      sendMap(confirmed.grid, composeColor(), confirmed.area);
    }
  };

  for (const input of [ui.color, ui.alpha]) {
    input.addEventListener('input', previewColor);
    input.addEventListener('change', sendColor);
  }

  // --- calibration ----------------------------------------------------------

  const cellsAcross = (): number => {
    const n = Math.floor(Number(ui.cells.value));
    if (!Number.isFinite(n)) return 1;
    return Math.min(Math.max(n, 1), MAX_CELLS);
  };

  /**
   * `url` is explicit for the upload case only. The map URL is deliberately not
   * predicted locally the way the grid is — main.ts reloads the image by
   * noticing that the incoming URL differs from the one on the scene, and a
   * prediction here would hide the change from it.
   */
  const sendMap = (grid: GridSpec, color: string, area: Rect | null, url?: string): void => {
    if (scene === null) return;
    send({
      type: 'set_map',
      url: url ?? scene.mapUrl,
      grid_px: grid.px,
      offset_x: grid.offsetX,
      offset_y: grid.offsetY,
      grid_color: color,
      play_area: area,
    });
  };

  /** Recomputes the previewed grid and play area from the box and the count. */
  const repreview = (): void => {
    if (scene === null || pending === null) return;

    const grid = gridFromBox(pending, cellsAcross());
    if (grid === null) {
      report(`that box is too small — each square must come out at ${MIN_GRID_PX} px or more`);
      return;
    }
    scene.grid = grid;
    // The whole image is stored as null rather than its own measurements, so it
    // stays true if the same URL is ever served a different-sized image.
    scene.playArea = pendingWholeImage ? null : playAreaFromBox(pending, grid);
    showReadout();
  };

  const setActive = (on: boolean): void => {
    active = on;
    dragBox = null;
    ui.calibrate.textContent = on ? 'stop calibrating' : 'calibrate grid';
    ui.calibrate.classList.toggle('is-active', on);
    ui.cellsRow.hidden = !on;
    if (!on) {
      pending = null;
      ui.applyRow.hidden = true;
      ui.hint.textContent = DRAG_HINT;
    }
    showReadout();
  };

  /**
   * Offers the whole image as the reference box, which reduces calibration to a
   * single question: how many squares across is this map?
   *
   * An image's dimensions cannot say how big a square is — 4000 px is twenty
   * 200 px squares or eighty 50 px ones, and only the DM knows which. But the
   * count and the width together do, and "the whole image" is just a box like
   * any other, so the preview and apply flow carries it unchanged. Right for
   * the many maps that are exported edge-to-edge along grid lines.
   */
  function proposeWholeMap(): void {
    const size = mapSize();
    if (scene === null || confirmed === null || size === null) return;

    // The map is drawn from the world origin, so the image *is* this box.
    const box: Box = { x0: 0, y0: 0, x1: size.width, y1: size.height };

    // Opening on the count the current cell size implies, rather than some
    // fixed number, puts the first preview in the right region for a map that
    // came from the same source as the last one.
    const ceiling = Math.max(1, Math.min(MAX_CELLS, Math.floor(size.width / MIN_GRID_PX)));
    const guess = Math.round(size.width / confirmed.grid.px);
    ui.cells.value = String(Math.min(Math.max(guess, 1), ceiling));
    countFromWholeImage = true;

    setActive(true);
    pending = box;
    pendingWholeImage = true;
    ui.applyRow.hidden = false;
    repreview();
    ui.hint.textContent = 'How many squares across is this map?';
    ui.cells.focus();
    ui.cells.select();
  }

  ui.wholeMap.addEventListener('click', proposeWholeMap);

  /** Leaves calibrate mode and puts the board back the way the server has it. */
  const discard = (): void => {
    if (scene !== null && confirmed !== null && pending !== null) {
      scene.grid = confirmed.grid;
      scene.playArea = confirmed.area;
    }
    setActive(false);
  };

  ui.calibrate.addEventListener('click', () => (active ? discard() : setActive(true)));
  ui.cancel.addEventListener('click', discard);

  ui.apply.addEventListener('click', () => {
    if (scene === null || pending === null) return;
    // The scene holds the preview, which is exactly what is on screen.
    sendMap(scene.grid, scene.gridColor, scene.playArea);
    pending = null;
    setActive(false);
  });

  const step = (by: number): void => {
    ui.cells.value = String(Math.min(Math.max(cellsAcross() + by, 1), MAX_CELLS));
    countFromWholeImage = false;
    repreview();
  };
  ui.cellsDown.addEventListener('click', () => step(-1));
  ui.cellsUp.addEventListener('click', () => step(1));
  ui.cells.addEventListener('input', () => {
    countFromWholeImage = false; // the DM has taken charge of the number
    repreview();
  });

  // Without this, leaving the mode means finding the button again — and while it
  // is on, dragging does not move tokens, which reads as a broken board.
  window.addEventListener('keydown', (e) => {
    if (!active) return;
    if (e.key === 'Escape') discard();
    // Enter applies, so the count can be typed and committed without reaching
    // for the mouse.
    if (e.key === 'Enter' && pending !== null) ui.apply.click();
  });

  // --- upload ---------------------------------------------------------------

  ui.file.addEventListener('change', () => {
    const file = ui.file.files?.[0];
    // Cleared so that picking the same file twice still fires a change event.
    ui.file.value = '';
    if (file !== undefined) void upload(file);
  });

  async function upload(file: File): Promise<void> {
    if (scene === null || confirmed === null) return;

    ui.root.classList.add('is-busy');
    ui.uploadText.textContent = 'uploading…';
    try {
      const response = await fetch('/api/map', {
        method: 'POST',
        headers: { 'x-slate-dm-secret': dmSecret },
        body: file,
      });

      // The endpoint answers with plain text on failure and JSON on success, so
      // read the body once and decide afterwards.
      const body = await response.text();
      if (!response.ok) throw new Error(body || `upload failed (${response.status})`);
      const { url } = JSON.parse(body) as { url: string };

      discard(); // a half-tuned grid means nothing on an image being replaced
      // The cell size carries over — a DM's maps tend to come out of one tool at
      // one resolution — but the offsets cannot: they describe where the grid
      // began on an image this one has just replaced. Nor can the play area, so
      // a new map is playable end to end until the DM says otherwise.
      sendMap({ px: confirmed.grid.px, offsetX: 0, offsetY: 0 }, scene.gridColor, null, url);
    } catch (err) {
      report(err instanceof Error ? err.message : 'could not upload that map');
    } finally {
      ui.root.classList.remove('is-busy');
      ui.uploadText.textContent = 'upload image…';
    }
  }

  // --- readout --------------------------------------------------------------

  function showReadout(): void {
    if (scene === null) return;
    const { px, offsetX, offsetY } = scene.grid;
    const prefix = pending === null ? '' : 'preview · ';
    ui.readout.textContent = `${prefix}${round(px)} px/cell · offset ${round(offsetX)}, ${round(offsetY)}`;
    ui.readout.classList.toggle('is-preview', pending !== null);
  }

  return {
    get active() {
      return active;
    },
    get box() {
      return dragBox ?? pending;
    },
    get cells() {
      return cellsAcross();
    },

    drag(box) {
      dragBox = box;
    },

    release(box) {
      dragBox = null;

      // A count worked out for the whole image — often dozens — says nothing
      // about a box drawn by hand over a handful of squares. Inheriting it
      // divides a small selection into slivers.
      if (countFromWholeImage) {
        ui.cells.value = String(HAND_DRAWN_CELLS);
        countFromWholeImage = false;
      }

      if (gridFromBox(box, cellsAcross()) === null) {
        report(`that box is too small — each square must come out at ${MIN_GRID_PX} px or more`);
        return;
      }

      // Kept rather than committed: the count is usually the thing that is
      // wrong, and it is far easier to judge against a box already drawn.
      pending = box;
      pendingWholeImage = false;
      ui.applyRow.hidden = false;
      ui.hint.textContent = 'Correct the count until the lines match, then apply.';
      repreview();
    },

    proposeWholeMap,

    update(next) {
      scene = next;
      confirmed = { grid: { ...next.grid }, area: next.playArea };
      // Whatever the server just said supersedes anything being tried out here.
      pending = null;
      ui.applyRow.hidden = true;
      showColor(next.gridColor);
      showReadout();
    },
  };
}

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

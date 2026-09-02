// The DM's map panel: upload an image, calibrate the grid to it, and set how
// the overlay is drawn.
//
// The panel has two modes, and the toggle at the top of it decides which map
// everything below is about: the board the table is looking at, or the one being
// prepared for later. Nothing else in the panel changes between them — an upload
// is an upload and a calibration is a calibration either way — which is why it is
// one toggle rather than a second copy of the whole panel.
//
// Switching to "next map" while something is staged is also preview mode: the
// board on screen becomes the staged image so it can be calibrated, because
// calibrating a map means looking at it. The table sees none of this.
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

import type { Box, Calibration, CalShape } from './calibrate.js';
import {
  gridFromBox,
  gridFromEdge,
  MAX_CELLS,
  MAX_GRID_RATIO,
  MIN_GRID_PX,
  MIN_GRID_RATIO,
  playAreaFromBox,
  STANDARD_RATIO,
} from './calibrate.js';
import type { GridSpec, Rect } from './coords.js';
import { squareGrid } from './coords.js';
import { createLibraryList } from './library.js';
import type { ClientMsg, Lighting } from './protocol.js';
import type { Board, Scene } from './scene.js';
import { shapeOf } from './scene.js';

export interface MapToolUi {
  root: HTMLElement;
  head: HTMLElement;
  live: HTMLButtonElement;
  next: HTMLButtonElement;
  stagedRow: HTMLElement;
  stagedNote: HTMLElement;
  promote: HTMLButtonElement;
  discard: HTMLButtonElement;
  file: HTMLInputElement;
  uploadText: HTMLElement;
  library: HTMLButtonElement;
  libraryList: HTMLElement;
  calibrate: HTMLButtonElement;
  cellsRow: HTMLElement;
  shape: HTMLSelectElement;
  /** How many cells the drag crossed, which both gestures ask. */
  cells: HTMLInputElement;
  cellsDown: HTMLButtonElement;
  cellsUp: HTMLButtonElement;
  /** The square path's alone: it proposes the image's own bounds as the
   *  reference box, and an edge gesture has no region in it to propose. */
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
  /** Called once on Welcome, then on every map_changed and staged_changed. */
  update(scene: Scene): void;
  /** Offers the whole image as the reference box. See below. */
  proposeWholeMap(): void;
  /**
   * Puts the panel down, called by the rail as it closes this tab.
   *
   * Calibrating takes the left mouse button, so leaving it armed under a hidden
   * panel would leave a drag on the canvas drawing a reference box with nothing
   * on screen saying why. The library list closes with it so the tab reopens on
   * the panel rather than mid-browse.
   *
   * Preview mode deliberately survives: staging a map and then dragging tokens
   * into position on it is one job done in two places, and `#preview-tag` says
   * which board is on screen without this panel being open.
   */
  stop(): void;
  /**
   * The fog panel's three fields, sent as part of a whole `set_map`.
   *
   * It goes through here rather than the fog panel building its own frame,
   * because this is where the *confirmed* calibration lives — the same reason
   * the grid colour is sent from `sendColor` rather than read off the board. A
   * fiddle with the fog must not commit an unapplied grid preview.
   *
   * Whichever slot the panel is on, which is whichever board is on screen. A
   * staged map carries `fog`, `vision_ft` and `lighting` like any other — they
   * have ridden on `MapInfo` since fog shipped — so the next dungeon's lights
   * are set before the table is ever shown it.
   */
  setFog(on: boolean, visionFt: number, lighting: Lighting): void;
}

const DEFAULT_ALPHA_PCT = 32;
/** Only reached before any board has loaded; the server has the same number. */
const DEFAULT_VISION_FT = 60;
const DRAG_HINT = 'Drag a box across that many whole squares.';
/** The isometric gesture, which is a run of cell edges rather than a box. */
const EDGE_HINT = 'Drag along that many diamond edges, corner to corner.';
/** The same gesture with the proportions already decided, so the hint says which
 *  half of it still matters. */
const FIXED_HINT = `Drag along that many diamond edges — they stay ${STANDARD_RATIO}:1.`;
/** Where the count starts for a box drawn by hand, as opposed to the image. */
const HAND_DRAWN_CELLS = 4;
/** Where it starts for an edge, which is the gesture as it was before the count
 *  reached it: one drag, one diamond. Tracing a whole room and dividing it is
 *  the thing being made *possible*, and aiming one tile is still the thing the
 *  hint asks for, so a DM who wants that must not have to correct a 4 first. */
const HAND_DRAWN_EDGES = 1;

/** The select's value, which is a DOM string like any other. */
function readShape(value: string): CalShape {
  return value === 'iso' || value === 'iso-fixed' ? value : 'square';
}

/**
 * Which entry a board already on screen opens on, so re-opening the panel on an
 * isometric map opens on isometric rather than offering to square it — and on a
 * 2:1 one opens on the fixed entry rather than on the gesture that entry exists
 * to spare the DM.
 *
 * A tolerance rather than an equality. The ratio has been through an `f32` on
 * the wire and back, and a board a hair off 2:1 is one somebody meant to be
 * 2:1; anything further out was aimed by hand and stays free.
 */
function shapeFor(grid: GridSpec): CalShape {
  const of = shapeOf(grid);
  if (of.kind !== 'iso') return 'square';
  return Math.abs(of.ratio - STANDARD_RATIO) < 1e-3 ? 'iso-fixed' : 'iso';
}

export function createMapTool(
  ui: MapToolUi,
  dmSecret: string,
  send: (msg: ClientMsg) => void,
  report: (message: string) => void,
  /** Pixel size of the map image on screen, or null before one has loaded. */
  mapSize: () => { width: number; height: number } | null,
  /** Told when the board on screen becomes, or stops being, the staged map. */
  onPreview: (previewing: boolean) => void,
): MapTool {
  // The live scene object, so reading through it always gives the map as it
  // stands. Assigned before the panel is ever shown.
  let scene: Scene | null = null;
  /** What the server last confirmed. Where a cancelled preview goes back to. */
  let confirmed: { grid: GridSpec; area: Rect | null } | null = null;

  /** Which slot everything in this panel is about. */
  let mode: 'live' | 'staged' = 'live';

  /**
   * The board being edited: the staged one in "next map" mode, and null there
   * until a map has actually been staged. Everything below reads through this
   * rather than through `scene.live`, which is what stops a staged preview from
   * ever being written into the map the table is looking at.
   */
  const target = (): Board | null =>
    scene === null ? null : mode === 'staged' ? scene.staged : scene.live;

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

  /**
   * Which lattice the DM is calibrating. Read off the board by `refresh`, so
   * re-opening the panel on an isometric map opens on isometric.
   *
   * The gesture is the same drag either way — `input.ts` hands over a box and
   * this decides whether to read it as a rectangle of squares or as one
   * diamond's edge — which is why nothing on the canvas side knows about this.
   * The two isometric entries are one gesture twice over: they differ only in
   * whether the drag decides the diamond's proportions or only its size.
   */
  let shape: CalShape = 'square';

  /** The grid a released box describes, under whichever shape is selected. */
  const gridFromDrag = (box: Box): GridSpec | null =>
    shape === 'square'
      ? gridFromBox(box, cellsAcross())
      : gridFromEdge(box, shape, cellsAcross());

  /** Why a drag was refused, which differs by shape because the gesture does —
   *  and a fixed diamond cannot be lopsided, so it is not offered that reason. */
  const dragRefusal = (): string => {
    if (shape === 'square') {
      return `that box is too small — each square must come out at ${MIN_GRID_PX} px or more`;
    }
    if (shape === 'iso-fixed') {
      return `that drag is too small — a cell must come out at least ${MIN_GRID_PX} px tall`;
    }
    return `that drag is too small or too lopsided — a cell must be at least ${MIN_GRID_PX} px tall, and between ${MIN_GRID_RATIO} and ${MAX_GRID_RATIO} times as wide as it is tall`;
  };

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
    const board = target();
    if (board === null) return;
    board.gridColor = composeColor();
    ui.alphaLabel.textContent = `${ui.alpha.value}%`;
  };

  const sendColor = (): void => {
    // Deliberately the *confirmed* state, not what is on screen: an unapplied
    // calibration preview must not be committed by a fiddle with the colour.
    if (confirmed !== null) sendMap(confirmed.grid, composeColor(), confirmed.area);
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
   *
   * `staged` says which slot, and is simply which mode the panel is in. An empty
   * staged slot has no URL of its own, so only an explicit one can fill it.
   */
  const sendMap = (
    grid: GridSpec,
    color: string,
    area: Rect | null,
    url?: string,
    /** The fog panel's three fields. Carried through unchanged otherwise, so
     *  calibrating a map never quietly turns its lights on or off. */
    fog?: { on: boolean; visionFt: number; lighting: Lighting },
  ): void => {
    const board = target();
    const to = url ?? board?.mapUrl;
    if (to === undefined) return;
    send({
      type: 'set_map',
      url: to,
      grid_px: grid.px,
      offset_x: grid.offsetX,
      offset_y: grid.offsetY,
      grid_color: color,
      // Derived from the basis rather than read off the panel, so an unapplied
      // shape change cannot be committed by a fiddle with the colour — which is
      // the reason `sendColor` sends the *confirmed* grid in the first place.
      grid_shape: shapeOf(grid),
      play_area: area,
      fog: fog?.on ?? board?.fog ?? false,
      vision_ft: fog?.visionFt ?? board?.visionFt ?? DEFAULT_VISION_FT,
      lighting: fog?.lighting ?? board?.lighting ?? 'dynamic',
      staged: mode === 'staged',
    });
  };

  /** Recomputes the previewed grid and play area from the box and the count. */
  const repreview = (): void => {
    const board = target();
    if (board === null || pending === null) return;

    const grid = gridFromDrag(pending);
    if (grid === null) {
      report(dragRefusal());
      return;
    }
    board.grid = grid;
    // **An isometric drag has no play area in it.** The square gesture drags a
    // box *across* part of the board, so the box is a region and reading a play
    // area off it is right. The isometric gesture is two points along one cell
    // edge — a direction and a length, nothing more — so deriving a region from
    // it collapses the board to a sliver the size of one diamond, which is what
    // it did until it was noticed on a real map. The playable region is simply
    // not what choosing a cell shape is about, so it is left as it was found.
    //
    // The whole image is stored as null rather than its own measurements, so it
    // stays true if the same URL is ever served a different-sized image.
    if (shape === 'square') {
      board.playArea = pendingWholeImage ? null : playAreaFromBox(pending, grid);
    }
    showReadout();
  };

  /**
   * The half of the calibration panel that belongs to the square path.
   *
   * **Only the whole-image shortcut is that half now.** It proposes a *region*
   * — the image's own bounds as the reference box — and an edge gesture has no
   * region in it, so it goes rather than sitting there inert: the rail's rule
   * about a tab that can do nothing, one level down. The count stayed, because
   * "how many cells did that drag cross" is a question both gestures ask.
   */
  const showShape = (): void => {
    ui.shape.value = shape;
    ui.wholeMap.hidden = shape !== 'square';
    if (pending === null) {
      ui.hint.textContent =
        shape === 'square' ? DRAG_HINT : shape === 'iso-fixed' ? FIXED_HINT : EDGE_HINT;
    }
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
    }
    showShape();
    showReadout();
  };

  // Changing the shape abandons whatever was being tuned: a box read as four
  // squares and the same box read as one diamond's edge are different claims
  // about the map, and carrying the drag across would silently make the second
  // one for the DM. That holds between the two isometric entries as well —
  // "these are the proportions" and "the proportions are 2:1" are two claims,
  // not one drag under two readings.
  ui.shape.addEventListener('change', () => {
    const next = readShape(ui.shape.value);
    if (next === shape) return;
    shape = next;
    pending = null;
    pendingWholeImage = false;
    ui.applyRow.hidden = true;
    // The count means the same *kind* of thing under both gestures and not the
    // same number: a hand-drawn box is a few squares across, while an edge is
    // one diamond unless the DM says otherwise. Carrying 26 across from a
    // whole-image square calibration would divide the next traced edge into
    // slivers, which is the mistake `release` already refuses to make with a
    // hand-drawn box.
    ui.cells.value = String(shape === 'square' ? HAND_DRAWN_CELLS : HAND_DRAWN_EDGES);
    countFromWholeImage = false;
    // Back to what the server confirmed, which is what a cancelled preview
    // already does — the shape switch is one.
    const board = target();
    if (board !== null && confirmed !== null) {
      board.grid = confirmed.grid;
      board.playArea = confirmed.area;
    }
    showShape();
    showReadout();
  });

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
    if (target() === null || confirmed === null || size === null) return;
    // The same rule that hides the button under an isometric shape, applied to
    // the one caller that is not the button: `main.ts` offers this on a freshly
    // loaded image, and a remembered isometric calibration is a map where that
    // offer means nothing. It always meant nothing there; before the count
    // reached the edge gesture it merely meant nothing quietly.
    if (shape !== 'square') return;

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
    const board = target();
    if (board !== null && confirmed !== null && pending !== null) {
      board.grid = confirmed.grid;
      board.playArea = confirmed.area;
    }
    setActive(false);
  };

  ui.calibrate.addEventListener('click', () => (active ? discard() : setActive(true)));
  ui.cancel.addEventListener('click', discard);

  ui.apply.addEventListener('click', () => {
    const board = target();
    if (board === null || pending === null) return;
    // The board holds the preview, which is exactly what is on screen.
    sendMap(board.grid, board.gridColor, board.playArea);
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

  // --- the two slots --------------------------------------------------------

  /** Panel chrome that depends on which slot is being edited. */
  const showMode = (): void => {
    const staging = mode === 'staged';
    const board = target();

    ui.head.textContent = staging ? 'Next map' : 'Map';
    ui.live.classList.toggle('is-active', !staging);
    ui.next.classList.toggle('is-active', staging);
    ui.stagedRow.hidden = !staging;
    ui.stagedNote.textContent =
      board === null
        ? 'Upload or choose a map to prepare it out of sight of the table.'
        : 'Only you can see this. Promote it to put it on the table.';
    ui.promote.disabled = board === null;
    ui.discard.disabled = board === null;
    // There is nothing to calibrate until a map has been staged.
    ui.calibrate.disabled = board === null;
  };

  /** Re-reads everything the panel shows from the board it is now editing. */
  const refresh = (): void => {
    const board = target();
    confirmed = board === null ? null : { grid: { ...board.grid }, area: board.playArea };
    // The board's own shape, so re-opening the panel on a map opens on the way
    // it was calibrated rather than offering to change it.
    if (board !== null) shape = shapeFor(board.grid);
    // Whatever the server just said, or whichever slot is now selected,
    // supersedes anything being tried out here.
    pending = null;
    ui.applyRow.hidden = true;
    if (board !== null) showColor(board.gridColor);
    showShape();
    showReadout();
    showMode();
  };

  const setMode = (next: 'live' | 'staged'): void => {
    if (mode === next || scene === null) return;
    // Before the switch: a half-tuned grid belongs to the map it was drawn on.
    discard();
    mode = next;

    // Switching to a slot that holds a map is what preview mode *is*. There is
    // no separate toggle, because calibrating a map means looking at it.
    const previewing = mode === 'staged' && scene.staged !== null;
    if (previewing !== scene.previewing) {
      scene.previewing = previewing;
      onPreview(previewing);
    }
    refresh();
  };

  ui.live.addEventListener('click', () => setMode('live'));
  ui.next.addEventListener('click', () => setMode('staged'));

  ui.promote.addEventListener('click', () => {
    discard();
    send({ type: 'promote_staged' });
  });

  ui.discard.addEventListener('click', () => {
    discard();
    send({ type: 'clear_staged' });
  });

  // --- putting a new image on the board -------------------------------------

  /**
   * Both ways of getting a map end here, because from this side they are the
   * same thing: some bytes are now served at `url` and the slot this panel is
   * pointed at should show them.
   */
  const showNewMap = (url: string): void => {
    if (scene === null) return;

    discard(); // a half-tuned grid means nothing on an image being replaced
    // Falls back to the live board when the staged slot is still empty: there is
    // nothing staged to carry anything over from, and one DM's maps tend to come
    // out of one tool at one resolution either way.
    const from = target() ?? scene.live;
    // The cell size carries over, but the offsets cannot: they describe where
    // the grid began on an image this one has just replaced. Nor can the play
    // area, so a new map is playable end to end until the DM says otherwise.
    //
    // For a map picked out of the library this is only an opening bid. The
    // server keys what it remembers on the URL, so a map calibrated in an
    // earlier session comes back the way it was left and the frame that lands
    // here overrides all of it.
    sendMap(squareGrid(from.grid.px, 0, 0), from.gridColor, null, url);
  };

  // --- upload ---------------------------------------------------------------

  // --- the library ----------------------------------------------------------

  // `showNewMap` guards on the scene being there, so a pick landing before the
  // first frame does nothing rather than half a load.
  //
  // **The upload button is the library's now.** It used to POST to `/api/map`,
  // which wrote the bytes into `uploads/` under a fresh UUID — a map that could
  // not be found again next session, and whose calibration a second upload of
  // the same file would not match. Handing the input to the widget makes an
  // uploaded map a library map, and there is one code path instead of two.
  const library = createLibraryList(
    {
      root: ui.root,
      button: ui.library,
      list: ui.libraryList,
      file: ui.file,
      fileText: ui.uploadText,
    },
    dmSecret,
    'maps',
    showNewMap,
    report,
  );

  // --- readout --------------------------------------------------------------

  function showReadout(): void {
    const board = target();
    if (board === null) {
      ui.readout.textContent = 'nothing staged';
      ui.readout.classList.remove('is-preview');
      return;
    }
    const { px, offsetX, offsetY } = board.grid;
    const prefix = pending === null ? '' : 'preview · ';
    const of = shapeOf(board.grid);
    // The ratio is the whole of what an isometric readout adds: `px/cell` is the
    // diamond's height either way, and its width is the number beside it.
    const kind = of.kind === 'iso' ? ` · iso ${round(of.ratio)}:1` : '';
    ui.readout.textContent = `${prefix}${round(px)} px/cell${kind} · offset ${round(offsetX)}, ${round(offsetY)}`;
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
    get shape() {
      return shape;
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

      if (gridFromDrag(box) === null) {
        report(dragRefusal());
        return;
      }

      // Kept rather than committed: the count is usually the thing that is
      // wrong, and it is far easier to judge against a box already drawn.
      pending = box;
      pendingWholeImage = false;
      ui.applyRow.hidden = false;
      ui.hint.textContent =
        shape === 'square'
          ? 'Correct the count until the lines match, then apply.'
          : 'Correct the count until the diamonds match, then apply.';
      repreview();
    },

    proposeWholeMap,

    stop() {
      setActive(false);
      library.close();
    },

    setFog(on, visionFt, lighting) {
      // `confirmed` rather than what is on screen: an unapplied grid preview
      // must not be committed by a fiddle with the fog.
      //
      // `target()` rather than `scene.live`, which is what milestone 20 changed
      // here — the fog panel edits the board on screen now, and the map panel's
      // own mode is exactly what decides which board that is. The two cannot
      // disagree because there is only one answer, which is the argument for
      // routing this through here in the first place.
      const board = target();
      if (board === null || confirmed === null) return;
      sendMap(confirmed.grid, board.gridColor, confirmed.area, undefined, {
        on,
        visionFt,
        lighting,
      });
    },

    update(next) {
      scene = next;

      // A slot that has emptied — promoted or discarded — has nothing left to
      // edit, so the panel goes back to the board rather than sitting in a mode
      // with no map in it.
      if (mode === 'staged' && next.staged === null) mode = 'live';

      const previewing = mode === 'staged' && next.staged !== null;
      if (previewing !== next.previewing) {
        next.previewing = previewing;
        onPreview(previewing);
      }
      refresh();
    },
  };
}

function round(n: number): string {
  return (Math.round(n * 10) / 10).toString();
}

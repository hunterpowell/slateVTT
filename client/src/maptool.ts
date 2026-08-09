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

import type { Box, Calibration } from './calibrate.js';
import { gridFromBox, MAX_CELLS, MIN_GRID_PX, playAreaFromBox } from './calibrate.js';
import type { GridSpec, Rect } from './coords.js';
import type { ClientMsg } from './protocol.js';
import type { Board, Scene } from './scene.js';

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
   * The fog panel's two fields, sent as part of a whole `set_map`.
   *
   * It goes through here rather than the fog panel building its own frame,
   * because this is where the *confirmed* calibration lives — the same reason
   * the grid colour is sent from `sendColor` rather than read off the board. A
   * fiddle with the fog must not commit an unapplied grid preview.
   *
   * The live slot only. There is no fog on a staged map, so the panel that calls
   * this is inert while previewing.
   */
  setFog(on: boolean, visionFt: number): void;
}

const DEFAULT_ALPHA_PCT = 32;
/** Only reached before any board has loaded; the server has the same number. */
const DEFAULT_VISION_FT = 60;
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
    /** The fog panel's two fields. Carried through unchanged otherwise, so
     *  calibrating a map never quietly turns its lights on or off. */
    fog?: { on: boolean; visionFt: number },
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
      play_area: area,
      fog: fog?.on ?? board?.fog ?? false,
      vision_ft: fog?.visionFt ?? board?.visionFt ?? DEFAULT_VISION_FT,
      staged: mode === 'staged',
    });
  };

  /** Recomputes the previewed grid and play area from the box and the count. */
  const repreview = (): void => {
    const board = target();
    if (board === null || pending === null) return;

    const grid = gridFromBox(pending, cellsAcross());
    if (grid === null) {
      report(`that box is too small — each square must come out at ${MIN_GRID_PX} px or more`);
      return;
    }
    board.grid = grid;
    // The whole image is stored as null rather than its own measurements, so it
    // stays true if the same URL is ever served a different-sized image.
    board.playArea = pendingWholeImage ? null : playAreaFromBox(pending, grid);
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
    if (target() === null || confirmed === null || size === null) return;

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
    // Whatever the server just said, or whichever slot is now selected,
    // supersedes anything being tried out here.
    pending = null;
    ui.applyRow.hidden = true;
    if (board !== null) showColor(board.gridColor);
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
    sendMap({ px: from.grid.px, offsetX: 0, offsetY: 0 }, from.gridColor, null, url);
  };

  /** Both endpoints answer with plain text on failure and JSON on success. */
  const mapUrlFrom = async (response: Response, whenItFails: string): Promise<string> => {
    const body = await response.text();
    if (!response.ok) throw new Error(body || `${whenItFails} (${response.status})`);
    return (JSON.parse(body) as { url: string }).url;
  };

  // --- upload ---------------------------------------------------------------

  ui.file.addEventListener('change', () => {
    const file = ui.file.files?.[0];
    // Cleared so that picking the same file twice still fires a change event.
    ui.file.value = '';
    if (file !== undefined) void upload(file);
  });

  async function upload(file: File): Promise<void> {
    if (scene === null) return;

    ui.root.classList.add('is-busy');
    ui.uploadText.textContent = 'uploading…';
    try {
      const response = await fetch('/api/map', {
        method: 'POST',
        headers: { 'x-slate-dm-secret': dmSecret },
        body: file,
      });
      showNewMap(await mapUrlFrom(response, 'upload failed'));
    } catch (err) {
      report(err instanceof Error ? err.message : 'could not upload that map');
    } finally {
      ui.root.classList.remove('is-busy');
      ui.uploadText.textContent = 'upload image…';
    }
  }

  // --- the library ----------------------------------------------------------

  let libraryOpen = false;

  const closeLibrary = (): void => {
    libraryOpen = false;
    ui.libraryList.hidden = true;
    ui.library.classList.remove('is-active');
  };

  const note = (text: string): void => {
    const line = document.createElement('p');
    line.className = 'map-library-note';
    line.textContent = text;
    ui.libraryList.replaceChildren(line);
  };

  const entry = (path: string): HTMLButtonElement => {
    const button = document.createElement('button');
    button.type = 'button';
    // The list is one line per map and the panel is narrow, so the full path
    // has to be reachable somewhere.
    button.title = path;

    const cut = path.lastIndexOf('/');
    if (cut !== -1) {
      const folder = document.createElement('span');
      folder.className = 'map-library-dir';
      folder.textContent = path.slice(0, cut + 1);
      button.append(folder);
    }
    button.append(path.slice(cut + 1));

    button.addEventListener('click', () => void pick(path));
    return button;
  };

  ui.library.addEventListener('click', () => {
    if (libraryOpen) {
      closeLibrary();
      return;
    }
    libraryOpen = true;
    ui.library.classList.add('is-active');
    ui.libraryList.hidden = false;
    // Re-read every time rather than caching: a DM who drops a file into the
    // folder mid-session should find it by reopening the list.
    void showLibrary();
  });

  async function showLibrary(): Promise<void> {
    note('reading the library…');
    try {
      const response = await fetch('/api/maps', {
        headers: { 'x-slate-dm-secret': dmSecret },
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(body || `could not read the library (${response.status})`);
      }

      const { maps } = JSON.parse(body) as { maps: string[] };
      if (maps.length === 0) {
        note('no maps in the library');
        return;
      }
      ui.libraryList.replaceChildren(...maps.map(entry));
    } catch (err) {
      note(err instanceof Error ? err.message : 'could not read the library');
    }
  }

  async function pick(path: string): Promise<void> {
    if (scene === null) return;

    ui.root.classList.add('is-busy');
    try {
      const response = await fetch('/api/maps/pick', {
        method: 'POST',
        headers: { 'x-slate-dm-secret': dmSecret, 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const url = await mapUrlFrom(response, 'could not pick that map');
      closeLibrary();
      showNewMap(url);
    } catch (err) {
      report(err instanceof Error ? err.message : 'could not pick that map');
    } finally {
      ui.root.classList.remove('is-busy');
    }
  }

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

    stop() {
      setActive(false);
      closeLibrary();
    },

    setFog(on, visionFt) {
      // `confirmed` rather than what is on screen, and `scene.live` rather than
      // `target()`: the fog panel is only usable over the board, so this must
      // not follow the map panel into the staged slot if it happens to be there.
      const board = scene?.live;
      if (board === undefined || mode !== 'live' || confirmed === null) return;
      sendMap(confirmed.grid, board.gridColor, confirmed.area, undefined, { on, visionFt });
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

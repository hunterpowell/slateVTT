/**
 * The DM's fog panel: a switch, a radius, and — since 16b — a brush.
 *
 * The first two are the map's and go out as part of a `set_map` through the map
 * tool, which owns the confirmed calibration. There is no `set_fog`, for the
 * reason there is no `set_hp`: it would be a second way to write one record, and
 * two writers for one record is how they come to disagree.
 *
 * The brush is not the map's. It says something about particular cells, it is
 * sent as its own command, and it is what turned this panel into a tool — which
 * means it is also what gave the panel its first `stop()`. Until 16b this was the
 * one tab on the rail with nothing to put down; a tool holding the left mouse
 * button under a hidden panel is a click doing something with nothing on screen
 * saying why, and that rule now applies here like everywhere else.
 *
 * Four states and two gestures, which is the whole of it:
 *
 * - **ground** hands the terrain over and leaves the creatures standing on it
 *   alone; **lit** hands over both; **dark** takes both away, memory included;
 *   **clear** hands the cells back to line of sight.
 * - **fill** floods from the cell under the pointer, bounded by every segment the
 *   DM traced — doors included, open or shut, which is the one place a door's
 *   state is not read — and previews before it commits. **paint** applies the
 *   state to the cells the pointer is dragged across.
 *
 * The preview is not decoration. One gap in a traced room reveals the whole
 * dungeon in a single click and there is no undo, so the fill is shown before it
 * lands and the DM's own eyes are the check on the geometry.
 *
 * Where a click landed and what was under it is input.ts's, exactly as it is for
 * the wall editor and the draw tool. What lives here is what the brush is loaded
 * with, what a fill would take, and the panel around both.
 *
 * Read `docs/fog.md` before changing what this sends.
 */

import type { Rect, Vec2 } from './coords.js';
import { playRect } from './coords.js';
import { fillFrom } from './overrides.js';
import type { ClientMsg, FogPaint } from './protocol.js';
import type { Board, Scene } from './scene.js';
import { shownBoard, shownWalls, showingStaged } from './scene.js';

/** Matches `MIN_VISION_FT` and `MAX_VISION_FT` on the server, which re-checks. */
const MIN_VISION_FT = 5;
const MAX_VISION_FT = 500;
/** The step the buttons move by: one cell, which is the unit that matters. */
const STEP_FT = 5;

/** Matches `MAX_OVERRIDE_CELLS` on the server, which refuses anything past it.
 *  A fill that reaches this has escaped through a gap, and stopping is how the
 *  DM sees that rather than getting a refusal they have to interpret. */
const MAX_FILL_CELLS = 50_000;

/** What the brush is loaded with. `clear` is the absence of an override rather
 *  than a fourth kind of one, which is why it goes on the wire as null. */
export type FogBrush = FogPaint | 'clear';
/** Flood from a cell, or apply to the cells the pointer crosses. */
export type FogGesture = 'fill' | 'paint';

export interface FogToolUi {
  root: HTMLElement;
  on: HTMLInputElement;
  vision: HTMLInputElement;
  visionDown: HTMLButtonElement;
  visionUp: HTMLButtonElement;
  hint: HTMLElement;
  /** The four state buttons are built here rather than in the document, the way
   *  the wall tool's modes are, so the list lives in one place. */
  brushes: HTMLElement;
  gesture: HTMLButtonElement;
  clear: HTMLButtonElement;
}

export interface FogTool {
  /** What the brush is loaded with, or null when the tool is put away and the
   *  pointer goes back to panning and dragging tokens. */
  readonly brush: FogBrush | null;
  readonly gesture: FogGesture;
  /** The cells a fill would take, as flat pairs — empty in paint mode and
   *  whenever the pointer is off the board. */
  readonly preview: readonly number[];

  /** Where the pointer is, in grid units, or null when it has left the canvas.
   *  Recomputes the fill only when it crosses into a different cell. */
  point(at: Vec2 | null): void;
  /** The gesture the pointer just made: a click in fill mode, or one cell of a
   *  drag in paint mode. */
  apply(at: Vec2): void;
  /** A paint stroke ended — sends what it covered as one command. */
  endStroke(): void;
  /** Called on Welcome, on every map or wall change, and when a preview starts
   *  or ends. */
  update(scene: Scene): void;
  /** Puts the brush down. Escape, closing the tab, and preview mode. */
  stop(): void;
}

const BRUSHES: readonly { brush: FogBrush; label: string; title: string }[] = [
  {
    brush: 'explored',
    label: 'ground',
    title:
      'Hand the party the shape of these squares, dimmed, without whatever is standing on them.',
  },
  {
    brush: 'lit',
    label: 'lit',
    title: 'Hand the party these squares and whatever is standing on them.',
  },
  {
    brush: 'dark',
    label: 'dark',
    title:
      'Black these squares out whatever their torches reach, and take what they remember of them too.',
  },
  {
    brush: 'clear',
    label: 'clear',
    title: 'Hand these squares back to line of sight.',
  },
];

export function createFogTool(
  ui: FogToolUi,
  /** Sends the two map fields as part of a whole `set_map` for the live slot. */
  setFog: (on: boolean, visionFt: number) => void,
  send: (msg: ClientMsg) => void,
  /** The map image's size, for a board with no play area — the same lazy read
   *  the map tool makes, because the image changes under this. */
  mapSize: () => { w: number; h: number } | null,
  /** Called when the brush is picked up, so the other tools let go of the left
   *  button. Two tools armed at once is not a state input.ts could resolve. */
  onArm: () => void = () => {},
): FogTool {
  let scene: Scene | null = null;
  let brush: FogBrush | null = null;
  let gesture: FogGesture = 'fill';
  let preview: number[] = [];
  /** The cell the preview was computed for, so a pointer moving within one cell
   *  does not re-flood a dungeon sixty times a second. */
  let previewCell: string | null = null;
  /** The cells a paint stroke has covered so far, sent as one command on
   *  release — a command per cell would be a hundred frames across one drag. */
  let stroke: number[] = [];
  let painted: Set<string> = new Set();

  const buttons = new Map<FogBrush, HTMLButtonElement>();

  /** Which board this panel is editing — the one on screen, like everything
   *  else that draws or hit-tests. */
  const staged = (): boolean => (scene === null ? false : showingStaged(scene));
  /** The board on screen, or null before the first Welcome. */
  const editing = (): Board | null => (scene === null ? null : shownBoard(scene));
  /** Whether the brush can do anything at all, which is one question now rather
   *  than two: is the board on screen fogged. It used to also ask "and are we
   *  not previewing", because there was no mask on a staged map to paint. */
  const usable = (): boolean => editing()?.fog ?? false;

  const clamp = (ft: number): number => {
    if (!Number.isFinite(ft)) return MIN_VISION_FT;
    return Math.min(Math.max(Math.round(ft), MIN_VISION_FT), MAX_VISION_FT);
  };

  /** The playable region in image pixels, which is what a fill is clipped to —
   *  the same bound the server checks every cell against. */
  const board = (): Rect | null => {
    const on = editing();
    const size = mapSize();
    if (on === null || size === null) return null;
    return playRect(on.playArea, size.w, size.h);
  };

  const clearPreview = (): void => {
    preview = [];
    previewCell = null;
  };

  const paint = (): void => {
    const on = editing();
    const previewing = staged();

    // The board on screen, not the live one — the switch and the radius are
    // fields of `MapInfo` and have always staged with it, so the next dungeon's
    // lights are the DM's to set before the table is shown it.
    ui.on.checked = on?.fog ?? false;
    ui.on.disabled = on === null;
    ui.vision.value = String(on?.visionFt ?? 60);
    // Read-only rather than hidden when fog is off: the radius is still the
    // map's, and hiding it would make turning fog on look like it had also
    // invented a number. The brushes go the same way for the same reason.
    const locked = !usable();
    for (const control of [ui.vision, ui.visionDown, ui.visionUp, ui.gesture]) {
      control.disabled = locked;
    }
    // Reset is the one control that stays live-only, and the reason is that
    // half of it is not the DM's: it forgets everywhere the *party* has
    // explored, and no ray has ever been cast on a map they have not been
    // shown. What it would mean over a preview is "clear the paint", which is
    // the `clear` brush with a bigger blast radius and no undo.
    ui.clear.disabled = locked || previewing;
    for (const [b, button] of buttons) {
      button.disabled = locked;
      button.classList.toggle('is-on', b === brush);
      button.setAttribute('aria-pressed', String(b === brush));
    }
    ui.gesture.textContent = gesture;
    // The body class is what tells the rest of the page the left button is spoken
    // for, exactly as the wall editor's `tracing` does.
    document.body.classList.toggle('painting-fog', brush !== null);

    ui.hint.textContent =
      on?.fog !== true
        ? previewing
          ? 'The map being prepared is unfogged; the table will see all of it.'
          : 'The table sees the whole board.'
        : brush === null
          ? previewing
            ? // Says what it is rather than what it looks like, because what it
              // looks like is nothing: there is no wash under the tint on a map
              // nobody has cast a ray on. Without this line the DM is painting
              // a dungeon that appears to be fully lit.
              'Painting the map being prepared. This is what the party gets when it lands.'
            : `Player tokens light ${ui.vision.value} ft, and walls and shut doors stop it.`
          : gesture === 'fill'
            ? 'Click a room to fill it — every wall and door bounds it, open or shut. Escape puts the brush down.'
            : 'Drag over the squares to paint them.';
  };

  /** The cells a fill from here would take. Recomputed only when the pointer
   *  crosses into a different cell, which is what makes a flood of a few
   *  thousand affordable on a pointer move. */
  const fillAt = (cell: Vec2): void => {
    const id = `${cell.x},${cell.y}`;
    if (id === previewCell) return;
    previewCell = id;

    const on = editing();
    const area = board();
    // The walls of the board being painted, which is what makes a fill on the
    // staged map bound itself with the dungeon traced on it rather than with
    // the one the table is standing in.
    preview =
      on === null || area === null
        ? []
        : fillFrom(cell, scene === null ? [] : shownWalls(scene), on.grid, area, MAX_FILL_CELLS);
  };

  const sendCells = (cells: number[], state: FogBrush): void => {
    if (cells.length === 0) return;
    const pairs: [number, number][] = [];
    for (let i = 0; i < cells.length; i += 2) {
      pairs.push([cells[i] ?? 0, cells[i + 1] ?? 0]);
    }
    send({
      type: 'set_fog_override',
      cells: pairs,
      // `clear` is an absence rather than a state, on the wire as in the room.
      state: state === 'clear' ? null : state,
      staged: staged(),
    });
  };

  for (const entry of BRUSHES) {
    const button = document.createElement('button');
    button.type = 'button';
    // Borrows `.draw-tool` the way the wall editor's modes mean to: it is the
    // same control saying the same thing, and the blue `.is-on` state means
    // exactly what it means there — the left mouse button is spoken for.
    button.className = 'draw-tool fog-brush';
    button.dataset['brush'] = entry.brush;
    button.textContent = entry.label;
    button.title = entry.title;
    button.addEventListener('click', () => {
      // Clicking the brush you are holding puts it down, which is the gesture
      // every other tool here uses and the fastest way back to the board.
      brush = brush === entry.brush ? null : entry.brush;
      clearPreview();
      if (brush !== null) onArm();
      paint();
    });
    buttons.set(entry.brush, button);
    ui.brushes.append(button);
  }

  ui.gesture.addEventListener('click', () => {
    gesture = gesture === 'fill' ? 'paint' : 'fill';
    clearPreview();
    paint();
  });

  // Both halves in one prompt, because the reset is one gesture and the half
  // that surprises is the one the old wording did not mention: the party's
  // exploring goes too. There is no undo, so the prompt says what is lost.
  ui.clear.addEventListener('click', () => {
    const ok = window.confirm(
      'Take the whole map back to dark?\n\n' +
        'This forgets everywhere the party has explored and every square you have painted, ' +
        'then works out what they can see from where they are standing right now.',
    );
    if (!ok) return;
    send({ type: 'reset_fog' });
  });

  const sendMap = (): void => {
    // The map tool owns which slot this lands in, and it is the same slot this
    // panel is showing — both are "the board on screen".
    if (editing() === null) return;
    setFog(ui.on.checked, clamp(Number(ui.vision.value)));
  };

  ui.on.addEventListener('change', sendMap);
  // `change` rather than `input`: typing 1 on the way to 100 would otherwise
  // send a radius nobody asked for and recompute the whole board for it. Same
  // split the grid colour slider makes, and for the same reason.
  ui.vision.addEventListener('change', sendMap);

  const nudge = (by: number): void => {
    ui.vision.value = String(clamp(Number(ui.vision.value) + by));
    sendMap();
  };
  ui.visionDown.addEventListener('click', () => nudge(-STEP_FT));
  ui.visionUp.addEventListener('click', () => nudge(STEP_FT));

  window.addEventListener('keydown', (e) => {
    if (brush === null || e.key !== 'Escape') return;
    tool.stop();
  });

  const tool: FogTool = {
    get brush() {
      return brush;
    },
    get gesture() {
      return gesture;
    },
    get preview() {
      return preview;
    },

    point(at) {
      if (brush === null || gesture !== 'fill' || at === null || !usable()) {
        clearPreview();
        return;
      }
      fillAt({ x: Math.floor(at.x), y: Math.floor(at.y) });
    },

    apply(at) {
      if (brush === null || !usable()) return;
      const cell = { x: Math.floor(at.x), y: Math.floor(at.y) };

      if (gesture === 'fill') {
        // What was previewed is what is sent — the same array, not a second run
        // of the same algorithm. That is what makes the preview a promise, and
        // it is why the fill lives on this side of the wire at all.
        fillAt(cell);
        sendCells(preview, brush);
        clearPreview();
        return;
      }

      const id = `${cell.x},${cell.y}`;
      if (painted.has(id)) return;
      painted.add(id);
      stroke.push(cell.x, cell.y);
    },

    endStroke() {
      if (brush !== null) sendCells(stroke, brush);
      stroke = [];
      painted = new Set();
    },

    update(next) {
      const wasStaged = staged();
      scene = next;
      // A brush left in hand over a map that has just lost its fog is a tool
      // that can do nothing — the same argument the tab itself goes inert on.
      // Previewing is no longer one of those cases: the staged board has a mask
      // of its own to paint now.
      if (brush !== null && !usable()) brush = null;
      // A stroke half-drawn when the board changed slot under it is a set of
      // cells about the other map. Dropped rather than sent, which is the same
      // call the wall editor makes about a half-traced run.
      if (staged() !== wasStaged) {
        stroke = [];
        painted = new Set();
      }
      clearPreview();
      paint();
    },

    stop() {
      brush = null;
      stroke = [];
      painted = new Set();
      clearPreview();
      paint();
    },
  };

  paint();
  return tool;
}

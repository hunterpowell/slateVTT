/**
 * The DM's fog panel: a switch, a mode, a radius, and a brush.
 *
 * The first three are the map's and go out as part of a `set_map` through the
 * map tool, which owns the confirmed calibration. There is no `set_fog`, as
 * there is no `set_hp`: two commands writing one record can come to disagree.
 *
 * The mode is a third field on that command. Nothing on the client computes
 * with it (what arrives is a packed rectangle either way), so the client's
 * part of room lighting is these two buttons and the hint under them.
 *
 * The hint matters. Under `room`, a wall the DM didn't trace lets a room light
 * into the next one, and the board can't say so: the fog just arrives wider
 * than they meant. So the hint names the rule, not the effect: every wall and
 * door bounds a room, and an archway is a door left open, as for the fill.
 *
 * The brush is not the map's. It applies to particular cells, is sent as its
 * own command, and is why this panel has a `stop()`: a tool holding the left
 * mouse button under a hidden panel makes a click do something with nothing on
 * screen saying why.
 *
 * Four states and two gestures:
 *
 * - **ground** hands the terrain over and leaves the creatures standing on it
 *   alone; **lit** hands over both; **dark** takes both away, memory included;
 *   **clear** hands the cells back to line of sight.
 * - **fill** floods from the cell under the pointer, bounded by every segment
 *   the DM traced (doors included, open or shut: the one place a door's state
 *   isn't read), and previews before it commits. **paint** applies the state to
 *   the cells the pointer is dragged across.
 *
 * The preview is necessary. One gap in a traced room reveals the whole dungeon
 * in a single click, so the fill is shown before it lands and the DM checks
 * the geometry by eye.
 *
 * Where a click landed and what was under it is input.ts's job, as for the
 * wall editor and the draw tool. This file holds what the brush is loaded
 * with, what a fill would cover, and the panel around both.
 *
 * Read `docs/fog.md` before changing what this sends.
 */

import type { Rect, Vec2 } from './coords.js';
import { playRect } from './coords.js';
import { fillFrom } from './overrides.js';
import type { ClientMsg, FogPaint, Lighting } from './protocol.js';
import type { Board, Scene, Token } from './scene.js';
import { shownBoard, shownWalls, showingStaged } from './scene.js';

/** Matches `MIN_VISION_FT` and `MAX_VISION_FT` on the server, which re-checks. */
const MIN_VISION_FT = 5;
const MAX_VISION_FT = 500;
/** The step the buttons move by: one cell. */
const STEP_FT = 5;

/** Matches `MAX_OVERRIDE_CELLS` on the server, which refuses anything past it.
 *  A fill that reaches this has escaped through a gap, and stopping shows the
 *  DM that directly instead of giving them a refusal to interpret.
 *
 *  **Both numbers are bounded by the frame size.** `set_fog_override` carries
 *  one `[x,y]` pair per cell, so the command has to fit inside
 *  `MAX_WS_MESSAGE_BYTES`; the server's test asserts the largest legal one
 *  does. Past that, a whole-room fill kills the socket and reloads the page
 *  instead of being refused. See `docs/net.md`. */
const MAX_FILL_CELLS = 8_000;

/**
 * Whether the solo sight check is offered at all.
 *
 * Off, and this const is the only thing switching it off. Player view answers
 * the question the DM was using the sight check for (what is on the table's
 * board) for the whole party at once, which made the one-creature check
 * redundant. `solo.ts`, its tests and the render path are unchanged and still
 * correct; only the button is gone.
 *
 * Milestone 29 brings it back. Once `visible` is per-player there is no single
 * table's board to mirror, player view has to name somebody, and "what can
 * this creature see" becomes the useful question. Flip this to `true` then,
 * and see *Solo sight* in `docs/fog.md`, which is still the design.
 *
 * Hidden, not greyed: this panel greys a control to mean "not on this board",
 * which the DM can change. A button that can never be pressed isn't that.
 */
const SOLO_SIGHT = false;

/** What the brush is loaded with. `clear` is the absence of an override, not a
 *  fourth kind of one, so it goes on the wire as null. */
export type FogBrush = FogPaint | 'clear';
/** Flood from a cell, or apply to the cells the pointer crosses. */
export type FogGesture = 'fill' | 'paint';

export interface FogToolUi {
  root: HTMLElement;
  on: HTMLInputElement;
  /** The two mode buttons are built here instead of in the document, like the
   *  brushes below, so the list lives in one place. */
  lighting: HTMLElement;
  vision: HTMLInputElement;
  visionDown: HTMLButtonElement;
  visionUp: HTMLButtonElement;
  hint: HTMLElement;
  /** The four state buttons are built here instead of in the document, as the
   *  wall tool's modes are, so the list lives in one place. */
  brushes: HTMLElement;
  gesture: HTMLButtonElement;
  clear: HTMLButtonElement;
  /** Solo sight: arm it, then click a creature to see the board as it does. */
  sight: HTMLButtonElement;
  /** Player view: the whole board as the table is looking at it. */
  view: HTMLButtonElement;
}

export interface FogTool {
  /** What the brush is loaded with, or null when the tool is put away and the
   *  pointer goes back to panning and dragging tokens. */
  readonly brush: FogBrush | null;
  readonly gesture: FogGesture;
  /** The cells a fill would cover, as flat pairs. Empty in paint mode and
   *  whenever the pointer is off the board. */
  readonly preview: readonly number[];

  /**
   * Solo sight is armed, so the next click on a creature picks it rather than
   * grabbing it. Separate from `brush` because the two are different gestures
   * on the same button and arming either puts the other down.
   */
  readonly checking: boolean;
  /** The creature whose sight is on the DM's board, or null. Outlives
   *  `checking`: having picked one, the DM puts the tool down and keeps looking
   *  at the answer. */
  readonly sightId: string | null;
  /** From a click on the board while `checking`. Null clears the answer. */
  check(token: Token | null): void;

  /**
   * The DM is looking at the board as the table sees it.
   *
   * Read by the frame loop, which narrows the scene through `asTable` before
   * handing it to the renderer. It arms nothing and refuses nothing: the DM can
   * still drag, click and edit through the mirror, as through one creature's
   * sight. See `mirror.ts`.
   */
  readonly playerView: boolean;

  /** Where the pointer is, in grid units, or null when it has left the canvas.
   *  Recomputes the fill only when it crosses into a different cell. */
  point(at: Vec2 | null): void;
  /** The gesture the pointer just made: a click in fill mode, or one cell of a
   *  drag in paint mode. */
  apply(at: Vec2): void;
  /** A paint stroke ended. Sends what it covered as one command. */
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

/** The two ways a fogged map works out what the party can see, in the words the
 *  DM picks between. Neither is a modifier of the other, so both are named. */
const MODES: readonly { mode: Lighting; label: string; title: string }[] = [
  {
    mode: 'dynamic',
    label: 'sight',
    title: 'A token sees what it has a straight line to, out to its radius.',
  },
  {
    mode: 'room',
    label: 'room',
    title:
      'A token lights the whole room it is standing in, out to its radius, and sees through open doors into the next one. Every wall and door you traced bounds a room — an archway is a door left open.',
  },
];

export function createFogTool(
  ui: FogToolUi,
  /** Sends the three map fields as part of a whole `set_map` for the slot on
   *  screen. */
  setFog: (on: boolean, visionFt: number, lighting: Lighting) => void,
  send: (msg: ClientMsg) => void,
  /** The map image's size, for a board with no play area. Read lazily, as the
   *  map tool does, because the image can change. */
  mapSize: () => { w: number; h: number } | null,
  /** Called when the brush is picked up, so the other tools let go of the left
   *  button. input.ts can't resolve two tools armed at once. */
  onArm: () => void = () => {},
  /** Called when player view is turned on or off. The board is redrawn every
   *  frame and reads the flag itself; the initiative panel isn't, and it
   *  mirrors too (see `tableInitiative`). */
  onView: () => void = () => {},
): FogTool {
  let scene: Scene | null = null;
  let brush: FogBrush | null = null;
  let gesture: FogGesture = 'fill';
  let preview: number[] = [];
  /** The cell the preview was computed for, so a pointer moving within one cell
   *  doesn't re-flood a dungeon sixty times a second. */
  let previewCell: string | null = null;
  /** The cells a paint stroke has covered so far, sent as one command on
   *  release. A command per cell would be a hundred frames across one drag. */
  let stroke: number[] = [];
  let painted: Set<string> = new Set();
  /** Solo sight: whether the next click picks a creature, and which one it
   *  picked. Two variables because putting the tool down must not take the
   *  answer off the board. */
  let checking = false;
  let sightId: string | null = null;
  /** Player view: the whole board as the table has it. A third thing that can
   *  replace the DM's own board, and it excludes the other two by hand (see
   *  the button's handler). */
  let playerView = false;

  const buttons = new Map<FogBrush, HTMLButtonElement>();
  const modes = new Map<Lighting, HTMLButtonElement>();

  /** Which board this panel is editing: the one on screen, like everything
   *  else that draws or hit-tests. */
  const staged = (): boolean => (scene === null ? false : showingStaged(scene));
  /** The board on screen, or null before the first Welcome. */
  const editing = (): Board | null => (scene === null ? null : shownBoard(scene));
  /** Whether the brush can do anything: is the board on screen fogged. This
   *  includes a staged board, which has a mask of its own to paint. */
  const usable = (): boolean => editing()?.fog ?? false;

  const clamp = (ft: number): number => {
    if (!Number.isFinite(ft)) return MIN_VISION_FT;
    return Math.min(Math.max(Math.round(ft), MIN_VISION_FT), MAX_VISION_FT);
  };

  /** The playable region in image pixels, which a fill is clipped to. The
   *  server checks every cell against the same bound. */
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

  /** Puts the mirror down, if it is up, and tells main.ts so the panels that
   *  don't redraw every frame catch up. A no-op otherwise, so callers can call
   *  it unconditionally. */
  const leaveView = (): void => {
    if (!playerView) return;
    playerView = false;
    onView();
  };

  const paint = (): void => {
    const on = editing();
    const previewing = staged();

    // The board on screen, not the live one: the switch and the radius are
    // fields of `MapInfo` and stage with it, so the DM sets the next map's
    // lights before the table is shown it.
    ui.on.checked = on?.fog ?? false;
    ui.on.disabled = on === null;
    ui.vision.value = String(on?.visionFt ?? 60);
    // Read-only, not hidden, when fog is off: the radius is still the map's,
    // and hiding it would make turning fog on look like it had also picked a
    // number. The brushes do the same for the same reason.
    const locked = !usable();
    for (const control of [ui.vision, ui.visionDown, ui.visionUp, ui.gesture]) {
      control.disabled = locked;
    }
    // The mode is the map's like the switch above it, so the buttons read off
    // the board instead of holding a state of their own. Switching to the
    // staged slot then shows that map's mode.
    const lighting = on?.lighting ?? 'dynamic';
    for (const [m, button] of modes) {
      button.disabled = locked;
      button.classList.toggle('is-on', m === lighting);
      button.setAttribute('aria-pressed', String(m === lighting));
    }
    // Reset stays live-only because half of it isn't the DM's: it forgets
    // everywhere the party has explored, and no ray has been cast on a map
    // they haven't been shown. Over a preview it would only clear the paint,
    // which is the `clear` brush over the whole map.
    ui.clear.disabled = locked || previewing;
    // Live-only, like reset: nothing has cast a ray on a board nobody has been
    // shown, so there is no sight on it to check. Unfogged doesn't disable it
    // (everyone seeing everything is still an answer), but a board with no
    // grid does, which `usable()` already covers for the rest of the panel.
    // The rest of this block styles the button when it is offered, which it
    // isn't (see `SOLO_SIGHT`). It runs against a hidden element instead of
    // being branched around, so bringing it back is one const.
    ui.sight.hidden = !SOLO_SIGHT;
    ui.sight.disabled = on === null || previewing;
    ui.sight.classList.toggle('is-on', checking);
    ui.sight.setAttribute('aria-pressed', String(checking));
    // The name is the readout: having picked a creature the DM puts the tool
    // down, and the button says whose eyes the board is showing.
    const watched = sightId === null ? null : (scene?.tokens.find((t) => t.id === sightId) ?? null);
    ui.sight.textContent = watched === null ? 'sight check' : `seeing as ${watched.name}`;
    // Live board only, like reset and sight check: the table isn't looking at
    // the map being prepared, so there is nothing to mirror. Unlike those two
    // it isn't greyed by an unfogged map: fog is not the only thing it hides,
    // and a monster the DM staged out of sight is hidden on a lit board too.
    ui.view.disabled = on === null || previewing;
    ui.view.classList.toggle('is-on', playerView);
    ui.view.setAttribute('aria-pressed', String(playerView));
    for (const [b, button] of buttons) {
      button.disabled = locked;
      button.classList.toggle('is-on', b === brush);
      button.setAttribute('aria-pressed', String(b === brush));
    }
    ui.gesture.textContent = gesture;
    // The body class tells the rest of the page the left button is taken, as
    // the wall editor's `tracing` does.
    document.body.classList.toggle('painting-fog', brush !== null);
    document.body.classList.toggle('checking-sight', checking);
    // The same treatment the staged map's border gets, for the same reason:
    // the DM is looking at something nobody else is, and could mistake it for
    // the board.
    document.body.classList.toggle('solo-sight', sightId !== null);
    // The third board-level treatment, beside preview's amber and solo sight's
    // blue, for the same reason: the DM is looking at something that isn't
    // their own board, and could mistake it for one.
    document.body.classList.toggle('player-view', playerView);

    ui.hint.textContent = playerView
      ? // Says what is missing, not what is there, because what is there looks
        // like an ordinary board. A DM who forgets they are in here will go
        // looking for a monster that is on their board and not on this one.
        'Showing the board as the table sees it — their fog, and nothing they are not sent. Your walls, painted squares, hit points and hidden creatures are still there behind it.'
      : checking
      ? 'Click a creature to see the board as it does. Geometry only — your painted squares are not applied.'
      : sightId !== null
        ? `Showing what ${watched?.name ?? 'that creature'} can see right now. Click the button to go back to the table's board.`
        : on?.fog !== true
        ? previewing
          ? 'The map being prepared is unfogged; the table will see all of it.'
          : 'The table sees the whole board.'
        : brush === null
          ? previewing
            ? // Says what this is, because nothing on screen shows it: there is
              // no wash under the tint on a map nobody has cast a ray on.
              // Without this line the DM is painting a dungeon that appears to
              // be fully lit.
              'Painting the map being prepared. This is what the party gets when it lands.'
            : lighting === 'room'
              ? // Names the boundary, not the door, because that is the rule the
                // DM needs to trace a dungeon that lights as they meant: a room
                // that lit further than expected has a gap in its wall, and the
                // fix is a segment across the gap.
                `Player tokens light the room they are in, out to ${ui.vision.value} ft, and see through open doors. Every wall and door you trace bounds a room.`
              : `Player tokens light ${ui.vision.value} ft, and walls and shut doors stop it.`
          : gesture === 'fill'
            ? 'Click a room to fill it — every wall and door bounds it, open or shut. Escape puts the brush down.'
            : 'Drag over the squares to paint them.';
  };

  /** The cells a fill from here would cover. Recomputed only when the pointer
   *  crosses into a different cell, which makes a flood of a few thousand
   *  affordable on a pointer move. */
  const fillAt = (cell: Vec2): void => {
    const id = `${cell.x},${cell.y}`;
    if (id === previewCell) return;
    previewCell = id;

    const on = editing();
    const area = board();
    // The walls of the board being painted, so a fill on the staged map is
    // bounded by the walls traced on it, not by the live map's.
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
      // `clear` is an absence, not a state, on the wire as in the room.
      state: state === 'clear' ? null : state,
      staged: staged(),
    });
  };

  for (const entry of BRUSHES) {
    const button = document.createElement('button');
    button.type = 'button';
    // Borrows `.draw-tool`, as the wall editor's modes do: it is the same kind
    // of control, and the blue `.is-on` state means the same thing there: the
    // left mouse button is taken.
    button.className = 'draw-tool fog-brush';
    button.dataset['brush'] = entry.brush;
    button.textContent = entry.label;
    button.title = entry.title;
    button.addEventListener('click', () => {
      // Clicking the brush you are holding puts it down, as with every other
      // tool here.
      brush = brush === entry.brush ? null : entry.brush;
      clearPreview();
      // The mirror doesn't show the DM's painted squares, so painting through
      // it would paint cells the DM can't see. Picking a brush up leaves the
      // mirror, as the sight check does below.
      if (brush !== null) {
        leaveView();
        onArm();
      }
      paint();
    });
    buttons.set(entry.brush, button);
    ui.brushes.append(button);
  }

  // Arming solo sight puts the brush down and vice versa: they are two gestures
  // on the same button, and input.ts can't resolve two tools armed at once.
  // `onArm` tells the draw and wall tools outside this panel the same thing.
  // Registered only while the check is offered, so `checking` and `sightId`
  // can't be reached at all. A hidden button can still be pressed by a script,
  // and the two states behind it change the DM's board with nothing on screen
  // to explain it.
  if (SOLO_SIGHT) ui.sight.addEventListener('click', () => {
    // Three states behind one button, and **anything on the board comes off
    // first.** With an answer up, the button is the way back to the table's
    // board, as the hint under it says. Re-arming there instead would leave
    // the DM with one creature's sight and no control on screen to remove it.
    if (checking || sightId !== null) {
      checking = false;
      sightId = null;
    } else {
      checking = true;
      brush = null;
      // Only one thing can replace the DM's board at a time: the whole table's
      // sight and one creature's are different questions, and a board showing
      // both answers neither. Preview is the third and excludes itself (see
      // `update`).
      leaveView();
      clearPreview();
      onArm();
    }
    paint();
  });

  // The mirror. Its own button, not a fifth brush or a second state on the one
  // above, because it is neither a gesture nor a question about a creature: it
  // decides which board is on screen, as preview does.
  //
  // It takes no mouse button, so nothing outside this panel has to let go of
  // one. The draw tool stays armed through it, since a shape swept while
  // looking at the table's board is aimed at what they can see.
  ui.view.addEventListener('click', () => {
    if (playerView) {
      leaveView();
    } else {
      playerView = true;
      // Whatever else was replacing the board comes off first, as with the
      // sight button, leaving only what was just asked for.
      checking = false;
      sightId = null;
      brush = null;
      clearPreview();
      onView();
    }
    paint();
  });

  ui.gesture.addEventListener('click', () => {
    gesture = gesture === 'fill' ? 'paint' : 'fill';
    clearPreview();
    paint();
  });

  // Both halves in one prompt, because the reset is one gesture and the half
  // that surprises is that the party's exploring goes too. The prompt says
  // what is lost; undo can bring it back, but only while it is in the ring.
  ui.clear.addEventListener('click', () => {
    const ok = window.confirm(
      'Take the whole map back to dark?\n\n' +
        'This forgets everywhere the party has explored and every square you have painted, ' +
        'then works out what they can see from where they are standing right now.',
    );
    if (!ok) return;
    send({ type: 'reset_fog' });
  });

  const sendMap = (lighting?: Lighting): void => {
    // The map tool owns which slot this lands in, and it is the same slot this
    // panel is showing: both use the board on screen.
    const on = editing();
    if (on === null) return;
    setFog(ui.on.checked, clamp(Number(ui.vision.value)), lighting ?? on.lighting);
  };

  for (const entry of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    // The brushes' control, narrower. Here `.is-on` means "this is what the
    // map is set to", not anything about the mouse: a mode arms nothing.
    button.className = 'draw-tool fog-mode';
    button.textContent = entry.label;
    button.title = entry.title;
    // Sent straight out as a `set_map`, with no local state. There is nothing
    // to confirm or preview: the room recomputes and the board that comes back
    // is the answer.
    button.addEventListener('click', () => sendMap(entry.mode));
    modes.set(entry.mode, button);
    ui.lighting.append(button);
  }

  // Wrapped, because `sendMap` takes an argument and an event listener would
  // pass it the event.
  ui.on.addEventListener('change', () => sendMap());
  // `change`, not `input`: typing 1 on the way to 100 would otherwise send a
  // radius nobody asked for and recompute the whole board for it. The grid
  // colour slider does the same.
  ui.vision.addEventListener('change', () => sendMap());

  const nudge = (by: number): void => {
    ui.vision.value = String(clamp(Number(ui.vision.value) + by));
    sendMap();
  };
  ui.visionDown.addEventListener('click', () => nudge(-STEP_FT));
  ui.visionUp.addEventListener('click', () => nudge(STEP_FT));

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (brush === null && !checking && sightId === null) return;
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
    get checking() {
      return checking;
    },
    get sightId() {
      return sightId;
    },
    get playerView() {
      return playerView;
    },

    check(token) {
      if (!checking) return;
      sightId = token?.id ?? null;
      // The tool disarms itself on a hit: picking a creature is one gesture,
      // and leaving the button armed would make the next click on the board
      // re-pick instead of doing what it normally does. A miss leaves it armed,
      // because a miss is usually slightly off aim.
      if (sightId !== null) checking = false;
      paint();
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
        // What was previewed is what is sent: the same array, not a second run
        // of the algorithm. That guarantees the preview matches the result,
        // and is why the fill runs on the client.
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
      // A brush left in hand over a map that has just lost its fog can do
      // nothing, which is also why the tab goes inert. Previewing isn't one of
      // those cases: the staged board has a mask of its own to paint.
      if (brush !== null && !usable()) brush = null;
      // A stroke half-drawn when the board changed slot under it is a set of
      // cells on the other map. Dropped, not sent, as the wall editor drops a
      // half-traced run.
      if (staged() !== wasStaged) {
        stroke = [];
        painted = new Set();
      }
      // A preview starting under the mirror is the only way the two could be
      // on at once, and the mirror would then be wrong: `asTable` works on the
      // live board, so the DM would see the table's board while thinking they
      // were looking at the next map.
      if (staged()) leaveView();
      clearPreview();
      paint();
    },

    stop() {
      brush = null;
      stroke = [];
      painted = new Set();
      // Solo sight goes with it, answer included. The rail's rule is that
      // closing a tab puts down whatever the panel armed, and this panel's
      // button is the only thing on screen explaining why the DM's board shows
      // one creature's line of sight instead of the table's fog.
      checking = false;
      sightId = null;
      // The mirror goes too, for the same reason: the button is the only thing
      // on screen explaining a board that is missing the DM's own walls and
      // half their monsters, and it goes with the tab.
      leaveView();
      clearPreview();
      paint();
    },
  };

  paint();
  return tool;
}

/**
 * The DM's fog panel: a switch, a mode, a radius, and — since 16b — a brush.
 *
 * The first three are the map's and go out as part of a `set_map` through the
 * map tool, which owns the confirmed calibration. There is no `set_fog`, for the
 * reason there is no `set_hp`: it would be a second way to write one record, and
 * two writers for one record is how they come to disagree.
 *
 * The mode is milestone 21 and is a third field on that one command rather than
 * anything of its own. **Nothing on this side computes with it** — what arrives
 * is a packed rectangle either way — so the whole of the client's half of room
 * lighting is these two buttons and the sentence under them.
 *
 * That sentence carries more than it looks like it does. Under `room` a wall the
 * DM did not trace is a room that lights into the next one, and the board cannot
 * say so: the fog just arrives wider than they meant. So the hint names the rule
 * rather than the effect — every wall and door bounds a room, and an archway is a
 * door left open, which is the same thing the reveal fill has always done.
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
import type { ClientMsg, FogPaint, Lighting } from './protocol.js';
import type { Board, Scene, Token } from './scene.js';
import { shownBoard, shownWalls, showingStaged } from './scene.js';

/** Matches `MIN_VISION_FT` and `MAX_VISION_FT` on the server, which re-checks. */
const MIN_VISION_FT = 5;
const MAX_VISION_FT = 500;
/** The step the buttons move by: one cell, which is the unit that matters. */
const STEP_FT = 5;

/** Matches `MAX_OVERRIDE_CELLS` on the server, which refuses anything past it.
 *  A fill that reaches this has escaped through a gap, and stopping is how the
 *  DM sees that rather than getting a refusal they have to interpret.
 *
 *  **Both numbers are bounded by the frame, not by taste.** `set_fog_override`
 *  carries one `[x,y]` pair per cell, so the command has to fit inside
 *  `MAX_WS_MESSAGE_BYTES`; the server's test asserts the largest legal one does.
 *  This was 50,000 against a 16 KiB frame, which meant a whole-room fill killed
 *  the socket and reloaded the page instead of being refused — see `docs/net.md`. */
const MAX_FILL_CELLS = 8_000;

/**
 * Whether the solo sight check is offered at all.
 *
 * **Off since milestone 34, and this const is the whole of the suspension.**
 * Player view answers the question a DM was actually using the sight check for —
 * what is on the table's board — and answers it for the whole party at once, so
 * asking one creature became a narrower version of a question with a better
 * button next to it. `solo.ts`, its tests and the whole render path are
 * untouched and still correct; what is switched off is the way in.
 *
 * **What brings it back is milestone 29.** The day `visible` becomes per-player
 * there is no single table's board to mirror, player view has to name somebody,
 * and "what can *this* creature see" stops being the narrow version of anything.
 * Flip this to `true` then — and see *Solo sight* in `docs/fog.md`, which is
 * still the design.
 *
 * Hidden rather than greyed on purpose: this panel greys a control to say "not
 * on this board, and here is why", which is a sentence with a way out of it. A
 * button that can never be pressed is not that sentence.
 */
const SOLO_SIGHT = false;

/** What the brush is loaded with. `clear` is the absence of an override rather
 *  than a fourth kind of one, which is why it goes on the wire as null. */
export type FogBrush = FogPaint | 'clear';
/** Flood from a cell, or apply to the cells the pointer crosses. */
export type FogGesture = 'fill' | 'paint';

export interface FogToolUi {
  root: HTMLElement;
  on: HTMLInputElement;
  /** The two mode buttons are built here rather than in the document, like the
   *  brushes below and for the same reason: the list lives in one place. */
  lighting: HTMLElement;
  vision: HTMLInputElement;
  visionDown: HTMLButtonElement;
  visionUp: HTMLButtonElement;
  hint: HTMLElement;
  /** The four state buttons are built here rather than in the document, the way
   *  the wall tool's modes are, so the list lives in one place. */
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
  /** The cells a fill would take, as flat pairs — empty in paint mode and
   *  whenever the pointer is off the board. */
  readonly preview: readonly number[];

  /**
   * Solo sight is armed, so the next click on a creature picks it rather than
   * grabbing it. Separate from `brush` because the two are different gestures
   * on the same button and arming either puts the other down.
   */
  readonly checking: boolean;
  /** The creature whose sight is on the DM's board, or null. Outlives `checking`
   *  deliberately: having picked one, the DM puts the tool down and goes on
   *  looking at the answer. */
  readonly sightId: string | null;
  /** From a click on the board while `checking`. Null clears the answer. */
  check(token: Token | null): void;

  /**
   * The DM is looking at the board as the table sees it.
   *
   * Read by the frame loop, which narrows the scene through `asTable` before
   * handing it to the renderer. It arms nothing and refuses nothing: the DM can
   * still drag, click and edit through the mirror, exactly as they can through
   * one creature's sight. See `mirror.ts`.
   */
  readonly playerView: boolean;

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
  /** The map image's size, for a board with no play area — the same lazy read
   *  the map tool makes, because the image changes under this. */
  mapSize: () => { w: number; h: number } | null,
  /** Called when the brush is picked up, so the other tools let go of the left
   *  button. Two tools armed at once is not a state input.ts could resolve. */
  onArm: () => void = () => {},
  /** Called when player view is turned on or off. The board is redrawn every
   *  frame and reads the flag for itself; the initiative panel is not, and it
   *  mirrors too — see `tableInitiative`. */
  onView: () => void = () => {},
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
  /** Solo sight: whether the next click picks a creature, and which one it
   *  picked. Two variables rather than one because putting the tool down must
   *  not take the answer off the board. */
  let checking = false;
  let sightId: string | null = null;
  /** Player view: the whole board as the table has it. A third thing that can be
   *  on the board instead of the DM's own, and it excludes the other two by
   *  hand — see the button's handler. */
  let playerView = false;

  const buttons = new Map<FogBrush, HTMLButtonElement>();
  const modes = new Map<Lighting, HTMLButtonElement>();

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

  /** Puts the mirror down, if it is up, and tells main.ts so the panels that do
   *  not redraw themselves every frame catch up. A no-op otherwise, so every
   *  caller can say it unconditionally. */
  const leaveView = (): void => {
    if (!playerView) return;
    playerView = false;
    onView();
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
    // The mode is the map's like the switch above it, so the buttons read off
    // the board rather than holding a state of their own — which is what makes
    // switching to the staged slot show that map's answer and not this one's.
    const lighting = on?.lighting ?? 'dynamic';
    for (const [m, button] of modes) {
      button.disabled = locked;
      button.classList.toggle('is-on', m === lighting);
      button.setAttribute('aria-pressed', String(m === lighting));
    }
    // Reset is the one control that stays live-only, and the reason is that
    // half of it is not the DM's: it forgets everywhere the *party* has
    // explored, and no ray has ever been cast on a map they have not been
    // shown. What it would mean over a preview is "clear the paint", which is
    // the `clear` brush with a bigger blast radius and no undo.
    ui.clear.disabled = locked || previewing;
    // Live-only for the reason reset is, and it is the same reason twice:
    // nothing has cast a ray on a board nobody has been shown, so there is no
    // sight on it to check. Unfogged is not a bar — an unfogged map is one
    // where everyone sees everything, and answering that is still an answer —
    // but a board with no grid is, which `usable()` already covers for the rest
    // of the panel.
    // Everything below about this button is what paints it when it is offered,
    // which it is not — see `SOLO_SIGHT`. Left running against a hidden element
    // rather than branched around, so bringing it back is one const and not a
    // reconstruction.
    ui.sight.hidden = !SOLO_SIGHT;
    ui.sight.disabled = on === null || previewing;
    ui.sight.classList.toggle('is-on', checking);
    ui.sight.setAttribute('aria-pressed', String(checking));
    // The name is the readout: having picked a creature the DM puts the tool
    // down, and the button is what says whose eyes the board is showing.
    const watched = sightId === null ? null : (scene?.tokens.find((t) => t.id === sightId) ?? null);
    ui.sight.textContent = watched === null ? 'sight check' : `seeing as ${watched.name}`;
    // Live board only, for the reason reset and sight check are: the table is
    // not looking at the map being prepared, so there is nothing here for a
    // mirror of their board to answer. Unlike those two it is not greyed by an
    // unfogged map — the fog is the loudest thing it hides and not the only one,
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
    // The body class is what tells the rest of the page the left button is spoken
    // for, exactly as the wall editor's `tracing` does.
    document.body.classList.toggle('painting-fog', brush !== null);
    document.body.classList.toggle('checking-sight', checking);
    // The same treatment the staged map's border gets, and for the same reason:
    // the DM is looking at something nobody else is, and mistaking it for the
    // board is the one way this goes wrong.
    document.body.classList.toggle('solo-sight', sightId !== null);
    // The third board-level treatment, beside preview's amber and solo sight's
    // blue, and it is owed one for their reason exactly: the DM is looking at
    // something that is not their own board, and mistaking it for one is the
    // single way any of the three goes wrong.
    document.body.classList.toggle('player-view', playerView);

    ui.hint.textContent = playerView
      ? // Says what is missing rather than what is there, because what is there
        // looks exactly like an ordinary board — which is the whole point of it
        // and also the whole risk. A DM who forgets they are in here will go
        // looking for a monster that is on the board and not on this one.
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
            ? // Says what it is rather than what it looks like, because what it
              // looks like is nothing: there is no wash under the tint on a map
              // nobody has cast a ray on. Without this line the DM is painting
              // a dungeon that appears to be fully lit.
              'Painting the map being prepared. This is what the party gets when it lands.'
            : lighting === 'room'
              ? // Names the boundary rather than the door, because that is the
                // rule a DM has to hold to trace a dungeon that lights the way
                // they meant: a room that lit further than expected is a wall
                // with a gap in it, and the fix is a segment across the gap.
                `Player tokens light the room they are in, out to ${ui.vision.value} ft, and see through open doors. Every wall and door you trace bounds a room.`
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
      // Painting through the mirror would be painting squares that are not on
      // it: the tint is the DM's own hand, and the mirror is what their hand is
      // absent from. Picking a brush up is therefore a way out of it, which is
      // the same trade the sight check makes below.
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
  // competing for the same button, and two tools armed at once is not a state
  // input.ts could resolve. `onArm` says the same thing to the draw and wall
  // tools outside this panel.
  // Registered only while the check is offered, so `checking` and `sightId`
  // cannot be reached at all rather than merely being hard to click. A hidden
  // button is still a button a script can press, and the two states behind this
  // one put the DM's board somewhere nothing on screen would account for.
  if (SOLO_SIGHT) ui.sight.addEventListener('click', () => {
    // Three states behind one button, and the order of these two branches is the
    // whole of it: **anything on the board comes off first.** With an answer up,
    // the button is the way back to the table's board, which is what the hint
    // under it promises — and re-arming there instead would leave the DM holding
    // one creature's sight with no control on screen that takes it away.
    if (checking || sightId !== null) {
      checking = false;
      sightId = null;
    } else {
      checking = true;
      brush = null;
      // Three things can stand in for the DM's board and only one of them can be
      // standing there: the whole table's answer and one creature's are two
      // different questions, and a board showing both would be answering
      // neither. Preview is the fourth and excludes itself — see `update`.
      leaveView();
      clearPreview();
      onArm();
    }
    paint();
  });

  // The mirror. Its own button rather than a fifth brush or a second state on
  // the one above, because it is neither a gesture nor a question about a
  // creature — it is which board is on screen, which is what preview is too.
  //
  // It takes no mouse button, so nothing outside this panel has to let go of
  // one: the draw tool stays armed through it deliberately, since a shape swept
  // while looking at the table's board is a shape aimed at what they can see.
  ui.view.addEventListener('click', () => {
    if (playerView) {
      leaveView();
    } else {
      playerView = true;
      // Whatever else was standing in for the board comes off, which is the
      // order the sight button already established: anything on the board goes
      // first, and what is left is the thing that was just asked for.
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

  const sendMap = (lighting?: Lighting): void => {
    // The map tool owns which slot this lands in, and it is the same slot this
    // panel is showing — both are "the board on screen".
    const on = editing();
    if (on === null) return;
    setFog(ui.on.checked, clamp(Number(ui.vision.value)), lighting ?? on.lighting);
  };

  for (const entry of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    // The brushes' control, narrower: `.is-on` means the same thing on both,
    // which is "this is what the panel is set to" rather than anything about
    // the mouse — a mode arms nothing.
    button.className = 'draw-tool fog-mode';
    button.textContent = entry.label;
    button.title = entry.title;
    // Straight out as a `set_map` rather than through a local variable. There
    // is nothing to confirm and nothing to preview: the room recomputes and the
    // board that comes back is the answer.
    button.addEventListener('click', () => sendMap(entry.mode));
    modes.set(entry.mode, button);
    ui.lighting.append(button);
  }

  // Wrapped, because `sendMap` takes an argument now and an event listener
  // would hand it the event.
  ui.on.addEventListener('change', () => sendMap());
  // `change` rather than `input`: typing 1 on the way to 100 would otherwise
  // send a radius nobody asked for and recompute the whole board for it. Same
  // split the grid colour slider makes, and for the same reason.
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
      // The tool disarms itself on a hit: picking a creature is a one-shot
      // gesture, and leaving the button armed would mean the next click on the
      // board re-picks instead of doing what it normally does. A miss leaves it
      // armed, because a miss is usually an aim that was slightly off.
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
      // A preview starting under the mirror is the one way the two could be on
      // at once, and it is the way this feature would lie: `asTable` answers
      // about the live board, so the DM would be looking at the board the table
      // has while believing they were looking at the next dungeon.
      if (staged()) leaveView();
      clearPreview();
      paint();
    },

    stop() {
      brush = null;
      stroke = [];
      painted = new Set();
      // Solo sight goes with it, answer included. The rail's rule is that
      // closing a tab puts down whatever the panel armed, and here what it armed
      // is also the only thing on screen explaining why the DM's board is
      // showing one creature's line of sight instead of the table's fog — a
      // wash nobody can account for is worse than a click nobody can account
      // for.
      checking = false;
      sightId = null;
      // And the mirror with them, for the same sentence: the button is the only
      // thing on screen accounting for a board that is missing the DM's own
      // walls and half their monsters, and it goes with the tab.
      leaveView();
      clearPreview();
      paint();
    },
  };

  paint();
  return tool;
}

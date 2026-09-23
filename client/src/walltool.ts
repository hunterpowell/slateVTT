// The DM's wall panel: trace walls, hang doors in them, erase what came out
// wrong.
//
// Three modes and an off switch. `wall` and `door` are the same tool tracing
// different kinds of wall; `erase` is a separate mode because the other two use
// the click to place corners. The draw tool differs here: a sweep is a drag, so
// a click is free to erase.
//
// This file holds the run being traced and the panel around it. Where a click
// landed, and what was under it, is input.ts's job, as for the draw tool, so
// coordinate math has one home.
//
// The run exists only on this client. It is sent whole on the last click and
// the server stores the segments between its corners; after that the polyline
// the DM drew doesn't exist anywhere. That lets one bad segment of a long
// trace be erased without redrawing the trace.

import type { Vec2 } from './coords.js';
import type { ClientMsg } from './protocol.js';
import type { Scene } from './scene.js';
import { shownWalls, showingStaged } from './scene.js';

export interface WallToolUi {
  root: HTMLElement;
  /** One button per mode, plus the off switch. */
  tools: HTMLElement;
  clear: HTMLButtonElement;
  hint: HTMLElement;
  readout: HTMLElement;
}

/** Tracing a wall, tracing a door, or taking a segment back off the map. */
export type WallMode = 'wall' | 'door' | 'erase';

export interface WallTool {
  /** The mode in hand, or null when the tool is put away and the pointer goes
   *  back to panning and dragging tokens. */
  readonly mode: WallMode | null;
  /** Corners placed so far, in image pixels. Empty unless a run is open. */
  readonly run: readonly Vec2[];
  /** Where the next corner would land: the far end of the rubber band. Null
   *  when the pointer is off the canvas or no run is open. */
  readonly aim: Vec2 | null;
  /** The wall a click would erase or swing, so the renderer can light it up. */
  readonly hovered: string | null;

  /** Another corner, already snapped (or left free with Alt) by input.ts. */
  place(at: Vec2): void;
  /** Where the pointer is now, or null when it has left the canvas. */
  point(at: Vec2 | null): void;
  /** Which wall is under the pointer, for the two modes where that means
   *  something. */
  hover(id: string | null): void;
  /** Which board this tool is editing, so input.ts can flag the commands it
   *  sends itself. Erasing and swinging are sent from input.ts, and both have
   *  to name the same slot the run would. */
  readonly staged: boolean;
  /** Ends the run and sends it: double-click, or Enter. */
  finish(): void;
  /** Drops the last corner. What Backspace means mid-trace. */
  undo(): void;
  /** Called on every `walls_changed` and `staged_changed`, once on Welcome, and
   *  whenever the board on screen changes slot. */
  update(scene: Scene): void;
  /** Puts the tool away, run and all. Escape, and closing the tab. */
  stop(): void;
}

/** Two corners closer than this are the same corner. It exists for the second
 *  click of a double-click, which lands on the corner the first one placed and
 *  would otherwise store a segment of no length. */
const SAME_CORNER_PX = 0.5;

/**
 * `hint` goes in the panel and `title` on the button. The hint is shorter
 * because the rail is 190 pixels wide and four panels tall, so the line under
 * the buttons has to stay one line. The full version is in the tooltip, and
 * the bar along the bottom of the screen repeats the gestures while a mode is
 * armed.
 */
const MODES: readonly { mode: WallMode; label: string; hint: string; title: string }[] = [
  {
    mode: 'wall',
    label: 'wall',
    hint: 'Click each corner. Double-click to finish.',
    title:
      'Click each corner. Double-click or Enter to finish, Backspace to take one back, Escape to abandon the run. Hold Alt to place off the grid corners.',
  },
  {
    mode: 'door',
    label: 'door',
    hint: 'Traced shut. Click a door to swing it.',
    title:
      'Trace a door the same way — it is traced shut. Clicking a door you have already hung opens or closes it instead of starting a run.',
  },
  {
    mode: 'erase',
    label: 'erase',
    hint: 'Click a segment to remove it.',
    title: 'Click a segment to take it off the map. One segment at a time, not the whole run.',
  },
];

export function createWallTool(
  ui: WallToolUi,
  send: (msg: ClientMsg) => void,
  /** Called when a mode is picked up here, so the draw tool can let go of the
   *  left button. input.ts can't resolve two tools armed at once (see
   *  `createDrawTool`). */
  onArm: () => void = () => {},
): WallTool {
  let mode: WallMode | null = null;
  let run: Vec2[] = [];
  let aim: Vec2 | null = null;
  let hovered: string | null = null;
  /** Kept for the readout only. The walls themselves live on the scene. */
  let walls: Scene['walls'] = [];
  /** Which board is on screen, and so which one everything here edits. Read off
   *  the scene in `update` instead of tracked as a mode of its own: the map
   *  panel decides preview, and this only has to agree with it. */
  let staged = false;

  const buttons = new Map<WallMode, HTMLButtonElement>();

  const showMode = (): void => {
    for (const [m, button] of buttons) {
      button.classList.toggle('is-on', m === mode);
      button.setAttribute('aria-pressed', String(m === mode));
    }
    // The body class tells the rest of the page the left button is taken, as
    // the draw tool's does. It also brightens the walls on the board: they are
    // drawn faintly the rest of the time, so the DM can see at a glance which
    // rooms are traced without arming anything.
    document.body.classList.toggle('tracing', mode !== null);
    // The idle line mentions the one thing here that needs no tool: the DM
    // swings doors mid-fight, and a hint that only described the modes would
    // suggest arming one first. Keep it to one line: the rail is tight enough
    // that one extra wrapped line pushes the panel off the bottom of the
    // screen.
    //
    // Over a preview it says so, because walls look identical on both boards,
    // and tracing the next map onto the one the table is playing on is an easy
    // mistake to make.
    ui.hint.textContent =
      mode === null
        ? staged
          ? 'Tracing the map being prepared. Click any door to swing it.'
          : 'Trace walls here. Click any door to swing it.'
        : (MODES.find((m) => m.mode === mode)?.hint ?? '');
  };

  const showReadout = (): void => {
    const doors = walls.filter((w) => w.door !== null).length;
    const segments = walls.length - doors;
    ui.readout.textContent =
      walls.length === 0
        ? 'nothing traced'
        : `${segments} ${segments === 1 ? 'wall' : 'walls'} · ${doors} ${doors === 1 ? 'door' : 'doors'}`;
  };

  /** Throws away the run without sending it. */
  const cancel = (): void => {
    run = [];
    aim = null;
  };

  for (const entry of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'wall-tool';
    button.textContent = entry.label;
    button.title = entry.title;
    button.addEventListener('click', () => {
      // A half-traced run belongs to the mode it was started in: switching from
      // walls to doors mid-trace would hang a door on the corners already
      // placed. Clicking the mode you are holding puts it down.
      cancel();
      mode = mode === entry.mode ? null : entry.mode;
      if (mode !== null) onArm();
      showMode();
    });
    buttons.set(entry.mode, button);
    ui.tools.append(button);
  }

  ui.clear.addEventListener('click', () => {
    // Names the board, because the live and staged boards are one click apart
    // and "this map" would be ambiguous.
    const which = staged ? 'the map being prepared' : 'the board';
    if (!window.confirm(`Erase every wall and door on ${which}?`)) return;
    send({ type: 'clear_walls', staged });
  });

  window.addEventListener('keydown', (e) => {
    if (mode === null) return;

    if (e.key === 'Escape') {
      // Two things to back out of, innermost first: a run in progress, then the
      // tool itself. Escaping out of both at once would make a slip while
      // tracing drop the tool as well as the run.
      if (run.length > 0) {
        cancel();
      } else {
        mode = null;
        showMode();
      }
      return;
    }
    if (run.length === 0) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      tool.finish();
    }
    if (e.key === 'Backspace') {
      // Otherwise the browser treats it as "go back" on a page with no form
      // focused, which loses the whole session rather than one corner.
      e.preventDefault();
      tool.undo();
    }
  });

  const tool: WallTool = {
    get mode() {
      return mode;
    },
    get run() {
      return run;
    },
    get aim() {
      return run.length === 0 ? null : aim;
    },
    get hovered() {
      return hovered;
    },
    get staged() {
      return staged;
    },

    place(at) {
      const last = run[run.length - 1];
      // The second click of a double-click lands where the first one did. It is
      // dropped here, not in `finish`, so any two clicks in one corner mean one
      // corner, which is also what a DM who clicked twice by accident meant.
      if (last !== undefined && Math.hypot(at.x - last.x, at.y - last.y) < SAME_CORNER_PX) {
        return;
      }
      run.push(at);
    },

    point(at) {
      aim = at;
    },

    hover(id) {
      hovered = id;
    },

    finish() {
      // One corner is a run that was started and never went anywhere. The
      // server refuses it; not sending it is how the DM's own client agrees.
      if (run.length >= 2) {
        send({
          type: 'add_walls',
          points: run.map((p) => ({ x: p.x, y: p.y })),
          door: mode === 'door',
          staged,
        });
      }
      cancel();
    },

    undo() {
      run.pop();
    },

    update(scene) {
      const nowStaged = showingStaged(scene);
      // The board on screen changed slot under a half-traced run, and the
      // corners already placed are pixels on the other image.
      if (nowStaged !== staged) cancel();
      staged = nowStaged;
      walls = shownWalls(scene);
      // A new map has swept the walls away, so a half-traced run belongs to a
      // map that is gone.
      if (walls.length === 0 && run.length > 0) cancel();
      showMode();
      showReadout();
    },

    stop() {
      cancel();
      mode = null;
      hovered = null;
      showMode();
    },
  };

  showMode();
  showReadout();
  // The rail decides whether this panel is on screen, since it is one of the
  // panels behind the tab strip. The draw tool unhides itself, being the one
  // panel that is always there.
  return tool;
}

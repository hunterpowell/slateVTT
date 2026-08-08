// The DM's wall panel: trace walls, hang doors in them, erase what came out
// wrong.
//
// Three modes and an off switch. `wall` and `door` are the same tool tracing
// different masonry; `erase` is the third because the other two have taken the
// only gesture a click could otherwise mean. That is the one place this differs
// from the draw tool, where a click erases *because* a sweep is a drag and a
// click is therefore free. Here a click is how a corner gets placed.
//
// What lives here is the run being traced and the panel around it. Where a click
// landed, and what was under it, is input.ts's — the same split the draw tool
// makes, and for the same reason: coordinate math has one home.
//
// The run is authoring, not state. It is sent whole on the last click and the
// server stores the segments between its corners; from the next frame on, the
// polyline the DM drew does not exist anywhere. That is what makes one bad
// segment of a long trace erasable without redrawing the trace.

import type { Vec2 } from './coords.js';
import type { ClientMsg } from './protocol.js';
import type { Scene } from './scene.js';

export interface WallToolUi {
  root: HTMLElement;
  /** One button per mode, plus the off switch. */
  tools: HTMLElement;
  clear: HTMLButtonElement;
  hint: HTMLElement;
  readout: HTMLElement;
}

/** Tracing masonry, tracing a door, or taking a segment back off the map. */
export type WallMode = 'wall' | 'door' | 'erase';

export interface WallTool {
  /** The mode in hand, or null when the tool is put away and the pointer goes
   *  back to panning and dragging tokens. */
  readonly mode: WallMode | null;
  /** Corners placed so far, in image pixels. Empty unless a run is open. */
  readonly run: readonly Vec2[];
  /** Where the next corner would land — the far end of the rubber band. Null
   *  when the pointer is off the canvas or no run is open. */
  readonly aim: Vec2 | null;
  /** The wall a click would erase or swing, so the renderer can light it up. */
  readonly hovered: string | null;

  /** Another corner, already snapped (or deliberately not) by input.ts. */
  place(at: Vec2): void;
  /** Where the pointer is now, or null when it has left the canvas. */
  point(at: Vec2 | null): void;
  /** Which wall is under the pointer, for the two modes where that means
   *  something. */
  hover(id: string | null): void;
  /** Ends the run and sends it: double-click, or Enter. */
  finish(): void;
  /** Drops the last corner. What Backspace means mid-trace. */
  undo(): void;
  /** Called on every `walls_changed`, and once on Welcome. */
  update(scene: Scene): void;
  /** Puts the tool away, run and all. Escape, and preview mode. */
  stop(): void;
}

/** Two corners closer than this are the same corner. It exists for the second
 *  click of a double-click, which lands on the corner the first one placed and
 *  would otherwise store a segment of no length. */
const SAME_CORNER_PX = 0.5;

/**
 * `hint` goes in the panel and `title` on the button, and they are different
 * lengths on purpose: the rail is 190 pixels wide and four panels tall, so the
 * line under the buttons has to stay a line. The full version is a tooltip away,
 * and the bar along the bottom of the screen repeats the gestures while a mode
 * is armed.
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
   *  left button. Two tools armed at once is not a state input.ts could
   *  resolve — see the same argument on `createDrawTool`. */
  onArm: () => void = () => {},
): WallTool {
  let mode: WallMode | null = null;
  let run: Vec2[] = [];
  let aim: Vec2 | null = null;
  let hovered: string | null = null;
  /** Kept for the readout alone — the walls themselves live on the scene. */
  let walls: Scene['walls'] = [];

  const buttons = new Map<WallMode, HTMLButtonElement>();

  const showMode = (): void => {
    for (const [m, button] of buttons) {
      button.classList.toggle('is-on', m === mode);
      button.setAttribute('aria-pressed', String(m === mode));
    }
    // The body class is what tells the rest of the page the left button is
    // spoken for, exactly as the draw tool's does. It is also what brightens the
    // walls on the board: they are drawn faintly the rest of the time, so the
    // DM can see at a glance which rooms are traced without arming anything.
    document.body.classList.toggle('tracing', mode !== null);
    // The idle line advertises the one thing here that needs no tool at all:
    // swinging a door is something the DM does mid-fight, and a panel that only
    // described its own modes would hide it behind arming one. It has to stay
    // about as long as the line it replaced — the rail is tight enough that one
    // extra wrapped line pushes the whole panel off the bottom of the screen.
    ui.hint.textContent =
      mode === null
        ? 'Trace walls here. Click any door to swing it.'
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
      // placed. Clicking the mode you are holding puts it down, which is the
      // fastest way back to dragging tokens.
      cancel();
      mode = mode === entry.mode ? null : entry.mode;
      if (mode !== null) onArm();
      showMode();
    });
    buttons.set(entry.mode, button);
    ui.tools.append(button);
  }

  ui.clear.addEventListener('click', () => {
    if (!window.confirm('Erase every wall and door on this map?')) return;
    send({ type: 'clear_walls' });
  });

  window.addEventListener('keydown', (e) => {
    if (mode === null) return;

    if (e.key === 'Escape') {
      // Two things to back out of, innermost first: a run in progress, then the
      // tool itself. Escaping straight out of both at once would lose a
      // forty-corner trace to a keypress meant to end the last segment.
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

    place(at) {
      const last = run[run.length - 1];
      // The second click of a double-click lands where the first one did. It is
      // dropped here rather than in `finish`, so that any two clicks in one
      // corner mean one corner — which is also what a DM who clicked twice by
      // accident meant.
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
        send({ type: 'add_walls', points: run.map((p) => ({ x: p.x, y: p.y })), door: mode === 'door' });
      }
      cancel();
    },

    undo() {
      run.pop();
    },

    update(scene) {
      walls = scene.walls;
      // A run whose segments have just been swept away by a new map is a run
      // about a dungeon that is gone.
      if (walls.length === 0 && run.length > 0) cancel();
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
  ui.root.hidden = false;
  return tool;
}

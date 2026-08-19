// The table panel: the settings that belong to the room rather than to a map, a
// token, or a person.
//
// It exists because of where its fields live. `show_names`, `diagonals` and
// `show_cursors` are `RoomState` fields, and the first two spent four milestones
// under the token panel's
// form — which describes one selected creature — with a rule drawn across the
// panel trying to say they were something else. Two comments in the markup
// explaining why a control sat where it did was the report. **A panel mirrors
// where its fields live**: `MapInfo` is the map tab, `Token` is the token tab,
// and room-wide state is this one.
//
// Named "table" and not "room" because `Lighting::Room` is a fog mode one tab
// over, and two meanings for one word in adjacent panels is worse than a
// slightly odd name.
//
// Every control here is DM-only to *set* and identical for everyone to hold,
// which is why the frames that carry them sit beside `FogChanged` rather than beside
// `WallsChanged` — who may set a thing is a permission, and what it says is not
// a secret. This panel arms nothing on the canvas, so the rail needs no `stop()`
// for it, and it is never inert, so its tab never greys.
//
// Players never see it. It is only built for a DM connection, and the server
// re-checks every command regardless.

import type { ClientMsg, Diagonals } from './protocol.js';
import type { Scene } from './scene.js';

export interface TableToolUi {
  root: HTMLElement;
  names: HTMLInputElement;
  diagonals: HTMLSelectElement;
  cursors: HTMLInputElement;
}

export interface TableTool {
  /** Called on Welcome and whenever any of the settings changes — which may have
   *  been this DM on another tab. */
  update(scene: Scene): void;
}

export function createTableTool(ui: TableToolUi, send: (msg: ClientMsg) => void): TableTool {
  // Sent rather than applied, which is the same bargain every other panel in
  // this rail makes: what is on screen moves when the server says so. The
  // control is put back by `update` below rather than by the click, so a refused
  // command leaves it saying what the room actually holds.
  ui.names.addEventListener('change', () => {
    send({ type: 'set_show_names', show: ui.names.checked });
  });

  // The same bargain, and the sharpest instance of the pattern in the project:
  // the server never counts a diagonal — there is no movement distance in the
  // crate at all — so the only thing the room is authoritative over here is
  // that six clients agree. That is also the whole argument against keeping it
  // in `localStorage`, which is where a client-only reading would want to live.
  //
  // The cast is safe because the two options are the only two in the markup, and
  // if it ever were not, the server refuses anything serde does not recognise —
  // which is the check that actually matters.
  ui.diagonals.addEventListener('change', () => {
    send({ type: 'set_diagonals', diagonals: ui.diagonals.value as Diagonals });
  });

  // The same bargain a third time, and the one control on this panel whose
  // effect is not only on screens: switching pointers off stops the server
  // relaying them and stops every client sending its own. That is why it is a
  // room setting rather than a `localStorage` preference like the initiative
  // panel's fold — how much clutter you want on your own board is nobody else's
  // business, and what the room is spending its wire on is everybody's.
  ui.cursors.addEventListener('change', () => {
    send({ type: 'set_show_cursors', show: ui.cursors.checked });
  });

  return {
    update(scene) {
      // Unconditionally: none of these is something the DM is halfway through
      // typing, so there is no edit here to eat, and each has to follow the room
      // whether the change came from this tab or another one.
      ui.names.checked = scene.showNames;
      ui.diagonals.value = scene.diagonals;
      ui.cursors.checked = scene.showCursors;
    },
  };
}

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
// a secret. It is never inert, so its tab never greys.
//
// **It arms nothing on the canvas and still owes a `stop()`.** The backdrop
// picker is a disclosure list, so what the rail closes on is a half-finished
// browse rather than a live tool — `LibraryList.close`'s own note calls that
// tidiness rather than a rule, and the map and token panels already do it.
//
// The backdrop is on *this* panel and not the map one, which is the same
// question `MapInfo` / `Token` / room-wide answers everywhere else: a backdrop
// is not a map. There is no grid on it, nothing stands on it, and the board it
// covers is still sitting there with its walls and its fog, which is exactly
// why putting one up costs the encounter nothing.
//
// Players never see it. It is only built for a DM connection, and the server
// re-checks every command regardless.

import { createLibraryList, type LibraryUi } from './library.js';
import type { ClientMsg, Diagonals } from './protocol.js';
import type { Scene } from './scene.js';

export interface TableToolUi {
  root: HTMLElement;
  names: HTMLInputElement;
  diagonals: HTMLSelectElement;
  cursors: HTMLInputElement;
  /** The backdrop picker's disclosure button and list. `root` above is the
   *  panel the widget dims while a pick is in flight. */
  backdrop: Pick<LibraryUi, 'button' | 'list' | 'file' | 'fileText'>;
  /** Takes the picture down. Hidden when there is not one up, because a button
   *  that would do nothing is a button that says something is up. */
  backdropClear: HTMLButtonElement;
}

export interface TableTool {
  /** Called on Welcome and whenever any of the settings changes — which may have
   *  been this DM on another tab. */
  update(scene: Scene): void;
  /** Closes the library list, so the tab reopens on the panel rather than
   *  mid-browse. Nothing on the canvas is armed; see the note at the top. */
  stop(): void;
}

export function createTableTool(
  ui: TableToolUi,
  dmSecret: string,
  send: (msg: ClientMsg) => void,
  report: (message: string) => void,
): TableTool {
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

  // The same bargain a fourth time, through the widget the map and token panels
  // already use. A pick has copied the file into the uploads directory by the
  // time this runs, so what goes on the wire is the URL it is served at —
  // byte-for-byte what an uploaded map or portrait would be, which is why
  // nothing downstream can tell a library pick from anything else.
  const library = createLibraryList(
    {
      root: ui.root,
      button: ui.backdrop.button,
      list: ui.backdrop.list,
      // The panel that had no upload of its own. It gets one because the widget
      // grew adding, not because anybody asked for a fourth upload button — and
      // the DM who wants tonight's campfire in the room no longer has to put it
      // in `backdrops/` by hand first.
      file: ui.backdrop.file,
      fileText: ui.backdrop.fileText,
    },
    dmSecret,
    'backdrops',
    (url) => send({ type: 'set_backdrop', url }),
    report,
  );

  // Null rather than an empty string, which is the same value the room holds
  // and the same one `shownBackdrop` answers with. There is no second command
  // and no "hidden" flag: the picture is either up or it is not.
  ui.backdropClear.addEventListener('click', () => {
    send({ type: 'set_backdrop', url: null });
  });

  return {
    update(scene) {
      // Unconditionally: none of these is something the DM is halfway through
      // typing, so there is no edit here to eat, and each has to follow the room
      // whether the change came from this tab or another one.
      ui.names.checked = scene.showNames;
      ui.diagonals.value = scene.diagonals;
      ui.cursors.checked = scene.showCursors;
      // Read off the room rather than remembered from the click, so the DM's
      // second tab agrees with their first — and so an undo that takes a
      // backdrop down is reflected here without a line of its own.
      ui.backdropClear.hidden = scene.backdrop === null;
    },
    stop() {
      library.close();
    },
  };
}

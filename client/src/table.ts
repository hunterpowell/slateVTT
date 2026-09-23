// The table panel: the settings that belong to the room, not to a map, a
// token, or a person.
//
// **A panel holds the controls for the struct its fields live on**: `MapInfo`
// is the map tab, `Token` is the token tab, and room-wide `RoomState` fields
// are this one. `show_names`, `diagonals`, `show_cursors` and `show_dm_cursor`
// are `RoomState` fields. Don't move them back under the token panel's form,
// which describes one selected creature.
//
// Named "table" and not "room" because `Lighting::Room` is a fog mode one tab
// over, and one word with two meanings in adjacent panels is worse than a
// slightly odd name.
//
// Every control here is DM-only to set and the same for everyone to hold, so
// the frames that carry them are unfiltered, like `FogChanged` and unlike
// `WallsChanged`. Who may set a thing is a permission question; its value
// isn't a secret. The panel is never inert, so its tab never greys.
//
// It arms nothing on the canvas and still has a `stop()`. The backdrop and
// track pickers are disclosure lists, and `stop` closes a half-finished
// browse. `LibraryList.close` calls that tidiness, not a rule, and the map and
// token panels do the same.
//
// The backdrop is on this panel and not the map one because a backdrop isn't a
// map. It has no grid, nothing stands on it, and the board it covers keeps its
// walls and fog, which is why putting one up costs the encounter nothing.
//
// Players never see this panel. It is only built for a DM connection, and the
// server re-checks every command regardless.

import { createLibraryList, type LibraryUi } from './library.js';
import type { ClientMsg, Diagonals } from './protocol.js';
import type { Scene } from './scene.js';

export interface TableToolUi {
  root: HTMLElement;
  names: HTMLInputElement;
  diagonals: HTMLSelectElement;
  cursors: HTMLInputElement;
  /** Just the DM's pointer. A separate checkbox, not a third state on the one
   *  above: "everybody's pointers" and "the DM's pointer" are two questions,
   *  and a select answering both would make the common case (all on) cost
   *  reading a menu. */
  dmCursor: HTMLInputElement;
  /** The backdrop picker's disclosure button and list. `root` above is the
   *  panel the widget dims while a pick is in flight. */
  backdrop: Pick<LibraryUi, 'button' | 'list' | 'file' | 'fileText'>;
  /** Takes the picture down. Hidden when none is up, because the button being
   *  visible tells the DM that something is up. */
  backdropClear: HTMLButtonElement;
  /** The track picker's disclosure button and list. Same as `backdrop`, over
   *  the `tracks` folder, the only library that doesn't hold pictures. */
  track: Pick<LibraryUi, 'button' | 'list' | 'file' | 'fileText'>;
  /** Stops the music. Hidden when there is none, like `backdropClear`. */
  trackClear: HTMLButtonElement;
}

export interface TableTool {
  /** Called on Welcome and whenever any of the settings changes, possibly from
   *  this DM on another tab. */
  update(scene: Scene): void;
  /** Closes the library lists, so the tab reopens on the panel and not
   *  mid-browse. Nothing on the canvas is armed; see the note at the top. */
  stop(): void;
}

export function createTableTool(
  ui: TableToolUi,
  dmSecret: string,
  send: (msg: ClientMsg) => void,
  report: (message: string) => void,
): TableTool {
  // Sent, not applied, as in every other panel in this rail: what is on screen
  // changes when the server says so. The control is set by `update` below, not
  // by the click, so a refused command leaves it showing what the room holds.
  ui.names.addEventListener('change', () => {
    send({ type: 'set_show_names', show: ui.names.checked });
  });

  // Also sent, not applied. The server never counts a diagonal (there is no
  // movement distance in the crate), so the room is only here to make six
  // clients agree. That is why it isn't in `localStorage`, though only clients
  // read it.
  //
  // The cast is safe because the markup has only the two options. If it ever
  // didn't, the server refuses anything serde doesn't recognise, and that is
  // the check that matters.
  ui.diagonals.addEventListener('change', () => {
    send({ type: 'set_diagonals', diagonals: ui.diagonals.value as Diagonals });
  });

  // Also sent, not applied. This is the one control here whose effect isn't
  // only on screens: switching pointers off stops the server relaying them and
  // stops every client sending its own. That is why it is a room setting and
  // not a `localStorage` preference like the initiative panel's fold. Clutter
  // on your own board concerns only you; traffic on the room's socket concerns
  // everyone.
  ui.cursors.addEventListener('change', () => {
    send({ type: 'set_show_cursors', show: ui.cursors.checked });
  });

  // Also sent, not applied. It affects only the other six screens: the DM's
  // own pointer is drawn by their operating system either way. It is a room
  // setting because what the table can see belongs to the room, not to one
  // browser. Unlike the switch above, it changes nothing about what any client
  // sends, because one pointer in seven isn't significant traffic.
  ui.dmCursor.addEventListener('change', () => {
    send({ type: 'set_show_dm_cursor', show: ui.dmCursor.checked });
  });

  // Also sent, not applied, through the widget the map and token panels use.
  // By the time this runs a pick has copied the file into the uploads
  // directory, so what goes on the wire is the URL it is served at. That is the
  // same kind of URL as an uploaded map or portrait, so nothing downstream can
  // tell a library pick from anything else.
  const library = createLibraryList(
    {
      root: ui.root,
      button: ui.backdrop.button,
      list: ui.backdrop.list,
      // The shared widget handles adding files, so the DM can upload a
      // backdrop here instead of copying it into `backdrops/` by hand.
      file: ui.backdrop.file,
      fileText: ui.backdrop.fileText,
    },
    dmSecret,
    'backdrops',
    (url) => send({ type: 'set_backdrop', url }),
    report,
  );

  // Null, not an empty string: the same value the room holds and
  // `shownBackdrop` returns. There is no second command and no "hidden" flag;
  // the picture is either up or it isn't.
  ui.backdropClear.addEventListener('click', () => {
    send({ type: 'set_backdrop', url: null });
  });

  // The same widget over the one library that isn't images. The pick has
  // already copied the file into uploads and the URL goes on the wire, as
  // above. Playback is in `sound.ts`, not on this panel.
  const tracks = createLibraryList(
    {
      root: ui.root,
      button: ui.track.button,
      list: ui.track.list,
      file: ui.track.file,
      fileText: ui.track.fileText,
    },
    dmSecret,
    'tracks',
    (url) => send({ type: 'set_audio', url }),
    report,
  );

  // Null, not an empty string, as above. The room is either playing something
  // or it isn't; there is no paused state for a second command to name.
  ui.trackClear.addEventListener('click', () => {
    send({ type: 'set_audio', url: null });
  });

  return {
    update(scene) {
      // Unconditionally: none of these is something the DM could be halfway
      // through typing, so there is no edit to overwrite, and each has to
      // follow the room whether the change came from this tab or another.
      ui.names.checked = scene.showNames;
      ui.diagonals.value = scene.diagonals;
      ui.cursors.checked = scene.showCursors;
      ui.dmCursor.checked = scene.showDmCursor;
      // Greyed while every pointer is off, as the fog panel does. The value is
      // still the room's, and hiding the checkbox would make it look like
      // switching pointers back on had invented a value for it. This is a
      // checkbox, not a tab, so the rail's inert-tab rule doesn't apply as
      // such, but the reason is the same: don't show a control as live when
      // it does nothing.
      ui.dmCursor.disabled = !scene.showCursors;
      // Read off the room, not remembered from the click, so the DM's second
      // tab agrees with their first, and an undo that takes a backdrop down
      // shows here without any extra code.
      ui.backdropClear.hidden = scene.backdrop === null;
      // Read off the room for the same reason.
      ui.trackClear.hidden = scene.audio === null;
    },
    stop() {
      library.close();
      tracks.close();
    },
  };
}

import type { Camera, Rect, Vec2 } from './coords.js';
import { gridToWorld, playRect, screenToWorld, worldToGrid } from './coords.js';
import type { Chat } from './chat.js';
import { createChat } from './chat.js';
import type { Dock } from './dock.js';
import { createDock } from './dock.js';
import type { DrawTool } from './drawtool.js';
import { createDrawTool } from './drawtool.js';
import type { Fog } from './fog.js';
import { fogFromWire } from './fog.js';
import type { FogTool } from './fogtool.js';
import { createFogTool } from './fogtool.js';
import { createGestures } from './gestures.js';
import type { Identity } from './identity.js';
import {
  ANONYMOUS,
  forgetPlayerId,
  forgetRoom,
  readStoredPlayerId,
  readStoredRoom,
  storePlayerId,
  storeRoom,
  takeDmSecret,
  takeRoomFromUrl,
} from './identity.js';
import { attachInput } from './input.js';
import { asTable } from './mirror.js';
import type { MapTool } from './maptool.js';
import { createMapTool } from './maptool.js';
import { createRail } from './rail.js';
import { soloSight } from './solo.js';
import type { Sound } from './sound.js';
import { createSound } from './sound.js';
import type { TableTool } from './table.js';
import { createTableTool } from './table.js';
import type { Net } from './net.js';
import { connect } from './net.js';
import type { Notes } from './notes.js';
import { createNotes } from './notes.js';
import { overridesFromWire } from './overrides.js';
import type { Panel } from './panel.js';
import { createPanel } from './panel.js';
import { createPicker } from './picker.js';
import type { RoomChoice } from './rooms.js';
import { createRoomPicker, fetchRooms } from './rooms.js';
import type { Cursors } from './cursors.js';
import { createCursors } from './cursors.js';
import type { Pings } from './pings.js';
import { colourOf, createPings } from './pings.js';
import type { Presence } from './presence.js';
import { createPresence, ownerOf } from './presence.js';
import type {
  ClientMsg,
  Initiative,
  RosterEntry,
  TokenMoved,
  WireToken,
} from './protocol.js';
import type { Viewport } from './render.js';
import { drawBackdrop, render } from './render.js';
import type { Rulers } from './ruler.js';
import { createRulers } from './ruler.js';
import type { Board, Scene, Token } from './scene.js';
import {
  adoptView,
  boardFromWire,
  stagedFromWire,
  removeToken,
  sceneFromView,
  shownBackdrop,
  shownBoard,
  shownPos,
  upsertToken,
} from './scene.js';
import type { Sketches } from './shapes.js';
import { createSketches, shapeFromWire } from './shapes.js';
import type { TokenTool } from './tokens.js';
import { createTokenTool } from './tokens.js';
import type { Turn } from './turn.js';
import { createTurn } from './turn.js';
import type { Undo } from './undo.js';
import { createUndo, typingIn } from './undo.js';
import type { Wall } from './walls.js';
import { wallFromWire } from './walls.js';
import type { WallTool } from './walltool.js';
import { createWallTool } from './walltool.js';

interface Ui {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  hud: HTMLElement;
  /** In the bottom-right corner, for everyone: the camera is per client, so
   *  this is too. */
  fitBoard: HTMLButtonElement;
  /** The gesture hint beside it, which is also the mouse/trackpad switch. */
  gestureHint: HTMLButtonElement;
  banner: HTMLElement;
  picker: HTMLElement;
  roomPicker: HTMLElement;
  whoami: HTMLElement;
  whoamiName: HTMLElement;
  whoamiSwitch: HTMLButtonElement;
  panel: {
    root: HTMLElement;
    round: HTMLElement;
    list: HTMLElement;
    controls: HTMLElement;
    form: HTMLFormElement;
    tokenSelect: HTMLSelectElement;
    valueInput: HTMLInputElement;
    clear: HTMLButtonElement;
    next: HTMLButtonElement;
    previous: HTMLButtonElement;
    collapse: HTMLButtonElement;
  };
  rail: {
    tabs: HTMLElement;
  };
  dock: {
    root: HTMLElement;
    tabs: HTMLElement;
  };
  presence: {
    root: HTMLElement;
    chips: HTMLElement;
    swatches: HTMLElement;
  };
  turn: {
    toast: HTMLElement;
  };
  chat: {
    root: HTMLElement;
    log: HTMLElement;
    destinations: HTMLElement;
    dice: HTMLElement;
    form: HTMLFormElement;
    text: HTMLInputElement;
    toast: HTMLElement;
  };
  sound: {
    root: HTMLElement;
    player: HTMLAudioElement;
    toggle: HTMLButtonElement;
    volume: HTMLInputElement;
    now: HTMLElement;
    blocked: HTMLElement;
  };
  notes: {
    root: HTMLElement;
    text: HTMLTextAreaElement;
  };
  undo: {
    root: HTMLElement;
    button: HTMLButtonElement;
  };
  maptool: {
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
  };
  drawtool: {
    root: HTMLElement;
    tools: HTMLElement;
    swatches: HTMLElement;
    clear: HTMLButtonElement;
    hint: HTMLElement;
  };
  walltool: {
    root: HTMLElement;
    tools: HTMLElement;
    clear: HTMLButtonElement;
    hint: HTMLElement;
    readout: HTMLElement;
  };
  fogtool: {
    root: HTMLElement;
    on: HTMLInputElement;
    lighting: HTMLElement;
    vision: HTMLInputElement;
    visionDown: HTMLButtonElement;
    visionUp: HTMLButtonElement;
    hint: HTMLElement;
    brushes: HTMLElement;
    gesture: HTMLButtonElement;
    clear: HTMLButtonElement;
    sight: HTMLButtonElement;
    view: HTMLButtonElement;
  };
  tokentool: {
    root: HTMLElement;
    head: HTMLElement;
    name: HTMLInputElement;
    size: HTMLSelectElement;
    owner: HTMLSelectElement;
    hidden: HTMLInputElement;
    hp: HTMLInputElement;
    hpMax: HTMLInputElement;
    light: HTMLInputElement;
    art: HTMLInputElement;
    artText: HTMLElement;
    artPreview: HTMLElement;
    artClear: HTMLButtonElement;
    library: HTMLButtonElement;
    libraryList: HTMLElement;
    markers: HTMLElement;
    save: HTMLButtonElement;
    duplicate: HTMLButtonElement;
    remove: HTMLButtonElement;
    fresh: HTMLButtonElement;
    hint: HTMLElement;
  };
  tabletool: {
    root: HTMLElement;
    names: HTMLInputElement;
    diagonals: HTMLSelectElement;
    cursors: HTMLInputElement;
    dmCursor: HTMLInputElement;
    backdrop: {
      button: HTMLButtonElement;
      list: HTMLElement;
      file: HTMLInputElement;
      fileText: HTMLElement;
    };
    backdropClear: HTMLButtonElement;
    track: {
      button: HTMLButtonElement;
      list: HTMLElement;
      file: HTMLInputElement;
      fileText: HTMLElement;
    };
    trackClear: HTMLButtonElement;
    roster: {
      list: HTMLElement;
      name: HTMLInputElement;
      add: HTMLButtonElement;
    };
  };
}

/** Everything main.ts needs from the document, or a clear error naming what is missing. */
function findUi(): Ui {
  const need = <T extends Element>(selector: string): T => {
    const found = document.querySelector<T>(selector);
    if (found === null) throw new Error(`index.html is missing ${selector}`);
    return found;
  };

  const canvas = need<HTMLCanvasElement>('#stage');
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable');

  return {
    canvas,
    ctx,
    hud: need('#hud'),
    fitBoard: need<HTMLButtonElement>('#fit-board'),
    gestureHint: need<HTMLButtonElement>('#hint'),
    banner: need('#banner'),
    picker: need('#picker'),
    roomPicker: need('#room-picker'),
    whoami: need('#whoami'),
    whoamiName: need('#whoami-name'),
    whoamiSwitch: need<HTMLButtonElement>('#whoami-switch'),
    panel: {
      root: need('#initiative'),
      round: need('#init-round'),
      list: need('#init-list'),
      controls: need('#init-controls'),
      form: need<HTMLFormElement>('#init-add'),
      tokenSelect: need<HTMLSelectElement>('#init-token'),
      valueInput: need<HTMLInputElement>('#init-value'),
      clear: need<HTMLButtonElement>('#init-clear'),
      next: need<HTMLButtonElement>('#init-next'),
      previous: need<HTMLButtonElement>('#init-previous'),
      collapse: need<HTMLButtonElement>('#init-collapse'),
    },
    rail: {
      tabs: need('#rail-tabs'),
    },
    dock: {
      root: need('#dock'),
      tabs: need('#dock-tabs'),
    },
    presence: {
      root: need('#presence'),
      chips: need('#presence-chips'),
      swatches: need('#presence-swatches'),
    },
    turn: {
      toast: need('#turn-toast'),
    },
    chat: {
      root: need('#chat'),
      log: need('#chat-log'),
      destinations: need('#chat-to'),
      dice: need('#chat-dice'),
      form: need<HTMLFormElement>('#chat-form'),
      text: need<HTMLInputElement>('#chat-text'),
      toast: need('#chat-toast'),
    },
    sound: {
      root: need('#sound'),
      player: need<HTMLAudioElement>('#sound-player'),
      toggle: need<HTMLButtonElement>('#sound-toggle'),
      volume: need<HTMLInputElement>('#sound-volume'),
      now: need('#sound-now'),
      blocked: need('#sound-blocked'),
    },
    notes: {
      root: need('#notes'),
      text: need<HTMLTextAreaElement>('#notes-text'),
    },
    undo: {
      root: need('#undo'),
      button: need<HTMLButtonElement>('#undo-button'),
    },
    maptool: {
      root: need('#maptool'),
      head: need('#map-head'),
      live: need<HTMLButtonElement>('#map-slot-live'),
      next: need<HTMLButtonElement>('#map-slot-next'),
      stagedRow: need('#map-staged-row'),
      stagedNote: need('#map-staged-note'),
      promote: need<HTMLButtonElement>('#map-promote'),
      discard: need<HTMLButtonElement>('#map-discard'),
      file: need<HTMLInputElement>('#map-file'),
      uploadText: need('#map-upload-text'),
      library: need<HTMLButtonElement>('#map-library'),
      libraryList: need('#map-library-list'),
      calibrate: need<HTMLButtonElement>('#map-calibrate'),
      cellsRow: need('#map-cells-row'),
      shape: need<HTMLSelectElement>('#map-shape'),
      cells: need<HTMLInputElement>('#map-cells'),
      cellsDown: need<HTMLButtonElement>('#map-cells-down'),
      cellsUp: need<HTMLButtonElement>('#map-cells-up'),
      wholeMap: need<HTMLButtonElement>('#map-whole'),
      hint: need('#map-hint'),
      applyRow: need('#map-apply-row'),
      apply: need<HTMLButtonElement>('#map-apply'),
      cancel: need<HTMLButtonElement>('#map-cancel'),
      color: need<HTMLInputElement>('#map-color'),
      alpha: need<HTMLInputElement>('#map-alpha'),
      alphaLabel: need('#map-alpha-label'),
      readout: need('#map-readout'),
    },
    drawtool: {
      root: need('#drawtool'),
      tools: need('#draw-tools'),
      swatches: need('#draw-swatches'),
      clear: need<HTMLButtonElement>('#draw-clear'),
      hint: need('#draw-hint'),
    },
    walltool: {
      root: need('#walltool'),
      tools: need('#wall-tools'),
      clear: need<HTMLButtonElement>('#wall-clear'),
      hint: need('#wall-hint'),
      readout: need('#wall-readout'),
    },
    fogtool: {
      root: need('#fogtool'),
      on: need<HTMLInputElement>('#fog-on'),
      lighting: need('#fog-lighting'),
      vision: need<HTMLInputElement>('#fog-vision'),
      visionDown: need<HTMLButtonElement>('#fog-vision-down'),
      visionUp: need<HTMLButtonElement>('#fog-vision-up'),
      hint: need('#fog-hint'),
      brushes: need('#fog-brushes'),
      gesture: need<HTMLButtonElement>('#fog-gesture'),
      clear: need<HTMLButtonElement>('#fog-clear'),
      sight: need<HTMLButtonElement>('#fog-sight'),
      view: need<HTMLButtonElement>('#fog-view'),
    },
    tokentool: {
      root: need('#tokentool'),
      head: need('#token-head'),
      name: need<HTMLInputElement>('#token-name'),
      size: need<HTMLSelectElement>('#token-size'),
      owner: need<HTMLSelectElement>('#token-owner'),
      hidden: need<HTMLInputElement>('#token-hidden'),
      hp: need<HTMLInputElement>('#token-hp'),
      hpMax: need<HTMLInputElement>('#token-hp-max'),
      light: need<HTMLInputElement>('#token-light'),
      art: need<HTMLInputElement>('#token-art'),
      artText: need('#token-art-text'),
      artPreview: need('#token-art-preview'),
      artClear: need<HTMLButtonElement>('#token-art-clear'),
      library: need<HTMLButtonElement>('#token-library'),
      libraryList: need('#token-library-list'),
      markers: need('#token-markers'),
      save: need<HTMLButtonElement>('#token-save'),
      duplicate: need<HTMLButtonElement>('#token-duplicate'),
      remove: need<HTMLButtonElement>('#token-delete'),
      fresh: need<HTMLButtonElement>('#token-new'),
      hint: need('#token-hint'),
    },
    tabletool: {
      root: need('#tabletool'),
      names: need<HTMLInputElement>('#table-names'),
      diagonals: need<HTMLSelectElement>('#table-diagonals'),
      cursors: need<HTMLInputElement>('#table-cursors'),
      dmCursor: need<HTMLInputElement>('#table-dm-cursor'),
      backdrop: {
        button: need<HTMLButtonElement>('#table-backdrop'),
        list: need('#table-backdrop-list'),
        file: need<HTMLInputElement>('#table-backdrop-file'),
        fileText: need('#table-backdrop-upload-text'),
      },
      backdropClear: need<HTMLButtonElement>('#table-backdrop-clear'),
      track: {
        button: need<HTMLButtonElement>('#table-track'),
        list: need('#table-track-list'),
        file: need<HTMLInputElement>('#table-track-file'),
        fileText: need('#table-track-upload-text'),
      },
      trackClear: need<HTMLButtonElement>('#table-track-clear'),
      roster: {
        list: need('#table-roster'),
        name: need<HTMLInputElement>('#table-roster-name'),
        add: need<HTMLButtonElement>('#table-roster-add'),
      },
    },
  };
}

/** Live room state. `start` holds this object and reads through it every frame. */
interface Room {
  scene: Scene;
  initiative: Initiative;
}

/**
 * Works out which room this browser is opening, then hands over to `boot`.
 *
 * Nothing after this function knows there is more than one room: `boot` takes
 * the room as an argument and never asks again. The choice is made here because
 * a socket belongs to one room from the moment it opens, so it has to be
 * settled before `connect`, and the list of rooms comes over HTTP.
 *
 * Three ways to arrive, in order: a `?room=` in the link, the room this browser
 * was last in, or the picker. The first two are checked against the list, not
 * trusted, so a stale bookmark or a renamed room falls back to the picker
 * instead of a socket the server 404s.
 */
async function chooseRoom(): Promise<void> {
  const ui = findUi();

  let rooms: RoomChoice[];
  try {
    rooms = await fetchRooms();
  } catch (err) {
    // There is no room to connect to and nothing to show, so this is the one
    // failure the page cannot recover from.
    console.error(err);
    ui.banner.textContent = 'could not reach the server — refresh to try again';
    ui.banner.hidden = false;
    return;
  }

  const known = (id: string | null): RoomChoice | undefined =>
    id === null ? undefined : rooms.find((candidate) => candidate.id === id);

  // A server with one room has nothing to pick between, so it is picked. A
  // second site is usually one room (see `RoomDef::site`), and a one-button
  // picker in front of every first visit would only be a click to get past.
  const alone = rooms.length === 1 ? rooms[0] : undefined;
  const chosen = known(takeRoomFromUrl()) ?? known(readStoredRoom()) ?? alone;
  if (chosen !== undefined) {
    // A link that named a room replaces the remembered one; a remembered one
    // is written back unchanged, which is harmless.
    storeRoom(chosen.id);
    boot(ui, chosen, alone !== undefined);
    return;
  }

  const roomPicker = createRoomPicker(ui.roomPicker, (roomId) => {
    const picked = known(roomId);
    if (picked === undefined) return; // not offered; nothing to do
    storeRoom(picked.id);
    roomPicker.hide();
    boot(ui, picked, false);
  });
  roomPicker.show(rooms);
}

/**
 * `alone` is whether this is the server's only room, which hides the DM's
 * switch button: with nothing to switch to, it would reload into the same room.
 */
function boot(ui: Ui, choice: RoomChoice, alone: boolean): void {
  // Read and strip the DM secret before anything else can screenshot the URL.
  // A reload comes back through this with no `?dm=` and reads the secret from
  // `localStorage`, so the DM comes back as the DM after a dropped socket.
  const dmSecret = takeDmSecret();

  let room: Room | null = null;
  let panel: Panel | null = null;
  let mapTool: MapTool | null = null;
  let tokenTool: TokenTool | null = null;
  let stage: Stage | null = null;
  let drawTool: DrawTool | null = null;
  let wallTool: WallTool | null = null;
  let fogTool: FogTool | null = null;
  let tableTool: TableTool | null = null;
  // Built on every connection, unlike everything above them: none of the
  // dock's panels is the DM's.
  let chat: Chat | null = null;
  let notes: Notes | null = null;
  let dock: Dock | null = null;
  let sound: Sound | null = null;
  // Everybody's too, and built before the chat panel because that panel reads
  // it: who is connected decides which destination chips are dimmed, and what
  // everyone picked decides what colour a line is written in.
  let presence: Presence | null = null;
  // Everybody's: whose turn it is is not a secret.
  let turn: Turn | null = null;
  // DM-only, and optional-chained like the DM's tools: a player has no undo
  // ring, so the server sends them no label.
  let undo: Undo | null = null;
  let identity: Identity = ANONYMOUS;
  // The cast, from `Welcome`. **One array, changed in place** by
  // `roster_changed`, because the presence strip, the chat, the draw tool, the
  // token panel, the table tab and the renderer each captured it when they were
  // built. Replacing it would leave all six reading the old one, which is
  // `adoptView`'s reason for changing the scene in place.
  let roster: RosterEntry[] | null = null;
  // Outlives any one drag and is fed from both sides: our own pointer in
  // input.ts, and everyone else's drag frames below.
  const rulers = createRulers();
  // The same for sweeps: ours goes in from input.ts, everyone else's from the
  // frames below.
  const sketches = createSketches();
  // And for the pointers, except that this one is fed only from the frames.
  // Our own pointer is the system cursor, so nothing ever puts ours in here
  // and it needs no identity.
  const cursors = createCursors();
  // And for the rings, except that this one can't be built until Welcome,
  // because it has to know which ring is ours.
  let pings: Pings | null = null;

  const picker = createPicker(ui.picker, (playerId) => {
    // Not stored yet: only a Welcome proves the server accepted the claim.
    net.send({ type: 'hello', dm_secret: null, player_id: playerId });
  });

  ui.whoamiSwitch.addEventListener('click', () => {
    // Forget both, room first, because the room decides which slots exist:
    // asking which character you are without asking which room you are in
    // offers a cast you may not want. It reloads into the room picker and then
    // the character picker, the same sequence as a first visit.
    //
    // For the DM it is the room alone: they hold no slot, so there is nothing
    // else to forget. The secret is untouched either way (this switches
    // campaign, it doesn't leave the DM seat), and the reload comes back
    // through `takeDmSecret` as the DM.
    if (!identity.isDm) forgetPlayerId(choice.id);
    forgetRoom();
    // The link's own `?room=` would override the forgetting and put us straight
    // back where we were, so remove it too.
    const url = new URL(location.href);
    url.searchParams.delete('room');
    location.replace(`${url.pathname}${url.search}${url.hash}`);
  });

  // Both no-ops until a board exists, like lookAt: the stage owns the camera
  // and it is not built until Welcome.
  ui.fitBoard.addEventListener('click', () => stage?.fit());

  // A global key, so it checks typingIn: Home is start-of-line inside the chat
  // box and the initiative value field, and the board shouldn't jump while
  // somebody is halfway through a whisper.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Home') return;
    if (typingIn(e.target)) return;
    e.preventDefault();
    stage?.fit();
  });

  /**
   * Everything that reads the token list, once that list has changed. The
   * initiative panel names its rows from it, and the DM's token panel may have
   * been editing a token that no longer exists.
   */
  const afterTokens = (current: Room): void => {
    panel?.update(current.initiative, current.scene);
    tokenTool?.update(current.scene);
  };

  /**
   * Fetches the image for whichever board is on screen now, if that changed.
   *
   * `wasShowing` is the URL that was on screen before the delta landed, which is
   * the only way to tell a change the DM can see from one they cannot: a promote
   * replaces the live map while they are looking at the staged one, and there is
   * nothing to reload until the preview ends.
   *
   * A new image also means the grid inherited from the last one is meaningless,
   * so the DM is asked to size it, but only once it has loaded and its
   * dimensions are known, and only if it is the map they are looking at.
   */
  const afterBoardChanged = (wasShowing: string, newImage: boolean): void => {
    if (room === null || shownBoard(room.scene).mapUrl === wasShowing) return;
    stage?.reloadMap(newImage ? () => mapTool?.proposeWholeMap() : undefined);
  };

  const net: Net = connect(choice.id, {
    onOpen: () => {
      // A DM link wins over any remembered slot: the DM may well have played
      // as a character in this browser before.
      net.send({
        type: 'hello',
        dm_secret: dmSecret,
        player_id: dmSecret === null ? readStoredPlayerId(choice.id) : null,
      });
    },

    onChooseIdentity: (roster) => picker.show(roster),

    onWelcome: (welcome) => {
      picker.hide();
      identity = { isDm: welcome.is_dm, playerId: welcome.player_id };
      if (welcome.player_id !== null) storePlayerId(choice.id, welcome.player_id);
      roster = welcome.roster;
      showWhoami(ui, identity, choice, welcome.state.tokens, alone);

      // Built here and not beside the rulers, because it needs to know who we
      // are: every ring it holds is attributed, ours included.
      pings = createPings(
        identity.playerId === null
          ? { kind: 'dm' }
          : { kind: 'player', id: identity.playerId },
      );

      // One Welcome per connection (identity cannot change once set), so this
      // runs once. Assigned synchronously so a delta arriving straight after
      // Welcome cannot land in a gap where the room does not exist yet.
      room = {
        scene: sceneFromView(welcome.state, identity.isDm),
        initiative: welcome.state.initiative,
      };
      panel = createPanel(
        ui.panel,
        identity,
        (msg) => net.send(msg),
        // Clicking a row looks at that creature. Read lazily off the stage,
        // which does not exist yet at this point: the board is built after the
        // panel, and it is the only thing holding a camera.
        (token) => stage?.lookAt(token),
      );
      panel.update(room.initiative, room.scene);

      // Built for everyone, unlike the DM's panels below. Anyone may draw; the
      // only thing that differs by identity here is the clear-all button.
      drawTool = createDrawTool(
        ui.drawtool,
        identity.isDm,
        (msg) => net.send(msg),
        // Whose line it is, for the measure tool. Read lazily like the panel's
        // `lookAt` above: presence is built a few lines below and owns the live
        // colour table, so a player changing colour changes the next line they
        // measure. Before it exists nobody has picked anything, which is what
        // an empty table means.
        () => colourOf(ownerOf(identity), welcome.roster, presence?.colours ?? {}),
        () => wallTool?.stop(),
      );

      // Before the chat panel, which reads it. Everybody's, like the dock's
      // panels and unlike the rail's: who is connected is not secret, and
      // everyone has to see everyone's colour. The DM's copy lacks only the
      // colour control, since their hue is not one of the six.
      presence = createPresence(
        ui.presence,
        identity,
        welcome.roster,
        welcome.state.here,
        welcome.state.colours,
        (msg) => net.send(msg),
      );

      // Seeded from the join and never fired by it: adopting state is not a
      // turn change, and a refresh mid-combat shouldn't announce whoever was
      // already up.
      turn = createTurn(ui.turn, identity, welcome.state.initiative);

      // Built for everyone, like the draw tool above and unlike the rail
      // below. The log in the Welcome already holds only what this client is
      // party to: a whisper between two other people is never sent.
      chat = createChat(
        ui.chat,
        identity,
        welcome.roster,
        welcome.state.chat,
        presence,
        (msg) => net.send(msg),
        // The dock does not exist yet here and does by the time a line can
        // arrive, so this reads it lazily.
        (count) => dock?.badge('chat', count),
      );
      // Everybody has one, and it is the only state no other client is sent:
      // the room sends this client its own box and has no way to send it
      // another. No identity branch, because the DM's scratchpad is the same
      // as anybody's.
      notes = createNotes(ui.notes, welcome.state.notes, (msg) => net.send(msg));

      // Built for every connection, the DM's included: everyone hears the same
      // track, and nothing about it differs by identity. `update` is idempotent
      // on the URL, so passing it the joined state here is harmless even when
      // nothing is playing.
      sound = createSound(ui.sound);
      sound.update(welcome.state.audio);

      dock = createDock(ui.dock, [
        {
          tab: 'chat',
          label: 'chat',
          root: ui.chat.root,
          // No `stop` anywhere in this list, unlike the rail's: nothing in the
          // dock arms the canvas. A panel here needs a hook for when it comes
          // on screen instead, where the log catches up and the unread count
          // clears.
          opened: () => chat?.opened(),
        },
        {
          tab: 'notes',
          label: 'notes',
          root: ui.notes.root,
          // Focus, and nothing else to catch up on: this panel has no unread
          // state, because nothing ever arrives in it that this client did not
          // type.
          opened: () => notes?.opened(),
        },
        {
          tab: 'sound',
          label: 'sound',
          root: ui.sound.root,
          // Last on the strip and first in the document. This is the panel
          // used least in an evening, so it goes at the far end of the strip
          // and at the far end of the stack from the chat box.
          //
          // No `opened` and no badge. Nothing arrives in here: the three
          // controls show state that is correct whether anybody is looking at
          // it or not.
        },
      ]);

      // Built for the DM alone and before the rail, because it sits above the
      // strip, not on it: undo is not an editing panel, it is used in the
      // middle of using one.
      if (identity.isDm) {
        undo = createUndo(ui.undo, (msg) => net.send(msg));
        undo.update(welcome.state.undo);
      }

      // `isDm` is only ever true because we sent a secret that the server
      // accepted, so we have it. Uploads need it, so check it here for the
      // compiler.
      if (identity.isDm && dmSecret !== null) {
        mapTool = createMapTool(
          ui.maptool,
          dmSecret,
          (msg) => net.send(msg),
          (message) => flash(ui.banner, message),
          // Read lazily: the board does not exist yet at this point, and the
          // size changes under it every time a new map is loaded.
          () => stage?.naturalSize() ?? null,
          (previewing) => {
            // Tokens can be placed and edited on both boards, so the token
            // panel stays. The selection does not: a staged-only token is
            // absent from the live board, and the panel shouldn't describe
            // something not on screen.
            document.body.classList.toggle('previewing', previewing);
            tokenTool?.select(null);
            // The staged map has no shapes, so a draw tool left armed over it
            // would look usable when it isn't. Stop it, like the selection.
            drawTool?.stop();
            // Don't stop the wall editor or the fog brush here: both boards have
            // their own walls and paint, so an armed tool still works after the
            // switch. They are updated instead, and each drops any half-finished
            // gesture, because a run of corners or a stroke of cells belongs to
            // the map it was started on.
            if (room !== null) {
              wallTool?.update(room.scene);
              fogTool?.update(room.scene);
              // The token panel reads the shown board too: the light box greys
              // out where there is no fog for a light to affect, and which board
              // is shown has just changed.
              tokenTool?.update(room.scene);
            }
            // No prompt to size the grid: a staged map was offered one when it
            // was staged, and the live map when it arrived.
            stage?.reloadMap();
            // **Preview takes priority over the backdrop**, so entering it hides
            // the picture on this screen only and leaving it brings it back.
            // The rule is in `shownBackdrop`; this only tells the board the
            // answer may have changed, beside the map's reload.
            stage?.reloadBackdrop();
          },
        );
        mapTool.update(room.scene);

        tokenTool = createTokenTool(
          ui.tokentool,
          dmSecret,
          welcome.roster,
          (msg) => net.send(msg),
          (message) => flash(ui.banner, message),
          // Lazily, for the same reason: a new token goes wherever the DM is
          // looking, and the camera does not exist yet.
          () => stage?.viewCentre() ?? null,
        );
        tokenTool.update(room.scene);

        // DM-only like the two above it: a player is sent no walls, so there is
        // nothing here for them to edit and nothing on their board to show.
        wallTool = createWallTool(ui.walltool, (msg) => net.send(msg), () => drawTool?.stop());
        wallTool.update(room.scene);

        // The switch and the radius are fields of the map, so they go out as a
        // `set_map` through the map tool, which owns the confirmed calibration.
        // Don't give them a frame of their own: two writers for one record will
        // come to disagree. The brush is not the map's and sends its own
        // command.
        fogTool = createFogTool(
          ui.fogtool,
          (on, visionFt, lighting) => mapTool?.setFog(on, visionFt, lighting),
          (msg) => net.send(msg),
          // Lazily, like the map tool's: a fill is clipped to the play area, and
          // "the whole image" is a size only the decoded image knows.
          () => {
            const size = stage?.naturalSize();
            return size === undefined ? null : { w: size.width, h: size.height };
          },
          () => {
            drawTool?.stop();
            wallTool?.stop();
          },
          // The board reads the mirror for itself every frame; the initiative
          // panel is redrawn only when something arrives, so it is told. One
          // line instead of a mirrored scene passed through the four places
          // that call `panel.update`, where a fifth caller could forget it.
          () => panel?.mirror(fogTool?.playerView ?? false),
        );
        fogTool.update(room.scene);

        // The room-wide settings, including the backdrop: it belongs to neither
        // board, and the board it covers is still there underneath with its
        // walls and its fog. It is never inert, so unlike the four above it
        // needs no rule about greying its tab, but its library picker needs a
        // `stop()`.
        tableTool = createTableTool(
          ui.tabletool,
          dmSecret,
          welcome.roster,
          (msg) => net.send(msg),
          (message) => flash(ui.banner, message),
        );
        tableTool.update(room.scene);

        // Last, because it decides which of the five above is on screen and has
        // to be able to stop each one as it closes it. The order here is the
        // order of the tabs. Every panel that arms the canvas needs a `stop`,
        // fog's brush included: a tool left armed under a hidden panel makes a
        // click do something with nothing on screen saying why.
        createRail(ui.rail, [
          { tab: 'map', label: 'map', root: ui.maptool.root, stop: () => mapTool?.stop() },
          // Only the portrait list to close. The selection stays: it is a
          // ring on the board, which is still on screen with the panel closed.
          {
            tab: 'token',
            label: 'token',
            root: ui.tokentool.root,
            stop: () => tokenTool?.stop(),
          },
          { tab: 'walls', label: 'walls', root: ui.walltool.root, stop: () => wallTool?.stop() },
          { tab: 'fog', label: 'fog', root: ui.fogtool.root, stop: () => fogTool?.stop() },
          // Last on the strip: the panel used least during play. The `stop`
          // closes the library lists. Nothing on the canvas is armed, so this
          // is only tidiness, as with the map and token panels' lists.
          { tab: 'table', label: 'table', root: ui.tabletool.root, stop: () => tableTool?.stop() },
        ]);
      }

      void start(
        ui,
        room,
        identity,
        (msg) => net.send(msg),
        mapTool,
        tokenTool,
        rulers,
        drawTool,
        sketches,
        wallTool,
        fogTool,
        pings,
        cursors,
        // The cast list, which every connection is sent and which nothing
        // changes after this frame. It turns anybody's `Owner` into a name and
        // a colour on their ring. A player holds it too: they have to be able
        // to read who pinged, and they were offered these same names at the
        // identity picker.
        welcome.roster,
        // And the colour each of those names picked, which the roster doesn't
        // hold. Passed as the object, not the table: it is read every frame and
        // somebody may change colour between two of them.
        presence,
      ).then(
        (started) => {
          stage = started;
        },
        (err: unknown) => console.warn('could not start the board:', err),
      );
    },

    onTokenMoved: (move: TokenMoved) => {
      if (room === null) return;
      const token = room.scene.tokens.find((t) => t.id === move.id);
      if (token === undefined) return;

      // Where our copy stands *before* the frame is applied. Until the first
      // drag frame lands that is the settled position the drag began from, and
      // this is the only chance to learn it: nothing on the wire says where a
      // drag started, and the next frame has already moved the token.
      const from =
        move.staged && token.stagedPos !== null ? token.stagedPos : { x: token.x, y: token.y };
      if (move.dragging) {
        rulers.seen(move.id, from, move.staged, performance.now());
      } else {
        // The drop. Ours never reaches here (the server does not echo our own
        // drag frames), and input.ts has already ended that one on pointerup.
        rulers.end(move.id, performance.now());
      }

      // The server is authoritative, including over our own prediction.
      // Mid-drag frames for the token we are dragging are never sent back to
      // us, so this is either someone else's move or our own settled drop.
      //
      // The flag says which of the token's two positions this frame is about.
      // Ignoring it would write a plan for the next map onto the board the
      // table is looking at.
      if (move.staged) {
        token.stagedPos = { x: move.x, y: move.y };
      } else {
        token.x = move.x;
        token.y = move.y;
      }
    },

    onTokenChanged: (wire) => {
      if (room === null) return;
      // An id this client has not seen is a creation; anything else is an
      // edit. Either way the server's copy replaces whatever we had.
      upsertToken(room.scene, wire);
      stage?.loadArt();
      afterTokens(room);
    },

    onTokenRemoved: (id) => {
      if (room === null) return;
      removeToken(room.scene, id);
      // Deleted, or just hidden from us mid-drag. Either way there is no longer
      // a token for a ruler to measure to, and no trail should be left behind,
      // so this forgets instead of ending: a fading line pointing into the dark
      // would show where the token went.
      rulers.forget(id);
      afterTokens(room);
    },

    onMapChanged: (map) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;
      const newImage = scene.live.mapUrl !== map.url;

      // Replaced, not mutated field by field, so the render loop can never read
      // a half-applied grid. Tokens are untouched: they are stored in grid
      // units, so recalibrating moves where they draw, not which cell they are
      // in (invariant 1).
      scene.live = boardFromWire(map);
      mapTool?.update(scene);
      // The fog fields are on the map, so this is also how the fog panel learns
      // the switch was flipped, including by the DM's other tab.
      fogTool?.update(scene);
      // And how the token panel's light box learns it, for the same reason.
      tokenTool?.update(scene);
      afterBoardChanged(wasShowing, newImage);
    },

    // Reaches everyone, like the fog and unlike the staged map: the DM decides
    // whether the board is labelled and every board is labelled that way
    // afterwards. The renderer reads it straight off the scene, so there is
    // nothing to redraw by hand. Only the checkbox has to follow the room,
    // including when the DM's other tab changed it.
    onNamesChanged: (show) => {
      if (room === null) return;
      room.scene.showNames = show;
      tableTool?.update(room.scene);
    },

    // Pointers are on or off for the whole table now. The scene field is read by
    // the renderer and by `input.ts`, which stops sending ours as soon as this
    // says so: the switch cuts the traffic, not only the drawing.
    onCursorsChanged: (show) => {
      if (room === null) return;
      room.scene.showCursors = show;
      // Otherwise pointers already on the board would stay for the couple of
      // seconds their decay takes, which looks like the switch didn't work.
      if (!show) cursors.clear();
      tableTool?.update(room.scene);
    },

    // Shorter than the handler above: there is nothing on our board to clear,
    // because the room withholds the DM's pointer itself, and nothing here
    // decides what we send. A player stores this and does nothing with it; only
    // the DM's own panel reads it.
    onDmCursorChanged: (show) => {
      if (room === null) return;
      room.scene.showDmCursor = show;
      tableTool?.update(room.scene);
    },

    // Like `onNamesChanged`: the ruler reads the convention off the scene every
    // time it draws, so a reading already on screen changes on the next frame
    // without anything here recomputing it.
    onDiagonalsChanged: (diagonals) => {
      if (room === null) return;
      room.scene.diagonals = diagonals;
      tableTool?.update(room.scene);
    },

    // A picture went up in front of the table, or came down. **Nothing about
    // the board is touched here**: the map, the walls, the drawings and
    // everywhere the party has explored are unchanged behind it.
    onBackdropChanged: (url) => {
      if (room === null) return;
      room.scene.backdrop = url;
      stage?.reloadBackdrop();
      tableTool?.update(room.scene);
    },

    // Short for the same reason as the handler above: the board is not
    // changed. Whether this browser plays anything is decided in `sound.ts`: a
    // player who has never turned sound on runs this the same as everyone else
    // and hears nothing.
    onAudioChanged: (url) => {
      if (room === null) return;
      room.scene.audio = url;
      sound?.update(url);
      tableTool?.update(room.scene);
    },

    // Never reaches a player: the server sends this frame to the DM alone.
    onStagedChanged: (board) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;
      const newImage = board !== null && scene.staged?.mapUrl !== board.url;

      // The whole slot at once, walls and paint included, so a staged load that
      // sweeps its walls or a staged recalibration that drops its paint needs
      // no frames of its own. One frame describes the slot, so there is one
      // place to apply it.
      scene.staged = stagedFromWire(board);
      // Leaves preview mode when the slot has emptied (promoted or discarded)
      // and reports it, which is what puts the token panel back.
      mapTool?.update(scene);
      // These read the board on screen, and the slot they are reading may have
      // just been swept.
      wallTool?.update(scene);
      fogTool?.update(scene);
      tokenTool?.update(scene);
      afterBoardChanged(wasShowing, newImage);
    },

    onInitiativeChanged: (initiative) => {
      if (room === null || panel === null) return;
      room.initiative = initiative;
      panel.update(initiative, room.scene);
      // The only path that fires the turn notice. A `Welcome` and a `Restored`
      // both carry an initiative too and neither fires it; see `turn.ts`.
      turn?.update(initiative, room.scene);
    },

    // Somebody joined or left. Reaches everyone and is not filtered: who is
    // connected is not room state.
    onPresence: (here) => {
      presence?.here(here);
      // A destination chip dims for somebody who is not connected, so nobody
      // whispers to a player who isn't there.
      chat?.repaint();
    },

    // A player picked. Everybody is told, this client included if it was ours:
    // nothing here is predicted locally, so the frame is how our own swatch
    // updates.
    onColoursChanged: (colours) => {
      presence?.picked(colours);
      // The log is written in its senders' colours, and lines in old colours
      // would look like they came from the wrong person.
      chat?.repaint();
    },

    // The DM edited the cast. Everything that holds the array reads the new
    // one on its next draw; these four also built DOM from it, so they rebuild.
    // Our own slot can't have gone: the room closes that connection instead of
    // sending this, and the reload lands on the character picker.
    onRosterChanged: (next) => {
      if (roster === null) return;
      roster.splice(0, roster.length, ...next);
      presence?.recast();
      chat?.recast();
      tokenTool?.recast();
      tableTool?.recast();
    },

    // Somebody else's sweep. Never our own: the server does not echo it, for
    // the same reason it does not echo our drag frames.
    onSketch: (frame) => {
      sketches.seen(frame.by, {
        kind: frame.kind,
        at: frame.at,
        to: frame.to,
        color: frame.color,
      });
    },

    // Released, or that client disconnected mid-sweep and the room said so.
    // Nothing here has to expire on a timer, unlike the movement ruler.
    onSketchEnded: (by) => sketches.ended(by),

    // Somebody pointed at something. Never our own, which has been on our board
    // since the hold was 150ms old and would restart if this echoed it back.
    //
    // Nothing is checked here and there is nothing to check: a ping carries a
    // position and a sender, and the room decided it may land wherever it was
    // pointed. It is the one positioned frame that no filter on either side of
    // the wire has touched.
    onPinged: (ping) => pings?.add(ping.by, ping.at, performance.now()),

    // Somebody's pointer moved. Never our own, and nothing to check on arrival:
    // the room has already filtered this frame, so anything that arrives may be
    // drawn. A person's previous pointer is replaced, not added to, and a
    // pointer is removed when its frames stop arriving, not by any frame.
    onCursorMoved: (cursor) => cursors.moved(cursor.by, cursor.at, performance.now()),

    // Somebody said something we are party to, including ourselves: the one
    // relayed frame echoed to its sender. Nothing about a line of text is
    // predicted locally: the room decides where a line lands in the log.
    onSaid: (line) => chat?.said(line),

    // Our own box, changed in another tab of ours; that is the only reason this
    // frame exists. It is never anybody else's: nothing on the wire can carry
    // one.
    onNotesChanged: (text) => notes?.changed(text),

    // The whole list, replacing whatever we held. Nothing is predicted locally:
    // the server assigns a shape's id, and an erase is a click, not a drag, so
    // the round trip isn't noticeable.
    onShapesChanged: (shapes) => {
      if (room === null) return;
      room.scene.shapes = shapes.map(shapeFromWire);
    },

    // Never reaches a player: the server sends this frame to the DM alone. The
    // whole list, replacing whatever we held. Nothing here is predicted
    // locally, because the server assigns a segment's id and a run is finished
    // with a click, not dragged.
    onWallsChanged: (walls, staged) => {
      if (room === null) return;
      const scene = room.scene;
      const traced = walls.map(wallFromWire);
      // The frame names its own slot; don't infer one from what is on screen.
      // A promote can swap the boards while a frame is in flight, and inferring
      // would then write the next map's walls onto the one the table is
      // looking at.
      if (staged) {
        if (scene.staged !== null) scene.staged.walls = traced;
      } else {
        scene.walls = traced;
      }
      wallTool?.update(scene);
      // The fill floods against these, so a segment traced or erased changes
      // what the next preview would take.
      fogTool?.update(scene);
    },

    // Reaches everyone, unlike the walls: fog is party-shared, so the DM and
    // the table are sent the same frame and only how faintly it draws differs.
    // Rebuilt into a canvas here, not per frame: a fogged board is a few
    // thousand cells, and the renderer stretches one image over them instead
    // of filling that many rectangles sixty times a second.
    //
    // Nothing here decides who is drawn. A creature the table cannot see is
    // absent from the token list entirely (invariant 4). This is only the
    // terrain.
    onFogChanged: (fog) => {
      if (room === null) return;
      room.scene.fog = fogFromWire(fog, identity.isDm);
    },

    // Never reaches a player, like the walls: this is what the DM decided, and
    // the fog frame is what the table is shown. Rebuilt into its own canvas
    // here, for the same reason as the fog: a filled room is a few thousand
    // cells.
    onOverridesChanged: (overrides, staged) => {
      if (room === null) return;
      const painted = overridesFromWire(overrides);
      // The frame names its slot, for the same reason as the walls.
      if (staged) {
        if (room.scene.staged !== null) room.scene.staged.overrides = painted;
      } else {
        room.scene.overrides = painted;
      }
    },

    // The DM undid something. The whole room, replacing everything we hold.
    //
    // **Not routed to `onWelcome`.** That builds the panels, the tools and the
    // board once, assuming one Welcome per socket. Running it again would
    // construct a second of each, register a second keydown listener for every
    // tool, and reset the DM's camera while they are looking at what they just
    // undid. So the state is adopted in place instead, and everything built on
    // connect is told to re-read it.
    onRestored: (view) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;

      // In place: the board captured this object when it started and draws from
      // it every frame, so assigning a new one over `room.scene` would leave the
      // renderer on the old state. `previewing` survives, which the type of
      // `adoptView` enforces.
      adoptView(scene, view, identity.isDm);
      room.initiative = view.initiative;
      // Seeded, never fired: a restore mid-combat shouldn't notify six people
      // of a turn that did not move.
      turn?.adopt(view.initiative);
      // On the view like everything else, so adopting them here is free.
      // Neither can have changed (an undo does not disconnect anybody, and
      // colours are excluded from the ring), but adopt them anyway so this
      // stays right if either stops being true.
      presence?.here(view.here);
      presence?.picked(view.colours);
      chat?.repaint();

      // A ruler measuring to a token the restore removed would show where it
      // went, as in `onTokenRemoved`. Sketches and pings are left alone: both
      // are somebody's mouse right now and neither is room state to restore.
      rulers.forgetExcept(new Set(scene.tokens.map((t) => t.id)));

      // An undo can turn the cursor switch back off, and the pointers already
      // drawn are not room state to restore. Same as `onCursorsChanged`.
      if (!scene.showCursors) cursors.clear();

      panel?.update(room.initiative, scene);
      tokenTool?.update(scene);
      tableTool?.update(scene);
      // Leaves preview mode if the slot it was previewing has just gone.
      mapTool?.update(scene);
      wallTool?.update(scene);
      fogTool?.update(scene);
      undo?.update(view.undo);
      stage?.loadArt();
      // `false`, so the DM is not asked to size a grid: whatever map this
      // restored to was calibrated when it was first loaded, and the grid came
      // back in this frame.
      afterBoardChanged(wasShowing, false);
      // An undo can put a backdrop up or take one down like any other step.
      stage?.reloadBackdrop();
      // This currently does nothing. Music is not on `Saved`, so `adopt` never
      // touches it and a restore cannot have changed it. It is kept for the
      // same reason as `presence.here` above: `update` returns immediately on
      // an unchanged URL, and this stays right if that stops being true.
      sound?.update(scene.audio);
    },

    // Only ever called on a DM connection.
    onUndoChanged: (label) => undo?.update(label),

    onError: (message) => {
      console.warn('server rejected a command:', message);
      flash(ui.banner, message);
    },

    // The socket dropped and net.ts is trying again. The board is stale from
    // here (the room carried on without us), so the banner says so, and the
    // class that greys the boxes that can no longer reach the room goes on now,
    // not when the retries run out.
    onLost: () => {
      document.body.classList.add('offline');
      ui.picker.hidden = true;
      // `body.offline` greys the scratchpad and disables its pointer events,
      // but a caret already in the box keeps taking keystrokes. The reconnect
      // is a page reload, so a paragraph typed after the socket died would be
      // lost without warning. Blurring flushes what the debounce is holding
      // (while the socket may still be open) and takes keyboard focus away.
      ui.notes.text.blur();
      ui.banner.textContent = 'connection lost — reconnecting…';
      ui.banner.hidden = false;
    },

    // The retries ran out.
    onClose: () => {
      document.body.classList.add('offline');
      ui.picker.hidden = true;
      ui.panel.root.hidden = true;
      ui.banner.textContent = 'disconnected — refresh to rejoin';
      ui.banner.hidden = false;
    },
  });
}

function showWhoami(
  ui: Ui,
  identity: Identity,
  choice: RoomChoice,
  tokens: WireToken[],
  alone: boolean,
): void {
  if (identity.isDm) {
    ui.whoamiName.textContent = `DM · ${choice.name}`;
  } else {
    // Prefer the character's display name over the raw slot id.
    const own = tokens.find((t) => t.owner.kind === 'player' && t.owner.id === identity.playerId);
    ui.whoamiName.textContent = `${own?.name ?? identity.playerId ?? '—'} · ${choice.name}`;
  }
  // The DM gets the button too, labelled for what it does for them. Don't hide
  // it because the DM has no character to switch: it also switches room, and
  // with the room and the secret both remembered, it is the DM's only way back
  // to the room picker short of hand-editing `?room=`. It is safe because the
  // reload comes back as the DM via `takeDmSecret`.
  //
  // Except on a server with one room, where the DM has nowhere to switch to.
  // A player keeps theirs there, since it is also how they change character.
  ui.whoamiSwitch.textContent = identity.isDm ? 'switch room' : 'switch';
  ui.whoamiSwitch.hidden = identity.isDm && alone;
  ui.whoami.hidden = false;
}

/** The running board, for the few things that have to reach into it later. */
interface Stage {
  /**
   * Loads the image for whichever board is shown now, then refits the camera to
   * it. `onLoaded` runs once that image is on screen, which is the first moment
   * its pixel dimensions are known.
   */
  reloadMap(onLoaded?: () => void): void;
  /**
   * Re-reads `shownBackdrop` and fetches the picture if it changed.
   *
   * Called wherever the answer could have changed, not only where a backdrop
   * arrives, because two things decide it: the room's backdrop, and whether the
   * DM is previewing the staged map. Like `reloadMap` it compares against what
   * is on screen and does nothing when that has not changed.
   */
  reloadBackdrop(): void;
  /** Fetches art for any token whose image is not in hand yet. */
  loadArt(): void;
  /** Pixel size of the map image currently on screen. */
  naturalSize(): { width: number; height: number };
  /** Middle of the viewport, in grid units. Where a new token goes. */
  viewCentre(): Vec2;
  /**
   * Puts a token in the middle of the viewport. The inverse of `viewCentre`, and
   * here for the same reason: the camera belongs to the board and nothing
   * outside it should hold one.
   *
   * A no-op for a token with no position on the board on screen, such as one
   * staged for the next map while the DM is looking at the live one.
   */
  lookAt(token: Token): void;
  /**
   * Frames the board on screen, for somebody who has panned off the edge of it.
   *
   * Like lookAt, at map scale, and here for the same reason. It never goes on
   * the wire: where one person is looking is theirs alone.
   */
  fit(): void;
}

async function start(
  ui: Ui,
  room: Room,
  identity: Identity,
  send: (msg: ClientMsg) => void,
  mapTool: MapTool | null,
  tokenTool: TokenTool | null,
  rulers: Rulers,
  drawTool: DrawTool,
  sketches: Sketches,
  wallTool: WallTool | null,
  fogTool: FogTool | null,
  pings: Pings,
  cursors: Cursors,
  roster: readonly RosterEntry[],
  presence: Presence,
): Promise<Stage> {
  const { scene } = room;
  const firstUrl = shownBoard(scene).mapUrl;
  let map = await loadImage(firstUrl);
  /** The image on screen. Not `map.src`, which the browser has made absolute. */
  let showing = firstUrl;

  // Two maps at most (the board and whatever is staged), but cached by URL like
  // the token art, so toggling in and out of preview does not re-fetch several
  // megabytes each time. Promises, not images, so two callers asking at once
  // share one download instead of racing.
  const mapImages = new Map<string, Promise<HTMLImageElement>>([[firstUrl, Promise.resolve(map)]]);
  const fetchMap = (url: string): Promise<HTMLImageElement> => {
    let arriving = mapImages.get(url);
    if (arriving === undefined) {
      arriving = loadImage(url);
      mapImages.set(url, arriving);
      // Don't cache a failure: the next attempt should try again.
      arriving.catch(() => mapImages.delete(url));
    }
    return arriving;
  };

  /**
   * The picture in front of the board, once it has arrived, and the URL it came
   * from.
   *
   * Two variables because the gap between them is a real state: `backdropUrl`
   * is what should be up, `backdrop` is what can be drawn. Between the DM's
   * click and the download finishing, the board stays on screen, which is
   * better than a black window.
   *
   * It shares `fetchMap`'s cache, since a backdrop is another large image
   * fetched by URL and toggling one on and off twice in an evening should not
   * fetch it twice.
   */
  let backdrop: HTMLImageElement | null = null;
  let backdropUrl: string | null = null;

  // Keyed by URL, not by token, so changing a token's art finds the new
  // picture and two goblins sharing a portrait share one download. Portraits
  // stream in; render.ts draws a placeholder disc for any that have not
  // arrived, so a slow or broken image never blocks the map.
  const tokenImages = new Map<string, HTMLImageElement>();
  // `tokenImages` only holds loaded images, so the renderer can draw anything
  // it finds there. This tracks every URL already requested, in flight or not.
  const requested = new Set<string>();
  const loadArt = (): void => {
    for (const token of scene.tokens) {
      // Empty is a token the DM gave no art; there is nothing to fetch.
      if (token.img === '' || requested.has(token.img)) continue;
      const url = token.img;
      requested.add(url);
      loadImage(url).then(
        (img) => tokenImages.set(url, img),
        // A broken URL leaves the placeholder disc, which is still a token
        // everyone can see and the DM can drag.
        (err: unknown) => console.warn(err),
      );
    }
  };
  loadArt();

  const cam: Camera = { x: 0, y: 0, zoom: 1 };
  fitToMap(cam, syncCanvasSize(ui.canvas), map.width, map.height);

  const input = attachInput(
    ui.canvas,
    cam,
    scene,
    identity,
    send,
    mapTool,
    tokenTool === null
      ? null
      : (id) => {
          // Selection and nothing else. Don't open the token tab here: the rail
          // is where the DM is working, and swapping the panel out from under a
          // trace to show a form they did not ask for costs more than the click
          // it saves. Only a click on a tab changes the tab. The selection is
          // visible anyway as a ring on the board, which the panel's own `stop`
          // relies on.
          tokenTool.select(id);
        },
    tokenTool === null ? null : () => tokenTool.selectedId,
    rulers,
    drawTool,
    sketches,
    wallTool,
    fogTool,
    pings,
    createGestures(ui.gestureHint),
  );

  // Delete removes every token with a selection ring: the group, the token the
  // panel is editing, or both. The renderer draws them as one
  // selection and this deletes them as one. Backspace too, because that is the
  // key a Mac labels "delete". Bound only for the DM, since only the DM holds a
  // token tool and only the DM may delete; a player's Delete does nothing
  // instead of getting a refusal. Ignored inside a field, and while the wall
  // editor is armed: Backspace removes a corner there, and a stray one
  // mid-trace must not delete a creature.
  if (tokenTool !== null) {
    const tool = tokenTool;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (e.repeat || typingIn(e.target)) return;
      if (wallTool !== null && wallTool.mode !== null) return;
      const ids = new Set(input.selection);
      if (tool.selectedId !== null) ids.add(tool.selectedId);
      if (ids.size === 0) return;
      // Before the confirm, not after it: an unhandled Backspace is "go back"
      // in some browsers, which would leave the page whatever the answer.
      e.preventDefault();
      tool.remove(ids);
    });
  }

  const stage: Stage = {
    reloadMap(onLoaded) {
      const url = shownBoard(scene).mapUrl;
      // Already up. The callback still runs: it is the prompt to size a grid,
      // not a redraw, and whoever asked still needs it.
      if (url === showing) {
        onLoaded?.();
        return;
      }

      fetchMap(url).then(
        (img) => {
          // A newer map may have arrived while this one was downloading.
          if (shownBoard(scene).mapUrl !== url) return;
          map = img;
          showing = url;
          // A different image may be a completely different size, so show all
          // of it instead of keeping the old camera.
          fitToMap(cam, syncCanvasSize(ui.canvas), map.width, map.height);
          onLoaded?.();
        },
        (err: unknown) => console.warn(err),
      );
    },
    reloadBackdrop() {
      const url = shownBackdrop(scene);
      if (url === backdropUrl) return;
      backdropUrl = url;
      // Cleared, not kept, so the frame loop cannot draw the *previous* picture
      // between one being chosen and it arriving.
      backdrop = null;
      if (url === null) return;

      fetchMap(url).then(
        (img) => {
          // The answer may have changed while this was downloading, including
          // the DM taking the backdrop down again.
          if (shownBackdrop(scene) !== url) return;
          backdrop = img;
        },
        // Leaves the board on screen: the DM can see their pick did not take,
        // and the table never goes black.
        (err: unknown) => console.warn(err),
      );
    },
    loadArt,
    naturalSize: () => ({ width: map.width, height: map.height }),
    viewCentre: () => {
      const view = syncCanvasSize(ui.canvas);
      const w = screenToWorld(cam, view.width / 2, view.height / 2);
      return worldToGrid(shownBoard(scene).grid, w.x, w.y);
    },
    lookAt: (token) => {
      // Through `shownPos`, because the DM may be previewing the staged map and
      // the camera has to land on the board that is actually on screen.
      const at = shownPos(scene, token);
      if (at === null) return;
      const world = gridToWorld(shownBoard(scene).grid, at.x, at.y);
      centreOn(cam, syncCanvasSize(ui.canvas), world);
    },
    fit: () => {
      // Frames the play area when the DM has drawn one, unlike reloadMap. A
      // load frames the whole image because a new map is calibrated next, and
      // the margin is part of what the DM needs to see. This is used mid-fight
      // by somebody who has lost the board, and the board is the part ruled
      // into cells.
      const board = shownBoard(scene);
      fitToRect(cam, syncCanvasSize(ui.canvas), playRect(board.playArea, map.width, map.height));
    },
  };

  let lastHud = '';
  /** What the body class was last set to, so it is written only on a change. */
  let lastCovered = false;
  /**
   * The solo wash, rebuilt only when the answer could have changed.
   *
   * A raycast over the reach of one torch is a few hundred cells against the
   * walls within it, which is affordable once and not sixty times a second. The
   * five things it depends on are compared, not hashed, and two of them by
   * reference: `scene.walls` and `scene.live` are both replaced whole by their
   * deltas, never mutated field by field, so reference equality answers "did
   * this change" exactly and cheaply.
   */
  let soloCache: {
    id: string;
    x: number;
    y: number;
    walls: readonly Wall[];
    board: Board;
    fog: Fog | null;
  } | null = null;

  const soloFog = (): Fog | null => {
    const id = fogTool?.sightId ?? null;
    if (id === null) {
      soloCache = null;
      return null;
    }
    // Live board only: nothing raycasts a map the table has not been shown, so
    // the panel greys this out during a preview and there is nothing to draw if
    // the DM gets here anyway.
    const token = scene.tokens.find((t) => t.id === id) ?? null;
    if (token === null || scene.previewing) return null;

    const board = scene.live;
    const walls = scene.walls;
    if (
      soloCache !== null &&
      soloCache.id === id &&
      soloCache.x === token.x &&
      soloCache.y === token.y &&
      soloCache.walls === walls &&
      soloCache.board === board
    ) {
      return soloCache.fog;
    }

    const size = stage?.naturalSize();
    const wire = soloSight(
      token,
      board,
      walls,
      size === undefined ? null : { w: size.width, h: size.height },
    );
    // The table's shade, not the DM's faint one, as `drawFog` uses for the
    // bands around it: the DM asked what this creature sees, and the answer has
    // to be legible.
    const fog = wire === null ? null : fogFromWire(wire, false);
    soloCache = { id, x: token.x, y: token.y, walls, board, fog };
    return fog;
  };

  const frame = (): void => {
    const view = syncCanvasSize(ui.canvas);

    // The picture is drawn instead of the board, not over it. Everything below
    // is skipped: no world transform, no fog, no tokens, no rulers, no HUD.
    // Read from `backdrop`, not the scene, so the board stays up until the
    // image has loaded.
    //
    // **The `covered` class is what stops the canvas responding.** One line
    // here instead of a guard in every handler in `input.ts`: with pointer
    // events off the canvas there is no pan, drag, ping, door, sweep or cursor
    // relay, and no handler has to remember to check.
    const covered = backdrop !== null;
    if (covered !== lastCovered) {
      lastCovered = covered;
      document.body.classList.toggle('covered', covered);
    }
    if (backdrop !== null) {
      drawBackdrop(ui.ctx, view, backdrop);
      requestAnimationFrame(frame);
      return;
    }

    // Read once and passed down, so the sweep below and the fade the renderer
    // draws cannot disagree about what time it is within one frame.
    const now = performance.now();
    // The mirror, read per frame like everything else here. Narrowed on the way
    // into the renderer, not held as a second scene, because a copy that
    // outlived a frame would have to be kept in step with the deltas, and the
    // scene changes on every drag frame. Everything outside this call,
    // `input.ts` included, keeps reading the room's own scene: the mirror is
    // what the DM is looking at, not what they are working on.
    const playerView = fogTool?.playerView ?? false;
    render(ui.ctx, view, {
      cam,
      scene: playerView ? asTable(scene) : scene,
      playerView,
      identity,
      map,
      now,
      tokenImages,
      draggingIds: input.draggingIds,
      // Expired here, not in the renderer: a client that disconnected mid-drag
      // sends no drop frame, and nothing else in a frame checks the clock.
      rulers: rulers.active(now),
      // Not expired on a clock like the rulers: a sweep ends on its release
      // frame or on the `sketch_ended` the room sends when a socket closes, so
      // there is no case left for a clock to catch.
      sketches: sketches.all(),
      // Expired here like the rulers, and only here: no release frame, socket
      // close or room message ends a ring, so its timer is the only thing that
      // removes it. It includes the hold in progress, so the growing preview
      // and the ring it becomes are one drawing.
      pings: pings.active(now),
      // Read per frame like the rings, and expiring the same way: whoever has
      // stopped moving is not in this array.
      cursors: cursors.active(now),
      roster,
      // Read per frame, not captured: a ring already on the board changes colour
      // on the next frame when its owner picks a new one, with nothing here
      // recomputing anything.
      colours: presence.colours,
      hoveredShapeId: input.hoveredShapeId,
      selectedId: tokenTool?.selectedId ?? null,
      selection: input.selection,
      marquee: input.marquee,
      currentTurn: room.initiative.current,
      calibration:
        mapTool !== null && mapTool.box !== null
          ? { box: mapTool.box, cells: mapTool.cells, shape: mapTool.shape }
          : null,
      walls:
        wallTool === null
          ? null
          : {
              armed: wallTool.mode !== null,
              run: wallTool.run,
              aim: wallTool.aim,
              hovered: wallTool.hovered,
            },
      fog:
        fogTool === null
          ? null
          : {
              armed: fogTool.brush !== null,
              paint: fogTool.brush === null || fogTool.brush === 'clear' ? null : fogTool.brush,
              preview: fogTool.preview,
            },
      solo: soloFog(),
    });

    const cursor = input.cursorGrid;
    const text =
      `${Math.round(cam.zoom * 100)}%  ·  ` +
      (cursor === null ? 'cell —' : `cell ${Math.floor(cursor.x)}, ${Math.floor(cursor.y)}`);
    if (text !== lastHud) {
      ui.hud.textContent = text;
      lastHud = text;
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  // The map may have been replaced while that first image was downloading.
  if (shownBoard(scene).mapUrl !== firstUrl) stage.reloadMap();
  // And the room may already have a backdrop up when this page joins.
  stage.reloadBackdrop();
  return stage;
}

/** Transient message. Never clears the permanent disconnect banner. */
function flash(banner: HTMLElement, message: string): void {
  banner.textContent = message;
  banner.hidden = false;
  window.setTimeout(() => {
    if (document.body.classList.contains('offline')) return;
    banner.hidden = true;
  }, 2500);
}

/**
 * Resizes the backing store to match the CSS box at the current device pixel
 * ratio. Called every frame: it is a no-op unless something changed, and it
 * covers window resizes and monitor-to-monitor DPR changes alike.
 */
function syncCanvasSize(canvas: HTMLCanvasElement): Viewport {
  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  const backingW = Math.max(1, Math.round(width * dpr));
  const backingH = Math.max(1, Math.round(height * dpr));

  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }

  return { width, height, dpr };
}

/** Centres the whole map in view without zooming past 1:1. */
function fitToMap(cam: Camera, view: Viewport, mapW: number, mapH: number): void {
  fitToRect(cam, view, { x: 0, y: 0, w: mapW, h: mapH });
}

/**
 * Frames a rectangle of the image, without zooming past 1:1.
 *
 * The 1:1 ceiling stops a small map (or a tight play area on a large one)
 * filling the screen with four enormous cells: past the art's resolution,
 * zooming in only adds blur.
 *
 * **Don't remove the floor of 1 on the sides.** playRect clips to the image
 * and returns a zero-width rectangle for a saved play area that no longer
 * overlaps it (a map replaced with a smaller image). Dividing by that gives an
 * infinite zoom and a camera at NaN, and the board doesn't come back without a
 * refresh.
 */
function fitToRect(cam: Camera, view: Viewport, at: Rect): void {
  const w = Math.max(1, at.w);
  const h = Math.max(1, at.h);
  cam.zoom = Math.min(view.width / w, view.height / h, 1);
  cam.x = at.x + w / 2 - view.width / (2 * cam.zoom);
  cam.y = at.y + h / 2 - view.height / (2 * cam.zoom);
}

/**
 * Puts a world point in the middle of the viewport, at whatever zoom is already
 * set.
 *
 * Like `fitToMap` but leaves the zoom alone: this is used mid-fight by somebody
 * who wants to look at something, and they didn't ask to change how far in
 * they are zoomed.
 */
function centreOn(cam: Camera, view: Viewport, at: Vec2): void {
  cam.x = at.x - view.width / (2 * cam.zoom);
  cam.y = at.y - view.height / (2 * cam.zoom);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => reject(new Error(`could not load ${url}`)));
    img.src = url;
  });
}

// Floating: nothing awaits the page. `chooseRoom` handles its own one failure.
void chooseRoom();

import type { Camera, Vec2 } from './coords.js';
import { gridToWorld, screenToWorld, worldToGrid } from './coords.js';
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
import { createUndo } from './undo.js';
import type { Wall } from './walls.js';
import { wallFromWire } from './walls.js';
import type { WallTool } from './walltool.js';
import { createWallTool } from './walltool.js';

interface Ui {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  hud: HTMLElement;
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
    form: HTMLFormElement;
    text: HTMLInputElement;
    toast: HTMLElement;
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
    save: HTMLButtonElement;
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
      form: need<HTMLFormElement>('#chat-form'),
      text: need<HTMLInputElement>('#chat-text'),
      toast: need('#chat-toast'),
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
      save: need<HTMLButtonElement>('#token-save'),
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
 * **Everything after this function is unchanged by multi-room** — it takes the
 * room as an argument and never asks again. The split is here because a socket
 * belongs to one room from the moment it opens, so the choice has to be settled
 * before `connect`, and the list it is settled against comes over HTTP.
 *
 * Three ways to arrive, in order: a `?room=` in the link, the room this browser
 * was last in, or the picker. The first two are checked against the list rather
 * than trusted, so a stale bookmark or a renamed room falls back to the picker
 * instead of a socket the server 404s.
 */
async function chooseRoom(): Promise<void> {
  const ui = findUi();

  let rooms: RoomChoice[];
  try {
    rooms = await fetchRooms();
  } catch (err) {
    // There is no room to connect to and nothing to show, so this is the one
    // failure the page cannot work around.
    console.error(err);
    ui.banner.textContent = 'could not reach the server — refresh to try again';
    ui.banner.hidden = false;
    return;
  }

  const known = (id: string | null): RoomChoice | undefined =>
    id === null ? undefined : rooms.find((candidate) => candidate.id === id);

  const chosen = known(takeRoomFromUrl()) ?? known(readStoredRoom());
  if (chosen !== undefined) {
    // A link that named a room replaces the remembered one; a remembered one
    // rewrites itself, which costs nothing.
    storeRoom(chosen.id);
    boot(ui, chosen);
    return;
  }

  const roomPicker = createRoomPicker(ui.roomPicker, (roomId) => {
    const picked = known(roomId);
    if (picked === undefined) return; // not offered; nothing to do
    storeRoom(picked.id);
    roomPicker.hide();
    boot(ui, picked);
  });
  roomPicker.show(rooms);
}

function boot(ui: Ui, choice: RoomChoice): void {
  // Read and strip the DM secret before anything else can screenshot the URL.
  // A reload comes back through this with an empty `?dm=` and picks the secret
  // up out of `sessionStorage`, which is what makes a dropped socket survivable
  // for the DM as well as for everybody else.
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
  // Both built on every connection, unlike everything above them: neither of
  // the dock's panels is the DM's.
  let chat: Chat | null = null;
  let notes: Notes | null = null;
  let dock: Dock | null = null;
  // Everybody's too, and built before the chat panel because that one reads
  // through it — who is connected decides which destination chips are dimmed,
  // and what everyone picked decides what colour a line is written in.
  let presence: Presence | null = null;
  // And everybody's for the plainest reason of all: whose turn it is is not a
  // secret, so this is the same feature on every screen.
  let turn: Turn | null = null;
  // DM-only for the same reason and optional-chained the same way: a player has
  // no undo ring to be told about, so the server sends them no label.
  let undo: Undo | null = null;
  let identity: Identity = ANONYMOUS;
  // Outlives any one drag and is fed from both directions — our own pointer in
  // input.ts, and everyone else's drag frames below.
  const rulers = createRulers();
  // The same arrangement for sweeps: ours goes in from input.ts, everyone
  // else's from the frames below.
  const sketches = createSketches();
  // And for the pointers — except that this one is fed from *one* direction
  // only. Ours is drawn by the machine it is plugged into, so nothing ever puts
  // our own in here and there is no identity for it to know.
  const cursors = createCursors();
  // And a third time for the rings — except that this one cannot be built until
  // Welcome, because it has to know whose ring ours is.
  let pings: Pings | null = null;

  const picker = createPicker(ui.picker, (playerId) => {
    // Not stored yet — only a Welcome proves the server accepted the claim.
    net.send({ type: 'hello', dm_secret: null, player_id: playerId });
  });

  ui.whoamiSwitch.addEventListener('click', () => {
    // **Both**, and the room first, because they are one act: the room decides
    // which slots exist, so being asked which character you are without being
    // asked which room you are in offers a cast you may not want. It reloads
    // into the room picker and then the character picker, which is the same
    // sequence a first visit takes.
    //
    // For the DM it is the room alone: they hold no slot, so there is nothing
    // to forget and nothing to be asked afterwards. The secret is untouched
    // either way — this is *switch campaign*, not *leave the DM seat*, and the
    // reload comes back through `takeDmSecret` as the DM.
    if (!identity.isDm) forgetPlayerId(choice.id);
    forgetRoom();
    // The link's own `?room=` would beat the forgetting and put us straight
    // back where we were, so it goes too.
    const url = new URL(location.href);
    url.searchParams.delete('room');
    location.replace(`${url.pathname}${url.search}${url.hash}`);
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
   * A brand new image also means the grid inherited from the last one is
   * meaningless, so the DM is asked to size it — but only once it has loaded and
   * its dimensions are known, and only if it is the map they are looking at.
   */
  const afterBoardChanged = (wasShowing: string, newImage: boolean): void => {
    if (room === null || shownBoard(room.scene).mapUrl === wasShowing) return;
    stage?.reloadMap(newImage ? () => mapTool?.proposeWholeMap() : undefined);
  };

  const net: Net = connect(choice.id, {
    onOpen: () => {
      // A DM link wins over any remembered slot: it is an explicit, deliberate
      // act, and the DM may well have played as a character before.
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
      showWhoami(ui, identity, choice, welcome.state.tokens);

      // Built here rather than beside the rulers, because it is the first thing
      // on the client that has to know *who we are* to work at all: every ring
      // it holds is attributed, ours included.
      pings = createPings(
        identity.playerId === null
          ? { kind: 'dm' }
          : { kind: 'player', id: identity.playerId },
      );

      // Exactly one Welcome per connection — identity cannot change once set —
      // so this runs once. Assigned synchronously so a delta arriving straight
      // after Welcome cannot land in a gap where the room does not exist yet.
      room = {
        scene: sceneFromView(welcome.state, identity.isDm),
        initiative: welcome.state.initiative,
      };
      panel = createPanel(
        ui.panel,
        identity,
        (msg) => net.send(msg),
        // Clicking a row looks at that creature. Read lazily off the stage,
        // which does not exist yet at this point — the board is built after the
        // panel is, and it is the only thing holding a camera.
        (token) => stage?.lookAt(token),
      );
      panel.update(room.initiative, room.scene);

      // Built for everyone, unlike the two panels below it. Anyone may draw —
      // this is the first thing a player can add to the room, and the only
      // thing that differs by identity here is the clear-all button.
      drawTool = createDrawTool(
        ui.drawtool,
        identity.isDm,
        (msg) => net.send(msg),
        // Whose line it is, for the measure tool. Reached for lazily like the
        // panel's `lookAt` above: presence is built a few lines below this one
        // and owns the live colour table, so a player changing their mind
        // changes the next line they measure. Before it exists nobody has
        // picked anything, which is exactly what an empty table means.
        () => colourOf(ownerOf(identity), welcome.roster, presence?.colours ?? {}),
        () => wallTool?.stop(),
      );

      // Before the chat panel, which reads through it. Everybody's, like the
      // dock's two panels and unlike the rail's five: who is connected is
      // nobody's secret, and a colour that only its owner could see would not be
      // a colour. The DM's copy is the same object with one thing missing — the
      // control, since their hue is not one of the six.
      presence = createPresence(
        ui.presence,
        identity,
        welcome.roster,
        welcome.state.here,
        welcome.state.colours,
        (msg) => net.send(msg),
      );

      // Seeded from the join and never fired by it: adopting state is not a turn
      // change, and a refresh mid-combat that announced whoever was already up
      // would be the feature crying wolf on its first frame.
      turn = createTurn(ui.turn, identity, welcome.state.initiative);

      // Built for everyone, like the draw tool above and unlike the rail
      // below: neither of the dock's panels is the DM's. The log the room hands
      // over here is already the one this client is party to — a whisper
      // between two other people is not in it to be filtered.
      chat = createChat(
        ui.chat,
        identity,
        welcome.roster,
        welcome.state.chat,
        presence,
        (msg) => net.send(msg),
        // The dock does not exist yet on this line and does by the time a line
        // can arrive, which is why this reaches for it lazily.
        (count) => dock?.badge('chat', count),
      );
      // The other panel everybody has, and the only state in this application
      // that is nobody else's business — the room sends this client its own box
      // and has no way to send it another. There is no identity branch here for
      // the same reason: the DM's scratchpad is not different from anybody's.
      notes = createNotes(ui.notes, welcome.state.notes, (msg) => net.send(msg));

      dock = createDock(ui.dock, [
        {
          tab: 'chat',
          label: 'chat',
          root: ui.chat.root,
          // No `stop` anywhere in this list, unlike the rail's: nothing in the
          // dock arms the canvas. What a panel here needs is the opposite hook
          // — the moment it comes on screen, where the log catches up and the
          // unread count goes.
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
      ]);

      // Built for the DM alone and before the rail, because it sits above the
      // strip rather than on it — undo is not an editing panel, it is what you
      // reach for in the middle of using one.
      if (identity.isDm) {
        undo = createUndo(ui.undo, (msg) => net.send(msg));
        undo.update(welcome.state.undo);
      }

      // `isDm` is only ever true because we sent a secret that the server
      // accepted, so it is in hand — but uploads need it, so prove it here.
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
            // Everything on this board is still a piece — that is the whole of
            // preparing the next room — so the token panel stays. The selection
            // does not: a staged-only token is absent from the live board, and a
            // panel describing something not on screen is a panel lying.
            document.body.classList.toggle('previewing', previewing);
            tokenTool?.select(null);
            // The staged map still has no shapes, so a tool left armed over it
            // would sit there looking like it could do something. Put it away
            // for the same reason the token selection goes.
            drawTool?.stop();
            // **The wall editor and the fog brush no longer go with it**, which
            // is milestone 20 on this side of the wire: both boards carry their
            // own masonry and their own paint now, so a tool armed here goes on
            // meaning something. They are told instead of stopped — each drops
            // the half-finished gesture it was holding, because a run of corners
            // or a stroke of cells is about the map it was started on.
            if (room !== null) {
              wallTool?.update(room.scene);
              fogTool?.update(room.scene);
              // A third reader of the same field since milestone 39: the light
              // box greys where there is no fog for a light to push back, and
              // which board that is has just changed.
              tokenTool?.update(room.scene);
            }
            // No prompt to size the grid — a staged map was offered one when it
            // was staged, and the live map when it arrived.
            stage?.reloadMap();
            // **Preview beats the backdrop**, so entering it puts the picture
            // away on this screen alone and leaving it brings the picture back.
            // The rule is `shownBackdrop`'s and this only tells the board the
            // answer may have moved — which is why it is here beside the map's
            // reload rather than expressed a second time.
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

        // The switch and the radius are the map's, so they go out as a `set_map`
        // through the panel that owns the confirmed calibration rather than as a
        // frame of their own — two writers for one record is how they come to
        // disagree. The brush is not the map's and sends its own command.
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
          // line rather than a mirrored scene threaded through the four places
          // that call `panel.update` — the fifth would be the one forgotten.
          () => panel?.mirror(fogTool?.playerView ?? false),
        );
        fogTool.update(room.scene);

        // The room-wide settings, and the backdrop, which is one of them: it
        // belongs to neither board, and the board it covers is still there
        // underneath with its walls and its fog. It is never inert, so unlike
        // the four above it it needs no rule about greying its tab — but the
        // picker means it does now owe a `stop()`.
        tableTool = createTableTool(
          ui.tabletool,
          dmSecret,
          (msg) => net.send(msg),
          (message) => flash(ui.banner, message),
        );
        tableTool.update(room.scene);

        // Last, because it owns whether the five above are on screen and has to
        // be able to put each of them down as it closes it. The order here is
        // the order of the tabs. Fog gained a `stop` in 16b: it used to arm
        // nothing, and the brush is a tool holding the left button like any
        // other — one left under a hidden panel is a click doing something with
        // nothing on screen saying why.
        createRail(ui.rail, [
          { tab: 'map', label: 'map', root: ui.maptool.root, stop: () => mapTool?.stop() },
          // Only the portrait list to put down. The selection stays: it is a
          // ring on the board, which is still on screen with the panel closed.
          {
            tab: 'token',
            label: 'token',
            root: ui.tokentool.root,
            stop: () => tokenTool?.stop(),
          },
          { tab: 'walls', label: 'walls', root: ui.walltool.root, stop: () => wallTool?.stop() },
          { tab: 'fog', label: 'fog', root: ui.fogtool.root, stop: () => fogTool?.stop() },
          // Last on the strip: the least-touched panel during play. The `stop`
          // closes the backdrop list — nothing on the canvas is armed, so this
          // is the map and token panels' tidiness rather than their rule.
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
        // changes after this frame — it is what turns anybody's `Owner` into a
        // name and a colour on their ring. A player holds it too: they have to
        // be able to read who pinged, and they were offered these same names at
        // the identity picker.
        welcome.roster,
        // And what each of those names picked to be drawn in, which the roster
        // alone no longer answers. Passed as the object rather than the table:
        // it is read every frame and somebody may change their mind between two
        // of them.
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
      // this is the only chance to learn it — nothing on the wire says where a
      // drag started, and the next frame has already moved the token.
      const from =
        move.staged && token.stagedPos !== null ? token.stagedPos : { x: token.x, y: token.y };
      if (move.dragging) {
        rulers.seen(move.id, from, move.staged, performance.now());
      } else {
        // The drop. Ours never reaches here — the server does not echo our own
        // drag frames — and input.ts has already ended that one on pointerup.
        rulers.end(move.id, performance.now());
      }

      // The server is authoritative, including over our own prediction.
      // Mid-drag frames for the token we are dragging are never sent back to
      // us, so this is either someone else's move or our own settled drop.
      //
      // The flag says which of the token's two positions this frame is about.
      // Missing it is how a plan for the next map gets written into the board
      // the table is looking at.
      if (move.staged) {
        token.stagedPos = { x: move.x, y: move.y };
      } else {
        token.x = move.x;
        token.y = move.y;
      }
    },

    onTokenChanged: (wire) => {
      if (room === null) return;
      // An id this client has not seen is the creation; anything else is an
      // edit. Either way the server's copy replaces whatever we had.
      upsertToken(room.scene, wire);
      stage?.loadArt();
      afterTokens(room);
    },

    onTokenRemoved: (id) => {
      if (room === null) return;
      removeToken(room.scene, id);
      // Deleted, or just hidden from us mid-drag. Either way there is no longer
      // a token for a ruler to measure to — and no trail to leave behind, which
      // is why this forgets rather than ending: a fading line pointing into the
      // dark is a line saying where something went.
      rulers.forget(id);
      afterTokens(room);
    },

    onMapChanged: (map) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;
      const newImage = scene.live.mapUrl !== map.url;

      // Replaced rather than mutated field by field so the render loop can never
      // read a half-applied grid. Tokens are untouched: they are stored in grid
      // units, so recalibrating moves where they draw, not which cell they are
      // in — invariant 1.
      scene.live = boardFromWire(map);
      mapTool?.update(scene);
      // The two fog fields ride on the map, so this is also how the panel learns
      // the switch was flipped — including by the DM's other tab.
      fogTool?.update(scene);
      // And how the token panel's light box learns it, for the same reason.
      tokenTool?.update(scene);
      afterBoardChanged(wasShowing, newImage);
    },

    // Reaches everyone, unlike the staged map below it and like the fog: the DM
    // decides whether the board is labelled and every board is labelled that way
    // afterwards, which is the whole of what the switch means. The renderer reads
    // it straight off the scene, so there is nothing to redraw by hand — only the
    // checkbox that has to follow the room, including when it was the DM's other
    // tab that moved it.
    onNamesChanged: (show) => {
      if (room === null) return;
      room.scene.showNames = show;
      tableTool?.update(room.scene);
    },

    // The frame above's twin, and nothing more: the ruler reads the convention
    // off the scene every time it draws, so a reading already on screen changes
    // on the next frame without anything here recomputing it.
    // Pointers are on or off for the whole table now. The scene field is read by
    // the renderer *and* by `input.ts`, which stops sending ours the moment this
    // says so — the switch is a dial on the traffic, not a preference about
    // drawing.
    onCursorsChanged: (show) => {
      if (room === null) return;
      room.scene.showCursors = show;
      // Whatever is already on the board would otherwise sit there for the
      // couple of seconds its decay takes, which reads as the switch not having
      // worked.
      if (!show) cursors.clear();
      tableTool?.update(room.scene);
    },

    // The frame above narrowed to one hand, and the arm is shorter by
    // everything that made that one long: there is nothing already on our board
    // to clear, because the DM's pointer is withheld by the room rather than
    // declined by us, and nothing here decides what we send. A player holds this
    // and does nothing with it; what reads it back is the DM's own panel.
    onDmCursorChanged: (show) => {
      if (room === null) return;
      room.scene.showDmCursor = show;
      tableTool?.update(room.scene);
    },

    onDiagonalsChanged: (diagonals) => {
      if (room === null) return;
      room.scene.diagonals = diagonals;
      tableTool?.update(room.scene);
    },

    // A picture went up in front of the table, or came down. **Nothing about
    // the board is touched here and nothing needs to be** — the map, the walls,
    // the drawings and everywhere the party has explored are all still exactly
    // what they were, waiting behind it. That is the entire feature, and this
    // handler being this short is what it looks like from the client.
    onBackdropChanged: (url) => {
      if (room === null) return;
      room.scene.backdrop = url;
      stage?.reloadBackdrop();
      tableTool?.update(room.scene);
    },

    // Never reaches a player: the server sends this frame to the DM alone.
    onStagedChanged: (board) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;
      const newImage = board !== null && scene.staged?.mapUrl !== board.url;

      // The whole slot at once, masonry and paint included. That is what makes
      // a staged load sweeping its walls and a staged recalibration dropping
      // its paint arrive with no frames of their own — there is one frame
      // describing the slot, so there is one place to apply it.
      scene.staged = stagedFromWire(board);
      // Leaves preview mode when the slot has emptied — promoted or discarded —
      // and reports it, which is what puts the token panel back.
      mapTool?.update(scene);
      // Both read the board on screen, and the slot they are reading may have
      // just been swept out from under them.
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
      // both carry an initiative too and both go the other way — see `turn.ts`.
      turn?.update(initiative, room.scene);
    },

    // Somebody joined or left. Reaches everyone and is filtered by nobody: this
    // is the one thing in the room that is not about the room.
    onPresence: (here) => {
      presence?.here(here);
      // A destination chip dims for somebody who is not connected, which is the
      // specific failure the strip exists to prevent — whispering an empty
      // chair.
      chat?.repaint();
    },

    // A player picked. Everybody is told, this client included if it was ours:
    // nothing here is predicted locally, so the frame is how our own swatch
    // settles.
    onColoursChanged: (colours) => {
      presence?.picked(colours);
      // The log is written in its senders' colours, and half a conversation in
      // yesterday's colours attributes it to the wrong person.
      chat?.repaint();
    },

    // Somebody else's sweep. Never our own — the server does not echo it, for
    // the same reason it does not echo our drag frames.
    onSketch: (frame) => {
      sketches.seen(frame.by, {
        kind: frame.kind,
        at: frame.at,
        to: frame.to,
        color: frame.color,
      });
    },

    // Released, or that client vanished mid-sweep and the room said so. Nothing
    // here has to expire on a timer, which is the one way this is simpler than
    // the movement ruler.
    onSketchEnded: (by) => sketches.ended(by),

    // Somebody pointed at something. Never our own, which has been on our board
    // since the hold was 150ms old and would restart if this echoed it back.
    //
    // Nothing is checked here and there is nothing to check: a ping carries a
    // position and a sender, and the room decided it may land wherever it was
    // pointed. It is the one frame this client is handed that no filter on
    // either side of the wire has touched.
    onPinged: (ping) => pings?.add(ping.by, ping.at, performance.now()),

    // Somebody's hand moved. Never our own, and nothing to check on arrival —
    // this is the frame the room *has* already filtered, so what lands here is
    // what may be drawn. A person's previous pointer is replaced rather than
    // added to, and stillness rather than any frame is what ends one.
    onCursorMoved: (cursor) => cursors.moved(cursor.by, cursor.at, performance.now()),

    // Somebody said something we are party to — including ourselves, which is
    // the one relayed frame the sender is echoed. Nothing about a line of text
    // is predicted locally: a log is a sequence, and where a line lands in it is
    // the room's to decide.
    onSaid: (line) => chat?.said(line),

    // Our own box, changed in another tab of ours — the only reason this frame
    // exists. It is never anybody else's: nothing on the wire can carry one,
    // which is what makes this the shortest handler in the file.
    onNotesChanged: (text) => notes?.changed(text),

    // The whole list, replacing whatever we held. Nothing is predicted locally:
    // a shape's id is the server's to invent, and an erase is a click rather
    // than a drag, so there is no round trip anybody can feel.
    onShapesChanged: (shapes) => {
      if (room === null) return;
      room.scene.shapes = shapes.map(shapeFromWire);
    },

    // Never reaches a player: the server sends this frame to the DM alone. The
    // whole list, replacing whatever we held — nothing here is predicted
    // locally, because a segment's id is the server's to invent and a run is
    // finished with a click rather than dragged.
    onWallsChanged: (walls, staged) => {
      if (room === null) return;
      const scene = room.scene;
      const traced = walls.map(wallFromWire);
      // The frame names its own slot rather than this inferring one from what
      // is on screen. A promote can move the board out from under a frame in
      // flight, and inferring would then write the next dungeon's masonry onto
      // the one the table is looking at.
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

    // Reaches everyone, unlike the walls above — fog is party-shared, so the DM
    // and the table are sent the same frame and it is only how faintly it draws
    // that differs. Rebuilt into a canvas here rather than per frame: a fogged
    // board is a few thousand cells, and the renderer stretches one image over
    // them instead of filling that many rectangles sixty times a second.
    //
    // Nothing here decides who is drawn. A creature the table cannot see is
    // absent from the token list entirely, which is invariant 4 — this is the
    // terrain, and it arrives beside that rather than instead of it.
    onFogChanged: (fog) => {
      if (room === null) return;
      room.scene.fog = fogFromWire(fog, identity.isDm);
    },

    // Never reaches a player: the walls' rule rather than the fog's, because
    // this is what the DM *decided* and the frame above is what the table gets
    // to see of it. Rebuilt into its own little canvas here for the reason the
    // fog is — a filled dungeon room is a few thousand cells.
    onOverridesChanged: (overrides, staged) => {
      if (room === null) return;
      const painted = overridesFromWire(overrides);
      // Named by the frame, for the reason the walls above are.
      if (staged) {
        if (room.scene.staged !== null) room.scene.staged.overrides = painted;
      } else {
        room.scene.overrides = painted;
      }
    },

    // The DM undid something. The whole room, replacing everything we hold.
    //
    // **This is `onWelcome`'s second half and deliberately not `onWelcome`.**
    // That one *builds* the panels, the tools and the board, once, on the
    // assumption there is exactly one Welcome per socket — running it again
    // would construct a second of each, register a second keydown listener for
    // every tool, and hand the DM a fresh camera at the moment they are looking
    // at what they just undid. So the state is adopted in place instead, and
    // everything that was built on connect is told to re-read it.
    onRestored: (view) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;

      // In place: the board captured this object when it started and draws from
      // it every frame, so assigning a new one over `room.scene` would leave the
      // renderer on the old world. `previewing` survives, which the type of
      // `adoptView` enforces rather than this remembering.
      adoptView(scene, view, identity.isDm);
      room.initiative = view.initiative;
      // Seeded, never fired: a restore mid-combat that nudged six people for a
      // turn that did not move is worse than the feature is good.
      turn?.adopt(view.initiative);
      // Carried on the view like everything else, so the undo is right here for
      // free. Neither can actually have changed — an undo does not disconnect
      // anybody, and a colour is exempt from the ring — which is exactly why
      // adopting them costs nothing and forgetting to would be a trap the day
      // one of those stops being true.
      presence?.here(view.here);
      presence?.picked(view.colours);
      chat?.repaint();

      // A ruler measuring to a token the restore removed is a line pointing at
      // where something went, which is the argument `onTokenRemoved` already
      // makes. Sketches and pings are left alone: both are somebody's hand on a
      // mouse right now and neither is in the room to be restored.
      rulers.forgetExcept(new Set(scene.tokens.map((t) => t.id)));

      // An undo can put the cursor switch back, and the pointers already drawn
      // are not the room's to restore — same line the delta above runs.
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
      // restored to was calibrated when it was first loaded, and the answer came
      // back in this very frame.
      afterBoardChanged(wasShowing, false);
      // An undo can put a backdrop up or take one down like any other step.
      stage?.reloadBackdrop();
    },

    // Only ever called on a DM connection.
    onUndoChanged: (label) => undo?.update(label),

    onError: (message) => {
      console.warn('server rejected a command:', message);
      flash(ui.banner, message);
    },

    // The socket dropped and net.ts is trying again. The board is frozen from
    // here — the room went on without us — so it says so, and the class that
    // greys the boxes that can no longer reach the room goes on now rather than
    // when the retries run out.
    onLost: () => {
      document.body.classList.add('offline');
      ui.picker.hidden = true;
      // `body.offline` greys the scratchpad and takes its pointer events, which
      // is not the same as letting go of it: a caret already in the box keeps
      // taking keystrokes, and the reconnect is a page reload, so a paragraph
      // typed after the socket died is lost with nothing said. Blurring both
      // flushes what the debounce is holding — while the socket may still be
      // open — and puts the box beyond the keyboard.
      ui.notes.text.blur();
      ui.banner.textContent = 'connection lost — reconnecting…';
      ui.banner.hidden = false;
    },

    // And they ran out. The floor this client has always had, reached rather
    // than reached for immediately.
    onClose: () => {
      document.body.classList.add('offline');
      ui.picker.hidden = true;
      ui.panel.root.hidden = true;
      ui.banner.textContent = 'disconnected — refresh to rejoin';
      ui.banner.hidden = false;
    },
  });
}

function showWhoami(ui: Ui, identity: Identity, choice: RoomChoice, tokens: WireToken[]): void {
  if (identity.isDm) {
    ui.whoamiName.textContent = `DM · ${choice.name}`;
  } else {
    // Prefer the character's display name over the raw slot id.
    const own = tokens.find((t) => t.owner.kind === 'player' && t.owner.id === identity.playerId);
    ui.whoamiName.textContent = `${own?.name ?? identity.playerId ?? '—'} · ${choice.name}`;
  }
  // **The DM has one too, and it says what it does.** It used to be hidden on
  // the argument that they have no character to switch to — true, and it was
  // never the whole job of the button: half of it is the *room*, and the chip
  // beside it says which room they are in. With the room and the secret both
  // remembered, a DM who wanted the other campaign had no way back to the
  // picker but hand-editing `?room=` onto the URL with an id nothing on the
  // screen tells them. The reason that did hold — that the reload this works by
  // came back anonymous — was fixed when `takeDmSecret` started remembering the
  // secret, which is what makes showing it safe now.
  ui.whoamiSwitch.textContent = identity.isDm ? 'switch room' : 'switch';
  ui.whoamiSwitch.hidden = false;
  ui.whoami.hidden = false;
}

/** The running board, for the few things that have to reach into it later. */
interface Stage {
  /**
   * Loads the image for whichever board is shown now, then refits the camera to
   * it. `onLoaded` runs once that image is actually on screen — which is the
   * first moment its pixel dimensions are known.
   */
  reloadMap(onLoaded?: () => void): void;
  /**
   * Re-reads `shownBackdrop` and fetches the picture if it changed.
   *
   * Called wherever the answer could have moved rather than wherever a backdrop
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
   * Puts a token in the middle of the viewport. `viewCentre`'s inverse, and it
   * is here for the same reason: the camera belongs to the board and nothing
   * outside it should be holding one.
   *
   * A no-op for a token with no position on the board on screen — one staged for
   * the next map, asked for from a panel that is looking at this one.
   */
  lookAt(token: Token): void;
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

  // Two maps at most — the board and whatever is staged — but cached by URL like
  // the token art, so toggling in and out of preview does not re-fetch several
  // megabytes each time. Promises rather than images: a promise is the answer
  // whether or not it has arrived, so two callers asking at once share one
  // download instead of racing.
  const mapImages = new Map<string, Promise<HTMLImageElement>>([[firstUrl, Promise.resolve(map)]]);
  const fetchMap = (url: string): Promise<HTMLImageElement> => {
    let arriving = mapImages.get(url);
    if (arriving === undefined) {
      arriving = loadImage(url);
      mapImages.set(url, arriving);
      // A failure is not an answer worth keeping — the next attempt should try.
      arriving.catch(() => mapImages.delete(url));
    }
    return arriving;
  };

  /**
   * The picture in front of the board, once it has arrived, and the URL it came
   * from.
   *
   * Two variables rather than one because they answer different questions and
   * the gap between them is a real state: `backdropUrl` is what should be up,
   * `backdrop` is what can actually be drawn. Between the DM's click and the
   * download landing the board is still what is on screen, which is better than
   * a black window.
   *
   * It shares `fetchMap`'s cache, since a backdrop is another large image
   * fetched by URL and toggling one on and off twice in an evening should not
   * fetch it twice.
   */
  let backdrop: HTMLImageElement | null = null;
  let backdropUrl: string | null = null;

  // Keyed by URL rather than by token, so re-arting a token finds the new
  // picture and two goblins sharing a portrait share one download. Portraits
  // stream in; render.ts draws a placeholder disc for any that have not
  // arrived, so a slow or broken image never blocks the map.
  const tokenImages = new Map<string, HTMLImageElement>();
  // Only holds *loaded* images, so the renderer can draw anything it finds
  // there. What is merely in flight is tracked separately.
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
          // Selection and nothing else. This used to open the token tab on the
          // argument that picking a token up is the request to edit it, and the
          // argument was wrong about which thing is scarce: the rail is where
          // the DM is working, and swapping the panel out from under a trace to
          // show a form they did not ask for costs more than the click it saved.
          // The selection is still visible either way — it is a ring on the
          // board, which is what the panel's own `stop` relies on.
          tokenTool.select(id);
        },
    rulers,
    drawTool,
    sketches,
    wallTool,
    fogTool,
    pings,
  );

  const stage: Stage = {
    reloadMap(onLoaded) {
      const url = shownBoard(scene).mapUrl;
      // Already up. The callback still runs: it is the prompt to size a grid,
      // not a redraw, and it is owed to whoever asked.
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
          // A different image is a different battle, and it may be a completely
          // different size — showing all of it beats holding the old camera.
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
      // Dropped rather than kept, so the frame loop cannot draw the *previous*
      // picture during the moment between one being chosen and it arriving.
      backdrop = null;
      if (url === null) return;

      fetchMap(url).then(
        (img) => {
          // A newer answer may have landed while this was downloading —
          // including the DM taking it down again, which is `backdropUrl` back
          // to null and this image no longer wanted.
          if (shownBackdrop(scene) !== url) return;
          backdrop = img;
        },
        // Leaves the board on screen, which is the honest failure: the DM can
        // see their pick did not take, and the table never went black.
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
  };

  let lastHud = '';
  /** What the body class was last set to, so it is written only on a change. */
  let lastCovered = false;
  /**
   * The solo wash, rebuilt only when the answer could have changed.
   *
   * A raycast over the reach of one torch is a few hundred cells against the
   * walls within it, which is affordable once and not sixty times a second. The
   * five things it depends on are compared rather than hashed, and two of them
   * are compared *by reference* on purpose: `scene.walls` and `scene.live` are
   * both replaced wholesale by their deltas rather than mutated field by field,
   * so identity is an exact answer to "did this change" and a cheap one.
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
    // Live board only — nothing raycasts a map the table has not been shown, so
    // the panel greys this over a preview and there is nothing to draw if the DM
    // gets there anyway.
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
    // The table's shade rather than the DM's faint one, which is the same choice
    // `drawFog` makes on the bands around it: this is a question with an answer
    // and the answer has to be legible.
    const fog = wire === null ? null : fogFromWire(wire, false);
    soloCache = { id, x: token.x, y: token.y, walls, board, fog };
    return fog;
  };

  const frame = (): void => {
    const view = syncCanvasSize(ui.canvas);

    // **The picture, instead of the board — not over it.** Everything below is
    // skipped: no world transform, no fog, no tokens, no rulers, no HUD, and
    // therefore nothing that could disagree with a board nobody can see. Read
    // from `backdrop` rather than from the scene, so the board stays up until
    // the image is actually in hand.
    //
    // The class is what stops the canvas *responding*. One line here rather
    // than a guard in every handler in `input.ts`: with pointer events off the
    // canvas there is no pan, no drag, no ping, no door, no sweep and no cursor
    // relay, by construction rather than by remembering.
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
    // into the renderer rather than held as a second scene, because a copy that
    // outlived a frame would be a second thing to keep in step with the deltas —
    // and the thing it is a copy of changes on every drag frame. Everything
    // outside this call, `input.ts` included, goes on reading the room's own:
    // the mirror is what the DM is looking at, not what they are working on.
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
      // Swept here rather than in the renderer: a client that vanished mid-drag
      // sends no drop frame, and nothing else in a frame is watching a clock.
      rulers: rulers.active(now),
      // Not swept for staleness the way the rulers are: a sweep ends on its
      // release frame or on the `sketch_ended` the room sends when a socket
      // closes, so there is no case left for a clock to catch.
      sketches: sketches.all(),
      // Swept here like the rulers, and for a stricter version of their reason:
      // a ring's whole life is a clock. Nothing ends one — no release frame, no
      // socket closing, nothing the room could say — so this is the only thing
      // that ever takes one off the board. It includes the hold in progress, so
      // the growing preview and the ring it becomes are one drawing.
      pings: pings.active(now),
      // Read per frame like the rings, and expiring the same way: whoever has
      // gone still since the last frame is simply not in this array.
      cursors: cursors.active(now),
      roster,
      // Read per frame, not captured: a ring already on the board changes colour
      // on the next frame when its owner picks a new one, with nothing here
      // recomputing anything.
      colours: presence.colours,
      hoveredShapeId: input.hoveredShapeId,
      selectedId: tokenTool?.selectedId ?? null,
      selection: input.selection,
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
  // And the room may have had a picture up all along, which is what a page
  // joining mid-campfire finds.
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
 * ratio. Called every frame — it is a no-op unless something actually changed,
 * and it covers window resizes and monitor-to-monitor DPR changes alike.
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
  cam.zoom = Math.min(view.width / mapW, view.height / mapH, 1);
  cam.x = mapW / 2 - view.width / (2 * cam.zoom);
  cam.y = mapH / 2 - view.height / (2 * cam.zoom);
}

/**
 * Puts a world point in the middle of the viewport, at whatever zoom is already
 * set.
 *
 * `fitToMap`'s sibling with the zoom left alone, deliberately: this is asked for
 * mid-fight by somebody who wants to *look* at something, and changing how far
 * in they are zoomed is a second thing they did not ask for.
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

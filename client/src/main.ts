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
  readStoredPlayerId,
  storePlayerId,
  takeDmSecretFromUrl,
} from './identity.js';
import { attachInput } from './input.js';
import type { MapTool } from './maptool.js';
import { createMapTool } from './maptool.js';
import type { Rail } from './rail.js';
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
import type { Pings } from './pings.js';
import { createPings } from './pings.js';
import type {
  ClientMsg,
  Initiative,
  RosterEntry,
  TokenMoved,
  WireToken,
} from './protocol.js';
import type { Viewport } from './render.js';
import { render } from './render.js';
import type { Rulers } from './ruler.js';
import { createRulers } from './ruler.js';
import type { Board, Scene, Token } from './scene.js';
import {
  adoptView,
  boardFromWire,
  stagedFromWire,
  removeToken,
  sceneFromView,
  shownBoard,
  shownPos,
  upsertToken,
} from './scene.js';
import type { Sketches } from './shapes.js';
import { createSketches, shapeFromWire } from './shapes.js';
import type { TokenTool } from './tokens.js';
import { createTokenTool } from './tokens.js';
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
    },
  };
}

/** Live room state. `start` holds this object and reads through it every frame. */
interface Room {
  scene: Scene;
  initiative: Initiative;
}

function boot(): void {
  const ui = findUi();

  // Read and strip the DM secret before anything else can screenshot the URL.
  const dmSecret = takeDmSecretFromUrl();

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
  // DM-only, like the three panels it shows. Null on a player connection, which
  // is why every use of it is optional-chained rather than guarded.
  let rail: Rail | null = null;
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
  // And a third time for the rings — except that this one cannot be built until
  // Welcome, because it has to know whose ring ours is.
  let pings: Pings | null = null;

  const picker = createPicker(ui.picker, (playerId) => {
    // Not stored yet — only a Welcome proves the server accepted the claim.
    net.send({ type: 'hello', dm_secret: null, player_id: playerId });
  });

  ui.whoamiSwitch.addEventListener('click', () => {
    forgetPlayerId();
    location.reload();
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

  const net: Net = connect({
    onOpen: () => {
      // A DM link wins over any remembered slot: it is an explicit, deliberate
      // act, and the DM may well have played as a character before.
      net.send({
        type: 'hello',
        dm_secret: dmSecret,
        player_id: dmSecret === null ? readStoredPlayerId() : null,
      });
    },

    onChooseIdentity: (roster) => picker.show(roster),

    onWelcome: (welcome) => {
      picker.hide();
      identity = { isDm: welcome.is_dm, playerId: welcome.player_id };
      if (welcome.player_id !== null) storePlayerId(welcome.player_id);
      showWhoami(ui, identity, welcome.state.tokens);

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
      drawTool = createDrawTool(ui.drawtool, identity.isDm, (msg) => net.send(msg), () =>
        wallTool?.stop(),
      );

      // Built for everyone, like the draw tool above and unlike the rail
      // below: neither of the dock's panels is the DM's. The log the room hands
      // over here is already the one this client is party to — a whisper
      // between two other people is not in it to be filtered.
      chat = createChat(
        ui.chat,
        identity,
        welcome.roster,
        welcome.state.chat,
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
            }
            // No prompt to size the grid — a staged map was offered one when it
            // was staged, and the live map when it arrived.
            stage?.reloadMap();
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
        );
        fogTool.update(room.scene);

        // The two room-wide settings. It arms nothing on the canvas and it is
        // never inert, so unlike the four above it it needs neither a `stop()`
        // nor a rule about greying its tab.
        tableTool = createTableTool(ui.tabletool, (msg) => net.send(msg));
        tableTool.update(room.scene);

        // Last, because it owns whether the five above are on screen and has to
        // be able to put each of them down as it closes it. The order here is
        // the order of the tabs. Fog gained a `stop` in 16b: it used to arm
        // nothing, and the brush is a tool holding the left button like any
        // other — one left under a hidden panel is a click doing something with
        // nothing on screen saying why.
        rail = createRail(ui.rail, [
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
          // Last on the strip: the least-touched panel during play. No `stop`,
          // because two checkboxes arm nothing.
          { tab: 'table', label: 'table', root: ui.tabletool.root },
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
        rail,
        pings,
        // The cast list, which every connection is sent and which nothing
        // changes after this frame — it is what turns anybody's `Owner` into a
        // name and a colour on their ring. A player holds it too: they have to
        // be able to read who pinged, and they were offered these same names at
        // the identity picker.
        welcome.roster,
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
    onDiagonalsChanged: (diagonals) => {
      if (room === null) return;
      room.scene.diagonals = diagonals;
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
      afterBoardChanged(wasShowing, newImage);
    },

    onInitiativeChanged: (initiative) => {
      if (room === null || panel === null) return;
      room.initiative = initiative;
      panel.update(initiative, room.scene);
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

      // A ruler measuring to a token the restore removed is a line pointing at
      // where something went, which is the argument `onTokenRemoved` already
      // makes. Sketches and pings are left alone: both are somebody's hand on a
      // mouse right now and neither is in the room to be restored.
      rulers.forgetExcept(new Set(scene.tokens.map((t) => t.id)));

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
    },

    // Only ever called on a DM connection.
    onUndoChanged: (label) => undo?.update(label),

    onError: (message) => {
      console.warn('server rejected a command:', message);
      flash(ui.banner, message);
    },

    onClose: () => {
      document.body.classList.add('offline');
      ui.picker.hidden = true;
      ui.panel.root.hidden = true;
      ui.banner.textContent = 'disconnected — refresh to rejoin';
      ui.banner.hidden = false;
    },
  });
}

function showWhoami(ui: Ui, identity: Identity, tokens: WireToken[]): void {
  if (identity.isDm) {
    ui.whoamiName.textContent = 'DM';
    ui.whoamiSwitch.hidden = true;
  } else {
    // Prefer the character's display name over the raw slot id.
    const own = tokens.find((t) => t.owner.kind === 'player' && t.owner.id === identity.playerId);
    ui.whoamiName.textContent = own?.name ?? identity.playerId ?? '—';
    ui.whoamiSwitch.hidden = false;
  }
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
  rail: Rail | null,
  pings: Pings,
  roster: readonly RosterEntry[],
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
          tokenTool.select(id);
          // The mirror of the rule below, that a panel describing something not
          // on screen is a panel lying: picking a token up off the board is the
          // request to edit it, so the tab that edits it opens. Deselecting is
          // not the request to close anything — the DM clicks empty map for all
          // sorts of reasons — so only a real selection opens it.
          if (id !== null) rail?.show('token');
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
    // Read once and passed down, so the sweep below and the fade the renderer
    // draws cannot disagree about what time it is within one frame.
    const now = performance.now();
    render(ui.ctx, view, {
      cam,
      scene,
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
      roster,
      hoveredShapeId: input.hoveredShapeId,
      selectedId: tokenTool?.selectedId ?? null,
      selection: input.selection,
      currentTurn: room.initiative.current,
      calibration:
        mapTool !== null && mapTool.box !== null
          ? { box: mapTool.box, cells: mapTool.cells }
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

boot();

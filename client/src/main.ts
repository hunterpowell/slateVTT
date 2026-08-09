import type { Camera, Vec2 } from './coords.js';
import { screenToWorld, worldToGrid } from './coords.js';
import type { DrawTool } from './drawtool.js';
import { createDrawTool } from './drawtool.js';
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
import type { Net } from './net.js';
import { connect } from './net.js';
import type { Panel } from './panel.js';
import { createPanel } from './panel.js';
import { createPicker } from './picker.js';
import type { ClientMsg, Initiative, TokenMoved, WireToken } from './protocol.js';
import type { Viewport } from './render.js';
import { render } from './render.js';
import type { Rulers } from './ruler.js';
import { createRulers } from './ruler.js';
import type { Scene } from './scene.js';
import { boardFromWire, removeToken, sceneFromView, shownBoard, upsertToken } from './scene.js';
import type { Sketches } from './shapes.js';
import { createSketches, shapeFromWire } from './shapes.js';
import type { TokenTool } from './tokens.js';
import { createTokenTool } from './tokens.js';
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
  };
  rail: {
    tabs: HTMLElement;
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
    vision: HTMLInputElement;
    visionDown: HTMLButtonElement;
    visionUp: HTMLButtonElement;
    hint: HTMLElement;
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
    save: HTMLButtonElement;
    remove: HTMLButtonElement;
    fresh: HTMLButtonElement;
    hint: HTMLElement;
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
    },
    rail: {
      tabs: need('#rail-tabs'),
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
      vision: need<HTMLInputElement>('#fog-vision'),
      visionDown: need<HTMLButtonElement>('#fog-vision-down'),
      visionUp: need<HTMLButtonElement>('#fog-vision-up'),
      hint: need('#fog-hint'),
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
      save: need<HTMLButtonElement>('#token-save'),
      remove: need<HTMLButtonElement>('#token-delete'),
      fresh: need<HTMLButtonElement>('#token-new'),
      hint: need('#token-hint'),
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
  // DM-only, like the three panels it shows. Null on a player connection, which
  // is why every use of it is optional-chained rather than guarded.
  let rail: Rail | null = null;
  let identity: Identity = ANONYMOUS;
  // Outlives any one drag and is fed from both directions — our own pointer in
  // input.ts, and everyone else's drag frames below.
  const rulers = createRulers();
  // The same arrangement for sweeps: ours goes in from input.ts, everyone
  // else's from the frames below.
  const sketches = createSketches();

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

      // Exactly one Welcome per connection — identity cannot change once set —
      // so this runs once. Assigned synchronously so a delta arriving straight
      // after Welcome cannot land in a gap where the room does not exist yet.
      room = {
        scene: sceneFromView(welcome.state, identity.isDm),
        initiative: welcome.state.initiative,
      };
      panel = createPanel(ui.panel, identity, (msg) => net.send(msg));
      panel.update(room.initiative, room.scene);

      // Built for everyone, unlike the two panels below it. Anyone may draw —
      // this is the first thing a player can add to the room, and the only
      // thing that differs by identity here is the clear-all button.
      drawTool = createDrawTool(ui.drawtool, identity.isDm, (msg) => net.send(msg), () =>
        wallTool?.stop(),
      );

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
            // The staged map has no shapes, so a tool left armed over it would
            // sit there looking like it could do something. Put it away for the
            // same reason the token selection goes — and the wall editor with
            // it, which has even less to work on: there are no staged walls.
            drawTool?.stop();
            wallTool?.stop();
            // Nothing to put down — the fog panel arms no tool — but its tab
            // goes inert over a preview and its hint has to say why, so it is
            // told the same as the two above.
            if (room !== null) fogTool?.update(room.scene);
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

        // Both fields are the map's, so they go out as a `set_map` through the
        // panel that owns the confirmed calibration rather than as a frame of
        // their own — two writers for one record is how they come to disagree.
        fogTool = createFogTool(ui.fogtool, (on, visionFt) => mapTool?.setFog(on, visionFt));
        fogTool.update(room.scene);

        // Last, because it owns whether the four above are on screen and has to
        // be able to put each of them down as it closes it. The order here is
        // the order of the tabs. Fog is the fourth, and the one with nothing to
        // put down: it arms no tool, because the party's tokens are what move it.
        rail = createRail(ui.rail, [
          { tab: 'map', label: 'map', root: ui.maptool.root, stop: () => mapTool?.stop() },
          // Nothing to put down: a selection is a ring on the board, which is
          // still on screen with the panel closed.
          { tab: 'token', label: 'token', root: ui.tokentool.root },
          { tab: 'walls', label: 'walls', root: ui.walltool.root, stop: () => wallTool?.stop() },
          { tab: 'fog', label: 'fog', root: ui.fogtool.root },
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
        rail,
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
        rulers.end(move.id);
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
      // a token for a ruler to measure to.
      rulers.end(id);
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

    // Never reaches a player: the server sends this frame to the DM alone.
    onStagedChanged: (map) => {
      if (room === null) return;
      const scene = room.scene;
      const wasShowing = shownBoard(scene).mapUrl;
      const newImage = map !== null && scene.staged?.mapUrl !== map.url;

      scene.staged = map === null ? null : boardFromWire(map);
      // Leaves preview mode when the slot has emptied — promoted or discarded —
      // and reports it, which is what puts the token panel back.
      mapTool?.update(scene);
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
    onWallsChanged: (walls) => {
      if (room === null) return;
      room.scene.walls = walls.map(wallFromWire);
      wallTool?.update(room.scene);
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
  rail: Rail | null,
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
  };

  let lastHud = '';
  const frame = (): void => {
    const view = syncCanvasSize(ui.canvas);
    render(ui.ctx, view, {
      cam,
      scene,
      identity,
      map,
      tokenImages,
      draggingId: input.draggingId,
      // Swept here rather than in the renderer: a client that vanished mid-drag
      // sends no drop frame, and nothing else in a frame is watching a clock.
      rulers: rulers.active(performance.now()),
      // Not swept for staleness the way the rulers are: a sweep ends on its
      // release frame or on the `sketch_ended` the room sends when a socket
      // closes, so there is no case left for a clock to catch.
      sketches: sketches.all(),
      hoveredShapeId: input.hoveredShapeId,
      selectedId: tokenTool?.selectedId ?? null,
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

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.addEventListener('load', () => resolve(img));
    img.addEventListener('error', () => reject(new Error(`could not load ${url}`)));
    img.src = url;
  });
}

boot();

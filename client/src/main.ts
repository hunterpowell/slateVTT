import type { Camera, Vec2 } from './coords.js';
import { screenToWorld, worldToGrid } from './coords.js';
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
import type { Net } from './net.js';
import { connect } from './net.js';
import type { Panel } from './panel.js';
import { createPanel } from './panel.js';
import { createPicker } from './picker.js';
import type { ClientMsg, Initiative, TokenMoved, WireToken } from './protocol.js';
import type { Viewport } from './render.js';
import { render } from './render.js';
import type { Scene } from './scene.js';
import { boardFromWire, removeToken, sceneFromView, shownBoard, upsertToken } from './scene.js';
import type { TokenTool } from './tokens.js';
import { createTokenTool } from './tokens.js';

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
  tokentool: {
    root: HTMLElement;
    head: HTMLElement;
    name: HTMLInputElement;
    size: HTMLSelectElement;
    owner: HTMLSelectElement;
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
    tokentool: {
      root: need('#tokentool'),
      head: need('#token-head'),
      name: need<HTMLInputElement>('#token-name'),
      size: need<HTMLSelectElement>('#token-size'),
      owner: need<HTMLSelectElement>('#token-owner'),
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
  let identity: Identity = ANONYMOUS;

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
      room = { scene: sceneFromView(welcome.state), initiative: welcome.state.initiative };
      panel = createPanel(ui.panel, identity, (msg) => net.send(msg));
      panel.update(room.initiative, room.scene);

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
            // What is on screen is no longer the board, so nothing on it is a
            // piece: the token panel goes away and any selection with it.
            document.body.classList.toggle('previewing', previewing);
            tokenTool?.select(null);
            ui.tokentool.root.hidden = previewing;
            // No prompt to size the grid — a staged map was offered one when it
            // was staged, and the live map when it arrived.
            stage?.reloadMap();
          },
        );
        mapTool.update(room.scene);
        ui.maptool.root.hidden = false;

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
        ui.tokentool.root.hidden = false;
      }

      void start(ui, room, identity, (msg) => net.send(msg), mapTool, tokenTool).then(
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
      // The server is authoritative, including over our own prediction.
      // Mid-drag frames for the token we are dragging are never sent back to
      // us, so this is either someone else's move or our own settled drop.
      token.x = move.x;
      token.y = move.y;
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
    tokenTool === null ? null : (id) => tokenTool.select(id),
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
      selectedId: tokenTool?.selectedId ?? null,
      currentTurn: room.initiative.current,
      calibration:
        mapTool !== null && mapTool.box !== null
          ? { box: mapTool.box, cells: mapTool.cells }
          : null,
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

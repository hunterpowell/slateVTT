import type { Camera } from './coords.js';
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
import { sceneFromView } from './scene.js';

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
        );
        mapTool.update(room.scene);
        ui.maptool.root.hidden = false;
      }

      void start(ui, room, identity, (msg) => net.send(msg), mapTool).then(
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

    onMapChanged: (map) => {
      if (room === null) return;
      const newImage = room.scene.mapUrl !== map.url;

      room.scene.mapUrl = map.url;
      // Replaced rather than mutated field by field so the render loop can never
      // read a half-applied grid. Tokens are untouched: they are stored in grid
      // units, so recalibrating moves where they draw, not which cell they are
      // in — invariant 1.
      room.scene.grid = { px: map.grid_px, offsetX: map.offset_x, offsetY: map.offset_y };
      room.scene.gridColor = map.grid_color;
      room.scene.playArea = map.play_area;
      mapTool?.update(room.scene);

      // Only a new image needs fetching; the grid is read fresh every frame.
      // If the board has not finished starting, `start` is already loading from
      // `scene.mapUrl` and will pick this up on its own.
      //
      // A new image also means the grid inherited from the last one is
      // meaningless, so the DM is asked to size it — once the image has loaded
      // and its dimensions are known.
      if (newImage) stage?.reloadMap(() => mapTool?.proposeWholeMap());
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
   * Loads whatever `scene.mapUrl` now points at, then refits the camera to it.
   * `onLoaded` runs once the new image is actually on screen — which is the
   * first moment its pixel dimensions are known.
   */
  reloadMap(onLoaded?: () => void): void;
  /** Pixel size of the map image currently on screen. */
  naturalSize(): { width: number; height: number };
}

async function start(
  ui: Ui,
  room: Room,
  identity: Identity,
  send: (msg: ClientMsg) => void,
  mapTool: MapTool | null,
): Promise<Stage> {
  const { scene } = room;
  const firstUrl = scene.mapUrl;
  let map = await loadImage(firstUrl);

  // Portraits stream in; render.ts draws a placeholder disc for any that have
  // not arrived, so a slow or broken image never blocks the map.
  const tokenImages = new Map<string, HTMLImageElement>();
  for (const token of scene.tokens) {
    loadImage(token.img).then(
      (img) => tokenImages.set(token.id, img),
      (err: unknown) => console.warn(`token ${token.id}:`, err),
    );
  }

  const cam: Camera = { x: 0, y: 0, zoom: 1 };
  fitToMap(cam, syncCanvasSize(ui.canvas), map.width, map.height);

  const input = attachInput(ui.canvas, cam, scene, identity, send, mapTool);

  const stage: Stage = {
    reloadMap(onLoaded) {
      const url = scene.mapUrl;
      loadImage(url).then(
        (img) => {
          // A newer map may have arrived while this one was downloading.
          if (scene.mapUrl !== url) return;
          map = img;
          // A different image is a different battle, and it may be a completely
          // different size — showing all of it beats holding the old camera.
          fitToMap(cam, syncCanvasSize(ui.canvas), map.width, map.height);
          onLoaded?.();
        },
        (err: unknown) => console.warn(err),
      );
    },
    naturalSize: () => ({ width: map.width, height: map.height }),
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
  if (scene.mapUrl !== firstUrl) stage.reloadMap();
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

import type {
  ClientMsg,
  Colours,
  Diagonals,
  Initiative,
  Owner,
  RosterEntry,
  RosterSlot,
  ServerMsg,
  TokenMoved,
  Welcome,
  WireFog,
  WireMapInfo,
  WireOverrides,
  WireShape,
  WireChatLine,
  WireStaged,
  WireRoomView,
  WireToken,
  WireWall,
} from './protocol.js';

export interface Handlers {
  /** Send the Hello frame from here: the socket is ready and nothing else has been sent. */
  onOpen(): void;
  /** The server does not know who we are; it has sent the roster and no state. */
  onChooseIdentity(roster: RosterSlot[]): void;
  /** Called synchronously on the Welcome frame, before any delta can be handled. */
  onWelcome(welcome: Welcome): void;
  onTokenMoved(move: TokenMoved): void;
  /** A token created or edited. An id we have not seen is a creation. */
  onTokenChanged(token: WireToken): void;
  onTokenRemoved(id: string): void;
  onMapChanged(map: WireMapInfo): void;
  /** The board writes token names under them now, or it stopped. Called on every
   *  connection: the DM sets it, everyone holds it. */
  onNamesChanged(show: boolean): void;
  /** The ruler charges diagonals differently now. Called on every connection,
   *  for the same reason as `onNamesChanged`. */
  onDiagonalsChanged(diagonals: Diagonals): void;
  /** Pointers are drawn on every board now, or they are not. Called on every
   *  connection. Unlike the two above, it changes what this client *sends*,
   *  because with it off the room relays nothing. */
  onCursorsChanged(show: boolean): void;
  /** The DM's pointer is drawn on the players' boards now, or it is not.
   *  Called on every connection. Unlike `onCursorsChanged`, it changes nothing
   *  about what this client sends or draws: the room withholds the DM's frames
   *  itself, so a player only stores it. */
  onDmCursorChanged(show: boolean): void;
  /** There is a picture in front of the table now, or there is not. Called on
   *  every connection. Nothing about the board arrives with it and nothing
   *  needs to: the board is covered, not changed. */
  onBackdropChanged(url: string | null): void;
  /** The room is playing a track now, or it is not. Called on every
   *  connection. Whether this browser plays it is decided in `sound.ts`. */
  onAudioChanged(url: string | null): void;
  /** The whole staged slot: map, walls and paint. Only ever called on a DM
   *  connection; the server sends no such frame to a player. Null means the
   *  slot is now empty. */
  onStagedChanged(board: WireStaged | null): void;
  onInitiativeChanged(initiative: Initiative): void;
  /** Somebody joined or left. The whole list, the DM among them. Called on every
   *  connection and never filtered: who is connected is not secret. */
  onPresence(here: Owner[]): void;
  /** A player picked their colour. The whole table, on every connection,
   *  including the client that picked, which is how its own swatch updates. */
  onColoursChanged(colours: Colours): void;
  /** The DM edited the cast. The whole list, on every connection. */
  onRosterChanged(roster: RosterEntry[]): void;
  /** Somebody else's sweep, keyed by their connection. Never our own. */
  onSketch(sketch: Extract<ServerMsg, { type: 'sketch' }>): void;
  onSketchEnded(by: number): void;
  /** Somebody pinged. Never called for our own, which is already on our board.
   *  Called on every connection and never filtered: a ping is relayed wherever
   *  it lands, unexplored ground included. */
  onPinged(ping: Extract<ServerMsg, { type: 'pinged' }>): void;
  /** Somebody's pointer moved. Never our own, which this client already draws.
   *  Unlike `onPinged` this one *has* been filtered (the DM's pointer over
   *  ground the party has not explored never arrives), so anything that
   *  arrives may be drawn without further checks. */
  onCursorMoved(cursor: Extract<ServerMsg, { type: 'cursor_moved' }>): void;
  /** Somebody said something we are party to, including our own: the one
   *  relayed frame in this protocol that is echoed to its sender. Nothing here
   *  is filtered: the server decided we may hold this line. */
  onSaid(line: WireChatLine): void;
  /** Our own scratchpad changed in another tab of ours. Never called for our
   *  own typing (the room does not echo it, so this cannot move our caret), and
   *  never called with anybody else's box, because no client is ever sent one. */
  onNotesChanged(text: string): void;
  /** Every shape we may see, replacing whatever we held. */
  onShapesChanged(shapes: WireShape[]): void;
  /** Every wall on one board, and which board that is. Only ever called on a DM
   *  connection: a player is sent no such frame, empty or otherwise. */
  onWallsChanged(walls: WireWall[], staged: boolean): void;
  /** What the party can see, or null on an unfogged map. Called on every
   *  connection, unlike the walls: fog is party-shared, so the DM and the table
   *  are sent the same frame. */
  onFogChanged(fog: WireFog | null): void;
  /** The cells the DM has overridden by hand. Only ever called on a DM
   *  connection, like the walls: this is what the DM decided, not what the
   *  table is shown. */
  onOverridesChanged(overrides: WireOverrides, staged: boolean): void;
  /** The DM undid something. Replace the whole room with this view.
   *
   *  Called on every connection, and the one delta that replaces everything
   *  instead of a part. **Not routed to `onWelcome`**: that builds the panels
   *  and the board and must run only once per socket.
   */
  onRestored(state: WireRoomView): void;
  /** What the DM's next undo would take back, or null for nothing. Only ever
   *  called on a DM connection. */
  onUndoChanged(label: string | null): void;
  onError(message: string): void;
  /** The socket dropped and a new one is being tried. May be called several
   *  times as the backoff climbs. */
  onLost(): void;
  /** The socket is not coming back: the backoff gave up. */
  onClose(): void;
}

export interface Net {
  send(msg: ClientMsg): void;
}

/**
 * How long to wait before each attempt, in milliseconds, and how many there
 * are.
 *
 * It climbs so that a laptop lid closed for a minute is not a hundred requests,
 * and it stops so that a machine left open overnight against a server that is
 * gone does not reconnect hours later to a board nobody is looking at. Nine
 * attempts is a little over a minute, which covers the cases this is for: the
 * Pi's service restarting, or the tunnel dropping briefly mid-session.
 */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 8000, 10000, 10000, 10000];

/**
 * One WebSocket to the room, and a fresh one if it drops.
 *
 * **A reconnect here is a `location.reload()`.** `onWelcome` in main.ts builds
 * the pings, the panels, the four tools, the rail and the board once per
 * socket, and assumes one Welcome per socket. A second Welcome would construct
 * a second of each and register another `window` keydown listener per tool.
 * Undo gets around this with `ServerMsg::Restored`; a reconnect doesn't need
 * to, because a refresh is already the supported way back, and this does it
 * without asking the person at the keyboard.
 *
 * So the socket opened in `retry` is a probe. It checks the server is
 * answering and then reloads the page; nothing is sent on it and it has no
 * other handlers.
 *
 * `onClose` is only called once the backoff has given up.
 */
export function connect(roomId: string, on: Handlers): Net {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // **The room is named here and nowhere else on the wire.** A socket belongs
  // to one room actor from the moment the server registers it, so the choice
  // has to be made before the connection, not in a frame after it. That is why
  // no `ClientMsg` or `ServerMsg` names a room. The probe below reuses this
  // URL, so a reconnect returns to the same room.
  const url = `${scheme}//${location.host}/ws?room=${encodeURIComponent(roomId)}`;
  const socket = new WebSocket(url);

  let attempt = 0;
  // Set as soon as a probe answers. A reload is not instant, and the probe's own
  // `close` fires as the page unloads. Without this, that close would schedule
  // one more attempt from a page that is already unloading.
  let reloading = false;

  const retry = (): void => {
    if (reloading) return;
    const wait = BACKOFF_MS[attempt];
    if (wait === undefined) {
      on.onClose();
      return;
    }
    attempt += 1;
    on.onLost();
    window.setTimeout(() => {
      const probe = new WebSocket(url);
      // It answered, so reload. The reloaded page opens its own socket; this
      // one is never used.
      probe.addEventListener('open', () => {
        reloading = true;
        location.reload();
      });
      // It did not. `error` fires before `close` on a failed connect, so
      // scheduling the next attempt from `close` alone runs it once.
      probe.addEventListener('close', () => retry());
      probe.addEventListener('error', () => {
        /* the close that follows is what schedules the next attempt */
      });
    }, wait);
  };

  socket.addEventListener('open', () => on.onOpen());

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return; // we never send binary frames

    let msg: ServerMsg;
    try {
      msg = JSON.parse(event.data) as ServerMsg;
    } catch {
      console.warn('discarding unparseable frame', event.data);
      return;
    }

    switch (msg.type) {
      case 'choose_identity':
        on.onChooseIdentity(msg.roster);
        break;
      case 'welcome':
        on.onWelcome(msg);
        break;
      case 'token_moved':
        on.onTokenMoved(msg);
        break;
      case 'token_changed':
        on.onTokenChanged(msg.token);
        break;
      case 'token_removed':
        on.onTokenRemoved(msg.id);
        break;
      case 'map_changed':
        on.onMapChanged(msg.map);
        break;
      case 'names_changed':
        on.onNamesChanged(msg.show);
        break;
      case 'diagonals_changed':
        on.onDiagonalsChanged(msg.diagonals);
        break;
      case 'cursors_changed':
        on.onCursorsChanged(msg.show);
        break;
      case 'dm_cursor_changed':
        on.onDmCursorChanged(msg.show);
        break;
      case 'backdrop_changed':
        on.onBackdropChanged(msg.url);
        break;
      case 'audio_changed':
        on.onAudioChanged(msg.url);
        break;
      case 'staged_changed':
        on.onStagedChanged(msg.board);
        break;
      case 'initiative_changed':
        on.onInitiativeChanged(msg.initiative);
        break;
      case 'presence':
        on.onPresence(msg.here);
        break;
      case 'colours_changed':
        on.onColoursChanged(msg.colours);
        break;
      case 'roster_changed':
        on.onRosterChanged(msg.roster);
        break;
      case 'sketch':
        on.onSketch(msg);
        break;
      case 'sketch_ended':
        on.onSketchEnded(msg.by);
        break;
      case 'pinged':
        on.onPinged(msg);
        break;
      case 'cursor_moved':
        on.onCursorMoved(msg);
        break;
      case 'said':
        on.onSaid(msg.line);
        break;
      case 'notes_changed':
        on.onNotesChanged(msg.text);
        break;
      case 'shapes_changed':
        on.onShapesChanged(msg.shapes);
        break;
      case 'walls_changed':
        on.onWallsChanged(msg.walls, msg.staged);
        break;
      case 'fog_changed':
        on.onFogChanged(msg.fog);
        break;
      case 'restored':
        on.onRestored(msg.state);
        break;
      case 'undo_changed':
        on.onUndoChanged(msg.label);
        break;
      case 'overrides_changed':
        on.onOverridesChanged(msg.overrides, msg.staged);
        break;
      case 'error':
        on.onError(msg.message);
        break;
      default:
        // `error` and not `warn`: an unknown frame means the two hand-written
        // copies of this union have drifted, and `cdp.mjs` only collects console
        // entries of type `error`. Don't downgrade it: as a warning, a protocol
        // mismatch passes every browser driver unnoticed.
        console.error('unknown message type', msg);
    }
  });

  // The board is stale from here on, whatever happens next: the room carried on
  // without us and there is no resync protocol. Reloading replaces it.
  socket.addEventListener('close', () => retry());
  socket.addEventListener('error', () => console.warn('websocket error'));

  return {
    send(msg) {
      // Drops sends made while connecting or after close. Both are states where
      // the server would never see the frame anyway.
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(msg));
    },
  };
}

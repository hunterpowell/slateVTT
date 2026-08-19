import type {
  ClientMsg,
  Colours,
  Diagonals,
  Initiative,
  Owner,
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
  /** Send the Hello frame from here — the socket is ready and nothing else has been sent. */
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
   *  connection — the DM sets it, everyone holds it. */
  onNamesChanged(show: boolean): void;
  /** The ruler charges diagonals differently now. Called on every connection,
   *  for the reason above: the DM sets it, everyone holds it. */
  onDiagonalsChanged(diagonals: Diagonals): void;
  /** The staged slot whole — map, walls and paint. Only ever called on a DM
   *  connection; the server sends no such frame to a player. Null means the slot
   *  is now empty, indistinguishably from not being the DM. */
  onStagedChanged(board: WireStaged | null): void;
  onInitiativeChanged(initiative: Initiative): void;
  /** Somebody joined or left. The whole list, the DM among them. Called on every
   *  connection and never filtered — who is connected is nobody's secret. */
  onPresence(here: Owner[]): void;
  /** A player picked their colour. The whole table, on every connection —
   *  including the client that picked, which is how its own swatch settles. */
  onColoursChanged(colours: Colours): void;
  /** Somebody else's sweep, keyed by their connection. Never our own. */
  onSketch(sketch: Extract<ServerMsg, { type: 'sketch' }>): void;
  onSketchEnded(by: number): void;
  /** Somebody pinged. Never called for our own, which is already on our board.
   *  Called on every connection and never filtered — a ping is relayed wherever
   *  it lands, unexplored ground included. */
  onPinged(ping: Extract<ServerMsg, { type: 'pinged' }>): void;
  /** Somebody said something we are party to — including our own, which is the
   *  one relayed frame in this protocol the sender is echoed. Nothing here is
   *  filtered: the server decided we may hold this line. */
  onSaid(line: WireChatLine): void;
  /** Our own scratchpad changed in another tab of ours. Never called for our own
   *  typing — the room does not echo it, so this cannot move our caret — and
   *  never called with anybody else's box, because no client is ever sent one. */
  onNotesChanged(text: string): void;
  /** Every shape we may see, replacing whatever we held. */
  onShapesChanged(shapes: WireShape[]): void;
  /** Every wall on one board, and which board that is. Only ever called on a DM
   *  connection — a player is sent no such frame, empty or otherwise. */
  onWallsChanged(walls: WireWall[], staged: boolean): void;
  /** What the party can see, or null on an unfogged map. Called on every
   *  connection, unlike the walls above — fog is party-shared, so the DM and the
   *  table are sent the same frame. */
  onFogChanged(fog: WireFog | null): void;
  /** The cells the DM has overridden by hand. Only ever called on a DM
   *  connection — the walls' rule, not the fog's, because this is what the DM
   *  decided rather than what the table gets to see of it. */
  onOverridesChanged(overrides: WireOverrides, staged: boolean): void;
  /** The DM undid something — take this view as the truth for the whole room.
   *
   *  Called on every connection, and it is the one delta that replaces
   *  everything rather than a part. Deliberately *not* routed to `onWelcome`:
   *  that one builds the panels and the board and runs exactly once per socket.
   */
  onRestored(state: WireRoomView): void;
  /** What the DM's next undo would take back, or null for nothing. Only ever
   *  called on a DM connection. */
  onUndoChanged(label: string | null): void;
  onError(message: string): void;
  /** The socket dropped and a new one is being tried. May be called several
   *  times as the backoff climbs. */
  onLost(): void;
  /** And it is not coming back — the backoff gave up. The floor this file has
   *  always had, now reached rather than reached for immediately. */
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
 * gone does not reconnect at dawn to a board nobody is looking at. Nine
 * attempts is a little over a minute, which covers the case this exists for: the
 * Pi's service restarting, or a tunnel blipping mid-session.
 */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 8000, 10000, 10000, 10000];

/**
 * One WebSocket to the room, and a fresh one if it drops.
 *
 * **A reconnect here is a `location.reload()`**, and that is the design rather
 * than a shortcut. `onWelcome` in main.ts builds the pings, the panels, the four
 * tools, the rail and the board once per socket, on the stated assumption of one
 * Welcome per socket — a second one would construct a second of each and
 * register another `window` keydown listener per tool. That is the wall
 * `ServerMsg::Restored` was invented to get around for the undo, and here there
 * is nothing to invent: a refresh is already the supported way back, and this
 * only stops asking the person at the keyboard to do it by hand.
 *
 * So the socket opened below is a *probe*. It proves the server is answering
 * and then throws the page away; nothing is sent on it and no handler is
 * attached to it but this one.
 *
 * The banner that used to be the immediate answer is still here — it is what
 * `onClose` means now, which is the backoff having given up.
 */
export function connect(on: Handlers): Net {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${scheme}//${location.host}/ws`;
  const socket = new WebSocket(url);

  let attempt = 0;
  // Set the moment a probe answers. A reload is not instant, and the probe's own
  // `close` fires as the page unloads — without this that close would schedule
  // one more attempt against a page that is already going away.
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
      // It answered, so a whole page against a live room is one reload away —
      // and this socket is not the one that page will use.
      probe.addEventListener('open', () => {
        reloading = true;
        location.reload();
      });
      // It did not. `error` fires before `close` on a failed connect, so
      // hanging the next attempt off `close` alone runs it exactly once.
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
      case 'sketch':
        on.onSketch(msg);
        break;
      case 'sketch_ended':
        on.onSketchEnded(msg.by);
        break;
      case 'pinged':
        on.onPinged(msg);
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
        console.warn('unknown message type', msg);
    }
  });

  // The board is stale from this moment, whatever happens next: the room went
  // on without us and there is no resync protocol, deliberately.
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

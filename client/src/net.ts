import type {
  ClientMsg,
  Initiative,
  RosterSlot,
  ServerMsg,
  TokenMoved,
  Welcome,
  WireMapInfo,
} from './protocol.js';

export interface Handlers {
  /** Send the Hello frame from here — the socket is ready and nothing else has been sent. */
  onOpen(): void;
  /** The server does not know who we are; it has sent the roster and no state. */
  onChooseIdentity(roster: RosterSlot[]): void;
  /** Called synchronously on the Welcome frame, before any delta can be handled. */
  onWelcome(welcome: Welcome): void;
  onTokenMoved(move: TokenMoved): void;
  onMapChanged(map: WireMapInfo): void;
  onInitiativeChanged(initiative: Initiative): void;
  onError(message: string): void;
  onClose(): void;
}

export interface Net {
  send(msg: ClientMsg): void;
}

/**
 * One WebSocket to the room. There is no reconnect: per the protocol a
 * reconnection is just another join, so when this closes the page says so and
 * waits for a refresh rather than pretending the board is still live.
 */
export function connect(on: Handlers): Net {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${scheme}//${location.host}/ws`);

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
      case 'map_changed':
        on.onMapChanged(msg.map);
        break;
      case 'initiative_changed':
        on.onInitiativeChanged(msg.initiative);
        break;
      case 'error':
        on.onError(msg.message);
        break;
      default:
        console.warn('unknown message type', msg);
    }
  });

  socket.addEventListener('close', () => on.onClose());
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

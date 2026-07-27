// The wire format, mirroring server/src/protocol.rs. Field names are what serde
// emits, so they stay snake_case here rather than being renamed on the way out.
//
// These types are the boundary. Nothing outside net.ts and scene.ts should
// touch them — the rest of the client works in Scene/Token/Camera.

/** Adjacently tagged on the Rust side: `{"kind":"player","id":"vex"}`. */
export type Owner = { kind: 'dm' } | { kind: 'player'; id: string };

export interface WireMapInfo {
  url: string;
  grid_px: number;
  offset_x: number;
  offset_y: number;
  /** `#rrggbbaa`. Alpha 00 means the DM turned the overlay off. */
  grid_color: string;
  /** The playable region in image pixels, or null for the whole image. */
  play_area: WireRect | null;
}

export interface WireRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface WireToken {
  id: string;
  name: string;
  /** Grid units, token centre. */
  x: number;
  y: number;
  owner: Owner;
  img: string;
}

export interface InitiativeEntry {
  token: string;
  value: number;
}

export interface Initiative {
  /** Already sorted by value, descending. The server owns the ordering. */
  entries: InitiativeEntry[];
  /** Token whose turn it is, or null when nothing is in the order. */
  current: string | null;
  round: number;
}

export interface WireRoomView {
  map: WireMapInfo;
  tokens: WireToken[];
  initiative: Initiative;
}

export interface RosterSlot {
  id: string;
  name: string;
  /** Someone is connected as this slot right now. Advisory, not enforced. */
  claimed: boolean;
}

export interface Welcome {
  type: 'welcome';
  your_id: number;
  is_dm: boolean;
  /** null for the DM, who occupies no roster slot. */
  player_id: string | null;
  state: WireRoomView;
}

export interface TokenMoved {
  type: 'token_moved';
  id: string;
  x: number;
  y: number;
  dragging: boolean;
}

export type ServerMsg =
  | { type: 'choose_identity'; roster: RosterSlot[] }
  | Welcome
  | TokenMoved
  | { type: 'map_changed'; map: WireMapInfo }
  | { type: 'initiative_changed'; initiative: Initiative }
  | { type: 'error'; message: string };

export type ClientMsg =
  | { type: 'hello'; dm_secret: string | null; player_id: string | null }
  | { type: 'move_token'; id: string; x: number; y: number; dragging: boolean }
  /** Image and grid together. A calibration repeats the URL it already had. */
  | {
      type: 'set_map';
      url: string;
      grid_px: number;
      offset_x: number;
      offset_y: number;
      grid_color: string;
      play_area: WireRect | null;
    }
  | { type: 'set_initiative'; token: string; value: number }
  | { type: 'remove_from_initiative'; token: string }
  | { type: 'clear_initiative' }
  | { type: 'next_turn' }
  | { type: 'previous_turn' };

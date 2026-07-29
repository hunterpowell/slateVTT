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

/** What the DM is counting down on a creature. Never a stat block. */
export interface Hp {
  current: number;
  max: number;
}

/** A position in grid units. Its own type so that "half a position" cannot be
 *  sent — the same reason `Hp` keeps its pair together. */
export interface WirePos {
  x: number;
  y: number;
}

/** A token as *this* client may see it — `TokenView` on the Rust side, not
 *  `Token`. A token the table cannot see never arrives at all, and `hp` and the
 *  two staged fields are redacted out on the way to anyone but the DM, so the
 *  two shapes genuinely differ. */
export interface WireToken {
  id: string;
  name: string;
  /** Grid units, token centre. */
  x: number;
  y: number;
  owner: Owner;
  /** Site-relative, or empty for a token the client draws as a named disc. */
  img: string;
  /** Width and height in grid cells. One of 0.5, 1, 2, 3, 4 — see TOKEN_SIZES. */
  size: number;
  /** The table cannot see this token. Only ever true on a DM connection: a
   *  player is not sent one, so their copy is false by construction. */
  hidden: boolean;
  /** Null for a player, always — and also null for a DM keeping no total on
   *  this creature. The two are indistinguishable from here, deliberately. */
  hp: Hp | null;
  /** Where this token lands when the staged map is promoted, or null for one
   *  staying put. Null for a player always: a plan is a cell on a map they have
   *  not been shown. */
  staged_pos: WirePos | null;
  /** Not on the live board yet — built on the map the DM is preparing. Only
   *  ever true on a DM connection, and false for a player by construction:
   *  they are not sent the token at all. */
  staged_only: boolean;
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
  /** The DM's next map. Always null for a player — and null also means nothing
   *  is staged, so the two are indistinguishable from here. That is deliberate:
   *  the server withholds it rather than sending it and asking us not to draw. */
  staged: WireMapInfo | null;
  tokens: WireToken[];
  initiative: Initiative;
}

export interface RosterSlot {
  id: string;
  name: string;
  /** Someone is connected as this slot right now. Advisory, not enforced. */
  claimed: boolean;
}

export interface RosterEntry {
  id: string;
  name: string;
}

export interface Welcome {
  type: 'welcome';
  your_id: number;
  is_dm: boolean;
  /** null for the DM, who occupies no roster slot. */
  player_id: string | null;
  state: WireRoomView;
  /** The cast list, so the DM's token panel can offer players by name. Not who
   *  is connected — that is `RosterSlot`, and only the picker cares. */
  roster: RosterEntry[];
}

export interface TokenMoved {
  type: 'token_moved';
  id: string;
  x: number;
  y: number;
  dragging: boolean;
  /** Which of the token's two positions this frame is: where it stands, or
   *  where it lands on a promote. Never true on a player's connection. */
  staged: boolean;
}

export type ServerMsg =
  | { type: 'choose_identity'; roster: RosterSlot[] }
  | Welcome
  | TokenMoved
  /** Created or edited — an id we have never seen is the creation. */
  | { type: 'token_changed'; token: WireToken }
  | { type: 'token_removed'; id: string }
  | { type: 'map_changed'; map: WireMapInfo }
  /** The staged slot, or null once there is not one. DM connections only. */
  | { type: 'staged_changed'; map: WireMapInfo | null }
  | { type: 'initiative_changed'; initiative: Initiative }
  | { type: 'error'; message: string };

export type ClientMsg =
  | { type: 'hello'; dm_secret: string | null; player_id: string | null }
  /** `staged` names which of the token's two positions this writes. Intent
   *  rides on the command because the server does not know we are previewing
   *  and must not learn — preview is ours alone. DM-only when true. */
  | {
      type: 'move_token';
      id: string;
      x: number;
      y: number;
      dragging: boolean;
      staged: boolean;
    }
  /** Image and grid together. A calibration repeats the URL it already had.
   *  `staged` names which slot that comparison runs against, and nothing else. */
  | {
      type: 'set_map';
      url: string;
      grid_px: number;
      offset_x: number;
      offset_y: number;
      grid_color: string;
      play_area: WireRect | null;
      staged: boolean;
    }
  /** DM-only. The staged map becomes the board; tokens keep their cells. */
  | { type: 'promote_staged' }
  /** DM-only. Throw the staged map away. */
  | { type: 'clear_staged' }
  /** DM-only. No id: the server invents it. `staged` builds it on the map being
   *  prepared, where it exists for nobody until the promote. */
  | {
      type: 'create_token';
      name: string;
      img: string;
      size: number;
      owner: Owner;
      x: number;
      y: number;
      hidden: boolean;
      hp: Hp | null;
      staged: boolean;
    }
  /** DM-only. Every editable field at once; position is `move_token`'s alone.
   *  Taking damage is this command with a new `hp` — there is no `set_hp`.
   *
   *  No `staged` flag, unlike its neighbours: every field here is shared by both
   *  boards, so an edit applies everywhere at once. Only position and existence
   *  fork. */
  | {
      type: 'update_token';
      id: string;
      name: string;
      img: string;
      size: number;
      owner: Owner;
      hidden: boolean;
      hp: Hp | null;
    }
  | { type: 'delete_token'; id: string }
  | { type: 'set_initiative'; token: string; value: number }
  | { type: 'remove_from_initiative'; token: string }
  | { type: 'clear_initiative' }
  | { type: 'next_turn' }
  | { type: 'previous_turn' };

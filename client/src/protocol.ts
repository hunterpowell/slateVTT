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
  /** Whether the party's sight is limited on this map. Per map and remembered
   *  per URL with the rest of the calibration: a dungeon wants fog and the
   *  meadow outside it does not. */
  fog: boolean;
  /** How far a player-owned token sees, in feet. One radius for the map —
   *  nothing here knows the word "darkvision". Only read when `fog` is on. */
  vision_ft: number;
}

/**
 * What the party can see and what they have explored, packed one character per
 * cell.
 *
 * A rectangle of characters rather than an array of per-cell values, because the
 * frames in devtools are meant to be readable and a few thousand numbers is not
 * one. The rectangle is the bounding box of everything explored, so **every cell
 * outside it is dark** and an unexplored map arrives as nothing at all.
 *
 * `null` in place of one of these is a map with fog turned off — and, like
 * `staged` being null, it is indistinguishable from a map that has none.
 */
export interface WireFog {
  /** Cell coordinates of the rectangle's top-left corner. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** `w * h` characters, row-major: `#` never seen, `o` explored, `.` in sight. */
  cells: string;
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

/** The four things anyone can draw. A closed set on the Rust side too — an
 *  unknown kind does not deserialize. */
export type ShapeKind = 'line' | 'circle' | 'cone' | 'rect';

/** Where a shape's first point is: a cell, or a token it follows.
 *
 *  Adjacently tagged like `Owner`, and an enum for the same reason `Owner` is
 *  one — an anchored shape carrying a position nothing reads is a field that can
 *  go stale. */
export type WireOrigin = { kind: 'point'; at: WirePos } | { kind: 'token'; at: string };

/** A drawn shape. Unlike a token this is the server's own type rather than a
 *  view of it: there is nothing on it one client may hold and another may not.
 *  A shape the table cannot see is absent, not redacted. */
export interface WireShape {
  id: string;
  kind: ShapeKind;
  from: WireOrigin;
  /** The second point, as an offset from the origin in grid units. An offset so
   *  an anchored shape translates with its token instead of stretching. */
  to: WirePos;
  /** Who drew it, and so who may erase it besides the DM. */
  by: Owner;
  /** `#rrggbbaa`, like the grid colour. */
  color: string;
}

/** A point in image pixels — the other coordinate space, and its own type for
 *  the reason the Rust side has one: a wall traces the art, so one stored in
 *  cells would slide off it the moment the grid was corrected. */
export interface WirePx {
  x: number;
  y: number;
}

/** Masonry, or a way through it and whether it stands open.
 *
 *  Adjacently tagged like `Owner`, and an enum rather than two booleans for the
 *  reason `WireOrigin` is one: "a solid wall that is open" cannot be said. */
export type WireWallKind = { kind: 'solid' } | { kind: 'door'; open: boolean };

/** One traced segment, in image pixels. Flat segments rather than the runs they
 *  are drawn as — the run is how the DM authors, not what the map holds.
 *
 *  A player is never sent one of these. There is no redacted form: the list
 *  arrives whole or not at all. */
export interface WireWall {
  id: string;
  from: WirePx;
  to: WirePx;
  kind: WireWallKind;
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
  /** Draw order, already filtered: a shape anchored to a token we cannot see
   *  never arrives, because an aura on a hidden monster is its position. */
  shapes: WireShape[];
  /** The traced walls and doors — empty for a player, always. Empty is also
   *  what a map nobody has traced looks like, so the two are indistinguishable
   *  from here, exactly as `staged` being null is. */
  walls: WireWall[];
  /** What the party can see, or null on an unfogged map.
   *
   *  The same value for everyone, unlike everything above it — fog is
   *  party-shared, so there is one answer. The DM is sent it so their own board
   *  can show, faintly, what the table is looking at. It is the walls one line
   *  up that stay theirs alone; a player reads the geometry off the edges of
   *  this instead, which is the whole shape of the feature. */
  fog: WireFog | null;
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
  /** Somebody else's in-progress sweep, keyed by their connection. Never our
   *  own: we are already drawing that one from our own pointer. */
  | { type: 'sketch'; by: number; kind: ShapeKind; at: WirePos; to: WirePos; color: string }
  /** That sweep is over — released, or its client went away. */
  | { type: 'sketch_ended'; by: number }
  /** Every shape we may see. The whole list, like the initiative panel. */
  | { type: 'shapes_changed'; shapes: WireShape[] }
  /** Every wall the DM has traced. DM connections only — a player is not sent
   *  this frame at all, not even an empty one, because a frame they cannot use
   *  still tells them the DM just did something. */
  | { type: 'walls_changed'; walls: WireWall[] }
  /** What the party can see now, and everywhere they have been. Null once the
   *  map is not fogged. Reaches everyone, unlike the walls above it — and only
   *  on a drop, never on a drag frame. */
  | { type: 'fog_changed'; fog: WireFog | null }
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
      /** Whether this map is fogged and how far a token sees on it. Here rather
       *  than on a command of their own for the reason the grid colour is: they
       *  are fields of the map, remembered per URL with the rest of it. */
      fog: boolean;
      vision_ft: number;
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
  /** A shape being swept out right now: relayed to everyone watching, stored by
   *  nobody. `drawing: false` is the release that ends it.
   *
   *  Whether a release keeps anything is ours alone to decide — the measuring
   *  tool stops here and the area tools follow with an `add_shape`. The server
   *  is uniform over all four kinds and never learns which tool was in hand. */
  | {
      type: 'sketch';
      kind: ShapeKind;
      at: WirePos;
      to: WirePos;
      color: string;
      drawing: boolean;
    }
  /** Keep the shape just swept. No id — the server invents it, like a token's. */
  | { type: 'add_shape'; kind: ShapeKind; from: WireOrigin; to: WirePos; color: string }
  /** Whoever drew it, or the DM. */
  | { type: 'remove_shape'; id: string }
  /** DM-only: it reaches into five other people's drawings. */
  | { type: 'clear_shapes' }
  /** DM-only. One traced run: its corners in order, in image pixels, and the
   *  segments between them become that many walls. No ids — the server invents
   *  one per segment, like a shape's.
   *
   *  The run is sent whole rather than a segment per click because that is the
   *  milestone: a two-hundred-segment dungeon is otherwise two hundred round
   *  trips. `door` applies to every segment of it. */
  | { type: 'add_walls'; points: WirePx[]; door: boolean }
  /** DM-only. One segment — there is no "erase this run", which is what lets a
   *  single bad segment be fixed without redrawing the trace. */
  | { type: 'remove_wall'; id: string }
  /** DM-only, and refused on masonry. It changes nothing anyone can see until
   *  fog exists; it is the command that will open a room to the party. */
  | { type: 'toggle_door'; id: string }
  /** DM-only. Every wall on the map — and unlike `clear_shapes` it reaches into
   *  nobody else's work, since the walls are all the DM's. */
  | { type: 'clear_walls' }
  | { type: 'set_initiative'; token: string; value: number }
  | { type: 'remove_from_initiative'; token: string }
  | { type: 'clear_initiative' }
  | { type: 'next_turn' }
  | { type: 'previous_turn' };

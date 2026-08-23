// The wire format, mirroring server/src/protocol.rs. Field names are what serde
// emits, so they stay snake_case here rather than being renamed on the way out.
//
// These types are the boundary. Nothing outside net.ts and scene.ts should
// touch them — the rest of the client works in Scene/Token/Camera.

/** Adjacently tagged on the Rust side: `{"kind":"player","id":"saelyn"}`. */
export type Owner = { kind: 'dm' } | { kind: 'player'; id: string };

/**
 * Which palette entry each player picked, keyed by roster slug.
 *
 * A plain object because that is what a `BTreeMap<PlayerId, u8>` serialises to
 * — `PlayerId` is a newtype over a string, so it is a legal JSON key, which is
 * exactly what `Owner` is not. A slug with no entry never picked, and
 * `colourOf` falls back to the default for that roster position.
 *
 * The numbers index `PLAYER_HUES` in `pings.ts`, which is the only place the
 * hues themselves exist. The server holds the bound and not the list.
 */
export type Colours = Readonly<Record<string, number>>;

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
  /** How this map's sight is worked out: line of sight from each token, or the
   *  room each token is standing in. Remembered per URL with the two above, so
   *  the outdoor map keeps line of sight and the dungeon reveals a room at a
   *  time. */
  lighting: Lighting;
}

/**
 * Which question a fogged map asks — `Lighting` on the server.
 *
 * The client never answers it. It sets it, it shows it in the panel, and what
 * comes back is the same `WireFog` either way: the mode changes what the party
 * can see and not what any of it means, which is why nothing that draws the
 * board reads this.
 */
export type Lighting = 'dynamic' | 'room';

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

/**
 * The cells the DM has overridden by hand, packed the same way the fog is.
 *
 * A different alphabet and the opposite audience. `#` forced dark, `o` forced
 * explored, `*` forced in sight, `-` no override — and unlike the fog, the
 * rectangle has holes in it, because it is bounded by the painted cells rather
 * than describing every cell inside its own box.
 *
 * **Empty for a player, always**, exactly as `walls` is: this is what the DM
 * decided, and `WireFog` above is the shadow the table gets to see. Empty is
 * therefore both "nothing painted" and "you are not the DM".
 */
export interface WireOverrides {
  x: number;
  y: number;
  w: number;
  h: number;
  cells: string;
}

/** What the DM's brush is loaded with. `null` hands the cells back to the rays —
 *  "no override" is an absence rather than a fourth state, on the wire as in the
 *  room. */
export type FogPaint = 'explored' | 'lit' | 'dark';

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

/**
 * The staged slot: the map the DM is preparing and everything they have
 * prepared *on* it.
 *
 * One bundle rather than three fields, because the three arrive, sweep and
 * promote together — and because one `null` then withholds all of it. There is
 * no second staged field for a later milestone to add and forget to filter.
 *
 * The map's own fields sit directly on this rather than under a `map` key,
 * which is `#[serde(flatten)]` on the server and is what keeps a save written
 * before any of this existed loading its staged map.
 */
export interface WireStaged extends WireMapInfo {
  /** Traced on the next dungeon before the table has ever seen it. Never sent
   *  to a player — but then neither is anything else here. */
  walls: WireWall[];
  /** Painted on it by hand, and handed to the party the moment it is promoted.
   *  There is no staged *fog* under this: what the DM is deciding is what the
   *  party will be given, not a preview of what they can see. */
  overrides: WireOverrides;
}

export interface WireRoomView {
  map: WireMapInfo;
  /** The DM's next map, its masonry and its paint. Always null for a player —
   *  and null also means nothing is staged, so the two are indistinguishable
   *  from here. That is deliberate: the server withholds it rather than sending
   *  it and asking us not to draw. */
  staged: WireStaged | null;
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
  /** The cells the DM has painted over the fog by hand — and empty for a player,
   *  always, like the walls three lines up rather than like the fog between
   *  them. The walls and this are what the DM authored; the fog is the shadow
   *  both of them cast. */
  overrides: WireOverrides;
  /** Whether the board writes each token's name under it.
   *
   *  The same value for everyone, like `fog` and unlike the two fields above it:
   *  the DM flips it, and the point of it is that every board is labelled the
   *  same way afterwards. Room-wide, not per map — swapping the dungeon is not a
   *  request to relabel the tokens standing on it. */
  show_names: boolean;
  /** How the movement ruler charges a diagonal.
   *
   *  The field above it in every respect: the DM's to set, everyone's to hold,
   *  the same value for every client. A counting convention only half the table
   *  holds is worse than either convention. */
  diagonals: Diagonals;
  /** Whether everybody's pointer is drawn on everybody's board.
   *
   *  The third of these and the same value for everyone, with one job the other
   *  two do not have: **we read it to decide whether to send**. A page that
   *  joined without it would ship its own pointer at 30Hz into a room that has
   *  switched cursors off. */
  show_cursors: boolean;
  /** The picture the table is looking at instead of the board, or null for the
   *  board.
   *
   *  The fourth of these, and the same value for everyone for the plainest
   *  version of the reason: the DM decides what is on the screens and there is
   *  nothing here being kept from anybody. Not a `WireMapInfo` and never one —
   *  there is no grid to draw on it, nothing standing on it and nothing traced
   *  across it, which is exactly why the board underneath survives it. */
  backdrop: string | null;
  /** Who is connected right now, the DM among them.
   *
   *  The same value for everyone, like the two fields above it: there is no
   *  permission here and nothing to withhold. A table that cannot tell whether
   *  the DM is still on the other end of the line is what it exists for.
   *
   *  `Owner` rather than `RosterSlot` — which is the difference between this and
   *  the picker's list, since a slot cannot say "the DM". One entry per person
   *  and not per socket: somebody on a laptop and a phone is one name. */
  here: Owner[];
  /** What colour each player picked for themselves.
   *
   *  **Public, unlike the scratchpad below**, and the first thing here a player
   *  writes that everybody else is sent. That is the axis a colour differs from
   *  a note on: everyone has to draw everyone else's rings, so a colour only its
   *  owner could see would not be a colour. */
  colours: Colours;
  /** What the DM's undo would take back, or null for nothing to take.
   *
   *  **Null on every player connection**, which is the walls' rule rather than
   *  the fog's — and it is also what an untouched room says, so the two are
   *  indistinguishable from here. A label rather than a depth because that is
   *  all the button needs: with no redo, a press has to name its victim before
   *  it takes it. */
  undo: string | null;
  /** What has been said this session that we are party to.
   *
   *  **The one field here that is different text per client rather than the
   *  same text with rows dropped.** Two players hold two different
   *  conversations, because a whisper only exists in the copies of the two
   *  people at either end of it.
   *
   *  Session memory on the server: it is never written to disk, so it is empty
   *  on the first join after a restart and never carries last week's game. */
  chat: WireChatLine[];
  /** Our own scratchpad, and never anybody else's.
   *
   *  **The second field here that is content per client rather than the room's
   *  copy with rows dropped**, and the first where the DM's is narrower than the
   *  room's. There is no view of this that carries somebody else's box — not for
   *  the DM either, which is the point of it. Empty when nothing has been
   *  written and empty for a client with no slot claimed, indistinguishably. */
  notes: string;
}

/**
 * How the movement ruler charges a diagonal step.
 *
 * `equal` is "5-5-5": every step costs one cell whichever way it goes.
 * `alternating` is "5-10-5": the second diagonal of a reading costs double, and
 * every other one after it. Counted from the start of each measurement rather
 * than across a turn — nothing here holds a movement budget, so the first
 * diagonal of anything anyone measures costs five.
 *
 * It moves the ruler and nothing else. A drawn circle and a token's vision are
 * geometry, and stay Euclidean on both settings.
 */
export type Diagonals = 'equal' | 'alternating';

/**
 * Where something typed is going — `ChatTo` on the server.
 *
 * **Two destinations for anyone and never a third.** A player says it to the
 * table or to the DM; the DM says it to the table or to one player. There is no
 * player-to-player variant, which is the whole boundary of the feature and the
 * reason the noun is "whisper and shout" rather than "chat".
 *
 * Adjacently tagged like `Owner`, which it deliberately is not: an owner is a
 * person, and this is a person *or* everybody.
 */
export type ChatTo = { kind: 'table' } | { kind: 'dm' } | { kind: 'player'; id: string };

/**
 * One thing somebody said.
 *
 * It carries `to` as well as `by` because a whisper has to look like one on the
 * screens of both people party to it — the DM's log holds their whisper to
 * Saelyn and Saelyn's whisper back, and only `to` tells them apart.
 *
 * Never filtered on this side. What arrives is what we are party to; the server
 * decided that, and the whole of what this client does with `to` is style it.
 */
export interface WireChatLine {
  by: Owner;
  to: ChatTo;
  text: string;
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
  /** The board writes token names under them now, or it stopped. Reaches
   *  everyone, including the DM who flipped it — nothing here is predicted
   *  locally, so this frame is how their own checkbox settles. */
  | { type: 'names_changed'; show: boolean }
  /** The ruler charges diagonals differently now. `names_changed`'s neighbour,
   *  and echoed to the DM who set it for the same reason. */
  | { type: 'diagonals_changed'; diagonals: Diagonals }
  /** There is a picture in front of the table now, or there is not.
   *
   *  `names_changed`'s neighbour again: identical for everyone, echoed to the DM
   *  who put it up. **Nothing arrives with it** — the board is being covered
   *  rather than changed, so the map, walls, shapes and fog we already hold are
   *  still correct and no frame is owed for them. */
  | { type: 'backdrop_changed'; url: string | null }
  /** The staged slot — map, walls and paint — or null once there is not one. DM
   *  connections only.
   *
   *  It carries the whole board rather than only the map, which is what lets a
   *  staged load sweeping its walls and a staged recalibration dropping its
   *  paint arrive with no frames of their own. */
  | { type: 'staged_changed'; board: WireStaged | null }
  | { type: 'initiative_changed'; initiative: Initiative }
  /** Somebody joined or left. The whole list, at most seven names.
   *
   *  `names_changed`'s shape rather than `walls_changed`'s — identical for every
   *  recipient, no filter — and unlike either, nobody sent a command to cause
   *  it. Sent on every join and every leave rather than only when the list
   *  differs, so a second connection as the same person repaints the same chips
   *  rather than needing the room to remember what it last said. */
  | { type: 'presence'; here: Owner[] }
  /** A player picked their colour. The whole table, for the reason above.
   *
   *  Echoed to whoever picked, unlike `notes_changed`: there is no caret for it
   *  to move and nothing was drawn locally, so this frame is how the chosen
   *  swatch settles on the client that chose it. */
  | { type: 'colours_changed'; colours: Colours }
  /** Somebody else's in-progress sweep, keyed by their connection. Never our
   *  own: we are already drawing that one from our own pointer. */
  | { type: 'sketch'; by: number; kind: ShapeKind; at: WirePos; to: WirePos; color: string }
  /** That sweep is over — released, or its client went away. */
  | { type: 'sketch_ended'; by: number }
  /** Somebody pinged. Draw a ring there for a second or two.
   *
   *  Keyed by `Owner` rather than by connection, unlike the two sweeps above:
   *  a ping replaces no previous frame and needs no release, so what we want
   *  from it is not which socket sent it but whose ring to draw. Never our own,
   *  which has been on our board since the hold was 150ms old.
   *
   *  The one frame carrying a position that no visibility filter touches — a
   *  ping lands wherever it was pointed, unexplored ground included. */
  | { type: 'pinged'; by: Owner; at: WirePos }
  /** Somebody's pointer is here now. Draw it until it stops arriving.
   *
   *  `pinged`'s twin — an `Owner` for the same reason, never our own for the
   *  same reason — and its opposite in one respect: this one *is* filtered. The
   *  DM's pointer is withheld from a player while it is over ground the party
   *  has not explored, because a ping is a gesture somebody chose to make and a
   *  cursor is where a hand happens to be. Nothing here has to know that; it is
   *  the room's decision, and what arrives is what may be drawn. */
  | { type: 'cursor_moved'; by: Owner; at: WirePos }
  /** Pointers are drawn on every board now, or they are not.
   *
   *  `names_changed`'s neighbour, and the one of the three that changes what
   *  this client *sends*: with it off the room relays nothing, so a client that
   *  kept sending would be paying for a feature nobody can see. */
  | { type: 'cursors_changed'; show: boolean }
  /** Every shape we may see. The whole list, like the initiative panel. */
  /** Somebody said something we are party to — a shout, or a whisper at whose
   *  either end we stand.
   *
   *  **Including our own**, which is where this differs from `pinged` and
   *  `sketch` above: a line of text is not drawn locally first, because where it
   *  lands in the log is the room's to decide and two people type at once. */
  | { type: 'said'; line: WireChatLine }
  /** Our own scratchpad now reads this — sent when our *other* tab changed it.
   *
   *  Never sent to the socket that typed it: that box already holds the text,
   *  and writing it back a round trip later moves the caret. That is `pinged`'s
   *  exclusion rather than `said`'s echo, and for the same reason those two
   *  differ from each other. */
  | { type: 'notes_changed'; text: string }
  | { type: 'shapes_changed'; shapes: WireShape[] }
  /** Every wall the DM has traced. DM connections only — a player is not sent
   *  this frame at all, not even an empty one, because a frame they cannot use
   *  still tells them the DM just did something. */
  | { type: 'walls_changed'; walls: WireWall[]; staged: boolean }
  /** What the party can see now, and everywhere they have been. Null once the
   *  map is not fogged. Reaches everyone, unlike the walls above it — and only
   *  on a drop, never on a drag frame. */
  | { type: 'fog_changed'; fog: WireFog | null }
  /** Every cell the DM has overridden. DM connections only — a player is not
   *  sent this frame at all, for the reason they are sent no `walls_changed`.
   *  What they are owed is the `fog_changed` beside it. */
  | { type: 'overrides_changed'; overrides: WireOverrides; staged: boolean }
  /** The DM undid something and the room is an earlier state — take this as the
   *  truth for all of it.
   *
   *  The whole world rather than a diff, which is the feature working rather
   *  than giving up: the case undo exists for is a map load, which sweeps the
   *  walls, the drawings and the fog in one command. Filtered by the same
   *  `snapshot_for` a join goes through, so a player is sent one of these with
   *  no walls and no staged map in it, exactly as they are on connect.
   *
   *  **Not a second `welcome`**, and the difference is on this side of the
   *  wire: `onWelcome` builds the panels, the tools and the board once per
   *  connection. This only hands over state — no identity, no roster, neither
   *  of which an undo can change. */
  | { type: 'restored'; state: WireRoomView }
  /** What the DM's next undo would take back. DM connections only, for the
   *  reason they alone are sent `walls_changed` — except that here what is
   *  withheld is not a secret but a label for a button a player does not have.
   *
   *  Arrives beside every change to the room, which is how the button stays
   *  right when the DM's other tab, or a player's drawing, adds a step. */
  | { type: 'undo_changed'; label: string | null }
  | { type: 'error'; message: string };

export type ClientMsg =
  | { type: 'hello'; dm_secret: string | null; player_id: string | null }
  /** Put the room back the way it was before the last thing that changed it.
   *  DM-only, and carries nothing — only the top of the room's ring can be
   *  undone, so there is no depth for this to name. Undoing twice is sending
   *  it twice. */
  | { type: 'undo' }
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
      lighting: Lighting;
      staged: boolean;
    }
  /** Say something, to the table or to one person.
   *
   *  One command for a whisper and a shout, because they differ only in where
   *  they are going — and the destination is exactly what the server's
   *  permission check is about. It carries no sender: who said it is what the
   *  socket already proved. */
  | { type: 'say'; to: ChatTo; text: string }
  /** Replace our own scratchpad. It carries no key — the box it lands in is the
   *  one the socket belongs to, because a key we could name is a key we could
   *  name somebody else's with. */
  | { type: 'set_notes'; text: string }
  /** Pick our own colour. It carries no key either, for `set_notes`' reason —
   *  whose colour it is comes from the socket.
   *
   *  An index into a closed palette rather than a hex string, and the reason is
   *  on the board: free hex would let a player take the gold a token ring uses
   *  for ownership and make their own ring say something false. The server holds
   *  the bound; `PLAYER_HUES` in `pings.ts` holds the colours. Never sent by the
   *  DM, whose hue is outside the six on purpose — the server refuses it. */
  | { type: 'set_colour'; colour: number }
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
  /** DM-only. Whether the board writes token names under them, for everyone.
   *
   *  Its own command rather than a field on `set_map`, where the fog switch
   *  went: this belongs to the room and not to the image, so riding on a map
   *  change would fork it between the two slots and reset it on every load. */
  | { type: 'set_show_names'; show: boolean }
  /** DM-only. How the ruler charges a diagonal, for everyone. Room-wide and not
   *  on `set_map`, for the reason above: the table's counting outlives the
   *  dungeon it is being done on. */
  | { type: 'set_diagonals'; diagonals: Diagonals }
  /** DM-only. Whether everybody's pointer is drawn on everybody's board.
   *
   *  The switch stops the *relay* rather than the drawing, so a client told
   *  `false` stops sending as well — seven pointers over a board that already
   *  carries tokens, nameplates, bars, rulers, trails, shapes and fog is a real
   *  cost, and a switch that saved none of it would be a preference. */
  | { type: 'set_show_cursors'; show: boolean }
  /** DM-only. Put a picture in front of the table, or null to take it away.
   *
   *  Room-wide and not on `set_map` for a sharper version of the reason above:
   *  a `set_map` is a map *load*, which sweeps the walls, the drawings and
   *  everywhere the party has explored. Not doing any of that is the command. */
  | { type: 'set_backdrop'; url: string | null }
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
  /** Look here. Anyone may send it; it is relayed to everyone else and stored
   *  by nobody, and there is no `drawing` flag because a ping is one frame
   *  rather than a stream — the hold is over by the time this goes out.
   *
   *  No colour on it either, unlike `sketch`: what a ring looks like is decided
   *  by who sent it, and every client can work that out from the roster. */
  | { type: 'ping'; at: WirePos }
  /** Where our pointer is now, in grid units. Relayed to everyone else and
   *  stored by nobody — `ping` with the deliberateness taken out.
   *
   *  Throttled to ~30Hz and sent only on movement, because this is the busiest
   *  thing either side of this wire: drag frames exist while a token is moving,
   *  and these exist whenever a hand is on the mouse. There is no frame that
   *  ends one — stillness does, on every recipient's own timer. */
  | { type: 'move_cursor'; at: WirePos }
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
   *  trips. `door` applies to every segment of it.
   *
   *  `staged` names the board, like `move_token` and `set_map` do — intent rides
   *  on the command because the server does not know we are previewing and must
   *  not learn. Every wall command below carries it for the same reason. */
  | { type: 'add_walls'; points: WirePx[]; door: boolean; staged: boolean }
  /** DM-only. One segment — there is no "erase this run", which is what lets a
   *  single bad segment be fixed without redrawing the trace. */
  | { type: 'remove_wall'; id: string; staged: boolean }
  /** DM-only, and refused on masonry. On the board it opens a room to the
   *  party mid-fight; on the staged one it is authoring — a door left open is
   *  the door they find open when the map lands. */
  | { type: 'toggle_door'; id: string; staged: boolean }
  /** DM-only. Every wall on one board — and unlike `clear_shapes` it reaches
   *  into nobody else's work, since the walls are all the DM's. */
  | { type: 'clear_walls'; staged: boolean }
  /** DM-only. What one brush stroke or one fill decided, as the cells it
   *  decided it about.
   *
   *  **The cells are the payload, not a seed.** The fill is computed here,
   *  because the preview has to compute it anyway — sending the previewed cells
   *  is what makes the preview and the result the same object rather than two
   *  runs of two implementations that would have to agree. `state` of null hands
   *  them back to line of sight. */
  | {
      type: 'set_fog_override';
      cells: [number, number][];
      state: FogPaint | null;
      /** Which board's mask. Painting the staged one is not previewing what the
       *  party will see there — it is deciding what they are handed when the map
       *  lands, which is why there is no staged fog under it. */
      staged: boolean;
    }
  /** DM-only. The whole map back to dark: every override cleared and everywhere
   *  the party has explored forgotten, then line of sight recomputed from where
   *  the tokens are standing. One command because it is one gesture — "this map
   *  has not been seen yet". */
  | { type: 'reset_fog' }
  | { type: 'set_initiative'; token: string; value: number }
  | { type: 'remove_from_initiative'; token: string }
  | { type: 'clear_initiative' }
  | { type: 'next_turn' }
  | { type: 'previous_turn' };

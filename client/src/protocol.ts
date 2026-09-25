// The wire format, mirroring server/src/protocol.rs. Field names are what serde
// emits, so they stay snake_case here instead of being renamed on the way out.
//
// Nothing outside net.ts and scene.ts should touch these types. The rest of
// the client works in Scene/Token/Camera.

/** Adjacently tagged on the Rust side: `{"kind":"player","id":"saelyn"}`. */
export type Owner = { kind: 'dm' } | { kind: 'player'; id: string };

/**
 * Which palette entry each player picked, keyed by roster slug.
 *
 * A plain object because that is what a `BTreeMap<PlayerId, u8>` serialises
 * to. `PlayerId` is a newtype over a string, so it is a legal JSON key, which
 * `Owner` is not. A slug with no entry never picked, and `colourOf` falls back
 * to the default for that roster position.
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
  /** How far a player-owned token sees, in feet. One radius for the map, with
   *  no notion of darkvision. Only read when `fog` is on. */
  vision_ft: number;
  /** How this map's sight is worked out: line of sight from each token, or the
   *  room each token is standing in. Remembered per URL with the two above, so
   *  the outdoor map keeps line of sight and the dungeon reveals a room at a
   *  time. */
  lighting: Lighting;
  /** What shape this map's cells are. Remembered per URL with the rest of the
   *  calibration, so the isometric town and the square dungeon can sit in the
   *  same folder. `gridBasis` in `scene.ts` is the only place it is read. */
  grid_shape: WireGridShape;
}

/**
 * How a fogged map works out sight. `Lighting` on the server.
 *
 * The client only sets it and shows it in the panel. What comes back is the
 * same `WireFog` either way: the mode changes which cells the party can see,
 * not what a cell means, so nothing that draws the board reads this.
 */
export type Lighting = 'dynamic' | 'room';

/**
 * The shape of one cell. `GridShape` on the server.
 *
 * An isometric grid is an affine transform of a square one, so this is a
 * descriptor and not a second coordinate system. `gridBasis` in `scene.ts`
 * turns it into the two cell axes and is the only place either variant is read.
 * `fog::basis` in Rust does the same on the server, and the two must agree.
 *
 * Flat: a diamond lattice, not a 2.5D renderer. Nothing here has a height.
 */
export type WireGridShape =
  | { kind: 'square' }
  /** A diamond `grid_px` tall and `grid_px * ratio` wide. */
  | { kind: 'iso'; ratio: number };

/**
 * What the party can see and what they have explored, packed one character per
 * cell.
 *
 * A rectangle of characters, not an array of per-cell values, so frames stay
 * readable in devtools; a few thousand numbers are not. The rectangle is the
 * bounding box of everything explored, so **every cell outside it is dark** and
 * an unexplored map arrives as an empty rectangle.
 *
 * `null` in place of one of these is a map with fog turned off.
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
 * A different alphabet: `#` forced dark, `o` forced explored, `*` forced in
 * sight, `-` no override. Unlike the fog, the rectangle has holes in it: it is
 * the bounding box of the painted cells, and every other cell inside it is `-`.
 *
 * **Empty for a player, always**, as `walls` is. This is what the DM decided;
 * `WireFog` above is the result the table is sent. Empty is therefore both
 * "nothing painted" and "you are not the DM".
 */
export interface WireOverrides {
  x: number;
  y: number;
  w: number;
  h: number;
  cells: string;
}

/** What the DM's brush paints. `null` hands the cells back to the raycast: "no
 *  override" is an absence, not a fourth state, on the wire as in the room. */
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

/** A position in grid units. Its own type so that half a position can't be
 *  sent, which is also why `Hp` keeps its pair together. */
export interface WirePos {
  x: number;
  y: number;
}

/**
 * A mark the DM puts on a creature: six colours, and `dead`.
 *
 * A closed set, checked by serde on the Rust side: an unknown marker does not
 * deserialize. What "red" means tonight is up to the DM and the table. A
 * member called `poisoned` would be 5e rules knowledge, which is out of scope.
 * The hues live in `MARKER_HUES` in `markers.ts` because the server doesn't
 * know what any of them looks like.
 *
 * `dead` is the one member that is not a colour. It is allowed because nothing
 * in Slate acts on a mark: it draws an X across the portrait and nothing more.
 * The creature still moves, keeps its initiative row and keeps its total. See
 * *Markers* in `docs/tokens.md`.
 */
export type Marker = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'dead';

/** A token as *this* client may see it: `TokenView` on the Rust side, not
 *  `Token`. A token the table cannot see never arrives at all, and `hp`,
 *  `light_ft` and the two staged fields are blanked for anyone but the DM. */
export interface WireToken {
  id: string;
  name: string;
  /** Grid units, token centre. */
  x: number;
  y: number;
  owner: Owner;
  /** Site-relative, or empty for a token the client draws as a named disc. */
  img: string;
  /** Width and height in grid cells. One of 0.5, 1, 2, 3, 4; see TOKEN_SIZES. */
  size: number;
  /** What the DM has marked this creature with.
   *
   *  The same value for every recipient, unlike the fields below it: a mark
   *  nobody at the table can see is not a mark. There is nothing to redact
   *  here because a token the table cannot see never arrives at all. */
  markers: Marker[];
  /** The table cannot see this token. Only ever true on a DM connection: a
   *  hidden token is not sent to a player, so every token a player holds has
   *  this false. */
  hidden: boolean;
  /** Null for a player, always, and also null for a DM keeping no total on
   *  this creature. The two can't be told apart from here. */
  hp: Hp | null;
  /** How far this token lights the board, in feet, or null for one carrying no
   *  light of its own.
   *
   *  Null for a player, always, and they lose nothing by it: what a light
   *  does reaches them as fog, as the walls do. Also null for a DM's token
   *  that carries none, which can't be told apart, as with `hp`. */
  light_ft: number | null;
  /** Where this token lands when the staged map is promoted, or null for one
   *  staying put. Null for a player always: a plan is a cell on a map they have
   *  not been shown. */
  staged_pos: WirePos | null;
  /** Not on the live board yet: built on the map the DM is preparing. Only
   *  ever true on a DM connection. A player is not sent such a token at all,
   *  so every token a player holds has this false. */
  staged_only: boolean;
}

/** The four things anyone can draw. A closed set on the Rust side too: an
 *  unknown kind does not deserialize. */
export type ShapeKind = 'line' | 'circle' | 'cone' | 'rect';

/** Where a shape's first point is: a cell, or a token it follows.
 *
 *  Adjacently tagged like `Owner`. An enum, because an anchored shape carrying
 *  a position nothing reads would be a field that can go stale. */
export type WireOrigin = { kind: 'point'; at: WirePos } | { kind: 'token'; at: string };

/** A drawn shape. Unlike a token this is the server's own type, not a view of
 *  it: there is nothing on it one client may hold and another may not. A shape
 *  the table cannot see is absent, not redacted. */
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

/** A point in image pixels, the other coordinate space. Its own type for the
 *  reason the Rust side has one: a wall traces the art, so one stored in cells
 *  would drift off it as soon as the grid was recalibrated. */
export interface WirePx {
  x: number;
  y: number;
}

/** A solid wall, or a door and whether it is open.
 *
 *  Adjacently tagged like `Owner`. An enum and not two booleans, so "a solid
 *  wall that is open" can't be represented. */
export type WireWallKind = { kind: 'solid' } | { kind: 'door'; open: boolean };

/** One traced segment, in image pixels. The room stores single segments, not
 *  the runs the DM traces them as.
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
 * One bundle and not three fields, because the three arrive, sweep and promote
 * together, and one `null` withholds all of it. Don't add a second staged
 * field beside it: it would be one more thing to remember to filter.
 *
 * The map's own fields sit directly on this, not under a `map` key. That is
 * `#[serde(flatten)]` on the server, and it keeps older saves loading their
 * staged map.
 */
export interface WireStaged extends WireMapInfo {
  /** Traced on the next map before the table has seen it. Never sent to a
   *  player, like everything else here. */
  walls: WireWall[];
  /** Painted by hand, and applied to the party's fog when the map is promoted.
   *  There is no staged fog under this: the DM is deciding what the party will
   *  be given, not previewing what they can see. */
  overrides: WireOverrides;
}

export interface WireRoomView {
  map: WireMapInfo;
  /** The DM's next map, its walls and its paint. Always null for a player, and
   *  null also means nothing is staged, so the two can't be told apart from
   *  here. The server withholds it; it doesn't send it and rely on us not to
   *  draw it. */
  staged: WireStaged | null;
  tokens: WireToken[];
  initiative: Initiative;
  /** Draw order, already filtered: a shape anchored to a token we cannot see
   *  never arrives, because an aura on a hidden monster gives away its
   *  position. */
  shapes: WireShape[];
  /** The traced walls and doors. Empty for a player, always. Empty is also
   *  what a map nobody has traced looks like, so the two can't be told apart
   *  from here, as with `staged`. */
  walls: WireWall[];
  /** What the party can see, or null on an unfogged map.
   *
   *  The same value for everyone, unlike everything above it: fog is
   *  party-shared, so there is one answer. The DM is sent it so their own
   *  board can show, faintly, what the table is looking at. The walls stay
   *  the DM's alone; a player can only infer the geometry from the edges of
   *  this. */
  fog: WireFog | null;
  /** The cells the DM has painted over the fog by hand. Empty for a player,
   *  always, like the walls and unlike the fog. The walls and this are what the
   *  DM authored; the fog is what they produce. */
  overrides: WireOverrides;
  /** Whether the board writes each token's name under it.
   *
   *  The same value for everyone, like `fog`: the DM flips it, and every board
   *  is labelled the same way afterwards. Room-wide, not per map, because
   *  loading a new map shouldn't relabel the tokens standing on it. */
  show_names: boolean;
  /** How the movement ruler charges a diagonal.
   *
   *  Like `show_names`: set by the DM, the same value for every client. A
   *  counting convention only half the table holds is worse than either
   *  convention. */
  diagonals: Diagonals;
  /** Whether everybody's pointer is drawn on everybody's board.
   *
   *  The same value for everyone, and it also decides whether this client
   *  sends its own pointer. **A page that ignored it would send its pointer at
   *  30Hz into a room that has switched cursors off.** */
  show_cursors: boolean;
  /** Whether the DM's own pointer is drawn on the players' boards.
   *
   *  The narrower half of the switch above, the same value for everyone, but it
   *  changes nothing about sending: a player is sent this and ignores it,
   *  because the room drops the DM's frames itself. Only the DM's table panel
   *  reads it. */
  show_dm_cursor: boolean;
  /** The picture the table is looking at instead of the board, or null for the
   *  board.
   *
   *  The same value for everyone: the DM decides what is on the screens and
   *  nothing here is kept from anybody. Never a `WireMapInfo`: there is no grid
   *  on it, nothing standing on it and nothing traced across it, which is why
   *  the board underneath is left untouched. */
  backdrop: string | null;
  /** The track the room is playing, or null for silence.
   *
   *  The same value for everyone, for the backdrop's reason. It is on the view
   *  and not only on the delta because a reconnect is a fresh join: a dropped
   *  socket reloads this page, and without it that person would come back
   *  silent while the table is still listening. */
  audio: string | null;
  /** Who is connected right now, the DM among them.
   *
   *  The same value for everyone: there is no permission here and nothing to
   *  withhold. It lets the table tell whether the DM is still connected.
   *
   *  `Owner` and not `RosterSlot`, since a slot can't represent the DM. One
   *  entry per person, not per socket: somebody on a laptop and a phone is one
   *  name. */
  here: Owner[];
  /** What colour each player picked for themselves.
   *
   *  Public, unlike the scratchpad below, and the first thing a player writes
   *  that everybody else is sent. Everyone has to draw everyone else's rings,
   *  so a colour only its owner could see would be useless. */
  colours: Colours;
  /** What the DM's undo would take back, or null for nothing to take.
   *
   *  Null on every player connection, like the walls. It is also what an
   *  untouched room says, so the two can't be told apart from here. A label and
   *  not a depth because that is all the button needs: with no redo, the
   *  button has to say what a press would undo before it is pressed. */
  undo: string | null;
  /** What has been said this session that we are party to.
   *
   *  **Different content per client, not the same list with rows dropped.**
   *  Two players hold two different conversations, because a whisper is only
   *  in the copies of the two people at either end of it.
   *
   *  Session memory on the server: it is never written to disk, so it is empty
   *  on the first join after a restart and never carries last week's game. */
  chat: WireChatLine[];
  /** Our own scratchpad, and never anybody else's.
   *
   *  **The second field that differs per client**, and the first where the DM
   *  is sent less than the room holds. No view of this carries somebody else's
   *  box, the DM's view included. Empty when nothing has been written and for a
   *  client with no slot claimed; the two can't be told apart. */
  notes: string;
}

/**
 * How the movement ruler charges a diagonal step.
 *
 * `equal` is "5-5-5": every step costs one cell whichever way it goes.
 * `alternating` is "5-10-5": the second diagonal of a reading costs double, and
 * every other one after it. Counted from the start of each measurement, not
 * across a turn: nothing here holds a movement budget, so the first diagonal
 * of anything anyone measures costs five.
 *
 * It moves the ruler and nothing else. A drawn circle and a token's vision are
 * geometry, and stay Euclidean on both settings.
 */
export type Diagonals = 'equal' | 'alternating';

/**
 * Where something typed is going. `ChatTo` on the server.
 *
 * **Two destinations for anyone and never a third.** A player says it to the
 * table or to the DM; the DM says it to the table or to one player. There is no
 * player-to-player variant. That limit is the feature's scope boundary, and
 * why it is called "whisper and shout" and not "chat".
 *
 * Adjacently tagged like `Owner`, but a separate type: an owner is a person,
 * and this is a person *or* everybody.
 */
export type ChatTo = { kind: 'table' } | { kind: 'dm' } | { kind: 'player'; id: string };

/**
 * One thing somebody said.
 *
 * It carries `to` as well as `by` because a whisper has to look like one on the
 * screens of both people party to it. The DM's log holds their whisper to
 * Saelyn and Saelyn's whisper back, and only `to` tells them apart.
 *
 * Never filtered on this side. What arrives is what we are party to; the server
 * decided that, and this client only uses `to` for styling.
 */
export interface WireChatLine {
  by: Owner;
  to: ChatTo;
  text: string;
  /** The server rolled this; nobody typed it.
   *
   *  Used for styling, never filtering, like `to`. A number the server rolled
   *  and one a player typed have to look different, or having the server roll
   *  gains nothing the table can see. */
  rolled: boolean;
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
   *  is connected: that is `RosterSlot`, and only the picker uses it. */
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
  /** Created or edited. An id we have never seen is a creation. */
  | { type: 'token_changed'; token: WireToken }
  | { type: 'token_removed'; id: string }
  | { type: 'map_changed'; map: WireMapInfo }
  /** The board writes token names under them now, or it stopped. Reaches
   *  everyone, including the DM who flipped it: nothing here is predicted
   *  locally, so this frame is what updates their own checkbox. */
  | { type: 'names_changed'; show: boolean }
  /** The ruler charges diagonals differently now. Echoed to the DM who set it,
   *  for the same reason as `names_changed`. */
  | { type: 'diagonals_changed'; diagonals: Diagonals }
  /** There is a picture in front of the table now, or there is not.
   *
   *  Like `names_changed`: identical for everyone, echoed to the DM who put it
   *  up. **Nothing arrives with it.** The board is covered, not changed, so the
   *  map, walls, shapes and fog we already hold are still correct. */
  | { type: 'backdrop_changed'; url: string | null }
  /** The room is playing a track now, or it is not.
   *
   *  Like `backdrop_changed`, and nothing arrives with it either. The volume,
   *  and whether sound is on at all, are kept in this browser and never sent. */
  | { type: 'audio_changed'; url: string | null }
  /** The staged slot (map, walls and paint), or null once there is none. DM
   *  connections only.
   *
   *  It carries the whole board and not only the map, so a staged load that
   *  sweeps its walls, or a staged recalibration that drops its paint, needs no
   *  frames of its own. */
  | { type: 'staged_changed'; board: WireStaged | null }
  | { type: 'initiative_changed'; initiative: Initiative }
  /** Somebody joined or left. The whole list, at most seven names.
   *
   *  Identical for every recipient with no filter, like `names_changed`, but no
   *  command causes it. Sent on every join and every leave, not only when the
   *  list differs, so a second connection as the same person repaints the same
   *  chips and the room doesn't have to remember what it last sent. */
  | { type: 'presence'; here: Owner[] }
  /** A player picked their colour. Sent to the whole table, like `presence`.
   *
   *  Echoed to whoever picked, unlike `notes_changed`: there is no caret for it
   *  to move and nothing was drawn locally, so this frame is what updates the
   *  chosen swatch on the client that chose it. */
  | { type: 'colours_changed'; colours: Colours }
  /** The DM edited the cast. The whole list, to everyone, like `welcome`'s
   *  `roster`. Never sent to a player whose slot was removed: the server closes
   *  that connection first, and the reload lands on the picker. */
  | { type: 'roster_changed'; roster: RosterEntry[] }
  /** Somebody else's in-progress sweep, keyed by their connection. Never our
   *  own: we are already drawing that one from our own pointer. */
  | { type: 'sketch'; by: number; kind: ShapeKind; at: WirePos; to: WirePos; color: string }
  /** That sweep is over: released, or its client went away. */
  | { type: 'sketch_ended'; by: number }
  /** Somebody pinged. Draw a ring there for a second or two.
   *
   *  Keyed by `Owner`, not by connection like the two sweeps above: a ping
   *  replaces no previous frame and needs no release, so all we need is whose
   *  ring to draw. Never our own, which has been on our board since the hold
   *  was 150ms old.
   *
   *  **The one frame carrying a position that no visibility filter touches.** A
   *  ping lands wherever it was pointed, unexplored ground included. */
  | { type: 'pinged'; by: Owner; at: WirePos }
  /** Somebody's pointer is here now. Draw it until it stops arriving.
   *
   *  Like `pinged`, it carries an `Owner` and is never our own. Unlike `pinged`,
   *  it is filtered: the DM's pointer is withheld from a player while it is over
   *  ground the party has not explored, because a ping is a gesture somebody
   *  chose to make and a cursor is just where the mouse is. The room decides
   *  that; whatever arrives may be drawn. */
  | { type: 'cursor_moved'; by: Owner; at: WirePos }
  /** Pointers are drawn on every board now, or they are not.
   *
   *  Like `names_changed`, but this one also changes what this client sends:
   *  with it off the room relays nothing, so a client that kept sending would
   *  be spending bandwidth for nothing. */
  | { type: 'cursors_changed'; show: boolean }
  /** The DM's pointer is drawn on the players' boards now, or it is not.
   *
   *  Unlike the frame above, this doesn't change what anyone sends. The only
   *  thing a client does with it is update the DM's own checkbox. */
  | { type: 'dm_cursor_changed'; show: boolean }
  /** Somebody said something we are party to: a shout, or a whisper we sent or
   *  received.
   *
   *  **Including our own**, unlike `pinged` and `sketch` above. A line of text
   *  is not drawn locally first, because the room decides where it lands in the
   *  log and two people may type at once. */
  | { type: 'said'; line: WireChatLine }
  /** Our own scratchpad now reads this. Sent when our *other* tab changed it.
   *
   *  Never sent to the socket that typed it: that box already holds the text,
   *  and writing it back a round trip later moves the caret. So this follows
   *  `pinged` (no echo), not `said`. */
  | { type: 'notes_changed'; text: string }
  /** Every shape we may see. The whole list, like the initiative panel. */
  | { type: 'shapes_changed'; shapes: WireShape[] }
  /** Every wall the DM has traced. DM connections only. A player is not sent
   *  this frame at all, not even an empty one, because a frame they cannot use
   *  still tells them the DM just did something. */
  | { type: 'walls_changed'; walls: WireWall[]; staged: boolean }
  /** What the party can see now, and everywhere they have been. Null once the
   *  map is not fogged. Reaches everyone, unlike the walls, and only on a drop,
   *  never on a drag frame. */
  | { type: 'fog_changed'; fog: WireFog | null }
  /** Every cell the DM has overridden. DM connections only: a player is not
   *  sent this frame at all, for the same reason as `walls_changed`. What they
   *  are sent is the resulting `fog_changed`. */
  | { type: 'overrides_changed'; overrides: WireOverrides; staged: boolean }
  /** The DM undid something and the room is in an earlier state. Replace all
   *  held state with this.
   *
   *  The whole world and not a diff, because the main case undo exists for is
   *  a map load, which sweeps the walls, the drawings and the fog in one
   *  command. Filtered by the same `snapshot_for` a join goes through, so a
   *  player is sent one of these with no walls and no staged map in it, as on
   *  connect.
   *
   *  **Not a second `welcome`**: `onWelcome` builds the panels, the tools and
   *  the board once per connection. This only hands over state, with no
   *  identity or roster, neither of which an undo can change. */
  | { type: 'restored'; state: WireRoomView }
  /** What the DM's next undo would take back. DM connections only, like
   *  `walls_changed`, though here it is not a secret, just a label for a button
   *  a player does not have.
   *
   *  Arrives with every change to the room, which keeps the button right when
   *  the DM's other tab, or a player's drawing, adds a step. */
  | { type: 'undo_changed'; label: string | null }
  | { type: 'error'; message: string };

export type ClientMsg =
  | { type: 'hello'; dm_secret: string | null; player_id: string | null }
  /** Put the room back the way it was before the last thing that changed it.
   *  DM-only, and carries nothing: only the top of the room's ring can be
   *  undone, so there is no depth for this to name. Undoing twice is sending
   *  it twice. */
  | { type: 'undo' }
  /** `staged` names which of the token's two positions this writes. The intent
   *  is on the command because the server must not learn we are previewing;
   *  preview is client-only. DM-only when true. */
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
      /** Whether this map is fogged and how far a token sees on it. Here and
       *  not on a command of their own, like the grid colour: they are fields
       *  of the map, remembered per URL with the rest of it. */
      fog: boolean;
      vision_ft: number;
      lighting: Lighting;
      /** What shape the cells are. Here for the same reason as the three
       *  above. */
      grid_shape: WireGridShape;
      staged: boolean;
    }
  /** Say something, to the table or to one person.
   *
   *  One command for a whisper and a shout, because they differ only in where
   *  they are going, and the destination is what the server's permission check
   *  is about. It carries no sender: the socket already identifies who said
   *  it. */
  | { type: 'say'; to: ChatTo; text: string }
  /** Throw `count` dice of `sides` faces and say the result to `to`.
   *
   *  The loaner die. It comes back as an ordinary `said`, because a roll is a
   *  chat line. So there is no frame to handle for it, and a private roll to
   *  the DM uses the destination chip that is already selected.
   *
   *  Counts and no modifiers: a dice bag has the first and not the second. */
  | { type: 'roll'; sides: number; count: number; to: ChatTo }
  /** Replace our own scratchpad. It carries no key: the box it lands in is
   *  the one the socket belongs to, because a key we could name is a key we
   *  could use to name somebody else's. */
  | { type: 'set_notes'; text: string }
  /** Pick our own colour. It carries no key either, for `set_notes`' reason:
   *  whose colour it is comes from the socket.
   *
   *  An index into a closed palette and not a hex string, because free hex
   *  would let a player take the gold a token ring uses for ownership and make
   *  their own ring misleading. The server holds the bound; `PLAYER_HUES` in
   *  `pings.ts` holds the colours. Never sent by the DM, whose hue is outside
   *  the six; the server refuses it. */
  | { type: 'set_colour'; colour: number }
  /** DM-only. The staged map becomes the board; tokens keep their cells. */
  | { type: 'promote_staged' }
  /** DM-only. Throw the staged map away. */
  | { type: 'clear_staged' }
  /** DM-only. No id: the server assigns it. `staged` builds it on the map being
   *  prepared, where nobody else sees it until the promote. */
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
      light_ft: number | null;
      /** Usually empty. It is here so that duplicating a marked creature is one
       *  command, which is the only time it is non-empty. */
      markers: Marker[];
      staged: boolean;
    }
  /** DM-only. Every editable field at once; only `move_token` sets position.
   *  Taking damage is this command with a new `hp`; there is no `set_hp`.
   *
   *  No `staged` flag, unlike the commands around it: every field here is
   *  shared by both boards, so an edit applies to both at once. Only position
   *  and existence differ between the two. */
  | {
      type: 'update_token';
      id: string;
      name: string;
      img: string;
      size: number;
      owner: Owner;
      hidden: boolean;
      hp: Hp | null;
      light_ft: number | null;
      /** The whole set, not a toggle. This command replaces the token, so
       *  every sender has to pass the current markers through, which is why
       *  there is no `set_markers`. Required, not optional, so the compiler
       *  catches a sender that forgets. */
      markers: Marker[];
    }
  | { type: 'delete_token'; id: string }
  /** DM-only. Whether the board writes token names under them, for everyone.
   *
   *  Its own command and not a field on `set_map`, where the fog switch is:
   *  this belongs to the room and not to the image, so on a map command it
   *  would differ between the two slots and reset on every load. */
  | { type: 'set_show_names'; show: boolean }
  /** DM-only. How the ruler charges a diagonal, for everyone. Room-wide and not
   *  on `set_map`, for the reason above: the table's counting convention
   *  doesn't change with the map. */
  | { type: 'set_diagonals'; diagonals: Diagonals }
  /** DM-only. Whether everybody's pointer is drawn on everybody's board.
   *
   *  The switch stops the relay, not just the drawing, so a client told `false`
   *  stops sending as well. Seven pointers over a board that already carries
   *  tokens, nameplates, bars, rulers, trails, shapes and fog is a real cost,
   *  and a switch that saved none of it would only be a display preference. */
  | { type: 'set_show_cursors'; show: boolean }
  /** DM-only. Whether the DM's own pointer is drawn on the players' boards.
   *
   *  It stops the relay only. One client in seven is not enough traffic to
   *  justify a second condition where pointers are sent, so unlike
   *  `set_show_cursors` nothing here changes what anybody sends. */
  | { type: 'set_show_dm_cursor'; show: boolean }
  /** DM-only. Put a picture in front of the table, or null to take it away.
   *
   *  Room-wide and not on `set_map`, because a `set_map` is a map load, which
   *  sweeps the walls, the drawings and everywhere the party has explored. This
   *  command must do none of that. */
  | { type: 'set_backdrop'; url: string | null }
  /** DM-only. Put music on for the room, or null to stop it.
   *
   *  Kept as small as `set_backdrop`. The room holds a URL and not a playback
   *  position: where each browser is in the track is up to that browser, and
   *  syncing positions would turn this toward a mixer. See `docs/sound.md`. */
  | { type: 'set_audio'; url: string | null }
  /** DM-only. The whole cast, in order. A slot missing from it was removed,
   *  which the server refuses while that player owns a token. A new slot's id is
   *  made here from its name (`slugFor`) and never changes after; a rename
   *  changes only `name`. See `docs/rooms.md`. */
  | { type: 'set_roster'; roster: RosterEntry[] }
  /** A shape being swept out right now: relayed to everyone watching, stored by
   *  nobody. `drawing: false` is the release that ends it.
   *
   *  The client decides whether a release keeps anything: the measuring tool
   *  stops here and the area tools follow with an `add_shape`. The server
   *  treats all four kinds the same and never learns which tool was used. */
  | {
      type: 'sketch';
      kind: ShapeKind;
      at: WirePos;
      to: WirePos;
      color: string;
      drawing: boolean;
    }
  /** Look here. Anyone may send it; it is relayed to everyone else and stored
   *  by nobody. There is no `drawing` flag because a ping is one frame, not a
   *  stream: the hold is over by the time this goes out.
   *
   *  No colour on it either, unlike `sketch`: the ring's colour follows from who
   *  sent it, and every client can work that out from the roster. */
  | { type: 'ping'; at: WirePos }
  /** Where our pointer is now, in grid units. Relayed to everyone else and
   *  stored by nobody.
   *
   *  Throttled to ~30Hz and sent only on movement, because this is the busiest
   *  message in the protocol: drag frames are sent while a token is moving,
   *  and these whenever the mouse moves. No frame ends one; each recipient
   *  drops a cursor that stops arriving, on its own timer. */
  | { type: 'move_cursor'; at: WirePos }
  /** Keep the shape just swept. No id: the server assigns it, like a token's. */
  | { type: 'add_shape'; kind: ShapeKind; from: WireOrigin; to: WirePos; color: string }
  /** Whoever drew it, or the DM. */
  | { type: 'remove_shape'; id: string }
  /** DM-only: it erases other people's drawings. */
  | { type: 'clear_shapes' }
  /** DM-only. One traced run: its corners in order, in image pixels, and the
   *  segments between them become that many walls. No ids: the server assigns
   *  one per segment, like a shape's.
   *
   *  The run is sent whole, not a segment per click, because a
   *  two-hundred-segment dungeon would otherwise be two hundred round trips.
   *  `door` applies to every segment of it.
   *
   *  `staged` names the board, like `move_token` and `set_map`: the intent is on
   *  the command because the server must not learn we are previewing. Every
   *  wall command below carries it for the same reason. */
  | { type: 'add_walls'; points: WirePx[]; door: boolean; staged: boolean }
  /** DM-only. One segment. There is no "erase this run", so a single bad
   *  segment can be fixed without redrawing the trace. */
  | { type: 'remove_wall'; id: string; staged: boolean }
  /** DM-only, and refused on a solid wall. On the board it opens a room to the
   *  party mid-fight; on the staged board it is preparation: a door left open
   *  there is open when the map is promoted. */
  | { type: 'toggle_door'; id: string; staged: boolean }
  /** DM-only. Every wall on one board. Unlike `clear_shapes` it erases nobody
   *  else's work, since the walls are all the DM's. */
  | { type: 'clear_walls'; staged: boolean }
  /** DM-only. The cells one brush stroke or one fill covered, and what to set
   *  them to.
   *
   *  **The cells are the payload, not a seed.** The fill is computed here,
   *  because the preview has to compute it anyway. Sending the previewed cells
   *  makes the preview and the result the same set, instead of two
   *  implementations that would have to agree. `state` of null hands them back
   *  to line of sight. */
  | {
      type: 'set_fog_override';
      cells: [number, number][];
      state: FogPaint | null;
      /** Which board's mask. Painting the staged one is not previewing what the
       *  party will see there: it decides what they are given when the map is
       *  promoted, which is why there is no staged fog under it. */
      staged: boolean;
    }
  /** DM-only. The whole map back to dark: every override cleared and everywhere
   *  the party has explored forgotten, then line of sight recomputed from where
   *  the tokens are standing. One command because it is one action: "this map
   *  has not been seen yet". */
  | { type: 'reset_fog' }
  | { type: 'set_initiative'; token: string; value: number }
  | { type: 'remove_from_initiative'; token: string }
  | { type: 'clear_initiative' }
  | { type: 'next_turn' }
  | { type: 'previous_turn' };

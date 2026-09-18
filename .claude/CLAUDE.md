# Slate

A minimal virtual tabletop for a private, remote D&D game. Six players plus a DM.
It replaces Foundry for one specific group that only needs a shared map, tokens, and turn order.

This file is the contract: what Slate is, what it must never become, and the rules that hold
across every feature. It is loaded into every session. Two kinds of thing live outside it,
deliberately, and neither is loaded for you:

- **`ROADMAP.md`** — design for what is not built yet, and the milestone order. Read it when
  starting a milestone.
- **`docs/*.md`** — one file per subsystem (`maps`, `tokens`, `drawings`, `walls`, `fog`, `undo`,
  `chat`, `dice`, `notes`, `sound`, `presence`, `rooms`, `frontend`, `net`): why each built
  feature is the shape it is. Every feature section below ends with a pointer to its file and the
  code that file covers. **The summaries here are enough to use a feature and not enough to
  redesign one** — the mechanism, the failure modes and the arguments are in `docs/`.

(All referenced in backticks on purpose: a bare `@` path here would be an import, and importing
them would load them into every session, which is what moving them out avoided.)

## What it does

- Displays a background map image with pan and zoom
- Shows tokens on that map; the DM moves any token, players move only their own
- Tracks initiative order and the current turn
- Lets the DM prepare the next map out of sight of the table, then promote it
- Lets the DM put a picture in front of everyone's board for the stretches of an evening with
  nothing to move, without costing the encounter underneath it
- Lets anyone measure a distance, draw a spell area, or point at a spot so everyone sees where
- Lets the DM trace walls and doors, and limits what the table sees to what their own tokens have
  line of sight on — or, per map, to the whole room each token stands in — with a hand override
- Lets the DM take back the last handful of things that changed the room
- Lets anyone say something to the table or whisper the DM, and the DM whisper any one player —
  two destinations and nothing else, kept for the evening and never written down
- Lends a die to whoever came without one, thrown by the room into that same log
- Plays one looping track the DM picks, at whatever level each person set for themselves
- Gives everyone a private box to write in that no other screen is ever sent, the DM's included
- Shows who is connected, tells you when it is your turn, recovers a dropped socket, lets a
  player choose their colour, and draws everybody's pointer on everybody's board

## Non-goals

Out of scope. Do not add them, do not scaffold for them, do not suggest them unless asked. Several
have a **bounded exception** that is built; the boundary is the specification, and the test named
beside each is what keeps it closed.

- **Character sheets, stat blocks, or any 5e rules knowledge.** A hit point total the DM keeps on
  a monster is in scope; anything that knows what a hit point *means* is not.
- **Dice beyond a loaner.** Test: *could a bag of plastic do this?* Counts yes (`8d6`); arithmetic
  no — no modifiers, no expressions, no macros, no parsing of anything typed, no per-token dice,
  no wiring into initiative. A modifier is a character sheet with one field filled in. See
  `docs/dice.md`.
- **Voice and video** (the group uses Discord). Text is the bounded exception: a player may whisper
  the DM or shout to the table, and that is the whole feature. No player-to-player, no channels,
  no threads, no history between sessions, no formatting, no emotes, no commands. See
  `docs/chat.md`.
- **A scene system** — several maps each owning walls, fog and token positions, switched between
  in play. It would turn every `staged` flag into a scene id and fork token positions per scene.
  The **backdrop** is not a first step toward it: a picture shown *instead of* the board with
  nothing in it to switch between. The room holds **one** URL; a *list* of backdrops in the state
  model is the scene manager wearing a different noun. See `docs/maps.md`.
- **Compendiums, handouts, journals.** Exception: one scratchpad per person, private, the DM's no
  different. **A second document makes it a journal** — no titles, pages, sharing, or handout
  button. See `docs/notes.md`.
- **Audio beyond one track.** Test: *is this still one track?* A second channel, a crossfade, a
  queue, a playlist, per-map ambience: each is a mixer arriving one field at a time. No one-shot
  stings (they want a playhead the room does not hold), **no embeds** (a third-party script on
  every client, playing ads on six screens at the dramatic beat — paste the link in chat instead).
  Notification sounds are a different, unbuilt feature. See `docs/sound.md`.
- **Module or plugin systems.**
- **5e reference lookup.** The spell index at `/spells/` is not an exception: a static page under
  `client/spells/` that imports nothing from `client/src/`, has no esbuild entry and touches no
  room state. The one anchor in the client's corner is the boundary, not a first step; anything
  that reads spell data *into* Slate is the lookup this refuses. See `client/spells/README.md`.
- **User accounts, email, password reset, OAuth.**
- **Mobile-first design.** Desktop browser is the target; don't break touch, don't optimise for it.

Scope creep is the primary risk to this project. When a request could be satisfied by a
smaller change, propose the smaller change.

## Stack

Backend: Rust — `axum`, `tokio` (full features), `tower-http` (fs, cors), `serde` + `serde_json`,
`uuid`, `futures-util`, `tracing` + `tracing-subscriber`.

Frontend: vanilla TypeScript, canvas 2D. No framework. No Pixi, no Three, no bundler heavier
than esbuild. If a dependency is proposed, justify it against "could this be 40 lines instead".

Persistence: `serde_json` snapshot to a file on disk, debounced. No database.

Deployment: **self-hosted on a Raspberry Pi 3B in the room**, behind a Cloudflare Tunnel, running a
cross-compiled binary under `systemd`. No cloud, no recurring cost — a constraint, not a stage. It
is **always on** so the DM can prepare the next dungeon on a Tuesday; that is what the staged map
and wall editor are for. Scale is still seven clients on a 1GB board. Procedure and backups in
`deploy/pi/README.md`; `deploy/windows/` hosts a game away from home.

**`/status/` is how the box is doing, and it is not part of Slate**: a static page and one
read-only `/api/status` behind `SLATE_STATUS_KEY` (a second credential, not the DM secret; unset
means the route is not mounted). Slate reports only what Slate knows; host vitals come from files
somebody else wrote. **What is wrong is decided once, in `verdict` on the server** — the page has
two renderers, `status.js` and `client/status/kindle/kindle.py` (a PNG for the Kindle on the
shelf), and neither judges. See `client/status/README.md`.

## Architecture

### Room actor

Each room is a single `tokio` task that exclusively owns its `RoomState`. There are no
locks on room state and there is no `Arc<Mutex<RoomState>>` anywhere. Clients send commands
into the room over an `mpsc` channel; the room sends messages back to each client over that
client's own `mpsc` sender.

**There is more than one room, and they are fixed at boot.** `ROOMS` is a const — an id, a display
name and a roster each — so `AppState` holds an `Arc<HashMap<String, RoomHandle>>` built once in
`main` and only ever read; **still no lock**, because nothing changes the table. Two rooms share no
field, no channel and no lock — which is why this is not the scene system, and why there is no
cross-room leak to filter. **The room is named in the WebSocket URL, not on the wire**: no
`ClientMsg`/`ServerMsg` variant, `protocol-tags.json` untouched. `/api/rooms` is the one `/api`
route without the DM secret, because the picker comes before the socket. The first entry is the
primary room: its save file is `SLATE_STATE` verbatim, every other room's a sibling `<id>.json`.
**A room id names a save file, a `localStorage` key and a `?room=` link** — changing one after play
orphans all three.

→ **`docs/rooms.md`** before touching `ROOMS`/`RoomDef`, `roster_from`, `RoomState::blank`,
`room::spawn`, `save_path`, `room_listing` or `ws_handler` on the server, or `rooms.ts`,
`chooseRoom` in `main.ts`, the storage keys in `identity.ts`, or the room in `connect`.

Per WebSocket connection, split the socket and spawn two tasks:
- recv task: reads the WS stream, deserializes, pushes `(ClientId, ClientMsg)` into the room's `mpsc::Sender`
- send task: reads that client's `mpsc::Receiver`, serializes, writes to the WS sink

### Do not use `tokio::sync::broadcast`

This is deliberate and non-obvious. `broadcast` delivers one identical value to every
subscriber, which makes per-recipient filtering impossible. Fog of war requires that different
clients receive different messages for the same underlying event, and the chat log is genuinely
different *text* per recipient. Per-client `mpsc` senders cost nothing at six clients.

### Command pipeline

The room's inner loop is always these four steps, in this order:

1. Receive a `ClientMsg` with its `ClientId`
2. Check permission; reject with `ServerMsg::Error` if denied
3. Apply to state, producing a `Vec<Event>`
4. For each connected client, map each `Event` through a visibility filter and send whatever survives

`Event` (internal) and `ServerMsg` (on the wire) are separate types even though they are
nearly 1:1 today. Do not collapse them. One event must be able to produce different outbound
messages for different recipients.

## State model

Field comments name the rule and the file; the reasoning is in the file.

```rust
struct RoomState {
    dm_secret: String,
    roster: Vec<RosterEntry>,
    map: MapInfo,
    /// The map the DM is preparing, with its walls and fog overrides — one bundle,
    /// so one `None` withholds all three. DM-only. `docs/maps.md`.
    staged: Option<StagedBoard>,
    tokens: HashMap<TokenId, Token>,
    /// Room-wide, DM's to set, everyone told. Defaults on. `docs/tokens.md`.
    show_names: bool,
    /// How the ruler charges a diagonal. Stored and relayed, never computed with
    /// on the server. `docs/drawings.md`.
    diagonals: Diagonals,
    initiative: Initiative,
    /// In draw order. `docs/drawings.md`.
    shapes: Vec<Shape>,
    /// Traced over the live map. DM-only, whole. `docs/walls.md`.
    walls: Vec<Wall>,
    /// Party-shared grid cells: everywhere a ray has reached / that widened a cell
    /// and masked / seen now. Only `revealed` is persisted and only
    /// `recompute_sight` reads it — everything else reads `known`. `docs/fog.md`.
    revealed: HashSet<Cell>, known: HashSet<Cell>, visible: HashSet<Cell>,
    /// Which tokens the table could see when last told. Written *at* the
    /// recompute, `recompute_sight` its only writer. `docs/fog.md`.
    shown: HashSet<TokenId>,
    /// The DM's mask over the live board, applied after the raycast, never a
    /// write into the sets above. DM-only, whole, staged like the walls.
    overrides: HashMap<Cell, Override>,
    /// Everything the DM prepared on each map, keyed by URL — grid, walls, fog
    /// paint. Server-side only. **The shelf, not a scene list.** `docs/maps.md`.
    calibrations: HashMap<String, Prepared>,
    /// Last ten states, for the DM's undo. Post-state: the back is the present.
    /// A snapshot is `Saved`. Memory only. `docs/undo.md`.
    undo: VecDeque<Snapshot>,
    /// This session's talk, capped. Memory only, pointedly not on `Saved`.
    /// `docs/chat.md`.
    chat: VecDeque<ChatLine>,
    /// One box per person, private — **not sent even to the DM**. On disk, and
    /// exempt from the undo ring by hand. `docs/notes.md`.
    notes: HashMap<Owner, String>,
    /// Which colour each player picked. Public, exempt from undo by hand.
    /// `BTreeMap` because `PlayerId` is a legal JSON key. `docs/presence.md`.
    colours: BTreeMap<PlayerId, u8>,
    /// Room-wide, DM's to set, read *in the filter*: off, no cursor frame leaves
    /// the room. Defaults on. `docs/presence.md`.
    show_cursors: bool,
    /// The DM's own pointer among them; read in `cursor_seen`. Defaults on.
    show_dm_cursor: bool,
    /// The picture shown instead of the board, or `None`. Nothing else in the
    /// room reads it. `docs/maps.md`.
    backdrop: Option<String>,
    /// The one track playing, or `None`. **Memory only**, unlike the backdrop —
    /// off `Saved`, so off the ring by construction. `docs/sound.md`.
    audio: Option<String>,
    /// Identified clients (the only ones any event reaches) and sockets that
    /// have not said who they are yet.
    clients: HashMap<ClientId, Client>,
    pending: HashMap<ClientId, mpsc::Sender<ServerMsg>>,
}

/// `to` is carried as well as `by` because a whisper must look like one on both
/// screens party to it. `rolled` says the room threw it — styled, never filtered on.
struct ChatLine { by: Owner, to: ChatTo, text: String, rolled: bool }
/// Two destinations and never a third. `docs/chat.md`.
enum ChatTo { Table, Dm, Player(PlayerId) }
/// A whole room and what was done to arrive at it.
struct Snapshot { did: String, state: Saved }
/// `Auto` is the absence of an entry. `Explored`/`Lit` are floors, `Dark` a ceiling.
enum Override { Explored, Lit, Dark }
/// What a diagonal step costs the ruler. `Equal` is the default.
enum Diagonals { Equal, Alternating }
/// A mark on a creature. The rule is that **nothing follows from a mark** — the
/// creature still moves, still holds its row. `Poisoned` would fail that test.
/// `Marker::ALL` is the closed set and the bound on a token's list. `docs/tokens.md`.
enum Marker { Red, Orange, Yellow, Green, Blue, Purple, Dead }
/// Does a straight line reach the cell, or does a walk. `Dynamic` is the default.
enum Lighting { Dynamic, Room }
/// A grid cell. A tuple: it indexes a lattice and never reaches the wire as itself.
type Cell = (i32, i32);

/// `to` is an *offset* from the origin. Grid units, like a token.
struct Shape { id: ShapeId, kind: ShapeKind, from: Origin, to: Pos, by: Owner, color: String }
enum ShapeKind { Line, Circle, Cone, Rect }
enum Origin { Point(Pos), Token(TokenId) }

/// In image pixels, not cells — invariant 1's exception.
struct Wall { id: WallId, from: Px, to: Px, kind: WallKind }
enum WallKind { Solid, Door(bool) }

struct MapInfo {
    url: String, grid_px: f32, offset_x: f32, offset_y: f32,
    grid_color: String, play_area: Option<Rect>,
    /// Per map, remembered per URL. `fog` defaults off, `lighting` to `Dynamic`.
    fog: bool, vision_ft: f32, lighting: Lighting,
    /// Per map. `fog::basis` and `gridBasis` are the only readers. Defaults to
    /// `Square`, which keeps every saved board where it was. `docs/maps.md`.
    grid_shape: GridShape,
}
/// A square of side `grid_px`, or a diamond `grid_px` tall and `ratio` times as
/// wide. Flat — a lattice, not a 2.5D renderer.
enum GridShape { Square, Iso { ratio: f32 } }

struct Token {
    id: TokenId, name: String, x: f32, y: f32, owner: Owner, img: String, size: f32,
    /// **The only public field here.** A set in practice. `docs/tokens.md`.
    markers: Vec<Marker>,
    /// DM-only, all three. `light_ft` replaces the map's `vision_ft` on a token a
    /// player owns and makes any other token a source at all. `docs/fog.md`.
    hidden: bool, hp: Option<Hp>, light_ft: Option<f32>,
    /// DM-only, both. `docs/tokens.md`.
    staged_pos: Option<Pos>, staged_only: bool,
}
struct Hp { current: i32, max: i32 }
/// Grid units. `Px` is the same pair in image pixels, a separate type so the
/// two spaces cannot be swapped by accident.
struct Pos { x: f32, y: f32 }
enum Owner { Dm, Player(PlayerId) }
```

### Invariants

These are load-bearing. Violating them creates work that is expensive to undo later.

1. **Token positions are stored in grid units, never pixels.** Recalibrating a map's grid
   size must not move any token. Pixel conversion happens only at render time on the client.
   Geometry that traces the map image — `play_area` and `Wall` — is stored in image pixels
   instead, because it is anchored to the art rather than to a cell. That is the `Pos` / `Px`
   split, and the types are separate so the two cannot be swapped silently.

2. **Every persisted struct field carries `#[serde(default)]`.** Saved rooms from an older
   schema must deserialize against a newer one without a migration step.

3. **The join snapshot goes through the same filter as every delta.** Implement
   `snapshot_for(&self, client) -> RoomView`, not `snapshot()`. The most common way to leak
   hidden state is to filter deltas correctly and then send the whole world on connect.

4. **The server is authoritative on what a client may know, not just what it may do.**
   Never send a client data it is supposed to be unable to see and rely on the client not to
   render it.

## Permissions

```rust
fn can_move(c: &Client, t: &Token) -> bool {
    c.is_dm || t.owner == Owner::Player(c.player_id)
}
```

Everything is DM-only except the cases below, and each exception is a rule about *what the
sender owns*, never about a role:

- **Drawing.** Anyone may add a shape; erasing is `can_erase` — the DM, or whoever drew it.
- **Saying something.** Anyone may; what a player may not do is name another player. `party_to`
  decides who sees a line and never asks `is_dm`. `Roll` shares `may_address` with `Say`.
- **Writing a scratchpad, picking a colour.** `SetNotes` and `SetColour` name no key — whose it is
  comes from the socket, so there is nothing to check but a bound. **A key a client could name is
  a key it could name somebody else's with.** The DM is refused `SetColour` outright.
- **Undo is DM-only and the one command that takes back somebody else's work**, because a restore
  restores the room whole. What may go on the ring is **state the undoing hand wrote** — the
  scratchpads and a player's colour are exempt, each by two lines (`undid` says `None`, and the
  `Undo` arm puts it back around `adopt`), and both are needed. See `docs/undo.md`.

Walls and fog overrides are the opposite extreme: DM-only with no per-item rule, and a player is
never *sent* one or told one changed. Token creation, deletion, editing, ownership, planning
(`staged_pos`), map changes, initiative edits, and every room-wide switch (`show_names`,
`diagonals`, `show_cursors`, `show_dm_cursor`, `backdrop`, `audio`) are DM-only.

The DM owns every library — listing, picking, adding, removing. Every route under `/api` (bar
`/api/rooms`) authenticates with the DM secret; a player has no credential, and giving them one
would be the authentication this project does not build.

Identity: the DM joins with a secret in the URL. Players join with a plain room link and claim a
name from a roster the DM defined. `player_id` persists in `localStorage`, and **a roster slot's id
is a slug, not its name** — renaming a character touches the name alone. This is a private game
among friends — do not build real authentication.

## Wire protocol

JSON over WebSocket, serde tagged enums: `#[serde(tag = "type", rename_all = "snake_case")]`.
Do not switch to a binary format. Human-readable frames in devtools are worth more than the
bandwidth during drag-sync debugging.

On join, the server sends `ServerMsg::Welcome { your_id, is_dm, player_id, state, roster }` with a
full filtered snapshot; everything after is a delta. Reconnection is just another join. `state` is
a boxed `RoomView` — the room as that one client may see it. `roster` is the cast list, not who is
connected.

**`ServerMsg::Restored` is the second frame carrying a whole `RoomView`, and it goes through the
same `snapshot_for`** — invariant 3 on the one message that would otherwise be a second place to
get it wrong. It is deliberately not a second `Welcome`: `onWelcome` builds panels, tools and board
once per socket, so a restore hands over state and nothing else.

**`Token` never reaches the wire; `TokenView` does.** `Token::view_for(is_dm)` names every field
that leaves the room. Third layer of `Event`/`ServerMsg` and `RoomState`/`RoomView`, and it makes
the failure fail the safe way: a secret added to `Token` and forgotten here is *absent* from the
wire, visible as the DM's own client missing a field.

**Unfiltered frames** — identical for every recipient: `fog` (party-shared, nothing per-client to
build), and every room-wide switch plus `here` and `colours` (who may set them is a permission;
what they say is not a secret). Everything else is filtered, and two fields are *different text*
per recipient rather than the room's copy with rows dropped: `chat` and `notes`.

**Echo rules.** The sender is not echoed drag frames, sketches, pings, cursors or `NotesChanged`.
`Said` is the one exception — a log is a sequence and where a line lands is the room's to decide.

**The send task pings an idle socket every 30 seconds**, at the protocol level, so a proxy does
not close a quiet board. A keepalive is not a reconnect.

**An inbound frame is capped at `MAX_WS_MESSAGE_BYTES`, read-side only.** So a command carrying a
collection has two bounds — the count the room refuses past, and the bytes the socket accepts —
and a test must serialise the largest legal instance and assert it fits, because `check` never
runs on a frame the socket dropped (`largest_override_fits_in_a_frame`).

**`ClientMsg` and `ServerMsg` are written out by hand twice**; `protocol-tags.json` is the third
copy both are checked against. **A new variant is four edits**: the exhaustive `match` (stops
the crate compiling), `KNOWN_CLIENT_TAGS`/`KNOWN_SERVER_TAGS` (what the fixture is compared
against — update only the first and the suite fails with a message that blames the fixture), the
TypeScript `Record<Msg['type'], true>`, and the fixture. Variant-level only; a renamed field is
caught by the server rejecting the frame.

→ **`docs/net.md`** before changing the wire format, the frame cap, or the keepalive.

## Drag semantics

Token movement uses two message rates:

- During drag: `MoveToken { dragging: true }`, throttled client-side to ~20–30 Hz. The room
  applies it in memory and relays it, but does not snap to grid and does not mark state dirty.
- On drop: `MoveToken { dragging: false }`. This snaps to the grid and marks the room dirty
  for persistence.

The client predicts locally — it moves its own token immediately rather than waiting for the
round trip, and corrects only if the server rejects. The server must not echo drag frames back
to the originating client; doing so causes visible rubber-banding.

`MoveToken` and `TokenMoved` both carry `staged`, naming which of the token's two positions the
frame is about. Everything either side of that one branch is unaware there are two.

## Tokens

A square `size` cells across, centred on its position; `size` is one of `0.5, 1, 2, 3, 4`. Where a
token settles lives in `snap_to_cell` on the server and nowhere else — the client never snaps.
Create/delete/edit are DM-only and the id is the server's. `UpdateToken` carries every editable
field except position; `TokenChanged` covers creation and editing alike. Duplicating is a
client-side `CreateToken`. **Deleting a token takes its initiative row and its anchored drawings.**
The Delete key deletes everything wearing a ring — panel's token and shift-click group alike, one
confirm, N ordinary deletes; `N` advances the turn. Both DM-only by construction and both stand down
inside a field via `typingIn`, the rule every global key that is not Escape asks.

**`RoomState::unseen_by_table(&Token)` is the only question any filter asks** — `hidden`,
`staged_only`, *and* line of sight, which is why it lives on `RoomState` and not `Token`. Anything
asking `Token::unseen` directly is filtering on two reasons out of three, which is a leak. **Every
`was_unseen` on an event asks the same question**, read before the change it describes (for a
promote, before the sweep); getting it wrong sends the table a `TokenRemoved` naming an id they
never held.

`markers` is the one public field and rides `CreateToken`/`UpdateToken` — no command, event,
`message_for` arm or fixture entry. Drawn as arcs inside the token's rim, with the X for `dead`;
every state ring is outside it, and **position is the separator, not hue**.

Art is optional. The DM uploads or picks from `portraits/`; a pick copies into uploads, so `img`
is the same kind of URL either way. Copy names are **prefixed and content-fingerprinted**; maps opt
out of both because their calibration table is keyed on the URL.

**The initiative panel is the DM's combat screen** — portrait and hit points per row, nothing on
the wire, and the bar has no permission check because a player's copy carries no `hp`. Damage is
typed on the row as a delta (`-12`, `+7`, bare `35` sets) and sends an ordinary `UpdateToken`;
the panel is rebuilt on every delta so the typed box must get its focus back. It folds to the
current row; the fold is `localStorage`, not the room. Shift-click groups tokens and a group
drag is N ordinary `MoveToken`s — the server does not know groups exist.

`show_names` is on the room, not `MapInfo` or the token: it belongs to neither the image nor any
one creature, which is why it is on the table tab.

→ **`docs/tokens.md`** before touching `tokens.ts`, `panel.ts`, `markers.ts`, `library.ts`,
`snap_to_cell`, `Token`/`TokenView`/`Marker`, the `selection` set in `input.ts`, or any
`message_for` arm.

## Drawings and distance

Line, circle, cone, rectangle — **one struct: a kind and two points**, `to` an offset from the
origin. One hit test and one coverage rule, both `containsPoint`. Grid units, so recalibrating
leaves a 20 ft circle 20 ft across. Snapping at both ends is the client's; Alt sweeps free.

**Anyone may draw** — the only thing a player can add or destroy. Measure draws in the sweeper's
colour; area tools take the picked swatch. A sketch in progress is on the wire and not in the room
(`Sketch` carries `drawing`, like `MoveToken` carries `dragging`). No staged shapes. `shapes_for`
withholds an anchored shape through `unseen_by_table` and an unanchored one unless a covered cell
is `known`.

A cell is five feet, counted in cells crossed. `Diagonals` is the DM's switch and moves the ruler
only — radii and vision stay Euclidean. `feetMoved` is client-only, from `TokenMoved` frames. The
trail is the straight line from origin to token, never the mouse path. A drag through a wall draws
the DM's amber: a hint, never a refusal, and it cannot leak because a player holds no walls.

**Ping**: hold the button with nothing armed, ~400ms, cancelled by movement or early release, so
doors still swing and a click still erases. It ignores the draw tool specifically. **No fog gate
and the one positioned message no filter touches** — a ring over black says only that somebody is
gesturing. Not in `moves_sight`, not in `persists`, absent from `snapshot_for`. `Pinged` carries an
`Owner`; colour is derived client-side. Off-screen draws an edge arrow, never a pan.

→ **`docs/drawings.md`** before touching `shapes.ts`, `drawtool.ts`, `ruler.ts`, `pings.ts`,
`snapOrigin`/`snapExtent`/`hasExtent`, `trailCells`, `crossesWall`, `edgeMarker`, `SetDiagonals`,
or `Shape`/`ShapeKind`/`Sketch`/`Ping` on the server.

## Walls and doors

The DM traces a polyline; the room stores **one `Wall` per gap between corners**, in image pixels.
A door is `WallKind::Door(bool)` rather than a flag, so "a solid wall that is open" cannot be said.
**A door swings on a click with no tool in hand** — a play-time action, and the one place a click's
meaning depends on what is under it: a token wins, a moved click was a pan, an armed tool takes
the button first.

**Walls reach the DM or nobody.** No `WallView`; a player's snapshot carries an empty list and
`WallsChanged` produces no message for them. A load into the live slot sweeps them and a
recalibration must not — `sweep_board`, shared with the shapes, and a **move** onto the shelf
rather than a destruction. The staged map has walls and overrides of its own; a promote moves the
pair onto the board.

→ **`docs/walls.md`** before touching `walls.ts`, `walltool.ts`, `sweep_board`, or
`Wall`/`WallKind`/`Px` on the server.

## Fog of war

Three sets of cells, **party-shared**: `revealed` (ever had sight), `known` (`revealed` widened one
cell by `with_fringe`, so traced masonry lands on screen), `visible` (sight now). **Terrain gates on
`known`, creatures on `visible`.** Vision comes from tokens a player *owns*. `with_fringe` never
touches `visible` or `revealed`: widening the first hands over the ogre behind the wall, and
writing into the second bakes an unreached cell into the save.

**Two modes, one question.** `Dynamic` raycasts to cell centres (not shadowcasting — a wall is an
arbitrary segment, and rasterising it blinds both sides). `Room` floods, unioned with the raycast,
bounded by every traced segment open or shut. `fog::sight_cells` is the only reader of `lighting`.
Radius is Euclidean. **A token may carry a light** (`light_ft`), gated on the party having line of
sight to it at any distance — ungated, a promote hands the table every lit room.

`fog`, `vision_ft` and `lighting` live on `MapInfo`, remembered per URL, sent on `SetMap` — no
`SetFog`. `FogView` is one string, identical for every recipient including the DM: the geometry is
the secret, the shadow is what the table plays with. **Recompute on the drop, never on a drag
frame** — `moves_sight` is `persists`'s twin. `forget_fog` on load, promote, recalibration, play
area; `ResetFog` is that plus the overrides.

**The DM's override is a mask after the raycast, and nothing but a ray writes `revealed`.**
`Lit`/`Explored`/`Dark` shape `known` and `visible`, so nothing downstream knows the word. DM-only
and unsent like the walls; `SetFogOverride` carries the cells because the client previews the fill.
The staged map has a mask and pointedly no fog — no staged `revealed`, and a staged preview would
be client-only. **Do not put it in the room.**

**`solo.ts` and `mirror.ts` are client-only and stay that way** — a second raycast the DM's client
runs over data it already holds. Solo: one creature's sight. Mirror (*player view*): the table's
board via `asTable`, the client-side twin of `snapshot_for`; not a security boundary. `SOLO_SIGHT`
is off since milestone 34. Per-player fog is `ROADMAP.md` milestone 29 — read it before arguing
from "party-shared".

→ **`docs/fog.md`** before touching `fog.rs`, `fog.ts`, `solo.ts`, `mirror.ts`, `overrides.ts`,
`fogtool.ts`, `unseen_by_table`, `with_fringe`, `shape_seen`, `refresh_fog`,
`sight_cells`/`lit_cells`, `Source`/`in_line_of_sight`, `party_sources`/`sight_sources`, or
`moves_sight`.

## Frontend

Camera is `{ x, y, zoom }`. `screenToWorld` and `worldToScreen` are the only places coordinate
math lives. Set the canvas transform once and draw everything in world coordinates; hit-test in
world coordinates too. Everything downstream trusts those two functions.

**The left rail shows one DM editing panel at a time behind a tab strip** — a new panel is an entry
in `RailTab` and the array `main.ts` passes to `createRail`, never another `<aside>`. Which panel a
control belongs on is where its field lives: `MapInfo` → map tab, `Token` → token tab, room-wide
`RoomState` → table tab. Three rules: closing a tab calls the panel's `stop`; a panel that goes
inert makes its **tab** inert too, and a tab wrongly greyed is the same defect as one wrongly
live; **only a click on a tab changes the tab** — nothing on the board or wire moves the rail. The
open tab is `localStorage`. The draw tool is pinned below the strip, not on it: everybody has it
and it is used mid-fight.

**The bottom-right `#corner`** holds the gesture hint, fit (`Stage.fit`, everybody's, `Home`) and
the `/spells/` link — each arms nothing and carries no count. **The right-hand column** is presence
strip (pinned top, the edge that never moves), initiative panel, then the dock. **The dock is a
second strip, everybody's**, in `dock.ts` rather than a generalised rail: nothing behind it arms the
canvas, tabs carry unread counts, and its panels stack. It grows upward, strip last.

→ **`docs/frontend.md`** before touching `coords.ts`, `rail.ts`, `dock.ts`, `Stage.fit`/`fitToRect`,
`#corner`, or the order of the right-hand column.

## Maps

Two slots: `map`, and `staged: Option<StagedBoard>` with its own walls and overrides. One slot,
not a list. `None` is both "nothing staged" and "not the DM". **A `SetMap`'s URL alone decides
load versus recalibrate** — the calibration table, staged plans, shapes and walls all branch on it,
and a recalibration sweeps none of them (overrides are cells, so it does clear those).

**Libraries**: the DM picks from `maps/`; **a pick is a copy into uploads, not a second way to
serve files**. `portraits/`, `backdrops/` and `tracks/` are the same `Library` over other folders.
Uploading is how you add; a remove deletes the library file and nothing else; a taken name is
refused, not overwritten. A client path reaches the filesystem in two guarded places: a pick is
canonicalised inside the library, an add must be a single component.

**A backdrop is shown *instead of* the board and is not a map** — `SetBackdrop` sweeps nothing,
the board is untouched underneath, and preview wins over it. **A map remembers what the DM
prepared** (`Prepared`: grid, walls, paint, keyed by URL, never on the wire); what is filed is what
a board held as it stopped being held. The DM's authoring is remembered and the party's play state
is not — remembering `revealed` or plans is the scene system.

**Preview is client-only; the server must not learn of it.** Intent rides on each command's
`staged` flag. Everything that draws or hit-tests reads `shownBoard`/`shownWalls`/`shownOverrides`/
`shownBackdrop`, never the live board.

**Cells are squares or isometric diamonds** (`GridShape`). An iso grid is an affine image of a
square one, so everything in grid space is unchanged; `fog::basis` and `gridBasis` are the only two
readers and must agree. `iso-fixed` is a client-side gesture, not room state. **It is flat and must
stay flat**: no depth sorting, wall height, sprite anchoring or elevation.

→ **`docs/maps.md`** before touching `maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`,
`drawBackdrop`, `shownBackdrop`, `fog::basis`, `gridBasis`/`shapeOf`, `gridFromEdge`, or
`SetMap`/`MapInfo`/`GridShape`/`SetBackdrop` on the server.

## Undo

One ring, ten deep, no redo, the DM's alone. **A snapshot is `Saved`**, so `clients`, `pending`,
`chat`, `here` and `audio` stay out by construction, and `adopt` is the one inverse of `to_saved`.
Post-state: the back is the present. **A step is a command that `undid` names and `persists` agrees
with**, and `Undo` itself is never a step. Restoring re-sends the world (`Restored`), and the
button names what it would take.

→ **`docs/undo.md`** before touching `RoomState::undo`, `remember`, `adopt`, `undid`,
`Event::Restored`, `undo.ts`, or `adoptView` in `scene.ts`.

## Whisper and shout

**Two destinations and never a third** — `ChatTo`; the non-goal is the specification. One command,
`Say`, carrying no sender. **`party_to` is the whole visibility rule and never asks `is_dm`**; both
routes out (`chat_for`, the `Said` arm) go through it. Session memory, never `Saved`: a refresh
keeps the rolls, whispers are never on disk, undo cannot take back words. The sender is echoed. The
destination is sticky and shown twice; an arriving line badges a tab and toasts, opening nothing.

→ **`docs/chat.md`** before touching `chat.ts`, `dock.ts`, `party_to`, `chat_for`,
`RoomState::chat`, or `Say`/`Said`/`ChatTo`/`ChatLine` on the server.

## The loaner die

**A roll is a line of talk.** `Roll { sides, count, to }` produces a `ChatLine` and emits the
existing `Said` — no new `ServerMsg`, `Event`, filter or `persists` arm. **The room throws it**, so
`rolled` marks a witnessed number; entropy is `uuid` v4, rejection-sampled, no `rand`. `Say` and
`Roll` differ in one arm of `may_address`: the DM may roll to themselves. `DICE_SIDES` is a closed
set and `MAX_DICE` keeps the sentence inside `MAX_CHAT_LEN` (`the_largest_roll_fits_a_chat_line`).

→ **`docs/dice.md`** before touching `Roll`/`ChatLine::rolled`, `roll`, `rolled_text`,
`may_address`, `RoomState::log`, `DICE_SIDES`/`MAX_DICE`, or the die row in `chat.ts`.

## The room's music

**`SetBackdrop` copied, with one deviation: not persisted.** `audio` is off `Saved` because
`audio.src = url` is not idempotent — on the ring an unrelated undo would restart the track — and a
room reopened on Saturday should come back quiet. The client owns volume and on/off in
`localStorage`; sound starts off (browsers refuse unasked playback, and every reconnect spends the
gesture), so `sound.ts` lights the button when refused. `update` returns early on an unchanged URL.
Off means paused. The room holds a URL, not a playhead.

→ **`docs/sound.md`** before touching `RoomState::audio`, `SetAudio`/`AudioChanged`,
`Library::Tracks`, `library::Formats`/`sniff`, `sound.ts`, or the `sound` tab in `dock.ts`.

## The scratchpad

One box per person, private, the DM's no different. **The first state Slate does not send the
DM** — no `is_dm` in either filter; a box the DM can open is a surveillance feature. Do not call it
privacy: the notes are in the save file the DM hosts. What is guaranteed is that no client is ever
sent somebody else's. `SetNotes` carries no key; sends on a 500ms pause, flushed on blur, no saved
indicator. Persisted, and exempt from undo by two lines that are both needed.

→ **`docs/notes.md`** before touching `notes.ts`, `RoomState::notes`, `notes_for`, `is_owner`, the
`Undo` arm of `apply`, or `SetNotes`/`NotesChanged` on the server.

## Presence, turns, colours and cursors

**Who is connected**: `Presence` carries `Owner`s, not sockets, so a laptop and a phone are one
name and the DM's presence is sayable. Off `Saved`, dispatched where the socket table changes.
Absent people dim. **"It is your turn"** is client-only and **must not fire on a `Welcome` or a
`Restored`** — `turn.ts` has `update` and `adopt` for that reason. **A dropped socket backs off and
reloads the page**; the DM comes back as the DM via `takeDmSecret` in `localStorage`, and the
reload is the design because `onWelcome` builds once per socket.

**A player picks their colour** — an index into the closed `PLAYER_HUES`, public, duplicates
allowed, the DM refused at three layers. **Everybody's pointer is drawn** — `MoveCursor` at ~30Hz,
relayed as `CursorMoved`, no persistence, stillness ends one, no edge marker. `cursor_seen`
withholds only the DM's pointer over cells outside `known`. `SetShowCursors` stops the relay *and*
the sending (the busiest message in the protocol); it is read in the filter, not `check`, so a
`MoveCursor` that arrives while it is off is dropped rather than refused — a red banner per
`pointermove` is worse than a frame nobody is sent. `SetShowDmCursor` narrows it to one hand, read
in `cursor_seen` before the `map.fog` guard.

→ **`docs/presence.md`** before touching `presence.ts`, `turn.ts`, `cursors.ts`, the reconnect
half of `net.ts`, `RoomState::colours`/`here`/`show_cursors`/`show_dm_cursor`, `cursor_seen`,
`PLAYER_HUES`, or `SetColour`/`Presence`/`ColoursChanged`/`MoveCursor`/`CursorMoved`/
`SetShowCursors`/`SetShowDmCursor` on the server.

## Testing

Three suites; which one a change belongs in is decided by what can observe it. **`node
tools/check.mjs` runs the first two plus `cargo fmt --check` and `clippy`**, reporting every failure
rather than stopping at the first. There is no CI: nothing runs unless somebody runs it.

**`cd server && cargo test`** — the room's own, and the bulk of them. They are **child modules of
`room`**, in `server/src/room/tests/`, split along the same seams as `docs/`; tests for a feature go
in the file named for its subsystem and never back into `room.rs`. Children rather than an
integration test because they drive `RoomState` through its *private* surface, which is the only
way to assert **what a client was not sent**. `server/src/room/tests.rs` holds shared helpers.

**`cd client && npm test`** — the client's pure half, `src/*.test.ts` behind `test.mjs`: coordinate
spaces, distance rules, the trail, `crossesWall`, coverage, the flood fill. It bundles with esbuild
first because the client imports `./coords.js`. Nothing needing a canvas or socket goes here.
`npm run check` is this plus typecheck and build.

**`tools/drive-*.mjs`** — headless Chrome against a running server, and the only thing that can see
a canvas, a layout failure, or a **difference between two connections**. They mutate the room, so
point `SLATE_STATE` at a scratch file every time. `cdp.mjs` is the protocol; `board.mjs` knows where
the grid falls on screen — anything that clicks the board goes through it, because **a driver may
not assume the map it was written against.** The README lists them.

## Working agreement

- When a requirement is ambiguous, ask before implementing. A wrong guess costs more than a question.
- State uncertainty plainly. Do not present a guess about a crate's API or behavior as fact —
  check it or say you are unsure.
- Read `ROADMAP.md` before starting a milestone, and update it when one lands. Nothing loads it
  for you.
- **Read the `docs/` file for a subsystem before changing how that subsystem works**, and update
  it when the behaviour changes. The summaries above are enough to use a feature and not enough to
  redesign one; the reasoning that would stop you deleting something load-bearing is in those
  files. Nothing loads them for you either.
- **A new feature gets a short summary and a pointer here; the rest goes in `docs/`.** The summary
  says what the feature *is*, which rules bind it, and what a change must not break. If the
  summary would let you redesign the feature, it is too long. The same holds for a new field's
  comment in the state model.
- Stay within the milestone currently being worked on. Do not scaffold future milestones,
  do not add abstraction for features that are not being built yet. The invariants here, and the
  design in `ROADMAP.md`, are the only forward-looking work permitted.
- **A change to a permission, a visibility filter, or a `was_unseen` is not finished until a test
  asserts what a client was _not_ sent.** The server suite is where that assertion belongs;
  `drive-player.mjs` is the same question asked of a real browser.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Do not add dependencies without flagging it and giving the reason.

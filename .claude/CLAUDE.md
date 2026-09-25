# Slate

A minimal virtual tabletop for a private, remote D&D game: six players and a DM. It replaces
Foundry for one group that only needs a shared map, tokens and turn order.

This file covers what Slate is, what it must not become, and the rules that apply across every
feature. It is loaded into every session. Two things are kept out of it so they aren't:

- `ROADMAP.md`: design for features not yet built, and the milestone order. Read it when starting
  a milestone.
- `docs/*.md`: one file per subsystem (`maps`, `tokens`, `drawings`, `walls`, `fog`, `undo`,
  `chat`, `dice`, `notes`, `sound`, `presence`, `rooms`, `frontend`, `net`), explaining why each
  built feature works the way it does. Each feature section below ends with a pointer to its file
  and the code it covers. **The summaries here are enough to use a feature, not to redesign one.**
  The mechanism, failure modes and reasoning are in `docs/`. `docs/history.md` is the record of
  each milestone as it was built.

These are written in backticks rather than as `@` paths because an `@` path is an import, and
would load the file into every session.

## What it does

- Displays a background map image with pan and zoom
- Shows tokens on that map; the DM moves any token, players move only their own
- Tracks initiative order and the current turn
- Lets the DM prepare the next map out of sight of the table, then promote it
- Lets the DM show everyone a picture in place of the board during stretches with nothing to
  move, without disturbing the board underneath
- Lets anyone measure a distance, draw a spell area, or ping a spot so everyone sees it
- Lets the DM trace walls and doors, and limits what the table sees to what their own tokens have
  line of sight to (or, per map, to the whole room each token is in), with a manual override
- Lets the DM undo the last few changes to the room
- Lets anyone message the table or whisper the DM, and the DM whisper any one player. Two
  destinations and nothing else, kept for the session and never saved
- Lends a die to whoever came without one, rolled by the server into the same chat log
- Plays one looping track the DM picks, at a volume each person sets for themselves
- Gives everyone, the DM included, a private scratchpad that no other client is ever sent
- Shows who is connected, tells you when it's your turn, recovers a dropped connection, lets a
  player choose their colour, and shows everyone's pointer on everyone's board

## Non-goals

Out of scope. Don't add them, scaffold for them, or suggest them unless asked. Some have a
bounded exception that is built. The boundary is the specification, and where a scope test is
given, use it to decide new requests.

- **Character sheets, stat blocks, or any 5e rules knowledge.** A hit point total the DM keeps on
  a monster is in scope; anything that knows what a hit point *means* is not.
- **Dice beyond a loaner.** Test: *could a bag of plastic do this?* Counts yes (`8d6`),
  arithmetic no: no modifiers, expressions, macros, parsing of typed text, per-token dice, or
  link to initiative. A modifier is the first field of a character sheet. See `docs/dice.md`.
- **Voice and video** (the group uses Discord). Text chat is the exception: a player can whisper
  the DM or message the table, and nothing more. No player-to-player, channels, threads, history
  between sessions, formatting, emotes or commands. See `docs/chat.md`.
- **A scene system**: several maps each with their own walls, fog and token positions, switched
  between during play. It would turn every `staged` flag into a scene id and fork token
  positions per scene. The **backdrop** is not a step toward it. It's a picture shown instead of
  the board, with nothing to switch between. The room holds one backdrop URL; a *list* of
  backdrops in the state model would be a scene manager under another name. See `docs/maps.md`.
- **Compendiums, handouts, journals.** Exception: one private scratchpad per person, the DM's
  included. A second document per person makes it a journal, so no titles, pages, sharing or
  handout button. See `docs/notes.md`.
- **Audio beyond one track.** Test: *is this still one track?* A second channel, crossfade,
  queue, playlist or per-map ambience each turns it toward a mixer. No one-shot sound effects
  (they need a playback position the room doesn't store). No embeds: they run a third-party
  script on every client and can play ads on six screens mid-scene. Paste the link in chat
  instead. Notification sounds are a separate feature, not built. See `docs/sound.md`.
- **Module or plugin systems.**
- **5e reference lookup.** The spell index at `/spells/` is not an exception. It's a static page
  under `client/spells/` that imports nothing from `client/src/`, has no esbuild entry and
  touches no room state. The client's one link to it, in the corner, is where the boundary sits.
  Anything that reads spell data *into* Slate is the lookup this rules out. See
  `client/spells/README.md`.
- **User accounts, email, password reset, OAuth.**
- **Mobile-first design.** Desktop browser is the target. Don't break touch, don't optimise for it.

Scope creep is the main risk to this project. When a smaller change would satisfy a request,
propose the smaller change.

## Stack

Backend: Rust — `axum`, `tokio` (full features), `tower-http` (fs, cors), `serde` + `serde_json`,
`uuid`, `futures-util`, `tracing` + `tracing-subscriber`.

Frontend: vanilla TypeScript, canvas 2D. No framework. No Pixi, no Three, no bundler heavier
than esbuild. If a dependency is proposed, justify it against "could this be 40 lines instead".

Persistence: `serde_json` snapshot to a file on disk, debounced. No database.

Deployment: self-hosted on a Raspberry Pi 3B in the room, behind a Cloudflare Tunnel, running a
cross-compiled binary under `systemd`. No cloud and no recurring cost; that's a requirement, not
a phase. It's always on so the DM can prepare the next dungeon midweek, which is what the staged
map and wall editor are for. Scale is seven clients on a 1GB board. Procedure and backups are in
`deploy/pi/README.md`; `deploy/windows/` is for hosting a game away from home. A second site (see
below) is a second process on the same Pi, with its own user, port and hostname.

`/status/` reports on the host and is not part of Slate. It's a static page plus one read-only
`/api/status` route behind `SLATE_STATUS_KEY` (a second credential, not the DM secret; if unset,
the route isn't mounted). Slate reports only what it knows itself; host vitals come from files
written by something else. **The server decides what's wrong, in `verdict`.** The page has two
renderers, `status.js` and `client/status/kindle/kindle.py` (a PNG for the Kindle on the shelf),
and neither makes that judgement. See `client/status/README.md`.

## Architecture

### Room actor

Each room is a single `tokio` task that exclusively owns its `RoomState`. There are no locks on
room state and no `Arc<Mutex<RoomState>>` anywhere. Clients send commands into the room over an
`mpsc` channel; the room replies to each client over that client's own `mpsc` sender.

There are several rooms, fixed at boot. `ROOMS` is a const (an id, display name, seed roster and
site each), so `AppState` holds an `Arc<HashMap<String, RoomHandle>>` built once in `main` and
only read after that. Still no lock, since that table never changes after boot. Rooms share no
field, channel or lock, which is why this isn't the scene system and why there's no cross-room
leak to filter.
The room is named in the WebSocket URL, not in any message: no `ClientMsg`/`ServerMsg` variant.
`/api/rooms` is the only `/api` route without the DM secret, because the room picker comes before
the socket, and a server with one room skips the picker. The first room of each site is its
primary room: its save file is `SLATE_STATE` as given, and every other room's is a sibling
`<id>.json`. **A room id names a save file, a `localStorage` key and a `?room=` link, so changing
one after play orphans all three.**

**A site is one process and the rooms it serves** (`SLATE_SITE`, default `home`). Rooms in one
process share the DM secret, the room list, the libraries and `uploads/`, so a DM who mustn't
reach this site's rooms gets a second site: a second process with its own secret and data, not a
third room. An unknown site refuses to boot rather than fall back.

The roster is room state: saved, edited by the DM on the table tab (`SetRoster`), and seeded
from `ROOMS` only when the save has none. Removing a slot is refused while that player owns a
token, and deletes their colour and scratchpad and closes their connection.

→ `docs/rooms.md` before touching `ROOMS`/`RoomDef`, `roster_from`, `RoomState::blank`,
`room::spawn`, `save_path`, `room_listing` or `ws_handler` on the server, `SLATE_SITE`,
`SetRoster`/`RosterChanged`/`roster_allowed`, or `rooms.ts`, `roster.ts`, `chooseRoom` in
`main.ts`, the storage keys in `identity.ts`, or the room in `connect`.

Per WebSocket connection, split the socket and spawn two tasks:
- recv task: reads the WS stream, deserializes, pushes `(ClientId, ClientMsg)` into the room's `mpsc::Sender`
- send task: reads that client's `mpsc::Receiver`, serializes, writes to the WS sink

### Do not use `tokio::sync::broadcast`

This is intentional and not obvious. `broadcast` delivers the same value to every subscriber,
which makes per-recipient filtering impossible. Fog of war needs different clients to receive
different messages for the same event, and chat log text differs per recipient. Per-client `mpsc`
senders cost nothing at six clients.

### Command pipeline

The room's inner loop is always these four steps, in this order:

1. Receive a `ClientMsg` with its `ClientId`
2. Check permission; reject with `ServerMsg::Error` if denied
3. Apply to state, producing a `Vec<Event>`
4. For each connected client, map each `Event` through a visibility filter and send whatever survives

`Event` (internal) and `ServerMsg` (on the wire) are separate types even though they are nearly
1:1 today. Don't merge them. One event must be able to produce different messages for different
recipients.

## State model

Field comments name the rule and the doc file; the reasoning is in the file.

```rust
struct RoomState {
    dm_secret: String,
    /// The cast. Saved, DM-edited, excluded from undo by hand; `ROOMS` only
    /// seeds it. `docs/rooms.md`.
    roster: Vec<RosterEntry>,
    map: MapInfo,
    /// The map the DM is preparing, with its walls and fog overrides. One bundle,
    /// so one `None` withholds all three. DM-only. `docs/maps.md`.
    staged: Option<StagedBoard>,
    tokens: HashMap<TokenId, Token>,
    /// Room-wide, set by the DM, sent to everyone. Defaults on. `docs/tokens.md`.
    show_names: bool,
    /// How the ruler counts a diagonal. Stored and relayed; the server never
    /// computes with it. `docs/drawings.md`.
    diagonals: Diagonals,
    initiative: Initiative,
    /// In draw order. `docs/drawings.md`.
    shapes: Vec<Shape>,
    /// Traced over the live map. DM-only, sent in full. `docs/walls.md`.
    walls: Vec<Wall>,
    /// Party-shared grid cells: everywhere a ray has reached / that set widened
    /// one cell, then masked / visible now. Only `revealed` is persisted and only
    /// `recompute_sight` reads it; everything else reads `known`. `docs/fog.md`.
    revealed: HashSet<Cell>, known: HashSet<Cell>, visible: HashSet<Cell>,
    /// Which tokens the table could see as of the last update. Written during
    /// the recompute; `recompute_sight` is the only writer. `docs/fog.md`.
    shown: HashSet<TokenId>,
    /// The DM's mask over the live board, applied after the raycast and never
    /// written into the sets above. DM-only, sent in full, staged like the walls.
    overrides: HashMap<Cell, Override>,
    /// Everything the DM prepared on each map, keyed by URL: grid, walls, fog
    /// paint. Server-side only. The shelf, not a scene list. `docs/maps.md`.
    calibrations: HashMap<String, Prepared>,
    /// Last ten states, for the DM's undo. Each is the state *after* a change,
    /// so the back is the present. Each snapshot is a `Saved`. Memory only.
    /// `docs/undo.md`.
    undo: VecDeque<Snapshot>,
    /// This session's messages, capped. Memory only, and not on `Saved`.
    /// `docs/chat.md`.
    chat: VecDeque<ChatLine>,
    /// One per person, private, and **not sent even to the DM**. Persisted, and
    /// excluded from the undo ring by hand. `docs/notes.md`.
    notes: HashMap<Owner, String>,
    /// Each player's chosen colour. Public, excluded from undo by hand.
    /// `BTreeMap` because `PlayerId` is a valid JSON key. `docs/presence.md`.
    colours: BTreeMap<PlayerId, u8>,
    /// Room-wide, set by the DM, checked *in the filter*: when off, no cursor
    /// message leaves the room. Defaults on. `docs/presence.md`.
    show_cursors: bool,
    /// Whether the DM's own pointer is included; checked in `cursor_seen`.
    /// Defaults on.
    show_dm_cursor: bool,
    /// The picture shown instead of the board, or `None`. Nothing else in the
    /// room reads it. `docs/maps.md`.
    backdrop: Option<String>,
    /// The one track playing, or `None`. **Memory only**, unlike the backdrop:
    /// not on `Saved`, so never on the undo ring. `docs/sound.md`.
    audio: Option<String>,
    /// Identified clients (the only ones any event reaches) and sockets that
    /// haven't said who they are yet.
    clients: HashMap<ClientId, Client>,
    pending: HashMap<ClientId, mpsc::Sender<ServerMsg>>,
}

/// `to` is stored alongside `by` so a whisper looks like one on both screens
/// involved. `rolled` means the server threw it; used for styling, never filtering.
struct ChatLine { by: Owner, to: ChatTo, text: String, rolled: bool }
/// Two destinations, never a third. `docs/chat.md`.
enum ChatTo { Table, Dm, Player(PlayerId) }
/// A whole room and the action that produced it.
struct Snapshot { did: String, state: Saved }
/// `Auto` is the absence of an entry. `Explored`/`Lit` are floors, `Dark` a ceiling.
enum Override { Explored, Lit, Dark }
/// What a diagonal step costs the ruler. `Equal` is the default.
enum Diagonals { Equal, Alternating }
/// A mark on a creature. Nothing follows from a mark: the creature still moves
/// and keeps its initiative row. `Poisoned` would fail that test. `Marker::ALL`
/// is the closed set and bounds a token's list. `docs/tokens.md`.
enum Marker { Red, Orange, Yellow, Green, Blue, Purple, Dead }
/// Whether a cell is reached by a straight line or by a walk. `Dynamic` is the default.
enum Lighting { Dynamic, Room }
/// A grid cell. A tuple: it indexes a lattice and is never sent on the wire as is.
type Cell = (i32, i32);

/// `to` is an *offset* from the origin. Grid units, like a token.
struct Shape { id: ShapeId, kind: ShapeKind, from: Origin, to: Pos, by: Owner, color: String }
enum ShapeKind { Line, Circle, Cone, Rect }
enum Origin { Point(Pos), Token(TokenId) }

/// In image pixels, not cells: the exception to invariant 1.
struct Wall { id: WallId, from: Px, to: Px, kind: WallKind }
enum WallKind { Solid, Door(bool) }

struct MapInfo {
    url: String, grid_px: f32, offset_x: f32, offset_y: f32,
    grid_color: String, play_area: Option<Rect>,
    /// Per map, remembered per URL. `fog` defaults off, `lighting` to `Dynamic`.
    fog: bool, vision_ft: f32, lighting: Lighting,
    /// Per map. `fog::basis` and `gridBasis` are the only readers. Defaults to
    /// `Square`, so older saved boards load unchanged. `docs/maps.md`.
    grid_shape: GridShape,
}
/// A square of side `grid_px`, or a diamond `grid_px` tall and `ratio` times as
/// wide. Flat: a lattice, not a 2.5D renderer.
enum GridShape { Square, Iso { ratio: f32 } }

struct Token {
    id: TokenId, name: String, x: f32, y: f32, owner: Owner, img: String, size: f32,
    /// Sent to everyone, unlike the fields below. A set in practice. `docs/tokens.md`.
    markers: Vec<Marker>,
    /// DM-only, all three. `light_ft` replaces the map's `vision_ft` for a token a
    /// player owns, and makes any other token a light source. `docs/fog.md`.
    hidden: bool, hp: Option<Hp>, light_ft: Option<f32>,
    /// DM-only, both. `docs/tokens.md`.
    staged_pos: Option<Pos>, staged_only: bool,
}
struct Hp { current: i32, max: i32 }
/// Grid units. `Px` is the same pair in image pixels, a separate type so the
/// two can't be swapped by accident.
struct Pos { x: f32, y: f32 }
enum Owner { Dm, Player(PlayerId) }
```

### Invariants

Breaking these creates work that is expensive to undo later.

1. **Token positions are stored in grid units, never pixels.** Recalibrating a map's grid size
   must not move any token. Pixel conversion happens only at render time on the client. Geometry
   that traces the map image (`play_area` and `Wall`) is stored in image pixels instead, because
   it's anchored to the art rather than to a cell. That's the `Pos` / `Px` split, and the types
   are separate so the two can't be mixed up silently.

2. **Every persisted struct field carries `#[serde(default)]`.** Saved rooms from an older
   schema must deserialize against a newer one without a migration step.

3. **The join snapshot goes through the same filter as every delta.** Implement
   `snapshot_for(&self, client) -> RoomView`, not `snapshot()`. The most common way to leak
   hidden state is to filter deltas correctly and then send the whole world on connect.

4. **The server decides what a client may know, not just what it may do.** Never send a client
   data it isn't supposed to see and rely on the client not to render it.

## Permissions

```rust
fn can_move(c: &Client, t: &Token) -> bool {
    c.is_dm || t.owner == Owner::Player(c.player_id)
}
```

Everything is DM-only except the cases below. Each exception is based on what the sender owns,
never on a role:

- **Drawing.** Anyone may add a shape. Erasing is `can_erase`: the DM, or whoever drew it.
- **Chat.** Anyone may send a message; a player may not address another player. `party_to`
  decides who sees a line and never checks `is_dm`. `Roll` shares `may_address` with `Say`.
- **Writing a scratchpad, picking a colour.** `SetNotes` and `SetColour` carry no key. Whose it
  is comes from the socket, so the only check is a size bound. **A key the client could name is
  a key it could use to name someone else's.** The DM is refused `SetColour` outright.
- **Undo is DM-only, and it's the one command that reverts other people's work**, because a
  restore replaces the whole room. Only kinds of state the DM could have written go on the ring.
  The scratchpads, player colours and roster are excluded, each by two lines (`undid` returns
  `None` for it, and the `Undo` arm puts it back around `adopt`), and both lines are needed. The
  roster is the DM's, and excluded because a restore can't change who somebody is. See
  `docs/undo.md`.

Walls and fog overrides are the other extreme: DM-only with no per-item rule, and a player is
never sent one or told one changed. Token creation, deletion, editing, ownership, planning
(`staged_pos`), map changes, initiative edits, the roster, and every room-wide setting
(`show_names`, `diagonals`, `show_cursors`, `show_dm_cursor`, `backdrop`, `audio`) are DM-only.

The DM owns every library: listing, picking, adding, removing. Every route under `/api` except
`/api/rooms` requires the DM secret. Players have no credential, and giving them one would be
the authentication this project doesn't build.

Identity: the DM joins with a secret in the URL. Players join with a plain room link and claim a
name from a roster the DM defined. `player_id` persists in `localStorage`. A roster slot's id is
a slug, not its name, so renaming a character changes only the name. This is a private game
among friends; don't build real authentication.

## Wire protocol

JSON over WebSocket, serde tagged enums: `#[serde(tag = "type", rename_all = "snake_case")]`.
Don't switch to a binary format. Readable frames in devtools are worth more than the bandwidth
when debugging drag sync.

On join, the server sends `ServerMsg::Welcome { your_id, is_dm, player_id, state, roster }` with a
full filtered snapshot; everything after is a delta. Reconnecting is just another join. `state`
is a boxed `RoomView`: the room as that one client may see it. `roster` is the cast list, not
who is connected.

**`ServerMsg::Restored` is the other message carrying a full `RoomView`, and it also goes
through `snapshot_for`**, so invariant 3 covers it. It's not a second `Welcome`: `onWelcome`
builds panels, tools and board once per socket, so a restore sends state and nothing else.

**`Token` is never sent; `TokenView` is.** `Token::view_for(is_dm)` lists every field that
leaves the room. It's the same split as `Event`/`ServerMsg` and `RoomState`/`RoomView`, and it
fails safe: a secret added to `Token` and forgotten here is simply missing from the wire, which
shows up as the DM's own client lacking a field.

Unfiltered messages (identical for every recipient): `fog` (party-shared, nothing to build per
client), every room-wide setting, `here`, `colours` and `roster`. Who may set those is a permission
question; their values aren't secret. Everything else is filtered. Two fields have different
content per recipient, rather than the room's copy with rows removed: `chat` and `notes`.

Echo rules: the sender is not echoed its own drag frames, sketches, pings, cursors or
`NotesChanged`. `Said` is the exception: the chat log is ordered, and the room decides where a
line goes.

The send task pings an idle socket every 30 seconds at the protocol level, so a proxy doesn't
close a quiet connection. This is a keepalive, not a reconnect.

**Inbound frames are capped at `MAX_WS_MESSAGE_BYTES`, read side only.** A command carrying a
collection therefore has two limits: the count the room refuses past, and the bytes the socket
accepts. A test must serialise the largest legal instance and assert it fits, because `check`
never runs on a frame the socket dropped (`largest_override_fits_in_a_frame`).

`ClientMsg` and `ServerMsg` are written out by hand twice (Rust and TypeScript), and
`protocol-tags.json` is a third copy both are checked against. **A new variant needs four
edits**: the exhaustive `match` (the crate won't compile without it), `KNOWN_CLIENT_TAGS`/
`KNOWN_SERVER_TAGS` (what the fixture is actually compared against; if you update only the
`match`, the suite fails with a message that blames the fixture), the TypeScript
`Record<Msg['type'], true>`, and the fixture. This checks variants only; a renamed field is
caught by the server rejecting the frame.

→ `docs/net.md` before changing the wire format, the frame cap, or the keepalive.

## Drag semantics

Token movement uses two message rates:

- During drag: `MoveToken { dragging: true }`, throttled client-side to ~20–30 Hz. The room
  applies it in memory and relays it, but does not snap to grid and does not mark state dirty.
- On drop: `MoveToken { dragging: false }`. This snaps to the grid and marks the room dirty
  for persistence.

The client predicts locally: it moves its own token immediately rather than waiting for the
round trip, and corrects only if the server rejects. **The server must not echo drag frames
back to the sender**; doing so causes visible rubber-banding.

`MoveToken` and `TokenMoved` both carry `staged`, saying which of the token's two positions the
frame refers to. Code on either side of that one branch doesn't know there are two.

## Tokens

A token is a square `size` cells across, centred on its position; `size` is one of
`0.5, 1, 2, 3, 4`. Snapping happens only in `snap_to_cell` on the server; the client never snaps.
Create, delete and edit are DM-only, and the server assigns ids. `UpdateToken` carries every
editable field except position; `TokenChanged` covers creation and edits alike. Duplicating is a
client-side `CreateToken`. Deleting a token also removes its initiative row and its anchored
drawings. The Delete key deletes every selected token (the panel's token and any shift-click
group) with one confirm, as N ordinary deletes; `N` advances the turn. Both keys work only for
the DM because the commands they send are DM-only, and both are ignored while typing in a field
via `typingIn`, which every global key except Escape checks.

**`RoomState::unseen_by_table(&Token)` is the only question any filter should ask.** It covers
`hidden`, `staged_only` *and* line of sight, which is why it lives on `RoomState` and not
`Token`. Calling `Token::unseen` directly checks two of the three reasons, which leaks. Every
`was_unseen` on an event asks the same question, evaluated before the change it describes (for
a promote, before the sweep). Getting it wrong sends the table a `TokenRemoved` for an id it
never had.

`markers` is the only extra token field sent to players, and it travels in
`CreateToken`/`UpdateToken`, with no command, event, `message_for` arm or fixture entry of its
own. Markers are drawn as arcs inside the token's rim, with an X for `dead`; every state ring is
drawn outside the rim. Position tells them apart, not colour.

Art is optional. The DM uploads an image or picks one from `portraits/`; a pick is copied into
uploads, so `img` is the same kind of URL either way. Copies get a prefix and a content
fingerprint in their names. Maps skip both because their calibration table is keyed on the URL.

The initiative panel is the DM's combat screen: portrait and hit points on each row, with
nothing new on the wire. The HP bar has no permission check because a player's copy of a token
has no `hp`. Damage is typed on the row as a change (`-12`, `+7`; a bare `35` sets it) and sends
an ordinary `UpdateToken`. The panel is rebuilt on every delta, so the input box must be given
focus back afterwards. It collapses to the current row; that setting is in `localStorage`, not
the room. Shift-click or a left-drag box on bare board groups tokens, and a group drag is N
ordinary `MoveToken`s; the server doesn't know groups exist. **Every ringed token is in the
group**, the panel's included. Pan is the right and middle buttons (touch still pans on a
left-drag), and only a left click on bare board swings a door or clears the selection.

`show_names` is on the room, not `MapInfo` or the token, because it belongs to neither the image
nor any one creature. That's why it's on the table tab.

→ `docs/tokens.md` before touching `tokens.ts`, `panel.ts`, `markers.ts`, `library.ts`,
`snap_to_cell`, `Token`/`TokenView`/`Marker`, the `selection` set or the marquee in `input.ts`,
`marquee.ts`, or any `message_for` arm.

## Drawings and distance

Line, circle, cone, rectangle: one struct holding a kind and two points, with `to` an offset from
the origin. One hit test and one coverage rule, both `containsPoint`. Stored in grid units, so a
20 ft circle stays 20 ft across after recalibrating. The client snaps both ends; Alt drags freely.

Anyone may draw; it's the only thing a player can create or delete. The measure tool draws in the
player's own colour; area tools use the picked swatch. A sketch in progress is sent on the wire
but not stored in the room (`Sketch` carries `drawing`, as `MoveToken` carries `dragging`). No
staged shapes. `shapes_for` withholds an anchored shape via `unseen_by_table`, and an unanchored
one unless a cell it covers is `known`.

A cell is five feet, counted in cells crossed. `Diagonals` is the DM's setting and affects only
the ruler; radii and vision stay Euclidean. `feetMoved` is client-only, computed from
`TokenMoved` frames. The trail is the straight line from the origin to the token, not the mouse
path. Dragging through a wall shows amber on the DM's screen: a hint, not a refusal. It can't
leak because players never receive walls.

Ping: hold the button with nothing armed for about 400ms. Moving or releasing early cancels it,
so doors still toggle and a click still erases. It ignores the draw tool specifically. **Pings
have no fog check and are the only positioned message no filter touches**; a ring over black
only says someone is pointing there. Not in `moves_sight`, not in `persists`, absent from
`snapshot_for`. `Pinged` carries an `Owner`; the colour is derived on the client. An off-screen
ping shows an edge arrow and never pans the camera.

→ `docs/drawings.md` before touching `shapes.ts`, `drawtool.ts`, `ruler.ts`, `pings.ts`,
`snapOrigin`/`snapExtent`/`hasExtent`, `trailCells`, `crossesWall`, `edgeMarker`, `SetDiagonals`,
or `Shape`/`ShapeKind`/`Sketch`/`Ping` on the server.

## Walls and doors

The DM traces a polyline; the room stores one `Wall` per segment between corners, in image
pixels. A door is `WallKind::Door(bool)` rather than a flag, so "an open solid wall" can't be
represented. A door toggles on a click with no tool armed. That's a play-time action, and the one
place where a click's meaning depends on what's under it: a token takes priority, a click that
moved was a pan, and an armed tool gets the click first.

**Walls go to the DM or nobody.** There's no `WallView`; a player's snapshot has an empty list
and `WallsChanged` produces no message for them. Loading a map into the live slot sweeps the
walls, and a recalibration must not. `sweep_board` (shared with the shapes) moves them onto the
shelf rather than deleting them. The staged map has its own walls and overrides, and a promote
moves both onto the board.

→ `docs/walls.md` before touching `walls.ts`, `walltool.ts`, `sweep_board`, or
`Wall`/`WallKind`/`Px` on the server.

## Fog of war

Three party-shared sets of cells: `revealed` (ever seen), `known` (`revealed` widened one cell
by `with_fringe`, so traced walls show on screen) and `visible` (seen now). **Terrain is gated on
`known`, creatures on `visible`.** Vision comes from tokens a player owns. `with_fringe` never
touches `visible` or `revealed`: widening `visible` would show the ogre behind the wall, and
writing to `revealed` would save a cell no ray reached.

Two modes answer the same question. `Dynamic` raycasts to cell centres. It isn't shadowcasting
because a wall is an arbitrary segment, and rasterising it blocks sight on both sides. `Room`
flood-fills, unioned with the raycast, bounded by every traced segment, open or shut.
`fog::sight_cells` is the only reader of `lighting`. Radius is Euclidean. A token can carry a
light (`light_ft`), which counts only if the party has line of sight to it, at any distance.
Without that check, a promote would show the table every lit room.

`fog`, `vision_ft` and `lighting` live on `MapInfo`, remembered per URL and sent with `SetMap`;
there is no `SetFog`. `FogView` is one string, identical for every recipient including the DM:
the wall geometry is the secret, and the shadow is what the table plays with. **Recompute on the
drop, never on a drag frame**; `moves_sight` is the counterpart of `persists`. `forget_fog` runs
on load, promote, recalibration and play-area change; `ResetFog` does the same and also clears
the overrides.

The DM's override is a mask applied after the raycast, and nothing but a ray writes `revealed`.
`Lit`/`Explored`/`Dark` shape `known` and `visible`, so nothing downstream needs to know about
them. DM-only and unsent, like the walls. `SetFogOverride` carries the cells because the client
previews the fill. The staged map has a mask but no fog: there's no staged `revealed`, and a
staged fog preview would be client-only. **Don't put it in the room.**

`solo.ts` and `mirror.ts` are client-only and must stay that way. They run a second raycast on
the DM's client over data it already has. Solo shows one creature's sight. Mirror (*player
view*) shows the table's board via `asTable`, the client-side counterpart of `snapshot_for`; it
isn't a security boundary. `SOLO_SIGHT` has been off since milestone 34. Per-player fog is
`ROADMAP.md` milestone 29; read it before arguing from "party-shared".

→ `docs/fog.md` before touching `fog.rs`, `fog.ts`, `solo.ts`, `mirror.ts`, `overrides.ts`,
`fogtool.ts`, `unseen_by_table`, `with_fringe`, `shape_seen`, `refresh_fog`,
`sight_cells`/`lit_cells`, `Source`/`in_line_of_sight`, `party_sources`/`sight_sources`, or
`moves_sight`.

## Frontend

Camera is `{ x, y, zoom }`. `screenToWorld` and `worldToScreen` are the only places coordinate
math lives. Set the canvas transform once and draw everything in world coordinates; hit-test in
world coordinates too. Everything downstream relies on those two functions.

The left rail shows one DM editing panel at a time, behind a tab strip. A new panel is an entry
in `RailTab` and in the array `main.ts` passes to `createRail`, never another `<aside>`. A
control goes on the panel where its field lives: `MapInfo` → map tab, `Token` → token tab,
room-wide `RoomState` → table tab. Three rules: closing a tab calls the panel's `stop`; a panel
that goes inert makes its **tab** inert too (a tab wrongly greyed out is as much a bug as one
wrongly active); and **only a click on a tab changes the tab**, never anything on the board or
the wire. The open tab is kept in `localStorage`. The draw tool is pinned below the strip rather
than on it, because everyone has it and it's used mid-fight.

`#corner`, bottom right, holds the gesture hint, fit (`Stage.fit`, for everyone, `Home`) and the
`/spells/` link. None of them arms a tool or shows a count. The hint is also the per-person
mouse/trackpad switch (`gestures.ts`, `localStorage`); off by default, so a mouse wheel zooms. The right-hand column is: presence
strip (pinned at the top, the edge that never moves), initiative panel, then the dock. The dock
is a second tab strip, for everyone, in `dock.ts` rather than a generalised rail: nothing in it
arms the canvas, its tabs show unread counts, and its panels stack. It grows upward, with the
strip last.

→ `docs/frontend.md` before touching `coords.ts`, `rail.ts`, `dock.ts`, `Stage.fit`/`fitToRect`,
`#corner`, `gestures.ts`, the wheel handler in `input.ts`, or the order of the right-hand column.

## Maps

Two slots: `map`, and `staged: Option<StagedBoard>` with its own walls and overrides. One slot,
not a list. `None` means both "nothing staged" and "not the DM". **A `SetMap`'s URL alone decides
load versus recalibrate.** The calibration table, staged plans, shapes and walls all branch on
it, and a recalibration sweeps none of them (it does clear overrides, since those are cells).

Libraries: the DM picks from `maps/`, and a pick is a copy into uploads, not a second way to
serve files. `portraits/`, `backdrops/` and `tracks/` use the same `Library` over other folders.
Uploading adds a file; removing deletes the library file and nothing else; a taken name is
refused, not overwritten. A client-supplied path reaches the filesystem in two guarded places: a
pick is canonicalised inside the library, and an add must be a single path component.

A backdrop is shown instead of the board and is not a map. `SetBackdrop` sweeps nothing, the
board is untouched underneath, and preview takes priority over it. A map remembers what the DM
prepared (`Prepared`: grid, walls, paint, keyed by URL, never sent). What gets filed is what the
board held when it stopped being the live board. The DM's preparation is remembered and the
party's play state is not; remembering `revealed` or plans would be the scene system.

**Preview is client-only; the server must not learn about it.** Intent travels in each command's
`staged` flag. Everything that draws or hit-tests reads `shownBoard`/`shownWalls`/
`shownOverrides`/`shownBackdrop`, never the live board.

Cells are squares or isometric diamonds (`GridShape`). An iso grid is an affine transform of a
square one, so everything in grid space is unchanged; `fog::basis` and `gridBasis` are the only
two readers and must agree. `iso-fixed` is a client-side gesture, not room state. It's flat and
must stay flat: no depth sorting, wall height, sprite anchoring or elevation.

→ `docs/maps.md` before touching `maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`,
`drawBackdrop`, `shownBackdrop`, `fog::basis`, `gridBasis`/`shapeOf`, `gridFromEdge`, or
`SetMap`/`MapInfo`/`GridShape`/`SetBackdrop` on the server.

## Undo

One ring, ten deep, no redo, DM only. Each snapshot is a `Saved`, so `clients`, `pending`,
`chat`, `here` and `audio` are left out because `Saved` doesn't have them, and `adopt` is the
only inverse of `to_saved`. Each entry is the state after a change, so the back of the ring is
the present. A step is a command that `undid` names and `persists` agrees with; `Undo` itself is
never a step. Restoring re-sends the world (`Restored`), and the button names what it would undo.

→ `docs/undo.md` before touching `RoomState::undo`, `remember`, `adopt`, `undid`,
`Event::Restored`, `undo.ts`, or `adoptView` in `scene.ts`.

## Whisper and shout

Two destinations and never a third (`ChatTo`); the non-goal is the specification. One command,
`Say`, with no sender field. **`party_to` is the entire visibility rule and never checks
`is_dm`**; both paths out (`chat_for` and the `Said` arm) go through it. Session memory, never on
`Saved`: a refresh keeps the log (rolls included), whispers are never written to disk, and undo
can't take back messages. The sender is echoed. The chosen destination is sticky and shown in two
places; an incoming line badges a tab and shows a toast, without opening anything.

→ `docs/chat.md` before touching `chat.ts`, `dock.ts`, `party_to`, `chat_for`,
`RoomState::chat`, or `Say`/`Said`/`ChatTo`/`ChatLine` on the server.

## The loaner die

A roll is a chat line. `Roll { sides, count, to }` produces a `ChatLine` and emits the existing
`Said`, with no new `ServerMsg`, `Event`, filter or `persists` arm. The server throws the dice,
so `rolled` marks a number the player couldn't have faked. Entropy comes from `uuid` v4 with
rejection sampling; there's no `rand`. `Say` and `Roll` differ in one arm of `may_address`: the
DM may roll to themselves. `DICE_SIDES` is a closed set, and `MAX_DICE` keeps the result within
`MAX_CHAT_LEN` (`the_largest_roll_fits_a_chat_line`).

→ `docs/dice.md` before touching `Roll`/`ChatLine::rolled`, `roll`, `rolled_text`,
`may_address`, `RoomState::log`, `DICE_SIDES`/`MAX_DICE`, or the die row in `chat.ts`.

## The room's music

Modelled on `SetBackdrop`, with one difference: not persisted. `audio` is off `Saved` because
`audio.src = url` isn't idempotent (on the undo ring, an unrelated undo would restart the
track), and a room reopened days later should come back silent. The client keeps volume and
on/off in `localStorage`. Sound starts off because browsers block unprompted playback and every
reconnect needs a new user gesture, so `sound.ts` highlights the button when playback is
refused. `update` returns early on an unchanged URL. Off means paused. The room stores a URL,
not a playback position.

→ `docs/sound.md` before touching `RoomState::audio`, `SetAudio`/`AudioChanged`,
`Library::Tracks`, `library::Formats`/`sniff`, `sound.ts`, or the `sound` tab in `dock.ts`.

## The scratchpad

One per person, private, the DM's no different. **It's the first state Slate doesn't send to the
DM**: neither filter checks `is_dm`, because a box the DM could read would be surveillance.
Don't describe it as privacy from the DM, though: the notes are in the save file the DM hosts.
The guarantee is that no client is ever sent someone else's. `SetNotes` carries no key. The
client sends after a 500ms pause and on blur, with no saved indicator. Persisted, and excluded
from undo by two lines that are both needed.

→ `docs/notes.md` before touching `notes.ts`, `RoomState::notes`, `notes_for`, `is_owner`, the
`Undo` arm of `apply`, or `SetNotes`/`NotesChanged` on the server.

## Presence, turns, colours and cursors

Who's connected: `Presence` carries `Owner`s, not sockets, so a laptop and a phone show as one
person and the DM's presence can be represented. Not on `Saved`; sent wherever the socket table
changes. Absent people are dimmed. **"It's your turn" is client-only and must not fire on a
`Welcome` or a `Restored`**, which is why `turn.ts` has both `update` and `adopt`. A dropped
socket backs off and reloads the page. The DM comes back as the DM via `takeDmSecret` in
`localStorage`. Reloading is intentional, because `onWelcome` builds the UI once per socket.

Players pick their colour: an index into the closed `PLAYER_HUES`, public, duplicates allowed,
refused for the DM at three layers. Everyone's pointer is drawn: `MoveCursor` at ~30Hz, relayed
as `CursorMoved`, not persisted. A client that stops moving sends nothing, and each recipient
removes the cursor on its own timer. No edge marker. `cursor_seen` withholds only the DM's
pointer over cells outside `known`. `SetShowCursors` stops both the relaying and the sending
(cursor moves are the busiest message in the protocol). It's checked in the filter, not
`check`, so a `MoveCursor` that arrives while it's off is dropped rather than refused: an error
banner on every `pointermove` is worse than a dropped frame. `SetShowDmCursor` hides only the
DM's pointer, checked in `cursor_seen` before the `map.fog` guard.

→ `docs/presence.md` before touching `presence.ts`, `turn.ts`, `cursors.ts`, the reconnect
half of `net.ts`, `RoomState::colours`/`here`/`show_cursors`/`show_dm_cursor`, `cursor_seen`,
`PLAYER_HUES`, or `SetColour`/`Presence`/`ColoursChanged`/`MoveCursor`/`CursorMoved`/
`SetShowCursors`/`SetShowDmCursor` on the server.

## Testing

Three suites; which one a change belongs in depends on what can observe it. `node
tools/check.mjs` runs the first two plus `cargo fmt --check` and `clippy`, and reports every
failure rather than stopping at the first. There is no CI: nothing runs unless someone runs it.

`cd server && cargo test`: the room's tests, and most of the suite. They're child modules of
`room`, in `server/src/room/tests/`, split by subsystem like `docs/`. A feature's tests go in the
file for its subsystem, never back in `room.rs`. They're child modules rather than integration
tests because they use `RoomState`'s private API, which is the only way to assert **what a
client was not sent**. `server/src/room/tests.rs` holds shared helpers.

`cd client && npm test`: the client's pure logic, `src/*.test.ts` run by `test.mjs`: coordinate
spaces, distance rules, the trail, `crossesWall`, coverage, the flood fill. It bundles with
esbuild first because the client imports `./coords.js`. Nothing needing a canvas or socket goes
here. `npm run check` runs this plus typecheck and build.

`tools/drive-*.mjs`: headless Chrome against a running server, and the only thing that can see a
canvas, a layout bug, or a **difference between two connections**. They change the room, so
always point `SLATE_STATE` at a scratch file. `cdp.mjs` is the protocol client; `board.mjs` knows
where the grid falls on screen. Anything that clicks the board goes through it, because a driver
can't assume which map it was written against. The README lists them.

## Working agreement

- When a requirement is ambiguous, ask before implementing. A wrong guess costs more than a question.
- State uncertainty plainly. Don't present a guess about a crate's API or behaviour as fact;
  check it or say you're unsure.
- Read `ROADMAP.md` before starting a milestone. When one lands, mark it done there and move its
  entry to `docs/history.md`. Nothing loads either file for you.
- **Read the `docs/` file for a subsystem before changing how that subsystem works**, and update
  it when the behaviour changes. The summaries above are enough to use a feature, not to
  redesign one. The reasoning that would stop you deleting something important is in those
  files, and nothing loads them for you either.
- A new feature gets a short summary and a pointer here; the rest goes in `docs/`. The summary
  says what the feature is, which rules bind it, and what a change must not break. If the
  summary would let you redesign the feature, it's too long. The same goes for a new field's
  comment in the state model.
- Stay within the milestone currently being worked on. Don't scaffold future milestones or add
  abstraction for features that aren't being built yet. The invariants here and the design in
  `ROADMAP.md` are the only forward-looking work allowed.
- **A change to a permission, a visibility filter, or a `was_unseen` isn't finished until a test
  asserts what a client was _not_ sent.** That assertion belongs in the server suite;
  `drive-player.mjs` asks the same question of a real browser.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Don't add dependencies without flagging it and giving the reason.

## Writing docs

This file, `ROADMAP.md` and `docs/` are read mostly by future sessions. The READMEs are read by
people, and the top-level `README.md` is public. Write all of them plainly.

- State the rule, then give the reason in a sentence or two. Don't build up to it.
- Don't frame a point as "not X, it's Y" unless a reader would actually assume X.
- Bold only what causes a bug if missed, and no more than one or two per section.
- No metaphors or personification ("the scene manager wearing a different noun", "a mixer
  arriving one field at a time"). Say what the code does.
- Avoid: *load-bearing*, *seam*, *pointedly*, *honest*, *quietly*, *earns its place*, *the whole
  point*, *by construction* (name the construction), *deliberately* (the reason already says it).
- Use em dashes sparingly. A period or parentheses usually works.
- A fact lives in one place. This file summarises and points; `docs/` explains. A field comment
  names the rule and the file, and doesn't restate it.
- Keep what stops a mistake: why something is shaped the way it is, what breaks if it changes,
  and alternatives that were rejected when a future session is likely to propose them again. Cut
  history that no longer affects a decision, and arguments against objections nobody would raise.

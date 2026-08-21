# Slate

A minimal virtual tabletop for a private, remote D&D game. Six players plus a DM.
It replaces Foundry for one specific group that only needs a shared map, tokens, and turn order.

This file is the contract: what Slate is, what it must never become, and the rules that hold
across every feature. It is loaded into every session. Two kinds of thing live outside it,
deliberately, and neither is loaded for you:

- **`ROADMAP.md`** — design for what is not built yet, and the milestone order. Read it when
  starting a milestone.
- **`docs/maps.md`, `docs/tokens.md`, `docs/drawings.md`, `docs/walls.md`, `docs/fog.md`,
  `docs/undo.md`, `docs/chat.md`, `docs/notes.md`, `docs/presence.md`, `docs/frontend.md`,
  `docs/net.md`** — why each built feature is the shape it is. Every section below that summarises a
  feature ends with a pointer to its file and the code that file covers.

(All referenced in backticks on purpose: a bare `@` path here would be an import, and importing
them would load them into every session, which is what moving them out avoided.)

## What it does

- Displays a background map image with pan and zoom
- Shows tokens on that map; the DM moves any token, players move only their own
- Tracks initiative order and the current turn
- Lets the DM prepare the next map out of sight of the table, then promote it
- Lets anyone measure a distance or draw a spell area on the board, or point at a spot on it so
  everyone else sees where
- Lets the DM trace the walls and doors of a map, and limits what the table can see to what their
  own tokens have line of sight on — or, on a map set that way, to the whole room each token is
  standing in — and lets the DM overrule either by hand, square by square or a room at a time
- Lets the DM take back the last handful of things that changed the room
- Lets anyone say something to the table, or whisper the DM — and the DM whisper any one player;
  two destinations and nothing else, kept for the evening and never written down
- Gives everyone a box to write in that no other screen is ever sent, the DM's included
- Shows who is connected, tells you when it is your turn, picks the page back up when a
  socket drops, lets a player choose the colour they are drawn in, and draws everybody's
  pointer on everybody's board

## Non-goals

These are out of scope. Do not add them, do not scaffold for them, do not suggest them
unless explicitly asked:

- Character sheets, stat blocks, or any 5e rules knowledge. A hit point total the DM keeps on
  a monster is not a stat block and is in scope; anything that knows what a hit point *means* is not.
- Dice rolling (the group uses physical dice)
- Voice and video (the group uses Discord). **Text is a bounded exception and the boundary is the
  whole of it** — a player may whisper the DM or shout to the table, and that is the entire feature.
  No player-to-player messages, no channels, no threads, no history between sessions, no formatting,
  no emotes, no commands, no dice. Two destinations, so a player's box needs no recipient picker;
  the noun is "whisper and shout" rather than "chat" because chat is a thing that grows. **Built**,
  as milestone 23; its motivating case is six people posting initiative rolls without clogging
  voice, and the boundary above is the specification — see *Whisper and shout* below and
  `docs/chat.md`.
- Compendiums, handouts, audio, and journals — **with one bounded exception**: a scratchpad.
  One box of text per person, private to whoever wrote it, and the DM's is no different from anyone
  else's. **A second document makes it a journal.** No titles, no pages, no sharing, no handout
  button. **Built**, as milestone 24, and the boundary above is the specification — see *The
  scratchpad* below and `docs/notes.md`.
- Module or plugin systems
- 5e reference lookup. The spell index at `/spells/` is **not an exception to this** — it is a
  static page under `client/spells/` that imports nothing from `client/src/`, has no entry in
  esbuild's build and touches no room state; it shares the `ServeDir` fallback and one anchor in
  the client's bottom-right corner, and that is the whole of the coupling. **The anchor is the
  boundary rather than a first step**: a link out costs no import, no build entry and no room
  state, and anything that reads spell data *into* Slate — an in-window panel, a search box on the
  board, a spell that places its own area — is the lookup this refuses. Do not connect it to
  Slate. See `client/spells/README.md`.
- User accounts, email, password reset, OAuth
- Mobile-first design (desktop browser is the target; don't break touch, don't optimize for it)

Scope creep is the primary risk to this project. When a request could be satisfied by a
smaller change, propose the smaller change.

## Stack

Backend: Rust — `axum`, `tokio` (full features), `tower-http` (fs, cors), `serde` + `serde_json`,
`uuid`, `futures-util`, `tracing` + `tracing-subscriber`.

Frontend: vanilla TypeScript, canvas 2D. No framework. No Pixi, no Three, no bundler heavier
than esbuild. If a dependency is proposed, justify it against "could this be 40 lines instead".

Persistence: `serde_json` snapshot to a file on disk, debounced. No database.

Deployment target: **self-hosted on hardware in the room**, behind a Cloudflare Tunnel — a
Raspberry Pi 3B on the home network, which receives a cross-compiled binary from a Windows
machine and runs it under `systemd`. There is no cloud and no recurring cost, and that is a
constraint rather than a stage: a VPS was the better answer for uptime and was declined on it.

It is **always on**, so the DM can prepare the next dungeon on a Tuesday without anyone else
being involved. That is what the staged map and the wall editor are for, and it is why the box
stopped being a PC somebody starts before a session. Scale expectations are unchanged — seven
clients on a 1GB board — so this buys availability and not headroom.

The procedure lives in `deploy/pi/README.md`, which also covers backups of `/var/lib/slate`;
`deploy/windows/` still hosts a session from a PC and is kept for a game away from home.

## Architecture

### Room actor

Each room is a single `tokio` task that exclusively owns its `RoomState`. There are no
locks on room state and there is no `Arc<Mutex<RoomState>>` anywhere. Clients send commands
into the room over an `mpsc` channel; the room sends messages back to each client over that
client's own `mpsc` sender.

**There is one room and it is hardcoded**, so its `RoomHandle` lives directly on `AppState` and
there is no registry and no `RoomId`. A second room would add a `RwLock<HashMap<RoomId, RoomHandle>>`
touched on connect and disconnect only — never on a token move — which is the shape everything above
is built to allow and none of it is waiting for. Do not build it before there is a second room.

Per WebSocket connection, split the socket and spawn two tasks:
- recv task: reads the WS stream, deserializes, pushes `(ClientId, ClientMsg)` into the room's `mpsc::Sender`
- send task: reads that client's `mpsc::Receiver`, serializes, writes to the WS sink

### Do not use `tokio::sync::broadcast`

This is deliberate and non-obvious. `broadcast` delivers one identical value to every
subscriber, which makes per-recipient filtering impossible. Fog of war (see `docs/fog.md`) requires
that different clients receive different messages for the same underlying event. Per-client
`mpsc` senders cost nothing at six clients and keep that door open.

**The chat log is what finally walked through it.** `RoomView::chat` is genuinely different *text*
per recipient rather than the room's one copy with rows dropped — two players hold two different
conversations. See `docs/chat.md`.

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

```rust
struct RoomState {
    dm_secret: String,
    roster: Vec<RosterEntry>,
    map: MapInfo,
    /// The map the DM is preparing, with its walls and fog overrides. One bundle,
    /// so one `None` withholds all three. DM-only, and `#[serde(flatten)]`ed on
    /// disk so an older save still loads — see `docs/maps.md`.
    staged: Option<StagedBoard>,
    tokens: HashMap<TokenId, Token>,
    /// Whether the board writes each token's name under it. Room-wide, the DM's
    /// to set and everyone's to hold — see `docs/tokens.md`. Defaults on.
    show_names: bool,
    /// How the movement ruler charges a diagonal. Room-wide, the DM's to set. The
    /// server stores and relays it and never computes with it — see
    /// `docs/drawings.md`.
    diagonals: Diagonals,
    initiative: Initiative,
    /// Drawn on the board, in draw order — see `docs/drawings.md`.
    shapes: Vec<Shape>,
    /// Traced over the live map image. DM-only, whole — see `docs/walls.md`.
    walls: Vec<Wall>,
    /// Everywhere the party's rays have reached, that widened a cell and as the
    /// DM's mask leaves it, and where they can see now. Grid cells, party-shared
    /// rather than per-player. Only `revealed` is persisted and only
    /// `recompute_sight` reads it — everything else reads `known` — see
    /// `docs/fog.md`.
    revealed: HashSet<Cell>, known: HashSet<Cell>, visible: HashSet<Cell>,
    /// What the DM said about particular cells of the live board anyway. A mask
    /// applied after the raycast, never a write into the two above. DM-only,
    /// whole, like the walls — and staged like them.
    overrides: HashMap<Cell, Override>,
    /// How each map URL was last calibrated. Server-side only — it never enters a
    /// snapshot or a message, because the finished `MapInfo` already says
    /// everything a client needs — see `docs/maps.md`.
    calibrations: HashMap<String, Calibration>,
    /// The last ten states of the room, for the DM's undo. Post-state, so the
    /// back of it is the present and an undo pops it — see `docs/undo.md`.
    /// A snapshot is `Saved`, which is what keeps the two client tables below
    /// out of it by construction. Memory only; never on disk.
    undo: VecDeque<Snapshot>,
    /// What has been said this session, oldest first, capped and trimmed from the
    /// front. Memory only and pointedly not on `Saved` — see `docs/chat.md`.
    chat: VecDeque<ChatLine>,
    /// One box of text per person, private to whoever wrote it — and **not sent
    /// even to the DM**; there is no `is_dm` in either filter. On disk, unlike
    /// `chat`, and exempt from the undo ring by hand — see `docs/notes.md`.
    notes: HashMap<Owner, String>,
    /// Which colour each player picked. **Public**, unlike the notes, because
    /// everyone draws everyone else's rings — and exempt from the undo ring by
    /// hand. A `BTreeMap` because `PlayerId` is a legal JSON key and `Owner` is
    /// not — see `docs/presence.md`.
    colours: BTreeMap<PlayerId, u8>,
    /// Whether everybody's pointer is drawn on everybody's board. Room-wide, the
    /// DM's to set — and the one such setting read *in the filter*: off, no cursor
    /// frame leaves the room. Defaults on; see `docs/presence.md`.
    show_cursors: bool,
    /// Identified clients, who are the only ones any event reaches, and the
    /// sockets that are connected but have not said who they are yet.
    clients: HashMap<ClientId, Client>,
    pending: HashMap<ClientId, mpsc::Sender<ServerMsg>>,
}

/// One thing somebody said. `to` is carried as well as `by` because a whisper has
/// to look like one on the screens of *both* people party to it.
struct ChatLine { by: Owner, to: ChatTo, text: String }

/// Two destinations and never a third: a player names the table or the DM, the DM
/// names the table or one player. `Owner`'s neighbour rather than `Owner` itself,
/// because `Table` is everybody — see `docs/chat.md`.
enum ChatTo { Table, Dm, Player(PlayerId) }

/// One entry in the undo ring: a whole room, and what was done to arrive at it.
struct Snapshot { did: String, state: Saved }

/// `Auto` is the absence of an entry rather than a fourth variant. `Explored`
/// and `Lit` are floors, `Dark` is a ceiling — see `docs/fog.md`.
enum Override { Explored, Lit, Dark }

/// What a diagonal step costs the ruler. `Equal` is the default — see *Distance*
/// in `docs/drawings.md`.
enum Diagonals { Equal, Alternating }

/// Which question a fogged map asks: does a straight line reach the cell, or
/// does a walk. `Dynamic` is the default — see `docs/fog.md`.
enum Lighting { Dynamic, Room }

/// A cell of the grid. A tuple, not a struct: it indexes a lattice rather than
/// naming a position, and it never reaches the wire as itself — `FogView` packs
/// a whole rectangle of them into one string.
type Cell = (i32, i32);

struct Shape {
    id: ShapeId, kind: ShapeKind, from: Origin, to: Pos, by: Owner, color: String,
}

enum ShapeKind { Line, Circle, Cone, Rect }
enum Origin { Point(Pos), Token(TokenId) }

/// In image pixels, not cells — invariant 1's exception.
struct Wall { id: WallId, from: Px, to: Px, kind: WallKind }
enum WallKind { Solid, Door(bool) }

struct MapInfo {
    url: String, grid_px: f32, offset_x: f32, offset_y: f32,
    grid_color: String, play_area: Option<Rect>,
    /// Whether this map is fogged, how far a token sees on it, and how that
    /// reach is worked out. Per map and remembered per URL with the rest — see
    /// `docs/fog.md`. `fog` defaults off and `lighting` defaults to `Dynamic`.
    fog: bool, vision_ft: f32, lighting: Lighting,
}

struct Token {
    id: TokenId, name: String, x: f32, y: f32, owner: Owner, img: String, size: f32,
    /// DM-only, both of them — see *Hidden tokens and hit points* in `docs/tokens.md`.
    hidden: bool, hp: Option<Hp>,
    /// DM-only, both of them — see *Preparing the next room* in `docs/tokens.md`.
    staged_pos: Option<Pos>, staged_only: bool,
}

struct Hp { current: i32, max: i32 }
/// Grid units. `Px` is the same pair in image pixels, and a separate type so the
/// two spaces cannot be swapped by accident.
struct Pos { x: f32, y: f32 }

enum Owner { Dm, Player(PlayerId) }
```

### Invariants

These are load-bearing. Violating them creates work that is expensive to undo later.

1. **Token positions are stored in grid units, never pixels.** Recalibrating a map's grid
   size must not move any token. Pixel conversion happens only at render time on the client.
   This is about tokens. Geometry that traces the map image — `play_area` and `Wall` — is stored
   in image pixels instead, because it is anchored to the art rather than to a cell. That is the
   `Pos` / `Px` split, and the types are separate so the two cannot be swapped silently.

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

**Drawing is the first exception.** Anyone may add a shape; erasing one
is `can_erase` — the DM, or whoever drew it. Everything else below is DM-only.

Walls are the opposite extreme: every wall command is DM-only *and* there is no per-item rule
underneath, because they are all the DM's. A player is not merely stopped from editing them — they
are never sent one, and never told one changed. **The fog override is the second thing with exactly
that rule**, and for the same reason: it is what the DM authored, and the fog is the shadow it casts.

**Undo is DM-only and is the one command that can take back somebody else's work** — a player's
drawing is on the ring like everything else persisted, because a restore restores the room whole and
skipping their shape would take it *and* the DM's last command together. The rule that decides what
may go on the ring is **state the undoing hand wrote**; the scratchpads are the case it was written
for and a player's colour is the second — for each, `undid` says `None` and the `Undo` arm puts it
back around `adopt`, and both halves are needed. **Two instances is what makes it a rule**: anything
persisted that a player writes wants the same two lines. See `docs/undo.md`. The chat log tested the same rule
first and passes without being named anywhere: a snapshot is a `Saved`, and the log is not on one.

**Saying something is also everyone's, and it is a permission about a *destination* rather than
about a role.** Anyone may say something; what a player may not do is name another player.
`party_to` decides who sees a line, and it draws that line between two players rather than between
the DM and the table — it never asks `is_dm`. See `docs/chat.md`.

**Writing in a scratchpad has no permission at all.** `SetNotes` names no box — the only one it
can reach is the sender's, because whose it is comes from the socket — so there is nothing to check
but a length. The asymmetry is on the way *out*: `notes_for` gives the **DM** less than the room
holds, and `is_owner` is the question both it and `party_to` ask. See `docs/notes.md`.

**Picking a colour names no key either.** `SetColour` reaches only the sender's own entry because
whose it is comes from the socket — `Say`'s rule and `SetNotes`' rule again, and the rule the three
share is that *a key a client could name is a key it could name somebody else's with*. What it
validates is a bound, like a token's size, because the palette is closed. **The DM is refused it
outright** — their hue is the one ring at the table that is not a player's. See `docs/presence.md`.

Token creation, deletion, map changes, initiative edits, and whether the board writes token names
under them — or draws everybody's pointer — are DM-only. That last one is the one whose *result* everybody is sent — see the wire
protocol below. So is reassigning a token's `owner`, which is how a player is handed a token the DM
built for them. So is planning
where a token lands — a player may move their own token and may not plan for it, because the
plan is a cell on a map they have not been shown.

The DM uploads all token art, and picks it out of `portraits/`. Both endpoints authenticate with
the DM secret, and a player has no credential to offer either — giving them one would be the
authentication this project does not build.

Identity: the DM joins with a secret in the URL. Players join with a plain room link and
claim a name from a roster the DM defined. `player_id` persists in `localStorage` so a
refresh does not orphan a token. **A roster slot's id is a slug, not its name** — the id is what
`localStorage` and a token's `owner` are written as, so renaming a character touches the name
alone and every token they own still points at them. This is a private game among friends — do not
build real authentication.

## Wire protocol

JSON over WebSocket, serde tagged enums:

```rust
#[serde(tag = "type", rename_all = "snake_case")]
```

Do not switch to a binary format. Human-readable frames in devtools are worth more than the
bandwidth during drag-sync debugging.

On join, the server sends `ServerMsg::Welcome { your_id, is_dm, player_id, state, roster }`
containing a full filtered snapshot. Everything after that is a delta. Reconnection is just
another join — there is no diffing or resync protocol.

**The send task pings an idle socket every 30 seconds**, because nothing crosses a quiet board and
a proxy that sees no traffic for long enough closes the connection. It is not a message: a browser
answers at the protocol level, so the wire format is unchanged and the client knows nothing about it. **A keepalive is not a reconnect** — when the socket does close,
the page still says so and waits for a refresh.

`state` is a `RoomView`, which is the room as that one client may see it — for a player that
means `staged` is stripped from it *whole*, taking the next dungeon's walls and paint with the
image; the live board's walls and fog overrides are empty; tokens they cannot see are absent; and
what survives is redacted. See `docs/maps.md` and `docs/tokens.md`. `state` is boxed, because growing
`RoomView` by one field pushed `Welcome` past clippy's large-variant threshold — every message in
every client's 256-slot mailbox is sized at the largest variant. Serde sees straight through the box
and the frame on the wire is unchanged.

`fog` is the exception to all of that: it is the same value for every recipient. There is nothing
per-client in a party-shared answer to build. **`show_names` and `diagonals` are unfiltered for a
different reason** — the DM alone may flip them and everyone is told, because who may set a
room-wide setting is a permission and what it says is not a secret. `NamesChanged` sits beside
`FogChanged` for that reason and not beside `WallsChanged`, which is the frame it most resembles on
paper. `diagonals` is the sharpest case: the server never counts a diagonal, so the only thing it is
authoritative over is that everybody counts them the same way.

**`Token` never reaches the wire; `TokenView` does.** `Token::view_for(is_dm)` names every field
that leaves the room, so `RoomView.tokens` and `ServerMsg::TokenChanged` both carry views. This
is the third layer of the same idea as `Event` vs `ServerMsg` and `RoomState` vs `RoomView`, and
it exists to make the failure fail the safe way round: a secret added to `Token` and forgotten
here is *absent from the wire*, which shows up as the DM's own client missing a field, rather
than shipped to everyone, which shows up as nothing at all until somebody opens devtools.

**`here`, `colours` and `show_cursors` are identical for every recipient too**, which puts them
with `fog`, `show_names` and `diagonals` rather than with anything filtered. Neither of the first two
is a secret: a table that cannot tell whether the DM is still connected is what `here` exists to fix,
and a colour nobody else can see is not a colour. `Presence` is also the one frame no command
produced — it is dispatched where the socket table changes. `show_cursors` is the only unfiltered
value a client reads to decide what to *send*.

**`CursorMoved` mirrors `Pinged` and differs in one line.** Same payload, same
`Owner`, same no-echo — and this one is filtered: the DM's pointer is withheld from a player
over ground the party has not explored, because a ping is a gesture somebody chose to make
and a cursor is where a hand happens to be. A player's pointer is relayed wherever it goes
and the DM is sent every one. `cursor_seen` is the whole rule.

**`ServerMsg::Restored` is the second frame that carries a whole `RoomView`, and it goes through the
same `snapshot_for`** — invariant 3 on the one message that would otherwise be a second place to get
it wrong. It is deliberately *not* a second `Welcome`: on the client that handler **builds** the
panels, the tools and the board once per socket, so a restore hands over state and nothing else — no
identity, no roster. `UndoChanged` beside it reaches the DM or nobody — `WallsChanged`'s rule again,
and here what is withheld is a label rather than a secret. See `docs/undo.md`.

**`chat` is the field that finally spent what per-client `mpsc` bought.** Every other list in a
`RoomView` is the room's one copy with rows dropped; this is different text per recipient, because a
whisper only exists in the copies of the two people at either end of it. The delta beside it,
`ServerMsg::Said`, is withheld whole or sent whole — `WallsChanged`'s shape, except that its
audience is a *pair of people* rather than a role — and it is **the one relayed frame the sender is
echoed**, because a log is a sequence and where a line lands in it is the room's to decide, not a
client's. See `docs/chat.md`.

**`notes` is per-recipient content too, and it is narrower for the DM than for the room.**
A client is sent its own box and there is no frame that can carry
another — `ServerMsg::NotesChanged` reaches its author minus the socket that typed it, which is
`Pinged`'s exclusion rather than `Said`'s echo: the text is already in that box, and writing it back
a round trip later moves the caret. What is left is the author's second tab, and that is the whole
audience it has.

`roster` is the cast list, not who is connected. The DM never sees the identity picker, so this
is the only way their token panel learns the names a token can be handed to; a player is sent it
too, having already been offered the same names. Because it describes no connections there is
nothing in it to go stale between deltas — that is `RosterSlot`, and only the picker wants it.

**An inbound frame is capped at `MAX_WS_MESSAGE_BYTES`, and that cap is read-side only** — nothing
bounds a `Welcome` on the way out. So **a command carrying a variable-length collection has two
bounds, not one**: the count the room refuses past, and the bytes the socket will accept. Get them
out of order and the refusal is unreachable — the socket dies on the read and the client reloads,
which is what `SetFogOverride` did at 50,000 cells against a 16 KiB frame. **A test must serialise
the largest legal instance and assert it fits**; driving `check` is not that test, because `check`
never runs. `largest_override_fits_in_a_frame` is the one that exists.

**`ClientMsg` and `ServerMsg` are written out by hand twice and nothing generates either from the
other.** `protocol-tags.json` is the third copy both are checked against — an exhaustive `match` in
Rust, a `Record<Msg['type'], true>` in TypeScript, so each language's own compiler refuses a variant
that is not in the fixture. Variant-level only: a renamed *field* keeps its tag and is caught only by
the server rejecting the frame, which is a `console.error` on the client so that a browser driver
fails on it.

→ **`docs/net.md`** before changing the wire format, the frame cap, or the keepalive in the send task.

## Drag semantics

Token movement uses two message rates:

- During drag: `MoveToken { dragging: true }`, throttled client-side to ~20–30 Hz. The room
  applies it in memory and relays it, but does not snap to grid and does not mark state dirty.
- On drop: `MoveToken { dragging: false }`. This snaps to the grid and marks the room dirty
  for persistence.

The client predicts locally — it moves its own token immediately rather than waiting for the
round trip, and corrects only if the server rejects. The server must not echo drag frames back
to the originating client; doing so causes visible rubber-banding.

`MoveToken` and `ServerMsg::TokenMoved` both carry `staged`, naming which of the token's two
positions the frame is about. Everything either side of that one branch — the throttle, the snap,
the debounce, the echo rule — is unaware there are two. A frame carrying a plan reaches the DM
alone; see *Preparing the next room* in `docs/tokens.md`.

## Tokens

A token is a square `size` cells across, centred on its stored position; `size` is one of
`0.5, 1, 2, 3, 4`, a closed set checked on the server. Where a token settles depends on how wide it
is, and that rule lives in `snap_to_cell` on the server and nowhere else — the client never snaps.

Creating, deleting and editing are DM-only, and the id is the server's to invent. `UpdateToken`
carries every editable field *except* position, which `MoveToken` owns, and carries no `staged`
flag because every field on it is shared by both boards. `TokenChanged` covers creation and editing
alike — an id the client has not seen is the creation. **Deleting a token takes its initiative row
and its anchored drawings with it.**

Four fields are DM-only: `hidden` and `hp` withhold a monster from the table; `staged_pos` and
`staged_only` plan the next encounter without a second token collection.

**`RoomState::unseen_by_table(&Token)` is the only question any filter asks.** Three reasons compose
in it: `Token::unseen()` is `hidden || staged_only`, both facts about the token, and the third is
line of sight, which is a fact about the *room* — so the funnel lives on `RoomState` rather than on
`Token`, which cannot see the walls or where the party is standing. `snapshot_for`, `initiative_for`,
`shape_seen`, both oracle guards in `check`, and every token arm of `message_for` go through it.
Anything that asks `Token::unseen` directly is filtering on two reasons out of three, which is a leak.

**Every `was_unseen` on an event asks the same question**, read before the change it describes — and
for a promote, before the sweep. It is what separates "it just vanished" from "you were never told",
and getting it from `Token::unseen` instead sends the table a `TokenRemoved` naming an id they have
never held, which announces that the id exists.

**Whether the board writes those names under the tokens is one switch on the room**, `SetShowNames`,
DM-only to set and sent to everyone — six familiar party portraits need no labels and a room full of
goblins does. Not on `MapInfo` beside `fog` and not on `UpdateToken`: it belongs to neither the image
nor any one creature, which is also why it, `SetDiagonals` and `SetShowCursors` are the table tab's
controls and not the token panel's. It defaults on, which is the only thing keeping an older save from losing every
label. The hit point bar is not a label and the switch leaves it alone.

Art is optional — a token without it draws as a named disc. The DM uploads it, or picks it out of
`portraits/`, which is `maps/` one folder over: a pick copies into the uploads directory, so `img`
holds the same kind of URL either way and nothing downstream can tell them apart. One
implementation serves both libraries — `Library` on the server, `library.ts` on the client — and
the two rules the second one added are one rule twice: **what a copy's name is derived from decides
what a re-pick resolves to.** It is a **prefixed** key, or the same filename in both folders lands
on one file; and it is fingerprinted by **content**, or art replaced in the folder keeps resolving
to the copy it replaced. **Maps opt out of both** — their calibration table is keyed on the URL
those names produce — so replacing a map's art does nothing, deliberately.

**The initiative panel is the DM's combat screen.** Each row carries the token's portrait and, for
the DM, its hit points — and none of that touched the wire, because `panel.update` is handed the
whole `Scene` and resolves each row's id to the token itself. The bar has *no permission check*: a
player's copy of the token carries no `hp`, so there is nothing to decline to draw, which is
invariant 4 the safe way round. Clicking a row centres the camera on that creature; it is not an
automatic pan on turn change, which would move the board under whoever is mid-drag.

**It folds, and folded is the current row rather than a bare tab.** Whose turn it is is what the
panel is for, so the fold gives back the other eleven rows and keeps that one — rendered by the same
loop, with the turn buttons still beside it. The preference is `localStorage` and pointedly not the
room: `diagonals` is on `RoomState` because six clients must agree on a rule, and how much of a panel
somebody wants on their own screen is nobody else's business.

**Shift-click gathers tokens into a group and dragging any member moves all of them.** The server
does not know this exists: a group move is N ordinary `MoveToken`s, so permission, snapping and
`moves_sight` are each answered once per token by the code that already answered them. Membership
comes from `tokenAt`, which is already blind to tokens you cannot move, so **the permission question
answers itself** and it is not DM-only. Empty is the ordinary case — only shift-click fills a group,
grabbing a token outside one clears it, and a click on empty map or Escape gives it up — so no
ordinary drag gained a second meaning. The group does not feed the token panel, and a group draws **one** ruler on
the dragger's screen and one per token on everyone else's.

→ **`docs/tokens.md`** before touching `tokens.ts`, `panel.ts`, `library.ts`, `snap_to_cell`,
`Token`/`TokenView`, the `selection` set in `input.ts`, or any `message_for` arm.

## Drawings and distance

Line, circle, cone, rectangle — **all four are one struct: a kind and two points**, where `to` is
an *offset* from the origin rather than a second position. One hit test and one coverage rule,
both `containsPoint`. Geometry is in grid units like a token, so recalibrating leaves a 20 ft
circle 20 ft across.

**A sweep snaps at both ends and both rules are the client's** — the origin to the nearest point of
the half-cell lattice (centres, corners, edge midpoints, which are one set), the extent to whole
cells: per axis for a line and a rectangle, by magnitude for a circle and a cone, so the drawn size
is the number on the label. Alt sweeps free and is read on the move, not at pointerdown, where it
already means something else.

**Anyone may draw** — the only thing in the room a player can add, and the only thing they can
destroy; `can_erase` is the DM or whoever drew it. **The measure tool draws in the sweeper's own
colour** and the three area tools take the picked swatch: a line that vanishes on release is a
gesture and the question is whose, while a shape that stays is a thing and `PLAYER_HUES` is not a
vocabulary for spell areas. Nothing on the wire changed — a sketch already carried its colour. A shape being swept out is on the wire and is
not in the room (`ClientMsg::Sketch` carries `drawing`, the way `MoveToken` carries `dragging`).
There are no staged shapes. `shapes_for` withholds a shape whose anchor the recipient cannot see,
through `unseen_by_table` — so an aura on a monster in the dark goes with it, and no new line was
needed for that. An *unanchored* shape is withheld unless a cell it covers has been explored.

A grid cell is five feet, and distance is counted in cells crossed. **What a diagonal step costs is
the DM's switch** — `Equal` charges one cell, `Alternating` charges double for every second
diagonal, counted from the start of each reading rather than across a turn. Both keep every reading
a multiple of five. It moves the ruler and nothing else: a circle's radius and a token's vision are
geometry and stay Euclidean either way. The reading itself is client-only — `feetMoved` has no
server counterpart — and is built from the `TokenMoved` frames the room already decided to send.

**The ruler tints the squares the move crossed**, and they are the squares of the straight line from
origin to token, never the path the mouse took. Under `Equal` that makes the trail a picture of the
number: `max + 1` cells for a reading of `max × 5`, from the same two integers, so they cannot
disagree — and every client rasterises the same line from data it already holds, so nothing was
added to the wire. It lingers a couple of seconds after the drop and the line and reading fade with
it, on one alpha. **A drag through a wall or a shut door draws the DM's amber**; that is a hint and
never a refusal, and it cannot leak because a player holds no walls to test against.

## Ping

Hold the left mouse button with nothing armed and a ring appears where everyone can see it, in the
sender's colour with their name beside it. **It separates from what the button already does by
duration rather than by target** — a ~400ms timer that a few pixels of movement cancels and an early
release cancels, so doors still swing and a click still erases. That is what let it coexist with the
one place a click's meaning depends on what is under it, without joining that argument. A hold on a
token pings; a drag only begins on movement, so a stationary hold on a creature is free.

**Ping ignores the draw tool specifically** — the one exception to "an armed tool takes the button
first". Everybody has that tool, it is used mid-fight, and a player who leaves it armed would lose
the gesture permanently with no hint why. The ring grows from ~150ms, local until it commits.

**No fog gate, and it is the one message with a position that no filter touches.** A ping lands
wherever it was pointed, unexplored ground included, and it is safe because there is nothing in it to
read but a position — a ring over black says somebody is gesturing in a direction, not what is
standing there. It does not light anything up: `Ping` is not in `moves_sight`, so pointing at a room
never explores it. Ephemeral whole — not in `persists`, absent from `snapshot_for`, never dirty, and
`apply`'s one arm with no `&mut self` in it.

`ServerMsg::Pinged` carries an **`Owner`** rather than a `ClientId`, unlike `Sketch`: it replaces no
previous frame and needs no release, so what a recipient wants is whose ring to draw. Colour is
**derived** — `colourOf` indexes a palette by roster position, so six clients agree with nothing on
the wire. The sender is not echoed their own. **A ping off the edge of your view draws an arrow at
the edge of the screen**, never a camera pan.

→ **`docs/drawings.md`** before touching `shapes.ts`, `drawtool.ts`, `ruler.ts`, `pings.ts`,
`snapOrigin`/`snapExtent`, `trailCells`, `crossesWall`, `edgeMarker`, `SetDiagonals`, or
`Shape`/`ShapeKind`/`Sketch`/`Ping` on the server.

## Walls and doors

The DM traces a polyline — click, click, double-click — and the room stores **one `Wall` per gap
between corners**. The run is authoring and is never stored, which is what makes one bad segment of
a long trace erasable without redrawing it. Corners snap to grid corners, Alt places freely, and
that snap is the client's like `snapOrigin` is.

**In image pixels, not cells** — invariant 1's exception, because a wall traces the art. A door is
`WallKind::Door(bool)` rather than a flag beside a wall, so "a solid wall that is open" cannot be
said; doors are traced shut and only the DM swings them.

**A door swings on a click with no tool in hand**, because opening one is a play-time action and not
an edit. It is the one place where what a click means depends on what is under it: a token on top
wins, a click that moved was a pan, and any armed tool takes the button first.

**Walls reach the DM or nobody.** There is no `WallView` and no filtered form: a player's
`snapshot_for` carries an empty list, indistinguishable from an untraced map, and
`Event::WallsChanged` produces *no message at all* for them — a frame they cannot use still says the
DM did something. A load into the live slot sweeps the walls and a recalibration must not; that is
`sweep_board`, shared with the shapes.

**The staged map has walls of its own, and fog overrides beside them.** The next dungeon is traced
before the table is shown it — every wall and override command carries a `staged` flag, like
`SetMap`/`MoveToken`/`CreateToken`, and a promote *moves* the staged pair onto
the board rather than `sweep_board` clearing it. It cost almost nothing because walls already
reached the DM or nobody: there was no filter to widen. A staged door promotes however the DM left
it swung, which is how they say a room is already ajar. Still one slot, still not the scene concept.

→ **`docs/walls.md`** before touching `walls.ts`, `walltool.ts`, `sweep_board`, or
`Wall`/`WallKind`/`Px` on the server.

## Fog of war

Three sets of grid cells, **party-shared rather than per-player**: `revealed` is everywhere the party
has had line of sight, `known` is that widened by a cell, `visible` is where they have sight now.
**Terrain gates on `known`, creatures gate on `visible`** — the room they walked through stays on
their screen, dimmed, and whatever has wandered into it since does not. Vision comes from tokens a
player *owns*, so handing one over grants sight with no extra rule.

**`known` is `revealed` widened by one cell in every direction** — `with_fringe`, so the traced
masonry lands on the table's screen instead of a room reading as a hole. **It never touches `visible`
and never touches `revealed`**: widening the first hands over the ogre standing behind the wall, and
writing into the second bakes a cell no ray reached into the save file. It is a mask like the DM's
paint, and `Dark` still wins because the overrides are applied after it.

**Two modes, one question underneath.** `lighting` on `MapInfo` picks between them and
`fog::sight_cells` is the only place that reads it, so nothing downstream knows there are two.
`Dynamic` is the raycast; **`Room` is a flood unioned with it** — *you see the whole room you are
standing in, plus whatever you have a straight line to* — so it can never show less than `Dynamic`
would. The flood is bounded by **every traced segment, open or shut**, and **only sight reads
`blocks()`**, so what an open door passes is the wedge seen through it rather than the room behind it.

**Raycasting to cell centres, not shadowcasting.** A cell is visible when the straight line from the
viewer's centre to it crosses no solid wall and no shut door. Shadowcasting wants opacity to be a
property of a cell and a wall here is an arbitrary segment in image pixels; rasterising one into
blocking cells would blind both sides of every wall traced along a cell boundary, which is most of
them. The radius is Euclidean — a circle, agreeing with a drawn circle and not with the ruler.

`fog: bool`, `vision_ft` and `lighting` live on `MapInfo`, remembered per URL like the grid and sent
on `SetMap` — there is no `SetFog`. **`fog` defaults off and `lighting` defaults to `Dynamic`**, which
is what keeps an older save from going dark or changing shape. Nothing here knows the word
"darkvision": one radius per map.

`FogView` packs a rectangle of cells one character each. **It is the one message identical for every
recipient**, the DM included, and that is the exact opposite of `WallsChanged` beside it: the geometry
is the secret and the shadow it casts is what the table plays with. `None` means the map is not
fogged, indistinguishable from having none.

**Recompute on the drop, never on a drag frame** — `moves_sight` is `persists`'s twin and is
enumerated the same way. `revealed` is persisted; `known` and `visible` are derived on boot. A map
load, a promote, a recalibration and a redrawn play area clear all three through `forget_fog`;
changing the radius does not. `ResetFog` is that plus the overrides, and is the DM's way to say **the
whole map back to dark**.

**The DM's override is a mask applied after the raycast, and nothing but a ray ever writes into
`revealed`** — a hide that merely cleared it would evaporate at the next torch, and a reveal that
merely wrote into it could never be lifted. `Lit`/`Explored`/`Dark` shape `known` and `visible`, which
is where every reader downstream looks, so `unseen_by_table` stays one line and nothing downstream
knows the word. It reaches the DM or nobody, exactly as the walls do, and the table is owed the
`FogChanged` beside it. `SetFogOverride` carries **the cells**, because the DM's client computes the
fill to preview it and the preview and the result have to be the same array — a fill bounded by every
traced segment, doors included and whatever they are swung to. Swept with the three sets, and
persisted whole.

**The staged map has a mask of its own and pointedly no fog.** A promote carries the paint across with
the walls. Nothing casts a ray on a board nobody has been shown, so there is no staged `revealed` and
`ResetFog` stays live-only. Previewing the staged map's fog is a second raycast and would be
client-only if ever wanted — **do not put it in the room.**

**An unanchored shape gates on `known`**, not on `visible`: a drawing is painted on the floor rather
than standing on it, so it belongs with the terrain — fringe included, which is the one reader
downstream of that widening.

**Fog is party-shared and stays that way; what the DM gets instead is `solo.ts`.** Arming *sight
check* and clicking a creature redraws the DM's own board as that creature's line of sight. It is
**client-only** — a second raycast over the walls, radius and mode their client already holds — so
there is no command, no event and no filter, and it is leak-proof by construction rather than by a
check, exactly as the movement hint is. Live board only, no overrides applied. **Do not put any of it
in the room.**

*Per-player fog is no longer a closed question: `ROADMAP.md` milestone 29 designs a switch that makes
`visible` per-player and leaves `revealed` alone — it exists because `solo.ts` answered the objection
that killed it. Nothing above changes until 29 is built; read it before arguing from this line.*

→ **`docs/fog.md`** before touching `fog.rs`, `fog.ts`, `solo.ts`, `overrides.ts`, `fogtool.ts`,
`unseen_by_table`, `with_fringe`, `shape_seen`, `refresh_fog`, `sight_cells`/`lit_cells`, or
`moves_sight`.

## Frontend

Camera is `{ x, y, zoom }`. Two functions, `screenToWorld` and `worldToScreen`, are the only
places coordinate math lives. Render by setting the canvas transform once
(`ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom)`) and drawing everything in
world coordinates. Hit-testing happens in world coordinates too.

Getting this layer right is the hardest part of the client, and everything downstream trusts
those two functions.

**The left rail shows one of the DM's editing panels at a time, behind a tab strip.** A new panel is
an entry in `RailTab` and an entry in the array `main.ts` passes to `createRail` — never another
`<aside>` stacked on the others. **Which panel a control belongs on is decided by where its field
lives**: `MapInfo` is the map tab, `Token` is the token tab, room-wide `RoomState` is the table tab.
Two rules come with the strip. Closing a tab must put down whatever that panel armed, via the panel's
`stop` — a tool still holding the left mouse button under a hidden panel is a click doing something
with nothing on screen saying why. And a panel that goes inert in some state must make its **tab**
inert too: a way in to a panel that can do nothing is the same lie as the panel sitting there looking
armed, and the rule cuts both ways — a tab wrongly greyed is the same defect as a tab wrongly live.

The draw tool is deliberately *not* on the strip. It is the one panel everybody has and it is used
in the middle of a fight, so it stays pinned to the bottom of the rail — the same reason a door
swings with no tool in hand.

**The right-hand column holds three things and their order is not a layout choice**: the presence
strip is pinned at the top because that is the one edge that never moves, since the initiative panel
folds and the dock grows upward.

**The right edge is a second strip, `dock.ts`, and it is everybody's** — a separate file rather than a
generalised rail because nothing behind it arms the canvas so there is no `stop`, a tab here can carry
an unread count, and **its panels stack**: rail panels are editing *modes* and nothing in the dock is
one. It grows *upward* from the bottom, so opening it never moves the initiative panel, and **its
strip is its last child** rather than its first.

→ **`docs/frontend.md`** before touching `coords.ts`, `rail.ts`, `dock.ts`, or the order of the
right-hand column. `docs/presence.md`, `docs/chat.md` and `docs/notes.md` cover what sits in them.

## Maps

Two slots: `map`, and `staged: Option<StagedBoard>` — the map the DM is preparing while the table is
still looking at the current one, **with its own walls and fog overrides**. One slot, not a list.
`staged` is absent from a player's `snapshot_for` and `Event::StagedChanged` becomes `None` for
everyone but the DM; `None` is both "nothing is staged" and "you are not the DM", indistinguishable
from the client side — and because the three travel as one bundle, that single `None` withholds the
next dungeon's masonry and paint along with its image. There is no second staged field to forget.

**A `SetMap`'s URL alone decides whether it is loading a map or recalibrating one**, against
whichever slot its `staged` flag names. That distinction is load-bearing four times over — the
remembered calibration table, the staged token plans, the board's shapes and each slot's traced
walls all branch on it, and a recalibration must sweep away none of them. The fog overrides are the
exception that proves it: they are cells, so a recalibration *does* clear them, on both boards.

The DM picks maps out of the repository's `maps/` folder rather than re-uploading; **a pick is a
copy into the uploads directory, not a second way to serve files.** Listing and picking are
DM-only. This is the only place a client-supplied path reaches the filesystem — canonicalise it
and confirm it resolves inside the library before opening it. **`portraits/` is the same feature
over token art** and shares every line of it; the folder, the size cap, the noun in the refusals
and what a copy's name is fingerprinted over are the whole of what a library differs by.

**Preview is client-only: the server does not know the DM is previewing and must not learn.**
That is why intent rides on the command — `SetMap`, `MoveToken`, `CreateToken`, all four wall
commands and `SetFogOverride` each carry `staged` — rather than on a mode. Everything that draws or
hit-tests reads `shownBoard(scene)`, or its twins `shownWalls` and `shownOverrides`, never the live
board directly.

→ **`docs/maps.md`** before touching `maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`, or
`SetMap`/`MapInfo` on the server.

## Undo

One ring, ten deep, no redo, the DM's alone. **A snapshot is `Saved`** — the save file kept in memory
rather than written — so `clients` and `pending` stay out by construction and `adopt` is the one
inverse of `to_saved` that both booting and undoing go through. **Post-state**: the back of the ring
is the present, an undo pops it and adopts what is behind, and both constructors seed a floor so the
first command of a session is undoable.

**A step is a command that `undid` names and `persists` agrees with.** Sharing `persists` is what
keeps drag frames out for free; `undid` adds the two exclusions it cannot express, and the
load-bearing one is that **`Undo` itself is never a step**. One step per command, so a long wall
trace fills the ring — `ClearWalls` is the way out of a bad one, and depth is the cheap thing to tune.

Restoring re-sends the world rather than a diff, because the case undo exists for is `sweep_board`.
The button names what it would take, since with no redo an unpredictable press is unrecoverable.

→ **`docs/undo.md`** before touching `RoomState::undo`, `remember`, `adopt`, `undid`,
`Event::Restored`, `undo.ts`, or `adoptView` in `scene.ts`.

## Whisper and shout

**Two destinations and never a third** — that is `ChatTo`, and the missing case, one player to
another, is the boundary the non-goal at the top of this file draws. Read it before changing
anything here; it is the specification, and everything below is how it was built.

**One command, `Say`, because a whisper and a shout differ only in where they are going** — and the
destination is exactly what the permission check is about. It carries no sender: who said it is
what the socket already proved.

**`party_to` is the whole visibility rule and it never asks `is_dm`.** A shout is everybody's; a
whisper is in exactly two copies, the sender's and the recipient's. That "or whoever sent it" half
is what stops the DM's own whisper being absent from the DM's log. Both routes out go through it —
`chat_for` in `snapshot_for` and the `Said` arm of `message_for` — which is invariant 3 on the first
state where getting it wrong hands over somebody's words.

**Session memory, never `Saved`.** One decision buying three things: a refresh mid-combat keeps the
initiative rolls, old whispers are never durable on the disk, and an undo cannot take back what
somebody said — a snapshot is a `Saved`, so the log is not in one and `undo.rs` never mentions it.
Capped and trimmed from the front.

**The sender is echoed their own**, alone among relayed frames, because a log is a sequence and
where a line lands in it is the room's to decide. So nothing here is predicted locally.

The client half: the dock is a strip like the rail's (see *Frontend*), the destination is **sticky**
and shown twice — the armed chip and the input's own colour and placeholder, because forgetting
which way the box points is the one failure a sticky destination has. An arriving line puts a count
on a collapsed tab **and** surfaces beside the dock for a few seconds, and does not open anything.
A line renders identically for both people party to it, so there is no "am I the sender" branch.

→ **`docs/chat.md`** before touching `chat.ts`, `dock.ts`, `party_to`, `chat_for`, `RoomState::chat`,
or `Say`/`Said`/`ChatTo`/`ChatLine` on the server.

## The scratchpad

One box of text per person, private to whoever wrote it, and **the DM's is no different from
anyone else's**. What it is worth over the Notepad window everybody already tabs to is one thing:
it is in the window, and it persists with the room. That is the entire scope, and **a second
document makes it a journal** — read the non-goal at the top of this file before adding anything.

**It is the first state in this project Slate does not send the DM.** Every asymmetry before it
runs the other way, so `snapshot_for` and `message_for` had only ever been asked to withhold
*downward*; there is no `is_dm` in either arm here. A scratchpad the DM's client can open is not a
scratchpad, it is a surveillance feature, and the reason it stays out is the reason it is worth
having.

**Be accurate about how far that goes and do not call it privacy.** The notes are in the save file
and the DM hosts the server. What is guaranteed is that **no client is ever sent somebody else's**,
which is the same guarantee the walls and the hit points get and the only kind this architecture
makes about anything.

**`SetNotes` carries no key**, because a key a client could name is a key it could name somebody
else's with — whose box it is comes from the socket, exactly as `Say`'s sender does. So there is no
permission to check, only a cap. **It sends on a pause, not on a keystroke**: a 500ms idle
debounce, flushed on blur, and no "saved" indicator — that would be the first UI here that narrates
the network, and it would make the box look like a document.

**Persisted, and exempt from the undo by hand.** A snapshot is a `Saved`, so this being on disk put
it on the ring by construction. Two things say otherwise and both are needed: `undid` is `None` for `SetNotes`, and the `Undo` arm
of `apply` takes the notes out and puts them back around `adopt`. The second is the load-bearing
one, because a paragraph typed *between* two commands is on the snapshot the later one pushed.

→ **`docs/notes.md`** before touching `notes.ts`, `RoomState::notes`, `notes_for`, `is_owner`, the
`Undo` arm of `apply`, or `SetNotes`/`NotesChanged` on the server.

## Presence, turns, colours and cursors

**Everything else in Slate is about the board; these five are about the people looking at it.**

**Who is connected** is a row of chips at the top of the right-hand column. The room already
computed it — `roster_slots` already scanned `clients` and told only the identity picker — so
`Presence` routes an existing answer to everyone. It carries **`Owner` and not
`RosterSlot`**, because a list of slots cannot say the DM is there and that is the connection a
table most wants to be sure of; it is **identities and not sockets**, so a laptop and a phone are
one name; and it is **not part of the room** — off `Saved`, so off the undo ring by construction
like the chat log, and `persists` refuses it on that principle rather than on it being fleeting.
Absent people dim rather than disappear, the chat destination chips dim from the same answer, and
`here` is on `RoomView` as well as on the delta because invariant 3 applies to it like everything
else.

**"It is your turn"** is client-only and has no server half at all — `initiative.current`,
the scene and `identity.ts` are already in hand. The rule that would ruin it is that it **must not
fire on a `Welcome` or a `Restored`**: adopting state is not a turn change, which is why `turn.ts`
has `update` and `adopt` rather than one method. It opens and moves nothing. It fires for the DM on
every monster's turn, deliberately unresolved —
**play decides**, and the off-switch is `localStorage` if it ever needs one.

**A dropped socket now backs off and reloads the page** when a fresh one opens. **The reload is
the design**: `onWelcome` builds the panels, the tools and the board once per socket, so a second
`Welcome` would build a second of each — the wall `Restored` was invented to avoid, except that
here a refresh was already the supported way back. The socket the backoff opens is a probe and
nothing is sent on it. Today's banner is now the floor, reached when the backoff gives up.

**A player picks their own colour**, replacing the body of `colourOf`. It is **public**, unlike the
scratchpad, because everyone draws everyone else's rings —
which makes it the first player-writable state here that is not private. It is **an index into a
closed palette**, because free hex would let a player take the gold a token ring uses for ownership
and make the board say something false; `PLAYER_HUES` in `pings.ts` is the only place the hues
exist and the server holds only the bound. **Duplicates are allowed** — the name beside a ring is
what tells two people apart, and colour never scaled to seven anyway. The DM has none, enforced at
three layers: the table is keyed by `PlayerId`, `check` refuses them, and `colourOf` answers `dm`
first.

**Everybody's pointer is drawn on everybody's board**, which is `Ping` with the
deliberateness taken out: `MoveCursor` at ~30Hz, relayed as `CursorMoved`, no persistence,
no snapshot, and **stillness rather than any frame is what ends one** — a client that stops
moving sends nothing, and each recipient's own decay does the rest. One pointer per person,
a small dot in their colour at reduced opacity with their name always under it, and no edge
marker for one off screen: `edgeMarker` exists because a ping would otherwise be missed, and seven markers
pinned round the border for hands that are simply elsewhere is this feature's whole risk.
Nothing is sent or drawn while the DM previews the staged board.

**The fog question lands the opposite way from ping's, and only for the DM.** `cursor_seen`
withholds the DM's pointer from a player over cells outside `known` — their hand lingers
where they are working — and answers yes to everything else: the DM sees every pointer, a
player's is relayed wherever it goes, and an unfogged map has nothing to withhold. This
overturned `ROADMAP.md`, which proposed gating everybody; the entry records why.

**`SetShowCursors` stops the relay, not the drawing.** DM-only, room-wide, on the table tab,
persisted, a step on the ring, defaults on — and with it off the room drops every frame *and*
every client stops sending. This is the busiest message in the protocol, so a switch that
saved none of that would be a preference rather than a dial. It is deliberately not refused
in `check`: a red banner per `pointermove` is worse than a frame nobody is sent.

→ **`docs/presence.md`** before touching `presence.ts`, `turn.ts`, `cursors.ts`, the reconnect
half of `net.ts`, `RoomState::colours`, `RoomState::here`, `RoomState::show_cursors`,
`cursor_seen`, `PLAYER_HUES`, or `SetColour`/`Presence`/`ColoursChanged`/`MoveCursor`/
`CursorMoved`/`SetShowCursors` on the server.

## Testing

Three suites; which one a change belongs in is decided by what can observe it. **`node
tools/check.mjs` runs the first two plus `cargo fmt --check` and `clippy`**, reporting every failure
rather than stopping at the first — the drivers are left out because they need a browser, a server
and a scratch state file. There is no CI: nothing runs unless somebody runs it.

**`cd server && cargo test`** — the room's own, and the bulk of them. They are **child modules of
`room`**, in `server/src/room/tests/`, split along the same seams as `docs/`: tests for a feature go
in the file named for its subsystem and never back into `room.rs`, which the split emptied of 5,000
lines and which stays that way. They are children rather than a sibling integration test because
they drive `RoomState` through its *private* surface, which is the only way to assert **what a client was not
sent** — and for a permission, a visibility filter, or an event's `was_unseen`, the message that
never left is the whole assertion. `server/src/room/tests.rs` holds what more than one file needs; a
helper one file uses stays in that file, which opens with `use super::*` to pick both up.

**`cd client && npm test`** — the client's pure half, `src/*.test.ts` behind `test.mjs`: the
coordinate spaces, the two distance rules and the trail, `crossesWall`, shape coverage, the DM's
flood fill. It bundles with esbuild first, which is not ceremony — the client imports its own
modules as `./coords.js` and node's resolver will not rewrite that to a `.ts` file. Nothing that
needs a canvas or a socket can be tested here. `npm run check` is this plus the typecheck and build.

**`tools/drive-*.mjs`** — headless Chrome against a running server, and the only thing that can see
a canvas, a layout failure, or a **difference between two connections**. Much of what this project
guarantees is what a *second* client is not holding, and one browser cannot see it; the drivers that
matter most open two. They mutate the room they connect to, so point `SLATE_STATE` at a scratch file
every time, and each one puts back what it changed. Two files sit under them: `cdp.mjs` is the
protocol and knows nothing about this project, and `board.mjs` knows where the grid falls on screen
and which token is standing on a square — anything that clicks the board goes through it rather than
reaching for pixels, because **a driver may not assume the map it was written against.** The README
lists them and what each drives.

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
- **A new feature gets a short summary and a pointer here; the rest goes in `docs/`.** This file is
  loaded into every session and the per-feature sections are already most of its length, because
  each milestone since 20 has written its reasoning into both places. The summary says what the
  feature *is*, which rules bind it, and what a change to it must not break — the mechanism, the
  failure modes and the arguments live in its `docs/` file. If the summary would let you redesign
  the feature, it is too long. The same holds for a new field's comment in the state model.
- Stay within the milestone currently being worked on. Do not scaffold future milestones,
  do not add abstraction for features that are not being built yet. The invariants here, and the
  design in `ROADMAP.md`, are the only forward-looking work permitted.
- **A change to a permission, a visibility filter, or a `was_unseen` is not finished until a test
  asserts what a client was _not_ sent.** The server suite is where that assertion belongs;
  `drive-player.mjs` is the same question asked of a real browser, and neither is the client's.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Do not add dependencies without flagging it and giving the reason.

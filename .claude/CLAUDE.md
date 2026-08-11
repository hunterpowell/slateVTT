# Slate

A minimal virtual tabletop for a private, remote D&D game. Six players plus a DM.
It replaces Foundry for one specific group that only needs a shared map, tokens, and turn order.

This file is the contract: what Slate is, what it must never become, and the rules that hold
across every feature. It is loaded into every session. Two kinds of thing live outside it,
deliberately, and neither is loaded for you:

- **`ROADMAP.md`** — design for what is not built yet, and the milestone order. Read it when
  starting a milestone.
- **`docs/maps.md`, `docs/tokens.md`, `docs/drawings.md`, `docs/walls.md`, `docs/fog.md`** — why each
  built feature is the shape it is. Every section below that summarises a feature ends with a pointer
  to its file and the code that file covers.

(All referenced in backticks on purpose: a bare `@` path here would be an import, and importing
them would load them into every session, which is what moving them out avoided.)

## What it does

- Displays a background map image with pan and zoom
- Shows tokens on that map; the DM moves any token, players move only their own
- Tracks initiative order and the current turn
- Lets the DM prepare the next map out of sight of the table, then promote it
- Lets anyone measure a distance or draw a spell area on the board
- Lets the DM trace the walls and doors of a map, and limits what the table can see to what their
  own tokens have line of sight on — and lets the DM overrule that by hand, square by square or a
  room at a time

## Non-goals

These are out of scope. Do not add them, do not scaffold for them, do not suggest them
unless explicitly asked:

- Character sheets, stat blocks, or any 5e rules knowledge. A hit point total the DM keeps on
  a monster is not a stat block and is in scope; anything that knows what a hit point *means* is not.
- Dice rolling (the group uses physical dice)
- Chat, voice, or video (the group uses Discord)
- Journals, compendiums, handouts, audio
- Module or plugin systems
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

Deployment target: hosted from a Windows PC during game sessions behind a
Cloudflare Tunnel. Slate runs only while the group is playing; it is not an
always-on service.

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
    /// The map the DM is preparing. DM-only — see `docs/maps.md`.
    staged: Option<MapInfo>,
    tokens: HashMap<TokenId, Token>,
    /// Whether the board writes each token's name under it. Room-wide, the DM's
    /// to set and everyone's to hold — see `docs/tokens.md`. Defaults on.
    show_names: bool,
    /// How the movement ruler charges a diagonal. Room-wide, the DM's to set and
    /// everyone's to hold, exactly like `show_names`. The server stores it and
    /// relays it and never computes with it — see `docs/drawings.md`.
    diagonals: Diagonals,
    initiative: Initiative,
    /// Drawn on the board, in draw order — see `docs/drawings.md`.
    shapes: Vec<Shape>,
    /// Traced over the map image. DM-only, whole — see `docs/walls.md`.
    walls: Vec<Wall>,
    /// Everywhere the party's rays have reached, that as the DM's mask leaves it,
    /// and where they can see now. Grid cells, party-shared rather than
    /// per-player. Only `revealed` is persisted and only `recompute_sight` reads
    /// it — everything else reads `known` — see `docs/fog.md`.
    revealed: HashSet<Cell>, known: HashSet<Cell>, visible: HashSet<Cell>,
    /// What the DM said about particular cells anyway. A mask applied after the
    /// raycast, never a write into the two above. DM-only, whole, like the walls.
    overrides: HashMap<Cell, Override>,
    /// How each map URL was last calibrated. Server-side only — it never enters a
    /// snapshot or a message, because the finished `MapInfo` already says
    /// everything a client needs — see `docs/maps.md`.
    calibrations: HashMap<String, Calibration>,
    /// Identified clients, who are the only ones any event reaches, and the
    /// sockets that are connected but have not said who they are yet.
    clients: HashMap<ClientId, Client>,
    pending: HashMap<ClientId, mpsc::Sender<ServerMsg>>,
}

/// `Auto` is the absence of an entry rather than a fourth variant. `Explored`
/// and `Lit` are floors, `Dark` is a ceiling — see `docs/fog.md`.
enum Override { Explored, Lit, Dark }

/// What a diagonal step costs the ruler. `Equal` is the default and is what the
/// ruler did before the switch existed — see *Distance* in `docs/drawings.md`.
enum Diagonals { Equal, Alternating }

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
    /// Whether this map is fogged and how far a token sees on it. Per map and
    /// remembered per URL with the rest — see `docs/fog.md`. `fog` defaults off.
    fog: bool, vision_ft: f32,
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

**Drawing is the exception, and the only one.** Anyone may add a shape; erasing one
is `can_erase` — the DM, or whoever drew it. Everything else below is DM-only.

Walls are the opposite extreme: every wall command is DM-only *and* there is no per-item rule
underneath, because they are all the DM's. A player is not merely stopped from editing them — they
are never sent one, and never told one changed. **The fog override is the second thing with exactly
that rule**, and for the same reason: it is what the DM authored, and the fog is the shadow it casts.

Token creation, deletion, map changes, initiative edits, and whether the board writes token names
under them are DM-only. That last one is the one whose *result* everybody is sent — see the wire
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

`state` is a `RoomView`, which is the room as that one client may see it — for a player that
means `staged` is stripped from it, the walls and the fog overrides are empty, tokens they cannot see
are absent, and what survives is redacted. See `docs/maps.md` and `docs/tokens.md`. `state` is boxed, because growing
`RoomView` by one field pushed `Welcome` past clippy's large-variant threshold — every message in
every client's 256-slot mailbox is sized at the largest variant. Serde sees straight through the box
and the frame on the wire is unchanged.

`fog` is the exception to all of that: it is the same value for every recipient. There is nothing
per-client in a party-shared answer to build. **`show_names` is the second exception and the clearer
one** — the DM alone may flip it and everyone is told, because who may set it is a permission and
what it says is not a secret. `NamesChanged` sits beside `FogChanged` for that reason and not beside
`WallsChanged`, which is the frame it most resembles on paper. **`diagonals` is the third**, and the
sharpest: the server never counts a diagonal, so the only thing it is authoritative over there is
that everybody counts them the same way.

**`Token` never reaches the wire; `TokenView` does.** `Token::view_for(is_dm)` names every field
that leaves the room, so `RoomView.tokens` and `ServerMsg::TokenChanged` both carry views. This
is the third layer of the same idea as `Event` vs `ServerMsg` and `RoomState` vs `RoomView`, and
it exists to make the failure fail the safe way round: a secret added to `Token` and forgotten
here is *absent from the wire*, which shows up as the DM's own client missing a field, rather
than shipped to everyone, which shows up as nothing at all until somebody opens devtools.

`roster` is the cast list, not who is connected. The DM never sees the identity picker, so this
is the only way their token panel learns the names a token can be handed to; a player is sent it
too, having already been offered the same names. Because it describes no connections there is
nothing in it to go stale between deltas — that is `RosterSlot`, and only the picker wants it.

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
nor any one creature. It defaults on, which is the only thing keeping an older save from losing every
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

→ **`docs/tokens.md`** before touching `tokens.ts`, `panel.ts`, `library.ts`, `snap_to_cell`,
`Token`/`TokenView`, or any `message_for` arm.

## Drawings and distance

Line, circle, cone, rectangle — **all four are one struct: a kind and two points**, where `to` is
an *offset* from the origin rather than a second position. One hit test and one coverage rule,
both `containsPoint`. Geometry is in grid units like a token, so recalibrating leaves a 20 ft
circle 20 ft across.

**Anyone may draw** — the only thing in the room a player can add, and the only thing they can
destroy; `can_erase` is the DM or whoever drew it. A shape being swept out is on the wire and is
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

→ **`docs/drawings.md`** before touching `shapes.ts`, `drawtool.ts`, `ruler.ts`, `trailCells`,
`crossesWall`, `SetDiagonals`, or `Shape`/`ShapeKind`/`Sketch` on the server.

## Walls and doors

The DM traces a polyline — click, click, double-click — and the room stores **one `Wall` per gap
between corners**. The run is authoring and is never stored, which is what makes one bad segment of
a long trace erasable without redrawing it. Corners snap to grid corners, Alt places freely, and
that snap is the client's like `originCell` is.

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
`sweep_board`, shared with the shapes. There are no staged walls, so the next dungeon is traced
after it is promoted.

→ **`docs/walls.md`** before touching `walls.ts`, `walltool.ts`, `sweep_board`, or
`Wall`/`WallKind`/`Px` on the server.

## Fog of war

Two sets of grid cells, **party-shared rather than per-player**: `revealed` is everywhere the party
has had line of sight, `visible` is where they have it now. **Terrain gates on `revealed`, creatures
gate on `visible`** — the room they walked through stays on their screen, dimmed, and whatever has
wandered into it since does not. Vision comes from tokens a player *owns*, so handing one over grants
sight with no extra rule.

**Raycasting to cell centres, not shadowcasting.** A cell is visible when the straight line from the
viewer's centre to it crosses no solid wall and no shut door. Shadowcasting wants opacity to be a
property of a cell and a wall here is an arbitrary segment in image pixels; rasterising one into
blocking cells would blind both sides of every wall traced along a cell boundary, which is most of
them. The radius is Euclidean — a circle, agreeing with a drawn circle and not with the ruler.

`FogView` packs a rectangle of cells one character each — `#` dark, `o` explored, `.` in sight —
because a readable frame in devtools is the point of the wire format and a few thousand numbers is
not one. **It is the one message that is identical for every recipient**, the DM included, and that
is the exact opposite of `WallsChanged` beside it: the geometry is the secret and the shadow it casts
is what the table plays with. `None` means the map is not fogged, indistinguishable from having none.

`fog: bool` and `vision_ft` live on `MapInfo`, remembered per URL like the grid, and go out on
`SetMap` — there is no `SetFog`. **`fog` defaults off**, which is what keeps an older save from
going dark. Nothing here knows the word "darkvision": one radius per map.

**Recompute on the drop, never on a drag frame** — `moves_sight` is `persists`'s twin and is
enumerated the same way. `refresh_fog` reads before `apply`, recomputes after, and reports the
difference as events. `revealed` is persisted; `known` and `visible` are derived on boot. A map load,
a promote, a recalibration and a redrawn play area clear all three through `forget_fog`; changing the
radius does not. So does `ResetFog`, which is that plus the overrides and is the DM's way to say **the
whole map back to dark** — one command, because forgetting the exploring and clearing the paint are
one gesture.

**The DM's override is a mask applied after the raycast, and nothing but a ray ever writes into
`revealed`** — a hide that merely cleared it would evaporate the next torch past, and a reveal that
merely wrote into it could never be lifted. `Lit`/`Explored`/`Dark` shape `known` and `visible`, which
is where every reader downstream looks. It gives `in_sight` a different answer, so `unseen_by_table`
stays one line and nothing downstream knows the word. It reaches the DM or nobody, exactly as the
walls do, and the table is owed the `FogChanged` beside it. `SetFogOverride` carries **the cells**,
because the DM's client computes the fill to preview it and the preview and the result have to be the
same array. That fill is bounded by **every traced segment, doors included and whatever they are
swung to** — the one place a door's state is not read, because it asks what is connected and not what
is visible. Swept with the three sets, and persisted whole.

**An unanchored shape gates on `known`**, not on `visible`: a drawing is painted on the floor
rather than standing on it, so it belongs with the terrain. `shape_covers` on the server is a second
copy of `coveredCells`, and the two only have to agree loosely.

→ **`docs/fog.md`** before touching `fog.rs`, `fog.ts`, `overrides.ts`, `fogtool.ts`,
`unseen_by_table`, `shape_seen`, `refresh_fog`, or `moves_sight`.

## Frontend

Camera is `{ x, y, zoom }`. Two functions, `screenToWorld` and `worldToScreen`, are the only
places coordinate math lives. Render by setting the canvas transform once
(`ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom)`) and drawing everything in
world coordinates. Hit-testing happens in world coordinates too.

Getting this layer right is the hardest part of the client. Build and verify it standalone,
against a hardcoded map with no networking, before any WebSocket code exists.

**The left rail shows one of the DM's editing panels at a time, behind a tab strip.** A new panel
is an entry in `RailTab` and an entry in the array `main.ts` passes to `createRail` — it is never
another `<aside>` stacked on the others, which is how the rail ran out of room at four. Two rules
come with it. Closing a tab must put down whatever that panel armed, via the panel's `stop`: the
calibration box and the wall editor both take the left mouse button, and a tool still holding it
under a hidden panel is a click doing something with nothing on screen saying why. And a panel that
goes inert in some state must make its **tab** inert too — a way in to a panel that can do nothing
is the same lie as the panel sitting there looking armed.

The draw tool is deliberately *not* on the strip. It is the one panel everybody has and it is used
in the middle of a fight, so it stays pinned to the bottom of the rail — the same reason a door
swings with no tool in hand. `rail.ts` is short and holds the rest of the reasoning.

## Maps

Two slots: `map`, and `staged: Option<MapInfo>` — the map the DM is preparing while the table is
still looking at the current one. One slot, not a list. `staged` is absent from a player's
`snapshot_for` and `Event::StagedChanged` becomes `None` for everyone but the DM; `None` is both
"nothing is staged" and "you are not the DM", indistinguishable from the client side.

**A `SetMap`'s URL alone decides whether it is loading a map or recalibrating one**, against
whichever slot its `staged` flag names. That distinction is load-bearing three times over — the
remembered calibration table, the staged token plans, and the board's shapes each branch on it,
and a recalibration must sweep away none of them.

The DM picks maps out of the repository's `maps/` folder rather than re-uploading; **a pick is a
copy into the uploads directory, not a second way to serve files.** Listing and picking are
DM-only. This is the only place a client-supplied path reaches the filesystem — canonicalise it
and confirm it resolves inside the library before opening it. **`portraits/` is the same feature
over token art** and shares every line of it; the folder, the size cap, the noun in the refusals
and what a copy's name is fingerprinted over are the whole of what a library differs by.

**Preview is client-only: the server does not know the DM is previewing and must not learn.**
That is why intent rides on the command — `SetMap`, `MoveToken` and `CreateToken` each carry
`staged` — rather than on a mode. Everything that draws or hit-tests reads `shownBoard(scene)`,
never the live board directly.

→ **`docs/maps.md`** before touching `maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`, or
`SetMap`/`MapInfo` on the server.

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
- Stay within the milestone currently being worked on. Do not scaffold future milestones,
  do not add abstraction for features that are not being built yet. The invariants here, and the
  design in `ROADMAP.md`, are the only forward-looking work permitted.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Do not add dependencies without flagging it and giving the reason.

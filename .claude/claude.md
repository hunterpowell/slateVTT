# Slate

A minimal virtual tabletop for a private, remote D&D game. Five players plus a DM.
It replaces Foundry for one specific group that only needs a shared map, tokens, and turn order.

This file describes Slate as it is today. Design for what is not built yet, and the milestone
order, live in `ROADMAP.md` at the repository root — which is not loaded into a session, so read
it when starting a milestone. (Referenced in backticks on purpose: a bare `@` path here would be
an import, and importing it would load it into every session, which is what moving it out
avoided.)

## What it does

- Displays a background map image with pan and zoom
- Shows tokens on that map; the DM moves any token, players move only their own
- Tracks initiative order and the current turn
- Lets the DM prepare the next map out of sight of the table, then promote it

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

A single `RwLock<HashMap<RoomId, RoomHandle>>` guards the room registry. It is touched on
connect and disconnect only — never on a token move.

Per WebSocket connection, split the socket and spawn two tasks:
- recv task: reads the WS stream, deserializes, pushes `(ClientId, ClientMsg)` into the room's `mpsc::Sender`
- send task: reads that client's `mpsc::Receiver`, serializes, writes to the WS sink

### Do not use `tokio::sync::broadcast`

This is deliberate and non-obvious. `broadcast` delivers one identical value to every
subscriber, which makes per-recipient filtering impossible. Fog of war (see below) requires
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
    id: RoomId,
    map: MapInfo,
    /// The map the DM is preparing. DM-only — see *Staged maps*.
    staged: Option<MapInfo>,
    tokens: HashMap<TokenId, Token>,
    initiative: Initiative,
    clients: HashMap<ClientId, Client>,
}

struct MapInfo {
    url: String, grid_px: f32, offset_x: f32, offset_y: f32,
    grid_color: String, play_area: Option<Rect>,
}

struct Token {
    id: TokenId, name: String, x: f32, y: f32, owner: Owner, img: String, size: f32,
    /// DM-only, both of them — see *Hidden tokens and hit points*.
    hidden: bool, hp: Option<Hp>,
}

struct Hp { current: i32, max: i32 }

enum Owner { Dm, Player(PlayerId) }
```

### Invariants

These are load-bearing. Violating them creates work that is expensive to undo later.

1. **Token positions are stored in grid units, never pixels.** Recalibrating a map's grid
   size must not move any token. Pixel conversion happens only at render time on the client.
   This is about tokens. Geometry that traces the map image — `play_area`, and walls when they
   arrive — is stored in image pixels instead, because it is anchored to the art rather than to
   a cell.

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

Token creation, deletion, map changes, and initiative edits are DM-only. So is reassigning a
token's `owner`, which is how a player is handed a token the DM built for them.

The DM uploads all token art. The upload endpoint authenticates with the DM secret, and a
player has no credential to offer it — giving them one would be the authentication this
project does not build.

Identity: the DM joins with a secret in the URL. Players join with a plain room link and
claim a name from a roster the DM defined. `player_id` persists in `localStorage` so a
refresh does not orphan a token. This is a private game among friends — do not build
real authentication.

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
means `staged` is stripped from it, hidden tokens are absent, and what survives is redacted.
See *Staged maps* and *Hidden tokens and hit points*.

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

## Tokens

A token is a square `size` cells across, centred on the position stored for it. `size` is one of
`0.5, 1, 2, 3, 4` — a closed set, checked on the server and offered to the DM as a dropdown rather
than a number field. Nothing here knows the words "large" or "huge"; that is rules knowledge. The
half exists for a druid who is currently a rat.

**Where a token settles depends on how wide it is.** An odd width has a middle cell and settles on
that cell's centre; an even width has no middle cell and settles on the corner four cells meet at.
Either way its edges land on grid lines, which is the point. Anything below one cell settles like a
single-cell token rather than on a sub-cell lattice of its own — a tiny creature belongs in a
square with the rest of the party, not tucked into a quarter of one. Resizing re-snaps, or a token
grown from 1×1 to 2×2 straddles half a cell until somebody happens to drag it. This rule lives in
`snap_to_cell` on the server and nowhere else; the client never snaps.

Creating, deleting and editing a token are DM-only, and the id is the server's to invent. One
`UpdateToken` carries every editable field, the way `SetMap` carries the whole grid — position is
deliberately not among them, because `MoveToken` owns that and an edit made from a panel must not
drag a token out from under whoever is moving it. `TokenChanged` covers creation and editing alike:
an id the client has not seen is the creation. That is one message instead of two that would have
to be kept in step, and it is what a hidden token becomes a `TokenRemoved` for players and a
`TokenChanged` for the DM out of.

**Deleting a token takes its initiative row with it**, and will have to take its anchored drawings
too. The order otherwise holds a row naming something that no longer exists, which the panel draws
as a bare id and `next_turn` hands the turn to.

Token art is optional: a token without it draws as a named disc, so the sixth goblin of the evening
costs the DM nothing. `img` is held to a site-relative path — art on somebody else's server is art
that vanishes the evening that server is down, and the one thing in a save the uploads directory
would not back. Uploading it shares the map upload's handler, since proving some bytes are an image
and giving them a name of ours is the same operation either way; the two routes differ only in the
size they cap at.

## Hidden tokens and hit points

Two DM-only fields on a token, and the place per-field redaction was invented. Staging withholds
a whole message; these withhold a *field on a token the table otherwise sees*, which is why they
came before fog — getting it wrong costs one monster's hit points rather than the entire map.

**`hidden` means genuinely absent, not drawn faintly.** A hidden token is filtered out of a
player's `snapshot_for`, its `TokenMoved` frames are dropped for them, and its initiative row is
gone from their panel. It applies whoever owns the token; a uniform filter is worth more than a
rule forbidding the DM from hiding a player's own token, which is merely a strange thing to do.

**`hp: Option<Hp>` reaches the DM and nobody else, on every token including a player's own.**
`None` is both "the DM keeps no total on this one" — the usual state — and "you are not the DM",
indistinguishable from the client side, the way `staged` being `None` is. The pair travels
together so "half a hit point total" is unrepresentable. Bounds are on magnitude only: whether
`current` may exceed `max` is a question about what a hit point *means*, and that is the rules
knowledge this does not have. Players track their own totals on their own sheets — character
sheets are a non-goal.

### The three shapes one event leaves in

`Event::TokenChanged` becomes a `TokenChanged` for the DM, a redacted `TokenChanged` for a player
who may see it, a `TokenRemoved` for a player it has just been hidden from, and **nothing at all**
for a player it was already hidden from. That last arm is the one that gets missed: a
`TokenRemoved` naming an id they never held tells them a token exists, which is the whole thing
being withheld.

Telling those last two apart needs the token's `hidden` from *before* `apply` ran, which
`message_for` cannot read off `&self`. So `Event::TokenChanged` and `Event::TokenRemoved` each
carry `was_hidden`. A token that has just been created counts as hidden, because nobody holds it
yet — which is exactly what makes a create-hidden announce nothing.

### Initiative

`initiative_for(is_dm)` drops rows naming a token the recipient cannot see, and nulls `current`
when it names one. Both halves matter: the panel names its rows by looking the token up in the
scene, so a row with no token draws as a raw id — the monster the DM just hid, advertised by the
one panel always on screen. `current` is an id, and an id is data. The round number is not a
secret and is sent as it is; the table watches the turn pass to something they cannot see, which
is what is happening.

**Hiding a token that is in the order therefore emits `InitiativeChanged` as well**, the way
deleting one does. Nothing else about a token edit rebuilds the panel, so without it the table
keeps a row naming a token their client has just been told to forget.

### On screen

Hidden tokens are the DM's alone, so the client never has to defend against drawing one — the
question is only how the DM tells them apart. They draw faded *and* with a dashed violet ring:
faded alone is what a slow-loading portrait looks like, dashed alone is what a selection is, and
violet collides with nothing the ring vocabulary already means. Fading multiplies with preview
ghosting rather than replacing it. The same violet marks the row in the DM's initiative panel,
because their panel and the table's now differ and the DM is the one who has to know which they
are reading.

Hit points draw as a bar above the token with the numbers over it, in screen space like a name.
Three colour bands rather than a gradient — a DM glancing at six monsters wants to sort them, and
nothing here knows the word "bloodied". Taking damage is the token panel with a new number and
Enter; there is no `SetHp`, because it would carry one field of the several `UpdateToken` already
sends together.

## Distance

A grid cell is five feet. Measured distance is straight-line. The 5e variant where every other
diagonal costs double is a rule, and rules knowledge is a non-goal.

The movement ruler shows how far the token being dragged has travelled from where its drag
began. It is client-only — no command, no event, nothing persisted.

## Frontend

Camera is `{ x, y, zoom }`. Two functions, `screenToWorld` and `worldToScreen`, are the only
places coordinate math lives. Render by setting the canvas transform once
(`ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom)`) and drawing everything in
world coordinates. Hit-testing happens in world coordinates too.

Getting this layer right is the hardest part of the client. Build and verify it standalone,
against a hardcoded map with no networking, before any WebSocket code exists.

## Maps and the map library

The DM picks a map out of the repository's `maps/` folder instead of re-uploading one every
session: list what is there, then pick one by path. The directory is `SLATE_MAPS`, defaulting to
`../maps` the way `SLATE_CLIENT_DIR` defaults to `../client`.

**A pick is a copy into the uploads directory, not a second way to serve files.** The copy is
named deterministically from the source path, so picking the same map twice resolves to the same
file and the same URL rather than accumulating a duplicate per pick. That name is a readable slug
of the relative path with a short hash of the same path appended — the slug because
`%LOCALAPPDATA%\Slate` is meant to be browsable, the hash because two different paths can slug
identically and silently collide onto one file. Everything downstream is then identical to an
upload — one kind of map URL, and `%LOCALAPPDATA%\Slate` stays a complete backup on its own,
which serving `maps/` directly would quietly break.

Listing and picking are DM-only, authenticated with the same secret header the upload endpoint
uses. A player enumerating the maps folder is the next dungeon in devtools, which is invariant 4's
concern even though no room state is involved.

**This is the only place a client-supplied path reaches the filesystem.** Uploads sidestep the
problem by generating their own name; a library pick cannot. Canonicalise the requested path and
confirm it resolves inside the maps directory before opening it, and remember that Windows
separators are in play.

Grid calibration is remembered per map URL, so re-picking a map used before comes back already
calibrated. It lives server-side only and never goes on the wire: the room applies the remembered
values when the map is set and sends the finished `MapInfo`, so there is no new client state and
no new message.

**A `SetMap`'s URL alone decides whether it is loading a map or recalibrating one.** A URL the
room is not already showing is a load, and a remembered calibration for it beats whatever the
client sent. A URL matching the current map is a recalibration: applied as given, and recorded.
Recording happens there and on a load of a map with nothing remembered yet — never on a load that
a remembered calibration won. Without that split the two halves of this feature cancel out, since
a remembered calibration would overwrite every attempt to correct it and no map could be
recalibrated twice.

The table is persisted with the room. Slate runs only while the group is playing, so an in-memory
one would be empty every game night and the feature would never fire. It is the first thing on
`Saved` that is not part of any client's view of the room, and it stays off `RoomView` for the
same reason walls will.

An uploaded map gets a fresh UUID each time and so will not match an earlier calibration — that
asymmetry is deliberate, and content-hashing uploads to close it is not worth the change.

## Staged maps

`staged: Option<MapInfo>` is the map the DM is preparing while the table is still looking at the
current one. Promoting moves it into `map` and empties the slot. There is one slot, not a list: a
full scene concept — several maps each owning its own walls, fog and token positions — is a much
larger feature and is not being built.

**This is the first thing the visibility filter genuinely withheld.** It is absent from a
player's `snapshot_for`, and `Event::StagedChanged` becomes a message for a DM recipient and
`None` for everyone else. The arms that predate it drop a message for something the recipient
*did*; this one drops it for who they are, which is the shape `hidden` tokens and hit points then
took and fog will — see *Hidden tokens and hit points*, where the same idea had to reach inside a
message rather than only past it. A staged map that shipped to every client and was merely not
drawn would be the next dungeon sitting in devtools — invariant 4.

`None` is both "nothing is staged" and "you are not the DM", so the two are indistinguishable
from the client side. Staging is persisted, for the same reason the calibration table is: Slate
runs only while the group is playing, so a map staged at the end of one evening for the next
would otherwise be gone before it was wanted.

**`SetMap` carries a `staged` flag rather than there being a second command.** It names the slot
and nothing else — the rule that a URL alone decides between loading and recalibrating is
unchanged, it just runs against that slot's URL. An empty staged slot holds no URL, so filling it
is always a load, which is what makes a map arrive already calibrated the moment it is staged.
Calibrations are one table keyed by URL across both slots, so calibrating while staged is what
makes the map land on the board correct when it is promoted. `PromoteStaged` and `ClearStaged`
are refused when nothing is staged, the way deleting a token that does not exist is refused.

On promote, tokens keep their grid coordinates and the DM repositions them. There is no sensible
way to carry a cell across to an unrelated image, and pretending otherwise would move tokens for
reasons nobody asked for. Fog and walls will clear, which is already the rule for a new map.

### Preview

Calibrating a staged map means looking at it, so the DM's client points the renderer at the
staged image while the table keeps seeing the live one. There is no separate preview toggle:
the map panel's `Map | Next map` switch decides which slot everything in it is about, and
selecting a slot that holds a map *is* preview mode.

The client's `Scene` therefore holds two `Board`s — live and staged — and everything that draws
or hit-tests reads `shownBoard(scene)` rather than reaching for the live one. That indirection is
the whole client-side feature; without it, a staged calibration preview writes into the grid the
table is looking at.

Tokens draw ghosted and nothing is grabbable while previewing: they keep their cells through a
promote, so showing them says where the party lands, but what is on screen is not the board and a
token that looks draggable and is not reads as broken. The token panel is hidden for the same
reason. (This is the one part of staging that a queued milestone deliberately reverses — see
*Preparing the next room* in `ROADMAP.md` before building on it.) Preview is client-only — no command, no event, nothing persisted, and nobody else can
tell it is happening. Because it is that invisible, the DM's own screen has to say so loudly:
mistaking a staged map for the board is the one way this feature goes wrong.

## Working agreement

- When a requirement is ambiguous, ask before implementing. A wrong guess costs more than a question.
- State uncertainty plainly. Do not present a guess about a crate's API or behavior as fact —
  check it or say you are unsure.
- Read `ROADMAP.md` before starting a milestone, and update it when one lands. Nothing loads it
  for you.
- Stay within the milestone currently being worked on. Do not scaffold future milestones,
  do not add abstraction for features that are not being built yet. The invariants here, and the
  design in `ROADMAP.md`, are the only forward-looking work permitted.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Do not add dependencies without flagging it and giving the reason.

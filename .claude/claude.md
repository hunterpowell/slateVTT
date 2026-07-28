# Slate

A minimal virtual tabletop for a private, remote D&D game. Five players plus a DM.
It replaces Foundry for one specific group that only needs a shared map, tokens, and turn order.

## What it does

- Displays a background map image with pan and zoom
- Shows tokens on that map; the DM moves any token, players move only their own
- Tracks initiative order and the current turn

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
    tokens: HashMap<TokenId, Token>,
    initiative: Initiative,
    clients: HashMap<ClientId, Client>,
}

struct MapInfo { url: String, grid_px: f32, offset_x: f32, offset_y: f32 }

struct Token { id: TokenId, name: String, x: f32, y: f32, owner: Owner, img: String }

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

On join, the server sends `ServerMsg::Welcome { your_id, is_dm, state }` containing a full
filtered snapshot. Everything after that is a delta. Reconnection is just another join —
there is no diffing or resync protocol.

## Drag semantics

Token movement uses two message rates:

- During drag: `MoveToken { dragging: true }`, throttled client-side to ~20–30 Hz. The room
  applies it in memory and relays it, but does not snap to grid and does not mark state dirty.
- On drop: `MoveToken { dragging: false }`. This snaps to the grid and marks the room dirty
  for persistence.

The client predicts locally — it moves its own token immediately rather than waiting for the
round trip, and corrects only if the server rejects. The server must not echo drag frames back
to the originating client; doing so causes visible rubber-banding.

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

## Maps, library, and staging (designed, not yet built)

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

**Staging.** `staged: Option<MapInfo>` lets the DM prepare the next map while the table is still
looking at the current one. Promoting moves it into `map` and clears the slot.

`staged` is DM-only, stripped in `snapshot_for` and in the filter exactly like walls. A staged map
that ships to every client and is merely not drawn is the next dungeon sitting in devtools, which
is what invariant 4 exists to stop. This is the first feature where that filtering is real rather
than structural, which is why it comes before the others that depend on it.

Calibrating a staged map means looking at it, so the DM's client gets a preview mode that points
the renderer at the staged image while players keep seeing the live one. Token interaction is off
in that mode — dragging tokens over a map that is not the board is only confusing.

On promote, tokens keep their grid coordinates and the DM repositions them; fog and walls clear,
which is already the rule for a new map. There is one staged slot, not a list. A full scene
concept — several maps each owning its own walls, fog, and token positions — is a much larger
feature and is not being built, and staging pre-traced walls waits for it.

## Drawings (designed, not yet built)

Spell areas and measuring shapes: line, circle, cone, rectangle. Anyone may draw. Only the
person who drew a shape, or the DM, may delete it.

A shape may anchor to a token, `anchor: Option<TokenId>`, so an aura follows the creature it
belongs to. An anchored shape needs no position updates on the wire at all — the client has the
anchor's position already and derives the rest. Deleting a token deletes the shapes anchored to it.

Measuring lines are ephemeral and vanish when released. Spell areas persist until deleted.

Once fog exists, shapes are filtered server-side like everything else, all-or-nothing on
overlap: if any cell a shape covers is visible, the whole shape is sent. Drawing shapes
underneath the fog overlay and calling them hidden would put the data on the client and paint
over it, which is precisely what invariant 4 forbids. An anchored shape's visibility follows
its anchor token's rather than its own footprint — otherwise an aura on a monster in the dark
advertises exactly where that monster is standing.

## Fog of war and walls (designed, not yet built)

Do not implement this ahead of its milestone. The following constraints exist so it can be
added without a rewrite — they are already reflected in the rules above:

- Per-client `mpsc` instead of `broadcast`
- `Event` separate from `ServerMsg`
- `snapshot_for(client)` instead of `snapshot()`
- Grid-unit token positions, which make the token-to-cell lookup free

Cell-based visibility over the grid, using symmetric shadowcasting.

**Fog is party-shared, not per-player.** One `revealed` bitset (explored terrain, persistent)
and one `visible` bitset (current line of sight), each the union over every player-owned token.
Five people narrating to each other on Discord get nothing out of per-player fog but confusion
and five times the state. Terrain gates on `revealed`; tokens gate on `visible`. Vision comes
from tokens a player *owns*, so handing a token over grants vision with no extra rule.

**Walls are `Vec<Segment>` in image pixels.** A wall traces a feature painted on the map, so it
is anchored to the art and not to a cell; stored in grid units, every wall would slide off the
wall it was tracing the moment the DM recalibrated. See invariant 1 — this is not an exception
to it. Calibrate the grid before tracing walls.

**Walls and doors never enter a player's snapshot.** Not sent-and-not-rendered — genuinely
absent, per invariant 4. Players infer the geometry from the edges of the fog.

Doors are walls carrying an open/closed state, toggled by the DM only. Tokens do not block line
of sight; only walls do. The play-area boundary is an implicit wall, so vision does not spill
into the void off the edge of the map.

Vision range is one DM-set radius per map, stored in feet on `MapInfo` and converted to cells
where it is used. It needs a generous value in `MapInfo`'s `Default` impl: the container-level
`#[serde(default)]` means a save written before the field existed would otherwise load it as
zero, and every restored room would go pitch black.

The DM also gets a manual override, independent of line of sight. It is a tri-state per cell —
`Auto`, `ForceRevealed`, `ForceHidden` — and *not* a write into `revealed`, because a manual
hide that merely clears `revealed` evaporates the next time a token has line of sight on that
cell. The reveal tool is a flood fill bounded by walls, and it previews before it commits: one
gap in a traced room otherwise reveals the whole dungeon in a single click, and there is no undo.

Visibility is recomputed in `apply`, never in the visibility filter — the filter runs against
`&self` while the client map is borrowed, so it cannot mutate bitsets, and it is better kept
pure regardless. Recompute on drop, not on drag frames: the shadowcast is cheap enough at 30 Hz,
but shipping a bitset thirty times a second is not. A bitset does not fit the frame cap as a
JSON array of per-cell values either — pack it into a single string field. That is still one
readable frame in devtools, which is what the wire protocol rule actually protects.

Recalibrating the grid invalidates the bitsets, which are inherently grid-space. Loading a new
map clears them outright.

## Build order

Do not work ahead. Each milestone should run and be usable before starting the next.

1. Client only, no server. Hardcoded map image, pan, zoom, drag a token around. No networking.
2. Server with a single hardcoded room, no identity, no permissions. Two browser tabs stay in sync.
3. Identity (DM secret, player roster) and the permission check.
4. Initiative panel — add, reorder, next/previous turn, round counter.
5. Debounced JSON persistence and restore on boot.
6. Map upload and grid calibration UI.
7. Package for Windows session hosting and deploy behind a Cloudflare Tunnel.

Milestones 1–7 are done. What follows was planned afterwards, and the order is deliberate:

8. Map library — list `maps/`, pick one, remember its calibration. The smallest thing on this
   list and the only one that touches nothing else.
9. Token lifecycle — the DM creates and deletes tokens, with a custom image, a size in grid
   units, and a reassignable `owner`. That last part is the whole wild shape story: build a
   large token, hand it to the player, take it back or delete it when the spell ends. Note that
   snapping becomes size-dependent — an even-sized token centres on a cell corner, not a cell
   centre — and that deleting a token has to reach into initiative and anchored drawings, or it
   leaves entries pointing at something that no longer exists.
10. Staged map, and the DM preview mode that makes it calibratable. This is where
    `snapshot_for` starts genuinely filtering rather than merely having the shape for it.
11. `hidden` on tokens, then hit points. Both DM-only-visible, and both the same filtering
    pattern staging established. Deliberately before fog: a mistake here costs one monster's
    hit points rather than the entire map.
12. Movement ruler.
13. Drawing layer.
14. Wall and door editor. Polyline authoring — click, click, double-click to end — snapped to
    grid corners, with a modifier for free placement. This is not polish: per-segment click-drag
    across a two-hundred-segment dungeon is what makes people quietly stop using fog of war.
15. Fog of war.

## Working agreement

- When a requirement is ambiguous, ask before implementing. A wrong guess costs more than a question.
- State uncertainty plainly. Do not present a guess about a crate's API or behavior as fact —
  check it or say you are unsure.
- Stay within the milestone currently being worked on. Do not scaffold future milestones,
  do not add abstraction for features that are not being built yet. The invariants, and the
  sections marked *designed, not yet built*, are the only forward-looking design permitted.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Do not add dependencies without flagging it and giving the reason.

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

- Character sheets, stat blocks, or any 5e rules knowledge
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

Token creation, deletion, map changes, and initiative edits are DM-only.

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

## Frontend

Camera is `{ x, y, zoom }`. Two functions, `screenToWorld` and `worldToScreen`, are the only
places coordinate math lives. Render by setting the canvas transform once
(`ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom)`) and drawing everything in
world coordinates. Hit-testing happens in world coordinates too.

Getting this layer right is the hardest part of the client. Build and verify it standalone,
against a hardcoded map with no networking, before any WebSocket code exists.

## Fog of war (not now, but the architecture must permit it)

Not in the initial build. Do not implement it. The following constraints exist so it can be
added later without a rewrite — they are already reflected in the rules above:

- Per-client `mpsc` instead of `broadcast`
- `Event` separate from `ServerMsg`
- `snapshot_for(client)` instead of `snapshot()`
- Grid-unit coordinates

When it is eventually built, the intended design is: cell-based visibility over the grid using
symmetric shadowcasting, with walls as `Vec<Segment>` in grid space. Two distinct bitsets per
player — `revealed` (explored terrain, persistent) and `visible` (current line of sight,
recomputed on movement). Terrain gates on `revealed`; tokens gate on `visible`.

## Build order

Do not work ahead. Each milestone should run and be usable before starting the next.

1. Client only, no server. Hardcoded map image, pan, zoom, drag a token around. No networking.
2. Server with a single hardcoded room, no identity, no permissions. Two browser tabs stay in sync.
3. Identity (DM secret, player roster) and the permission check.
4. Initiative panel — add, reorder, next/previous turn, round counter.
5. Debounced JSON persistence and restore on boot.
6. Map upload and grid calibration UI.
7. Package for Windows session hosting and deploy behind a Cloudflare Tunnel.

## Working agreement

- When a requirement is ambiguous, ask before implementing. A wrong guess costs more than a question.
- State uncertainty plainly. Do not present a guess about a crate's API or behavior as fact —
  check it or say you are unsure.
- Stay within the milestone currently being worked on. Do not scaffold future milestones,
  do not add abstraction for features that are not being built yet. The invariants section
  above is the only forward-looking design permitted.
- Prefer the smaller change. Prefer deleting code to adding a flag.
- No `unwrap()` outside tests and startup. Errors that can happen at runtime get handled.
- Do not add dependencies without flagging it and giving the reason.

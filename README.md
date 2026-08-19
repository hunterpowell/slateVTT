# Slate

A minimal virtual tabletop for a private, remote D&D game — handful of players plus a DM. It
replaces Foundry for one group that only needs a shared map, tokens, and turn order.

- Pan/zoom map with DM-controlled upload and grid calibration, or a pick out of a map library
- A second map slot the DM prepares out of sight of the table, then promotes
- Tokens the DM can move freely and players can move only their own, with uploaded or
  library art, a size in grid units, and an owner the DM can reassign
- Monsters the DM can keep hidden, with hit points only they can see, and positions
  planned on the map the table has not been shown yet
- An initiative tracker with round counter, next/previous turn, portraits, and — for the
  DM — a hit point bar on each row
- A movement ruler that tints the squares a drag crossed, counting diagonals whichever
  way the DM sets the room to
- Measuring and spell-area drawing that anyone at the table can use
- A ping: hold the mouse button and a ring appears on everyone's board, with an arrow at
  the edge of the screen for whoever is looking somewhere else
- Walls and doors the DM traces over the map, which block line of sight and never movement
- Fog of war: the table sees what their own tokens can see, and remembers where they have
  been — with a DM override to reveal or black out a room by hand
- Two ways for a map to be lit: line of sight from each token, or the whole room a token is
  standing in, where an open door lets the light through and a shut one seals it
- Whisper and shout: a player says something to the table or privately to the DM, the DM whispers
  any one player, and nobody messages anybody else — kept for the evening and never written to disk
- State is saved to a JSON file on disk and restored on restart

See [CLAUDE.md](.claude/CLAUDE.md) for the architecture, invariants, and non-goals, and [docs/](docs/)
for why each feature is the shape it is. This game does not include character sheets, dice rolling,
or accounts — the group uses physical dice and Discord for the rest. The text above is not chat and
the distinction is the design: two destinations, no player-to-player, no history between sessions.

## Stack

- **Server:** Rust, `axum` + `tokio`, JSON snapshot persistence (no database)
- **Client:** vanilla TypeScript, canvas 2D, bundled with `esbuild` (no framework)

## Prerequisites

- Rust (2024 edition — `rustc` 1.85+) and Cargo
- Node.js (for `esbuild`/`tsc`, dev-time only — nothing from `npm` ships to the browser
  except the bundled output)

## Running it

Build the client bundle, then run the server, which serves the client and the API from the
same port:

```sh
cd client
npm install
npm run build      # or: npm run watch, to rebuild on save

cd ../server
cargo run
```

The server logs the URL it's listening on and a one-time DM link:

```
DM link: http://127.0.0.1:3000/?dm=<secret>
```

Open that link as the DM. Give players the plain room link (`http://127.0.0.1:3000/`) —
they'll be prompted to claim a name from the roster on first visit. The claimed identity is
remembered in `localStorage`, so a refresh doesn't orphan a token.

## Configuration

The server is configured entirely through environment variables; all have working defaults
for local use:

| Variable          | Default          | Purpose                                       |
| ----------------- | ---------------- | ---------------------------------------------- |
| `SLATE_ADDR`       | `127.0.0.1:3000` | Address to bind                               |
| `SLATE_CLIENT_DIR` | `../client`      | Static files served for everything but `/ws` and `/api/*` |
| `SLATE_DM_SECRET`  | random per boot  | Set this to keep the DM link stable across restarts |
| `SLATE_STATE`      | `slate-state.json` | Path to the persisted room snapshot         |
| `SLATE_UPLOADS`    | `uploads`        | Directory for DM-uploaded map images          |
| `SLATE_MAPS`       | `../maps`        | Map library the DM picks from. Never served directly — a pick is copied into `SLATE_UPLOADS` |
| `SLATE_PORTRAITS`  | `../portraits`   | Token-art library, the same way. DM-only to list or pick from |

The player roster (currently Cleodara, Saelyn, Torrin, Captain Bronzebeard, Thornwhistle
Fernbark and Ignacio) is a constant in [server/src/room.rs](server/src/room.rs), not runtime
config — edit it there for a different group. Each slot has a short id beside its name; the id
is what `localStorage` remembers and what a token's owner is written as, so renaming a
character is a change to the name alone and their tokens follow them.

## Project layout

```
client/   TypeScript source, canvas rendering, esbuild config
server/   axum server: room actor, wire protocol, JSON persistence
tools/    gen-assets.mjs — placeholder map/token art for local dev
          cdp.mjs, board.mjs, drive-*.mjs — drive the real client in a headless browser
maps/     the map library — the DM picks from these in-app during play
portraits/ the token-art library — the same, for faces rather than floors
```

## Testing

```sh
cd server && cargo test
cd client && npm run check   # typecheck + unit tests + build
cd client && npm test        # just the unit tests
```

The server's tests live in [server/src/room/tests/](server/src/room/tests/), one file per
subsystem along the same seams as [docs/](docs/). They are child modules of the room rather
than a sibling integration test, because they drive `RoomState` through its private surface —
which is the only way to assert what a client was *not* sent, and that is most of what is
interesting about a room that filters every message per recipient.

The client's tests cover its pure half — the coordinate spaces, the two distance
rules and the trail, the wall crossing test, shape coverage, and the DM's flood
fill. They run under node's own test runner against an esbuild bundle, because
the client imports its own modules as `./coords.js` and node will not resolve
that to a `.ts` file. Anything needing a canvas or a socket is the browser
drivers' job, below.

### Driving the real client

The `tools/drive-*.mjs` scripts open the actual client in headless Chrome and click through it,
asserting on the DOM and — where only pixels can tell the difference — on the canvas itself. They
speak the DevTools protocol directly, so there is nothing to install beyond the browser already on
the machine. Two files sit under them: [tools/cdp.mjs](tools/cdp.mjs) is the protocol and knows
nothing about Slate, and [tools/board.mjs](tools/board.mjs) is what knows where the grid is on
screen and which token is standing on a given square.

| Driver             | What it drives                                                    | Browsers |
| ------------------ | ----------------------------------------------------------------- | -------- |
| `drive-ui.mjs`     | The wall and door editor, as the DM                               | DM       |
| `drive-player.mjs` | A player's connection — that the DM's half is *absent*, not hidden | player   |
| `drive-rail.mjs`   | The left rail's tab strip, and the layout failures it fixed        | DM       |
| `drive-fog.mjs`    | Fog of war, room lighting, and what a player's client never fetched | both     |
| `drive-names.mjs`  | The names-under-tokens switch, on both boards at once              | both     |
| `drive-ruler.mjs`  | The movement trail, the diagonal switch, the initiative panel      | both     |
| `drive-ping.mjs`   | The hold that pings, and the ring reaching an unexplored corner    | both     |
| `drive-select.mjs` | Shift-click selection, and the group drag that moves them together | both     |
| `drive-staged.mjs` | Tracing and painting the next dungeon, and the table not being told | both     |
| `drive-undo.mjs`   | The DM's undo reaching the table, and not rebuilding their page    | both     |
| `drive-panels.mjs` | The initiative panel folding, and the DM's solo sight staying theirs | both     |
| `drive-chat.mjs`   | Whisper and shout — and a whisper being absent from a *third* person's page | three    |

The ones marked *both* open two browsers at once, and that is the point of them: almost everything
they assert is a **difference** between what two people are holding, which one client cannot see.
`drive-chat.mjs` opens three, because the thing it has to show is what one *player* is not sent
about another — a line drawn between two people at the same table rather than between the DM and it.

They need a server running with a **known** DM secret, and they change the room they connect to.
Each takes an optional base URL, and the DM-side ones an optional secret after it — the defaults
are exactly what is written below:

```sh
cd server
SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run

# elsewhere — the arguments below are the defaults, so bare `node tools/…` does the same
node tools/drive-ui.mjs     http://127.0.0.1:3000 test-secret
node tools/drive-player.mjs http://127.0.0.1:3000
```

Point them at a scratch `SLATE_STATE`, never at the room you are about to play in — the first
thing `drive-ui.mjs` does is erase every wall on the board, `drive-staged.mjs` throws away whatever
was in the staged slot, and the fog, names, ruler and ping drivers each build a token or flip a
switch that persists. Run them one at a time: they share debug ports (9333 for a DM, 9334 for a
player, 9335 for a second player), so two at once attach to each other's browser. Set `SLATE_BROWSER` if Chrome or Edge is
somewhere unusual.

**A scratch path with no file on it, and not a copy of a real room.** They are written against the
room a first boot builds — eight tokens on `/assets/map.png`, an empty initiative order, nothing
traced and nothing staged — and several of them assert against that directly, so a copy of a room
that has been played in fails checks that have nothing to do with what they drive. Deleting the
scratch file is what resets them, and because the room lives in memory and is only read at boot,
that means **restarting the server** rather than just deleting the file.

**They may be run in any order**, and that is worth stating because for a while they could not be.
`drive-staged.mjs` ends by promoting a different map onto the board, on purpose, and four other
drivers used to build a token and then click the middle of the canvas to select it — which is where
a new token lands only if the middle was free and the zoom was the one they were written at. The
symptom was five failures in `drive-ruler` that looked exactly like a regression in whatever had
just been changed.

That lives in [tools/board.mjs](tools/board.mjs) now: it measures the grid off the HUD, finds a
token by looking outward from the middle of the view, and converts a cell to either client's screen
coordinates. Anything that clicks the board should go through it rather than reaching for pixels —
**a driver may not assume the map it was written against.**

### Running the lot

**All twelve take about three minutes**, so run all of them whenever the client changes rather than
picking the ones that look relevant. Picking is not worth the thought it costs: they all sit on
`coords.ts`, `render.ts`, `input.ts` and `scene.ts`, and almost every client commit touches one of
those, so any honest rule about which to skip says "none of them" nearly every time.

| player | names | ui  | rail | undo | chat | staged | fog | ruler | select | ping |
| ------ | ----- | --- | ---- | ---- | ---- | ------ | --- | ----- | ------ | ---- |
| 4s     | 6s    | 9s  | 12s  | 14s  | 16s  | 22s    | 23s | 25s   | 30s    | 39s  |

`drive-ping.mjs` is the slowest and stays that way: most of its time is spent waiting for rings to
expire, which is the feature.

The per-run cost is not the drivers, it is the room — a fresh one means restarting the server, so
run the suite against **one** server rather than restarting between drivers. Sequentially, because
of the shared debug ports:

```sh
cd server
rm -f scratch.json      # the room is only read at boot, so this is what resets it
SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run &
until curl -sf http://127.0.0.1:3000/ >/dev/null; do sleep 1; done

cd ..
for d in player names ui rail undo panels chat staged fog ruler select ping; do node tools/drive-$d.mjs; done
```

That whole block is 169 seconds on the machine it was written on, and the order in it is the cheap
drivers first — so a broken client fails `drive-player.mjs` four seconds in rather than two minutes
in. The order is a convenience and nothing rests on it.

A driver killed part-way leaves two things behind that make the *next* run lie: a Chrome holding the
debug port, which the next `open()` attaches to and hangs on, and whatever tokens it had not tidied
away yet. `taskkill //F //IM chrome.exe` and a fresh scratch file put both right. **Never pipe a
driver through `head`** — it dies on the broken pipe part-way through and leaves exactly that mess.

## Hosting a remote session from Windows

Slate can run from a Windows PC only while the group is playing. The included
PowerShell scripts build the production client and server, keep runtime data
under `%LOCALAPPDATA%\Slate`, and start the server on the loopback interface.
A separate Cloudflare Tunnel terminal exposes it without opening an inbound
firewall port.

See [deploy/windows/README.md](deploy/windows/README.md) for the build, local
run, Quick Tunnel rehearsal, backup, and troubleshooting procedures.

## Hosting always-on from a Raspberry Pi

The other host, and a different proposition: it stays up between sessions so the
DM can prepare the next map without anyone else being involved. The Pi builds
nothing — a Windows machine cross-compiles the server and bundles the client, and
the Pi runs them under `systemd`.

See [deploy/pi/README.md](deploy/pi/README.md) for the card, the layout, the
service account, the cross-compile, the deploy, and what each failure we hit
looked like.

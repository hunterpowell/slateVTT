# Slate

A minimal virtual tabletop for a private, remote D&D game — handful of players plus a DM. It
replaces Foundry for one group that only needs a shared map, tokens, and turn order.

- Pan/zoom map with DM-controlled upload and grid calibration
- Tokens the DM can move freely and players can move only their own
- An initiative tracker with round counter and next/previous turn
- Measuring and spell-area drawing that anyone at the table can use
- Walls and doors the DM traces over the map, ready for line of sight
- State is saved to a JSON file on disk and restored on restart

See [CLAUDE.md](.claude/CLAUDE.md) for the architecture, invariants, and non-goals, and [docs/](docs/)
for why each feature is the shape it is. This game does not include character sheets, dice rolling,
chat, or accounts — the group uses physical dice and Discord for the rest.

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

The player roster (currently Grog, Vex, Pike, Nyx, Bram) is a constant in
[server/src/room.rs](server/src/room.rs), not runtime config — edit it there for a different
group.

## Project layout

```
client/   TypeScript source, canvas rendering, esbuild config
server/   axum server: room actor, wire protocol, JSON persistence
tools/    gen-assets.mjs — placeholder map/token art for local dev
          cdp.mjs, drive-*.mjs — drive the real client in a headless browser
maps/     the map library — the DM picks from these in-app during play
```

## Testing

```sh
cd server && cargo test
cd client && npm run check   # typecheck + build
```

### Driving the real client

`tools/drive-ui.mjs` and `tools/drive-player.mjs` open the actual client in headless Chrome and
click through it, asserting on the DOM and — where only pixels can tell the difference — on the
canvas itself. They speak the DevTools protocol directly, so there is nothing to install beyond
the browser already on the machine.

They need a server running with a **known** DM secret, and they change the room they connect to:

```sh
cd server
SLATE_DM_SECRET=test-secret SLATE_STATE=scratch.json cargo run

# elsewhere
node tools/drive-ui.mjs      http://127.0.0.1:3000 test-secret
node tools/drive-player.mjs  http://127.0.0.1:3000
```

Point them at a scratch `SLATE_STATE`, never at the room you are about to play in — the first
thing `drive-ui.mjs` does is erase every wall on the board. Set `SLATE_BROWSER` if Chrome or Edge
is somewhere unusual.

## Hosting a remote session from Windows

Slate can run from a Windows PC only while the group is playing. The included
PowerShell scripts build the production client and server, keep runtime data
under `%LOCALAPPDATA%\Slate`, and start the server on the loopback interface.
A separate Cloudflare Tunnel terminal exposes it without opening an inbound
firewall port.

See [deploy/windows/README.md](deploy/windows/README.md) for the build, local
run, Quick Tunnel rehearsal, backup, and troubleshooting procedures.

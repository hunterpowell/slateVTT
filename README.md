# Slate

A minimal virtual tabletop for a private, remote D&D game: a handful of players plus a DM. It
replaces Foundry for one group that only needs a shared map, tokens, and turn order.

- Pan/zoom map with DM-controlled upload and grid calibration, or a pick from a map library
- A second map slot the DM prepares out of sight of the table, then promotes
- Tokens the DM can move freely and players can move only their own, with uploaded or
  library art, a size in grid units, and an owner the DM can reassign
- Monsters the DM can keep hidden, with hit points only they can see, and positions
  planned on the map the table hasn't been shown yet
- An initiative tracker with round counter, next/previous turn, portraits, and (for the
  DM) a hit point bar on each row
- A movement ruler that tints the squares a drag crossed, counting diagonals whichever
  way the DM sets the room to
- Measuring and spell-area drawing that anyone at the table can use
- A ping: hold the mouse button and a ring appears on everyone's board, with an arrow at
  the edge of the screen for anyone looking somewhere else
- Walls and doors the DM traces over the map, which block line of sight but never movement
- Fog of war: the table sees what their own tokens can see and remembers where they have
  been, with a DM override to reveal or black out a room by hand
- Two ways for a map to be lit: line of sight from each token, or the whole room a token is
  standing in, where an open door lets the light through and a shut one seals it
- Whisper and shout: a player says something to the table or privately to the DM, the DM whispers
  any one player, and nobody messages anybody else. Messages last for the evening and are never
  written to disk
- A scratchpad each: one box of text, kept with the room, that no other screen is ever sent. The
  DM's is no different from anybody's
- A loaner die: seven dice in the chat panel, thrown by the server, for whoever came without theirs
- A backdrop: a picture the DM shows everyone in place of the board, for stretches of the evening
  with nothing to move, which leaves the board untouched underneath
- One looping music track the DM picks, at a volume each person sets for themselves
- Coloured markers on a token, and an X for a dead one, that everyone can see
- Square or isometric grids, and tokens that carry a light of their own
- Who's connected, a prompt when it's your turn, a colour each player picks, and everyone's pointer
  on everyone's board
- Undo for the DM, ten changes deep, and a player view that redraws the DM's board as the table
  sees it
- Several rooms on one server, each with its own board and cast, so a one-shot doesn't disturb
  the campaign
- State is saved to a JSON file on disk and restored on restart

See [CLAUDE.md](.claude/CLAUDE.md) for the architecture, invariants, and non-goals, and [docs/](docs/)
for why each feature works the way it does. There are no character sheets or accounts: the group
brings physical dice and uses Discord for the rest. The dice above are a loaner for the night
somebody forgets theirs, and they do what a bag of plastic does: counts, but no modifiers, no
expressions, no macros. Messaging stops at two destinations, with no player-to-player messages and
no history between sessions.

## Stack

- **Server:** Rust, `axum` + `tokio`, JSON snapshot persistence (no database)
- **Client:** vanilla TypeScript, canvas 2D, bundled with `esbuild` (no framework)

## Prerequisites

- Rust (2024 edition, so `rustc` 1.85+) and Cargo
- Node.js, for `esbuild` and `tsc` at dev time only. Nothing from `npm` ships to the browser
  except the bundled output.

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

Open that link as the DM. Give players the plain link (`http://127.0.0.1:3000/`). They pick a room
(skipped when the server has only one), then claim a name from that room's roster on their first
visit. The claimed identity is remembered in `localStorage`, so a refresh doesn't orphan a token.

## Configuration

The server is configured entirely through environment variables, and all of them have working
defaults for local use:

| Variable          | Default          | Purpose                                       |
| ----------------- | ---------------- | ---------------------------------------------- |
| `SLATE_ADDR`       | `127.0.0.1:3000` | Address to bind                               |
| `SLATE_SITE`       | `home`           | Which rooms this process serves. A second site is a second process with its own secret and data, for a DM who mustn't reach the first site's rooms. A name with no rooms stops the server booting |
| `SLATE_CLIENT_DIR` | `../client`      | Static files served for everything but `/ws` and `/api/*` |
| `SLATE_DM_SECRET`  | random per boot  | Set this to keep the DM link stable across restarts |
| `SLATE_STATE`      | `slate-state.json` | Path to the first room's saved snapshot. Every other room's save sits beside it as `<room id>.json` |
| `SLATE_UPLOADS`    | `uploads`        | Directory for DM uploads and for everything picked from a library |
| `SLATE_MAPS`       | `../maps`        | Map library the DM picks from. Never served directly: a pick is copied into `SLATE_UPLOADS` |
| `SLATE_PORTRAITS`  | `../portraits`   | Token-art library, handled the same way. Only the DM can list or pick from it |
| `SLATE_BACKDROPS`  | `../backdrops`   | Backdrop library, handled the same way |
| `SLATE_TRACKS`     | `../tracks`      | Music library, handled the same way |
| `SLATE_STATUS_KEY` | unset            | Enables `/api/status` and the `/status/` page. **If unset, the route isn't mounted at all.** See [client/status/README.md](client/status/README.md) |
| `SLATE_HOST_STATUS` | unset           | A JSON file some *other* process writes with the host's vitals, passed through unchanged by `/api/status` |
| `SLATE_BUILD_INFO` | unset            | A JSON file the deploy writes naming the running build, read once at boot |

The rooms are the `ROOMS` constant in [server/src/room.rs](server/src/room.rs), not runtime config;
edit them there for a different group. Each names the site that serves it. The home site has two:
the campaign and a Halloween one-shot. A second site has one room of its own.

The DM edits each room's roster (its players) on the table tab, and it's saved with the room. The
casts in `ROOMS` only seed a room that has never saved one. Each roster slot has a short id beside
its name, made from the name when the player is added. The id is what `localStorage` remembers and
what a token's owner is recorded as, so renaming a character changes only the name, and their tokens
follow them.

## Project layout

```
client/   TypeScript source, canvas rendering, esbuild config
  spells/ the spell index at /spells/, a static page outside the bundle (its own README)
  status/ the host status page at /status/, and the Kindle renderer (their own READMEs)
server/   axum server: room actor, wire protocol, JSON persistence
docs/     one file per subsystem, explaining why it works the way it does
deploy/   hosting from Windows (windows/) and from a Raspberry Pi (pi/)
tools/    check.mjs: every check that doesn't need a browser, in one command
          gen-assets.mjs: placeholder map/token/backdrop art and one track, for local dev
          audit-uploads.mjs: what is in uploads/ and what the room still points at
          cdp.mjs, board.mjs, drive-*.mjs: drive the real client in a headless browser
          *-spells.mjs: build, import and validate the spell index's data
maps/     the map library, which the DM picks from during play
portraits/ the token-art library, the same idea for faces
backdrops/ pictures shown *instead of* the board, for parts of an evening with nothing to move
tracks/   the music library: one looping track at a time
```

## Testing

```sh
node tools/check.mjs         # all of the below, reporting every failure

cd server && cargo test
cd server && cargo fmt -- --check
cd server && cargo clippy --all-targets -- -D warnings
cd client && npm run check   # typecheck + unit tests + build
cd client && npm test        # just the unit tests
```

`tools/check.mjs` runs the first four in sequence and doesn't stop at the first failure, so a
formatting diff can't hide a failing test. It leaves out the browser drivers, which need Chrome, a
running server and a scratch state file; they're described below and are run separately. There is
no CI: these run when somebody runs them.

The server's tests live in [server/src/room/tests/](server/src/room/tests/), one file per
subsystem, split the same way as [docs/](docs/). They are child modules of the room rather than a
separate integration test, because they drive `RoomState` through its private API. That's the only
way to assert what a client was *not* sent, which is most of what matters in a room that filters
every message per recipient.

The client's tests cover its pure logic, one `src/*.test.ts` per module: among them the coordinate
spaces and the isometric grid, the two distance rules and the trail, the wall-crossing test, shape
coverage, the DM's flood fill, what player view strips out, the damage box's grammar, and the
client's half of the protocol drift check against `protocol-tags.json`. They run under Node's own
test runner against an esbuild bundle, because the client imports its own modules as `./coords.js`
and Node won't resolve that to a `.ts` file. Anything needing a canvas or a socket is left to the
browser drivers below.

Two more sets of tests sit outside `check.mjs`. `python3 client/status/kindle/kindle_test.py` covers
the Kindle renderer, which draws the status page as a PNG for a jailbroken Kindle. It needs Pillow,
so it's run separately. See [client/status/kindle/README.md](client/status/kindle/README.md). The
spell index has `node --test client/spells/query.test.mjs` and `node tools/check-spells.mjs`; see
[client/spells/README.md](client/spells/README.md).

### Driving the real client

The `tools/drive-*.mjs` scripts open the actual client in headless Chrome and click through it,
asserting on the DOM and, where only pixels can tell the difference, on the canvas itself. They
speak the DevTools protocol directly, so there's nothing to install beyond the browser already on
the machine. Two files sit under them: [tools/cdp.mjs](tools/cdp.mjs) is the protocol and knows
nothing about Slate, and [tools/board.mjs](tools/board.mjs) knows where the grid is on screen and
which token is standing on a given square.

| Driver             | What it drives                                                    | Browsers |
| ------------------ | ----------------------------------------------------------------- | -------- |
| `drive-ui.mjs`     | The wall and door editor, as the DM                               | DM       |
| `drive-player.mjs` | A player's connection: that the DM's controls are *absent*, not hidden | player   |
| `drive-rail.mjs`   | The left rail's tab strip, and the layout failures it fixed        | DM       |
| `drive-fog.mjs`    | Fog of war, room lighting, and what a player's client never fetched | both     |
| `drive-names.mjs`  | The names-under-tokens switch, on both boards at once              | both     |
| `drive-ruler.mjs`  | The movement trail, the diagonal switch, the initiative panel      | both     |
| `drive-ping.mjs`   | The hold that pings, and the ring reaching an unexplored corner    | both     |
| `drive-select.mjs` | Shift-click and box selection, the group drag that moves them together, and Delete removing them | both     |
| `drive-staged.mjs` | Tracing and painting the next dungeon, and the table not being told | both     |
| `drive-undo.mjs`   | The DM's undo reaching the table, and not rebuilding their page    | both     |
| `drive-panels.mjs` | The initiative panel folding, `n` advancing the turn, the damage box, token markers, and the sight check no longer being offered | both     |
| `drive-chat.mjs`   | Whisper and shout, and the loaner die, each absent from a *third* person's page | three    |
| `drive-notes.mjs`  | The scratchpad: one person in two tabs, and the DM holding none of it | three    |
| `drive-presence.mjs` | Who is connected, the colour a player picks, and being told it's your turn | three    |
| `drive-cursors.mjs` | Everybody's pointer, and the DM's *not* reaching the table over unexplored ground | both     |
| `drive-backdrop.mjs` | A picture in front of the table, and the board being unchanged when it comes down | both     |
| `drive-library.mjs` | Adding an image to a library and removing it again; the one driver that tests the disk | DM       |
| `drive-rooms.mjs`  | Two rooms on one server: the picker, and one board's tokens being absent from the other | both     |
| `drive-roster.mjs` | The DM adding, renaming and removing a player, seen on that player's screen; on a one-room site, no room picker | both     |
| `drive-status.mjs` | The status page: its three states, that it fits an 800×480 panel, and that a join shows up on it | both     |
| `drive-mirror.mjs` | Player view: the DM's own board redrawn as the table's, and switched off again | DM       |
| `drive-isometric.mjs` | Calibrating a map to diamonds, and the table getting the same grid | both     |
| `drive-fit.mjs`    | The fit-board control and the Home key, on two different cameras | both     |
| `drive-sound.mjs`  | The room's music: the player's `<audio>` pointed at the DM's pick, and an undo not restarting it | both     |

The ones marked *both* open two browsers at once, because almost everything they assert is a
**difference** between what two people are holding, and one client can't see a difference.
`drive-mirror.mjs` couldn't use a second browser if it wanted one: it tests a difference between
two boards on the *same* screen. `drive-chat.mjs` opens three, because it has to show what one
*player* is not sent about another, a line drawn between two players rather than between the DM and
the table. `drive-presence.mjs` opens three for a related reason: it's about the other connections,
so a colour has to reach somebody who didn't pick it, and with two browsers the picker and the
observer would be the same window.

`drive-cursors.mjs` and `drive-ping.mjs` are worth reading together, because they assert
**opposite** outcomes about the same kind of square. A ping over ground the party has never
explored is relayed, and a pointer over it isn't. A ping is a gesture somebody chose to make; a
cursor is just where the DM's hand is while they work on the ambush.

**Reconnecting has no driver.** The only way to test it is to stop the server and start it again,
which a suite running against one long-lived room shouldn't do. So it's checked by hand: kill the
server, watch the banner become "connection lost — reconnecting…", bring it back, and watch the page
reload itself.

The drivers need a server running with a **known** DM secret, and they change the room they
connect to. Each takes an optional base URL, and the DM-side ones an optional secret after it. The
defaults are exactly what's written below:

```sh
cd server
SLATE_DM_SECRET=test-secret SLATE_STATUS_KEY=test-status SLATE_STATE=scratch.json cargo run

# elsewhere; the arguments below are the defaults, so bare `node tools/…` does the same
node tools/drive-ui.mjs     http://127.0.0.1:3000 test-secret
node tools/drive-player.mjs http://127.0.0.1:3000
```

`SLATE_STATUS_KEY` is there only for `drive-status.mjs`. Without it `/api/status` isn't mounted and
that driver fails on a 404, which means the feature is working, not that the driver is broken.
Every other driver ignores it. It does *not* also need `SLATE_HOST_STATUS` or `SLATE_BUILD_INFO`:
those name files written outside this repo, so their sections can legitimately be empty, and the
driver asserts whichever state it finds.

**Every driver appends `?room=campaign` to the URL it opens**, because a page that names no room
shows the room picker, with no board behind it to click. That's all multiple rooms changed for the
drivers: the room is in the URL rather than in any message, so nothing else about them changed.
`drive-rooms.mjs` is the exception, since the picker is what it tests.

Point them at a scratch `SLATE_STATE`, never at the room you're about to play in. The first thing
`drive-ui.mjs` does is erase every wall on the board, `drive-staged.mjs` throws away whatever was in
the staged slot, and the fog, names, ruler, ping and cursor drivers each build a token or flip a
switch that persists. **A scratch `SLATE_STATE` covers every room**: the first room's save is that
path and the others are saved beside it, so one scratch directory holds them all.

**`drive-library.mjs` also writes outside the room.** It adds a file to `portraits/` and one to
`backdrops/` and then removes both, so it needs a scratch `SLATE_STATE` *and* a checkout you don't
mind it touching. A run that dies partway leaves a `slate-driver-probe.png` behind, which is safe to
delete by hand. Those folders are in git, so `git status` shows whether a run put them back, and
`git checkout -- portraits/ backdrops/` restores them if it didn't.

Run the drivers one at a time. They share debug ports (9333 for the DM, 9334 for a player, 9335 for
a second player), so two at once attach to each other's browser. Set `SLATE_BROWSER` if Chrome or
Edge is installed somewhere unusual.

**Use a scratch path with no file on it, not a copy of a real room.** The drivers are written
against the room a first boot builds (eight tokens on `/assets/map.png`, an empty initiative order,
nothing traced and nothing staged), and several of them assert against that directly, so a copy of
a room that has been played in fails checks that have nothing to do with what they test. Deleting
the scratch file resets them, but the room lives in memory and is only read at boot, so you also
have to **restart the server**.

Since milestone 31 that matters more: a map now remembers the walls and fog paint it was last left
with, so a driver that traces something and then loads another map finds its own tracing waiting
the next time it picks the same map. That's why `drive-staged.mjs` clears both slots' walls before
it asserts they're untraced. A driver that wants a blank board has to make one rather than assume
it.

**The drivers can be run in any order**, which is worth saying because for a while they couldn't.
`drive-staged.mjs` ends by promoting a different map onto the board, on purpose, and four other
drivers used to build a token and then click the middle of the canvas to select it. A new token only
lands there if the middle was free and the zoom was the one they were written at. The symptom was
five failures in `drive-ruler` that looked exactly like a regression in whatever had just changed.

That logic lives in [tools/board.mjs](tools/board.mjs) now: it measures the grid from the HUD, finds
a token by searching outward from the middle of the view, and converts a cell to either client's
screen coordinates. Anything that clicks the board should go through it rather than hard-coding
pixels. **A driver may not assume the map it was written against.**

### Running the lot

**The twenty-one drivers in the loop below take about seven and a half minutes**, so run all of them
whenever the client changes rather than picking the ones that look relevant. Picking isn't worth the
thought: they all sit on `coords.ts`, `render.ts`, `input.ts` and `scene.ts`, and almost every client
commit touches one of those, so any rule about which to skip says "none of them" nearly every time.
`drive-library.mjs` is the one left out, because it writes to the library folders.

| player | names | ui  | chat | undo | isometric | sound | rail | backdrop | notes | presence |
| ------ | ----- | --- | ---- | ---- | --------- | ----- | ---- | -------- | ----- | -------- |
| 3s     | 6s    | 9s  | 10s  | 11s  | 11s       | 13s   | 15s  | 15s      | 17s   | 17s      |

| mirror | status | fit | rooms | ruler | staged | fog | select | ping | panels | cursors |
| ------ | ------ | --- | ----- | ----- | ------ | --- | ------ | ---- | ------ | ------- |
| 18s    | 18s    | 22s | 24s   | 25s   | 26s    | 27s | 31s    | 40s  | 46s    | 57s     |

`drive-cursors.mjs` and `drive-ping.mjs` are slow for the same reason: most of their time is spent
waiting for something to expire, which is the behaviour they test.

The per-run cost isn't the drivers, it's the room: a fresh one means restarting the server, so run
the suite against **one** server rather than restarting between drivers. Run them sequentially,
because of the shared debug ports:

```sh
cd server
rm -f scratch.json      # the room is only read at boot, so this is what resets it
SLATE_DM_SECRET=test-secret SLATE_STATUS_KEY=test-status SLATE_STATE=scratch.json cargo run &
until curl -sf http://127.0.0.1:3000/ >/dev/null; do sleep 1; done

cd ..
for d in player names ui rail undo panels chat notes presence backdrop staged fog ruler select ping cursors rooms mirror isometric fit sound status; do node tools/drive-$d.mjs; done
```

That whole block takes about seven and a half minutes on the machine it was written on. The cheap
drivers go first, so a broken client fails `drive-player.mjs` a few seconds in rather than two
minutes in. The order is only a convenience; nothing depends on it.

Each browser a driver opens gets a throwaway profile in the temp folder, and `cdp.mjs` deletes it
along with the browser, including when the driver throws or is stopped with Ctrl+C. The first
`open()` of a run also deletes any profile more than half an hour old, which catches the ones a
killed process left behind.

A driver that stops partway still leaves whatever tokens it hadn't tidied away, and one whose node
process is killed outright (by a timeout or Task Manager) also leaves its Chrome holding the debug
port, which the next `open()` attaches to and hangs on. `taskkill //F //IM chrome.exe` and a fresh
scratch file fix both. **Never pipe a driver through `head`**: it dies on the broken pipe partway
through and leaves tokens behind.

## What is in `uploads/`

Every file in `uploads/` is a copy of a library file. Uploading from a panel adds the file to the
library and then picks it, and a pick copies it here under a name fingerprinted by content, so
picking the same file twice lands on one copy (see [docs/maps.md](docs/maps.md)). Nothing ever
deletes a copy, including when the DM removes the original from the library, so the directory only
grows by one copy per distinct file ever picked. A map is capped at 25 MB, and on an always-on Pi
the directory is in every backup.

```sh
node tools/audit-uploads.mjs [state.json] [uploads/]
```

It reads every room's save file and the directory and sorts the files three ways: **in use** by a
live board, a staged one, a backdrop or a token; **remembered**, meaning nothing shows it but the DM has
calibrated it, so loading it again keeps its grid; and **unreferenced**, which nothing in any room
points at. A music track's copy always shows as unreferenced, because the room's music isn't saved;
don't remove one the room is playing.

**It deletes nothing.** It prints the `rm` lines and the DM runs the ones they want, with the server
stopped. A cleanup job inside the room was considered and not built: the room would have to know
about the filesystem, and the one case it can't judge (art referenced only by a calibration the DM
may still want) is exactly the case that deserves a human look. Check the list before acting on it;
a file uploaded since the last save shows as unreferenced only because the room hasn't been saved
yet.

## Hosting a remote session from Windows

Slate can run from a Windows PC only while the group is playing. The included PowerShell scripts
build the production client and server, keep runtime data under `%LOCALAPPDATA%\Slate`, and start
the server on the loopback interface. A Cloudflare Tunnel running in a separate terminal exposes it
without opening an inbound firewall port.

See [deploy/windows/README.md](deploy/windows/README.md) for the build, local run, Quick Tunnel
rehearsal, backup, and troubleshooting procedures.

## Hosting always-on from a Raspberry Pi

The other host works differently: it stays up between sessions so the DM can prepare the next map
without anyone else being involved. The Pi builds nothing. A Windows machine cross-compiles the
server and bundles the client, and the Pi runs them under `systemd`.

See [deploy/pi/README.md](deploy/pi/README.md) for the SD card, the layout, the service account, the
cross-compile, the deploy, and what each failure we hit looked like.

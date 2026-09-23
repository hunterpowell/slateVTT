# The status page

A static page at `/status/`, and one endpoint at `/api/status` behind a key of its own.

**It isn't part of Slate**, in the same sense `client/spells/` isn't: it imports nothing from
`../src/`, has no entry in esbuild's build, and touches no room state. It's served by the same
`ServeDir` fallback in `server/src/main.rs` that serves the client, and unlike the spell index,
nothing on the board links to it. Nobody at the table wants a link to the server's temperature
mid-combat. The only connection is one route and one `RoomCmd` variant.

**It is read-only and must stay that way.** A restart button, a room reset or a "save now" would
each need the DM secret and a much better reason than convenience. The page is safe to leave open on
a second screen, or pinned to a wall, because there's nothing on it to press.

## Why it exists

Slate is always on, on a Pi 3B in the room, behind a Cloudflare Tunnel. Before this page, finding out
whether the box was alive, whether anyone was connected, whether a deploy had landed, or whether the
SD card was full meant `ssh` and `journalctl`. The only liveness check in the project was
`deploy/pi/install.sh` curling `/` during a deploy, and it stopped checking the moment the deploy
finished.

## Two readers, one endpoint

The page is shown in a window on the Windows machine, and as a PNG on a jailbroken Kindle in the
room. **These are two renderers of one JSON document, not two pages**: `status.js` in a browser, and
`kindle/kindle.py` drawing the same layout with Pillow. The Kindle's needs shaped the page:

- **The Kindle is a frame viewer.** It runs the TRMNL client, which asks a URL for JSON naming an
  image, shows the image, and puts the whole device to sleep until the next fetch. So JSON at a
  guarded URL is the format, and this page is a *client* of the same endpoint rather than something
  the Kindle scrapes. See `kindle/README.md` for the contract, and for the three ways of getting the
  page onto that screen that were tried before drawing it.
- **A Kindle browser can't set a request header.** So the key is also accepted as `?key=`. That's no
  weaker than what already existed: the DM link has carried its secret in a query string since the
  first commit, and this key unlocks only a single read-only document. The Kindle's browser was used
  for a day and then retired, but the query form stays: it costs nothing, and it's how a window is
  opened.
- **Both displays are 1-bit or greyscale.** Hence black on white, no colour, no shadows, and
  inversion as the only alarm. The layout fits **800×480** without scrolling, because a panel can't
  scroll, and content below the fold on one might as well not exist.

`tools/drive-status.mjs` asserts the 800×480 fit, which only a browser can check.

**The server decides what's wrong.** Every threshold (a save failing, a room not answering, a host
reading older than five minutes, a hot CPU, a full disk, a restart) is decided in `verdict` in
`server/src/main.rs` and sent as `alarms` plus a flag for each cell that should invert. Neither
renderer judges anything; both just draw. Two renderers each with its own threshold would be two
thresholds, and the day one was tuned the other would be wrong. `UNREACHABLE` is the one verdict the
reader makes, because it means the reader couldn't fetch the verdict.

## The sections, and where each comes from

| Section | Comes from |
|---|---|
| `rooms` | Each room actor, asked over its own `mpsc`: who is here, sockets, tokens, and how its saves are going |
| `server` | The process: version, uptime, when it started |
| `host` | A file **something else on the box wrote** |
| `build` | A file **the deploy wrote** |

**Slate reports only what Slate knows.** The server doesn't read `/sys/class/thermal`: that's
Linux-only, it would make the status handler untestable on the dev machine, and a game server that
grows a hardware monitor has stopped being just a game server. `SLATE_HOST_STATUS` and
`SLATE_BUILD_INFO` name files that are read and passed through unchanged. On Windows both are unset
and both sections read `null`, which is accurate rather than made up.

`deploy/pi/slate-host-status.sh` writes the first one, on a systemd timer, installed once by hand like
`slate.service` itself. It writes to a temp file and renames it, because the server can read at any
moment.

## What must not break

**A stuck room must not hang the page.** `/api/status` asks every room over the same `mpsc` a socket
would use. That's intentional: a status answered separately would be describing a room it couldn't
see, and a full mailbox is the real measure of a stuck actor. It means the answer has to be bounded:
`STATUS_TIMEOUT` is 2 seconds, and a room that misses it gets a row saying `"responding": false`
rather than stalling the response. **The moment the page most needs to answer is the moment a naive
implementation would hang.** `RoomHandle::status` returns `Option` for this reason, and its doc
comment says the caller must bound it.

**A room that didn't answer still gets a row.** The missing answer is the news; dropping the row
would leave a page that looks complete.

**A failing save is a different fact from a pending one, which is why there are two fields.**
`save_at` is the whole of the dirty flag, and it's `Some` both while a change waits out the
two-second debounce *and* while a write is failing and retrying. From the deadline alone, a dying SD
card looks the same as a healthy write two seconds old. `saves_failing` is what separates them, and
`last_saved_unix` says how much is at risk once it's set. Apart from an `error!` in the journal, the
retry loop is otherwise silent, and a failing save is the failure most likely to cost the group an
evening and the one nobody is watching for.

The flag **stays set until a write succeeds**, not for one attempt. Something has to outlast a single
pass of the retry loop, or the page would only catch the failure if it happened to poll inside the
right two-second window. A successful write clears it again, so one transient error doesn't mark a
room broken forever. There's a test for each half.

**The whole payload is judged before any card is drawn.** `verdict` is one function over the rooms
and the host together, and the alarm strip is drawn from its `alarms`. If a card were judged after
the strip was drawn, a number on screen could invert with nothing anywhere saying why. That's how
the restart count first shipped, when the judging was still in `status.js`: the row went black and
the bar still read `OK`.

**Two of the host fields are about things Slate can't see.** `restarts` is systemd's `NRestarts` for
the unit, and it matters because `Restart=always` hides a crash: the service is back in five seconds
and the only trace is in the journal. systemd resets the count on an *explicit* restart, so a deploy
zeroes it, which is the useful meaning: any number there means the service fell over on its own since
you last touched it. It's drawn on the **Server** card rather than the Host one, because next to
`Uptime` it's what tells "it crashed" apart from "you deployed". `uploads_mb` is the other. Picking a
map copies it into `uploads/`, and removing it from the library leaves the copy behind, so that
directory only grows; the number tells you when to run `tools/audit-uploads.mjs`.

**The `Read` row only appears once the host reading is more than 90 seconds old.** A fresh reading is
the normal case, and on a panel with no spare lines, a row that always says "20s old" is the one to
drop. It's the same rule as `last_saved_unix`: show the age when it starts to mean something, not
before.

**Inversion is reserved for what is actually wrong.** `pending` is drawn as plain text, because a
change inside the debounce is what a healthy room in use looks like most of the time; only `FAILING`
inverts. An alarm that fires on the ordinary case is one you learn to ignore, and a status page that
gets ignored has failed.

**Between polls, only the age text changes, and only when its value changes.** On e-ink every
rewrite is a repaint. The page once rebuilt itself every second to keep "updated 4s ago" counting,
which flickered the whole panel sixty times a minute for a counter in one corner. `tick` now updates
a single text node, and `duration` is coarse past a minute, so at `?every=60` the screen changes once
a minute plus the poll. `drive-status.mjs` tags the grid and checks the tag survives the ticker while
the counter moves.

**No key, no endpoint.** `/api/status` is mounted only when `SLATE_STATUS_KEY` is set, so an
unconfigured server answers 404 rather than 403. An endpoint that says "wrong credential" has
announced that it exists. It also keeps `/api/rooms` the only route under `/api` reachable without a
credential, which `main.rs` says is intentional.

**The status key is not the DM secret.** A display pinned to a wall holds this key and nothing else;
if it opened the library routes it would be the DM secret by another name. Both directions are
tested.

**`here` is `RoomState::here`, not a copy of it.** The status page and the presence strip must never
disagree about who is connected, so the room's existing answer is called rather than reimplemented.
`sockets` is the one thing `here` can't say: it counts tabs where `here` counts people, and it
includes connections still on the identity picker.

**Everything that ages is measured against the server's clock**, reconstructed as
`started_unix + uptime_s`. A laptop with a wrong clock can't make the Pi look stale.

**The host reading is timestamped, and that timestamp is essential.** A timer that has died leaves a
file that still parses and still looks like data. Its age is the only way to notice, so a reading
older than five minutes is an alarm. That's four missed runs of headroom, because a status page that
raises false alarms gets ignored.

**Both passed-through files are parsed leniently about one thing: a leading UTF-8 BOM.** Windows
PowerShell 5.1's `Set-Content -Encoding utf8` writes one and calls it utf8, `serde_json` refuses a
byte order mark before `{`, and the result was a stamp that read as valid JSON in every editor and
showed on the page as "No build stamp". The writer now asks for `UTF8Encoding($false)` explicitly,
*and* `parse_foreign_json` strips the mark. Both, because a file this server only passes through is
not the place to be strict about three bytes every editor hides, and the next such file will be
written by some other tool on some other machine.

**The build stamp rolls back with the binary it names.** `install.sh` swaps it in with the rest and
puts it back on a rollback. A stamp left pointing at the commit that failed would have this page
state, confidently, that a rolled-back deploy had landed, which is the exact question the page exists
to answer.

## Running it

```
cd server
SLATE_DM_SECRET=test-secret SLATE_STATUS_KEY=test-status SLATE_STATE=scratch.json cargo run
```

then open `http://127.0.0.1:3000/status/?key=test-status`. As a window rather than a tab:

```
chrome.exe --app="http://127.0.0.1:3000/status/?key=test-status"
```

`?every=<seconds>` sets the poll interval, default 15. A full repaint flashes an e-ink panel, so a
wall display wants `?every=60`.

## Files

| File | |
|---|---|
| `index.html` | Markup and styling. Black on white, three cards across at 800px |
| `status.js` | Polling and rendering. **ES5 and `XMLHttpRequest` on purpose**: the eventual reader is an old browser, and none of this is worth a build step |
| `kindle/` | The other renderer: the same page as a PNG for the Kindle, with its own README |

Server side: `status`, `status_allowed`, `room_status_json`, `host_json` and `verdict` in
`server/src/main.rs`; `RoomCmd::Status`, `RoomHandle::status`, `RoomStatus` and `RoomState::status`
in `server/src/room.rs`. Tests are in `server/src/room/tests/status.rs` and in `main.rs`'s own
`mod tests`. The thresholds are tested there, once, because that's where they live.

**This folder isn't part of the bundle and has to be deployed separately.** esbuild never touches it,
so a deploy that copies only `dist/` leaves a 404 behind a page that worked on the build machine.
Both `Deploy-Slate.ps1` and `install.sh` name it explicitly, and `install.sh`'s health check curls
`/status/` for the same reason it curls `/spells/`. See `deploy/pi/README.md`.

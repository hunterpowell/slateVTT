# The status page

A static page at `/status/`, and one endpoint at `/api/status` behind a key of its own.

**Not part of Slate**, in the same sense `client/spells/` is not: it imports nothing from
`../src/`, has no entry in esbuild's build, and touches no room state. It is served by the same
`ServeDir` fallback in `server/src/main.rs` that serves the client, and unlike the spell index it
does not even have an anchor pointing at it from the board — nobody at the table wants a link to
the server's temperature mid-combat. The coupling is one route and one `RoomCmd` variant.

**It is read-only and must stay that way.** A restart button, a room reset, a "flush now" — each
would need the DM secret and a much harder argument than "it would be convenient". What makes this
page safe to leave open on a second screen, or pinned to a wall, is that there is nothing on it to
press.

## Why it exists

Slate is always on, on a Pi 3B in the room, behind a Cloudflare Tunnel. Before this, the answer to
*is the box alive, is anyone connected, did my deploy actually land, is the SD card full* was `ssh`
and `journalctl`. The only liveness probe in the project was `deploy/pi/install.sh` curling `/`
during a deploy, and it stopped caring the moment the deploy finished.

## Two readers, one endpoint

It is a window on the Windows machine, and a PNG on a jailbroken Kindle in the room. **Two
renderers of one JSON, not two pages** — `status.js` in a browser and `kindle/kindle.py` drawing
the same layout with Pillow — and the second is what shaped the first:

- **The Kindle is a frame viewer.** It runs the TRMNL client, which asks a URL for JSON naming an
  image, shows the image, and sleeps the whole device until the next fetch. So JSON at a guarded
  URL is the format, and this page is a *client* of the same endpoint rather than the thing the
  Kindle scrapes. See `kindle/README.md` for the contract and for the three ways of getting the
  page onto that screen that were tried before drawing it.
- **A Kindle browser cannot set a request header.** So the key is accepted as `?key=` as well. That
  is not a weakening invented here — the DM link has carried its secret in a query string since the
  first commit — and what this one unlocks is a single read-only document. The Kindle's browser
  was run for a day and retired, but the query form stays: it costs nothing and it is how a window
  is opened.
- **Both are 1-bit or greyscale.** Hence black on white, no colour, no shadows, and inversion as the
  only alarm. The layout is built to fit **800×480** without scrolling, because a panel cannot
  scroll and content past the fold on one is content that does not exist.

`tools/drive-status.mjs` asserts the 800×480 fit, which is the sort of thing only a browser can see.

**The verdict is the server's.** Every threshold — a save failing, a room not answering, a host
reading older than five minutes, a hot CPU, a full disk, a restart — is decided in `verdict` in
`server/src/main.rs` and shipped as `alarms` plus a flag per cell that inverts. Neither renderer
judges; both paint. Two readers of one page with a threshold in each is two thresholds, and the
day one is tuned the other is wrong. `UNREACHABLE` is the one verdict that stays with the reader,
because it is about failing to fetch the verdict.

## The three sections, and who knows what

| Section | Comes from |
|---|---|
| `rooms` | Each room actor, asked over its own `mpsc` — who is here, sockets, tokens, and how its writes to disk are going |
| `server` | The process — version, uptime, when it started |
| `host` | A file **something else on the box wrote** |
| `build` | A file **the deploy wrote** |

**Slate reports only what Slate knows.** The server never learns what `/sys/class/thermal` is: that
is Linux-only, it would make the status handler untestable on the dev machine, and a game server
that grows a hardware monitor has stopped being a game server. `SLATE_HOST_STATUS` and
`SLATE_BUILD_INFO` name files that are read and re-emitted verbatim. On Windows both are unset and
both sections read `null`, which is honest rather than fabricated.

`deploy/pi/slate-host-status.sh` is what writes the first one, on a systemd timer, installed once
like `slate.service` itself. It writes to a temp file and renames, because the server can read at
any moment.

## The parts that are load-bearing

**A wedged room must not hang the page.** `/api/status` asks every room over the same `mpsc` a
socket would use — deliberately, because a status answered off to one side would be describing a
room it could not see, and a full mailbox is the honest measure of a wedged actor. That means the
answer has to be bounded: `STATUS_TIMEOUT` is 2 seconds, and a room that misses it gets a row saying
`"responding": false` rather than stalling the response. **The moment the page most needs to answer
is the moment a naive implementation would hang.** `RoomHandle::status` returns `Option` for exactly
this, and its doc comment says the caller must bound it.

**A room that did not answer still gets a row.** The absence is the news; dropping it would leave a
page that looks complete.

**A failing save is a different fact from a pending one, and that is why there are two fields.**
`save_at` is the whole of the dirty flag, and it is `Some` both while a change waits out the
two-second debounce *and* while a write is failing and retrying — so on the deadline alone a dying
card is indistinguishable from a healthy write two seconds old. `saves_failing` is what separates
them, and `last_saved_unix` is what says how much is at risk once it is set. The retry loop is
otherwise silent apart from an `error!` in the journal, which is the failure most likely to cost
the group an evening and the one nobody is watching for.

The flag is **set until a write succeeds**, not for one attempt: something has to outlive a single
pass of the retry loop, or the page would only catch the failure by being polled inside the wrong
two-second window. A good write puts it down again, so one transient error does not brand a room
broken forever — there is a test for each half.

**The whole payload is judged before any card is drawn.** `verdict` is one function over the
rooms and the host together, and the strip is rendered from its `alarms` — a card judged after the
strip was written inverts a number on the screen with nothing anywhere saying why. That is exactly
how the restart count first shipped, when the judging was still in `status.js`: the row went black
and the bar still read `OK`.

**Two of the fields on the host card are about things Slate cannot see.** `restarts` is systemd's
`NRestarts` for the unit, and it matters because `Restart=always` makes a crash invisible — the
service is back in five seconds and the only trace is in the journal. systemd resets it on an
*explicit* restart, so a deploy zeroes it, which is the semantic worth having: any number there
means the service fell over on its own since you last touched it. It is drawn on the **Server**
card rather than the Host one, because read next to `Uptime` it is what separates "it crashed"
from "you deployed". `uploads_mb` is the other: picking a map copies it into `uploads/` and
removing it from the library deliberately leaves the copy behind, so that directory only grows —
the number is what tells you when to run `tools/audit-uploads.mjs`.

**The `Read` row only appears once the reading is stale.** A fresh one is the ordinary case, and on
a panel with no spare lines a row that permanently says "20s old" is the one to give up. The same
judgement as `last_saved_unix`: show the age at the moment it becomes evidence, not before.

**Inversion is reserved for what is actually wrong.** `pending` renders as plain text, because a
change inside the debounce is what a healthy room in use looks like most of the time; only
`FAILING` inverts. An alarm that fires on the ordinary case is one you learn to ignore, which is
the only way a status page can fail.

**Between polls, only the age text moves — and only when it has changed.** On e-ink every
rewrite is a repaint. The page once rebuilt itself every second to keep "updated 4s ago" counting,
which ghosted the whole panel sixty times a minute for a counter in one corner. `tick` now writes a
text node and nothing else, and `duration` is coarse past a minute, so at `?every=60` the screen
changes once a minute plus the poll. `drive-status.mjs` tags the grid and checks it survives the
ticker while the counter moves.

**No key, no endpoint.** `/api/status` is mounted only when `SLATE_STATUS_KEY` is set, so an
unconfigured server answers 404 rather than 403 — an endpoint that says "wrong credential" has
announced that it exists. It also keeps `/api/rooms` the only route under `/api` reachable without a
credential, which `main.rs` says is deliberate.

**The status key is not the DM secret.** A display pinned to a wall holds this one and nothing else;
if it opened the library routes it would be the DM secret with extra steps. Both directions are
tested.

**`here` is `RoomState::here`, not a copy of it.** The status page and the presence strip must never
be able to disagree about who is connected, so the room's existing answer is called rather than
reimplemented. `sockets` is the one thing `here` cannot say — it counts tabs where `here` counts
people, and it includes connections still on the identity picker.

**Everything that ages is measured against the server's clock**, reconstructed as
`started_unix + uptime_s`. A laptop with a wrong clock cannot make the Pi look stale.

**The host reading is stamped, and that field is the point.** A timer that has died leaves a file
that still parses and still looks like data. Age is the only thing that can catch it, so a reading
older than five minutes is an alarm — four missed runs of headroom, because a status page that cries
wolf gets ignored, which is the only way one can fail.

**Both relayed files are parsed leniently about one thing: a leading UTF-8 BOM.** Windows
PowerShell 5.1's `Set-Content -Encoding utf8` writes one and calls it utf8, `serde_json` refuses
a byte order mark before `{`, and the result was a stamp that read as correct JSON in every editor
and arrived on the page as "No build stamp". The writer now asks for `UTF8Encoding($false)`
explicitly, *and* `parse_foreign_json` strips the mark — both, because a file this server merely
relays is not the place to be strict about three bytes every editor hides, and the next such file
will be written by some other tool on some other machine.

**The build stamp rolls back with the binary it names.** `install.sh` swaps it in with the rest and
puts it back on a rollback. A stamp left pointing at the commit that failed would have this page
state, confidently, that a rolled-back deploy had landed — which is the exact question it exists to
answer.

## Running it

```
cd server
SLATE_DM_SECRET=test-secret SLATE_STATUS_KEY=test-status SLATE_STATE=scratch.json cargo run
```

then `http://127.0.0.1:3000/status/?key=test-status`. As a window rather than a tab:

```
chrome.exe --app="http://127.0.0.1:3000/status/?key=test-status"
```

`?every=<seconds>` sets the poll interval, default 15. A full repaint flashes an e-ink panel, so a
wall display wants `?every=60`.

## Files

| File | |
|---|---|
| `index.html` | Markup and styling. Black on white, three cards across at 800px |
| `status.js` | Polling and rendering. **ES5 and `XMLHttpRequest` on purpose** — the eventual reader is an old browser, and none of this is worth a build step |

| `kindle/` | The other renderer: the same page as a PNG for the Kindle, and its own README |

Server side: `status`, `status_allowed`, `room_status_json`, `host_json` and `verdict` in
`server/src/main.rs`; `RoomCmd::Status`, `RoomHandle::status`, `RoomStatus` and `RoomState::status`
in `server/src/room.rs`. Tests in `server/src/room/tests/status.rs` and `main.rs`'s own `mod tests`
— the thresholds are tested there, once, because that is where they live.

**This folder is not part of the bundle and ships on its own line** — esbuild never touches it, so a
deploy that copies `dist/` alone leaves a 404 behind a page that worked on the build machine. It is
named in `Deploy-Slate.ps1` twice and in `install.sh` three times, and `install.sh`'s health check
now curls `/status/` for the same reason it curls `/spells/`. See `deploy/pi/README.md`.

# Rooms

More than one campaign on one server, and the screen that picks between them. Milestone 33.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`ROOMS`, `RoomDef`, `roster_from`, `RoomState::blank`, `room::spawn`, `save_path`, `room_listing`
or `ws_handler` on the server, or `rooms.ts`, `chooseRoom` in `main.ts`, the storage keys in
`identity.ts`, or the room in `connect`.**

## What asked for it

A Halloween one-shot, and not wanting to clear the campaign's board to run it — tokens deleted,
the map swapped, the traced walls and the explored fog gone, and all of it to be rebuilt
afterwards. That is the whole motivating case and it is worth keeping in view, because it decides
which half of the feature is load-bearing: **a second board, not a second cast.**

A second roster on one room was proposed first and is the smaller change, so it was considered
properly. It does not work. The roster is the cast list; swapping it leaves `tokens`, `map`,
`staged`, `initiative`, `walls`, `revealed`, `overrides` and `shapes` exactly where they were, and
those are the fields the one-shot would have had to clear. `ROADMAP.md` had guessed the other way
— *"the roster becoming per-room is the actual point"* — and that line is now wrong in this one
respect: the roster is what makes a second room *pleasant*, and a second board is what makes it
work at all.

## Not the scene system

`.claude/CLAUDE.md` refuses a scene system by name, and it is worth saying exactly why this is not
one, because on paper they are both "more than one map".

A scene shares the room with the other scenes. Switching between them mid-session is the point of
having them, so every `staged` flag becomes a scene id, token positions fork per scene, and
`snapshot_for` multiplies. **Rooms share nothing.** Two rooms have no field, no channel and no lock
in common — a room is a `tokio` task that exclusively owns its `RoomState`, and there are simply
two of them. Nothing switches during play: you pick a room on arrival, and the way to the other one
is a page reload.

That is also why there is no leak to test for between rooms. A visibility filter can be written
wrongly; a reference that does not exist cannot. `server/src/room/tests/rooms.rs` says so at the
top and tests the one thing that *can* go wrong instead — an identity from one room being accepted
by another.

## Fixed at boot, so there is no registry

`.claude/CLAUDE.md` had already designed this half:

> A second room would add a `RwLock<HashMap<RoomId, RoomHandle>>` touched on connect and disconnect
> only — never on a token move.

It came in cheaper than that. **`ROOMS` is a const**, so every room exists before the first socket
opens, and `AppState.rooms` is an `Arc<HashMap<String, RoomHandle>>` that is built once in `main`
and only ever read. A lock guards a table that changes; nothing changes this one.

The `RwLock` is what a room the DM could *create at runtime* would need. That is not built, is not
wanted, and would be the point at which this file's design changes rather than grows. Until then a
lock here would be a lock with nothing to protect.

Everything else the architecture promised held: a socket resolves its room once in `ws_handler` and
then talks to that actor's `mpsc` directly, exactly as it did when there was one handle on
`AppState`. Nothing on the hot path learned that rooms are plural.

Adding a campaign is an edit to `ROOMS` and a redeploy, which is deliberately the same act as
editing a roster. A config file was the alternative and was declined: it buys editing a room in on
the Pi without a cross-compile, and costs a schema, boot-time validation, and a failure mode where
a typo means no rooms at all.

## The id is the load-bearing field

A `RoomDef` has three fields and only one of them is dangerous. **The id names the save file, the
`localStorage` key a claimed slot is remembered under, and the `?room=` in a link** — so changing
one after a room has been played in orphans all three at once. `name` is free text and renaming a
campaign is safe at any point.

Two tests in `room/tests/rooms.rs` guard the id: it is a slug, because it is joined onto a
directory to make a path and put in a URL; and ids are unique, because `main.rs` builds a `HashMap`
off them and a duplicate would silently be one room fewer with the wrong roster on the other's save
file.

## The first entry is the primary room

Exactly two things hang off being first, and both are answers to the same question — *which room
did the single-room server become?*

- **Its save file is `SLATE_STATE` verbatim.** Every other room's is a sibling named `<id>.json`.
- **A missing save file boots it from `hardcoded`** rather than an empty board.

Neither generalises to a third room and neither should. `exactly_one_room_is_primary` exists so
that the pair cannot quietly become zero or two.

### Why the save path is a sibling rule and not a directory

`SLATE_STATE` naming a *directory* was the obvious design and is what `ROADMAP.md` proposed. The
sibling rule was chosen instead for one reason: **it needs no migration.** The Pi's env file is
unchanged, the live `/var/lib/slate/slate-state.json` goes on being the campaign, and the backup
script that greps the tar for that filename keeps passing. `store.rs` did not change at all —
`Store::new` already took a path.

The cost is that the rule is a sentence rather than a shape, which is why `save_path` carries it
and two tests in `main.rs` pin both halves. If there are ever enough rooms that a directory would
be tidier, that is a migration to do on purpose, not a thing to drift into.

### `blank`, and the map it keeps

`RoomState::blank` is `restored` with nothing to adopt, and it is a third constructor rather than a
flag on one of the other two because it answers a different question. `hardcoded` is what a **fresh
checkout** looks like, so that a new clone has something on the screen. `blank` is what a **new
room** looks like — and seeding a Halloween one-shot with six tokens called Cleodara and Saelyn is
worse than seeding it with nothing.

It keeps one thing `MapInfo::default` does not have: **the built-in map's URL.** A default `MapInfo`
has no URL at all, and a client handed one loads no image, never builds its stage, and draws
nothing — a new room would open as a black page with a working rail on it. That was found by
`drive-rooms.mjs` failing on *the board is drawing*, which is the sort of thing only a browser
notices. `BUILT_IN_MAP` is a placeholder the DM's first `SetMap` replaces, exactly as it is in the
room that predates all of this; everything that would need clearing is still empty.

## The room rides in the URL, not on the wire

**No `ClientMsg` or `ServerMsg` variant was added.** `protocol-tags.json` is untouched and
`docs/net.md` did not move. That is worth stating plainly because it is the single decision the
rest of the feature's smallness comes from.

The room is named in the WebSocket URL — `/ws?room=<id>` — and resolved in `ws_handler` before the
upgrade, so a socket only ever exists attached to one room. The alternative was a `room` field on
`Hello`, and it does not work: `RoomCmd::Connected` goes into a *particular* room's mailbox, so a
socket that had not chosen yet would need a holding area outside every actor, which means moving
the handshake out of the room and inventing a second `pending` table for it. The room actor owning
its own handshake is the thing that would have paid for.

An unknown room is a **404 rather than an upgrade**. A socket that opened and then said "no such
room" is indistinguishable to `net.ts` from the server having restarted, and it would reconnect
against it forever.

### `/api/rooms` is the one route under `/api` without the secret

The picker cannot be drawn without the list and it comes before the socket, so the list has to
arrive over HTTP — and a player has no credential to offer. What it discloses is the room *names*.
That is a much smaller thing than the map library's contents, which are DM-only because a player
reading off every dungeon the DM has prepared is next week's session in devtools; a name on a
picker is not that. The unguessable subdomain is the access control here as it is everywhere else
in this project.

Two things keep it from becoming a library: static segments outrank `{library}` in axum's router,
and `Library::named("rooms")` is `None` regardless. `rooms_is_not_a_library` pins the second.

## The client: one function in front of the old one

`chooseRoom` fetches `/api/rooms`, settles which room this browser is opening, and calls `boot`.
**Everything after it is unchanged by multi-room** — `boot` takes the room as an argument and never
asks again, so all fourteen `net.send` sites and the `const net = connect(…)` shape stayed exactly
as they were. That was the point of splitting there rather than threading a nullable `Net` through
the file.

Three ways to arrive, in order: a `?room=` in the link, the room this browser was last in, then the
picker. The first two are **checked against the fetched list rather than trusted**, so a stale
bookmark or a renamed room falls back to the picker instead of a socket the server 404s.

### `?room=` is not stripped, and `?dm=` is

`takeRoomFromUrl` deliberately leaves the address bar alone, one function above
`takeDmSecret` which deliberately does not. A DM secret is a credential and the DM
screen-shares; a room id is checked against a const and knowing a room exists gets you no further
than the picker already does. What keeping it buys is a link the DM can send the table that opens
straight into the one-shot — and the drivers skipping the picker, which is the same property used
for a different reason.

### `rooms.ts` is `picker.ts`'s neighbour, not its generalisation

The same call `dock.ts` makes against `rail.ts` in `docs/frontend.md`, and for the same kind of
reason: the two overlays share their CSS and nothing else. A room is not a slot — nothing can
*claim* one, so there is no `claimed` to dim, and a picker serving both would carry a flag saying
which of the two it is being today.

### The player id is keyed by room

`slate.player_id.<roomId>`, where it used to be one key. A player in two campaigns is two slugs —
the same person is `cleodara` in one room and somebody else in the other — so one key could only
ever hold the wrong answer for whichever room they opened second. Nothing would have leaked: the
server refuses a `player_id` that names no slot in the room being joined, which is
`a_slug_from_another_rooms_roster_is_not_an_identity`. It would just have sent them to the picker
every time they switched.

`slate.room` is a single value beside it, because you are in one room at a time.

**The unscoped key is still read as a fallback.** `slate.player_id` is what this was called when
there was one room, and reading it once means six people do not each have to find themselves again
on the first evening after this lands — invariant 2's argument applied to the browser's own state
rather than the save file's. It is only ever read; the first `Welcome` writes the scoped key, and
from then on the old one is dead weight nothing consults. It is safe against the wrong room because
the server decides: a campaign slug offered to the one-shot names no slot in that roster, so `hello`
answers with the picker, which is what a player with no stored id gets anyway. `forgetPlayerId`
clears it too, or *switch* would hand the picker's choice straight back on the next load.

### The switch button

It forgets the room **and** the player id, and deletes `?room=` from the URL on the way out —
otherwise the link puts you straight back where you were. All three are one act: the room decides
which slots exist, so being asked which character you are without being asked which room you are in
offers a cast you may not want.

**It stays hidden for the DM**, and it now has one reason rather than two: the DM has no character
to switch to, which is the entire job of this button. They switch rooms by opening their own link,
which may carry `?room=` and skip the picker entirely.

The second reason is gone, and it is worth recording that it was a real bug rather than a design.
This section used to say that a reload is how the button works and *the DM's secret does not survive
one* — the secret was stripped from the address bar on boot and lived in a closure from then on, so
a reloaded DM came back anonymous and landed on the character picker. **That was never only about
this button.** `net.ts` reconnects a dropped socket by calling `location.reload()`, so the DM's own
page demoted itself mid-session, which is the worst possible moment for it. This file carried it as
a known bug and deferred the call as security-relevant.

### The secret is remembered in the browser

`takeDmSecret` writes it to `localStorage` under `slate.dm_secret` and reads it back when the URL
carries none. Four things about that, and each is the decision rather than a detail:

- **`localStorage`, and it was `sessionStorage` first.** Per-tab is the tidier answer and it was the
  wrong one. It survives `location.reload()` — the reconnect — and nothing else, so a DM who
  reaches for their bookmark or a new tab when the board goes stale lands on the character picker
  exactly as they did before any of this. **That is what happened on the Pi**, and it is why the
  narrower version is recorded here as a mistake rather than as a trade: "how do I get back" is not
  a habit anybody has to have consistently, and a fix that only works for one of the two ways is a
  fix that reads as broken.
- **The strip is untouched, and that was always the real guard.** The risk is the address bar during
  a screen-share; storage is not on screen, so remembering it there costs that argument nothing. The
  two risks were never the same risk, which is why widening the storage leaves the stripping exactly
  where it was.
- **A URL beats what is stored**, so a DM opening a fresh link is never handed a stale secret by a
  browser that held an old one.
- Both accessors are wrapped, like every other storage read in `identity.ts`. A private-browsing tab
  that throws loses the reconnect path and nothing else.

**What it costs, stated rather than argued away.** The secret now sits in the DM's browser until
site data is cleared, so anybody with that browser profile opens the room as the DM. That is
proportionate here and would not be anywhere else: `.claude/CLAUDE.md` says this is a private game
among friends and not to build real authentication, and the unguessable subdomain is the access
control the whole deployment already rests on. A DM sharing a profile with a player wants a second
profile, not a login. If that ever stops being true, the switch button below is where a *leave the
DM seat* would go — it already forgets the room and the player id, and forgetting the secret beside
them is one line.

**The switch button stays hidden anyway.** Fixing the secret removes the second argument for hiding
it, not the first, and widening a reconnect fix into a UI change is scope it does not need.

## What the drivers cost

Every `tools/drive-*.mjs` appends `?room=campaign` to the URL it opens, because a page that names
no room shows the picker and there is no board behind it to click. That is the whole of what
multi-room cost them — the room is in the URL rather than on the wire, so nothing else about them
changed.

Two other things moved with it. The whoami chip now reads `Saelyn · Campaign`, so the twelve
assertions on it read the half in front of the separator — which also leaves them alone if the room
is ever renamed. And `audit-uploads.mjs` now reads **every** room's save: the libraries and the
uploads directory are shared while the boards are not, so a portrait on a one-shot token is
referenced by a file the campaign's save has never heard of, and reading one room alone would print
an `rm` for every other room's art. That was the one way that tool could have done damage.

`drive-rooms.mjs` is the new one, and it opens two browsers because what it has to show is a
difference between two connections. It reads the isolation off the **presence strip**, which is the
cheapest thing on the page computed per room actor: the DM sitting in the campaign is drawn as away
on a screen looking at the one-shot, and the one-shot's player is absent from the campaign's strip
entirely, holding no slot in that room's roster.

## What is deliberately not here

- **Creating or deleting a room from the UI.** This is the `RwLock` the architecture was shaped to
  allow. Do not build it before there is a reason.
- **A DM secret per room.** `ROADMAP.md` argued for one and its case is a DM running campaigns for
  different groups. This is one DM, one group, one tunnel, and two links to keep straight is worse
  than one. `the_dm_secret_opens_a_room_whatever_its_cast_is` records the decision.
- **Per-room libraries.** Same DM, same art. Splitting `maps/`, `portraits/`, `backdrops/` or
  `uploads/` buys nothing and costs a copy of every goblin.
- **Moving anything between rooms.** A token, a map's calibration, a scratchpad. Each would be a
  reference across two actors that share none, which is the property everything above rests on.

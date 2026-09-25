# Rooms

More than one campaign on one server, and the screen that picks between them (milestone 33). A
second site, which is a second server for a DM who mustn't reach the first one's rooms, and the
roster the DM edits (milestone 46).

Read this before touching `ROOMS`, `RoomDef`, `roster_from`, `RoomState::blank`, `room::spawn`,
`save_path`, `room_listing` or `ws_handler` on the server, `SLATE_SITE`, `SetRoster`/
`RosterChanged`/`roster_allowed`, or `rooms.ts`, `roster.ts`, `chooseRoom` in `main.ts`, the storage
keys in `identity.ts`, or the room in `connect`.

## What asked for it

A Halloween one-shot, run without clearing the campaign's board: no deleting tokens, swapping the
map, and losing the traced walls and explored fog, all to be rebuilt afterwards. That's the whole
motivating case, and it decides which half of the feature matters most: **a second board, not a
second cast.**

A second roster on one room was proposed first. It's the smaller change, so it was considered
properly, and it doesn't work. The roster is the cast list. Swapping it leaves `tokens`, `map`,
`staged`, `initiative`, `walls`, `revealed`, `overrides` and `shapes` exactly where they were, and
those are the fields the one-shot would have had to clear. The multi-room design in
`docs/history.md` had guessed the other way (*"the roster becoming per-room is the actual point"*),
and that line is wrong in this one respect: the roster is what makes a second room *pleasant*, and a
second board is what makes it work at all.

## Not the scene system

`.claude/CLAUDE.md` rules out a scene system by name. It's worth saying exactly why this isn't one,
because on paper both are "more than one map".

Scenes share a room. Switching between them mid-session is why you'd have them, so every `staged`
flag becomes a scene id, token positions fork per scene, and `snapshot_for` multiplies. **Rooms
share nothing.** Two rooms have no field, channel or lock in common: a room is a `tokio` task that
exclusively owns its `RoomState`, and there are simply two of them. Nothing switches during play.
You pick a room on arrival, and getting to the other one takes a page reload.

That's also why there's no leak between rooms to test for. A visibility filter can be written
wrongly; a reference that doesn't exist can't. `server/src/room/tests/rooms.rs` says so at the top
and tests the one thing that *can* go wrong instead: an identity from one room being accepted by
another.

## Fixed at boot, so there's no registry

`.claude/CLAUDE.md` had already designed this half:

> A second room would add a `RwLock<HashMap<RoomId, RoomHandle>>` touched on connect and disconnect
> only — never on a token move.

It turned out cheaper than that. **`ROOMS` is a const**, so every room exists before the first
socket opens, and `AppState.rooms` is an `Arc<HashMap<String, RoomHandle>>` built once in `main`
and only ever read. A lock guards a table that changes, and nothing changes this one.

The `RwLock` is what a room the DM could *create at runtime* would need. That isn't built or
wanted, and it would be the point where this design changes rather than grows. Until then, a lock
here would have nothing to protect.

Everything else the architecture promised held. A socket resolves its room once in `ws_handler`
and then talks to that actor's `mpsc` directly, exactly as it did when there was one handle on
`AppState`. Nothing on the hot path knows that rooms are plural.

Adding a campaign is an edit to `ROOMS` and a redeploy. A config file was the alternative and was
declined. It would allow adding a room on the Pi without a cross-compile, but it costs a schema,
boot-time validation, and a failure mode where a typo means no rooms at all. Rooms are added about
once a season. The roster changes far more often, which is why it moved out of the code and into
the room (see *The roster is the DM's* below).

## The id is the dangerous field

A `RoomDef` has four fields, and the id is the dangerous one. **The id names the save file, the
`localStorage` key a claimed slot is remembered under, and the `?room=` in a link**, so changing it
after a room has been played in orphans all three at once. `name` is free text, and renaming a
campaign is safe at any time. `roster` is only a seed (see *The roster is the DM's*). Moving a room
to another `site` strands its save file in the old process's directory, so treat that like an id
change.

Two tests in `room/tests/rooms.rs` guard the id. `every_room_id_is_a_slug`, because it's joined
onto a directory to make a path and put in a URL. And `room_ids_are_unique`, because `main.rs`
builds a `HashMap` from them, and a duplicate would silently leave one room fewer, with the wrong
roster on the other's save file.

## The first room of each site is its primary room

Two things depend on being first, and both answer the same question: *which room did the
single-room server become?*

- **Its save file is `SLATE_STATE` as given.** Every other room's is a sibling named `<id>.json`.
  This is per site (`is_primary`): each process has its own `SLATE_STATE`, so a second site's
  first room is that process's `SLATE_STATE`.
- **A missing save file boots it from `hardcoded`** rather than an empty board. This one is only the
  very first room in `ROOMS` (`boots_demo`), not every site's first, because the built-in board's
  tokens are the campaign's party. A second site seeded with them would open on somebody else's
  characters.

`every_site_has_exactly_one_primary_room` and `only_the_campaign_boots_into_the_built_in_board`
keep both from drifting.

### Why the save path is a sibling rule and not a directory

`SLATE_STATE` naming a *directory* was the obvious design, and it's what the design in
`docs/history.md` proposed. The sibling rule was chosen for one reason: **it needs no migration.**
The Pi's env file is unchanged, the live `/var/lib/slate/slate-state.json` is still the campaign,
and the backup script that greps the tar for that filename keeps passing. `store.rs` didn't change
at all, since `Store::new` already took a path.

The cost is that the rule is a sentence rather than a directory layout, which is why `save_path`
implements it and two tests in `main.rs` pin both halves
(`the_primary_rooms_save_file_is_slate_state_itself`,
`every_other_rooms_save_file_sits_beside_it`). If there are ever enough rooms that a directory
would be tidier, that's a migration to do on purpose, not something to drift into.

### `blank`, and the map it keeps

`RoomState::blank` is `restored` with nothing to adopt. It's a third constructor rather than a flag
on one of the other two because it answers a different question. `hardcoded` is what a **fresh
checkout** looks like, so a new clone has something on screen. `blank` is what a **new room** looks
like, and seeding a Halloween one-shot with six tokens called Cleodara and Saelyn is worse than
seeding it with nothing.

It keeps one thing `MapInfo::default` doesn't have: **the built-in map's URL.** A default `MapInfo`
has no URL, and a client given one loads no image, never builds its stage, and draws nothing. A new
room would open as a black page with a working rail. `drive-rooms.mjs` found this by failing on
*the board is drawing*, which only a browser would notice. `BUILT_IN_MAP` is a placeholder the DM's
first `SetMap` replaces, exactly as in the room that predates all this. Everything that would need
clearing is still empty.

## The room is in the URL, not on the wire

**No `ClientMsg` or `ServerMsg` variant was added.** `protocol-tags.json` is untouched and
`docs/net.md` didn't change. This is the one decision the rest of the feature's small size comes
from.

The room is named in the WebSocket URL (`/ws?room=<id>`) and resolved in `ws_handler` before the
upgrade, so a socket only ever exists attached to one room. The alternative was a `room` field on
`Hello`, and it doesn't work. `RoomCmd::Connected` goes into a *particular* room's mailbox, so a
socket that hadn't chosen yet would need a holding area outside every actor. That means moving the
handshake out of the room and inventing a second `pending` table for it, giving up the room actor
owning its own handshake.

An unknown room gets a **404 rather than an upgrade**. To `net.ts`, a socket that opened and then
said "no such room" looks the same as a restarted server, and it would keep reconnecting forever.

### `/api/rooms` is the one route under `/api` without the secret

The picker can't be drawn without the list, and it comes before the socket, so the list has to
arrive over HTTP, and a player has no credential to offer. What it discloses is the room *names*.
That's much less than the map library's contents, which are DM-only because a player reading every
dungeon the DM has prepared would see next week's session in devtools. A name on a picker isn't
that. The unguessable subdomain is the access control here, as everywhere else in this project.

Two things keep it from becoming a library: static segments outrank `{library}` in axum's router,
and `Library::named("rooms")` is `None` regardless. `rooms_is_not_a_library` pins the second.

## The client: one function in front of the old one

`chooseRoom` fetches `/api/rooms`, settles which room this browser is opening, and calls `boot`.
**Nothing after it changed for multi-room.** `boot` takes the room as an argument and never asks
again, so all fourteen `net.send` sites and the `const net = connect(…)` shape stayed as they were.
That's why the split is there, rather than threading a nullable `Net` through the file.

There are three ways to arrive, in order: a `?room=` in the link, the room this browser was last
in, then the picker. The first two are **checked against the fetched list rather than trusted**, so
a stale bookmark or a renamed room falls back to the picker instead of a socket the server 404s.

### `?dm=` is stripped from the address bar and `?room=` isn't

`takeRoomFromUrl` leaves the address bar alone. `takeDmSecret`, one function below it, strips its
parameter. A DM secret is a credential, and the DM screen-shares. A room id is checked against a
const, and knowing a room exists gets you no further than the picker does. Keeping it gives the DM
a link they can send the table that opens straight into the one-shot, and it lets the drivers skip
the picker for the same reason.

### `rooms.ts` is separate from `picker.ts`, not a generalisation of it

This is the same call `dock.ts` makes against `rail.ts` in `docs/frontend.md`, for the same kind of
reason: the two overlays share their CSS and nothing else. A room isn't a roster slot. Nothing can
*claim* one, so there's no `claimed` to dim, and a picker serving both would need a flag saying
which one it was being.

### The player id is keyed by room

The key is `slate.player_id.<roomId>`; it used to be a single key. A player in two campaigns has two
slugs (the same person is `cleodara` in one room and someone else in the other), so one key would
always hold the wrong answer for whichever room they opened second. Nothing would have leaked: the
server refuses a `player_id` that names no slot in the room being joined
(`a_slug_from_another_rooms_roster_is_not_an_identity`). It would just have sent them to the picker
every time they switched.

`slate.room` is a single value beside it, because you're in one room at a time.

**The unscoped key is still read as a fallback.** `slate.player_id` is what the key was called when
there was one room, and reading it once means six people don't each have to pick their character
again on the first evening after this shipped. It's invariant 2's argument applied to the browser's
state rather than the save file. It's only ever read: the first `Welcome` writes the scoped key, and
after that nothing consults the old one. It's safe against the wrong room because the server
decides. A campaign slug offered to the one-shot names no slot in that roster, so `hello` answers
with the picker, which is what a player with no stored id gets anyway. `forgetPlayerId` clears the
old key too, or *switch* would hand the picker's choice straight back on the next load.

### The switch button

It forgets the room **and** the player id, and deletes `?room=` from the URL on the way out, or the
link would put you straight back where you were. All three go together: the room decides which
slots exist, so asking which character you are without asking which room you're in offers a cast
you may not want.

**The DM has one too, and for them it forgets only the room.** It used to be hidden on the argument
that the DM has no character to switch to. That's true, but the button was always also about the
*room*, and the chip beside it has shown which room they're in since this feature landed. Two later
changes, made to fix other things, left the DM with no way back to the picker. The room is
remembered in `localStorage`, so a bare link reopens the last one. The secret is remembered beside
it, so the DM's own link no longer needs `?dm=` and in practice stops being opened by hand. A DM who
wanted the other campaign had to type `?room=<id>` onto the URL, with an id **nothing on the screen
shows them**: `/api/rooms` reports it and the picker uses it, and neither ever displays it to the
DM.

So it shows for everyone, and the label carries the difference: `switch room` for the DM, `switch`
for a player. The click does the same thing minus the half the DM doesn't have: `forgetPlayerId` is
skipped, because the DM holds no slot and there's nothing to ask afterwards.

**The secret is kept.** This is *switch campaign*, not *leave the DM seat*. The reload goes back
through `takeDmSecret`, the DM comes back as the DM in whichever room they pick, and the character
picker never appears. A *leave the DM seat* would be one more line here and still isn't wanted; see
the cost paragraph in the next section.

Showing the button is only safe because the DM's reload now keeps the DM's identity, and the order
mattered. The second argument for hiding the button (that a reloaded DM came back anonymous) had to
be fixed as a bug before the first could be reconsidered.

That second argument was a real bug, not a design choice. This section used to say that the button
works by reloading and that *the DM's secret does not survive one*: the secret was stripped from the
address bar on boot and kept only in a closure, so a reloaded DM came back anonymous and landed on
the character picker. **That was never only about this button.** `net.ts` reconnects a dropped
socket by calling `location.reload()`, so the DM's page demoted itself mid-session, the worst
possible moment. This file carried it as a known bug and deferred the fix as security-relevant.

### The secret is remembered in the browser

`takeDmSecret` writes it to `localStorage` under `slate.dm_secret` and reads it back when the URL
has none. Four points, each of them a decision:

- **`localStorage`, after `sessionStorage` was tried first.** Per-tab storage looked tidier and was
  wrong. It survives `location.reload()` (the reconnect) and nothing else, so a DM who reaches for a
  bookmark or a new tab when the board goes stale lands on the character picker just as before.
  **That's what happened on the Pi**, and it's why the narrower version is recorded as a mistake
  rather than a trade-off. Nobody consistently uses one way of getting back, and a fix that works
  for only one of the two looks broken.
- **The stripping is unchanged, and it was always the real guard.** The risk is the address bar
  during a screen-share. Storage isn't on screen, so keeping the secret there doesn't weaken that
  argument. They were always two different risks, which is why widening the storage leaves the
  stripping where it was.
- **A URL beats what's stored**, so a DM opening a fresh link never gets a stale secret from a
  browser that held an old one.
- Both accessors are wrapped in try/catch, like every other storage read in `identity.ts`. In a
  private-browsing tab that throws, only the reconnect path is lost.

**The cost.** The secret now stays in the DM's browser until site data is cleared, so anyone with
that browser profile opens the room as the DM. That's proportionate here and wouldn't be anywhere
else: `.claude/CLAUDE.md` says this is a private game among friends and not to build real
authentication, and the unguessable subdomain is the access control the whole deployment already
relies on. A DM sharing a profile with a player needs a second profile, not a login. If that stops
being true, the switch button (above) is where a *leave the DM seat* would go. It already forgets
the room and the player id, and forgetting the secret too is one line.

**The switch button was left hidden from the DM when this fix landed.** Fixing the secret removed
the second argument for hiding it but not the first, and widening a reconnect fix into a UI change
was scope that milestone didn't need. The first argument then failed on the Pi too; see *The switch
button* above, where it's now shown to the DM as well.

## What it cost the drivers

Every `tools/drive-*.mjs` appends `?room=campaign` to the URL it opens, because a page that names no
room shows the picker, with no board behind it to click. That's all multi-room cost them: the room
is in the URL rather than on the wire, so nothing else about them changed.

Two other things changed with it. The whoami chip now reads `Saelyn · Campaign`, so the twelve
assertions on it read the part before the separator, which also keeps them working if the room is
renamed. And `audit-uploads.mjs` now reads **every** room's save. The libraries and the uploads
directory are shared while the boards aren't, so a portrait on a one-shot token is referenced by a
file the campaign's save knows nothing about, and reading one room alone would print an `rm` for
every other room's art. That was the one way that tool could have done damage.

`drive-rooms.mjs` is new, and it opens two browsers because what it has to show is a difference
between two connections. It checks isolation using the **presence strip**, the cheapest thing on
the page that's computed per room actor. The DM sitting in the campaign is drawn as away on a screen
showing the one-shot, and the one-shot's player is missing from the campaign's strip entirely,
holding no slot in that room's roster.

## Sites: a second DM gets a second process

A **site** is one server process and the rooms it serves. `RoomDef::site` names it and
`SLATE_SITE` picks it (default `home`, so the Pi's first service needed no change). A process lists,
spawns and accepts sockets only for its own site's rooms, so `/api/rooms` on one site never names
another's, and a `?room=` for another site's room is a 404.

It exists for a second DM running a different table on the same box (`sword-legend`), who mustn't
see the home site's campaign or one-shot. Inside one process, a room shares four things with its
neighbours, and each would leak to that DM:

- **The DM secret.** One secret opens every room in the process (`hello` checks it against the
  process-wide value). His link would open the campaign as its DM.
- **The room list.** `/api/rooms` needs no credential, so his players' picker would list the
  campaign and the one-shot.
- **The libraries.** Listing `maps/` is how the DM picks a map, so he'd see next week's dungeon.
- **`uploads/`.** Served to anyone holding a URL.

Making each of those per room was the alternative, and it reverses three decisions this file
records: one secret, a public room list, and shared libraries. Each change would be a new place for
the home site's rooms to leak, and each would need a test. A second process shares none of the four
because it never had them: its own env file, secret, data directory and port. On the Pi it also runs
as its own Linux user with the home site's data outside its view (`deploy/pi/README.md`, *A second
site*), so even a bug in Slate itself couldn't reach across. Nothing in the code crosses between
sites. They meet only in the `ROOMS` table.

**`SLATE_SITE` naming no rooms stops the boot** rather than falling back. An empty site would be a
server with nothing on its picker, and falling back to `home` would serve the home site's rooms
under the second DM's secret, which is exactly the leak the site exists to prevent.

What a misconfigured second site *could* show is what's compiled in: room names and seed rosters.
Those are in this repository already, so they aren't secret. The boards, walls, libraries and
uploads live on disk under the home site's own directory.

### A server with one room skips the picker

`chooseRoom` picks the only room when `/api/rooms` lists one, and the DM's switch button is hidden
there because it would reload into the same room. A player's stays: it also changes character.

## The roster is the DM's

The roster used to be a constant, with a note on `roster_from` saying it would have to become state
if the DM could edit it. A second site made that necessary. A DM who can't add a friend without
someone else cross-compiling a release isn't running his own game.

**It's saved with the room** (`Saved::roster`), and the constant in `ROOMS` only seeds a room that
has never saved one. `None` on the file means a save from before this, and keeps the seed. An empty
list is a real roster (a new site's room starts with no players), which is why the field is an
`Option` and not a list defaulting to empty: loading an old campaign save as an empty roster would
turn six players away on the first boot after the upgrade.
`a_save_from_before_the_roster_was_saved_keeps_the_seed` pins it. The cost: once a room has saved,
editing its seed in the code changes nothing.

### One command, the whole list

`SetRoster { roster }` sends the whole cast, and the room compares it with what it holds. That's one
command and one event (`RosterChanged`) rather than add, rename and remove. A new slot's id is made on
the client from its name (`slugFor` in `roster.ts`); the room checks it's a slug, short enough and
unique, and checks names and the count (`roster_allowed`). **An id never changes.** It's what tokens,
colours, scratchpads and each player's `localStorage` are keyed on, so a rename sends the same id with
a new name. A name added again after its slot was removed makes the same id, which is how a token
restored by an undo finds its owner again.

`RosterChanged` is unfiltered: the roster already goes to everyone in `Welcome`. Clients that built
DOM from it (the presence strip, the chat chips, the token panel's owners, the table tab) rebuild,
and everything else reads the same array, **which `main.ts` changes in place**. Six modules captured
it when they were built, and replacing it would leave them reading the old one. That's `adoptView`'s
reason for changing the scene in place. Players still on the picker get a fresh `ChooseIdentity`,
so a slot added while they're deciding appears.

### Removing a slot

- **Refused while that player owns a token**, staged tokens included. The token would belong to
  nobody who could join. Handing it to somebody else first is one edit on the token tab.
- **Their colour and scratchpad are deleted.** Otherwise a name added later under the same id would
  be handed the last person's private paragraph.
  `a_name_added_again_is_not_sent_the_last_persons_scratchpad` is the test.
- **Their connections are closed** through `remove_client`, the one way anybody leaves. The page
  reconnects, offers the slug it remembered, and `hello` refuses it (a slug not in the roster was
  already not an identity), so they land on the picker. A connection left open would be somebody
  playing as nobody.

### Kept off the undo ring

Edited by the DM, and still excluded, by the same two lines as the colours: `undid` returns `None`
for `SetRoster`, and the `Undo` arm puts the roster back around `adopt`. The reason is different
from the scratchpad's: **a restore can't change who somebody is.** `Restored` carries no roster, and
an undo that took back an added slot would leave its player connected as nobody. So an undo can
bring back a token whose owner has since been removed. The DM can move and re-own it, and re-adding
the name brings the same id back.

## Not built

- **Creating or deleting a room from the UI.** That's what the `RwLock` would be for. Don't build it
  before there's a reason.
- **A DM secret per room.** The design in `docs/history.md` argued for one, for a DM running
  campaigns for different groups. Within a site that's still one DM and one group, and two links to
  keep straight is worse than one. `the_dm_secret_opens_a_room_whatever_its_cast_is` records the
  decision. A different DM gets a site instead (above).
- **Per-room libraries.** Same DM, same art. Splitting `maps/`, `portraits/`, `backdrops/` or
  `uploads/` gains nothing and costs a copy of every goblin. A different DM's are separate because
  they're a different process.
- **Moving anything between rooms.** A token, a map's calibration, a scratchpad. Each would be a
  reference across two actors that share none, and everything above depends on them sharing none.

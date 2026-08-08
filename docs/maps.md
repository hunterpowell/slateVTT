# Maps

The two map slots, the map library, and the DM's preview mode.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`maptool.ts`, `calibrate.ts`, `library.rs`, or `SetMap` / `MapInfo` on the server** — the
loading-versus-recalibrating rule below is depended on by three separate features and is the arm
that gets missed.

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
took and fog will — see *Hidden tokens and hit points* in `docs/tokens.md`, where the same idea
had to reach inside a message rather than only past it. A staged map that shipped to every client
and was merely not drawn would be the next dungeon sitting in devtools — invariant 4.

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

**Everything on that board is a piece.** Tokens drag, the token panel works, and what a drag
writes is the token's plan rather than its position — see *Preparing the next room* in
`docs/tokens.md`. Preview briefly ghosted tokens and refused to grab them, on the grounds that
what was on screen was not the board; that rule is gone, because a board where some things can be
moved and others cannot is worse than either extreme.

Preview is client-only — no command, no event, nothing persisted, and nobody else can
tell it is happening. **The server does not know the DM is previewing and must not learn.** That
is why intent rides on the command (`SetMap`, `MoveToken` and `CreateToken` each carry `staged`)
rather than on a mode, and it means the server cannot refuse an operation *because* the DM is
previewing — anything that should not happen there is the client declining to offer it.

Because preview is that invisible, the DM's own screen has to say so loudly:
mistaking a staged map for the board is the one way this feature goes wrong.

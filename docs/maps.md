# Maps

The two map slots, the map library, the DM's preview mode — and the backdrop, which is in this
file because it is defined by not being a map.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`, `drawBackdrop`, `shownBackdrop`, or
`SetMap` / `MapInfo` / `SetBackdrop` / `Prepared` on the server, or `RoomState::shelve` or
`library::destination`** — the
loading-versus-recalibrating rule below is depended on by four separate features now and is the arm
that gets missed.

## Maps and the map library

The DM picks a map out of the repository's `maps/` folder instead of re-uploading one every
session: list what is there, then pick one by path. The directory is `SLATE_MAPS`, defaulting to
`../maps` the way `SLATE_CLIENT_DIR` defaults to `../client`.

**A pick is a copy into the uploads directory, not a second way to serve files.** The copy is
named deterministically, so picking the same map twice resolves to the same file and the same URL
rather than accumulating a duplicate per pick. That name is a readable slug of the relative path
with a short hash appended — the slug because `%LOCALAPPDATA%\Slate` is meant to be browsable, the
hash because two different paths can slug identically and silently collide onto one file.
Everything downstream is then identical to an upload — one kind of map URL, and
`%LOCALAPPDATA%\Slate` stays a complete backup on its own, which serving `maps/` directly would
quietly break.

**What that hash is taken over is the caller's choice, and the two libraries differ on it** —
`copy_name` takes a fingerprint beside the key, and `Library::names_by_content` decides which. A
map hashes its path; a portrait hashes its bytes. See *The portrait library* in `docs/tokens.md`
for why, and read the rest of this section before considering the same for maps.

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
same reason walls do. Since milestone 31 it remembers the walls and the paint as well — see *The
shelf* below.

**Uploading is adding to the library, since milestone 32.** It used to be its own route: the bytes
went into `uploads/` under a fresh UUID, so an uploaded map matched no earlier calibration, could
not be found again next session, and a second upload of the same file was a second URL with a
second set of walls under it. The asymmetry used to be written down here as deliberate and it was
not worth defending once the folder could be written to — the upload button now writes into
`maps/` and then picks what it wrote, which makes an uploaded map a library map in every respect
because it *is* one. The wart that remains is the one below, about names: the copy is named from
the path, so replacing art still does nothing.

There is one route family now — `/api/{library}` with `pick`, `add` and `remove` under it — and
one client widget behind all three panels. `Library::named` turns the path segment into the folder,
which is what collapsed twelve operations into four handlers.

**The calibration table is why a map is named from its path, and it is load-bearing.** Replacing a
map's art in `maps/` therefore does nothing: the pick recomputes the same name, finds the copy
already written, and serves the bytes it replaced. That is a real wart and it is the cheaper side
of the trade — naming a map by its contents would give every recalibrated map a new URL and orphan
every calibration the DM has ever made. Closing it properly means migrating that table, not
flipping `names_by_content`. Two tests hold the line: `a_picked_map_keeps_the_name_it_has_always_had`
asserts both the empty prefix and the path fingerprint, and
`a_replaced_portrait_is_a_new_copy_and_a_replaced_map_is_not` states the asymmetry from both ends.

**There are two libraries now, and one implementation of them.** `portraits/` is the same feature
over token art — see *The portrait library* in `docs/tokens.md`. The folder, the size cap and the
noun in the refusals are all a library differs by, so they ride on `Library` in `main.rs` and on
two arguments to `createLibraryList` in `library.ts`; `library.rs` itself never learns there is
more than one. The second library added exactly two rules, and they are the same rule twice: a
copy's name is derived from a **prefixed** key, or the same filename in both folders resolves to
one file; and it is fingerprinted by **content**, or replaced art keeps resolving to the copy it
replaced. **Maps opt out of both**, because the calibration table above is keyed on the URL their
names produce.

### Adding and removing

**Two rules, and the first is where the risk is.** An add's name is a *single component* — refused
outright if it holds a separator, rather than having its last segment taken, because taking it
would accept `../../evil.png` by quietly meaning something else. That is tighter than a pick, which
may name a file in a subdirectory and is checked against the canonicalised root; an add cannot
leave the folder rather than being proven not to have. The rest of the rule is Windows: the
characters it reserves, the device names it still resolves ahead of files, and the trailing dots
and spaces it strips — a file written as something other than what the DM typed is one they cannot
then remove by asking for the name they gave.

**The extension is the sniffed one, never the supplied one.** The name decides what the picker
reads and what the copy's key comes from; the bytes decide how it is served.

**A name already taken is refused, not overwritten.** There is no undo on a filesystem, and for a
map an overwrite would not even do what it looks like — the copy is named from the path, so the old
bytes would go on being served under the same URL.

**A remove deletes the library file and nothing else.** Not the copy in `uploads/`, and so not the
map on the board, not the remembered calibration, and not the walls or the paint on the shelf.
Removing something from the picker is saying "stop offering me this", and re-adding a file under
the same name later lands on the same URL and finds all of it waiting. That is the property that
makes the destructive-sounding button safe, and it falls out of a pick being a copy rather than a
second way to serve files.

`add` finishes by calling `pick` on the file it just wrote. One path from "a file in the library"
to "a URL it is served at" is what guarantees an add and a later pick of the same file agree, which
matters more than the wasted re-read: everything keyed on that URL is keyed on both.

## The shelf

**Milestone 31, and it is the calibration table above growing two fields rather than a new
subsystem.** The ask was "I'd like to save map states and prep a handful of maps before a
session": the DM traces three dungeons on a Tuesday and finds all three still traced on Saturday.

`Calibration` already answered most of it — grid, offset, play area, fog, radius and lighting,
keyed by URL, persisted, never sent. The only prep it did not remember was the traced **walls** and
the painted **overrides**, both of which a map load threw away. So the feature is one table entry
growing and two things to get right:

- the outgoing board's walls and paint are filed under **its** URL as it stops being held
- the load arm restores them, exactly as it already restores the grid

No new command, no new event, no list in the state model, no panel UI, no `staged` flag on the
wire, and **no filter to widen** — walls already reach the DM or nobody, which is what made
milestone 20 cheap too. **The shelf is the folder**, which is the backdrop's line again: the
collection of prepared maps is `maps/`, and the room holds only what it has learned about each.

### A wrapper, not two more fields on `Calibration`

```rust
struct Prepared { calibration: Calibration, walls: Vec<Wall>, overrides: OverrideView }
calibrations: HashMap<String, Prepared>
```

`Calibration` is **what the client sent** — the room builds one as a bare struct literal out of the
`SetMap` fields. What the room has *learned* about an image is a different thing, and keeping them
apart is what makes the trap below unsayable rather than merely avoided. The calibration is
`#[serde(flatten)]`ed, so the disk shape is what it always was with two keys beside it and a save
written before this milestone loads as a calibrated map with nothing traced on it — `StagedView`'s
trick, for the same reason. (`Calibration` derives `PartialEq` and `Wall` does not, so the two
could not have been merged without one of them changing anyway.)

### Three traps, and the first is silent

- **The recalibration clobber.** `SetMap`'s record step fires on **every** recalibration, not only
  on a first load. With the walls inside `Calibration` the obvious way to write that arm files
  *empty* walls, so nudging the grid on a traced dungeon quietly erases what the room remembered
  about it — and the board keeps its walls, because a recalibration does not sweep, so nothing
  looks wrong until the DM loads away and back. With the wrapper the record step assigns
  `prepared.calibration` and cannot reach the rest. `nudging_the_grid_does_not_erase_what_the_room_remembers`
  holds it.
- **`sweep_board` cannot ask which map it is sweeping**, so the URL is passed in. Its two call
  sites order the map assignment opposite ways round — a `SetMap` assigns and then sweeps, a
  promote sweeps and then assigns — so `self.map.url` in there is the *incoming* map on one path
  and the outgoing one on the other. Filing a dungeon's masonry under the name of the map that
  replaced it puts the walls back on the wrong image.
- **The staged slot is a second write site with a different shape.** Staged walls never reach
  `sweep_board`; they die where the load arm takes the slot, and again in `ClearStaged`. Both are
  `RoomState::shelve`, which takes the board's walls and paint as arguments precisely because the
  three callers hand over different boards.

**What is filed is whatever the board actually holds, empty included.** A DM who cleared a bad
trace and then loaded away has cleared it; filing only non-empty lists would make starting a trace
again unsayable, and `ClearWalls` is the way to throw prep away.

**`ClearStaged` files too, and that is the rule rather than an extra.** The shelf is keyed by
image, not by slot, so which of the two exits the DM took must not change what next week's load
finds.

### Two deliberate omissions, and the second is the boundary

- **Token plans.** `staged_pos` / `staged_only` are on `Token`, singular, and stay bound to
  whatever is in the staged slot. The DM preps *terrain* for many maps and *the encounter* for the
  one they are about to run.
- **`revealed` is not remembered.** Returning to a dungeon means the party re-explores it. The
  split to hold is **the DM's authoring is remembered; the party's play state is not** — remembering
  where they had walked would make a map swap a partial scene restore, which immediately raises
  "why not the token positions too", and that road ends at the scene system this file refuses.
  `the_party_re_explores_a_dungeon_they_return_to` is that boundary written down.

### Two consequences worth knowing

**There is no frame-cap question here**, which is worth saying because `CLAUDE.md`'s "a command
carrying a collection has two bounds" rule looks like it should apply. This table never reaches the
wire. `MAX_WALLS`, applied where a wall is traced, is the only bound, and nothing here needs a
`largest_..._fits_in_a_frame` test.

**Staging the map that is already live reads off the shelf, not off the board.** The staged slot
holds no URL, so filling it is always a load, and a load restores what was last *filed* for that
image — which is older than what the live board is holding, since the shelf is written as a board
leaves. It is an odd thing to do and it is not worth a special case; the walls the DM is looking
at are the live board's and are untouched.

**The undo ring's motivating case is weaker now**, and `docs/undo.md` says so: "the case that makes
undo worth having is `sweep_board`" was written when a map load destroyed half an hour of tracing,
and a load that gives the walls back on the way in is a less catastrophic load. The ring is still
right for its other reasons.

## Staged maps

`staged: Option<StagedBoard>` is the map the DM is preparing while the table is still looking at the
current one, **and the walls and fog overrides they have prepared on it**. Promoting moves all three
onto the live board and empties the slot. There is one slot, not a list: a full scene concept —
several maps each owning its own geometry — is a much larger feature and is not being built.

The bundle is milestone 20, and it is worth knowing what it bought before adding a fourth thing to
it. **One `None` withholds the whole slot**: `snapshot_for` has one arm, `Event::StagedChanged`
carries the whole board so a staged load sweeping its walls needs no frame of its own, and there is
no second staged field for a later milestone to add and forget to filter. The in-memory type and the
wire type differ by one field — the overrides are a `HashMap<Cell, Override>` in the room and a
packed rectangle on the wire, exactly as the live board's are — which is `StagedBoard` and
`StagedView`, the same split `RoomState`/`RoomView` and `Token`/`TokenView` already make.

**On disk the map is `#[serde(flatten)]`ed inside it**, and that is load-bearing rather than
stylistic. A save written when this was an `Option<MapInfo>` holds the map's own fields directly
under `staged`, which is exactly where flatten reads them from — so an older room comes back with
its staged map intact and two empty lists beside it. Nested under a `map` key, every one of those
fields would have read as missing, `MapInfo::default()` would have filled in, and the DM's next-map
tab would have opened on a blank image with nothing on screen saying a map had been lost. There is a
test named for it.

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
reasons nobody asked for. The party's explored cells clear, which is already the rule for a new
map — **the walls and the overrides no longer do**: `sweep_board` clears the board's and then the
staged board's land in their place. That is milestone 20 and it is the one thing a promote does
differently from any other map load.

`SetMap` into the staged slot follows the live slot's rules exactly, which is the argument for both
slots holding the same three things: a **load** sweeps that slot's walls and paint alongside its
token plans, and a **recalibration** sweeps only the paint. Walls are image pixels and still trace
the same painted line after the grid moves; an override is a cell whose square has just moved out
from under it. `docs/walls.md` has the table.

### Preview

Calibrating a staged map means looking at it, so the DM's client points the renderer at the
staged image while the table keeps seeing the live one. There is no separate preview toggle:
the map panel's `Map | Next map` switch decides which slot everything in it is about, and
selecting a slot that holds a map *is* preview mode.

The client's `Scene` therefore holds two boards — live and staged — and everything that draws
or hit-tests reads `shownBoard(scene)` rather than reaching for the live one. That indirection is
the whole client-side feature; without it, a staged calibration preview writes into the grid the
table is looking at.

**`shownWalls` and `shownOverrides` are its twins**, added in milestone 20 for the two things that
live beside a board rather than on it. Same argument a third time: without one function answering
"which of the two", a single missing branch traces the next dungeon's masonry across the board the
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

## Backdrop

A picture the DM shows the table **instead of** the board — a forested clearing, a campsite, the
inside of a tavern — for the stretches of an evening where there is nothing to move and nothing to
measure. `backdrop: Option<String>` on `RoomState`, one command, one event, and nothing else.

### Why it is not a map

The problem it solves is not "there are only two slots". It is that **loading a map is
destructive on purpose**. A `SetMap` whose URL changed sets `loading`, which calls `sweep_board`:
the drawings go, the walls go, `forget_fog` takes everywhere the party had explored, and the DM's
paint goes with them. That is right for a map — a new image is a new dungeon and a wall traced on
the last one is a line across the middle of this one — and it makes showing a campfire between two
fights cost half an hour of tracing with no way back.

So the thing to notice is that **what the DM wants to show is not a map**. There is no grid on it,
nothing stands on it, nothing is traced across it and nobody explores it. Building it as a second
board would pay for all of that and use none of it, and a *list* of such boards is the scene
concept the section above refuses — every `staged` flag becomes a scene id, token positions fork
per scene, and `snapshot_for` multiplies.

One field instead. `apply`'s arm is an assignment and an event, and **that arm staying short is the
feature**: the board, its walls, its shapes and everywhere the party has been all go on existing
untouched behind the picture, so taking it down puts the table back exactly where they were.
`covering_the_board_leaves_the_encounter_exactly_where_it_was` in `room/tests/maps.rs` is that
claim as a test, and it is deliberately the mirror of
`undoing_a_map_load_gives_back_the_walls_the_shapes_and_the_fog_together` in `room/tests/undo.rs`:
that one asserts a load destroys four things at once, this one asserts a backdrop destroys none.

### The presets are the folder

`backdrops/` is a third `Library` beside `maps/` and `portraits/`, sharing every line — the folder,
the size cap, the noun in the refusals and what a copy's name is fingerprinted over are the whole
of what a library differs by. It takes the **portraits'** answer on both axes it can choose: a
`backdrop/` prefix, and a name fingerprinted by content, because nothing is keyed on a backdrop's
URL and replacing the art in the folder should replace the picture. Maps' opt-out exists only
because the calibration table is keyed on their names, and that reason does not reach here.

That is also how "a few presets" costs nothing: **the collection is the folder**, and the room
holds one field saying which of them is up. A list in the state model would be a scene manager
wearing a different noun.

### On the wire and on the screen

Unfiltered — `BackdropChanged` sits beside `NamesChanged` and `FogChanged` rather than beside
`WallsChanged`. Who may put a picture up is a permission; which picture it is is not a secret,
since six people are looking at it. Echoed to the DM who sent it, like the switches beside it.
**Nothing travels with it**: no map, wall, shape or fog frame accompanies it, and none is owed,
because the board is being covered rather than changed.

On the client it is drawn by `drawBackdrop` **instead of** `render`, not as a layer inside it —
screen space, no camera, no grid, no hit test. `main.ts` returns from the frame before any of that
runs, so there is nothing that could disagree with a board nobody can see. It is contained rather
than covered, unlike a token's portrait: the DM picked this image to be looked at, so letterbox
bars are correct and cropping is not.

**`shownBackdrop` is `shownBoard`'s fourth twin**, and answers one question earlier than the other
three: they pick *which* board, this decides whether a board is drawn at all. Its one branch is
that **preview wins** — a backdrop is what the *table* is looking at, and a DM previewing the
staged map is asking to see the next dungeon. That is the case it exists for: the party roleplays
at the campfire while the DM traces the crypt they are about to walk into. Without it the DM would
have to take the picture off six other screens to get any work done.

The board stops responding through **one CSS rule** — `body.covered #stage { pointer-events: none }`
— rather than a guard in each handler in `input.ts`. With no pointer events delivered there is no
pan, no drag, no ping, no door swing, no sweep and no cursor relay, by construction rather than by
remembering. The panels stay: the table can still roll initiative and talk while the picture is up,
which is most of why it is worth having.

The control is on the **table tab**, because a panel mirrors where its fields live and this is
room-wide `RoomState` rather than `MapInfo`. It is the first thing on that panel to arm anything
at all — a disclosure list rather than a canvas tool, so the `stop()` it gained is the map and
token panels' tidiness rather than their rule.

`drive-backdrop.mjs` is the browser half. Its last two checks are the point: the board's pixels
before the picture went up and after it came down have to be the same.

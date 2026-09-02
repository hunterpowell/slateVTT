# Maps

The two map slots, the map library, the DM's preview mode — and the backdrop, which is in this
file because it is defined by not being a map.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`, `drawBackdrop`, `shownBackdrop`, or
`SetMap` / `MapInfo` / `SetBackdrop` / `Prepared` on the server, or `RoomState::shelve` or
`library::destination`** — the
loading-versus-recalibrating rule below is depended on by four separate features now and is the arm
that gets missed. **Also before touching `fog::basis`, `gridBasis` / `shapeOf`, `gridFromEdge` or
`GridShape`** — see *The shape of a cell* below, and note that the two `basis` functions are one
statement written in two languages.

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

## The shape of a cell

A map's cells are squares or they are isometric diamonds. `GridShape` on `MapInfo` says which, and
it is remembered per URL with the rest of the calibration — so the isometric town and the square
dungeon can sit in the same folder and the DM never has to remember which is which. **`Square` is
the default**, which is invariant 2 doing the only job that matters here: a save written before the
field describes exactly the board it always did. Anything else and every token on every saved map is
somewhere new.

**It is flat, and that boundary is the feature.** A diamond lattice, not a 2.5D renderer: no depth
sorting, no wall height, no sprite anchoring, no elevation, no occlusion. Tokens are still upright
discs, `Wall` is still a segment in image pixels with no height, and tokens still draw in list
order. Read *Why the 2.5D version is refused* below before adding to any of that.

### An isometric grid is an affine image of a square one

That one sentence is why this was small. A diamond lattice is the square lattice with a 2×2 matrix
applied, so **everything expressed in grid space was already lattice-agnostic and was not touched**:
`snap_to_cell`, `covered_cells`, `shape_covers`, `contains_point`, `line_cells`, `with_fringe`, the
fog packing, `snapOrigin` / `snapExtent`, `feetMoved`, `trailCells`, both `Diagonals` rules, and
every line of wall segment math. What changed is five functions and the places that *draw*.

The five are the whole grid-to-pixel bridge: `grid_to_px`, `cell_of` and `cell_centre` in `fog.rs`,
and `gridToWorld` / `worldToGrid` in `coords.ts`. **`fog::basis` and `gridBasis` are the only two
places either variant is read**, which is the discipline `sight_cells` already keeps over
`Lighting` — and they are one statement in two languages, so a disagreement between them puts the
fog the server packed a cell away from the walls that cast it. `drive-isometric.mjs` is what holds
them together once a real frame has crossed the socket, because nothing else can see it.

**The raycast needed nothing structural**, which was the surprise. Both fog algorithms already test
the radius *in cells* and use pixels only for wall intersection — the split is deliberate and
`visible_cells` says so in a comment. Only the once-per-source wall cull moved, from `grid_px` to
`px_per_cell`, which is the basis's largest singular value. On a square grid that is `grid_px`
exactly, and that is what keeps the culls dropping precisely the walls they always did. `|u| + |v|`
would also be safe, and would quietly halve the culling on every map in the project.

**`MapInfo` is the only thing on the wire that moved.** No new `ClientMsg` or `ServerMsg` variant,
`protocol-tags.json` untouched, and `Cell` / `Pos` / `Px` / `Wall` / `FogView` / `OverrideView` all
unchanged. `Prepared` wraps `Calibration`, which is where the shape lives, so an isometric map is
remembered on the shelf with everything else at no cost at all.

### One dragged edge, not two

The DM drags along **one edge of one diamond**, corner to corner, and `gridFromEdge` reads that
vector as half a cell's width across and half its height down. The second axis is the first mirrored
about vertical, because real isometric art is symmetric and there is nothing for a second gesture to
say. A free basis would express oblique lattices no map anybody loads actually has, at the cost of a
second drag and a `Default` with no honest answer — "square" depends on `grid_px`, a sibling field,
which is exactly why the wire carries a *descriptor* and each side derives the basis from it.

It also means **the gesture cost nothing on the canvas**: `input.ts` hands over the same box either
way, and the shape decides whether it is read as a rectangle of squares or as one diamond's edge.
The square path — the box drag, the cell count, "use the whole image" — is untouched and still
produces `Square`.

Three panel rules came with it. The whole-image shortcut is hidden under isometric, because it
proposes a *region* — the image's own bounds as the reference box — and an edge gesture has no
region in it: the rail's rule about a way in to something that can do nothing, one level down.
Changing the shape **abandons the drag** rather than reinterpreting it: a box read as four squares
and the same box read as one diamond's edge are different claims about the map, and carrying it
across would make the second one on the DM's behalf without saying so.

*(The cell count was hidden here too at first, on the grounds that it answered "how many squares
across" and an edge gesture never asked it. That was wrong — see below.)*

### The count is both gestures'

**It is often easier to trace the whole edge of a room and say how many tiles that was** than to
aim at one tile and have the answer replicate across the map. So the edge gesture takes the same
count the box gesture does, and `gridFromEdge` divides the drag by it.

The count answers "how many cells did that drag cross", which **both** gestures ask; only the
whole-image shortcut is the square path's alone. The first cut hid them together because they sit
in one row, which is a layout fact rather than an argument — `#map-count` is no longer a thing the
tool holds a reference to, and `wholeMap` is hidden on its own.

Three things make it fit the gesture rather than merely apply to it:

- **The overlay draws the whole chain.** `drawCalibrationDiamond` steps `cells` diamonds along the
  drag, which is the edge gesture's version of the divisions the square path rules inside its box:
  with the count right they land on the tiles printed on the art, and a wrong one is visible over
  the whole run rather than hidden in a single tile and multiplied later. That is most of why the
  long gesture is the easier one, so drawing one diamond and dividing silently would have given
  away the reason for building it.
- **It divides and nothing else.** Both readings are linear in the drag, so `isoDiamond` divides
  the vector once at the top and the fixed shape's projection is unaffected — a run of four is
  exactly the statement one edge of the same cell is, under either shape. The anchor is untouched
  too: it is the corner the drag *began* on, which is a lattice point however many cells the drag
  went on to cross.
- **It resets to one on a shape change**, where the square path resets to four. The count means the
  same kind of thing under both and not the same number, and one drag meaning one diamond is the
  gesture as it was before the count reached it — a DM aiming a single tile must not have to
  correct a 4 first. Carrying 26 across from a whole-image square calibration would divide the next
  traced edge into slivers, which is the mistake `release` already refuses to make with a
  hand-drawn box.

One thing followed from it. `proposeWholeMap` now refuses under an isometric shape: `main.ts` calls
it on a freshly loaded image, and a map with a remembered isometric calibration is one where that
offer means nothing. It always meant nothing there — before the count reached the edge gesture it
merely meant nothing quietly, where now it would divide the image's bounds by a count.

### The 2:1 entry, which is the same gesture with the ratio pinned

Aiming half a tile edge decides the *ratio*, and being two pixels out on a forty-pixel edge leaves
the lattice 6% off — which is invisible under the first diamond and most of a cell of drift ten
cells later. But almost every isometric map anybody loads is drawn on a 2:1 tileset, so on that art
the ratio was never in question and only the size was. **`iso-fixed` is the select's third entry**:
the same edge drag, with the diamond's proportions pinned to `STANDARD_RATIO` and only its size
taken from the gesture.

**It is not a second lattice and it is not on the wire.** What it produces is an ordinary
`Iso { ratio }` with `ratio` equal to 2, so `MapInfo`, `gridBasis`, `fog::basis`, the calibration
shelf and the server's bounds are all untouched — nothing downstream of `gridFromEdge` can tell
which of the two gestures made a grid. It is a *client-side gesture*, not a state of the room, which
is why there is nothing in `RoomState` about it and nothing to persist.

The size comes from **projecting the drag onto the pinned edge** — the least-squares fit — rather
than from the drag's vertical alone. Half a tile height is the smaller and harder-to-aim of the two
components, so reading the size off it would throw away the better half of the gesture; with the
projection, a drag exactly along a tile edge gives exactly that tile and one a few pixels off gives
the same tile. `isoDiamond` is where that lives, and it is **the one place either isometric gesture
decides anything**: `gridFromEdge` builds the lattice from it and `drawCalibrationDiamond` draws it,
so the diamond the DM aims and the diamond that gets committed are one diamond by construction. That
mattered more here than under the free gesture, where the drawn diamond is the one under the pointer
anyway — under `iso-fixed` it deliberately is not, and two functions deriving it separately would
disagree invisibly.

Two smaller rules. The refusals differ, because **a pinned diamond cannot be lopsided**: a drag the
free gesture has to refuse for being twenty times as wide as it is tall is an ordinary cell under
this one, so it is not offered a reason that cannot apply to it. And `shapeFor` opens the panel on
the entry the board is already on, which for a 2:1 board is this one — re-opening on the free
gesture would offer to re-aim a ratio that is already right. It compares against a tolerance rather
than for equality, because the ratio has been through an `f32` and back.

The other standard is **true isometric** — a projected cube, edges at exactly 30°, ratio √3 — which
is what a rendered map gives you rather than what a tileset is drawn on. There is one preset because
a second one nobody picks is a menu; a map on any other projection is what the free gesture is still
there for.

And **an isometric drag has no play area in it**, which is the rule that was got wrong first time
and is worth stating plainly. `repreview` reads a play area off the dragged box, and for squares
that is right — the box is dragged *across* part of the board, so it is a region. The isometric
gesture is two points along one cell edge: a direction and a length, nothing more. Deriving a
region from it collapsed the playable area to a sliver the size of one diamond, so
`drawOutsidePlayArea` dimmed the entire board and `drawGrid`, which rules only inside that area,
drew a handful of lines in one corner. **The readout was perfect throughout**, which is what made
it hard to see and is why the guard for it is a brightness reading off the canvas in
`drive-isometric.mjs` rather than an assertion about the panel. Choosing a cell shape is not
choosing a playable region, so the isometric path leaves it exactly as it found it.

The overlay follows the same distinction. `drawCalibrationDiamond` draws **the one diamond the
dragged edge describes**, where the square path draws a box divided into cells. Drawing the square
affordance for an edge gesture tells the DM they are selecting a region, which is the wrong thing
to aim — and aiming is the whole difficulty here, because a floor tile on real isometric art is a
few dozen pixels across and the gesture is half of one.

### The transform paid for itself

Three places filled one `rect` per cell at a corner plus `grid_px`, and two stretched a
one-pixel-per-cell canvas over a rectangle. All five now push the basis as a canvas transform and
work in **cell units**, where one cell is the unit square whatever shape the lattice is — so
`cellPath` replaced three loops, and `fogRect` and `overrideRect` became identities and were
deleted. An affine transform of a per-cell raster is exactly correct, which is why the fog's
`drawImage` got *simpler* rather than harder.

Two things do not survive the transform, and they are the trap: `lineWidth` is in transformed units,
so `cellPath` hands back a `Path2D` to be stroked *outside* it, and so is any text.

`drawGrid` is the one place that got longer. It used to walk world coordinates ruling two families
of axis-aligned lines; the lines now lean, so the extent is taken in grid space — `gridBounds`, the
bounding box of the play area's four corners — and the play area does the trimming as a clip.
`firstLineAt` fell out of use and was deleted with its test.

**`gridBounds` is deliberately unrounded, and that is a bug fixed rather than a matter of style.**
Its two callers want different things: ruling the grid wants the whole-numbered *lines inside* the
rectangle, so it rounds inward; sweeping cells wants every cell the rectangle *touches*, so it
floors both ends. Rounding the low end up for the second takes a column off one side of a viewer and
not the other, which is exactly what `the circle is the same on both sides of the viewer` in
`solo.test.ts` caught when the two were briefly conflated.

### A token is an upright disc

`grid_px` still means the size of a cell — a square's side, a diamond's **height** — so
`grid.px * size / 2` goes on being a token's radius and `tokenAt` / `anchorTokenAt` are untouched.
A disc fits the diamond's short axis and reads as a creature standing on the tile rather than a
decal covering it, and portraits, name labels and hit point bars all stay upright and need no
thought. The alternative, squashing the footprint to match the diamond, makes hit-testing an ellipse
test that has to agree with what is drawn, and leaves the ring and the art disagreeing about shape.

`GridSpec` carries `px` alongside the two axes for that reason, and the comment on it is the rule:
**it is for sizing things that stand on the grid, never for placing them.** Anything that computes a
position from it is assuming squares. `minSpan` is what a legibility threshold or a step size wants
and `maxSpan` is what a wall cull wants; on a square grid all three are the same number, which is
why nothing needed to tell them apart before.

### Why the 2.5D version is refused

The flat lattice above is what "isometric support" cost. What people usually mean by the phrase —
tokens depth-sorted so they occlude correctly, walls with height, sprites anchored at their base —
is a different renderer, and the reasons are structural rather than budgetary:

- **`Wall` is a 2D segment in image pixels with no height**, and it is the type the raycast, both
  lighting modes, the tracing tool and the override flood are all built on. Giving it a third
  dimension is not additive.
- **Fog aligned to the floor lattice would be visibly wrong.** In isometric art a wall occupies
  screen space *above* its floor footprint, so clearing a room's floor leaves the tops of its walls
  dark — or reveals wall tops the floor has not earned. Fixing that means giving fog a height model
  too.
- **Hit-testing would stop matching what is drawn.** A base-anchored sprite with vertical extent is
  not a disc around a grid centre, and `mirror.ts` and `solo.ts`, which re-derive the board
  client-side, inherit all of it.

If it is ever wanted it needs its own milestone and its own argument. It is not more of this.

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

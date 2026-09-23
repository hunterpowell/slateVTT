# Maps

The two map slots, the map library, the DM's preview mode, and the backdrop. The backdrop is in
this file because what defines it is that it isn't a map.

Read this before touching `maptool.ts`, `calibrate.ts`, `library.rs`, `library.ts`,
`drawBackdrop`, `shownBackdrop`, `SetMap`/`MapInfo`/`SetBackdrop`/`Prepared` on the server,
`RoomState::shelve` or `library::destination`. **The rule that a `SetMap`'s URL decides between
loading and recalibrating is depended on by four features, and it's the arm that gets missed.**
Also read it before touching `fog::basis`, `gridBasis`/`shapeOf`, `gridFromEdge` or `GridShape`:
see *The shape of a cell* below. The two `basis` functions are the same statement written in two
languages.

## Maps and the map library

The DM picks a map from the repository's `maps/` folder instead of uploading it again each
session: list what's there, then pick one by path. The directory is `SLATE_MAPS`, defaulting to
`../maps` the way `SLATE_CLIENT_DIR` defaults to `../client`.

A pick is a copy into the uploads directory, not a second way to serve files. The copy's name
is deterministic, so picking the same map twice gives the same file and URL instead of a duplicate
per pick. The name is a readable slug of the relative path with a short hash appended. The slug is
there because `%LOCALAPPDATA%\Slate` is meant to be browsable; the hash is there because two
different paths can produce the same slug and would otherwise collide onto one file without any
error. After the copy, everything works as it does for an upload: there's one kind of map URL, and
`%LOCALAPPDATA%\Slate` stays a complete backup by itself. Serving `maps/` directly would break that
without anyone noticing.

What the hash is taken over is up to the caller, and the libraries differ on it. `copy_name` takes
a fingerprint beside the key, and `Library::names_by_content` decides which. A map hashes its path;
a portrait hashes its bytes. *The portrait library* in `docs/tokens.md` says why. Read the rest of
this section before considering the same for maps.

Listing and picking are DM-only, authenticated with the same secret header as uploads. A player
who could list the maps folder would see the next dungeon in devtools. That's invariant 4's concern
even though no room state is involved.

A client-supplied path reaches the filesystem in two places, a pick and an add (see *Adding and
removing* below). Uploads used to avoid the problem by generating their own name, which a library
pick can't do. A pick canonicalises the requested path and confirms it resolves inside the maps
directory before opening it. Remember that Windows separators are in play.

Grid calibration is remembered per map URL, so a map used before comes back already calibrated.
It's server-side only and never sent: the room applies the remembered values when the map is set
and sends the finished `MapInfo`, so there's no new client state and no new message.

**A `SetMap`'s URL alone decides whether it loads a map or recalibrates one.** A URL the room isn't
already showing is a load, and a remembered calibration for it overrides whatever the client sent.
A URL matching the current map is a recalibration: applied as given, and recorded. Recording
happens there and on a load of a map with nothing remembered yet, never on a load where a
remembered calibration was used. Without that split the two halves of the feature cancel out: a
remembered calibration would overwrite every attempt to correct it, and no map could be
recalibrated twice.

The table is persisted with the room. Slate only runs while the group is playing, so an in-memory
table would be empty every game night and the feature would never fire. It was the first thing on
`Saved` that isn't part of any client's view of the room, and it stays off `RoomView` for the same
reason walls do. Since milestone 31 it remembers the walls and the fog paint too (see *The shelf*
below).

Since milestone 32, uploading is adding to the library. It used to be its own route: the bytes
went into `uploads/` under a fresh UUID. An uploaded map therefore matched no earlier calibration,
couldn't be found again next session, and uploading the same file twice gave a second URL with a
second set of walls. This file used to defend that asymmetry as intended; once the folder could be
written to, it wasn't worth defending. The upload button now writes into `maps/` and then picks what
it wrote, so an uploaded map is a library map in every respect. The problem that remains is the one
below about names: the copy is named from the path, so replacing a map's art still does nothing.

There's one route family now, `/api/{library}` with `pick`, `add` and `remove` under it, and one
client widget behind every library panel. `Library::named` turns the path segment into the folder,
which collapsed twelve operations into four handlers.

The calibration table is why a map is named from its path. Replacing a map's art in `maps/`
therefore does nothing: the pick computes the same name, finds the copy already written, and serves
the old bytes. That's a real flaw, and it's the cheaper side of the trade. Naming a map by its
contents would give every recalibrated map a new URL and orphan every calibration the DM has made.
Fixing it properly means migrating that table, not flipping `names_by_content`. Two tests enforce
this: `a_picked_map_keeps_the_name_it_has_always_had` asserts both the empty prefix and the path
fingerprint, and `a_replaced_portrait_is_a_new_copy_and_a_replaced_map_is_not` checks the
asymmetry from both ends.

There are four libraries now (`maps/`, `portraits/`, `backdrops/` and `tracks/`) with one
implementation. `portraits/` was the second, the same feature over token art (see *The portrait
library* in `docs/tokens.md`); backdrops are below and tracks are in `docs/sound.md`. What a library
differs by is on `Library` in `main.rs` and in two arguments to `createLibraryList` in
`library.ts`: the folder, the size cap, the noun in the refusals, the prefix and fingerprint below,
and (since tracks) which formats it accepts. `library.rs` itself never learns there's more than one.

The second library added two rules, and both are about what a copy's name is derived from. The key
gets a prefix, or the same filename in two folders would resolve to one file. And the copy is
fingerprinted by content, or replaced art would keep resolving to the copy it replaced. **Maps
opt out of both**, because the calibration table is keyed on the URLs their names produce.

### Adding and removing

**There are two rules for an add's name, and the first is where the risk is.** The name must be a
single path component. One holding a separator is refused outright, rather than having its last
segment taken, because taking the last segment would accept `../../evil.png` by treating it as
something else. That's stricter than a pick, which may name a file in a subdirectory and is checked
against the canonicalised root: an add can't leave the folder at all, where a pick is checked after
the fact. The second rule is Windows: the characters it reserves, the device names it still
resolves ahead of files, and the trailing dots and spaces it strips. A file written under a
different name from the one the DM typed is one they then can't remove by giving that name.

The extension comes from sniffing the bytes, never from the supplied name. The name decides what
the picker shows and what the copy's key is derived from; the bytes decide how the file is served.

A name already taken is refused, not overwritten. A filesystem has no undo, and for a map an
overwrite wouldn't even do what it looks like: the copy is named from the path, so the old bytes
would keep being served under the same URL.

A remove deletes the library file and nothing else. The copy in `uploads/` stays, so the map on the
board, the remembered calibration, and the walls and paint on the shelf all stay too. Removing
something from the picker means "stop offering me this", and re-adding a file under the same name
later lands on the same URL and finds all of it still there. That's what makes a
destructive-sounding button safe, and it follows from a pick being a copy.

`add` finishes by calling `pick` on the file it just wrote. Having one path from "a file in the
library" to "the URL it's served at" guarantees that an add and a later pick of the same file
agree. That matters more than the wasted re-read, because everything keyed on that URL is keyed on
both.

## The shape of a cell

A map's cells are squares or isometric diamonds. `GridShape` on `MapInfo` says which, and it's
remembered per URL with the rest of the calibration, so an isometric town and a square dungeon can
sit in the same folder and the DM never has to remember which is which. **`Square` is the
default.** That's invariant 2 at work: a save written before the field existed describes exactly
the board it always did. Any other default would put every token on every saved map somewhere new.

It's flat, and the feature stops there: a diamond lattice, not a 2.5D renderer. No depth sorting,
wall height, sprite anchoring, elevation or occlusion. Tokens are still upright discs, `Wall` is
still a segment in image pixels with no height, and tokens still draw in list order. Read *Why the
2.5D version is refused* below before adding to any of that.

### An isometric grid is an affine transform of a square one

That's why this was a small change. A diamond lattice is the square lattice with a 2×2 matrix
applied, so everything expressed in grid space already worked for either lattice and wasn't
touched: `snap_to_cell`, `covered_cells`, `shape_covers`, `contains_point`, `line_cells`,
`with_fringe`, the fog packing, `snapOrigin`/`snapExtent`, `feetMoved`, `trailCells`, both
`Diagonals` rules, and all the wall segment math. What changed was five functions and the code that
draws.

The five functions are the whole conversion between grid and pixels: `grid_to_px`, `cell_of` and
`cell_centre` in `fog.rs`, and `gridToWorld`/`worldToGrid` in `coords.ts`. `fog::basis` and
`gridBasis` are the only two places that read which variant a map uses, the same way `sight_cells`
is the only reader of `Lighting`. They're the same statement in two languages, and if they disagree,
the fog the server packed lands a cell away from the walls that cast it. `drive-isometric.mjs` is
what checks they agree once a real frame has crossed the socket, because nothing else can see that.

The raycast needed no structural change, which was unexpected. Both fog algorithms already tested
the radius in cells and used pixels only for wall intersection (`visible_cells` has a comment
saying so). Only the once-per-source wall cull changed, from `grid_px` to `px_per_cell`, which is
the basis's largest singular value. On a square grid that's exactly `grid_px`, so the culls drop
exactly the walls they always did. `|u| + |v|` would also be safe, but on a square grid it's
`2 * grid_px`, which would halve the culling on every map without anyone noticing.

`MapInfo` is the only thing on the wire that changed. No new `ClientMsg` or `ServerMsg` variant,
`protocol-tags.json` untouched, and `Cell`/`Pos`/`Px`/`Wall`/`FogView`/`OverrideView` all
unchanged. `Prepared` wraps `Calibration`, which is where the shape lives, so an isometric map is
remembered on the shelf with everything else at no extra cost.

### One dragged edge, not two

The DM drags along one edge of one diamond, corner to corner, and `gridFromEdge` reads that vector
as half a cell's width across and half its height down. The second axis is the first mirrored
about the vertical, because real isometric art is symmetric and a second gesture would add nothing.
A free basis could express oblique lattices that no map anyone loads actually uses, at the cost of
a second drag and a `Default` with no correct answer: "square" depends on `grid_px`, a sibling
field. That's also why the wire carries a descriptor of the shape and each side derives the basis
from it.

It also meant the gesture needed nothing new on the canvas. `input.ts` hands over the same box
either way, and the chosen shape decides whether it's read as a rectangle of squares or as one
diamond's edge. The square path (the box drag, the cell count, "use the whole image") is unchanged
and still produces `Square`.

Three panel rules came with it. The whole-image shortcut is hidden under isometric, because it
proposes a region (the image's own bounds as the reference box) and an edge gesture has no region.
This is the rail's rule against offering a control that can do nothing, applied inside one panel.
Changing the shape **abandons the drag** instead of reinterpreting it: a box read as four squares
and the same box read as one diamond's edge are different claims about the map, and carrying the
drag across would make the second claim for the DM without telling them.

*(The cell count was hidden here too at first, on the grounds that it answered "how many squares
across" and an edge gesture didn't ask that. That was wrong; see below.)*

### The count applies to both gestures

It's often easier to trace the whole edge of a room and say how many tiles that was than to aim at
one tile and have any error multiplied across the map. So the edge gesture takes the same count as
the box gesture, and `gridFromEdge` divides the drag by it.

The count answers "how many cells did that drag cross", which both gestures ask. Only the
whole-image shortcut belongs to the square path alone. The first version hid both because they sit
in one row, which is a layout fact, not a reason. `#map-count` is no longer something the tool
keeps a reference to, and `wholeMap` is hidden by itself.

Three things make the count fit the edge gesture:

- The overlay draws the whole chain. `drawCalibrationDiamond` draws `cells` diamonds along the
  drag, the edge gesture's version of the divisions the square path draws inside its box. With the
  right count they land on the tiles printed on the art, and a wrong count is visible along the
  whole run instead of hidden in one tile and multiplied later. That's most of why the long gesture
  is easier, so drawing one diamond and dividing without showing it would have lost the reason for
  building this.
- It only divides. Both readings are linear in the drag, so `isoDiamond` divides the vector once
  at the top and the pinned shape's projection is unaffected: a run of four is exactly the same
  statement as one edge of the same cell, under either shape. The anchor doesn't change either. It's
  the corner the drag started on, which is a lattice point however many cells the drag crossed.
- It resets to one on a shape change, where the square path resets to four. The count means the
  same kind of thing under both shapes but not the same number, and one drag meaning one diamond is
  how the gesture worked before it had a count. A DM aiming at a single tile shouldn't have to
  correct a 4 first. Carrying 26 over from a whole-image square calibration would divide the next
  traced edge into slivers, which is the mistake `release` already refuses to make with a
  hand-drawn box.

One thing followed from this. `proposeWholeMap` now refuses under an isometric shape. `main.ts`
calls it on a freshly loaded image, and on a map with a remembered isometric calibration that offer
means nothing. It always meant nothing there; before the edge gesture had a count, it just did
nothing visible, where now it would divide the image's bounds by a count.

### The 2:1 entry: the same gesture with the ratio pinned

Aiming at half a tile edge sets the ratio, and being two pixels out on a forty-pixel edge leaves
the lattice 6% off. That's invisible under the first diamond and most of a cell of drift ten cells
later. But nearly every isometric map is drawn on a 2:1 tileset, so on that art the ratio was never
in question, only the size. `iso-fixed` is the select's third entry: the same edge drag, with
the diamond's proportions pinned to `STANDARD_RATIO` and only its size taken from the gesture.

It isn't a second lattice and it isn't on the wire. It produces an ordinary `Iso { ratio }` with
`ratio` equal to 2, so `MapInfo`, `gridBasis`, `fog::basis`, the calibration shelf and the
server's bounds are all unchanged. Nothing after `gridFromEdge` can tell which gesture made a grid.
It's a client-side gesture, not room state, so there's nothing in `RoomState` about it and nothing
to persist.

The size comes from projecting the drag onto the pinned edge (the least-squares fit) rather than
from the drag's vertical component alone. Half a tile's height is the smaller and harder-to-aim
component, so reading the size off it would throw away the more accurate half of the gesture. With
the projection, a drag exactly along a tile edge gives exactly that tile, and one a few pixels off
gives the same tile. `isoDiamond` is where that's computed, and **it's the only place either
isometric gesture decides anything**: `gridFromEdge` builds the lattice from it and
`drawCalibrationDiamond` draws it, so the diamond the DM aims and the diamond that gets committed
come from one function. That matters more here than under the free gesture, where the drawn diamond
is the one under the pointer anyway. Under `iso-fixed` it intentionally isn't, and two functions
deriving it separately could disagree without it being visible.

Two smaller rules. The refusals differ, because a pinned diamond can't be lopsided: a drag the free
gesture refuses for being twenty times wider than it is tall is an ordinary cell under this one,
so it isn't given a reason that can't apply. And `shapeFor` opens the panel on the entry the board
already uses, which for a 2:1 board is this one; reopening on the free gesture would offer to
re-aim a ratio that's already right. It compares within a tolerance rather than for equality,
because the ratio has been through an `f32` and back.

The other standard is true isometric: a projected cube with edges at exactly 30° and a ratio of
√3, which is what a rendered map uses rather than what tilesets are drawn on. There's one preset
because a second one nobody picks is just a longer menu. A map on any other projection is what the
free gesture is still there for.

**An isometric drag has no play area in it.** This rule was got wrong the first time. `repreview`
reads a play area off the dragged box, and for squares that's right: the box is dragged across part
of the board, so it's a region. The isometric gesture is two points along one cell edge, a direction
and a length and nothing more. Deriving a region from it shrank the play area to one diamond, so
`drawOutsidePlayArea` dimmed the entire board and `drawGrid`, which only draws inside that area,
drew a few lines in one corner. The readout was correct the whole time, which made it hard to spot.
That's why its guard is a brightness reading off the canvas in `drive-isometric.mjs` rather than an
assertion about the panel. Choosing a cell shape isn't choosing a play area, so the isometric path
leaves the play area as it was.

The overlay follows the same distinction. `drawCalibrationDiamond` draws the one diamond the
dragged edge describes, where the square path draws a box divided into cells. Drawing a box for an
edge gesture tells the DM they're selecting a region, which is the wrong thing to aim at. Aiming is
the hard part here: a floor tile on real isometric art is a few dozen pixels across, and the
gesture covers half of one.

### The transform simplified the drawing code

Three places filled one `rect` per cell at a corner plus `grid_px`, and two stretched a
one-pixel-per-cell canvas over a rectangle. All five now apply the basis as a canvas transform and
work in cell units, where a cell is the unit square whatever the lattice shape. `cellPath`
replaced three loops, and `fogRect` and `overrideRect` became identity functions and were deleted.
An affine transform of a per-cell raster is exactly correct, which is why the fog's `drawImage` got
simpler rather than harder.

Two things don't survive the transform, and they're easy to get wrong: `lineWidth` is in
transformed units, so `cellPath` returns a `Path2D` to be stroked outside the transform, and text
has the same problem.

`drawGrid` is the one place that got longer. It used to walk world coordinates drawing two sets of
axis-aligned lines. The lines now lean, so the extent is computed in grid space (`gridBounds`, the
bounding box of the play area's four corners) and the play area trims them as a clip. `firstLineAt`
fell out of use and was deleted with its test.

**`gridBounds` is unrounded on purpose, to fix a bug.** Its two callers want different things.
Drawing the grid wants the whole-numbered lines inside the rectangle, so it rounds inward; sweeping
cells wants every cell the rectangle touches, so it floors both ends. Rounding the low end up for
the second takes a column off one side of a viewer and not the other, which is what
`the circle is the same on both sides of the viewer` in `solo.test.ts` caught when the two were
briefly merged.

### A token is an upright disc

`grid_px` still means the size of a cell (a square's side, a diamond's height), so
`grid.px * size / 2` is still a token's radius and `tokenAt`/`anchorTokenAt` are unchanged. A disc
fits the diamond's short axis and reads as a creature standing on the tile rather than a decal
covering it, and portraits, name labels and hit point bars all stay upright with no extra work. The
alternative, squashing the footprint to match the diamond, makes hit-testing an ellipse test that
has to agree with what's drawn, and leaves the ring and the art disagreeing about shape.

`GridSpec` carries `px` alongside the two axes for that reason, and its comment states the rule:
**`px` is for sizing things that stand on the grid, never for placing them.** Anything that
computes a position from it is assuming squares. `minSpan` is what a legibility threshold or a step
size wants, and `maxSpan` is what a wall cull wants. On a square grid all three are the same number,
which is why nothing needed to tell them apart before.

### Why the 2.5D version is refused

The flat lattice above is what "isometric support" cost. What people usually mean by the phrase
(tokens depth-sorted so they occlude correctly, walls with height, sprites anchored at their base)
is a different renderer, and the reasons are structural, not a matter of time:

- `Wall` is a 2D segment in image pixels with no height, and the raycast, both lighting modes,
  the tracing tool and the override fill are all built on it. A third dimension can't just be added
  alongside.
- Fog aligned to the floor lattice would look wrong. In isometric art a wall occupies screen
  space above its floor footprint, so clearing a room's floor leaves the tops of its walls dark, or
  reveals wall tops the party hasn't seen. Fixing that means giving fog a height model too.
- Hit-testing would stop matching what's drawn. A base-anchored sprite with vertical extent isn't
  a disc around a grid centre, and `mirror.ts` and `solo.ts`, which re-derive the board on the
  client, inherit all of it.

If it's ever wanted, it needs its own milestone and its own argument. It isn't an extension of this.

## The shelf

Milestone 31. It's the calibration table above with two more fields, not a new subsystem. The
request was "I'd like to save map states and prep a handful of maps before a session": the DM
traces three dungeons on a Tuesday and finds all three still traced on Saturday.

`Calibration` already covered most of that: grid, offset, play area, fog, radius and lighting,
keyed by URL, persisted, never sent. The only prep it didn't remember was the traced walls and the
painted overrides, both of which a map load threw away. So the feature is one table entry growing,
and two things to get right:

- the outgoing board's walls and paint are filed under **its own** URL as it stops being the board
- the load arm restores them, the same way it already restores the grid

No new command, no new event, no list in the state model, no panel UI, no `staged` flag on the
wire, and no filter to widen: walls already reach the DM or nobody, which is what made milestone 20
cheap too. The collection of prepared maps is the `maps/` folder, as with backdrops: the room
holds only what it has learned about each one.

### A wrapper, not two more fields on `Calibration`

```rust
struct Prepared { calibration: Calibration, walls: Vec<Wall>, overrides: OverrideView }
calibrations: HashMap<String, Prepared>
```

`Calibration` is what the client sent; the room builds one as a bare struct literal from the
`SetMap` fields. What the room has learned about an image is a different thing, and keeping them
apart means the first trap below can't be written, rather than just being avoided. The calibration
is `#[serde(flatten)]`ed, so the disk shape is what it always was with two keys beside it, and a
save from before this milestone loads as a calibrated map with nothing traced on it. `StagedView`
uses the same technique for the same reason. (`Calibration` derives `PartialEq` and `Wall` doesn't,
so merging them would have meant changing one of them anyway.)

### Three traps, and the first is silent

- The recalibration clobber. `SetMap`'s record step runs on every recalibration, not only on a
  first load. With the walls inside `Calibration`, the obvious way to write that arm files *empty*
  walls, so adjusting the grid on a traced dungeon erases what the room remembered about it. The
  board keeps its walls, because a recalibration doesn't sweep, so nothing looks wrong until the DM
  loads another map and comes back. With the wrapper, the record step assigns
  `prepared.calibration` and can't reach the rest.
  `nudging_the_grid_does_not_erase_what_the_room_remembers` tests it.
- `sweep_board` can't tell which map it's sweeping, so the URL is passed in. Its two call sites
  assign the map in opposite orders (a `SetMap` assigns and then sweeps, a promote sweeps and then
  assigns), so `self.map.url` inside it is the incoming map on one path and the outgoing one on the
  other. Filing a dungeon's walls under the name of the map that replaced it puts them back on the
  wrong image.
- The staged slot is a second place that writes to the shelf, with a different shape. Staged
  walls never reach `sweep_board`; they're dropped where the load arm takes the slot, and again in
  `ClearStaged`. All three go through `RoomState::shelve`, which takes the board's walls and paint
  as arguments because the three callers hand over different boards.

**What's filed is whatever the board actually holds, including nothing.** A DM who cleared a bad
trace and then loaded away has cleared it. Filing only non-empty lists would make it impossible to
start a trace over, and `ClearWalls` is how prep gets thrown away.

`ClearStaged` files too, and that's required, not an extra. The shelf is keyed by image, not by
slot, so which of the two exits the DM took mustn't change what next week's load finds.

### Two omissions, and the second is the boundary

- Token plans. `staged_pos`/`staged_only` are on `Token`, one per token, and stay tied to
  whatever is in the staged slot. The DM preps *terrain* for many maps and *the encounter* for the
  one they're about to run.
- `revealed` isn't remembered. Returning to a dungeon means the party explores it again. The
  rule is **the DM's preparation is remembered and the party's play state isn't**. Remembering where
  they had walked would make a map swap a partial scene restore, which immediately raises "why not
  the token positions too", and that leads to the scene system this project refuses.
  `the_party_re_explores_a_dungeon_they_return_to` tests that boundary.

### Consequences worth knowing

There's no frame-cap question here. It's worth saying because `CLAUDE.md`'s rule that a
command carrying a collection has two limits looks like it should apply. This table never goes on
the wire. `MAX_WALLS`, applied where a wall is traced, is the only limit, and nothing here needs a
`largest_..._fits_in_a_frame` test.

**Staging the map that's already live reads from the shelf, not from the board.** The staged slot
holds no URL, so filling it is always a load, and a load restores what was last *filed* for that
image. That's older than what the live board holds, since the shelf is written when a board is
replaced. It's an odd thing to do and not worth a special case; the walls the DM is looking at
belong to the live board and aren't touched.

The undo ring's main motivating case is weaker now, and `docs/undo.md` says so. "The case that
makes undo worth having is `sweep_board`" was written when a map load destroyed half an hour of
tracing, and a load that restores the walls on the way back in is much less costly. The ring is
still justified by its other reasons.

## Staged maps

`staged: Option<StagedBoard>` is the map the DM is preparing while the table still looks at the
current one, together with the walls and fog overrides prepared on it. Promoting moves all
three onto the live board and empties the slot. There's one slot, not a list: a full scene system
(several maps each with its own geometry) is a much larger feature and isn't being built.

The bundle is milestone 20, and it's worth knowing what it gained before adding a fourth thing to
it. **One `None` withholds the whole slot.** `snapshot_for` has one arm; `Event::StagedChanged`
carries the whole board, so a staged load that sweeps its walls needs no frame of its own; and
there's no second staged field for a later milestone to add and forget to filter. The in-memory
type and the wire type differ in one field: the overrides are a `HashMap<Cell, Override>` in the
room and a packed rectangle on the wire, as the live board's are. That's `StagedBoard` and
`StagedView`, the same split as `RoomState`/`RoomView` and `Token`/`TokenView`.

On disk, the map is `#[serde(flatten)]`ed inside it, and that matters for loading old saves. A save
from when this was an `Option<MapInfo>` holds the map's fields directly under `staged`, which is
exactly where flatten reads them from, so an older room comes back with its staged map intact and
two empty lists beside it. Nested under a `map` key, every one of those fields would read as
missing, `MapInfo::default()` would fill in, and the DM's next-map tab would open on a blank image
with nothing saying a map had been lost. There's a test named for it.

This was the first thing the visibility filter withheld based on who the recipient is. It's
absent from a player's `snapshot_for`, and `Event::StagedChanged` becomes a message for a DM
recipient and `None` for everyone else. The filter arms before it dropped a message because of
something the recipient *did*; this one drops it because of who they are. `hidden` tokens and hit
points used the same approach next, and fog after that. See *Hidden tokens, hit points, and the
light it carries* in `docs/tokens.md`, where the same idea had to apply to a field inside a
message rather than the whole message. A staged map that was sent to every client and just not
drawn would put the next dungeon in devtools, which is invariant 4.

`None` means both "nothing is staged" and "you're not the DM", so a client can't tell the two
apart. Staging is persisted for the same reason the calibration table is: Slate only runs while
the group is playing, so a map staged at the end of one evening for the next would otherwise be
gone before it was needed.

`SetMap` carries a `staged` flag instead of there being a second command. The flag names the
slot and nothing else. The rule that the URL alone decides between loading and recalibrating is
unchanged; it just runs against that slot's URL. An empty staged slot holds no URL, so filling it
is always a load, which is why a map arrives already calibrated the moment it's staged.
Calibrations are one table keyed by URL across both slots, so calibrating while staged means the map
arrives on the board correctly calibrated when it's promoted. `PromoteStaged` and `ClearStaged` are
refused when nothing is staged, the same way deleting a nonexistent token is refused.

On promote, tokens keep their grid coordinates and the DM repositions them. There's no sensible way
to carry a cell over to an unrelated image, and trying would move tokens for reasons nobody asked
for. The party's explored cells clear, which is already the rule for a new map. **The walls and the
overrides no longer do**: `sweep_board` clears the board's, and the staged board's take their
place. That's milestone 20, and it's the one thing a promote does differently from any other map
load.

`SetMap` into the staged slot follows the live slot's rules exactly, which is the argument for both
slots holding the same three things. A load sweeps that slot's walls and paint along with its
token plans, and a recalibration sweeps only the paint. Walls are in image pixels and still
trace the same painted line after the grid moves; an override is a cell whose square has just moved
out from under it. `docs/walls.md` has the table.

### Preview

Calibrating a staged map means looking at it, so the DM's client points the renderer at the staged
image while the table keeps seeing the live one. There's no separate preview toggle: the map
panel's `Map | Next map` switch decides which slot everything in the panel refers to, and selecting
a slot that holds a map is preview mode.

The client's `Scene` therefore holds two boards, live and staged, and everything that draws or
hit-tests reads `shownBoard(scene)` instead of the live one. That function is the entire
client-side feature. Without it, a staged calibration preview writes into the grid the table is
looking at.

`shownWalls` and `shownOverrides` are the same kind of function, added in milestone 20 for the two
things that sit beside a board rather than on it. The argument is the same: without one function
deciding which of the two to use, a single missing branch draws the next dungeon's walls across the
board the table is looking at.

Everything on the previewed board can be moved. Tokens drag, the token panel works, and a drag
writes the token's plan rather than its position (see *Preparing the next room* in
`docs/tokens.md`). Preview briefly showed tokens ghosted and refused to let them be grabbed, on the
grounds that what was on screen wasn't the board. That rule was dropped because a board where some
things can be moved and others can't is worse than either alternative.

Preview is client-only: no command, no event, nothing persisted, and nobody else can tell it's
happening. **The server doesn't know the DM is previewing and must not find out.** That's why
intent travels on each command (`SetMap`, `MoveToken` and `CreateToken` each carry `staged`)
instead of as a mode. It also means the server can't refuse an operation because the DM is
previewing; anything that shouldn't happen in preview is something the client doesn't offer.

Because preview is invisible to everyone else, the DM's own screen has to make it obvious.
Mistaking a staged map for the live board is the one way this feature goes wrong.

## Backdrop

A picture the DM shows the table instead of the board (a forest clearing, a campsite, the
inside of a tavern) for the parts of an evening with nothing to move and nothing to measure.
`backdrop: Option<String>` on `RoomState`, one command, one event, and nothing else.

### Why it isn't a map

The problem it solves isn't that there are only two slots. It's that loading a map is
destructive, and has to be. A `SetMap` with a new URL sets `loading`, which calls `sweep_board`:
the drawings go, the walls go, `forget_fog` clears everywhere the party had explored, and the DM's
paint goes with them. That's correct for a map (a new image is a new dungeon, and a wall traced on
the last one is a line across the middle of this one), but it would make showing a campfire between
two fights cost half an hour of tracing with no way back.

What the DM wants to show isn't a map. There's no grid on it, nothing stands on it, nothing is
traced across it and nobody explores it. Building it as a second board would pay for all of that
and use none of it. A *list* of such boards is the scene system the section above refuses: every
`staged` flag becomes a scene id, token positions fork per scene, and `snapshot_for` multiplies.

So it's one field. `apply`'s arm is an assignment and an event, and **that arm must stay that
short**: the board, its walls, its shapes and everywhere the party has been all stay untouched
behind the picture, so taking it down puts the table back exactly where they were.
`covering_the_board_leaves_the_encounter_exactly_where_it_was` in `room/tests/maps.rs` tests that,
and it's written as the counterpart of
`undoing_a_map_load_gives_back_the_walls_the_shapes_and_the_fog_together` in `room/tests/undo.rs`:
that one asserts a load destroys four things at once, and this one asserts a backdrop destroys none.

### The presets are the folder

`backdrops/` is a third `Library` beside `maps/` and `portraits/`, sharing all of their code; a
library differs only in the settings listed under *Maps and the map library*. It takes the
portraits' answer on both choices a library makes: a `backdrop/` prefix, and a name fingerprinted
by content. Nothing is keyed on a backdrop's URL, so replacing the art in the folder should replace
the picture. Maps opt out only because the calibration table is keyed on their names, and that
reason doesn't apply here.

That's also why "a few presets" costs nothing: the collection is the folder, and the room holds
one field saying which picture is up. A list in the state model would be a scene manager under
another name.

### On the wire and on the screen

It's unfiltered: `BackdropChanged` goes with `NamesChanged` and `FogChanged`, not with
`WallsChanged`. Who may put a picture up is a permission question; which picture it is isn't a
secret, since six people are looking at it. It's echoed to the DM who sent it, like the other
room-wide settings. Nothing is sent with it: no map, wall, shape or fog frame, and none is
needed, because the board is being covered, not changed.

On the client, `drawBackdrop` draws it instead of `render`, not as a layer inside it: screen
space, no camera, no grid, no hit test. `main.ts` returns from the frame before any of that runs,
so nothing can disagree with a board nobody can see. It's scaled to fit inside the window, unlike a
token's portrait, which is cropped to fill: the DM picked this image to be looked at, so letterbox
bars are correct and cropping isn't.

`shownBackdrop` is the fourth `shown*` function beside `shownBoard`, and it answers an earlier
question than the other three: they pick which board to draw, and this decides whether a board is
drawn at all. Its one branch is that **preview wins**. A backdrop is what the table is looking at,
and a DM previewing the staged map is asking to see the next dungeon. That's the case it exists
for: the party roleplays at the campfire while the DM traces the crypt they're about to walk into.
Without it the DM would have to take the picture off six other screens to get any work done.

The board stops responding through one CSS rule, `body.covered #stage { pointer-events: none }`,
rather than a guard in each handler in `input.ts`. With no pointer events delivered there's no pan,
drag, ping, door swing, sweep or cursor relay, and no handler has to remember to check. The panels
stay usable: the table can still roll initiative and talk while the picture is up, which is most of
why it's worth having.

The control is on the table tab, because a panel goes where its fields live and this is
room-wide `RoomState`, not `MapInfo`. It was the first control on that panel to arm anything: a
disclosure list rather than a canvas tool, so the `stop()` the panel gained is for tidiness, as on
the map and token panels, rather than required by the rail's rule.

`drive-backdrop.mjs` is the browser test. Its last two checks matter most: the board's pixels before
the picture went up and after it came down must be identical.

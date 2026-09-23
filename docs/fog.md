# Fog of war

What the party can see, and what they remember seeing. Milestone 15 added walls that nothing read;
fog is what reads them.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`fog.rs`, `fog.ts`, `solo.ts`, `mirror.ts`, `overrides.ts`, `fogtool.ts`, `unseen_by_table`,
`with_fringe`, `recompute_sight`, `sight_sources`, `refresh_fog`, or the `moves_sight` gate.**
Several of those are where a leak would go unnoticed, and the coordinate handling in `fog.rs` looks
like a mistake and isn't one.

This covers all of milestone 16: automatic line of sight in 16a, and the DM's manual override in
16b. The text separates the two wherever 16b changed 16a. Milestone 20 gave the staged board a mask
of its own but no fog (see *The staged board has a mask of its own* and *No staged fog*). Milestone
21 added a second way of lighting a map (see *Two lighting modes, and one question underneath*,
which is where to start if the question is why a room lit all at once).

## Three sets of cells, shared by the whole party

```rust
revealed:  HashSet<Cell>,             // everywhere the party's rays have ever reached
known:     HashSet<Cell>,             // that, widened a cell and masked — what the table is shown
visible:   HashSet<Cell>,             // where they have sight now, masked
overrides: HashMap<Cell, Override>,   // what the DM said about it anyway
```

Three sets, and only one of them on disk. `revealed` is the memory and holds rays only. `known` and
`visible` are derived, rebuilt together by `recompute_sight`, and are what everything downstream
reads. Nothing outside that function reads `revealed`; doing so is how a blacked-out room comes back
onto the table's board.

**Terrain is gated on `known`, creatures on `visible`.** A room the party walked through an hour ago
stays on their screen, dimmed, because they remember its shape; anything that has wandered into it
since doesn't show. This split is what makes fog playable. A board that forgets the corridor behind
you can't be navigated.

`visible` is a subset of `known`, because everything that builds `known` only adds to what `visible`
is made of. That matters: it lets one character per cell describe both facts, which is what
`FogView` does (below).

**Fog is party-shared, not per-player.** One set of each, the union over every player-owned token.
Five people narrating to each other on Discord get nothing from per-player fog but confusion and
five times the state, and the DM would have to reason about five answers to "can they see this".

Vision comes from tokens a player *owns*, so handing a token over grants sight with no extra rule,
and taking it back removes it. A player's own token is always visible to the table. It would be
anyway, since it's a vision source and lights the cell it stands in, but `in_sight` also returns
true for it directly, so a token handed over mid-fight doesn't depend on the recompute having run.

Since milestone 39, vision also comes from **lights**: a radius on any other token, which counts
only when the party can see that token. See *Light sources*. Nothing between here and that section
changes because of it, since the gate is applied to the source list and nothing downstream knows
there are two kinds of source.

`party_sources` asks `Token::unseen`, not `unseen_by_table`: what the party can see can't be an
input to computing what the party can see. `sight_sources` asks the same of a light, then asks a
second question that *is* about what the party can see. That's the one place in this file where the
order matters.

## One cell of fringe, so the wall is on the board

`known` is not `revealed`. It's `revealed` widened by one cell in every direction, which is
`with_fringe` in `fog.rs`.

It exists to put the wall on screen. `snapToCorner` puts a traced wall on the corner lattice, so it
runs *between* cell centres, and the last cell a ray reaches is the floor square inside the room.
If the DM traced along the inner face of the wall (the natural way to trace one), the drawn wall is
past that cell, and fog that stopped at the rays would show the table floor, then nothing. Rooms
would read as holes, and the thing a player looks at to work out where they are is the one thing
the board wouldn't draw. One cell of fringe puts the wall on their screen.

**It is a set operation and knows nothing about walls.** The fringe lands in every direction, not
only across masonry, so it also reaches one cell further down an open corridor: `vision_ft` plus a
square, for terrain. That reads as the corridor ahead fading rather than cutting off, and it's why
this is ten lines. Asking the raycast which cells it was *blocked* into would need a second return
value from `visible_cells`, for a picture nobody could tell apart.

Eight neighbours, not four, because a four-neighbour ring leaves a notch out of every room corner,
which is more visible than what the fringe fixes. It's clipped to the board with `cell_on_board`,
the same bound the sweep uses and for the same reason: the void off the edge isn't somewhere the
party explores, and a cell out there would sit in the packed rectangle from then on.

Only `known` is built through it. The two exclusions are what keep it safe:

- **Never `visible`.** Creatures are gated on `visible`, so a fringe there would hand the table an
  ogre pressed against the far side of a wall. Terrain widens; sight doesn't.
  `a_creature_standing_in_the_fringe_is_still_not_on_the_tables_board` tests it.
- **Never `revealed`.** Memory is rays only. The next section makes the same argument about the
  overrides, which once got it wrong. A fringe cell written into memory would be baked into the save
  file, survive the wall being retraced around it, and outlive the ray that never cast it.
  `the_fringe_is_derived_and_never_reaches_the_save_file` tests it.

So the fringe is a mask like `Explored`, applied on the way into `known` and recomputed from
`revealed` every time. Two things follow without being separately decided: `Dark` still wins,
because the override loop runs after the widening; and a recalibration removes the fringe along with
the memory it was derived from, since there's nothing of it to sweep.

The cost is a one-cell strip of map art, terrain only: the far side of a shut door becomes ground,
and the party sees the near edge of a room they haven't entered. That was weighed, and it's smaller
than it sounds. Players already read the floor plan off the edge of the fog (see *`FogView`*), and
this moves that edge out by one square.

## The DM's override: a mask, never a write

`overrides` is 16b, and its shape is the thing to understand before touching any of it.

```rust
enum Override { Explored, Lit, Dark }   // `Auto` is the absence of an entry
```

**It is applied after the raycast and never writes into `revealed`.** A manual hide that just
cleared the memory would be undone the next time a torch was carried past, and the failure would
look like a raycast bug rather than a missing feature. So the override is its own state, and
`recompute_sight` folds it in every time:

```
revealed ∪= rays                                        // memory: rays only, and persisted
visible   = rays ∪ Lit − Dark                           // in sight now
known     = fringe(revealed) ∪ Lit ∪ Explored − Dark    // shown as terrain
```

`rays` is whatever `sight_cells` returned: the raycast on a `Dynamic` map, the flood unioned with it
on a `Room` one. Nothing from here on asks which, except *Two lighting modes*.

`Lit` and `Explored` are floors and `Dark` is a ceiling, applied to both derived sets and never to
the stored one. `visible ⊆ known` still holds, because `fringe(revealed) ⊇ revealed ⊇ rays` and the
mask does the same thing to both; the one-character packing depends on it. The first of those
holds because `with_fringe` inserts each input cell before it checks the board, so the superset
doesn't depend on where some other bound clipped.

`Auto` is the absence of an entry rather than a fourth variant, so "not overridden" has one
representation and `recompute_sight` has no arm that does nothing.

### 16b said this and did not do it

Kept because the description above was already in this file while the code did the opposite.
`recompute_sight` used to run `revealed = (revealed ∪ visible ∪ Explored) − Dark`. With `revealed`
persisted and cumulative, that is **a write, not a mask**, in both directions:

- An `Explored` or `Lit` cell entered the memory and stayed there when the paint was cleared, so a
  ground-fill was permanent. Combined with the fill leaking through a chamfered corner (see *A cell a
  wall runs through is a dead end*), one click handed over an entire dungeon with no way back short
  of reloading the map. That's how it was found.
- A `Dark` cell was subtracted from the memory, so lifting a blackout didn't give back the corridor
  the party had walked down to reach it.

The old version needed a careful order between the two loops for that reason: `Dark` had to leave
`visible` before the union into `revealed`, or a blacked-out cell entered the party's memory by the
back door. That ordering is gone along with the write it protected. Nothing but a ray reaches
memory, a cell holds at most one override, and one `match` arm settles both derived sets, so there's
no order left to get wrong.

A save written before the fix loads unchanged and keeps whatever an override baked into it;
`ResetFog` (below) clears it out.

**`Explored` does not demote a cell the rays already lit.** "Show them the room but not the ambush
in it" would be a fifth state, and that's what `hidden` is for.

### Two answers, not a fourth question

The roadmap asked for the override to land as *a different answer from `in_sight`* rather than as
another clause, and it does. `Dark` subtracts from `visible`, so `in_sight` (which asks whether any
cell a token covers is in `visible`) says no by itself, and the token leaves the table's board by
the same path `hidden` has used since milestone 11. `Lit` adds to `visible` and gets a yes the same
way. **`unseen_by_table` is still one line**, and nothing downstream of it knows overrides exist.

Two consequences follow:

- **A `Lit` cell is not a vision source.** It lights that cell; no rays are cast from it.
- **`Dark` does not take a player's own token off their screen**, because `in_sight` returns true
  early for anything they own. The party walks into a blacked-out room and still sees themselves on
  a black field. Removing the party from their own board would be worse than the darkness it was
  meant to show.

### It travels like the walls, not like the fog

`OverrideView` packs the same rectangle of characters as `FogView` (`#` forced dark, `o` forced
explored, `*` forced in sight, `-` no override), but it goes **to the DM or to nobody**. A player's
`snapshot_for` carries an empty one and `Event::OverridesChanged` produces no message for them, so
empty means both "nothing painted" and "you are not the DM".

That's the rule `WallsChanged` follows. The walls and the overrides are what the DM authored, and
the fog is what both of them produce. What the table gets is the `FogChanged` sent alongside, and
when the DM paints over ground nobody could see, there correctly isn't one.

The DM's own board draws the override as a tint over the wash, faint during play and stronger while
the panel is open. It's needed: on a board where a wall's shadow and a blacked-out room are both
just dark, the tint is the only thing that tells them apart, and without that the tool can't be
used with any confidence.

Unlike `visible`, the overrides are **persisted whole**. Sight can be derived from what the save
file already holds; what somebody decided can't be derived from anything.

### The staged board has a mask of its own

Milestone 20. `StagedBoard` holds a map, its walls and its overrides together, so the DM can black
out the ambush chamber on a Tuesday and the party is handed it already dark on Saturday, instead of
the DM painting it while six people watch the map load.

It works like the staged walls, and cost nothing here for the same reason: the override already went
to the DM or nobody, so a staged one gave nothing new a way to leak. `SetFogOverride` gained a
`staged` flag like the four wall commands, `OverridesChanged` gained one so the client knows which
mask it received, and `snapshot_for` withholds both boards' masks with the same `None` that already
withheld the staged map.

Three rules come with it, each the live board's:

- **A staged load clears the paint, and so does a staged recalibration.** Overrides are cells, and
  both a new image and a moved lattice invalidate them. These are the same two paths `sweep_board`
  and `SetMap`'s `reshaped` branch take for the live board. The staged walls are what differ: they're
  in image pixels and survive the recalibration.
- **A promote carries it across.** `sweep_board` still clears the live board's overrides, then the
  staged board's take their place. `refresh_fog` runs afterwards, so the mask applies the moment the
  map arrives.
- **`ResetFog` stays live-only and names no slot.** Half of it is forgetting where the *party*
  explored, and they haven't explored a map they haven't been shown. Over a preview it would mean
  "clear the paint", which is the `clear` brush over the whole board, so the button greys out
  instead.

### No staged fog

**Nothing raycasts the staged board.** There's no staged `revealed`, `known` or `visible`, and the
DM's screen draws no wash over the map they're preparing, only their own tint over the bare art.

A staged override is not a *preview* of what the party will see; it's what they'll be **handed**.
"Will they spot the dragon when the door opens" is a real question and a different feature: a second
raycast, needing the staged walls, the staged token plans and the radius. If it's ever wanted it is
client-only and costs the room nothing, since the DM's client already holds all three; `shape_covers`
is the precedent for a geometry rule written in two languages. Don't put it in the room.

The cost is that the DM paints a staged map with nothing under the tint to react to: no fog edge,
no shadow, just their own colour on the floor. The panel's hint says so in words, because the board
can't show it.

### The fill runs on the client

`ClientMsg::SetFogOverride` carries **the cells, not a seed to flood from**. The DM's client already
holds the walls and has to compute the fill anyway to preview it, so sending the previewed cells
makes the preview and the result the same data, rather than two runs of two implementations that
would have to agree. Nothing is being adjudicated (the DM may reveal whatever they like), so the
server has no answer of its own to defend, only a size to bound (`MAX_OVERRIDE_CELLS`) and a board to
clip against (`cell_on_board`, the same bound the sweep uses, for the same reason).

**`MAX_OVERRIDE_CELLS` is set by the frame size.** Because the command carries the cells, it grows
with the fill (one `[x,y]` pair each, up to twelve bytes at four-digit coordinates), so the count the
room refuses past has to fit inside `MAX_WS_MESSAGE_BYTES` or it's never reached. At first it
didn't: 50,000 cells against a 16 KiB frame meant any fill past roughly 1,700 cells killed the DM's
socket and reloaded their page, well within the "large dungeon room" this feature is for. It's now
8,000 against 128 KiB, `MAX_FILL_CELLS` in `fogtool.ts` mirrors it, and
`largest_override_fits_in_a_frame` asserts the pair. The general rule is in `docs/net.md`. The cost
here is that the two numbers move together, and a fill bigger than a level isn't worth widening the
socket for.

`fillFrom` in `overrides.ts` is not the raycast written twice. The raycast asks whether a viewer can
see a cell; the fill asks whether two cells are connected. They read the same walls but answer
different questions, and they don't have to agree: a fill that squeezes through a gap the DM traced
badly is what the preview is there to show before they commit. It uses four neighbours rather than
eight, the conservative choice: a fill that stops short costs a second click, and one that escapes
costs a repaint.

**Every traced segment bounds a fill, open or shut.** This is where the fill and sight part company,
and the one place in the project a door's state isn't read. 16b shipped it the other way round: the
fill borrowed `blocks()` and treated an open door as a way through. That was wrong for two reasons.
A dungeon traced for *sight* leaves its archways open on purpose, so no room reached through one
could be filled at all: the fill escaped into the whole connected map, and the only rooms that
worked were the few sealed by a shut door. And those stopped working the moment the party opened the
door, so the region a click selected depended on play-time state that has nothing to do with which
cells make up the room.

So an archway is traced as a door left open. It blocks nothing the party does and it bounds the
fill, which makes a room selectable without blinding a creature standing in the doorway. The rule
for the DM is *a fill is bounded by everything I traced*. The cost is that a room plus the corridor
past its open door takes two clicks, the same conservative choice as four neighbours.

### A cell a wall runs through is a dead end

The second thing 16b got wrong, and the cause of the leak described above. `crosses` was copied
from the raycast including its permissive ties, which is right for a *creature* (a viewer standing
on a wall isn't blinded by it) and says nothing useful about a step. A cell whose centre sat exactly
on a wall let the fill walk in from one side and straight out the other, because every step touching
that cell ties at one end or the other. One such cell is a hole.

These ties aren't rare. Corner-snapped masonry can't produce one: a wall on the corner lattice runs
*between* cell centres, never through them, whatever the grid offset. **A wall at 45 degrees runs
through a cell centre every other cell**, and a chamfered room corner is made of exactly those. So
the leak happened on carefully traced maps and not on boxy ones. The dungeon it was found on has
four such cells, and a fill from the middle of the party took 308 of the board's 368 squares,
including the void outside the building.

Such a cell really is half in and half out, and no single answer is right for it. So it is taken by
whichever fill reaches it, and expanded out of by none. That's `cutByWall`, checked once per cell as
it comes off the queue rather than folded into `crosses`, which stays permissive. This gets both
things right: a room's fill covers its own chamfered corner, so the DM gets no ragged square to
notice and paint over; and the fill can't get through the wall, because the way out is what's been
removed. Both sides may claim the same cell, which is the correct reading of a square the wall cuts
in half. On the dungeon above, the party's fill goes from 308 squares to 101 and reaches the image
border nowhere.

The seed isn't special-cased: clicking exactly on a chamfer fills that one square. It's an odd thing
to ask for, and letting it expand would put both sides of the wall into one fill.

**The raycast in `fog.rs` keeps the permissive tie and needs no equivalent.** A creature in a
doorway is a real case there, with tests named after it, and sight has no notion of walking through
a cell to reach the next one. The two are allowed to disagree, for the reasons above. (The `Room`
flood in `fog.rs` does have an equivalent, `cut_by_wall`; see *Two lighting modes*.) Worth knowing:
the same lattice fact reaches sight from the other side. A token standing on a 45-degree wall sees
through it, because that is the tie at `p` (see *A tie is answered the same way from both ends*)
applied to a case it wasn't designed for.

## Two lighting modes, and one question underneath

Milestone 21. `lighting: Dynamic | Room` on `MapInfo`, next to `fog` and `vision_ft` and remembered
per URL with them, so an outdoor map keeps line of sight and a dungeon reveals a room at a time.

```
Dynamic   rays                 a cell is lit when a straight line reaches it
Room      flood ∪ rays         …or when a walk does
```

`fog::sight_cells` is the only place the mode is read, so `recompute_sight` makes a single call and
**nothing downstream knows there are two.** The mode changes what the party can see, not what any
of it means: `revealed`, `known` and `visible` are built from the answer exactly as before, the
fringe still widens `known`, the DM's mask is still applied after, and `unseen_by_table` is
unchanged. It added no arm in `message_for`, no field on the wire beyond `MapInfo`, and no second
derived set.

### The doorway carries sight, not light

**`Room` is a union.** That was the correction forced by one session on a real dungeon. One sentence
for the DM: *you see the whole room you're standing in, plus whatever you have a straight line to.*
It can never show the table less than `Dynamic` would.

The flood shipped reading `blocks()`, so an open door was a way through, on the argument that an
open door is how light reaches the next room. In play that made an open door a hole in the room
boundary: a one-cell hallway handed over the whole chamber past it, and the only thing that bounded
a room was a shut door someone had to open and close by hand as the party moved.

So the flood is bounded by every traced segment, open or shut, which is `fillFrom`'s rule in
`overrides.ts` (see *The fill runs on the client*): **an archway is a door left open.** That was
already the convention everywhere except here.

| segment    | bounds the flood | stops a ray |
| ---------- | ---------------- | ----------- |
| masonry    | yes              | yes         |
| shut door  | yes              | yes         |
| open door  | yes — the archway | no         |

So an open door shows the wedge visible through it rather than the room behind it, which is what
opening a door does at a real table. Only sight reads a door's state now, one rule fewer than this
file used to carry. `lit_cells` asks the same *question* as `fillFrom`, in a second language, and is
kept separate for `shape_covers`'s reason: `fillFrom` previews what the DM is about to paint,
`lit_cells` decides what the party is handed, and a disagreement at the fringe changes a preview
rather than a permission.

A shut door still seals a room (both halves stop at it), which is why doors matter in this mode.

Considered and not built: a separate `WallKind::Archway`. It would bound the flood and nothing else,
which is what an open door already does, and a third variant in a closed set costs the editor's mode
strip, the renderer, `AddWalls`, and the client's two-state `Wall.door`. The roadmap asked whether
an archway needed its own kind (milestone 21 in `docs/history.md`); the answer is no. If a permanent
opening ever needs to be one nobody can close, the option is still there.

**It is bounded by the radius as well as by the walls**, Euclidean from the source like the
raycast. A pure fill ignores corners (walk into a winding corridor and the whole of it lights to the
far end, around every bend), and bounding it keeps `vision_ft` meaningful in both modes. A hall
bigger than the radius is a map whose radius should be raised; there's no second number.

A cell a traced segment runs through is a dead end, matching `cutByWall` segment for segment (see
*A cell a wall runs through is a dead end*). Corner-snapped masonry never produces such a cell; a
45-degree wall produces one every other cell, and a chamfered room corner is made of them. It's
taken by whichever fill reached it and expanded out of by none. The seed isn't special-cased either,
so a token standing inside masonry lights only the square it's on. That's visibly wrong in a way the
DM will notice and fix, which is the right direction for this to fail.

**One fill per source, unioned, not one sweep sharing a visited set.** The raycast can skip a cell
another torch already lit because rays are independent. Here, skipping such a cell would stop this
source expanding *through* it, and a fill that never enters the corridor never reaches the room past
it.

Leaving a room un-lights it with no new rule: terrain is gated on `known` and creatures on
`visible`, so the room stays dimmed and whatever wandered in while the party was away doesn't show.

A bad trace fails visibly: one gap merges two rooms in front of everyone, instead of leaking a
sliver of sight nobody notices. That's the mode's best property and its biggest cost. The DM has to
keep in mind *every wall and door I trace bounds a room*, and the panel's hint says exactly that,
because a room that lit further than intended looks like fog, not like a gap.

Unlike `shape_covers` there's **no client copy for the table**: players are sent a `FogView` and
compute nothing, so there's no second implementation to keep in step. The client's part is two
buttons in the panel and the sentence under them. (The DM's sight check reuses `fillFrom` for
`Room`; see *Solo sight*.)

## Raycasting, not shadowcasting

How `Dynamic` works, which is what every map did before there were two modes.

The original fog design (in `docs/history.md`) specified symmetric shadowcasting. It doesn't fit:
**shadowcasting needs opacity to be a property of a cell, and a wall here is an arbitrary segment in
image pixels.** The DM traces freely, Alt places off the lattice, and a cave wall is a diagonal.

Rasterising a segment into blocking cells doesn't approximate the map; it produces a different one.
A wall traced *along* a cell boundary (the common case, because `snapToCorner` puts it there) would
blind the cells on both sides and shrink every room it encloses by one square all the way round.

So the rule is one sentence:

> A cell is visible when the straight line from the viewer's centre to that cell's centre crosses no
> solid wall and no shut door.

It reads the segments as they were traced, can be explained to a player who asks why they can't see
something, and is a page of code rather than three. The roadmap's line changed; the invariants it was
protecting didn't.

**The radius is Euclidean, so vision is a circle.** That agrees with a drawn circle and disagrees
with the movement ruler, where a diagonal step costs one cell and "within 20 ft" is a square. It's
the same disagreement *Distance* in `docs/drawings.md` already names and leaves standing, for the
same reason: they're different questions. A radius of light is a circle.

**A monster is visible if any cell it covers is.** A four-cell ogre leaning into a lit corridor is an
ogre the party can see, and asking only about its centre would hide half of it behind the wall it's
standing beside. That's `covered_cells`, which uses the same lattice `snap_to_cell` snaps to.

### A tie is answered the same way from both ends

**Ties at the ray's own ends are permissive; ties in the middle are not.** Touching is the hard part
of `crosses`, and it happens constantly: cell centres and `snapToCorner`'d wall corners sit on the
same lattice, so a ray passing exactly through a wall's endpoint is the common case. Three cases
follow from the one rule:

- A viewer standing *on* a wall is not blinded by it, which would otherwise happen to a creature in a
  doorway. A tie at `p`.
- A ray *ending* exactly on a wall's endpoint slips past its tip. That's corner peeking, which every
  VTT has, and it errs towards showing the player something. A tie at `q`.
- A wall's corner sitting exactly *across* the ray stops it. A tie in the middle.

The tests are `a_viewer_standing_on_a_wall_is_not_blinded_by_it`,
`a_ray_ending_on_a_wall_tip_slips_past_it` and
`a_wall_corner_on_the_ray_stops_it_whichever_end_is_looking`.

The first draft said "proper intersection: touching does not count" and tested it as
`(d3 > 0.0) != (d4 > 0.0)`, which isn't that rule or any rule. Negating a side flips a negative to
positive but leaves a zero reading as "not positive", so **the answer depended on which end the ray
was cast from.** Two tokens either side of a wall's free end: one saw the other and wasn't seen back.
The viewer-on-a-wall case was half-broken the same way (blind along the wall in one direction and not
the other), and its test asserted only that they could see their own square, which was true
throughout.

A tie is a measure-zero event that only happens because both spaces are on a lattice, so either
answer is defensible; giving the *same* answer both ways is required. If the middle case should ever
be permissive too, that's one `within` call to delete.

### The radius is measured in cells, and that is why the sweeps take grid units

`sources` arrives in **grid units**, while every other coordinate in this file is image pixels, and
the conversion happens once per source inside the loop. That looks backwards. It's the one exception
to "walls are pixels, so rays are pixels", and it's there because of a tie.

A radius set in feet is a whole number of cells (`vision_ft` is a multiple of five and a cell is five
feet), and an odd-sized token stands on a cell centre, so the cells due north, south, east and west
at exactly that distance sit **exactly on the circle**. At twenty-five feet, the far ends of every
3-4-5 triangle do too. It's the same kind of event as the wall ties above, decided by the same rule:
*a tie is answered the same way from both ends.*

Measured in pixels, it wasn't. `(c + 0.5) * grid_px - x * grid_px` and `radius_cells * grid_px` are
two roundings of one number and disagree in the last bit, so the cell six east of the torch landed
inside the circle and the cell six west outside. The circle gained a cell on one edge and lost one
on the other, and which edge changed as the token walked, because the answer depended on absolute
pixel values rather than on distance. A power-of-two grid is exact and hides all of this; a map
calibrated to 35.65 pixels a cell isn't, and about a fifth of (grid, offset, position, radius)
combinations showed it.

Measured in cells, the arithmetic is exact for the numbers involved (`13.5 - 9.5` is `4.0`, and
`sqrt(16.0)` is `4.0`), so both sides of a tie answer together and the circle is symmetric whatever
the grid. **It isn't a precision problem, and widening to `f64` doesn't fix it**: a tie is decided in
whichever space the comparison happens, so it has to happen in the space where the numbers are exact.

The pixel radius stays for the two questions that really are about pixels: culling walls to the
viewer's reach, and clipping the sweep window. Both are bounds rather than the answer, so being a
cell off either way costs a little work and never a wrong picture.

`lit_cells` uses the same split (cells for the step test, pixels for the cull), and `solo.ts` and
`fillFrom`'s `withinCells` bring it to the client, because the DM's sight check has to agree with the
fog it previews. The regression tests are `the_circle_is_the_same_on_both_sides_of_the_viewer` in
both languages: they sweep awkward grid sizes and assert the lit set is its own mirror image, which
fails on the pixel version and can't fail on this one.

### What it costs

The product of cells swept and walls not culled, per source. Both are bounded before the loop:
walls further from the viewer than the radius can't be crossed by any of its rays and are dropped
**once per source rather than once per cell**, and the sweep is clipped to the board. Skipping a cell
another torch already lit removes most of the work from the second party member onward, because five
people stand close together.

It runs on a drop, never on a drag frame. See *When it recomputes*.

### The play-area boundary is an implicit wall

Vision doesn't spill into the void off the edge of the map. Nothing in the wall editor produces that
boundary, and nothing should, because it's already on `MapInfo`.

It's enforced twice, and both are needed. The four edges are in the blocker list, which stops a
viewer standing off the board from seeing onto it; and a cell whose centre is off the board is
skipped outright, which stops the party exploring the void.

On a map with no play area (what the DM's "use the whole image" button leaves behind, so the common
case), the board extends to `MAX_MAP_PX`, the same bound the walls are held to. This is needed: a
token dragged to cell one million would otherwise reveal cells there, and the rectangle packing them
alongside the dungeon would be the whole map's worth of characters on every send.

## `FogView`: a rectangle of characters

```
#  never seen        o  explored, not in sight now        .  in sight
```

Row-major, one character per cell, with the rectangle's origin and size alongside. **The rectangle
is the bounding box of what has been explored**, and every cell outside it is dark. That lets it
shrink to the interesting part of a large map, and an unexplored map packs to nothing.

It's a string rather than an array of per-cell values because the wire protocol wants frames a human
can read in devtools, and a few thousand numbers aren't readable. A few thousand characters laid out
as a map are: the shape of the dungeon is visible in the string.

`None` in place of a `FogView` means the map isn't fogged. That's the only thing the server could
mean by it (the same approach as `staged` being `None`), so turning fog off needs no second field on
the wire.

**The same value reaches everyone.** Fog is party-shared, so there's one answer and nothing
per-client to build; the `Event::FogChanged` arm of `message_for` doesn't filter. `WallsChanged` next
to it does the opposite, and the pair sums up the design: the wall geometry is the secret, and the
shadow it casts is what the table plays with. Players infer the floor plan from the edges of the
fog, which is why walls stay out of their snapshot even though the fog shows the walls' effect.

## The third reason a token is unseen

`Token::unseen` used to be the question every filter asked. It's now two of the three reasons.

```rust
fn unseen_by_table(&self, token: &Token) -> bool {
    token.unseen() || !self.in_sight(token)     // hidden || staged_only || out of sight
}
```

Two of the three reasons are facts about the token and stay on it. The third is a fact about the
*room* (where the walls are, where the party is standing, how far their torches reach), so it can't
be answered from `&Token` alone. **That's why the check moved up to `RoomState` rather than adding a
third field to `Token`.**

All three combine, and every filter has to ask about all three. `snapshot_for`, `initiative_for`,
`shape_seen`, both oracle guards in `check`, and all four token arms of `message_for` go through this
one function. Anything that asks `Token::unseen` directly is filtering on two of them.

16b added a fourth reason and no fourth question, which was the thing to get right: the DM's
override changes what `visible` holds, so `in_sight` returns a different answer and this line is
unchanged. See *The DM's override*.

### `was_unseen` had to change meaning, everywhere

This was the expensive half of the milestone, and milestone 11's note predicted it.

Every event carrying `was_unseen` answers "did the table hold this token a moment ago". That used to
be `Token::unseen()`, read just before the field it describes was overwritten. With fog it has to be
`unseen_by_table`, and there were four sites:

- `UpdateToken` reads it **before taking the mutable borrow**, since the question needs `&self`.
- `delete_token` reads it **before the removal**, since afterwards neither half can be asked.
- `promote_staged_tokens` reads it **for every token up front**, because a promote sweeps the fog,
  and by the time the loop runs the lattice it was asked about is gone.
- `CreateToken` is the one that didn't change: nobody held a token that didn't exist.

Missing any of them is a real leak, not a cosmetic one. Renaming a monster standing in the dark would
send the table a `TokenRemoved` naming an id they never held, which announces that the id exists:
exactly what `hidden` was built to prevent. `renaming_a_creature_in_the_dark_tells_the_table_nothing`
tests it.

`Event::Promoted` gained a third outcome for the same reason: a planned token landing somewhere the
party can't see has to be *removed from their board*, not just left undrawn at the cell it used to
stand in, on a map that's no longer there.

## When it recomputes

`moves_sight` is the counterpart of `persists`, and lists commands the same way rather than with a
catch-all: a command added later and missed there leaves the fog stale, which looks like a raycast
bug rather than a missing arm.

The reading is taken in `handle`, **before `apply` runs**, and only for the commands that could
change it: the packed string costs too much to build on a drag frame arriving thirty times a second
from each of six people. Its token half isn't built there at all; see *Drag frames*. `refresh_fog`
then recomputes and reports the difference as events: the fog frame, a `TokenChanged` for every token
whose visibility flipped, and the initiative panel and the shape list if any of those tokens appears
there. The last two are sent only when something actually changed. An unconditional `ShapesChanged`
on every step would tell the table that *something happened* every time anyone moved.

A token the command has already reported on isn't reported twice: those events carry their own
`was_unseen`, computed with the same question. **`TokenMoved` is not on that list.** Walking out of
the light is *how* a creature stops being visible, and the move frame has just been withheld from
exactly the recipients who now need to be told it's gone.

### Drag frames

The roadmap's rule, kept: **recompute on the drop.** The raycast is cheap enough at 30 Hz, but
sending a packed rectangle to six people that often isn't, so the fog opens as a token settles rather
than as it moves.

What still happens mid-drag is the *filter*. A monster dragged into a cell the party can't currently
see stops being relayed to them at once, because that check reads `visible` rather than rebuilding
it. The player keeps it at the last position they saw until the drop removes it from their board: a
drag's worth of staleness, where the alternative is thirty bitsets a second.

**That drop is why `Sight.seen` is copied from `RoomState::shown` instead of being computed with the
rest of the reading.** The reading exists to answer "what could the table see a moment ago", and
computing it from `&self` answers "what can they see right now". Those are the same only if nothing
has moved since the last recompute, and a drag frame is the one thing that moves a token without
one. So by the time the drop asked, the creature was already standing in the dark, the room answered
*they never saw it*, `refresh_fog` found no flip, and no `TokenRemoved` was sent. The monster stayed
on the table's board at the last cell a drag frame reached them, for the rest of the session. It was
worst where fog matters most: the DM walking something out of the light is the ordinary way a
creature stops being visible.

`shown` fixes it by recording the answer when it's true rather than asking for it afterwards. It's a
set of `TokenId`, derived and never persisted like `visible`, and `recompute_sight` is its only
writer. That's what makes it correct rather than just a cache: everything that can change the answer
triggers a recompute (`moves_sight` lists them), and the only exception is the drag frame this
exists to handle. It's written after both branches of the recompute, because switching fog *off*
shows the table every token and changes the answer as much as a raycast does.

Nothing downstream knows about it. `refresh_fog`'s flip loop is unchanged, so the initiative row and
any anchored aura leave the table's board with the creature through `anchors_a_shape`, as they
already did when someone walked out of a doorway.

**`Sight.shapes` next to it stays a live reading, and giving it the same treatment would be a bug.**
It looks like it needs one, since an anchored shape's visibility is its token's and goes stale on a
drag the same way. But the token loop above already covers that case, and the shapes are the one
list here that a command *outside* `moves_sight` can change: `AddShape` and `RemoveShape` neither
trigger a recompute nor are gated. A record written only at the recompute would miss them, and the
next person to move anywhere would find `before.shapes` disagreeing with the room and emit a
`ShapesChanged` telling the table something happened. `seen` has no such gap, which is why it can be
recorded and this can't.

The cost is that a room built without `spawn`'s boot recompute claims the table has been shown
nothing, and reports every token as newly appeared on its first command. That's a real trap and it
caught fourteen tests: `room()` and `reboot()` go through `booted` for the same reason `spawn` calls
`recompute_sight`, and `the_fog_survives_the_save_file` asserts both halves (absent from the
constructor, derived back by the boot).

## What sweeps it

**A map load and a promote clear all three sets**, through `sweep_board`, along with the shapes and
the walls. The three are cleared together by `forget_fog` rather than as three lines at each call
site, because the third is what gets missed when someone adds a fourth, and a `known` left standing
after `revealed` is cleared is the whole map still on the table's board.

A recalibration clears them too, and this is where fog differs from the walls it's swept with. A
wall is in image pixels and still traces the same painted line after the grid moves; these are
cells, and the squares themselves have just moved. Redrawing the play area counts as well: what was
explored outside the new edge isn't somewhere the party can be.

Only a change to the board's *shape* does this. Turning the vision radius up is no reason for the
party to forget the dungeon, and neither is the grid's colour or turning fog off and on again.

The overrides are cleared with them, for the same reason: they're cells, and the squares they name
have just moved. That happens in two places: `sweep_board` for a load and a promote, and the
`reshaped` branch of `SetMap` for a recalibration.

**Since milestone 31 the paint is filed rather than destroyed on a load, and `revealed` isn't.** The
DM's mask is authoring, so it goes onto the shelf with the walls of the image it was painted on and
comes back when that image does. Where the party *explored* is play, so returning to a dungeon means
re-exploring it. That split (the DM's authoring is remembered, the party's play state isn't) keeps a
map load from becoming a partial scene restore. It relies on two orderings: the shelf is written
before the sweep clears anything, and on a load the `reshaped` branch above is skipped entirely,
because emptying the overrides first would file the DM's paint as nothing. See *The shelf* in
`docs/maps.md`.

`sweep_board` emits no event of its own for the three sets. `refresh_fog` runs afterwards and
compares against a reading taken before any of it, so the clear is already in the difference it
reports. The overrides do need one, because nothing recomputes authoring data: without an
`OverridesChanged`, the DM's own panel would keep drawing a mask the room no longer holds.

### And `ResetFog`, which is the DM asking for it

`sweep_board` without the board: `forget_fog` and the overrides, but not the shapes or the walls,
because this restarts the fog, not the map. The whole board goes dark and comes back as whatever the
party's tokens can see from where they stand.

One command rather than two. "Forget the exploring" and "clear the paint" are one intent (*this map
hasn't been seen yet*), and splitting them would offer a reset that leaves the map lit, which nobody
wants. It stopped being grouped with `ClearWalls` when it gained the first half: the walls are all
the DM's work, and the party's exploring isn't.

The events are `OverridesChanged` for the DM and the `FogChanged` that `refresh_fog` finds for
everyone, the same pair every paint stroke produces. The confirm prompt names both halves, because
the exploring is the half that surprises people.

## On disk

`revealed` and `overrides` are persisted; `known` and `visible` aren't. Neither is the fringe, since
it's part of what builds `known`: a save holds the rays, and the widening is rebuilt from them on
boot.

An evening of exploring belongs to the map it was done on, and `revealed` is the one part of fog
whose loss on restart would make the feature feel broken. Sight is derived from where the tokens
stand and what blocks the rays between them, both already in the same file, and deriving it means a
save written before a door was shut can't describe sight straight through it.

The file reuses `FogView`, packed against an empty `visible`, so every explored cell is recorded as
`o`. `unpack` reads both lit states as explored, so neither side has to know which it's looking at.

The overrides next to it are the opposite case, and the two are worth reading together. `revealed`
is one half of a derived thing and records only the half that can't be recomputed, while the
overrides aren't derived at all. No arrangement of walls and tokens gives back what someone decided,
so they're stored whole and applied again on boot. **That difference matters; don't merge the two
into one rule for symmetry.**

## Three fields on the map, and no command of their own

```rust
fog: bool,             // is this map fogged
vision_ft: f32,        // how far a player-owned token sees
lighting: Lighting,    // and how that reach is worked out
```

Per map rather than per room, and remembered per URL in `Calibration` with the grid: a dungeon wants
fog, room lighting and a short radius, while the meadow outside it wants none of the three, and the
DM shouldn't have to remember which is which when switching between them.

All three go out on `SetMap`. There's no `SetFog`, for the same reason there's no `SetHp`: it would
be a second way to write one record, and two writers is how they come to disagree. The client sends
them through `MapTool.setFog`, which holds the *confirmed* calibration, so adjusting the fog can't
commit an unapplied grid preview.

**`lighting` defaults to `Dynamic`** for the same reason `fog` defaults to off: it's what every map
did before the field existed, so a save that predates it describes the same dungeon after loading.
That's invariant 2 working in the one direction it can; see milestone 20 in `docs/history.md`, which
notes that it protects a field being *added* and does nothing for one changing shape.

**`fog` defaults to off**, which answers the roadmap's warning about a radius defaulting to zero and
every restored room going pitch black. A switch that defaults to off can't cause that, whatever
`vision_ft` loads as, so the radius can default to a playable 60 feet instead of a defensive number.

`vision_ft` is now the **fallback** rather than the only answer: a token with a `light_ft` sees by
that instead, through `fog::Source::radius_cells`, and that's all a lantern is. The map still holds
the number every token without one uses, so a save that predates lights is unchanged and a map with
no lights costs exactly what it did.

Nothing here knows the word "darkvision", even so. A radius on a token isn't a creature's eyes: it's
a light, it lights for everyone, and a light nobody is carrying only counts when the party can see
it. Per-token *darkvision* would need a radius that lights for its owner alone, which is milestone
29's per-player `visible` and still isn't built.

## On screen

**Over the terrain and under everything standing on it.**

Under the tokens is for the DM: their monsters stay at full strength over a faint wash, so the board
they play on stays readable while also showing what the table can see. A player has no token in the
dark to be washed out (every token they hold is a vision source, or stands where one is looking), so
the order costs them nothing.

The DM sees a faint wash rather than the table's view, the same trade-off masonry makes on their
screen: always drawn, faint until the editor is armed. It's also why they're sent the fog at all.

**No wash while previewing, but the override tint regardless.** This is the one place the two layers
differ. The fog sets belong to the live board because nothing has cast a ray on the staged one; the
mask doesn't, and over a preview it's the only thing on screen showing what the DM has decided. See
*No staged fog*.

### One `drawImage`, whatever the dungeon looks like

A fogged board is a few thousand cells, and a `fillRect` per cell per frame is far too slow. `fog.ts`
turns the packed rectangle into **a small canvas**, painted once per `fog_changed`, and the renderer
stretches it over the board.

**The edge is feathered, and `SUBCELLS` is what keeps that correct.** A fog edge approximates where
a wall is. A crisp line claims precision the raycast doesn't have; a soft edge understates it, which
is the more accurate picture. But the obvious way to get one is wrong. The canvas used to be *one
pixel per cell* with smoothing off, and turning smoothing on there ramps across the whole square and
moves the boundary half a cell, because bilinear sampling anchors on pixel centres. The old
"smoothing is off" comment was guarding against that shift; it was right about the danger and wrong
that turning smoothing off was the only fix. Drawing each cell as a solid block of `SUBCELLS` pixels
first and stretching *that* keeps the boundary exactly where the server put it and limits the ramp to
a quarter of a cell.

The override tint keeps its hard edge. A fog edge approximates a wall, but an override edge is
exactly the squares the DM clicked, and softening it would misreport their own paint back to them.

The four bands around that rectangle are filled flat and clipped to the board, since everything
outside it is dark. It's the same approach `drawOutsidePlayArea` uses, and it's what lets the packed
frame shrink to the interesting part of a large map.

**Nothing in `fog.ts` is a visibility decision.** A creature the table can't see is absent from
`scene.tokens`, not drawn and painted over. Painting over it would put the position on the client,
which invariant 4 forbids.

`overrides.ts` does the same for the DM's mask, and makes no decisions either: the board is already
dark where the party can't see, and this only shows which of that darkness the DM put there by hand.
Its layer draws directly over the fog with one `globalAlpha` rather than as two canvases, which is
why the tint is built at full strength and faded at draw time: opening the panel changes a number
instead of rebuilding a canvas.

## The panel

A switch, a mode, a radius, and a brush. The first three belong to the map and go out as part of a
`set_map` through the map tool, which holds the confirmed calibration; the fourth doesn't, and sends
its own command.

The mode is two buttons rather than a "light whole rooms" checkbox, because it's a choice between two
ways of working out what the party can see, and a checkbox names only one. They arm nothing: clicking
one sends a `set_map`, and the board that comes back shows the result. So `.is-on` there means "this
is what the map says" rather than "the left button is taken", the one place that class doesn't mean
a tool is armed.

The radius is greyed rather than hidden while fog is off. It's still the map's number, and hiding it
would make turning fog on look like it had also made one up. The brushes grey the same way, for the
same reason. The radius listens for `change` rather than `input`, so typing `1` on the way to `100`
doesn't send a radius nobody asked for and recompute the whole board for it.

**Since milestone 20 the panel and its tab stay live over a preview**, for the same reason the wall
editor does: the staged board has a mask of its own to paint. The switch and the radius come with it
(they're `MapInfo` fields and have been staged since 16a; only the client was refusing them), so the
next dungeon's lighting is set before the table sees it. Reset is the one control still greyed
there, and *No staged fog* explains why.

The hint says what the board can't: over a preview it explains what painting there means, because
there's no wash under the tint to make it obvious.

16a's note that this was the one tab with no `stop()` no longer holds, and the reason is worth
keeping. The panel armed nothing *because the party's tokens are what move the fog*, but the override
is the one part the DM places by hand, so it's a tool holding the left mouse button like any other.
One left armed under a hidden panel is a click doing something with nothing on screen to explain it,
which is the rail's rule and now applies here too.

The hint says what a torch does, differently in the two modes: the `Room` wording mentions doors,
because that mode is where doors matter and because a room that lit further than the DM expected is
nearly always a wall with a gap in it.

Below all of it is **sight check**, which edits nothing but belongs on this panel anyway, because
this is where the DM comes to reason about what the table can see. It's hidden while `SOLO_SIGHT` is
off; see *Solo sight*.

Four brushes and two gestures:

- **ground** hands the terrain over and leaves whoever is standing on it alone; **lit** hands over
  both; **dark** takes both away, memory included; **clear** hands the cells back to line of sight.
- **fill** floods from the cell under the pointer, bounded by every traced segment and previewed
  before it commits; **paint** applies the brush to the cells the pointer is dragged across.

The preview is necessary. One gap in a traced room reveals the whole dungeon in a single click, so
the region is shown in the colour it would land in, and the DM's own eyes check the geometry before
anything is sent. (Milestone 22's undo can take a fill back, but not what the table already saw.)
It's recomputed only when the pointer crosses into a different cell, which makes a flood of a few
thousand cells affordable on a pointer move.

A paint stroke accumulates on the tool and goes out as **one command** when the button is released.
A frame per cell would be a hundred of them across one drag, and there's nothing to predict: the
answer is already on screen.

## Solo sight: what one creature can see

> **Not offered right now.** Milestone 34 hid the button (`SOLO_SIGHT` in `fogtool.ts` is the only
> switch) because player view answers the question a DM was actually using it for, and answers it
> for the whole table at once. Asking about one creature became the narrow version of a question
> with a better button next to it.
>
> Nothing else was removed. `solo.ts`, `solo.test.ts`, `frame.solo` and `drawFog`'s branch are
> unchanged and still correct; only the way in is switched off, and everything below is still the
> design. **Milestone 29 is what brings it back**: once `visible` is per-player there's no single
> table's board to mirror, player view has to name someone, and *can the rogue see it* stops being
> the narrow version of anything. `drive-panels.mjs` asserts the button is unreachable, and that
> check fails the day the const flips.

Milestone 26, all in `solo.ts`. The DM arms *sight check* in the fog panel, clicks a creature, and
their own board stops showing the table's wash and shows that creature's line of sight instead. It
answers the question that actually comes up at a table (*can the rogue see it*), and it's the only
part of per-player fog worth having.

**Per-player fog itself stays refused**, and this is why refusing it costs nothing. The architecture
would allow it: per-client `mpsc`, `snapshot_for`, and `FogView` is already built per recipient. The
cost is in play. `unseen_by_table` would become `unseen_by(client)` at six call sites, `FogView`
would stop being the one message identical for everyone, and there's no defensible answer for what
the *DM's* board should then show, which usually means the question was posed wrong. Six people
narrating to each other gain nothing from five answers unless the party splits, and a split is one
sentence from the DM.

**Client-only, and nothing goes in the room.** It's a second raycast over data the DM's client
already holds (the walls, the radius, the mode, and where everyone is standing), so it needs no
command, event or filter. It can't leak, and not because of a check: a player's scene carries no
walls, so their client couldn't compute this if it tried, and nothing in `solo.ts` asks who is
reading it. That's the same argument `crossesWall` makes for the movement hint. *No staged fog* sets
the precedent for a second raycast on the client; `shape_covers` sets it for a geometry rule in two
languages.

It reuses existing pieces rather than adding new ones:

- **`crossesWall` for `Dynamic`**, which already filters to solid walls and shut doors, over walls
  culled to the radius once per source (the same bound `fog.rs` uses, for the same reason).
- **`fillFrom` for `Room`, unioned with the rays**, which is *The doorway carries sight, not light*
  again on the client. `fillFrom` gained an optional `withinCells` radius for it, measured from the
  seed and defaulting to unbounded so the DM's reveal preview is unchanged. It's in cells for the
  reason *The radius is measured in cells* gives.
- **`fogFromWire` for the picture.** `soloSight` returns a `WireFog` packed exactly as the server
  packs one, so there's no second rendering path to keep in step, and the wash is guaranteed to look
  like the one it stands in for. It draws at the **table's** strength rather than the DM's faint one:
  the faint wash exists so the DM can play on a board that also shows what the party can see, while
  this is a direct question whose answer has to be readable.

Two things it doesn't do, both to keep it one question rather than two:

- **No memory.** Two states, `#` and `.`, never `o`. The question is what this creature's eyes reach
  *now*; what the party remembers is a different question, and `revealed` already answers it.
- **No overrides.** Geometry only. The mask is the DM's own work and they know what they painted;
  including it would answer "what would the table be shown" instead.

**Live board only**, so the button greys over a preview just as `ResetFog` does, for the same reason:
nothing raycasts a board nobody has been shown.

One button, three states, and **the order of its two branches matters**: anything on the board is
cleared first. With an answer showing, the button is the way back to the table's board, which is what
the hint under it promises. Re-arming there instead would leave the DM holding one creature's sight
with no control on screen to remove it. That shipped wrong once and `drive-panels.mjs` caught it.
`stop()` clears the answer as well as the arming, which is the rail's rule about closing a tab
applied to a wash rather than to a tool: a wash nobody can account for is worse than a click nobody
can account for. While an answer is up, the board shows the preview tag's styling in blue.

`drive-panels.mjs` asserts the half that matters in one reading: the DM's board changes and the
player's changes by nothing at all. The first version of that check opened both browsers on the same
debug port, so "the player" was the DM's own page; the two numbers came back identical and it read as
a leak. The ports are fixed per browser now, and that matters.

## Player view: the whole table's board

Milestone 34, all in `mirror.ts`. The DM clicks *player view* in the fog panel and their own board
becomes the one the table is looking at: the party's fog at the party's strength, no walls, no
painted squares, no hit points, no plans, and nothing standing anywhere the party can't see. Clicking
it again gives them their board back.

**It's the broad version of solo sight's question.** `solo.ts` asks whether one creature can see
something; this asks what the six screens are showing. Both belong to the fog panel, because the fog
is what makes either worth asking, and the broad version turned out to be the one worth offering:
the sight check went behind `SOLO_SIGHT` days after this landed, because a DM asking *can the rogue
see it* was nearly always asking what the table's board looks like. See the note at the top of
*Solo sight* above; that's the version this replaced, not one that was wrong.

It's worth having because the fog is party-shared. There's exactly one answer to "what can the table
see", so a mirror of it is a fact rather than a choice between six. That's also the line that would
have to be re-argued if milestone 29 ever made `visible` per-player: `asTable` is where a player's
name would have to go, and the feature would need a justification it doesn't need today.

**Client-only, and nothing goes in the room.** No command, event or filter; the server doesn't know
the DM is looking at this and must not learn. That's `solo.ts`'s rule and `previewing`'s before it.
The difference from both: **nothing here is a security boundary.** It *removes* things the DM is
entitled to see and can put back, so every line of `mirror.ts` could be wrong without a player
learning anything. It's a reading aid, and its failure mode is a DM who believes they got away with
something.

`asTable` is the client-side counterpart of `snapshot_for`, and each line matches one on the server:

- Tokens go through `unseenByTable`, which is `unseen_by_table`: all three reasons, combined the same
  way, including `in_sight`'s shortcut for a player's own token. `footprint` is `fog::covered_cells`
  with the same nudge, so an ogre leaning into a lit corridor stays.
- What survives is `redact`, which is `Token::view_for(false)` field for field.
- Shapes go through `shape_seen`'s two arms, anchored and not, with a port of `line_cells` for the
  kind that encloses nothing.
- Walls and overrides are emptied, which is `WallsChanged`'s rule: what the table gets of them is
  the fog they produce, already on the board underneath.
- `staged` is `None` and `previewing` is false, which is the one bundle a player is never sent.

**The fog itself isn't filtered, and doesn't need to be.** It's already the table's own answer; what
differs is how faintly it *draws*. So `Fog` carries a second canvas, `table`, built at the party's
strength next to the DM's. It exists only on the DM's client, since for a player it would be what
they're already looking at. `drawFog` picks between the two on one line, and that line covers four
cases without asking who's reading: the DM playing, the DM mirroring, the DM checking one creature,
and a player. `Fog` also keeps the packed `cells` it was built from, because a canvas answers "how
dark is this square" and the mirror has to ask "can the table see what's standing on it".

**The initiative panel mirrors too, and has to.** The panel names its rows by looking each token up
in the scene, so a mirrored scene without `tableInitiative` leaves a row drawn as a raw id: a monster
the DM hid, advertised by the one panel that's always on screen, which is the failure
`initiative_for` exists to prevent. The panel is told about the mirror rather than handed a narrowed
scene, because it's redrawn only when something arrives, while the board is redrawn every frame.

It's a mirror, so it doesn't annotate. Nothing is marked as withheld or outlined. A board that says
"and here's what they can't see" is the DM's board again, which is one click away. `docs/tokens.md`
makes the same argument about the live board not marking a planned token.

**It arms nothing and refuses nothing.** The DM can still drag, click and edit through it, as they can
through one creature's sight; only the drawing changes, and `input.ts` keeps reading the room's own
scene. So the mirror never has to hold a second opinion about permissions.

Three things turn it off. Picking up a fog brush, because the tint is the DM's own work and the
mirror is the board without it. Arming the sight check, because two answers on one board answer
neither (unreachable while `SOLO_SIGHT` is off, and kept because the rule matters more than the
current wiring). And `stop()`, the rail's rule that closing a tab puts down whatever the panel armed:
a wash nobody can account for is worse than a click nobody can account for. A preview starting also
turns it off, from the other direction, in `update`: `asTable` answers about the live board, so a
mirror over a preview would show the table's board to a DM who thinks they're looking at the next
dungeon. While it's on, the board shows the preview tag's styling in green, the third of three
colours and the last one available.

**Testing it.** `mirror.test.ts` owns the filter: twelve assertions, each one something the DM holds
that is *not* in what comes back, which is the server suite's rule applied to a filter on this side.
`tools/drive-mirror.mjs` owns the wiring, in one browser rather than two: this is a difference
between two boards on the same screen, so a second session would add nothing. Its pixel check
compares against a remembered frame *and* against a control frame where nothing was touched, since
how much of a canvas is board at all depends on the framing.

## Drawings on ground the party cannot see

The other half of 16b, and the case milestone 14 left open. `shape_seen` has two arms that ask
different questions:

- **An anchored shape follows its token's visibility.** An aura on a monster in the dark is that
  monster's position drawn in colour. That arm shipped in milestone 14, because `hidden` predates
  fog, and adding shapes without it would have leaked the day they landed.
- **An unanchored shape is gated on `known`**, not on `visible`. A shape is painted on the floor
  rather than standing on it, so it goes with the terrain: a marker a player dropped in a corridor is
  still theirs after they walk out of it, and gating on current sight would make every drawing on the
  board flicker as the party moved. It's the same terrain/creature split this file already makes,
  applied to a third kind of thing.

`known` and not `revealed`, so a shape is treated exactly like the ground under it: shown with an
`Explored` fill, hidden with a `Dark` one, and (since the fringe is part of `known`) shown when it
sits in the square of masonry past a wall the party is looking at. That's one of the fringe's
downstream readers (`cursor_seen` is another), and it's correct for the same reason the fringe is:
the cell is terrain the table has been shown.

The `map.fog` guard in the second arm is required, not defensive: `known` is empty on an unfogged
map, so without it every loose shape in the room would vanish from every player's board the moment
fog was switched off.

**The coverage test had to be ported to Rust.** `coveredCells` and `containsPoint` are client-only
and the filter has to run where the decision is made, so `shape_covers` in `fog.rs` says the same
thing again in a second language. The two only have to agree loosely, because a disagreement at the
fringe changes whether a frame is sent, never how it draws: the client draws exactly what it's given.
It walks the shape's bounding box rather than the cell set, which keeps the cost proportional to the
shape instead of to how much dungeon has been explored, and a `Line` gets its own walk because
`contains_point` is false everywhere on one. Without that walk every measuring line would be withheld
from everyone on a fogged map.

`Sight` gained a second reading for it. Every *anchored* shape moves with a token, so the token loop
in `refresh_fog` was enough to gate `ShapesChanged` on; an unanchored one is gated on `known`, which
changes when the party walks somewhere, with no DM token involved. Still one gate and one event: an
unconditional `ShapesChanged` on every step would tell the table that *something happened* every time
anyone moved.

## Light sources

Milestone 39. A radius on a token, which does two things:

```rust
light_ft: Option<f32>,   // on `Token`, DM-only, `None` for almost everything
```

- On a token **a player owns** it replaces `MapInfo::vision_ft` for that token. A lantern.
- On **anything else** it's what makes the token a source at all. A brazier, a torch on a wall, a
  goblin carrying one.

`fog::Source` is where those become one rule: `radius_ft: Option<f32>`, `None` meaning *as far as
this map lets anyone see*, which is what every source in `fog.rs` was before this. The sweeps used to
take `&[Pos]` and read one radius above the loop; they now take `&[Source]` and read it inside.
Nothing else in `visible_cells` or `lit_cells` changed, and the cells-not-pixels comparison that
*The radius is measured in cells* protects is untouched.

### The gate, and why it is line of sight rather than reach

**A light nobody is carrying has to be gated on something.** Ungated, the DM prepares a dungeon on a
Tuesday, puts a brazier in each room, promotes it on Saturday, and the table is handed every lit
chamber on the level through three walls. `visible` is a flat union of its sources with no *and
somebody can see it* term, so that term has to be applied to the source list, before the sweep.

**The gate is line of sight at any distance, not the party's radius.** With vision at thirty feet, a
brazier at forty is one the party can plainly see; refusing it because their own torches fall short
answers a question nobody asked. So `fog::in_line_of_sight` asks only whether a straight line reaches
the light, over the same blockers the rays stop at, with no radius and therefore no wall cull. That
also makes it cheap: a segment test per party token per light, where gating on `visible` would have
been a second sweep.

The other way a light passes the gate is the party's own sight (any cell of the light's footprint
that the party can see), which is what makes it work under `Lighting::Room`: a flood reaches round a
corner no straight line does, and a brazier in the room you're standing in should light whether or
not a pillar is in the way.

```text
party    player-owned tokens, radius light_ft ?? vision_ft   ungated
lights   anything else with a light                          active when seen
rays     sight_cells(party ∪ active)
```

**No cascade.** The gate reads the sight the party has *on their own*, computed before any light
joins the list, so one brazier can never switch on the next. Otherwise a chain of torches down a
corridor would open the level, which is the failure the gate exists to prevent, one step later.
`one_light_never_switches_on_the_next` is the test, and it fails when the gate is opened.

A light nobody can see lights nothing, whoever is holding it: `!unseen()`, the rule vision has always
used. A hidden brazier would be a second reveal tool, and the DM already has one: the `Lit` brush,
which does exactly that and is clearly the DM's own doing.

### It cost nothing on the wire and nothing in the three lists

`light_ft` travels in `CreateToken` and `UpdateToken`, which are already `true` in `moves_sight`,
already persist, and already have undo labels. **No new command, no new event, no new arm in
`message_for`, and `protocol-tags.json` is unchanged.** That's the case for putting it on `Token`
rather than building a separate `Light`.

It's DM-only on the wire, redacted in `Token::view_for` next to `hp`. What a light *does* reaches the
table as fog; what it *is* is the DM's authoring, and goes the way the walls go: the geometry is the
secret and the shadow it casts is what the table plays with. `None` therefore means both "carries no
light" and "you are not the DM".

A room with no lights costs exactly what it did. `sight_sources` returns the party unchanged when
nothing carries a light, which is almost always; only when something does is the extra sweep for the
gate paid.

`solo.ts` applies the same `light_ft ?? visionFt` on the client, because the DM's sight check is a
second raycast over the same data and the two have to agree. `mirror.ts` nulls it in `redact`, which
matches `view_for(false)` field for field. The client computes nothing else with it.

### On the panel, and the one thing that bit

One box on the token tab, in feet, blank for nearly every token. It's greyed while the board on
screen has no fog, as the fog panel greys its own radius, with the placeholder giving the reason. So
`tokenTool.update` is called next to `fogTool.update` wherever a panel is told `MapInfo.fog` may have
changed.

**The damage box had to carry it through.** `panel.ts` sends an `UpdateToken` built from the token it
already has, and `UpdateToken` replaces the token whole, so a field left out of that send would put
out a lantern on the first hit that lands. The compiler caught it. That's the `TokenView` argument
working in the other direction: a required field is a question the type system makes somebody answer.

## What milestone 16 did not do

- **Walls block sight and never movement.** Decided, not deferred; don't add collision. A token may
  be dragged through a shut door or off the play area, and the DM says "there's a wall there" as
  they would at a table. Four reasons, and the first makes it a rule rather than a preference:
  - A refused move is information. Players are never sent walls, so a server that rejected a
    `MoveToken` for hitting one would give the floor plan to anyone who drags a token around and
    watches which moves stick. It's the same trap as the uniform refusals in `docs/drawings.md`,
    where trying every shape id would map out the DM's monsters, with the whole dungeon as the
    prize.
  - Squeezing, climbing, flying, misty step, and a wall traced two pixels off each turn into "the
    VTT won't let me move" in the middle of a fight. The DM ruling on it costs one sentence and is
    never wrong.
  - A half-traced map would block inconsistently, which is worse than not blocking.
  - Fog already does the practical work: a player who can't see into a room doesn't drag a token
    into it.
- No light sources, no per-token vision, no darkvision; one radius per map. **Milestone 39 added the
  first of those, and the second came with it** (see *Light sources*). The third is still refused,
  and *Three fields on the map* says why a light isn't darkvision.
- **No undo.** The fill previews instead, which was the cheaper answer to the same problem: the
  mistake worth protecting against is the one nobody sees coming, and a region shown in the colour it
  would land in before it lands is one the DM has already seen. Milestone 22 later added the DM's
  undo, which covers fog paint and `ResetFog`; the preview still matters, because undo can't take
  back what the table already saw.

## Testing it

`tools/drive-fog.mjs` drives two real browsers at once, and it has to: almost everything fog does is
a *difference* between what two people are holding, and one client can't see a difference.

Its sharpest check is a network one rather than a pixel one. A token the room never sent is a token
whose **art was never fetched**, and the browser keeps that record whether or not anything was drawn,
so `performance` can answer "was this monster ever on this client" in a way no pixel can. Pixels
can't tell "correctly withheld" from "sent, and the renderer is broken"; those are the same picture
and very different bugs.

The pixel checks it does make are *differences against a remembered frame*, which took two failed
attempts to arrive at. How dark the board **is** depends entirely on how dark the map was painted: a
dungeon of black rock reads as fogged whatever the server said. How much the board **changed** when
the switch was flipped depends on nothing but the switch.

16b's checks use the same idea one step further: when the DM fills a room dark, the two boards move
in opposite directions. The table's goes dark; the DM's gets *brighter*, because what lands on theirs
is the override tint. One measurement shows both that the table lost the board and that the DM is the
only one told. A player is sent no such frame, so there's nothing on theirs to brighten.

Its own network check came later: a third browser joins *after* a forced-lit fill and is sent the
wraith. That's invariant 3 applied to the override. Filtering every delta correctly and then handing
over the whole world on connect is the most common way this goes wrong, and no amount of driving the
two existing clients would catch it.

Milestone 21's half is the only part of this driver that isn't self-contained, and what it cost is
worth knowing before writing another one like it. Room lighting has no shape at all without a wall,
so the driver has to **trace one**. A driver may neither assume the board it was written against nor
erase the DM's dungeon to make room for its own, so it runs only on a board with nothing traced,
erases what it traced, and otherwise says so and skips. It also builds its **own torch** rather than
searching the board for one of the party's: where six party tokens are standing depends on whatever
room this is, a ring search wide enough to find one costs a click per square, and a token the DM
creates lands in the first free cell out from the middle of the view, which is the one place both
clients are certainly looking. It's handed to a player, because a monster the DM keeps lights
nothing.

The reading itself is the fog switch's, one step on: mark the player's board under `Dynamic`, switch
to `Room`, and the ground the spur was hiding arrives. **The reverse isn't asserted**: `revealed` is
memory, so switching back leaves that ground on their board dimmed rather than taking it away.
Forgetting is what `reset all` is for, which is why the run resets before it measures.

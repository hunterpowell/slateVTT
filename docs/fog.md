# Fog of war

What the party can see, and what they remember seeing. The walls arrived in milestone 15 and
nothing read them; this is what reads them.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`fog.rs`, `fog.ts`, `solo.ts`, `mirror.ts`, `overrides.ts`, `fogtool.ts`, `unseen_by_table`,
`with_fringe`, `recompute_sight`, `refresh_fog`, or the `moves_sight` gate** — six of those ten are the places a leak would go
unnoticed, and the coordinate story in the first is the thing that looks like a mistake and is not.

This covers the whole of milestone 16: automatic line of sight in 16a, and the DM's manual override
in 16b. The two halves are separated in the text below wherever the second one changed the first.
Milestone 20 then gave the staged board a mask of its own and pointedly no fog — see *The staged
board has a mask of its own* and *No staged fog*. Milestone 21 gave the map a second way of being lit
— see *Two lighting modes, and one question underneath*, which is where to start if the question is
why a room came on all at once.

## Two sets of cells, shared by the whole party

```rust
revealed:  HashSet<Cell>,             // everywhere the party's rays have ever reached
known:     HashSet<Cell>,             // that, widened a cell and masked — what the table is shown
visible:   HashSet<Cell>,             // where they have sight now, masked
overrides: HashMap<Cell, Override>,   // what the DM said about it anyway
```

Three sets and one of them on disk. `revealed` is the memory and is **rays only**; `known` and
`visible` are both derived, rebuilt together by `recompute_sight`, and are what everything downstream
reads. Nothing outside that function reads `revealed` at all — doing so is how a blacked-out room
comes back onto the table's board.

**Terrain gates on `revealed`; creatures gate on `visible`.** A room the party walked through an
hour ago stays on their screen, dimmed — they remember the shape of it — and anything that has
wandered into it since does not. That split is the whole of what makes fog play well rather than
merely work: a board that forgets the corridor behind you is a board nobody can navigate.

`visible` is a subset of `known`, because everything that builds the second one only ever adds to
what the first is made of. That is not incidental — it is what lets one character per cell describe
both facts, which is what `FogView` does below.

**Fog is party-shared, not per-player.** One pair of sets, the union over every player-owned token.
Five people narrating to each other on Discord get nothing out of per-player fog but confusion and
five times the state, and the DM would have to reason about five answers to "can they see this".

Vision comes from tokens a player *owns*, so handing a token over grants sight with no extra rule
and taking it back removes it. A player's own token is always visible to the table by construction
rather than by rule: it is a vision source, so the cell it stands in is lit by it.

`vision_sources` asks `Token::unseen` and deliberately not `unseen_by_table` — what the party can
see cannot be an input to computing what the party can see.

## One cell of fringe, so the wall is on the board

`known` is not `revealed` — it is `revealed` widened by a square in every direction, and that is
`with_fringe` in `fog.rs`.

**It exists for the masonry.** `snapToCorner` puts a traced wall on the corner lattice, so it runs
*between* cell centres and the last cell a ray reaches is the floor square inside the room. If the DM
traced along the inner face of the wall — the natural way to trace one — the drawn wall is past that
cell, and fog that stopped at the rays would show the table floor, then nothing. Rooms read as holes
rather than as rooms, and the thing the player is looking at to work out where they are is the one
thing the board will not draw them. One cell of fringe puts the wall on their screen.

**It is a set operation and knows nothing about walls.** The fringe lands in every direction, not
only across masonry: one cell further down an open corridor as well, which is `vision_ft` plus a
square for terrain. That reads as the corridor ahead fading rather than cutting, and it is the whole
reason this is ten lines. Asking the raycast which cells it was *blocked* into instead means a second
return value out of `visible_cells` for a picture nobody would tell apart.

Eight neighbours and not four, because a four-neighbour ring leaves a notch bitten out of every room
corner — more visible than the thing it was fixing. Clipped to the board with `cell_on_board`, the
same bound the sweep takes and for the same reason: the void off the edge is not somewhere the party
explores, and a cell out there sits in the packed rectangle from then on.

**Only `known` is built through it**, and the two exclusions are the whole safety argument:

- **Never `visible`.** Creatures gate on `visible`, so a fringe there hands the table an ogre pressed
  against the far side of a wall. Terrain widens; sight does not. There is a test named for it.
- **Never `revealed`.** Memory is rays only — see the section below, which is the same argument the
  overrides make and got wrong once already. A fringe cell written into memory would bake into the
  save file, survive the wall being retraced around it, and outlive the ray that never cast it.

So it is a mask like `Explored` is, applied on the way into `known` and recomputed from `revealed`
every time. Two things fall out rather than being decided: **`Dark` still wins**, because the
override loop runs after the widening, and a recalibration lifts the fringe with the memory it was
derived from, since there is nothing of it to sweep.

What it hands over is a one-cell strip of map art, terrain-only: the far side of a shut door becomes
ground, and the party gets the near edge of a room they have not entered. That is the cost, it was
weighed, and it is smaller than it sounds — the file already concedes below that players read the
floor plan off the edge of the fog, and this moves that edge out by one square.

## The DM's override: a mask, never a write

`overrides` is 16b, and the shape of it is the one thing worth reading before touching any of it.

```rust
enum Override { Explored, Lit, Dark }   // `Auto` is the absence of an entry
```

**It is applied after the raycast and it never writes into `revealed`.** A manual hide that merely
cleared the memory would evaporate the next time a torch was carried past, and the failure would look
like a bug in the raycast rather than a missing feature. So the override is its own state and
`recompute_sight` folds it in every time:

```
revealed ∪= rays                                        // memory: rays only, and persisted
visible   = rays ∪ Lit − Dark                           // in sight now
known     = fringe(revealed) ∪ Lit ∪ Explored − Dark    // shown as terrain
```

`rays` is whatever `sight_cells` answered — the raycast on a `Dynamic` map, the flood unioned with it
on a `Room` one. Nothing below this line asks which, and *Two lighting modes* below is the only
section that does.

**`Lit` and `Explored` are floors and `Dark` is a ceiling**, over both derived sets and neither of
them the stored one. `visible ⊆ known` survives it — `fringe(revealed) ⊇ revealed ⊇ rays` and the
mask does the same thing to both — which is what the one-character packing depends on. The first of
those holds by construction: `with_fringe` puts each cell in before it consults the board, so the
superset does not depend on where some other bound happened to clip.

`Auto` is the absence of an entry rather than a fourth variant, so "not overridden" has one
representation and `recompute_sight` has no arm that does nothing.

### 16b said this and did not do it

Worth keeping, because the words above were already in this file while the code did the opposite.
`recompute_sight` used to run `revealed = (revealed ∪ visible ∪ Explored) − Dark` — with `revealed`
persisted and cumulative, that is **a write and not a mask**, in both directions:

- An `Explored` or `Lit` cell entered the memory and stayed there when the paint was cleared. A
  ground-fill was permanent. Combined with the fill leaking through a chamfered corner (see *A tie is
  contact*), one click handed over an entire dungeon with no way back short of reloading the map —
  which is how it was found.
- A `Dark` cell was subtracted from the memory, so lifting a blackout did not give back the corridor
  the party had walked down to reach it.

The old version needed a careful order between the two loops for exactly that reason: `Dark` had to
leave `visible` before the union into `revealed`, or a blacked-out cell entered the party's memory by
the back door. **That order is gone with the write it was protecting.** Nothing but a ray reaches
memory, a cell holds at most one override, and one `match` arm settles both derived sets — there is
no ordering left to get wrong.

A save written before this loads unchanged and keeps whatever an override baked into it; the reset
below is what clears it out.

**`Explored` does not demote a cell the rays already lit.** "Show them the room but not the ambush
in it" would be a fifth state, and it is what `hidden` is for.

### Two answers, not a fourth question

The roadmap asked that the override land as *a different answer from `in_sight`* rather than as
another clause, and it does. `Dark` subtracts from `visible`, so `in_sight` — which asks whether any
cell a token covers is in `visible` — says no on its own, and the token leaves the table's board
through the machinery `hidden` has used since milestone 11. `Lit` adds to `visible` and says yes the
same way. **`unseen_by_table` is still one line**, and nothing downstream of it knows the word
"override".

Two consequences fall out rather than being decided:

- **A `Lit` cell is not a vision source.** It lights that cell; no rays are cast from it.
- **`Dark` does not take a player's own token off their screen**, because `in_sight` returns true
  early for anything they own. The party walks into a blacked-out room and still sees themselves on
  a black field, which is the right way round — deleting the party from their own board would be
  worse than the darkness it was meant to describe.

### It travels like the walls, not like the fog

`OverrideView` packs the same rectangle of characters `FogView` does — `#` forced dark, `o` forced
explored, `*` forced in sight, `-` no override — and then goes the opposite way: **to the DM or to
nobody**. A player's `snapshot_for` carries an empty one, `Event::OverridesChanged` produces no
message for them at all, and empty is therefore both "nothing painted" and "you are not the DM".

That is `WallsChanged`'s rule arriving for the third time, and it is the right one: **the walls and
this are what the DM authored, and the fog is the shadow both of them cast.** What the table is owed
is the `FogChanged` that rides alongside — and when the DM paints over ground nobody could see,
there is correctly no such frame at all.

The DM's own board draws the override as its own tint over the wash, faint while they are playing
and stronger while the panel is open. That is not decoration: on a board where a wall's shadow and a
blacked-out room are both simply dark, it is the only thing that tells them apart, and with no undo
that difference is the usability of the whole tool.

Unlike `visible`, the overrides are **persisted whole**. Sight is derived from what the save file
already holds; what somebody decided is derivable from nothing.

### The staged board has a mask of its own

Milestone 20. `StagedBoard` holds a map, its walls and its overrides together, so the DM blacks out
the ambush chamber on a Tuesday and the party is handed it already dark on the Saturday — rather
than the DM racing to paint it while six people watch the map load.

It is the walls' story exactly, and it cost nothing here for the same reason: **the override already
reached the DM or nobody**, so a staged one added no visibility surface. `SetFogOverride` grew a
`staged` flag like the four wall commands beside it, `OverridesChanged` grew one so the client knows
which mask it just received, and `snapshot_for` withholds both boards' with the one `None` that
already withheld the map.

Three rules ride along, and each is the live board's:

- **A staged load sweeps the paint; a staged recalibration sweeps it too.** Overrides are cells, and
  both a new image and a moved lattice invalidate them. That is the same pair of arms `sweep_board`
  and `SetMap`'s `reshaped` branch run for the live board — the staged walls are what differ, being
  image pixels and surviving the recalibration.
- **A promote carries it across.** `sweep_board` still clears the live board's, and then the staged
  board's land in their place. `refresh_fog` runs afterwards, so the mask is applied the instant the
  map arrives rather than a beat later.
- **`ResetFog` stays live-only and names no slot**, which is the one asymmetry worth stating. Half
  of it is forgetting where the *party* explored, and they have not explored a map they have not
  been shown. Over a preview it would mean "clear the paint", which is the `clear` brush with a
  bigger blast radius and no undo — so the button greys instead.

### No staged fog

**Nothing raycasts the staged board, deliberately.** There is no staged `revealed`, `known` or
`visible`, and the DM's screen draws no wash over the map they are preparing — only their own tint,
over the bare art.

The distinction the whole feature rests on: a staged override is not a *preview* of what the party
will see, it is what they will be **handed**. "Will they spot the dragon when the door opens" is a
real question and a genuinely different feature — a second raycast, needing the staged walls, the
staged token plans and the radius. If it is ever wanted it is **client-only** and costs the room
nothing, since the DM's client already holds all three; `shape_covers` is the precedent for a
geometry rule living in two languages. Do not put it in the room.

The visible cost is that the DM paints a staged map with nothing underneath the tint to react
against — no fog edge, no shadow, just their own colour on the floor. The panel's hint says so in
words, because the board cannot.

### The fill runs on the client

`ClientMsg::SetFogOverride` carries **the cells, not a seed to flood from**. The DM's client already
holds the walls and has to compute the fill anyway to preview it, so sending the previewed cells
makes the preview and the result the same object rather than two runs of two implementations that
would have to agree. Nothing is being adjudicated — the DM may reveal whatever they like — so the
server has no answer of its own to defend, only a size to bound (`MAX_OVERRIDE_CELLS`) and a board to
clip against (`cell_on_board`, the same bound the sweep uses and for the same reason).

**`MAX_OVERRIDE_CELLS` is bounded by the frame and not by taste.** Sending the cells means the
command grows with the fill — one `[x,y]` pair each, up to twelve bytes at four-digit coordinates —
so the count the room refuses past has to fit inside `MAX_WS_MESSAGE_BYTES` or it is never reached.
It did not: 50,000 cells against a 16 KiB frame meant any fill past roughly 1,700 cells killed the
DM's socket and reloaded their page, which is well inside the "large dungeon room" this feature is
for. It is now 8,000 against 128 KiB, `MAX_FILL_CELLS` in `fogtool.ts` mirrors it, and
`largest_override_fits_in_a_frame` asserts the pair rather than trusting them. The general rule that
came out of it is in `docs/net.md`; what it costs *here* is that the two numbers move together, and
a fill bigger than a level is not a case worth widening the socket for.

`fillFrom` in `overrides.ts` is **not the raycast written twice**. That asks whether a viewer can see
a cell; this asks whether two cells are connected. They read the same walls and are different
questions, and they do not have to agree: a fill that squeezes through a gap the DM traced badly is
exactly what the preview exists to show them before they commit. Four-neighbour rather than eight,
which is the conservative reading — a fill that stops short is a second click, one that escapes is a
repaint.

**Doors are where the two questions part company: every traced segment bounds a fill, open or shut.**
This is the one place in the project a door's state is not read, and it shipped the other way round
in 16b — the fill borrowed `blocks()` and skipped an open door as "a way through". That was wrong
twice over. A dungeon traced for *sight* leaves its archways open on purpose, so no room reached
through one could be filled at all; the fill escaped into the whole connected map and the only rooms
that worked were the handful sealed by a shut door. And those stopped working the moment the party
swung it, which made the region a click selects depend on play-time state that has nothing to do with
which cells make up the room.

So an archway is traced as a door left open. It blocks nothing the party does and it bounds this,
which is what makes a room selectable without blinding a creature standing in the doorway. The rule
the DM holds in their head is *a fill is bounded by everything I traced*, and the cost is that a room
plus the corridor past its open door is two clicks — the conservative side again, and the same
argument four-neighbour already made.

### A cell a wall runs through is a dead end

The second thing 16b got wrong, and the one that actually escaped. `crosses` was copied from the
raycast including its permissive ties, which is right for a *creature* — a viewer standing on a wall
is not blinded by it — and says nothing useful about a step. A cell whose centre sat exactly on a wall
let the fill walk in from one side and straight out of the other, because every step touching that
cell ties at one end or the other. One such cell is a hole, and by now this file has said three times
what a hole is worth.

It is not a rare tie. Corner-snapped masonry cannot produce one — a wall on the corner lattice runs
*between* cell centres and never through them, whatever the grid offset. **A wall at 45 degrees runs
through a cell centre every other cell**, and a chamfered room corner is made of exactly those. So the
leak fired on the carefully traced maps and not on the boxy ones: the dungeon it was found on has four
such cells, and a fill from the middle of the party took 308 of the board's 368 squares, including the
void outside the building.

Such a cell is genuinely half in and half out, and there is no right single answer for it. **So it is
taken by whichever fill reaches it, and expanded out of by none** — `cutByWall`, checked once per cell
as it comes off the queue rather than folded into `crosses`, which stays permissive. That is the
answer that is right twice: a room's fill covers its own chamfered corner, so the DM gets no ragged
square to notice and paint over; and the fill cannot get through the wall, because the way out is what
was taken away. Both sides may claim the same cell, which is the honest reading of a square the wall
cuts in half. On the dungeon above, the party's fill goes from 308 squares to 101 and reaches the
image border nowhere.

The seed is not special-cased: clicking exactly on a chamfer fills that one square. Strange to ask
for, and letting it expand would put both sides of the wall into one fill.

**`fog.rs` keeps the permissive tie and needs no equivalent** — a creature in a doorway is a real case
there, with tests named after it, and sight has no notion of walking through a cell to reach the next
one. The two are allowed to disagree; that is the paragraph above this one. What is worth knowing is
that the same lattice fact reaches sight from the other side: a token standing on a 45-degree wall
sees through it, because that is the tie at `p` working as designed on a case it was not designed for.

## Two lighting modes, and one question underneath

Milestone 21. `lighting: Dynamic | Room` on `MapInfo`, beside `fog` and `vision_ft` and remembered
per URL with them, so the outdoor map keeps line of sight and the dungeon reveals a room at a time.

```
Dynamic   rays                 a cell is lit when a straight line reaches it
Room      flood ∪ rays         …or when a walk does
```

`fog::sight_cells` is the one place the mode is read, so `recompute_sight` is a single call and
**nothing downstream knows there are two.** The mode changes what the party can see and not what any
of it means: `revealed`, `known` and `visible` are built from the answer exactly as before, the
fringe still widens `known`, the DM's mask is still applied after, and `unseen_by_table` is
untouched. It bought no arm in `message_for`, no field on the wire past `MapInfo`, and no second
derived set.

### The doorway carries sight, not light

**`Room` is a union**, and that is the correction one session on a real dungeon forced. One sentence
for the DM: *you see the whole room you are standing in, plus whatever you have a straight line to.*
It can never hand the table less than `Dynamic` would.

The flood shipped reading `blocks()` — an open door was a way through, on the argument that an open
door is how light reaches the next room. In play that makes an open door **a hole in the room
boundary**: a one-cell hallway hands over the whole chamber past it, and the only marker that bounds
a room is a shut door somebody has to swing by hand as the party moves.

So the flood bounds on **every traced segment, open or shut**, which is `fillFrom`'s rule in
`overrides.ts` — the one this file already taught the DM under *The fill runs on the client*: **an
archway is a door left open.** It was the established idiom everywhere except here.

| segment    | bounds the flood | stops a ray |
| ---------- | ---------------- | ----------- |
| masonry    | yes              | yes         |
| shut door  | yes              | yes         |
| open door  | yes — the archway | no         |

What an open door hands over is therefore the **wedge visible through it** rather than the room
behind it, which is what opening a door does at a table. Only sight reads a door's state now, which
is one rule fewer than the two this file used to carry — and `lit_cells` is openly the same
*question* `fillFrom` asks, in a second language, kept separate for `shape_covers`'s reason: that one
previews what the DM is about to paint, this one decides what the party is handed, and a
disagreement at the fringe changes a preview rather than a permission.

**A shut door still genuinely seals a room** — both halves stop at it — which is what makes doors
load-bearing rather than decorative.

Considered and not built: a `WallKind::Archway` of its own. It would bound light and nothing else,
which is exactly what an open door now does, and a third variant in a closed set costs the editor's
mode strip, the renderer, `AddWalls`, and the client's two-state `Wall.door`. `ROADMAP.md` asked
whether an archway needed its own kind; the answer is no. If a permanent opening ever needs to be
un-swingable, it is still available.

**It is bounded by the radius as well as by the walls**, Euclidean from the source like the
raycast's. A pure fill does not respect corners — walk into a winding corridor and the whole of it
lights to its far end, around every bend — and bounding it keeps `vision_ft` meaningful in both
modes rather than dead in one. A hall bigger than the radius is a map whose radius should be raised;
there is no second number.

**A cell a traced segment runs through is a dead end**, `cutByWall`'s rule matched segment for
segment — see *A tie is contact* below, which is the same lattice fact from the other side.
Corner-snapped masonry never produces such a cell; a wall at 45 degrees produces one every other
cell, and a chamfered room corner is made of them. Taken by whichever fill reached it and expanded
out of by none. The seed is not special-cased either, so a token standing inside masonry lights the
one square it is standing in — visibly wrong in a way the DM goes and fixes, which is the direction
this has to fail.

**One fill per source, unioned, and deliberately not one sweep sharing a visited set.** The raycast
may short-circuit on a cell another torch already lit because rays are independent; here skipping
such a cell would stop that source expanding *through* it, and a fill that never enters the corridor
never reaches the room past it.

Leaving a room un-lights it, and no new rule was needed for that: terrain gates on `known` and
creatures on `visible`, so the room stays dimmed and whatever wandered in while the party was away
does not show.

**A bad trace fails loudly** — one gap merges two rooms in front of everybody, instead of leaking a
sliver of sight nobody notices. That is the mode's best property and its sharpest cost: what the DM
has to hold in their head is *every wall and door I trace bounds a room*, and the panel's hint says
exactly that, because a room that lit further than they meant looks like fog and not like a gap.

Unlike `shape_covers` there is **no client twin**: the table is sent a `FogView` and asks nothing,
so there is no second copy to keep loosely in step. The whole of the client's half is two buttons in
the panel and the sentence under them.

## Raycasting, not shadowcasting

How `Dynamic` answers it, which is what every map did before there were two modes.

`ROADMAP.md` specified symmetric shadowcasting. It does not fit, and the reason is worth keeping:
**shadowcasting wants opacity to be a property of a cell, and a wall here is an arbitrary segment in
image pixels.** The DM traces freely, Alt places off the lattice, and a cave wall is a diagonal.

Rasterising a segment into blocking cells is not a lossy version of the truth — it is a different
dungeon. A wall traced *along* a cell boundary, which is the common case because `snapToCorner`
puts it there, would blind the cells on both sides of the line and shrink every room it encloses by
one square all the way round.

So the rule is one sentence instead:

> A cell is visible when the straight line from the viewer's centre to that cell's centre crosses no
> solid wall and no shut door.

It reads the segments as they were traced, it is explicable to a player who asks why they cannot see
something, and it is a page of code rather than three. The roadmap's line changed; the invariants it
was protecting did not.

**Ties at the ray's own ends are permissive; ties in the middle of it are not.** Touching is the
whole difficulty in `crosses`, and it is systematic rather than rare — cell centres and
`snapToCorner`'d wall corners sit on the same lattice, so a ray straight through a wall's endpoint
is the common case and not a coincidence. Three cases fall out of the one rule:

- A viewer standing *on* a wall is not blinded by it, which is what happens to a creature in a
  doorway otherwise. A tie at `p`.
- A ray *ending* exactly on a wall's endpoint slips past its tip — corner peeking, which every VTT
  has and which errs towards showing the player something. A tie at `q`.
- A wall's corner sitting exactly *across* the ray stops it. A tie in the middle.

The first draft said "proper intersection: touching does not count" and tested it as `(d3 > 0.0) !=
(d4 > 0.0)`, which is not that rule and is not any rule: negating a side flips a negative to positive
but leaves a zero reading as "not positive", so **the answer depended on which end the ray was cast
from.** Two tokens either side of a wall's free end, one seeing the other and not being seen back.
The viewer-on-a-wall case was half-broken the same way — blind along the wall in one direction and
not the other — and its test asserted only that they could see their own square, which was true
throughout.

A tie is a measure-zero event that only happens at all because both spaces are on a lattice, so
either answer is defensible; being the *same* answer both ways is not optional. If the middle case
ever wants to be permissive too, it is one `within` call to delete.

**The radius is Euclidean, so vision is a circle.** That agrees with a drawn circle and disagrees
with the movement ruler, where a diagonal step costs one cell and "within 20 ft" is a square. It is
the same disagreement *Distance* in `docs/drawings.md` already names and leaves standing, for the
same reason: different questions. A radius of light is a circle.

### The radius is measured in cells, and that is why the sweeps take grid units

`sources` arrives in **grid units** where every other coordinate in this file is image pixels, and
the conversion happens once per source inside the loop. That looks backwards, and it is the one part
of the coordinate story that is not "walls are pixels, so rays are pixels". It is there because of a
tie.

A radius set in feet is a whole number of cells — `vision_ft` is a multiple of five and a cell is
five feet — and an odd-sized token stands on a cell centre, so the cells due north, south, east and
west at exactly that distance sit **exactly on the circle**. At twenty-five feet the two ends of
every 3-4-5 triangle do as well. That is the same kind of event as the wall ties above, and the same
rule decides it: *a tie is answered the same way from both ends.*

Measured in pixels it was not. `(c + 0.5) * grid_px - x * grid_px` and `radius_cells * grid_px` are
two roundings of one number and they disagree in the last bit, so the cell six east of the torch
landed inside the circle and the cell six west of it outside. The circle grew a nub on one edge and a
bite out of the other, **and which edge it was changed as the token walked**, because the answer
depended on the absolute pixel numbers rather than on the distance. A power-of-two grid is exact and
hides the whole thing; a map calibrated to 35.65 pixels a cell is not, and about a fifth of
(grid, offset, position, radius) combinations showed it.

Measured in cells the arithmetic is exact for the numbers involved — `13.5 - 9.5` is `4.0`, and
`sqrt(16.0)` is `4.0` — so both sides of a tie answer together and the circle is symmetric by
construction rather than by luck. **It is not a precision problem, and widening to `f64` does not fix
it**: a tie is decided in whichever space the comparison is made, so it has to be made in the space
where the numbers are exact.

The pixel radius stays for the two things that are genuinely pixel questions: culling the walls to
the viewer's reach, and clipping the sweep window. Both are bounds rather than the answer, so a cell
either way costs a little work and never a wrong picture.

`lit_cells` takes the same split — cells for the step test, pixels for the cull — and `solo.ts` and
`fillFrom`'s `withinCells` carry the change to the client, because the DM's sight check has to agree
with the fog it is previewing. The regression tests are
`the_circle_is_the_same_on_both_sides_of_the_viewer` in both languages: they sweep the awkward grid
sizes and assert the lit set is its own mirror, which is the assertion that fails on the pixel
version and cannot be made to fail on this one.

**A monster is visible if any cell it covers is.** A four-cell ogre leaning into a lit corridor is an
ogre the party can see, and asking only about its centre would hide half of it behind the wall it is
standing beside. That is `covered_cells`, which uses the same lattice `snap_to_cell` settles onto.

### What it costs

The product of cells swept and walls not culled, per source. Both halves are bounded before the
loop: walls further from the viewer than the radius cannot be crossed by any of its rays and are
dropped **once per source rather than once per cell**, and the sweep is clipped to the board. The
short-circuit on a cell another torch already lit drops most of the work of the second party member
onward, because five people stand close together.

It runs on a drop, never on a drag frame — see *When it recomputes*.

### The play-area boundary is an implicit wall

Vision does not spill into the void off the edge of the map. Nothing in the wall editor produces
that boundary and nothing should, because it is already on `MapInfo`.

It is enforced twice, and both are needed. The four edges are in the blocker list, which is what
stops a viewer standing off the board from seeing onto it; and a cell whose centre is off the board
is skipped outright, which is what stops the party exploring the void.

On a map with no play area — which is what the DM's own "use the whole image" button leaves behind,
so it is the common case rather than the odd one — the board is `MAX_MAP_PX`, the same bound the
walls are held to. **That is not tidiness.** A token dragged to cell one million would otherwise
reveal cells there, and the rectangle packing them alongside the dungeon is the whole map's worth of
characters on every send.

## `FogView`: a rectangle of characters

```
#  never seen        o  explored, not in sight now        .  in sight
```

Row-major, one character per cell, with the rectangle's origin and size beside it. **The rectangle
is the bounding box of what has been explored**, and every cell outside it is dark by definition —
which is what lets it shrink to the interesting part of a large map, and what makes an unexplored
map pack to nothing at all.

A string rather than an array of per-cell values because the wire protocol asks for frames a human
can read in devtools, and a few thousand numbers is not one. A few thousand characters laid out as a
map *is*: the shape of the dungeon is legible in the string.

`None` in place of one means the map is not fogged, and it is the only thing the server could mean
by it — the trick `staged` being `None` plays, and the reason turning fog off needs no second field
on the wire.

**The same value reaches everyone.** Fog is party-shared, so there is one answer and nothing
per-client left to build; `Event::FogChanged` is the one arm of `message_for` that does not filter.
That is the exact opposite of `WallsChanged` sitting beside it, and the pair is the design in
miniature: **the geometry is the secret, and the shadow it casts is the thing the table plays with.**
Players infer the floor plan from the edges of the fog, which is why walls stay out of their
snapshot even though fog is the only thing they can see the effect of.

## The third reason a token is unseen

`Token::unseen` used to be *the* question every filter asked. It is now half of it.

```rust
fn unseen_by_table(&self, token: &Token) -> bool {
    token.unseen() || !self.in_sight(token)     // hidden || staged_only || out of sight
}
```

Two of the three reasons are facts about the token and stay on it. The third is a fact about the
*room* — where the walls are, where the party is standing, how far their torches reach — so it
cannot be answered from `&Token` alone, and **that is why the funnel moved up to `RoomState` rather
than growing a third field down there.**

All three compose and every filter has to ask about all three. `snapshot_for`, `initiative_for`,
`shape_seen`, both oracle guards in `check`, and all four token arms of `message_for` go through
this one function. Anything that asks `Token::unseen` directly is filtering on two of them.

**16b added a fourth reason and no fourth question**, which was the thing to get right: the DM's
override changes what `visible` holds, so `in_sight` returns a different answer and this line is
untouched. See *The DM's override* above.

### `was_unseen` had to change meaning, everywhere

This was the expensive half of the milestone, and milestone 11's note predicted the shape of it.

Every event carrying `was_unseen` is answering "did the table hold this token a moment ago". That
used to be `Token::unseen()`, read just before the field it describes was overwritten. With fog it
has to be `unseen_by_table`, and there were four sites:

- `UpdateToken` reads it **before taking the mutable borrow**, since the question needs `&self`.
- `delete_token` reads it **before the removal**, since afterwards neither half can be asked.
- `promote_staged_tokens` reads it **for every token up front**, because a promote sweeps the fog
  and by the time the loop runs the lattice it was asked about is gone.
- `CreateToken` is the one that did not change: nobody held a token that did not exist.

Missing any of them is a real leak rather than a cosmetic one. Renaming a monster standing in the
dark would send the table a `TokenRemoved` naming an id they have never held — which announces that
the id exists, and is precisely what `hidden` was built to prevent. There is a test named after it.

`Event::Promoted` grew a third outcome for the same reason: a planned token landing somewhere the
party cannot see has to be *taken off their board*, not merely left undrawn at the cell it used to
stand in, on a map that is no longer there.

## When it recomputes

`moves_sight` is `persists`'s twin, and enumerated the same way rather than with a catch-all: a
command added later and forgotten there leaves the fog quietly stale, which looks like a bug in the
raycast rather than a missing arm.

The reading is taken in `handle`, **before `apply` runs**, and only for the commands that could move
it — the packed string costs too much to build on a drag frame arriving thirty times a second from
each of six people. Its token half is not built there at all; see *Drag frames* below.
`refresh_fog` then recomputes and reports the difference as events:
the fog frame, a `TokenChanged` for every token whose visibility flipped, and the initiative panel
and the shape list if any of those tokens is named there. Both of the last two are gated on
something actually having changed, which is load-bearing for the third time in this project: an
unconditional `ShapesChanged` on every step would tell the table that *something happened* every time
anybody moved.

A token the command has already spoken about is not spoken about twice — those events carry their
own `was_unseen`, read through the same question. **`TokenMoved` is deliberately not on that list,
and it is the interesting exclusion**: walking out of the light is *how* a creature stops being
visible, and the move frame has just been dropped for exactly the recipients who now need to be told
it is gone.

### Drag frames

The roadmap's rule, kept: **recompute on the drop.** The raycast is cheap enough at 30 Hz and
shipping a packed rectangle to six people that often is not, so the fog opens as a token settles
rather than as it travels.

What still happens mid-drag is the *filter*. A monster dragged into a cell the party cannot currently
see stops being relayed to them at once, because that decision reads `visible` rather than rebuilding
it. The player is left holding it at the last position they saw until the drop lands and takes it off
their board — a drag's worth of staleness, and the alternative is thirty bitsets a second.

**And that drop is why `Sight.seen` is copied off `RoomState::shown` instead of being computed where
the rest of the reading is.** The reading exists to answer "what could the table see a moment ago",
and reading it off `&self` answers "what can they see right now" — which is the same sentence only if
nothing has moved since the last recompute. A drag frame is the one thing that moves a token without
one. So by the time the drop asked, the creature was already standing in the dark, the room answered
*they never saw it*, `refresh_fog` found no flip, and no `TokenRemoved` was sent: the monster stayed
on the table's board at the last cell a drag frame reached them, for the rest of the session. It was
worst exactly where fog matters most — the DM walking something out of the light is the ordinary way
a creature stops being visible.

`shown` fixes it by writing the answer down **when it is true rather than asking for it afterwards**.
It is a set of `TokenId`, derived and never persisted like `visible`, and `recompute_sight` is its
only write — which is what makes it correct rather than merely cached: everything that can change the
answer recomputes, `moves_sight` enumerates that, and the sole exception is the drag frame this
exists to survive. It is written after both branches of the recompute, because switching fog *off*
shows the table every token and is as much a change to the answer as a raycast is.

Nothing downstream knows about it. `refresh_fog`'s flip loop is unchanged, so the initiative row and
the anchored aura come off the table's board with the creature through `anchors_a_shape`, exactly as
they already did when somebody walked out of a doorway.

**`Sight.shapes` beside it stays a live reading, and giving it the same treatment would be a bug.**
It looks like it wants one — an anchored shape's visibility is a token's, so it goes stale on a drag
in the same way — but the token loop above already covers that case, and the shapes are the one list
here that a command *outside* `moves_sight` can change: `AddShape` and `RemoveShape` are neither
recomputed nor gated. A record written only at the recompute would therefore miss them, and the next
person to walk anywhere would find `before.shapes` disagreeing with the room and emit a
`ShapesChanged` announcing to the table that something happened. `seen` has no such gap, which is the
whole reason it can be written down and this cannot.

The cost is that a room built without `spawn`'s boot recompute now claims the table has been shown
nothing, and reports every token as newly appeared on its first command. That is a real trap and it
caught fourteen tests: `room()` and `reboot()` go through `booted` for the same reason `spawn` calls
`recompute_sight`, and `the_fog_survives_the_save_file` asserts both halves — absent from the
constructor, derived back by the boot.

## What sweeps it

**A map load and a promote clear all three sets**, through `sweep_board`, alongside the shapes and
the walls. The three go together through `forget_fog` rather than as three lines at each call site,
because the third one is exactly what gets missed when somebody adds a fourth — and a `known` left
standing after `revealed` is cleared is the whole map still sitting on the table's board.

**A recalibration clears them too, and this is where fog differs from the walls it is swept beside.**
A wall is image pixels and still traces the same painted line after the grid moves; these are cells,
and the squares themselves have just moved. Redrawing the play area counts as well — what was
explored outside the new edge is not somewhere the party can be.

Asked of the board's *shape* alone, and that is the point: turning the vision radius up is not a
reason for the party to forget the dungeon, and neither is the grid's colour or turning fog off and
on again.

**The overrides go with them, by the identical argument** — they are cells, and the squares they name
have just moved out from under them. That is both places: `sweep_board` for a load and a promote, and
the `reshaped` branch of `SetMap` for a recalibration.

**Since milestone 31 the paint is filed rather than destroyed on a load, and `revealed` is not.**
The DM's mask is authoring, so it goes onto the shelf with the walls of the image it was painted on
and comes back when that image does; where the party has *explored* is play, so returning to a
dungeon means re-exploring it. That split — the DM's authoring is remembered, the party's play state
is not — is what keeps a map load from becoming a partial scene restore. Two orderings hold it up:
the shelf is written before the sweep clears anything, and on a load the `reshaped` branch above is
skipped entirely, because emptying the overrides first would file the DM's paint as nothing. See
*The shelf* in `docs/maps.md`.

`sweep_board` emits no event of its own for the three sets. `refresh_fog` runs afterwards and
compares against a reading taken before any of it, so the clear is already in the difference it
reports. **The overrides do need one**, and that asymmetry is the point of them: nothing recomputes
authoring data, so without an `OverridesChanged` the DM's own panel would go on drawing a mask the
room no longer holds.

### And `ResetFog`, which is the DM asking for it

`sweep_board` without the board: `forget_fog` and the overrides, and not the shapes or the walls,
because this is the fog starting over rather than the map. The whole board goes dark and comes back
as whatever the party's tokens can see from where they are standing.

**One command rather than two.** "Forget the exploring" and "clear the paint" are one gesture — *this
map has not been seen yet* — and splitting them offers a reset that leaves the map lit, which is the
state nobody wants. It stopped being `ClearWalls`'s neighbour when it grew the first half: the walls
are all the DM's work, and the party's exploring is not.

The events are `OverridesChanged` for the DM and the `FogChanged` `refresh_fog` finds for everybody,
which is the same pairing every paint stroke produces. There is no undo, so the confirm prompt names
both halves — the exploring is the one that surprises.

## On disk

`revealed` and `overrides` are persisted; `known` and `visible` are not. The fringe is not either,
being part of what makes the first of those two — a save holds the rays and the widening is rebuilt
on top of them on boot.

An evening of exploring belongs to the map it was done on, and this is the one thing on `Saved` that
would make the feature feel broken if it were left in memory. Sight is derived from where the tokens
are standing and what blocks the rays between them, both of which the same file already holds — and
deriving it is how a save written before a door was shut cannot describe sight straight through it.

The file reuses `FogView`, packed against an empty `visible`, so every explored cell records as `o`.
`unpack` reads both lit states as explored, so neither side has to know which it is looking at.

The overrides beside it are the mirror image, and the pair is worth reading together: that field is
half a derived thing and records only the half that cannot be recomputed, while this one is not
derived at all. No amount of walls and tokens would give back what somebody decided, so it is stored
whole and applied again on boot — which is a load-bearing difference and not a symmetry worth tidying
into one rule.

## Three fields on the map, and no command of their own

```rust
fog: bool,             // is this map fogged
vision_ft: f32,        // how far a player-owned token sees
lighting: Lighting,    // and how that reach is worked out
```

Per map rather than per room, and remembered per URL in `Calibration` with the grid: a dungeon wants
fog, room lighting and a short radius while the meadow outside it wants none of the three, and the
DM should not have to remember which is which when they swap between them.

Both go out on `SetMap`. There is no `SetFog`, for the reason there is no `SetHp` — it would be a
second way to write one record, and two writers is how they come to disagree. The client sends them
through `MapTool.setFog`, which owns the *confirmed* calibration, so a fiddle with the fog cannot
commit an unapplied grid preview.

**`lighting` defaults to `Dynamic`** for the reason `fog` defaults to off: it is what every map did
before the field existed, so a save that predates it describes the same dungeon after loading. That
is invariant 2 doing its job in the one direction it can — see milestone 20's note that it protects
a field being *added* and does nothing for one changing shape.

**`fog` defaults to off**, and that is the whole of the roadmap's warning about a radius defaulting
to zero and every restored room going pitch black. A switch that defaults to off cannot make that
mistake whatever `vision_ft` loads as, which frees the radius to default to a playable 60 feet
rather than a defensive number.

Nothing here knows the word "darkvision". One radius for the map; per-token vision is a larger
feature and is not built.

## On screen

**Over the terrain and under everything standing on it.**

Under the tokens is the DM's half of the feature: their monsters stay at full strength over a faint
wash, so the board they are playing on is still legible while it also says what the table can see.
A player has no token in the dark to be washed out — every one they hold is a vision source, or is
standing where one is looking — so the order costs them nothing.

The DM sees a **faint** wash rather than the table's view, which is the same bargain masonry makes on
their screen: drawn always, faint until the editor is armed. It is also why they are sent the fog at
all.

**No wash while previewing, and the override tint regardless** — which is the one place the two
layers part company. The bitsets belong to the live board because nothing has cast a ray on the
other one; the mask does not, and over a preview it is the only thing on screen saying what the DM
has decided. See *No staged fog* above.

### One `drawImage`, whatever the dungeon looks like

A fogged board is a few thousand cells, and a `fillRect` per cell per frame is a slideshow. `fog.ts`
turns the packed rectangle into **a small canvas**, painted once per `fog_changed`, and the renderer
stretches it over the board.

**The edge is feathered, and what makes that safe is `SUBCELLS`.** A fog edge is an approximation of
where a wall is, and a crisp line claims a precision the raycast does not have — a ramp understates
it, which is the more honest picture. But the obvious way to get one is wrong: the canvas used to be
*one pixel per cell* with smoothing off, and simply turning smoothing on there ramps across the whole
square **and moves the boundary half a cell**, because bilinear sampling anchors on pixel centres.
That displacement is what the old "smoothing is off" comment was defending, and it was right about
the danger and wrong about the only cure. Drawing each cell as a solid block of `SUBCELLS` pixels
first and stretching *that* keeps the boundary exactly where the server put it and confines the ramp
to a quarter of a cell.

**The override tint next door keeps its hard edge**, and the asymmetry is the point: a fog edge
approximates a wall, while an override edge is exactly the squares the DM clicked. Softening the
second would misreport their own paint back to them.

The four bands around that rectangle are filled flat and clipped to the board, since everything
outside it is dark by definition. Same trick `drawOutsidePlayArea` uses, and here it is what lets the
packed frame shrink to the interesting part of a large map.

**Nothing in `fog.ts` is a visibility decision.** A creature the table cannot see is absent from
`scene.tokens` rather than drawn and painted over — painting over it would put the position on the
client, which is what invariant 4 forbids.

`overrides.ts` beside it is the same trick for the DM's mask, and nothing in it is a decision either:
the board is already dark where the party cannot see, and this only says which of that somebody put
there. Its layer draws directly over the fog and is one `globalAlpha` rather than two canvases —
which is why the tint is built at full strength and faded at draw time, so opening the panel changes
a number instead of rebuilding a canvas.

## The panel

A switch, a mode, a radius, and a brush. The first three are the map's and go out as part of a
`set_map` through the map tool, which owns the confirmed calibration; the fourth is not the map's
and sends its own command.

The mode is two buttons rather than a "light whole rooms" checkbox, because it is a choice between
two ways of working out what the party can see and a checkbox names only one of them. They arm
nothing — clicking one sends a `set_map` and the board that comes back is the answer — so `.is-on`
there means "this is what the map says" rather than "the left button is spoken for", which is the
one place that class does not mean a tool is in hand.

The radius is greyed rather than hidden while fog is off — it is still the map's number, and hiding
it would make turning fog on look like it had also invented one. The brushes grey the same way and
for the same reason. `change` rather than `input` on the radius, so typing `1` on the way to `100`
does not send a radius nobody asked for and recompute the whole board for it.

**Live over a preview since milestone 20**, panel and tab together, for the reason the wall editor
is: the staged board has a mask of its own to paint. The switch and the radius come with it — they
are `MapInfo` fields and have staged since 16a, and only the client was refusing them — so the next
dungeon's lights are set before the table is shown it. Reset is the one control still greyed there,
and *No staged fog* above says why.

The hint carries the weight the board cannot: over a preview it says what painting there means,
because there is no wash under the tint to make that obvious.

**16a's note that this was the one tab with no `stop()` is no longer true**, and the reason is worth
keeping: it arms nothing *because the party's tokens are what move the fog* — and the override is the
one part of it the DM places by hand, so it is a tool holding the left mouse button like any other.
One left armed under a hidden panel is a click doing something with nothing on screen saying why,
which is the rail's rule and now applies here too.

The hint says what a torch does, and it says it differently in the two modes: the `Room` wording
names the door, because a door is what that mode makes load-bearing and because a room that lit
further than the DM expected is nearly always a wall with a gap in it.

Below all of it, **sight check** — which edits nothing and belongs to the panel anyway, because this
is where the DM comes to reason about what the table can see. See *Solo sight* below.

Four brushes and two gestures:

- **ground** hands the terrain over and leaves whoever is standing on it alone; **lit** hands over
  both; **dark** takes both away, memory included; **clear** hands the cells back to line of sight.
- **fill** floods from the cell under the pointer, bounded by every traced segment and previewed
  before it commits; **paint** applies the brush to the cells the pointer is dragged across.

**The preview is not decoration.** One gap in a traced room reveals the whole dungeon in a single
click and there is no undo, so the region is shown in the colour it would land in and the DM's own
eyes are the check on the geometry. It is recomputed only when the pointer crosses into a different
cell, which is what makes a flood of a few thousand affordable on a pointer move.

A paint stroke accumulates on the tool and goes out as **one command** when the button comes up. A
frame per cell would be a hundred of them across one drag, and there is nothing to predict — the
answer is already on screen.

## Solo sight: what one creature can see

> **Not offered right now.** Milestone 34 hid the button — `SOLO_SIGHT` in `fogtool.ts` is the whole
> of the suspension — because player view answers the question a DM was actually reaching for it
> with, and answers it for the whole table at once. Asking about one creature became the narrow
> version of a question with a better button beside it.
>
> **Nothing else was taken out.** `solo.ts`, `solo.test.ts`, `frame.solo` and `drawFog`'s branch are
> untouched and still correct; what is switched off is the way in, and everything below is still the
> design. **Milestone 29 is what brings it back**: the day `visible` is per-player there is no single
> table's board to mirror, player view has to name somebody, and *can the rogue see it* stops being
> the narrow version of anything. `drive-panels.mjs` asserts the button is unreachable, which is the
> check that fails on the day the const flips.

Milestone 26, and `solo.ts` is the whole of it. The DM arms *sight check* in the fog panel, clicks a
creature, and their own board stops showing the table's wash and starts showing that creature's line
of sight. It answers the question that actually gets asked at a table — *can the rogue see it* — and
it is the only part of per-player fog worth having.

**Per-player fog itself stays refused**, and this is why the refusal costs nothing. The architecture
would take it: per-client `mpsc`, `snapshot_for`, and `FogView` is already built per recipient. What
it costs is play. `unseen_by_table` would become `unseen_by(client)` at six call sites, `FogView`
would stop being the one message identical for everyone — and there is no defensible answer for what
the *DM's* board should then show, which is usually the sign a question was posed wrong. Six people
narrating to each other get nothing from five answers unless the party splits, and a split is one
sentence from the DM.

**Client-only, and nothing goes in the room.** It is a second raycast over data the DM's client
already holds — the walls, the radius, the mode, and where everybody is standing — so it needs no
command, no event and no filter. It is leak-proof **by construction rather than by a check**, which
is `crossesWall`'s argument for the movement hint word for word: a player's scene carries no walls,
so their client could not compute this if it tried, and nothing in `solo.ts` asks who is reading it.
*No staged fog* above sets the precedent for a second raycast living on this side; `shape_covers`
sets it for a geometry rule living in two languages.

It reuses the pieces rather than inventing any:

- **`crossesWall` for `Dynamic`**, which already filters to solid walls and shut doors, over walls
  culled to the radius once per source — the same bound `fog.rs` takes, and for the same reason.
- **`fillFrom` for `Room`, unioned with the rays**, which is *The doorway carries sight, not light*
  said again on the client. `fillFrom` grew an optional `withinCells` radius for it, measured from
  the seed and defaulting to unbounded so the DM's reveal preview is unchanged — in cells, for the
  reason *The radius is measured in cells* gives.
- **`fogFromWire` for the picture.** `soloSight` returns a `WireFog`, packed exactly as the server
  packs one, so there is no second rendering path to keep in step and the wash is guaranteed to look
  like the one it stands in for. It draws at the **table's** strength rather than the DM's faint one:
  the faint wash exists so the DM can play on a board that also says what the party can see, and this
  is a question with an answer that has to be legible.

Two things it deliberately does not do, and both keep it one question rather than two:

- **No memory.** Two states, `#` and `.`, never `o`. What this creature's eyes reach *now* is the
  question; what the party remembers is a different one and `revealed` already answers it.
- **No overrides.** Geometry only. The mask is the DM's own hand and they know what they painted;
  folding it in would answer "what would the table be shown" instead.

**Live board only**, so the button greys over a preview exactly as `ResetFog` does and for the same
reason — nothing raycasts a board nobody has been shown.

One button, three states, and **the order of its two branches is load-bearing**: anything on the
board comes off first. With an answer up, the button is the way back to the table's board, which is
what the hint under it promises — re-arming there instead leaves the DM holding one creature's sight
with no control on screen that takes it away. That shipped wrong once and `drive-panels.mjs` caught
it. `stop()` clears the answer as well as the arming, which is the rail's rule about closing a tab
applied to a wash rather than to a tool: a wash nobody can account for is worse than a click nobody
can account for. Meanwhile the board says so with the preview tag's treatment in blue.

`drive-panels.mjs` asserts the half that matters in one reading: the DM's board moves and **the
player's moves by nothing at all**. It is worth knowing that the first version of that check opened
both browsers on the same debug port, so "the player" was the DM's own page — the two numbers came
back identical and it read as a leak. The ports are fixed and they are not a detail.

## Player view: the whole table's board

Milestone 34, and `mirror.ts` is the whole of it. The DM clicks *player view* in the fog panel and
their own board becomes the one the table is looking at: the party's fog at the party's strength, no
walls, no painted squares, no hit points, no plans, and nothing standing anywhere they cannot see.
Clicking it again gives them their board back.

**Solo sight's sibling, and the broad half of the same question.** `solo.ts` asks whether one
creature can see something; this asks what the six screens are showing. Both are the fog panel's,
because the fog is what makes either worth asking — and **the broad half turned out to be the one
worth offering**: the sight check went behind `SOLO_SIGHT` days after this landed, because a DM
reaching for *can the rogue see it* was nearly always asking what the table's board looks like. See
the note at the top of *Solo sight* below; that is the version this replaced, not a version that was
wrong.

**It earns its keep because the fog is party-shared.** There is exactly one answer to "what can the
table see", so a mirror of it is a fact rather than a pick between six of them — which is also the
line that would have to be re-argued if milestone 29 ever made `visible` per-player. `asTable` is
where the name would have to go, and the feature would need a defence it does not need today.

**Client-only, and nothing goes in the room.** No command, no event, no filter; the server does not
know the DM is looking at this and must not learn. That is `solo.ts`'s rule and `previewing`'s before
it. The difference from both is worth saying plainly: **nothing here is a security boundary.** It
*removes* things the DM is entitled to and is entitled to put back, so every line of `mirror.ts`
could be wrong without a player learning anything. What it is is a reading aid, and its failure mode
is a DM who believes they got away with something.

`asTable` is the **client-side twin of `snapshot_for`**, and each line names its counterpart:

- Tokens go through `unseenByTable`, which is `unseen_by_table` — all three reasons, composed the
  same way, including `in_sight`'s shortcut that a player's own token is a vision source. `footprint`
  is `fog::covered_cells` with the same nudge, so an ogre leaning into a lit corridor stays.
- What survives is `redact`, which is `Token::view_for(false)` field for field.
- Shapes go through `shape_seen`'s two arms, anchored and not, with a port of `line_cells` for the
  kind that encloses nothing.
- Walls and overrides are emptied, which is `WallsChanged`'s rule: what the table gets of them is the
  fog they cast, already on the board underneath.
- `staged` is `None` and `previewing` is false, which is the one bundle a player is never sent.

**The fog itself is not filtered, and that is the point.** It is already the table's own answer; what
differs is how faintly it *draws*. So `Fog` carries a second canvas, `table`, built at the party's
strength beside the DM's — only on the DM's client, since a player switching to it would be switching
to what they are already looking at — and `drawFog` picks between them on one line. Four cases fall
out of that line with nothing asking who is reading: the DM playing, the DM mirroring, the DM
checking one creature, and a player. `Fog` also keeps the packed `cells` it was built from, because a
canvas answers "how dark is this square" and the mirror has to ask "can the table see what is
standing on it".

**The initiative panel mirrors too, and it has to.** The panel names its rows by looking each token
up in the scene, so a mirrored scene without `tableInitiative` leaves a row drawing as a raw id — a
monster the DM hid, advertised by the one panel that is always on screen, which is the exact failure
`initiative_for` exists to prevent. It is told rather than handed a narrowed scene, because it is
redrawn only when something arrives while the board is redrawn every frame.

**It is a mirror, so it does not annotate.** Nothing is marked as withheld or outlined. A board that
says "and here is what they cannot see" is the DM's board again, which is one click away — the same
argument `docs/tokens.md` makes about the live board refusing to mark a planned token.

**It arms nothing and refuses nothing.** The DM can still drag, click and edit through it, exactly as
they can through one creature's sight; only the drawing changes, and `input.ts` goes on reading the
room's own scene. What that buys is that the mirror never has to be a second opinion about
permissions.

Three things put it down. Picking up a fog brush, because the tint is the DM's hand and the mirror is
where their hand is absent; arming the sight check, because two answers on one board answer neither —
unreachable while `SOLO_SIGHT` is off, and kept because it is the rule rather than the wiring that
matters; and `stop()`, which is the rail's rule that closing a tab puts down whatever the panel armed
— a wash nobody can account for is worse than a click nobody can account for. A preview starting takes it down
from the other side, in `update`: `asTable` answers about the live board, so a mirror over a preview
would be showing the table's board to a DM who believes they are looking at the next dungeon. The
board wears the preview tag's treatment in green, which is the third of three and the last one
available.

**Testing it.** `mirror.test.ts` owns the filter — twelve assertions, every one of them something the
DM holds that is *not* in what comes back, which is the server suite's rule for a filter applied on
this side. `tools/drive-mirror.mjs` owns the wiring, in one browser rather than two: this is a
difference between two boards on the same screen, so a second session would have nothing to say. Its
pixel check is a difference against a remembered frame *and* against a control frame where nothing
was touched, since how much of a canvas is even board depends on the framing.

## Drawings on ground the party cannot see

The other half of 16b, and the arm milestone 14 left open. `shape_seen` now has two arms asking
genuinely different questions:

- **An anchored shape follows its token's visibility.** An aura on a monster in the dark is that
  monster's position drawn in colour. That arm shipped in milestone 14, because `hidden` predates fog
  and adding shapes without it would have been a leak the day it landed.
- **An unanchored shape gates on `known`** — not on `visible`. A shape is painted on the floor
  rather than standing on it, so it belongs with the terrain: the marker a player dropped in a
  corridor is still theirs after they walk out of it, and gating on current sight would make every
  drawing on the board flicker as the party moved. It is the same split this file already draws
  between terrain and creatures, arriving for a third kind of thing.

`known` and not `revealed`, so a shape is treated exactly the way the ground under it is: handed over
with an `Explored` fill, taken back with a `Dark` one, and — since the fringe is part of what makes
that set — shown when it sits in the square of masonry past a wall the party is looking at. That last
is the fringe's one downstream reader, and it is the right answer for the same reason the fringe is:
the cell is terrain the table has been shown.

The `map.fog` guard in that second arm is load-bearing rather than defensive: `known` is empty on an
unfogged map, so without it every loose shape in the room would vanish from every player's board the
moment the switch was flipped.

**The coverage test had to be ported to Rust.** `coveredCells` and `containsPoint` are client-only
and the filter has to run where the decision is made, so `shape_covers` in `fog.rs` says the same
thing a second time in a second language. That duplication is deliberate: **the two only have to
agree loosely**, because a disagreement at the fringe changes whether a frame is sent and never how
it draws — the client draws exactly what it is given. It walks the shape's bounding box rather than
the cell set, which keeps the cost proportional to the shape instead of to how much dungeon has been
explored, and a `Line` gets its own walk because `contains_point` is false everywhere on one. Without
that walk every measuring line would be withheld from everybody on a fogged map.

`Sight` grew a second reading for it. Every *anchored* shape moves with a token, so the token loop in
`refresh_fog` was enough to gate `ShapesChanged` on; an unanchored one gates on `revealed`, which the
party changes by walking somewhere with no token of the DM's involved. Still one gate and still one
event — an unconditional `ShapesChanged` on every step would tell the table that *something happened*
every time anybody moved, which is the fourth time that trap has come up.

## What this milestone did not do

- **Walls block sight and never movement.** Decided, not deferred — see `ROADMAP.md` for the four
  reasons, the first of which is that a refused move hands back a floor plan to anybody who drags a
  token around and watches which moves stick.
- No light sources, no per-token vision, no darkvision. One radius per map.
- **No undo.** The fill previews instead, which is the cheaper answer to the same problem: the
  mistake worth protecting against is the one nobody sees coming, and a region shown in the colour it
  would land in before it lands is one the DM has already seen.

## Testing it

`tools/drive-fog.mjs` drives two real browsers at once, and that is the point: almost everything fog
does is a *difference* between what two people are holding, and one client cannot see a difference.

Its sharpest check is a network one rather than a pixel one. A token the room never sent is a token
whose **art was never fetched**, and the browser keeps that record whether or not anything was drawn
— so `performance` can answer "was this monster ever on this client" in a way no pixel can. Pixels
cannot tell "correctly withheld" from "sent, and the renderer is broken"; those are the same picture
and very different bugs.

The pixel checks it does make are *differences against a remembered frame*, which took two failed
attempts to arrive at. How dark the board **is** depends entirely on how dark the map was painted —
a dungeon of black rock reads as fogged whatever the server said. How much the board **changed** when
the switch was flipped depends on nothing but the switch.

16b's checks are the same idea used one step harder: when the DM fills a room dark, **the two boards
move in opposite directions**. The table's goes dark; the DM's gets *brighter*, because what lands on
theirs is the override tint. One measurement, and it says both that the table lost the board and that
the DM is the only one told — a player is sent no such frame, so there is nothing on theirs to
brighten.

Its own network check is a latecomer: a third browser joins *after* a forced-lit fill and is sent the
wraith. That is invariant 3 asked of the override — filtering every delta correctly and then handing
over the whole world on connect is the most common way this goes wrong, and it is the one thing no
amount of driving the two existing clients would catch.

Milestone 21's half is the only part of this driver that is not self-contained, and what it cost is
worth knowing before writing another one like it. Room lighting has no shape at all without a wall,
so the driver has to **trace one** — and a driver may neither assume the board it was written against
nor erase the DM's dungeon to make room for its own, so it runs only on a board with nothing traced,
erases what it traced, and says so and skips otherwise. It also builds its **own torch** rather than
hunting the board for one of the party: where six party tokens are standing is a fact about whatever
room this is, a ring search wide enough to find one costs a click per square, and a token the DM
creates lands in the first free cell out from the middle of the view — which is the one place both
clients are certainly looking. It is handed to a player, because a monster the DM keeps lights
nothing.

The reading itself is the fog switch's, one step on: mark the player's board under `Dynamic`, switch
to `Room`, and the ground the spur was hiding arrives. **The reverse is deliberately not asserted** —
`revealed` is memory, so switching back leaves that ground on their board dimmed rather than taking
it away. Forgetting is what `reset all` is for, which is why the run resets before it measures.

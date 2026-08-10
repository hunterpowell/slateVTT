# Fog of war

What the party can see, and what they remember seeing. The walls arrived in milestone 15 and
nothing read them; this is what reads them.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`fog.rs`, `fog.ts`, `overrides.ts`, `fogtool.ts`, `unseen_by_table`, `refresh_fog`, or the
`moves_sight` gate** — four of those seven are the places a leak would go unnoticed, and the
coordinate story in the first is the thing that looks like a mistake and is not.

This covers the whole of milestone 16: automatic line of sight in 16a, and the DM's manual override
in 16b. The two halves are separated in the text below wherever the second one changed the first.

## Two sets of cells, shared by the whole party

```rust
revealed:  HashSet<Cell>,             // everywhere the party's rays have ever reached
known:     HashSet<Cell>,             // that, as the DM's mask leaves it — what the table is shown
visible:   HashSet<Cell>,             // where they have sight now, likewise masked
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

`visible` is a subset of `revealed`, because `recompute_sight` unions in that order. That is not
incidental — it is what lets one character per cell describe both facts, which is what `FogView`
does below.

**Fog is party-shared, not per-player.** One pair of sets, the union over every player-owned token.
Five people narrating to each other on Discord get nothing out of per-player fog but confusion and
five times the state, and the DM would have to reason about five answers to "can they see this".

Vision comes from tokens a player *owns*, so handing a token over grants sight with no extra rule
and taking it back removes it. A player's own token is always visible to the table by construction
rather than by rule: it is a vision source, so the cell it stands in is lit by it.

`vision_sources` asks `Token::unseen` and deliberately not `unseen_by_table` — what the party can
see cannot be an input to computing what the party can see.

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
revealed ∪= rays                                // memory: rays only, and persisted
visible   = rays ∪ Lit − Dark                   // in sight now
known     = revealed ∪ Lit ∪ Explored − Dark    // what the table is shown as terrain
```

**`Lit` and `Explored` are floors and `Dark` is a ceiling**, over both derived sets and neither of
them the stored one. `visible ⊆ known` survives it — `revealed ⊇ rays` and the mask does the same
thing to both — which is what the one-character packing depends on.

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

### The fill runs on the client

`ClientMsg::SetFogOverride` carries **the cells, not a seed to flood from**. The DM's client already
holds the walls and has to compute the fill anyway to preview it, so sending the previewed cells
makes the preview and the result the same object rather than two runs of two implementations that
would have to agree. Nothing is being adjudicated — the DM may reveal whatever they like — so the
server has no answer of its own to defend, only a size to bound (`MAX_OVERRIDE_CELLS`) and a board to
clip against (`cell_on_board`, the same bound the sweep uses and for the same reason).

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

### A tie is contact, and contact separates

The second thing 16b got wrong, and the one that actually escaped. `crosses` was copied from the
raycast including its permissive ties, and the raycast is permissive at the ray's ends *for a
creature* — a viewer standing on a wall is not blinded by it. **A step is not a viewer.** With the
rule copied over, a cell whose centre sat exactly on a wall let the fill walk in from one side and
straight out of the other, because every step touching that cell ties at one end or the other. One
such cell is a hole, and by now this file has said three times what a hole is worth.

It is not a rare tie. Corner-snapped masonry cannot produce one — a wall on the corner lattice runs
*between* cell centres and never through them, whatever the grid offset. **A wall at 45 degrees runs
through a cell centre every other cell**, and a chamfered room corner is made of exactly those. So
the leak fired on the carefully traced maps and not on the boxy ones: the dungeon this was found on
had four such cells, and a fill from the middle of the party took 308 of the board's 368 squares,
including the void outside the building.

A cell a wall passes through is genuinely half in and half out, and there is no right single answer
for it. So it is neither side's: ties block, the cell joins no region, and a chamfer costs one ragged
square that the paint brush fixes in a click. `within` is still asked, because a tie can be anywhere
on the wall's infinite line and a cell centre level with a wall thirty feet away is not touching it.

**`fog.rs` still has the permissive rule and keeps it** — a creature in a doorway is a real case there
and there are tests named after it. The two are allowed to disagree; that is the paragraph above this
one. What is worth knowing is that the same lattice fact reaches sight from the other side: a token
standing on a 45-degree wall sees through it, because that is the tie at `p` working as designed on a
case it was not designed for.

## Raycasting, not shadowcasting

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
it — the set and the packed string cost too much to build on a drag frame arriving thirty times a
second from each of six people. `refresh_fog` then recomputes and reports the difference as events:
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
their board — a frame or two of staleness, and the alternative is thirty bitsets a second.

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

`revealed` and `overrides` are persisted; `known` and `visible` are not.

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

## Two fields on the map, and no command of their own

```rust
fog: bool,          // is this map fogged
vision_ft: f32,     // how far a player-owned token sees
```

Per map rather than per room, and remembered per URL in `Calibration` with the grid: a dungeon wants
fog and the meadow outside it does not, and the DM should not have to remember which is which when
they swap between them.

Both go out on `SetMap`. There is no `SetFog`, for the reason there is no `SetHp` — it would be a
second way to write one record, and two writers is how they come to disagree. The client sends them
through `MapTool.setFog`, which owns the *confirmed* calibration, so a fiddle with the fog cannot
commit an unapplied grid preview.

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

Nothing is drawn while previewing. The bitsets belong to the live board, exactly as the walls and the
shapes do.

### One `drawImage`, whatever the dungeon looks like

A fogged board is a few thousand cells, and a `fillRect` per cell per frame is a slideshow. `fog.ts`
turns the packed rectangle into **a canvas one pixel per cell**, painted once per `fog_changed`, and
the renderer stretches it over the board. Smoothing is off, which keeps the edge on the cell boundary
the server actually decided rather than half a cell either side of it.

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

A switch, a radius, and a brush. The first two are the map's and go out as part of a `set_map`
through the map tool, which owns the confirmed calibration; the third is not the map's and sends its
own command.

The radius is greyed rather than hidden while fog is off — it is still the map's number, and hiding
it would make turning fog on look like it had also invented one. The brushes grey the same way and
for the same reason. `change` rather than `input` on the radius, so typing `1` on the way to `100`
does not send a radius nobody asked for and recompute the whole board for it.

Inert over a preview, panel and tab together, for the reason the wall editor is: there is no fog on a
staged map, and a way in to a panel that can do nothing is the same lie as the panel looking armed.

**16a's note that this was the one tab with no `stop()` is no longer true**, and the reason is worth
keeping: it arms nothing *because the party's tokens are what move the fog* — and the override is the
one part of it the DM places by hand, so it is a tool holding the left mouse button like any other.
One left armed under a hidden panel is a click doing something with nothing on screen saying why,
which is the rail's rule and now applies here too.

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

## Drawings on ground the party cannot see

The other half of 16b, and the arm milestone 14 left open. `shape_seen` now has two arms asking
genuinely different questions:

- **An anchored shape follows its token's visibility.** An aura on a monster in the dark is that
  monster's position drawn in colour. That arm shipped in milestone 14, because `hidden` predates fog
  and adding shapes without it would have been a leak the day it landed.
- **An unanchored shape gates on `revealed`** — not on `visible`. A shape is painted on the floor
  rather than standing on it, so it belongs with the terrain: the marker a player dropped in a
  corridor is still theirs after they walk out of it, and gating on current sight would make every
  drawing on the board flicker as the party moved. It is the same split this file already draws
  between terrain and creatures, arriving for a third kind of thing.

The `map.fog` guard in that second arm is load-bearing rather than defensive: `revealed` is empty on
an unfogged map, so without it every loose shape in the room would vanish from every player's board
the moment the switch was flipped.

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

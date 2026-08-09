# Fog of war

What the party can see, and what they remember seeing. The walls arrived in milestone 15 and
nothing read them; this is what reads them.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`fog.rs`, `fog.ts`, `unseen_by_table`, `refresh_fog`, or the `moves_sight` gate** — three of those
five are the places a leak would go unnoticed, and the coordinate story in the first is the thing
that looks like a mistake and is not.

This covers milestone 16a: automatic line of sight. The DM's manual override — a tri-state per cell
and a flood-fill reveal tool — is 16b and is designed in `ROADMAP.md`.

## Two sets of cells, shared by the whole party

```rust
revealed: HashSet<Cell>,   // everywhere the party has ever had line of sight
visible:  HashSet<Cell>,   // where they have it now
```

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

**A map load and a promote clear both sets**, through `sweep_board`, alongside the shapes and the
walls.

**A recalibration clears them too, and this is where fog differs from the walls it is swept beside.**
A wall is image pixels and still traces the same painted line after the grid moves; these are cells,
and the squares themselves have just moved. Redrawing the play area counts as well — what was
explored outside the new edge is not somewhere the party can be.

Asked of the board's *shape* alone, and that is the point: turning the vision radius up is not a
reason for the party to forget the dungeon, and neither is the grid's colour or turning fog off and
on again.

`sweep_board` emits no event of its own for this. `refresh_fog` runs afterwards and compares against
a reading taken before any of it, so the clear is already in the difference it reports.

## On disk

`revealed` is persisted; `visible` is not.

An evening of exploring belongs to the map it was done on, and this is the one thing on `Saved` that
would make the feature feel broken if it were left in memory. Sight is derived from where the tokens
are standing and what blocks the rays between them, both of which the same file already holds — and
deriving it is how a save written before a door was shut cannot describe sight straight through it.

The file reuses `FogView`, packed against an empty `visible`, so every explored cell records as `o`.
`unpack` reads both lit states as explored, so neither side has to know which it is looking at.

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

## The panel

A switch and a radius, and deliberately no third control. It arms nothing, which is why it is the one
tab on the rail with no `stop()`: the party's tokens are what move the fog, and the DM chooses how
far they see rather than where.

The radius is greyed rather than hidden while fog is off — it is still the map's number, and hiding
it would make turning fog on look like it had also invented one. `change` rather than `input`, so
typing `1` on the way to `100` does not send a radius nobody asked for and recompute the whole board
for it.

Inert over a preview, panel and tab together, for the reason the wall editor is: there is no fog on a
staged map, and a way in to a panel that can do nothing is the same lie as the panel looking armed.

## What this milestone did not do

- **Unanchored shapes are not filtered by fog.** A shape anchored to a token the recipient cannot see
  is withheld, and has been since milestone 14 — that is the arm that leaks a *monster's position*.
  Narrowing an unanchored shape to the cells it covers is 16b's, and until then a fireball marker the
  DM drops on ground the party cannot see draws over their fog.
- **Walls block sight and never movement.** Decided, not deferred — see `ROADMAP.md` for the four
  reasons, the first of which is that a refused move hands back a floor plan to anybody who drags a
  token around and watches which moves stick.
- No light sources, no per-token vision, no darkvision. One radius per map.

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

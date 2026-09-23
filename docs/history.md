# Build history

The record of each milestone from 8 on, as it was built: what the design didn't anticipate, what
cost more than expected, and what building it found. `ROADMAP.md` has the build order, the design
for what isn't built yet, and a summary of the lessons below that apply across subsystems.

This is a record, so parts of it describe code that has since changed. Where it disagrees with
`.claude/CLAUDE.md` or another file in `docs/`, those are current. Read the entries for a subsystem
before redesigning it, alongside its docs file.

The last section, *Designs written before building*, keeps five designs as they were written in
advance, with notes where the build went differently.

## 8. Map library

List `maps/`, pick one, remember its calibration. The smallest milestone on the list, and the only
one that touched nothing else.

## 9. Token lifecycle

The DM creates and deletes tokens, with a custom image, a size in grid units and a reassignable
`owner`. The reassignable owner is what covers wild shape: build a large token, hand it to the
player, and take it back or delete it when the spell ends. See *Tokens* in `docs/tokens.md` for
what the size rule turned out to be.

Deleting reached into initiative from the start, and the entry noted it would have to reach into
anchored drawings once they existed. (It does now.)

## 10. Staged map and preview

The staged map, and the DM preview mode that makes it possible to calibrate. See *Staged maps* in
`docs/maps.md`.

This is where `snapshot_for` started filtering for real rather than just having the shape for it,
and where `message_for` got its first arm that drops a message based on who the recipient is. On
the server that was three lines in each of those two functions. The rest of the milestone was the
client, which had to learn that "the map" and "the map on screen" are different questions.

## 11. Hidden tokens and hit points

`hidden` on tokens, then hit points, both visible only to the DM. See *Hidden tokens and hit
points* in `docs/tokens.md`.

**Per-field redaction turned out to be a type rather than a rule.** `TokenView`, built by
`Token::view_for`, is what the wire carries, so a secret added to `Token` and forgotten is missing
from the wire instead of sent to everyone. The entry recommended filtering milestone 12's
`staged_pos` and `staged_only` the same way: add them to `Token`, and they reach nobody until
`view_for` includes them.

Two things cost more than expected:

- Telling "it just vanished" apart from "you were never told" needs the token's *previous*
  `hidden`, which `message_for` can't read from `&self`. That's why the events carry `was_hidden`.
- A hidden creature's initiative row had to be filtered too, so a token edit can now force the
  panel to rebuild. A feature that hides something but leaves its name in a panel hasn't hidden it.

## 12. Preparing the next room

`staged_pos` and `staged_only` on tokens, and the reversal of milestone 10's rule that nothing in
preview is interactive. See *Preparing the next room* in `docs/tokens.md`.

Milestone 11's guess was right: the two fields reached nobody until `view_for` named them, and the
interesting work was elsewhere. Three things cost more than the state model did.

**`was_hidden` had to become `was_unseen`.** There are two independent reasons the table can't see
a token, they combine, and every filter has to ask about both. So the question moved onto
`Token::unseen()`, and nothing reads either field directly for it. A filter that checks one reason
and forgets the other leaks, and a rename was cheaper than relying on memory. (Milestone 16a later
moved the question again, to `RoomState::unseen_by_table`.)

Promote didn't fit the existing events. The DM needs the whole token, because their client holds
two fields that have just been emptied and no `TokenMoved` can say so. The table needs either a
creation or a move, depending on whether they've seen the token before. That's `Event::Promoted`,
with three arms. Discarding a plan needed `Event::TokenPlanChanged`, which reaches only the DM.
Reusing `TokenChanged` would have sent players a frame identical to what they already had: no new
data, but it would still reveal the moment the DM changed their mind.

The client repeated milestone 10's pattern. `shownPos` is the counterpart of `shownBoard`: one
function answering "where is this token on the board that's on screen", and everything that draws
or hit-tests goes through it. Ghosting was deleted rather than adjusted, as predicted.

## 13. Movement ruler

See *Distance* in `docs/drawings.md`. That section was reworded to match the code rather than the
code changed to fit it: counting a diagonal step as one cell makes every reading a multiple of
five, which is what the table counts in, and "straight-line" no longer described what shipped.

Drawing the ruler was easy. Two things weren't.

Every client draws a ruler for any token it sees moving, not just the dragger's, and that needed
nothing new on the wire. `TokenMoved` already carries `dragging`, and a watcher's copy of a token
stays at its settled position until the first drag frame arrives, which is exactly the origin. Read
the origin a frame later and the ruler measures from itself.

**It does need a timeout**, for a client that disconnects mid-drag and never sends its drop, and
the first guess at its length was wrong by an order of magnitude. Drag frames come from
`pointermove`, so a drag that pauses sends nothing. A ruler that expired after a second of silence
disappeared from the table's screens while the DM was still holding the token. This was caught by
driving two clients at once, which is the only way that case shows up.

## 14. Drawing layer

See *Drawings* in `docs/drawings.md`. Two decisions made this bigger than the state model, and both
took the more expensive option.

A shape being drawn is shared, so everyone watches the sweep. That puts it on the wire rather than
keeping it local, so it needed the `dragging` protocol a second time, for shapes. It didn't need the
ruler's timeout: the room is told when a socket closes, so a stranded sketch is removed on
`Disconnected`. Nothing announces that a *drag* stopped, which is why milestone 13 had to guess and
this one didn't.

A circle also tints the cells it covers as well as drawing an outline, which needed a
point-in-shape test. That paid for itself twice, because the same test makes click-to-erase free.
The tint is where drawings openly disagree with *Distance* in the same doc: a diagonal step costs
one cell there, so "within 20 ft" is a square, while a circle here is a circle. They answer
different questions and were left different on purpose.

**Anchor visibility couldn't wait for fog.** The pre-build design had filed "an aura on a monster in
the dark advertises where it's standing" under fog of war, but `hidden` had existed since milestone
11, so the rule shipped here, through `Token::unseen` so both reasons combine. Adding shapes without
it would have leaked on the day it landed.

`Event::ShapesChanged` also had to be gated. Emitting it on every token hide would tell the table
*something happened* even when nothing was drawn on that token. It uses the same gate the initiative
panel already used; this was the second time that trap came up.

## 15. Wall and door editor

See `docs/walls.md`.

The state model was easy again. Its shape came from two questions that look like one: what the DM
*draws* is a run of connected segments, and what the room *stores* is a segment. Storing the run
would have given the list two shapes and made every consumer flatten it, including the shadowcast
that hadn't been written yet.

Three things cost more than expected.

**Walls needed their own point type.** `Pos` is grid units and a wall is image pixels, and two
structs each holding two floats can be swapped without complaint. `Px` is what separates "a wall a
hundred cells long" from "a wall a hundred pixels long". Both serialise fine, and one of them is a
line across the middle of the dungeon.

A click was already taken. The draw tool erases on click because a sweep is a drag, which leaves the
click free. In the wall tool a click places a corner, so erase had to become a third mode. The
exception is a door, which swings on a click with no tool armed. Opening one is a play-time action
rather than an edit, and a feature that needs a tool armed first tends to go unused. It's the one
place in the project where what a click means depends on what's under it, and it coexists with
panning by reading the pan drag's own `moved` flag.

The rail ran out of room. A fourth DM panel squeezed the token panel down to a scrollbar and a
heading, which nothing in the state model or the protocol would have caught. Layout limits what this
UI can grow, and the entry concluded that the next panel would have to displace something rather
than sit beside it.

That was resolved before milestone 16 (see `rail.ts`). The DM's editing panels went behind a tab
strip with one open at a time, so fog's panel cost a tab rather than a share of the rail's height.
Two rules came with it and apply to anything added to the strip:

- Closing a tab must put down whatever that panel armed. A tool holding the left mouse button under
  a hidden panel is a click with nothing on screen to explain it.
- A panel that's inert in some state must make its tab inert too.

The draw tool isn't on the strip: everyone has it and it's used mid-fight, which is the same reason
a door swings with no tool armed.

Worth knowing before adding to `RoomView`: growing it by one field pushed `ServerMsg::Welcome` past
clippy's large-variant threshold, because every message in every client's mailbox is sized to the
largest variant. `state` is boxed now. Serde serialises through the box, so the frame on the wire is
unchanged.

## 16. Fog of war

Built in two halves. See `docs/fog.md`, and *Fog of war* in the last section for the design as it
was written in advance.

### 16a: automatic line of sight

This is what finally reads the walls. The state model was three lines again. Four things cost more.

**Symmetric shadowcasting had to go**, and this is the part to read before building on it.
Shadowcasting needs opacity to be a property of a cell, and a wall here is an arbitrary segment in
image pixels that the DM may have traced diagonally. Rasterising a segment into blocking cells
doesn't approximate the dungeon, it changes it: a wall traced along a cell boundary, which is where
`snapToCorner` puts most of them, would block the cells on both sides and shrink every room it
encloses. What shipped is a ray from the viewer's centre to each cell centre, culled to the walls
within reach. It's one sentence, a page of code, and easy to explain to a player who asks why they
can't see something.

`Token::unseen` stopped being the only question filters ask. Two of the three reasons a token is
unseen are facts about the token. The third, line of sight, is a fact about the room, so it can't be
answered from `&Token`, and the check moved up to `RoomState::unseen_by_table`. That was the third
time a filtering question had to grow, and the first time it changed type.

`was_unseen` had to change meaning at four sites, as milestone 11's note warned. Missing one is a
live leak, not a cosmetic bug: renaming a monster standing in the dark would send the table a
`TokenRemoved` for an id they've never held, which reveals that the id exists. `Event::Promoted`
grew a third outcome for the same reason.

Fog needed an off switch, which the design hadn't planned. Without one, every map is fogged
including outdoor ones, and every existing save goes dark the day it ships. `fog: bool` beside the
radius on `MapInfo` also handles the design's warning about a radius defaulting to zero, so the
radius can default to a playable number instead of a defensive one.

### 16b: the DM's manual override

The manual override, the flood-fill reveal tool, and the filter for unanchored shapes that milestone
14 left for whenever fog existed.

The two questions the design left open were answered by building it:

- `ForceRevealed` became two brushes. `Explored` gives the table the ground and `Lit` gives them
  what's standing on it, because the conservative answer alone made the DM use two controls to say
  one thing.
- `ForceHidden` does hide a creature the party otherwise has line of sight on. Anything else is the
  failure `hidden` was built to prevent.

The design's guess about how to land it was right: it's a different answer from `in_sight`, not a
fourth question. `Dark` subtracts from `visible` before anything reads it, so `unseen_by_table` is
still one line and nothing downstream knows the word "override".

Four things cost more than the state model, which was three lines again.

**The override had to be a mask and never a write.** The design said so, but it couldn't have
predicted the ordering inside the mask. `Dark` has to leave `visible` *before* the union into
`revealed`, or a blacked-out cell enters the party's memory anyway, and it has to leave `revealed`
last or it doesn't remove the memory. Treating `Lit` and `Explored` as floors and `Dark` as the one
ceiling is what makes the rest order-independent.

The fill runs on the client, and the command carries cells rather than a seed. That looks like the
server giving up authority, but the DM may reveal whatever they like, so there's no answer for the
server to defend: only a size to bound and a board to clip against. In return, the preview and the
result are the same array, rather than two runs of two implementations that would have to agree. It
also isn't the raycast written twice. Connectivity and line of sight are different questions that
happen to read the same walls.

The override travels like the walls, not like the fog, and that pairing is the thing to keep. The
walls and the override are what the DM authored; the fog is the result of both. The override
reaches the DM or nobody, and the table is sent only the `FogChanged` that goes with it. On the DM's
own board it needs its own tint. With no undo (at the time), telling a blacked-out room from a
wall's shadow is most of what makes the tool usable, and both are simply dark otherwise.

The shape filter needed geometry the server didn't have. `coveredCells` and `containsPoint` are
client-only TypeScript, so `shape_covers` is a second copy in a second language. That's affordable
because the two only have to agree loosely: a disagreement changes whether a frame is sent, never
how it's drawn. A `Line` needed its own rule, since `contains_point` is false everywhere on one and
every measuring line would otherwise have been withheld. `Sight` also gained a second reading: an
unanchored shape's visibility can change with no token involved, which the token loop gating
`ShapesChanged` couldn't see.

Not foreseen at all: the fog panel got its first `stop()`. 16a's note that it was the one tab arming
nothing was true because the party's tokens are what move the fog, and the override is the one part
the DM places by hand.

### After both: one cell of fringe

Something the design never considered: **`known` is `revealed` widened by one cell.** A traced wall
runs between cell centres, so the rays stop at the floor inside the room and the drawn masonry is
beyond it. Fog that stopped at the rays showed the table the floor and then nothing, and rooms
looked like holes. `with_fringe` takes the eight neighbours, clipped to the board, and is applied
only on the way into `known`. Not into `visible`, which would show the creature behind the wall, and
not into `revealed`, which is rays only. See *One cell of fringe* in `docs/fog.md`.

## 17. The movement pass

The trail, the diagonal switch, and the wall hint the design asked for under *Fog of war* but never
scheduled. See *Distance* in `docs/drawings.md`.

**The trail is the ruler's straight line, not the path the mouse took**, and that decision paid off
twice. It's derived from `ruler.from` and the token's position, which every watching client already
has, so it cost nothing on the wire or in the room. And under the existing convention a rasterised
line is exactly `max + 1` cells against a reading of `max × 5`, so the trail is a picture of the
number rather than a second thing that has to be kept in step with it. The recorded-path version
would have been worse at the job: drag frames are throttled, so a watcher's recording is coarser
than the dragger's and the same move draws differently on six screens.

Three things cost more than the state model, which was one function and one field.

The diagonal switch follows `show_names`' pattern, the third instance of it: DM-only to set,
identical for every recipient, with `DiagonalsChanged` beside `FogChanged` rather than
`WallsChanged`. It's the clearest case of that pattern because the server never computes with it
(there's no movement distance in the crate), so all the room guarantees is that six clients agree.
That's also the argument against `localStorage`, which is where a client-only setting would
otherwise go.

The rule had to be per measurement, not per turn. `5 × (max + ⌊min/2⌋)` counts diagonals from the
start of each reading, so the first diagonal anybody measures costs five. The alternative needs a
movement budget to carry a remainder in, which is a character sheet, and gives a number that can't
be checked by looking at it.

Two clocks, not one. `end` had to stop deleting a ruler and start fading it, which needed `forget`
for the case where the token itself goes away: a trail left behind by a token that just vanished
points at where it went. And `active` had to stop applying `STALE_MS` to a ruler that has landed,
since a landed ruler has stopped receiving frames by definition.

The wall hint was the cheapest part and the best test. `crossesWall` is four signed areas, and the
assertion that it can't leak needs no mock and no identity check: one drag, one set of frames, amber
on the DM's screen and blue on the player's, because the player's client has no walls to test
against. `tools/drive-ruler.mjs` checks exactly that.

## 18. The initiative panel

Portraits on the rows, hit points on the DM's, and clicking a row to look at that creature. See
*Initiative* in `docs/tokens.md`.

The milestone touched no Rust at all, which is worth recording as a type of feature: `panel.update`
was already given the whole `Scene`, so every row could resolve its id to the token and read `img`
and `hp`. Nothing was missing from the wire; something was missing from the panel.

**The hit point bar has no check for who is reading it**, because `hp` is redacted in `TokenView`
and a player's copy carries null. That's invariant 4 failing safe, the same argument `drawHitPoints`
already made on the canvas: a secret added to `Token` and forgotten in `view_for` goes missing from
the DM's own panel rather than appearing in everyone's. The driver asserts the negative directly.

The only real cost was layout. The portrait and the bar both take space from the column the name had
to itself, so the panel went from 208px to 248px and the name now truncates with an ellipsis. Layout
limits what this UI can grow, as milestone 15 already said about the rail.

## 19. Ping

Hold the left mouse button and a ring appears where everyone can see it. See *Ping* in
`docs/drawings.md`.

Everything the design specified held, including the parts that read like guesses: the ~400ms timer,
the 150ms growth, the arrow instead of a pan, and the decision not to gate on fog. That last one is
the thing to read before adding anything else the table can see.

Two questions the design left open were answered by building it, and both went the way it thought
less likely.

**Ping ignores the draw tool**, rather than the draw tool disarming. Disarming is the tidier rule,
but it costs the wrong tool: the measure line is the one used repeatedly in a fight, and re-arming
it after every measurement costs more than the one thing ignoring it breaks, which is that a *slow*
click on a shape pings instead of erasing. That trade is only visible once you notice which of the
four tools gets used most.

The owner's colour had to be invented, and it's derived rather than chosen. The design said "the
owner's colour" as though one existed, but nothing in the project had needed one. `colourOf` indexes
a fixed palette by roster position, which every client resolves identically from the `Welcome` it
already holds: nothing on the wire, nothing persisted, nothing to set at the start of a session.
Players picking their own colour was split out as a separate feature, since it needs a command a
*player* may send, persisted state keyed to them, and an answer to how a personal colour relates to
the draw palette. The entry predicted it would replace the body of one function. (It became
milestone 27d. The roster-position palette is still the default for anyone who hasn't picked.)

Three things cost more than the state model, which was nothing at all.

- **`HOLD_SLOP_PX` has to equal `DRAW_CLICK_SLOP_PX` and be checked first.** If it's larger, a press
  can cross into sweeping and *then* fire, killing a sketch that five other screens have already been
  shown, with no release frame left to remove it from them. The two constants look independent and
  aren't, which is the kind of coupling that gets noticed once and then tuned apart later.
- Firing has to undo what the press started. The gesture runs alongside whatever the button press
  also began, which is how it works at all, and it means a hold on a token has already told the
  ruler where a drag began. Left alone, that's a zero-length ruler measuring a move nobody made. The
  selection isn't undone: un-selecting a creature somebody just pointed at is the opposite of what
  they meant.
- `startedAt` is when the button went down, not when the ping fires. That one line makes the growing
  preview and the landed ring one drawing rather than two with a handoff: committing moves the same
  object between two lists, and nothing on screen restarts. The obvious alternative flickers for
  150ms at the moment everyone is looking at it.

The negative assertion landed in the opposite shape from every earlier one: `drive-ping.mjs` asserts
that a second connection *was* sent something over ground it can't see, and that the ground under it
is exactly as dark afterwards. One gesture checks both halves.

## 20. Walls and fog overrides on the staged map

The next dungeon traced before the table is shown it, rather than in front of them after the
promote. See *The staged map has walls of its own* in `docs/walls.md` and *The staged board has a
mask of its own* in `docs/fog.md`.

The prediction held almost exactly, the first time that happened at this scale. The argument for why
it would be cheap generalises: **a subsystem that already reaches the DM or nobody is nearly free to
stage**, because there's no filter to widen. `snapshot_for` grew no arm, `message_for` grew no arm,
`unseen_by_table` wasn't touched, and no `was_unseen` changed meaning. Compare milestone 12, where
staging two token fields cost all four.

Three things cost more than the state model, which was one struct.

**The bundle had to flatten its map, because of the save file.** `staged` was an `Option<MapInfo>`
on disk, so an existing save holds the map's fields directly under that key. Nesting them under
`map` inside a new struct reads every one of them as missing, and because invariant 2 puts
`#[serde(default)]` on the container, that isn't an error. It's a staged slot holding a blank image
with an empty URL, silently, and the DM's next-map tab opens onto nothing. `#[serde(flatten)]` reads
the fields where they already are. The general trap: invariant 2 protects a field being added, and
does nothing for a field changing shape. The default that makes an old file load is the same
default that discards what it held. A test asserting the old JSON by hand is the only thing that
catches it.

`StagedChanged` carrying the whole board is what kept the event count flat. The obvious design is a
`WallsChanged { staged: true }` beside every staged sweep, and then a staged load, a staged
recalibration, a promote and a discard each have to remember to emit one: four places to forget.
Carrying the bundle means the frame the DM was already being sent describes all of it, and the two
staged-slot events that do exist are only for editing.

The negative assertion landed in two places, and the browser half needed a network check. The
server suite says a player is sent no staged wall and no staged paint. The driver had to say the
same about a real second browser, and the pixel reading couldn't: the board they were on was fully
fogged and so was the one arriving, so black replacing black looks like nothing happened.
`drive-staged.mjs` asks the browser's resource timeline whether it ever fetched the next dungeon's
image, which is `drive-fog.mjs`'s check on token art applied to a map. It also has to clear the
timings first. The room stays in memory across runs, so a map staged this run was very likely the
live board last run, and reading the whole history reports a legitimate old fetch as a leak.

Two smaller things, both predicted and both true. `rulerBlocked`'s early return was exactly the
marker the design said it was: deleting it was the whole change, and a plan is now measured against
the dungeon it's a plan for. And the client repeated milestone 10's pattern a third time, with
`shownWalls` and `shownOverrides` beside `shownBoard`.

Not considered by the design: the rail's inertness rule ran backwards. Milestone 15 established that
a panel which can do nothing must grey out its tab. Here the staged board gave both panels something
to do, so the work was deleting two CSS rules. The fog switch and radius came with them: they'd been
on `MapInfo` since 16a and only the client was refusing them, so the next dungeon's lights are now
set before the promote. `ResetFog` is the one control that's still live-only, because half of it
forgets where the *party* explored, and they haven't explored a map they haven't been shown.

Left out, as planned: previewing the staged map's fog. Nothing raycasts a board nobody has been
shown. The visible cost is that the DM paints a staged map with no fog wash under the tint to react
against, and the panel's hint says so in words because the board can't. If it's ever wanted, it's
client-only and costs the room nothing (`shape_covers` is the precedent for a geometry rule in two
languages). Don't put it in the room.

## 21. Room lighting

See *Two lighting modes, and one question underneath* in `docs/fog.md`.

The design held in full, including the parts written as warnings: the door rule, the radius bound
and the four-neighbour stepping all shipped as specified. The paragraph about `fillFrom` saved the
most time. The temptation to reuse it is real, and it would have been wrong in exactly the way the
design predicted. (The door rule was then revised the same day; see below.)

The state model was one enum and one field, and **the mode cost no arm anywhere**. `sight_cells`
picks between the two implementations and nothing downstream reads `lighting`: `recompute_sight` is
unchanged past that one call, `message_for` grew nothing, `unseen_by_table` wasn't touched, no
`was_unseen` changed meaning, and the wire carries one more `MapInfo` field and no new message. This
is the counterpart of milestone 20's lesson: a feature that changes what a filter is given, rather
than what it decides, is nearly free.

Three things cost more than the state model.

`fillFrom`'s dead-end rule had to come across, and only that rule. The two fills disagree about
doors and agree about a cell a wall runs *through*: a chamfered corner is a hole in any fill, and
here a hole gives the table a room they haven't reached. So `cut_by_wall` in `fog.rs` is a second
copy of the client's, asked only about the walls that block, while `crosses` beside it stays
permissive for the raycast, which has tests named after its ties. Two files, one fact about the
lattice, and three different right answers to it.

The union had to be per source. The raycast skips a cell another torch already lit, and copying that
here is a real bug, not a slow path: skipping such a cell stops *this* source expanding through it,
so a party member standing one square behind another lights nothing beyond them. Six fills over a
radius each is nothing at this scale, and the sharing that looks like an optimisation is what breaks
it.

The driver had to build its own dungeon and its own torch, which is the part to read before writing
another driver. Room lighting has no shape without a wall, so `drive-fog.mjs` traces one. A driver
may neither assume the board it was written against nor erase the DM's work to make room for its
own, so it runs only on an untraced board, erases what it traced, and otherwise skips with a note.
Finding a party token to stand beside was the harder half: where six of them are standing depends on
the room, a ring search wide enough to find one costs a click per square, and both clients frame the
board for themselves. Building a token and handing it to a player puts a vision source in the first
free cell out from the middle of the view, which is the one place both browsers are certainly
looking.

### Revised the same day, after playing on it

The design said an open door is how light reaches the next room, and the flood read `blocks()` to
make that true. On a real dungeon that makes an open door a hole in the room's boundary: a one-cell
hallway shows the table the whole chamber beyond it, and the only thing that bounds a room is a shut
door the DM has to swing by hand as the party moves. The obvious fix was the `WallKind::Archway` the
design had wondered about, and it wasn't needed:

- The flood now stops at every traced segment, open or shut. That's `fillFrom`'s rule, which
  `docs/fog.md` has described since 16b as *an archway is a door left open*. Room lighting was the
  one place in the project that disagreed with it, and the disagreement is what leaked. The change
  was deleting one `.filter(|w| w.blocks())`.
- `Room` became a union with the raycast, which is what lets the flood give up the doorway: *you see
  the whole room you're standing in, plus whatever you have a straight line to.* An open door shows
  the wedge visible through it rather than the room behind it, which is what opening a door does at
  a real table, and the mode can never show less than `Dynamic` would. Three lines, since both
  algorithms already existed and were already bounded by the radius.

So only sight reads a door's state, one rule fewer than the two the entry had counted. And an
archway doesn't need a `WallKind` of its own. A third variant in a closed set costs the editor's mode
strip, the renderer, `AddWalls` and the client's two-state `Wall.door`, and an open door already is
one.

**The general lesson is about where a rule is allowed to be new.** Milestone 21 invented a door rule
rather than adopting the one the project already had, and it read as a decision in the roadmap and
the docs until a dungeon was traced against it. When a neighbouring subsystem already answers the
question, the burden is on diverging, not on matching. The warning sign was in writing:
`docs/fog.md` described a fill bounded by everything traced, one section away from a fill that
wasn't.

Also not considered by the design, and it's about the memory rather than the mode: switching back
to `Dynamic` doesn't take the room away. `revealed` is rays only and cumulative, so ground the flood
revealed stays on the table's board as explored terrain. That's correct (it's the same rule that
keeps the corridor behind them), but it means the driver's reading has to be taken after a reset,
and the DM's way to un-light a room they lit by accident is `reset all`, not the mode button.

### The design as written

Kept as written. The door rule in it was revised the same day (above); the rest didn't have to
change.

`lighting: Dynamic | Room` on `MapInfo`, beside `fog` and `vision_ft` and remembered per URL with
them, so the outdoor map keeps line of sight and the dungeon reveals a room at a time.

Under `Room`, `recompute_sight` stops raycasting and becomes a flood fill from each party token's
cell, bounded by traced segments and shut doors, unioned over the party. It's connectivity rather
than the raycast written twice: the same walls read a different way.

It isn't `fillFrom` ported to Rust, and the difference is doors. 16b's reveal tool bounds on every
traced segment whatever state it's in, on purpose: which cells make up a room must not change when
somebody opens its door, or the region a click selects depends on play-time state. The argument is
written out above `fillFrom` in `client/src/overrides.ts` and is worth reading before starting,
because room lighting asks the opposite question: an open door is how light reaches the next room,
and a shut one sealing a room is what the mode is for. So this fill reads `Wall::blocks()`, as
`visible_cells` beside it already does. Two fills, two door rules, and neither is a copy of the
other. *(Revised the same day: the flood now stops at every segment, like `fillFrom`.)*

What they do share is four-neighbour stepping and the reasoning behind it: a fill that stops short
is a smaller failure than one that escapes. That matters more here than for the DM's paint, because
an escaped fill shows the table a room they haven't reached.

Unlike `shape_covers`, this one has no client counterpart: the table is sent a `FogView` and computes
nothing. There's no second copy to keep loosely in step.

**The fill is bounded by the radius as well as by the walls.** A pure fill doesn't respect corners:
walk into a winding corridor and the whole of it lights to its far end, around every bend. Bounding
by `vision_ft` stops it at the radius, keeps that number meaningful in both modes, and still reads
as a whole-room reveal in any room the radius covers. A hall bigger than the radius is a map whose
radius should be raised; don't add a second number.

Leaving a room un-lights it. Terrain gates on `revealed` and creatures on `visible`, so the room
stays dimmed and whatever wandered into it while the party was away doesn't show. That's the existing
rule working, not a new one. *(Terrain now gates on `known`, which is `revealed` widened by one cell;
see milestone 16. The conclusion is unchanged.)*

This mode gives two things beyond the reveal. A shut door really seals a room, so doors matter to
play rather than being decoration. And a bad trace fails visibly: one gap merges two rooms in front
of everybody, instead of leaking a sliver of sight nobody notices. That second point is why
milestone 20 came first. It's an argument for tracing carefully out of sight, a dependency of
quality rather than of code, and it's now satisfied: the DM can trace and check a whole dungeon
before anybody is looking at it.

It also reopens a question: the wall hint on the player's screen, now under *Unscheduled* in
`ROADMAP.md`. Its cheap version shows amber when a move crosses the boundary of `known`, which meant
nothing under `Dynamic` because a fog edge there is usually just the vision radius. Under `Room` a
fog edge is almost always a wall, more so now that the flood stops at every traced segment. Play on
it first. (The other half of that sentence, whether an archway needs its own `WallKind`, was
answered by the revision above: it doesn't.)

## 22. Undo

See `docs/undo.md`.

Every claim the design made about the server held, and the server work was small for exactly the
reasons given: `persists` was already the trigger list, a snapshot really is the persisted subset,
and defining it that way does keep `clients` and `pending` out without a separate rule. Two small
additions the design didn't have, both necessary.

**`undid` had to exist beside `persists`.** The button needs a label (it names what it would undo,
because with no redo an unexpected press can't be recovered), and the same list turned out to be
where `Undo` excludes *itself*. Without that, the ring gains a new entry every time the DM steps back
through it, and the second press returns to where the first started. So `undid` is the third sibling
of `persists` and `moves_sight`, enumerated the same way, and a step is a command that both `undid`
and `persists` agree about.

The ring stores the state after each change, and the constructors seed a starting entry.
Snapshotting *before* each command is the obvious design and can't consult `persists`, which answers
about the events a command produced. It would clone the whole room thirty times a second during a
drag and discard all but one. Pushing afterwards costs one clone per step. The starting entry goes
in `hardcoded` and `restored` rather than in `spawn`, which is where `recompute_sight` lives: sight
is derived from state, but the starting entry is part of being a room, and every test in the crate
builds one by hand.

**The one thing the design got wrong was on the client.** "Restoring re-sends `Welcome` to everyone"
is true of the server and false of the client. `onWelcome` *builds* the pings, the panels, the four
tools, the rail and the board once, on the stated assumption of one Welcome per socket, and `start()`
captures `room.scene` by reference. A second Welcome would construct a second copy of everything,
register another `window` keydown listener per tool, and give the DM a fresh camera at the moment
they're looking at what they just undid. So `Restored` is its own message carrying only state, and
`adoptView` mutates the scene in place. It shares its field list with `sceneFromView` through a
`fromView` typed `Omit<Scene, 'previewing'>`. `previewing` is the one field a restore must not touch,
and the type excludes it rather than relying on memory.

That was the main cost of the milestone, and the general form is worth stating: "reconnection is
already a full resync" was a claim about the protocol, and the protocol wasn't the part that had to
be true. The client had never actually been asked to resync.

Two smaller things. `rulers.forgetExcept` is the one thing a restore needed that no other frame did:
a restore removes several tokens at once and there's no per-token frame to attach a `forget` to. And
`UndoChanged` is sent with every persisting command, which added a trailing frame to every DM-side
assertion in the server suite. `drain` filters it and `drain_all` doesn't, so those tests stay about
what they test, and `undo.rs` asserts the pairing directly.

One step per command, as chosen. A long wall trace fills the ring and can't be undone as a unit.
`ClearWalls` is the way out of a bad one, and is itself one step. Coalescing a run was the
alternative, and was declined because it's a rule `persists` doesn't already contain: depth is cheap
to tune after a session, and the trigger isn't.

### The design as written

Kept because the server half needed no changes.

One stack, roughly ten deep, no redo. Nearly all of it falls out of things that already exist.

`persists` is already the trigger list. It's enumerated, it's already exactly "commands that changed
something worth keeping", and it already excludes drag frames. A stack growing thirty times a second
while a token is dragged is the obvious failure, and this avoids it without a rule of its own.

A snapshot is the persisted subset: the save file kept in memory instead of written to disk.
Defining it that way keeps `clients` and `pending` out of it. Restoring a live socket table from ten
commands ago is the one way this feature fails outright, and reusing the disk serializer's definition
of state means never deciding it a second time.

Minus anything persisted that the DM didn't author, which meant milestone 24's scratchpads. Otherwise
the rule above silently loses a player's paragraph: undoing a wall erase would restore every note in
the room to what it said ten commands ago, with nothing on screen to say so and no way for its author
to get it back. The ring holds the persisted subset minus the notes, and the general form is the part
to keep: **the undo ring may only contain state the person undoing wrote.** Anything persisted and
owned by somebody else has to be excluded when it's added, or it inherits this bug silently.
Milestone 23's log avoids it by never being persisted.

Restoring re-sends `Welcome` to everyone. Reconnection is already a full resync, so undo needs no new
event type and no diffing. "There is no diffing or resync protocol" is the rule that makes this
affordable. *(Wrong on the client; see above. `Restored` is its own message.)*

The alternative, an inverse per command, fails on `sweep_board`: a map load destroys walls, shapes
and fog together, and writing an inverse for that is most of a second state model. A snapshot
restores it for free, and that case is also what makes undo worth having. *(Milestone 31 weakened
this: a load now puts the walls back on the way in.)*

## 23. Whisper and shout

Two destinations and no third: a player whispers the DM or shouts to the table. It isn't called
chat, because the narrower name is the design. See `docs/chat.md`.

Every design decision shipped as written, including the ones the design called essential: the two
destinations, the session-memory log, the per-recipient snapshot, the dock rather than a floating
window, and the badge that doesn't auto-open anything. Worth recording: one prediction that was half
wrong, and three things the design didn't have.

**"The first message whose *content* is per-recipient" was true of the snapshot and false of the
delta.** `RoomView::chat` really is different text per client, and it's what refusing
`tokio::sync::broadcast` finally paid for. But `ServerMsg::Said` is either withheld or sent whole,
the same as `WallsChanged`. What's actually new is smaller: it's the first filter in the project
that draws a line between two players. Every other filter separates the DM from the table and asks
`is_dm`. `party_to` never asks it, and the DM receives every whisper because they're one end of all
of them, not because they're the DM. The general form: a filter that stops asking about a role has
to start asking about a pair, and the pair includes the sender. Leave that half out and the person
who said something is the only one who can't see it.

The sender is echoed their own line, which nothing else in the project does. `Sketch`, `Pinged` and
mid-drag `TokenMoved` all skip the sender, each on the same argument: the sender is already drawing
it, so an echo restarts an animation. That doesn't apply here, because a log is a sequence. Where a
line goes in it is the room's decision, and a client appending its own line would have two orderings
to reconcile the first time two people typed at once. The sign that this was different is that
nothing here is predicted locally.

Not persisting the log was one decision that paid off three ways, and only one was planned. Old
whispers stay off a disk in somebody's front room; a refresh mid-combat keeps the initiative rolls;
and an undo can't remove what the table said. Milestone 22 wrote that the ring may only hold state
the person undoing wrote, and this was the first thing to test the rule. It passes without being
named anywhere: a snapshot is a `Saved`, and the log isn't on one. Milestone 24's scratchpads *are*
persisted and wouldn't get this for free, which the entry noted for when they landed.

The sticky destination was chosen over two send-once buttons, and it needed a second indicator.
Enter sends where the box is pointed, which is one keystroke each way in a back-and-forth and has one
failure: forgetting which way it points and shouting something private. So the armed chip isn't the
only sign. The input itself gets the amber border and says `whisper Torrin…` in its placeholder,
because the thing somebody looks at while typing is the thing they're typing into. A control with
state needs that state shown where the user is looking, not only where the choice was made.

Two smaller things. The input's keydown calls `stopPropagation`: every tool in the project listens
on `window`, four disarm on Escape and the calibration box applies on Enter, and none of them should
be reachable from a sentence somebody is typing. `undo.ts`'s `typingIn` is the same argument from the
other side and was the precedent. And the driver needed three browsers, a first: the assertion is
that a whisper is absent from *another player's* page, and two connections can't show that.
`drive-chat.mjs` also has to tag its lines per run. The log being session memory sounds like it makes
the driver idempotent, but it doesn't, because the room stays in memory across runs and no command
clears a log.

### The design as written

Kept because all of it held.

The non-goal in CLAUDE.md was written on the premise that the group uses Discord. Half the table has
a Discord account only because the DM made them one, and tabbing out of the browser to send one
sentence is friction the VTT itself created. That premise is what changed, and the non-goal was
amended in place rather than left to contradict this design. Read it, because the bounded version is
the specification and the boundary is most of it.

The motivating case is six people posting initiative rolls without cluttering voice, which is why
the general channel that "six people already talking get nothing from" turned out to be worth having.
What stays out is player-to-player: no private messages between players. At a voice table that
splits the table, and it's also why a player's box needs no recipient picker. Two buttons. The DM
picks a player to whisper; a player never picks anything.

- Kept in session memory, never written to disk. The last ~200 messages live on `RoomState` and go
  out in `Welcome`, so a browser hiccup mid-combat doesn't lose the initiative rolls. They're gone
  next game night, and old whispers never persist on a disk. The cap is a cap, not a policy: trim
  from the front.
- The log is per-recipient in `snapshot_for`, because a whisper can't go to everyone. That's
  invariant 3 doing its job, on the first piece of state where getting it wrong reveals words rather
  than positions.
- No history between sessions, no formatting, no emotes, no commands, no dice. A shout is text and
  is filtered by nothing; the fog doesn't apply to words. *(Milestone 40 later added the loaner die,
  as a chat line.)*
- **No coupling to the initiative panel.** A shouted number is text and a panel row is state, and
  they stay separate. Parsing chat to fill a row would make this milestone reach into a subsystem it
  otherwise doesn't touch. The DM reads the number and types it.

Architecturally it's the cleanest thing this project could be asked for: `Whispered` is the first
message whose content is per-recipient rather than filtered per recipient. That's exactly what
refusing `tokio::sync::broadcast` paid for, and it had never been used. *(Half wrong; see the first
note above. The message shipped as `Said`.)*

A whisper and a shout share one log, styled differently, rather than two panes. Attribution is the
roster name in the owner's colour, the same pair milestone 19's ring uses.

## 24. The scratchpad

One box of text per person, private to whoever wrote it. See `docs/notes.md`.

What it cost: a `HashMap<Owner, String>`, one command, one event, a 100-line `notes.ts` and a dock
tab. The design was right about all of it except one line, covered under *The dock stacks now*
below.

A `HashMap<Owner, String>` on `RoomState`, and one `SetNotes` carrying only the text. The sender's
own key is never on the wire, because a key a client could name is a key it could use to name
someone else's. An `Event::NotesChanged` reaches its author and nobody else.

**It's the first state in the project that Slate doesn't send the DM.** Every earlier asymmetry runs
the other way, so `snapshot_for` and `message_for` had only ever been asked to withhold from players.
Neither arm here checks `is_dm`. A scratchpad the DM's client can open isn't a scratchpad, it's
surveillance, and the reason it stays private is also why it's worth having: nobody writes candidly
in a box somebody else can read.

Be accurate about how far that goes, and don't describe it to the table as privacy. The notes are in
the save file and the DM hosts the server, so anyone holding the JSON can read all of them. What the
milestone guarantees is that no client is ever sent someone else's notes. That's the only guarantee
this architecture can make about anything, and it's the same one the walls and the hit points get.

What it offers over the Notepad window everyone already switches to is one thing: it's in the
window, and it persists with the room. That's enough, and it's also the whole scope.

It can't be a rail tab. Only one rail panel is open at a time, notes have to stay readable while a
tool is armed, and the rail is the DM's while this belongs to everybody. Milestone 26's dock answered
all three.

The line to hold: **a second document makes it a journal.** No titles, no pages, no sharing, no
handout button.

### The dock stacks now

This is the one line of the design that changed. The dock's panels were one at a time because that's
what the rail does. But the rail is one at a time because its panels are editing modes, and two armed
tools would give one mouse button two meanings. Nothing in the dock is a mode, so making notes close
the chat would have recreated on that edge the problem that kept the scratchpad off the rail. The fix
was a `Set<DockTab>` and a `toggle`, and two flex items instead of a fixed height.

### What the design didn't say

The undo exemption needs two parts, not one. Keeping `SetNotes` off the ring still leaves a
paragraph typed *between* two other commands on the snapshot the later one pushed, so the `Undo` arm
takes the notes out and puts them back around `adopt`. That was the only exception `adopt` had
needed, and it's the case `docs/undo.md` predicted.

And the one frame this feature sends is for your other tab. The author's socket is excluded, which
is `Pinged`'s rule rather than `Said`'s, because writing the text back a round trip later moves the
caret.

## 25. Shift-click selection and the group drag

Built out of order. Six goblins cross a corridor in one drag rather than six. See *Moving several at
once* in `docs/tokens.md`.

It was numbered last at the time and built first, because it depends on nothing and nothing depends
on it. The rule about not working ahead exists to stop a later milestone's design being guessed at
early. This one touches no other milestone, so following the letter of that rule would have gained
nothing.

The notable thing is how little there was. **The server wasn't touched at all**, which wasn't the
plan: it followed from a group move being N ordinary `MoveToken`s. Permission, snapping and
`moves_sight` are each per-command and each already correct. A batched command would have had to
answer all three again for a collection and would have got the same answers. The client change is
one widening (the `token` arm of `Drag` holds a list instead of a token) and four call sites that
loop.

The permission question answered itself. The intention was DM-only, on the assumption that a player
selecting a mixed group would need filtering. It doesn't: membership comes from `tokenAt`, which has
always ignored tokens you can't move, so a group can only hold what `can_move` would allow anyway.
The feature that seemed to need a new rule needed none. Check the instinct to gate a new gesture on
`is_dm` against the hit test before acting on it. This was the second time the existing hit test
turned out to be the boundary already.

Two things cost more than the state model, which was a `Set<string>`.

Escape drops a group, added after the rest was working. Five tools in the rail already respond to
that key, and a sixth thing you can be holding that ignores it would be inconsistent. The case a
click on empty map doesn't cover is a board with no empty square left to click.

**Marquee select was the original request and isn't built.** A marquee is a drag on empty ground,
which is what pan already is, so it needs a modifier or a rail tab, and a rubber band drawn.
Shift-click needs neither and gets most of the value. If it's ever wanted, the selection set is
already there and only the gesture is new work. What made the smaller version clearly right was
noticing that the left button already carries pan, token drag, ping, door swing and shape erase, and
that the ping entry (milestone 19) records what it costs to add to that list.

One ruler for a group is only true on the dragger's screen, and this is the one place the feature is
knowingly inconsistent. Watchers build rulers from `TokenMoved`, and nothing on the wire says which
token was grabbed, so the table sees one ruler per moving token. The fix is a field on one of the
busiest messages in the project, for a hint that refuses nothing and persists nothing, and it was
declined. But the conflict was only visible from `docs/drawings.md`, not from the code, which is the
argument for reading the subsystem doc before designing against a subsystem.

## 26. The panel pass

Built out of order: a table tab, a folding initiative panel, softer fog edges, and the DM's solo
sight. Numbered after 25 and built before 23, because none of it depends on anything unbuilt, and
because three of the four parts came from playing rather than from the roadmap.

**The table tab has a rule attached, and the rule matters more than the tab.** `show_names` and
`diagonals` are `RoomState` fields, and both were living in the token panel's form (which describes
one selected creature) behind a divider, with two comments in the markup explaining the placement.
One said the dropdown was there "for want of a better home". A panel mirrors where its fields live:
`MapInfo` is the map tab, `Token` is the token tab, room-wide state is the table tab. That
arrangement was the only violation.

Cost: one entry in `RailTab`, one entry in the array `main.ts` passes to `createRail`, and a
fourteen-line `table.ts`. That's exactly what milestone 15's tab strip was built to make a panel
cost, and the first time the claim was tested by adding one. No Rust, since both commands already
existed. It's named *table* rather than *room* because `Lighting::Room` is a fog mode one tab over,
and two meanings for one word in adjacent panels is worse than a slightly odd name.

The initiative panel folds the list and never the turn. Collapsed, it renders only the current row
through the loop that was already there, so the folded panel is the unfolded one's highlighted line
rather than a separate drawing. The turn buttons stay: advancing the turn from a folded panel is most
of what folding it is for. Collapsing to a bare tab was the obvious design, and it would repeat the
door-swing mistake (putting something used in play behind an extra step) with information instead
of an action; `panel.ts` says of itself that glancing at it is all it's for. The fold is in
`localStorage` and not on the room, which is the line `diagonals` falls on the other side of. See
*It folds the list and never the turn* in `docs/tokens.md`, which also settles the right dock
question.

The fog edge is feathered now, and the one-line version is wrong. Turning `imageSmoothingEnabled`
back on over a canvas with one pixel per cell ramps across the whole square *and moves the boundary
half a cell*, because bilinear sampling anchors on pixel centres. That displacement is exactly what
the old "smoothing is off" comment was defending against. The comment was right about the danger and
wrong that a hard edge was the only cure. Drawing each cell as a solid block of `SUBCELLS` pixels
first keeps the boundary where the server put it and confines the ramp to a quarter of a cell. The
override tint keeps its hard edge: a fog edge approximates a wall, while an override edge is exactly
the squares the DM clicked.

**Solo sight is the answer to "should fog be per-player", and the answer was no.** The question was
asked directly, and the architecture could support it: per-client `mpsc`, `snapshot_for`, `FogView`
already built per recipient. The cost is to play, not code. `unseen_by_table` becomes
`unseen_by(client)` at six call sites, `FogView` stops being the one message identical for everyone,
and there's no defensible answer for what the DM's own board should then show, which usually means
the question was posed wrong. What a table actually asks is narrower and has one answer: *can the
rogue see it*. That's `solo.ts`. It's client-only and needed no command, no event, no filter and no
Rust. *(Milestone 29 reopens this; its design in `ROADMAP.md` explains why.)*

It can't leak because a player's client holds no walls, so it couldn't compute this if it tried.
That's `crossesWall`'s argument for the movement hint, word for word. Every piece already existed:
`crossesWall` for `Dynamic`, `fillFrom` for `Room` (with one optional radius bound added), and
`fogFromWire` for the picture, so there's no second rendering path to keep in step. The general form
is the counterpart of milestone 21's: a feature that only asks a question the client already has the
data for is nearly free.

Four things cost more than the state models, which were a `RailTab` variant, a boolean and a
`WireFog`.

- One button with three states, and the order of its branches matters: *arm*, *an answer is
  showing*, *neither*. It shipped toggling `checking` first, so pressing it with a creature picked
  re-armed instead of going back to the table's board. That left the DM holding one creature's sight
  with no control on screen to clear it, while the panel's hint promised otherwise. The driver caught
  it. Anything on the board comes off first.
- Moved UI takes its drivers with it. Renaming two ids broke four drivers, and one (`drive-undo`)
  failed on an assertion unrelated to the change: it opened the token tab, and what it was checking
  had moved. A rename isn't just a rename when a test names the id.
- `drive-panels.mjs` opened both browsers on the same debug port, so "the player" was the DM's own
  page. The two pixel readings came back identical and looked like a leak, and two more runs went
  into chasing a bug in `solo.ts` that didn't exist. The ports are now fixed at 9333, 9334 and 9335,
  and that matters. The control measurement is what settled it: a noise floor of 0.00% on a board
  where nothing is happening turns every later number into evidence.
- A driver must not assume where the server puts a token. Looking up a creature by name and clicking
  where it ought to be failed repeatedly on a board with two of them side by side. Clicking its
  initiative row centres the camera on it, which is one click instead of a hundred and can't miss,
  and then the driver asserts *which* creature it picked from what the panel says rather than what it
  assumed. Per-run token names, and a cleanup that matches by pattern rather than exact name, keep a
  failed run from breaking the next one.

## 27. The presence pass

Done 2026-08-19, all four parts. See `docs/presence.md`. What the design didn't anticipate is in the
four notes marked **On landing**. Everything else held, including the claim that three of the four
parts touch no Rust and the fourth is where the difficulty is.

Who's here, and who they are. The theme is what makes four parts one milestone: the application had
no answer to *is the DM still connected*, *it's your turn*, *my socket dropped*, and colours nobody
chose. Milestone 26 is the precedent for a four-part pass held together by a theme rather than a
dependency. The fourth part is where the difficulty is, and it isn't the one that looks it.

### 27a: connected players

`roster` is the cast list, not who is connected; CLAUDE.md says so, and this is what finally needed
the other list. The server already computed it: `roster_slots()` builds `claimed` by scanning
`clients`, and at the time only sockets on the identity picker ever saw the answer. Both emit points
already existed and did neighbouring work: `hello`'s success path calls `refresh_pickers`, and the
`Disconnected` arm calls it *and* dispatches `Event::SketchEnded`.

- `ServerMsg::Presence { here: Vec<Owner> }`. `Owner` rather than `RosterSlot`, because what a table
  most wants to know is whether the *DM* is there, and `RosterSlot` can't represent that. Also,
  `colourOf` and `nameOf` already resolve an `Owner` to a name and a colour with nothing on the wire,
  which is `Pinged`'s argument reused.
- A set of identities, not a count. `RosterSlot`'s own doc comment says a player on a laptop and a
  phone is legitimate, so two connections for one person is one entry.
- `here` is on `RoomView` as well as on the delta, so the join snapshot carries it (invariant 3) and
  `Restored` is correct for free. `state` was already boxed, so milestone 15's large-variant warning
  didn't apply.
- Shaped like `NamesChanged`: identical for every recipient, no filter, no permission. Off `Saved`,
  so off the undo ring for the same reason `chat` is. The room already had the sentence that makes
  this correct, in the `Disconnected` arm: *"Who happens to be connected is not part of the room."*
- On screen it's a row of chips at the top of the right-hand column. That end of the column never
  moves: the initiative panel folds and the dock grows upward, which is `dock.ts`'s own argument for
  putting its strip last. Absent players dim rather than disappear, so the row never reflows. The chat
  destination chips dim too, because whispering somebody who isn't there is the failure this feature
  exists to prevent.

**On landing:** all of it held. The one thing not designed for was the test suite. A `Presence` now
comes with every join and leave, and every test in the server suite opens two or three connections,
so `drain` had to filter it as it already filters `UndoChanged`. Three tests using raw `try_recv`
needed a `settle` after their joins. That's the cost of an unrequested frame arriving in a suite
built around "and nothing else".

### 27b: "your turn"

When `initiative.current` becomes a token you own, flash the title while the tab is hidden and show a
notice beside the dock. Client-only: `panel.update` is already given the whole `Scene` and
`identity.ts` holds your id. That's milestone 26's lesson again: a feature that only asks a question
the client already has the data for is nearly free.

It must not fire on `Welcome` or `Restored`. Adopting state isn't a turn change, and a restore
mid-combat that notifies six people does more harm than the feature does good. Seed the previous
value from the snapshot. It doesn't open or move anything, the rule the ping arrow, the initiative
panel and the chat badge each already follow for the same reason.

Left open on purpose: it fires for the DM on every monster's turn, because monsters are `Owner::Dm`
and it really is their turn to act. That may be right or may be noise. A `localStorage` off switch is
the cheap follow-up, and play decides. It's the same kind of question as milestone 19's draw-tool
choice, which was also only answerable by using it.

**On landing:** built as designed, with `update` and `adopt` as two methods so the seeding rule is in
the type rather than in a comment. The notice got its own box beside the chat toast rather than
sharing it: a whisper arriving must not wipe out the news that you're up, and both can happen in the
same second.

### 27c: reconnect on drop

CLAUDE.md stated the gap: *"A keepalive is not a reconnect — when the socket does close, the page
still says so and waits for a refresh."* Back off on close and call `location.reload()` when a fresh
socket opens.

The reload is the design, not a shortcut, because of milestone 22. `onWelcome` builds the pings,
panels, four tools, rail and board once per socket, on the assumption of one Welcome per socket, so a
second one constructs a second copy of everything and registers another `window` keydown listener per
tool. That's the problem `Restored` was invented to avoid, and here nothing needs inventing: a reload
is already the supported path, and this only automates what the page used to ask the user to do by
hand. Keep the existing banner for when the backoff gives up.

**On landing:** built as designed. `onClose` split into `onLost` and `onClose`, which is what keeping
the banner turned out to mean in practice. Nine attempts over about a minute. Verified by hand both
ways: the reload fires when the server comes back, and the give-up banner appears at ~80s when it
doesn't. No driver, because testing it means stopping and starting the server, which the README's
run-all loop shouldn't do.

### 27d: player-picked colours

Split out of milestone 19, which had already priced it: *"it replaces the body of `colourOf` below
and touches nothing else, with these as the defaults for whoever never picks."* True, and that's the
client half. The server half is new persisted state and is the whole cost of this milestone.

- `colours: HashMap<Owner, String>` on `RoomState`, persisted. *(Landed as
  `BTreeMap<PlayerId, u8>`; see below.)*
- `SetColour` carries no key; whose colour it is comes from the socket. That's `Say`'s rule and
  `SetNotes`'s rule a third time, and three instances is a pattern worth naming in `docs/`: a key a
  client could name is a key it could use to name someone else's.
- Public, unlike the notes, because everyone needs everyone's colour to draw pings and chat
  attribution. So this is the first player-writable state that isn't private, which is how it differs
  from the scratchpad and why it doesn't just reuse `notes_for`.
- A closed palette, not free hex, for a reason already written down. `pings.ts` records that the six
  hues avoid the token ring colours in `render.ts`: gold is ownership, blue is in progress, white is
  the turn, violet is hidden, teal is staged-only. Free hex would let a player pick gold and make
  their own ring claim ownership falsely, which is the board saying something untrue about a
  creature. So the command carries an index into a fixed set, validated server-side like
  `Token.size`, and there's no colour-picker UI to build.
- The undo exemption needs both parts. Milestone 22's rule is that the ring may only hold state the
  person undoing wrote, and a player's colour isn't the DM's. So `undid` returns `None` for
  `SetColour`, *and* the `Undo` arm of `apply` lifts the colours out and puts them back around
  `adopt`, because a colour picked *between* two commands is on the snapshot the later one pushed.
  This is the second thing to need that exemption, which turns `docs/notes.md`'s "the only thing
  exempted by hand" into a rule with two instances. The entry asked for that file and `docs/undo.md`
  to be updated when this landed.
- The control is your own chip on the presence strip, where every colour is already visible. Not a
  third dock tab for one control: `dock.ts` argues against that itself, since its panels are things
  you read while something else is going on.

Owed on landing: a `docs/presence.md` and a CLAUDE.md section pointing to it, and a
`tools/drive-presence.mjs` on fixed debug ports: two browsers listing each other, then one closed and
the other's strip dimming that name. Milestone 26's `drive-panels` problem is why the fixed ports are
required.

**On landing:** all of it held, and all three were delivered. Four things the design didn't settle
and the build did:

- The table is a `BTreeMap<PlayerId, u8>`, not a `HashMap<Owner, String>`. `PlayerId` is a newtype
  over `String`, so it's a valid JSON object key, which `Owner` isn't; that's why `notes` had to be a
  sorted list of pairs. `BTreeMap` keeps itself sorted, so the file doesn't churn. One type in the
  room, on the wire and on disk, and `to_saved` is a clone.
- The stored value is the index, not the resolved hue. The server has no copy of `PLAYER_HUES` and no
  opinion about what `3` looks like. It holds only the list's length, as `PALETTE`, so changing a
  colour touches no Rust.
- Two people may pick the same swatch and nothing refuses it. `pings.ts` already argued that colour
  doesn't scale to seven people and the name beside a ring is the real answer, so a duplicate is
  still legible, and it keeps `check` to a bounds test.
- The DM is refused `SetColour` at three layers: the table is keyed by `PlayerId`, so a DM entry
  can't be represented; `check` refuses it; and `colourOf` answers `dm` before it reads the table. A
  rule only the UI enforces isn't a rule.

The driver opens three browsers rather than the two designed for: a colour has to reach somebody who
didn't pick it, and with two browsers the picker and the observer are the same window.

## 28. Cursors

Done 2026-08-19. Everyone's pointer drawn on everyone's board. The design was held without a number
until then (see *Cursors* in the last section), and it was written into `docs/presence.md` rather
than getting its own file: a cursor is a colour with a name beside it, and like the four parts before
it, this milestone is about the people looking at the board.

The design got most of it right: `Ping`'s shape but more ephemeral, a throttled frame carrying a
`Pos`, nothing persisted, nothing in the snapshot, send only on movement, decay after a few seconds
of stillness, and 27d first so `colourOf` wasn't changed underneath it.

**What it got wrong is the fog, and that's the thing to read here.** The design said to gate on
`known` for everybody. What shipped gates the DM alone, because the gate only protects against a hand
that knows something, and the only person at the table who does is the DM. A player can point only
at what their own client drew, so gating a player's pointer gains nothing and costs the feature on
exactly the ground the party is fighting over. The design section is left as it was written; this
paragraph is the correction.

Four things the build settled that the design didn't:

- The switch is new state and wasn't in the design. `show_cursors` is the third sibling of
  `show_names` and `diagonals` on `RoomState`, on the table tab because a panel mirrors where its
  field lives. It stops the server relaying cursor frames rather than only hiding them on screen:
  this is the busiest message in the protocol, and a switch that saved none of that traffic would be
  a preference rather than a control. It defaults on, the one way it differs from `show_names`: that
  one defaults on because it's what the board already did, and this one because a feature switched
  off in every existing room is one nobody finds.
- The client stops sending while previewing the staged board. A position there is in a different
  dungeon's grid units, and the server must not learn preview exists, so it's one condition at the
  send site, like every other `staged` decision on the client.
- Two numbers changed within an hour of first use, both in the same direction. It shipped at ~15Hz
  with a full-strength arrow, on the argument that a pointer is background information and should be
  neither the smoothest nor the loudest thing on the board. Half of that was right. *Quieter* was
  right and went further: a small dot at 55% rather than an arrow at full strength. *Slower* was
  wrong, because a hand has no inertia, and 15Hz looks like stutter where 25Hz on a token looks fine.
  30Hz and a dot is what shipped. The switch is still there if the cost ever matters.
- `drive-ping.mjs` needed a change. A parked pointer draws into the pixel boxes that driver measures
  on the *other* client's screen, so a baseline taken while an arrow was showing, and read after it
  had decayed, reported a difference unrelated to any ring. It now switches pointers off for its own
  run. That was the first time a feature in this project made an existing driver give a false
  result. The lesson is narrow: a driver that diffs a box on somebody else's screen now has a second
  moving thing in it.

**Ping didn't remove the need.** The *Cursors* design was left unscheduled because milestone 19
might have made it pointless, and *"that is not knowable before playing a session with pings in
it."* Sessions were played and the answer was no: a ping is a deliberate gesture, and cursors give
background presence, knowing where somebody is looking without them having to ask for attention.
Everything else the design settled still stands, including two warnings worth re-reading: it would be
the busiest thing in the room by an order of magnitude, and the fog question lands the opposite way
from ping's. *(Whose pointer it applies to is corrected above: the DM's only.)*

It depended on 27d and wasn't built before it. A cursor is a colour with a name beside it, and
`colourOf` indexing a fixed palette by roster position is exactly what player-picked colours replace.
Building this first would have built it against a function about to change, for no gain, since 27d
replaced the function body either way.

## 29. Party sight and split sight

Not built. The design is in `ROADMAP.md`.

## 30. The backdrop

Done 2026-08-22. A picture the DM shows the table *instead of* the board. See *Backdrop* in
`docs/maps.md`.

**The request was for scenes, and the answer was not to build them.** The DM wanted a forest clearing
or a campsite on everyone's screen during dialogue-heavy stretches, and the obvious reading was
"Slate needs more than two map slots". What made that reading wrong is what `sweep_board` does: a
`SetMap` whose URL changed clears the drawings, clears the walls, calls `forget_fog` and drops the
DM's paint. Showing a campfire between two fights wasn't just awkward, it cost the encounter, which
is *why* it felt like a scene system was missing.

What was asked for isn't a map. No grid, nothing standing on it, nothing traced across it, nobody
exploring it. A scene system would have paid for all of that and used none of it. One
`Option<String>` on `RoomState` did the whole job, and `apply`'s arm is an assignment and an event.
Keeping that arm short is the feature, because everything a scene concept would have had to fork
just carries on behind the picture.

The general form: when a request seems to need a bigger version of something you have, check whether
it needs that thing at all. Two other milestones read the same way in hindsight: the chat that is two
destinations, and the journal that is one box.

Three things were cheaper than expected, and one cost more:

- The presets are the folder. "A few presets" sounded like a list in the state model, and it's a
  third `Library` beside `maps/` and `portraits/`: the same code a third time, taking the portraits'
  answer on both axes it chooses between. The room holds *which one is showing* and nothing else,
  which is what keeps this from being a scene manager under another name.
- Unfiltered, so there was no filter to write. `BackdropChanged` sits beside `NamesChanged`: who may
  put a picture up is a permission question, but which picture it is isn't a secret.
- The board stops responding through one CSS rule, `body.covered #stage { pointer-events: none }`,
  rather than a guard in each handler in `input.ts`. With no pointer events delivered there's no pan,
  drag, ping, door, sweep or cursor relay. That's the same approach as the fog and the walls: they
  can't leak because the data is absent, not because something checks.
- The one branch that had to be argued is `shownBackdrop`. A backdrop is what the *table* is looking
  at, so the DM previewing the staged map has to take priority. Otherwise, putting a campfire up
  means the DM can't prepare anything without taking it off six other screens. It's the fourth of the
  `shownBoard` family and answers one question earlier than the other three: they pick which board,
  and this decides whether a board is drawn at all.

## 31. Prepared maps, remembered per URL

Done 2026-08-22. A DM can trace three dungeons on a Tuesday and find all three still traced on
Saturday. See *The shelf* in `docs/maps.md`.

This is milestone 30's other half, from the same conversation, where the request was "I'd like to
save map states and prep a handful of maps before a session". Read 30 first. The two look like one
feature and aren't: a backdrop is about what's on the screens, and this is about what the DM has
already done to a map.

Most of it already existed. `Calibration` is "everything the DM learned about this map, keyed by URL,
persisted, never sent": grid, offset, play area, and `fog`/`vision_ft`/`lighting` too. The only
preparation it didn't remember was the traced walls and the painted overrides, which `store.rs`
itself calls the one thing on `Saved` that would make the feature unusable if it weren't persisted,
and which were persisted for the current board only.

So it was one table entry growing, and two write sites (three, once `ClearStaged` was counted):

- the outgoing board's walls and overrides are recorded under *its* URL as it's swept
- the load arm of `SetMap` restores them, as it already restores the grid

No new commands, no new events, no list in the state model, no panel UI, `staged: bool` on the wire
unchanged, and no filter to widen: walls already reach the DM or nobody, which is also what made
milestone 20 cheap. The disk format stays compatible, and an old save loads with empty walls per
entry. The shelf is the folder, which is milestone 30's point again.

A wrapper, not two more fields on `Calibration`. The entry originally said to put `walls` and
`overrides` inside `Calibration`, and reading the code said not to:

```rust
struct Prepared { calibration: Calibration, walls: Vec<Wall>, overrides: OverrideView }

// Field name kept, so `#[serde(rename)]` holds the disk shape unchanged.
calibrations: HashMap<String, Prepared>
```

`Calibration` is what the client sent, and the room builds one as a bare struct literal from the
`SetMap` fields (`given`, in the arm). Growing that type mixes up "what the DM typed into the panel"
with "what the room has learned", and the three traps below all come from that. With the wrapper,
none of them arise.

Three traps, all read from the code on 2026-08-22 rather than remembered. The first is silent, which
is why the wrapper is worth the extra type.

- **The recalibration clobber.** `self.calibrations.insert(url.clone(), given.clone())` in the
  `SetMap` arm runs on every recalibration, not only on a first load. With walls inside
  `Calibration`, the struct literal above it stops compiling, the obvious fix is
  `..Default::default()`, and that inserts *empty* walls. Nudging the grid on a traced dungeon would
  silently erase what the room remembered about it. The board keeps its walls (a recalibration
  doesn't sweep), so nothing looks wrong until the DM loads another map and comes back. With a
  wrapper, the insert can't reach the walls.
- `sweep_board` can't ask which map it's sweeping. Its two call sites assign the map in opposite
  orders: `SetMap` does `self.map = finished` and then sweeps, while `PromoteStaged` sweeps and then
  assigns. So `self.map.url` inside `sweep_board` is the incoming map on a load and the outgoing one
  on a promote. Recording against it files a dungeon's walls under the map that replaced it, and they
  come back on the wrong image. Pass the URL in: `showing` is already computed at the top of the
  `SetMap` arm, before anything is assigned, and is exactly the outgoing URL.
- The staged slot is a second write site with a different shape. Staged walls never reach
  `sweep_board`; they're dropped in the `carried` match at `self.staged.take()`, where the load arm
  discards the old board. It's easier than the live one, since `board.map.url` is right there, but
  it's a separate edit and exactly the kind that gets missed. "The arm that gets missed" was already
  written into six places across `room.rs`, `docs/maps.md` and `docs/walls.md`, and this would have
  been a seventh unless both sites landed together.

Also: `Calibration` derives `PartialEq` and `Wall` doesn't, so the two can't be combined without one
of them changing. The wrapper avoids that too.

Two omissions, and the second is the boundary.

- Token plans. `staged_pos`/`staged_only` are on `Token`, singular, and stay tied to whatever is in
  the staged slot. The DM prepares *terrain* for many maps and *the encounter* for the one they're
  about to run. Moving plans onto a prepared board is a real refactor and wasn't what was asked for.
- `revealed` isn't remembered. Returning to a dungeon means the party explores it again. Remembering
  it would make a map swap a partial scene restore, which immediately raises "why not token positions
  too", and that leads to the feature `docs/maps.md` refuses. The split to hold: **the DM's
  preparation is remembered; the party's play state is not.**

The thing to watch was that this weakens the case `docs/undo.md` made for the undo ring ("the case
that makes undo worth having is `sweep_board`"). A load that gives the walls back on the way in is
less destructive. Undo is still right for the other nine reasons; the doc's argument needed rewording
rather than the ring needing deletion.

Two smaller consequences. There's no frame-cap question here, which is worth saying because the "a
command carrying a collection has two limits" rule in CLAUDE.md looks like it applies: this table
never reaches the wire, so `MAX_WALLS` is the only bound and nothing new needs a
`largest_..._fits_in_a_frame` test. And `drive-staged.mjs` became more order-sensitive. It asserted
`the staged map is untraced` after picking library map #1, which stops being true on any second run
against a persisted scratch state once walls come back with a map. The driver notes already said to
start from a fresh `SLATE_STATE`; this made that necessary rather than advisory, and the check needed
rewording to say what it means.

### What building it found

The three traps were read from the code before a line was written, and all three were real. The
wrapper made the first one impossible to write rather than just avoided, which is what it was for.
Four more things:

- `ClearStaged` is a third write site, and it's the rule rather than an extra. The shelf is keyed by
  image, not by slot, so which of the slot's two exits the DM took must not change what next week's
  load finds. Discarding the *preparation* is `ClearWalls`; this discards the slot. That also settles
  what gets filed in general: whatever the board was actually holding, empty included. Filing only
  non-empty lists would make it impossible to start a bad trace over.
- A fourth ordering trap, which the entry missed. The live arm cleared the overrides in its
  `reshaped` branch *before* the sweep ran, so on a load the DM's paint would have gone onto the shelf
  as nothing. The two arms are now exclusive (`if loading { … } else if reshaped { … }`), which
  behaves identically because a load clears everything the reshape arm clears, and the comment there
  says why the order matters.
- Two frames needed deduplicating. A load between two traced maps fires both the sweep's
  `WallsChanged` gate and the restore's, and both are built at *dispatch* from whatever the room holds
  then, so the second names the same list as the first.
  `swapping_between_two_traced_maps_names_the_walls_once` covers it.
- The client needed nothing. `scene.walls` is on the `Scene`, not the `Board`, so `MapChanged`
  replacing the board doesn't touch it, and the `WallsChanged` after it lands normally. Tested in a
  real browser: trace a map, load another, load the first back, and the walls are on screen.

`drive-staged.mjs` was the one thing that needed changing, and it needed more than a reword: its
staged slot now comes back holding the door it placed last run, so it clears the slot's walls as it
already clears the board's. The check after that now says what it really asserts: that the board's
own walls didn't follow the map into the slot.

## 32. Writable libraries

Done 2026-08-22. The DM adds an image to `maps/`, `portraits/` or `backdrops/` from the panel, and
removes one from the list. See *Adding and removing* in `docs/maps.md`.

Milestone 31's other half, found by using it. The shelf makes a map remember what was traced on it,
which is only useful for a map that's *in* the library, and the only way to put one there was `scp`
onto the Pi. An uploaded map went into `uploads/` under a fresh UUID: a one-off that couldn't be
found again next session, and that a second upload of the same file duplicated under a second URL
with a second set of walls.

So uploading became adding, rather than a second button beside it. The upload control each panel
already had now belongs to the library widget: it writes into the folder and then picks what it
wrote, so an uploaded map is a library map in every respect. Three things followed:

- The two upload routes were removed. `/api/map` and `/api/token` shared one handler and had no
  callers left, and `uploads/` went back to being only the serving directory rather than a second
  library. `docs/maps.md` had a paragraph defending "an uploaded map gets a fresh UUID" as an
  intended asymmetry. It was intended while the folder was read-only, and not worth defending once it
  wasn't.
- The backdrop panel gained an upload it never had. Nobody asked for it; the widget gained adding and
  all three panels use the widget. That's the argument for putting it in the widget rather than in
  each panel.
- Twelve operations, four handlers. Three libraries times list/pick/add/remove would have been twelve
  one-line wrappers on top of the six that existed, so the folder became a path segment:
  `/api/{library}`, with `Library::named` refusing anything else. Fewer lines than before the
  milestone.

**The two rules that carry the risk.** A client-supplied path now reaches the filesystem in exactly
two places, guarded differently on purpose. A *pick* may name a subdirectory, so it's normalised and
then checked against the canonicalised root. An *add* must be a single path component, so it *can't*
leave the folder, rather than being checked not to have. Taking the last segment of
`../../evil.png` would accept a traversal by silently meaning something else. The rest is Windows,
which is a deployment target: the characters it reserves, the device names it resolves ahead of
files, and the trailing dots it strips, since a file written under a different name from the one the
DM typed is one they can't then remove.

A remove deletes the library file and nothing else, not the copy in `uploads/`, so the board keeps
working and the calibration and walls stay on the shelf. Re-adding the same name later lands on the
same URL and finds all of it. That's what makes the destructive button safe, and it comes from a pick
being a copy, not from anything new.

What building it found, including one bug this milestone caused:

- A row gained a second button and a driver was off by one. `drive-backdrop.mjs` staged a map with
  `querySelectorAll('#map-library-list button')[1]`, which had been the second row and became the
  *first row's remove*. `cdp.mjs` stubs `confirm` to `true`, so it deleted a map from `maps/` and
  then failed two checks about staging. Recovered with `git checkout`, because the libraries are in
  git. The fix is a class of its own on the pick button rather than three corrected selectors:
  `.map-library-pick` can't be off by one. This is `board.mjs`'s lesson one layer up: a driver may
  not assume the map it was written against, and it may not assume the shape of a widget either.
- `ProtectSystem=strict` would have refused every add on the Pi. The libraries lived under
  `/opt/slate`, which is outside `ReadWritePaths` and owned by root, so the feature would have worked
  on Windows and failed on the actual deployment. They moved to `/var/lib/slate` alongside
  `uploads/`, which fixed the permission, the ownership, *and* the deploy wiping them, all three of
  which needed solving anyway. The repo's folders became seed content copied in once at install.
- `backdrops/` was missing from the Pi deploy entirely, never added when milestone 30 landed. It
  didn't matter while nothing wrote there; now it does.

Not built: renaming, and folders. An add puts one file directly in the library root, so there are no
directories to create and none to tidy after a remove. The picker still *lists* subdirectories,
because a DM who arranges the folder by hand should see that. Renaming is remove-then-add, which is
also how replacing a portrait's art works, and both take two steps for the same reason: the one-step
version is a silent overwrite with no undo.

## 33. Multi-room

Done 2026-08-23. A Halloween one-shot on the same server as the campaign, without clearing the
campaign's board to run it. See `docs/rooms.md`, and *Multi-room* in the last section, which is the
design as written in advance with its corrections marked inline.

It was numbered late. The design and the notes on how it went both landed in that section rather
than in this list, and the number was never written beside them. Nothing here repeats what those
say: three of the six items held, three were overturned, and the corrections are where they are.

What's worth pulling up into the numbered record is where the cost landed, because it's the one
milestone whose cost landed somewhere the roadmap didn't look. **The room registry was the cheap
half.** `ROADMAP.md` and `CLAUDE.md` had both budgeted an `RwLock<HashMap<..>>` for it. What shipped
is a const and an `Arc<HashMap<..>>` built once in `main`, because a lock guards a table that changes
and nothing changes this one. The expensive half was the twenty-odd files that weren't about rooms
at all: every `tools/drive-*.mjs` needed `?room=campaign` appended, and `audit-uploads.mjs` had to
start reading *every* room's save, or it would print an `rm` for every other room's art. Shared
libraries with separate boards is what caused that.

The general form, the reverse of milestone 21's: a feature that adds a dimension to something shared
makes every tool that reads it wrong at once. The room actor didn't care that rooms are plural;
everything outside it did.

## 34. Player view

Done 2026-08-25. The DM's own board, redrawn as the board the table sees. One button on the fog
panel; see *Player view* in `docs/fog.md`.

Unplanned, like 25 and 26, and from the same source: playing. The DM holds more of the room than
anybody else by design, and the cost is the one thing every other screen has for free: knowing what
it's showing. Before this, the only way to check was to open a second browser and claim a player's
slot.

**It exists because the fog is party-shared**, which is why it's small. There's one answer to "what
can the table see", so the mirror is a fact rather than a choice between six, and `asTable` is a pure
function over a scene the DM's client already holds. No command, no event, no filter, nothing on the
wire: milestone 26's pattern a second time, and the second feature that can't leak because it only
uses what the client already has.

Milestone 29 is the entry this one relates to. If `visible` ever becomes per-player, `asTable` is
where a name has to go, and this feature would need a defence it doesn't need now. 26 answered the
objection that ruled out per-player fog; this one makes it less needed, since the question a DM
actually asks (what's on their screens) now has a button.

What building it found:

- The initiative panel had to mirror too, which wasn't obvious. A mirrored scene alone leaves a
  hidden creature's row drawing as a raw id, which is exactly the failure `initiative_for` exists to
  prevent: the server's filter, rediscovered by removing it. The panel is *told* rather than given a
  narrowed scene, because it redraws when a message arrives and the board redraws every frame.
- The fog isn't filtered, it's drawn darker, so it needed a second canvas rather than a second
  answer. `Fog` gained `table`, built only on the DM's client, and `drawFog` picks between them on
  one line that handles all four cases without asking who's reading.
- `Fog` had to keep its packed `cells`. The canvas answers how dark a square is; the mirror has to
  ask whether the table can see what's standing on it, which reads the same characters for a
  different question.
- Editing is untouched. The DM can drag and click through the mirror. Refusing would have made it a
  second opinion about permissions, and the project has exactly one of those and wants to keep it
  that way.

Then it took the sight check off the panel, days later, based on using it: a DM reaching for *can the
rogue see it* was nearly always asking what the table's board looks like, which is now one button.
`SOLO_SIGHT` in `fogtool.ts` is the whole of the change; `solo.ts`, its tests and the render path are
untouched, and milestone 29 is what turns it back on, for the reason its design gives.
`drive-panels.mjs` lost its solo half and gained a check that fails when the const flips.

## 35. The controls pass

Done 2026-08-27. The rail stops surprising the person using it, and the DM can take their own
pointer off the table's boards. Two parts held together by a theme rather than a dependency, like
milestones 26 and 27: neither came from the roadmap, both came from playing, and each fixes a control
that did something other than what the person reaching for it expected.

### 35a: the rail pass

Two changes and one removed return value. Selecting a token used to open the token tab; now **only a
click on a tab changes which tab is open**. That's rule 4 in `docs/frontend.md`, which has it in
full. What's worth keeping is what the rule cost: with its one caller gone, nothing else changed the
strip, so `createRail` returns `void`. The rule is in the type rather than in a comment asking future
callers to respect it, the same approach `Omit<Scene, 'previewing'>` took for undo in milestone 22.

The rail also remembers its open tab in `localStorage`. It used to open nothing on connect, on the
argument that the change was about giving the board back, and that argument forgot milestone 27c. A
dropped socket reloads the page, so "on connect" isn't only the start of an evening, and a rail that
opens empty then empties itself in the middle of a fight. A general trap: since 27c, every "on
connect" decision in this client is also a mid-session decision, and the two usually have different
right answers.

### 35b: the DM's own pointer

`show_dm_cursor`, a narrower sibling of `show_cursors`: the DM's pointer off the players' boards, with
everyone else's untouched, for a DM who wants their hand out of sight while the party argues about
which door to open. On `RoomState`, DM-only to set, unfiltered, persisted, a step on the ring, on the
table tab, defaulting on. The fourth instance of the `show_names` pattern. See `docs/presence.md`.

It cost four lines of filter because `cursor_seen` already existed to answer this question, and
already answered *no* for one case: the dark. The switch widens that case from "over ground the party
hasn't explored" to "anywhere". That's milestone 21's lesson a third time (a feature that changes
what a filter is given, rather than what it decides, is nearly free), and it's why a full-stack
change with a new command, a new event and a `protocol-tags.json` entry still touched no visibility
rule.

**The order inside `cursor_seen` matters.** The check is read after the two yeses and *before* the
`map.fog` guard. The other way round, it's a switch that does nothing until the DM turns fog on,
which nobody would want, and it would have tested clean on every fogged map in the project.

Where it differs from `show_cursors`: it stops the relay, not the sending. `show_cursors` takes every
client's frames off the wire; this is one client in seven, so a second condition at the send site
would add a branch in `input.ts` to save nothing measurable, and the DM's client would then have to
decide whether a second DM tab counts.

## 36. The damage box

Done 2026-08-31. The DM types `-12` on a creature's initiative row instead of doing the subtraction
in their head on the token tab. See *The damage box* in `docs/tokens.md`.

Milestones 26 and 35's pattern a third time: it came from playing, not from the roadmap, and it fixes
a control that made the person using it do arithmetic. It's also milestone 18's pattern a second
time: no Rust at all. `panel.update` is given the whole `Scene`, so the row resolves its own token and
has every field `UpdateToken` needs; the box computes the absolute value and sends an ordinary edit.
Nothing was missing from the wire, and there's still no `SetHp`.

Three things worth keeping.

**Again, the permission check is the one that isn't there.** The box is built inside the existing
`hp !== null` branch and gated on nothing else, so a player's panel can't contain one: `view_for`
redacts `hp`, and `asTable` strips it for player view. That's invariant 4 failing safe for the third
time on this panel (the bar, the numbers, and now the control that edits them), and none of them asks
who's reading. The driver asserts it as the absence of `.init-damage` anywhere on the second
browser's page.

The rule that had to be invented is about the caret, not the numbers. The panel is rebuilt entirely
on every token delta, which had always been fine because nothing on a row was worth typing into for
long. `valueField` has the same hazard, and a misheard roll is corrected once. A damage box is used
repeatedly on the same creature, and the room's echo of the hit destroys the element it was typed
into. So `update` records which `data-hp-for` had focus and restores it after `replaceChildren`. The
general form: rebuilding everything is affordable until a control is used twice in a row, and
nothing in the state model shows that. Drag frames were the thing to check and are safe:
`onTokenMoved` doesn't reach `afterTokens`.

A delta box makes the absolute box necessary. `-3` on the row now means three damage, so the token
tab's `hp`/`max` pair is the only place left that can set a creature *to* minus three. `token_fields`
allows that, since `-MAX_HP..=MAX_HP` bounds the magnitude, and "a creature can't go below zero" is
the rules knowledge this project refuses. Keeping the tab absolute-only is what keeps the row's input
unambiguous, and it's the reason not to merge the two into one behaviour later.

One correction from the build, about the driver rather than the design: `drive-panels.mjs`'s
`build()` had to write the hit point fields on *every* token, including the one meant to have none.
The token panel keeps its fields after a create (six goblins is six clicks), so a total typed for the
first creature was still there for the second, and the check that a row without hit points has no
box failed loudly.

## 37. The status page

Done 2026-08-31. `/status/`, so "is the Pi alive, is anyone in there, did my deploy land, is the card
full" no longer needs `ssh` and `journalctl`. See `client/status/README.md`.

**It follows `/spells/`'s pattern and isn't a feature of Slate**: a static page importing nothing
from `client/src/`, no esbuild entry, no room state. Unlike the spell index it has no link on the
board either, because nobody at the table wants a link to the server's temperature mid-combat. The
coupling is one route and one `RoomCmd` variant.

Four things worth keeping.

The interim and the final version are one artifact. It was a window on the Windows machine at first
and a jailbroken Kindle or a TRMNL panel later, and designing for the second shaped the first. TRMNL
polls a URL, so JSON at a guarded URL is the format and the page is a *client* of the same endpoint.
A Kindle browser can't set a header, so the key is also accepted as `?key=`. Both are 1-bit, so the
layout is black on white with inversion as its only alarm, and it fits 800×480 without scrolling,
because on a panel that can't scroll, content below the fold doesn't exist. `drive-status.mjs`
asserts that fit, which only a browser can see.

A stuck room must not hang the page. The status request goes through each room's own `mpsc`, the
same queue a socket uses, because an answer produced outside the room would describe a room it
couldn't see. That makes the wait unbounded, so `RoomHandle::status` returns `Option` and the caller
wraps it in a two-second timeout. The moment the page is most useful is the moment a naive version
would hang. A room that misses the timeout still gets a row saying so: the absence is the news, and
dropping the row would leave a page that looked complete.

Slate reports only what Slate knows. The host's temperature and the running commit arrive as two
files written by something else (a systemd timer and the deploy), which the server reads and passes
on verbatim. It never learns what `/sys/class/thermal` is. That keeps a monitoring feature out of the
room actor, keeps the handler testable on Windows, and makes the missing case accurate: both sections
read `null`, not zero. The build added one refinement: "no file configured" and "the file won't
parse" are *different* answers, because a collector that has died must not look the same as one
never installed.

**A second credential, and no key means no route.** `SLATE_STATUS_KEY` isn't the DM secret: a
display on a shelf mustn't hold the key to the map library, and both directions are tested. Unset,
`/api/status` isn't mounted at all, so an unconfigured server answers 404 rather than 403. An
endpoint that says "wrong credential" has announced that it exists. `/api/rooms` stays the only route
under `/api` reachable without a credential.

Two corrections from the build. The build stamp had to be rolled back with the binary it names: a
stamp left pointing at the commit that failed would have the page say, confidently, that a
rolled-back deploy had landed, which is the exact question the page exists to answer. And the host
reading had to be stamped with the time it was taken: a dead timer leaves a file that still parses
and still looks like data, so age is the only thing that catches it.

A third correction came from using it, and it's the same mistake in a third place. The first version
reported `unsaved` from `save_at.is_some()` alone. But that deadline is `Some` both while a change
waits out the debounce *and* while a write is failing and retrying, so a dying SD card showed as a
healthy write two seconds old. `saves_failing` and `last_saved_unix` separate the two, and the flag
holds until a write succeeds rather than for one attempt, because the retry loop is otherwise silent
apart from an `error!` nobody reads. The general form: a field that's true for two unrelated reasons
isn't a status. The fix also stopped inverting `pending`, since an alarm that fires in the ordinary
case is one you learn to ignore.

The collector later gained two more readings for failures Slate can't see at all: systemd's
`NRestarts`, because `Restart=always` makes a crash invisible, and the size of `uploads/`, which only
ever grows. Both were a line of shell and no Rust, which is the property to keep: anything about the
host is a line in the collector, and only questions about the rooms need a new binary. The restart
count also found a real ordering bug: its card was built *after* the alarm strip was rendered, so it
inverted a number on screen while the bar still read `OK`. Every card is now built before the verdict
is decided.

The last one only appeared on the real Pi. The build stamp was written by `Set-Content -Encoding
utf8`, which on Windows PowerShell 5.1 means UTF-8 with a BOM, and `serde_json` won't parse a byte
order mark before `{`. A stamp that looked correct in every editor arrived as "No build stamp", with
one `warn!` nobody was reading. Fixed at both ends on purpose: the writer uses
`UTF8Encoding($false)`, and the reader strips the mark, because a file this server only passes on is
the wrong place to be strict. The next one will be written by another tool on another machine. The
diagnosis is worth noting too: the file was the right size *to the byte* for its contents plus a BOM
plus a CRLF, which is what identified it.

### The Kindle, 2026-09-18

It didn't land the way the milestone planned. The page was written for the Kindle's browser, and a
day of running it there (the browser chrome, the screensaver, and wifi that never sleeps) ended that
idea. The device now runs the TRMNL client, which is a frame viewer: it asks a URL for JSON naming a
PNG, shows the PNG and puts the whole device to sleep. So something had to draw the PNG. Three
renderers were costed:

- trmnl.app: a third party, the status key and a tunnel hop, for a display in the same room as the
  Pi.
- Headless Chromium on the Pi: the real HTML, and the heaviest thing that would ever run on a 1 GB
  board, for three tables of text.
- Drawing the JSON directly. That's `client/status/kindle/kindle.py`, in Python with Pillow. What
  made it acceptable was giving up "show *any* page", which was the requirement Chromium was the
  price of.

**The change it forced on Slate is the one to keep: the verdict moved to the server.** Two renderers
of one payload with thresholds in each means two sets of thresholds, so `verdict` in `main.rs` now
decides what's wrong, once, with tests, and both `status.js` and the PNG show what it says. Two
failure modes shaped the frame. The TRMNL client is *silent* on failure and keeps its last image, so
a server that has gone is drawn as gone rather than left to the Kindle. And a static image has no
"updated 4s ago", so every frame is stamped with when it was drawn, which is the only way to tell a
dead renderer from a current one (the collector's `at` field again, one layer up). It's the one
process on the Pi that listens on the LAN, so its token is required, not optional.

## 38. Isometric grids

Done 2026-08-31. A map's cells can be diamonds, so the grid lands on the floor tiles of isometric
art. Never planned: it began as a feasibility question and the answer was small enough to build. See
*The shape of a cell* in `docs/maps.md`.

Unplanned and out of order like 25, 26 and 34, but for a different reason. Those were things the
design got wrong; this is something the design had already made cheap without anyone noticing.
That's the main point of the entry.

**An isometric grid is an affine transform of a square one.** That's why a feature that sounds like
a renderer rewrite is five functions. Everything computed in *grid* space was already independent of
the lattice shape and wasn't touched: `snap_to_cell`, `covered_cells`, `shape_covers`,
`with_fringe`, `snapExtent`, `feetMoved`, `trailCells`, both `Diagonals` rules, all of the wall math.
The conversion between grid and pixels was already confined to three functions in `fog.rs` and two in
`coords.ts`, as invariant 1 and `coords.ts`'s header said, and generalising those five is all the
maths there is.

The raycast was free, which nobody expected. Both fog algorithms already measured their radius *in
cells* and used pixels only for wall intersection, a split made in milestone 16 for an unrelated
tie-breaking reason, and commented as such. Only the once-per-source wall cull moved. A decision made
for one reason paying off later for an unrelated one is the argument for writing reasons down, and
it's why `docs/` exists.

The bug it shipped with is the one to remember. `repreview` derives a play area from the dragged
box, which is right for squares (the box is a *region* of the board) and wrong for an edge gesture,
which is a direction and a length. So the playable area collapsed to one diamond,
`drawOutsidePlayArea` dimmed the whole board, and `drawGrid` drew a few lines in a corner. It looked
exactly like "isometric just draws a normal grid". The readout was correct the entire time, which is
why every test passed: the driver asserted what the panel *said* and never looked at the picture. The
guard now is a brightness reading from the canvas. The general lesson: a panel describing a board is
not evidence about the board.

Two costs the estimate didn't name. `drawGrid` got *longer*: drawing two families of slanted lines
against an axis-aligned play area means taking the extent in grid space and clipping, where it used
to walk world coordinates. And `gridBounds` had to stay unrounded, because its two callers round in
opposite directions: the grid wants the lines *inside* a rectangle and a cell sweep wants every cell
it *touches*. Mixing them up cut a column off one side of a viewer's sight and not the other, which
`solo.test.ts`'s both-sides-of-the-viewer test caught immediately. That test was written in milestone
34 for a different bug entirely.

The drawing side paid for itself. Setting the basis as a canvas transform and working in cell units
turned three per-cell fill loops into one `cellPath`, made `fogRect` and `overrideRect` into
identities that were then deleted, and made the fog's `drawImage` simpler. `firstLineAt` went with
them: four functions removed for one added. The client still grew by about 400 lines net. The new
gesture, the shape control on the map panel and the comments explaining the basis are all real
additions. What *didn't* happen is the renderer doubling.

**The boundary is that it's flat**, and it's written down in `docs/maps.md`. Depth sorting, wall
height, sprite anchoring and elevation are refused, and not because of cost: `Wall` is a segment in
image pixels with no height, and it's the type the raycast, both lighting modes, the tracing tool and
the override flood are all built on. Fog aligned to the floor lattice also looks wrong against art
where a wall stands above its own footprint. That would be a different renderer, needing its own
milestone and its own argument.

`MapInfo` is the only thing on the wire that changed: no new message, `protocol-tags.json` untouched.
`Prepared` wraps `Calibration`, so an isometric map is remembered on the shelf for free. The gesture
is one dragged diamond edge, mirrored about the vertical, because real isometric art is symmetric.
`input.ts` never learned about it, since it hands over the same box either way.

## 39. Light sources

Done 2026-09-01. A radius on a token, so a brazier lights the room the party walks into and a lantern
reaches further than the map's setting. See *Light sources* in `docs/fog.md`.

It's one field on `Token` and nothing else new. `light_ft: Option<f32>`, DM-only, beside `hidden` and
`hp`. It travels on `CreateToken` and `UpdateToken`, which are already `true` in `moves_sight`,
already persist and already carry undo labels, so there's no new command, no new event, no arm in
`message_for`, and `protocol-tags.json` is untouched. That's the argument against the `Light` entity
considered alongside it, which would have needed an id type, four commands, a rail tab, a filter arm
and three enumerated-list entries to reimplement drag, delete, staging and undo that `Token` already
has.

One field doing two things, and `fog::Source` is where they become one rule. On a token a player
owns, `light_ft` replaces `MapInfo::vision_ft`; on anything else, it's what makes the token a source
at all. `Source { at, radius_ft: Option<f32> }` carries the `?? vision_ft` fallback, so `room.rs`
passes `token.light_ft` unchanged for a party member and a brazier alike, and `None` still means what
every source in `fog.rs` meant before. The three sweeps took `&[Pos]` and read one radius above the
loop; now they take `&[Source]` and read it inside. Nothing else in them changed.

**The gate is the design, and it's line of sight, not reach.** Without it, prepare a dungeon on a
Tuesday, put a brazier in each room, promote on Saturday, and the table sees every lit chamber on the
level through three walls, because `visible` is a flat union of its sources with no *and somebody can
see it* condition. So the condition is applied to the source list. And it's unbounded line of sight,
not the party's radius: vision at thirty feet and a brazier at forty is a brazier they can plainly
see. That was Hunter's call, and it made the feature cheaper: `in_line_of_sight` is a segment test per
eye with no radius and therefore no wall cull, where gating on `visible` would have been a second
sweep. The fallback beside it is the party's own sight, which is what carries `Lighting::Room`.

No cascade, and not as an optimisation. The gate reads the sight the party has on their own, computed
before any light joins the list, so one brazier can't switch on the next. Otherwise a chain of torches
down a corridor opens the level, the same failure one step later.
`one_light_never_switches_on_the_next` is the test; opening the gate fails it along with two others,
which is how it was checked for being vacuous.

This is the per-token vision deferred since 16a, arriving for a different reason from the one that
was declined. It's still not darkvision: a radius on a token lights for *everybody*, and a radius
that lights for its owner alone is milestone 29's per-player `visible`. The change stopped at one
field, with no `Vision` struct.

The damage box had to carry it through, and the compiler is what said so. `panel.ts` builds an
`UpdateToken` from the token it already resolved, and that command replaces the token whole, so a
field left out of the send puts the lantern out on the first hit. A required field on a struct is a
question somebody has to answer, which is `TokenView`'s argument in the other direction.

What the driver could and couldn't be made to check. `drive-fog.mjs` checks the lantern half end to
end in two browsers: the map's radius set to its five-foot minimum, the light on, and the player's
board brightens 48%. The *gated* half isn't there. A brazier of the driver's own lands in the first
free cell out from the middle of the view, `spaceFor` picks that cell by position rather than by
footprint, and a large creature standing beside it takes the click that would select it again for
cleanup. A driver that can't put back what it changed is worse than one that checks less, so it
checks less; the gate has three server tests instead.

## 40. The loaner die

Done 2026-09-03. A bag of plastic for whoever came without one, thrown by the room and landing in the
chat log. See `docs/dice.md`.

Never planned, and the first milestone to *remove* a non-goal. A player arrived on 2026-09-02 without
his dice and the table rolled for him all evening.

The non-goal it overturned was a fact, not an argument, which is why it could go. "Dice rolling (the
group uses physical dice)" described the table, and the table changed for a night. What was missing
was never a dice system; it was a spare bag. Naming it *the loaner die* did the design work that
"dice rolling" would have made impossible, as "whisper and shout" did for chat and "the scratchpad"
did for a journal.

The scope test is a physical object, and it answers the next three requests without more work. Could
a bag of plastic do this? A bag has counts, so `8d6` is in, and it's the case that most needs a
loaner, since nobody owns eight d6. A bag has no arithmetic, so modifiers are out, and that's the line
the old non-goal was really guarding: `2d6+3` is a character sheet with one field filled in. A bag
lets you throw two d20s and pick, so advantage needs no code. That's the test working best: the
obvious next feature is already answered with nothing to build.

It's one `ClientMsg` variant and one `bool`, because a roll is a line of chat. `Roll` produces an
ordinary `ChatLine` and emits the existing `Event::Said`, so there's no new `ServerMsg`, no new
`Event`, no new visibility rule, nothing on disk, nothing on the undo ring, and no arm in `persists`
or the `spoken` match (both key on `Event`, and there isn't a new one). `party_to`, `chat_for`, the
cap, the dock badge and the toast were all reused unchanged. That's milestone 33's lesson again: the
cheap version of a feature decides early to be an existing thing rather than a new one.

The estimate missed the fourth copy of the protocol tag. `.claude/CLAUDE.md` said the tag lives in
three places (the Rust enum, `protocol-tags.json`, and the TypeScript union), and there's a fourth:
`KNOWN_CLIENT_TAGS` in `protocol.rs`, which is what the fixture is actually compared against. Adding
the variant to `client_tag` compiles, and the suite still fails with a message that reads as if the
fixture were wrong. The summary in CLAUDE.md was what was wrong, and it now says four.

The private roll is the part that beats plastic, and it cost nothing. `to: ChatTo` was going to be on
the command anyway, so a whispered roll needed no code, and the client needed no second picker,
because the die throws to whichever destination chip is already selected. The sticky destination
`docs/chat.md` argues for turned out to matter for a feature written two milestones later.

**The DM's roll to themselves shipped unreachable, and that's the miss worth recording.** The room
allowed `(Dm, ChatTo::Dm)` from the first commit, and the DM's screen had no way to send it:
`destinations` gives them `[table, ...roster]` and no `dm` chip, because `Say` there is refused. The
server test passed the whole time because it drives `RoomState` directly. A server test can't see a
missing button, and putting the only assertion there was the mistake. Hunter found it by asking where
the control was. The general form is one `.claude/CLAUDE.md` already half-states: a permission test
proves the room *allows* something, and only a driver proves anybody can *do* it.

The fix wasn't the obvious one either. A `dm` chip in the DM's list would select a destination the
text box can't send to, since the chips are shared: a panel half-dead in one mode, which is what the
rail rules argue against. So the control is a toggle on the die row. Privacy is a property of the
*throw*, not of the conversation, and the driver selects `table` first to prove the toggle overrides
the chip. Looking at it also caught `DM → DM` in the log, which is accurate and reads badly; it says
`DM → hidden` now.

The one divergence is the DM rolling to themselves, and it's the opposite of `Say`. Chat refuses it
because a note to self is the scratchpad's job; a die allows it because a monster's save has nowhere
else to go. `party_to` needed no change: the DM matches both halves of its `Dm` arm and gets exactly
one copy. The test covers *both* directions, because widening one command must not also widen the
other through the rule they share.

No new dependency, which was luck worth checking for. `uuid` was already a dependency with `v4`
enabled, which is sixteen bytes of OS entropy per call, so `rand` was never needed. Instead there are
fifteen lines of rejection sampling, because `byte % sides` biases low faces and 256 isn't a multiple
of 100. The habit that found it was reading `Cargo.toml` before proposing an addition rather than
after.

**The randomness test shipped broken, and how it broke is the lesson.** The bounds check is easy and
nearly worthless alone (a range check passes against a function that always returns 1), so the
assertion that matters is that *every face is reachable*, and with no seedable RNG its only defence
is a large sample. It claimed 4,000 throws per face and was measuring seventeen. A test client's
outbound mailbox is 16 deep, the room drops a client whose mailbox fills, and from then on `apply`
finds no sender and logs nothing. Undrained, the loop stopped counting. It failed about one run in
six and looked exactly like a biased RNG, which is what made it expensive: the symptom pointed at the
code under test rather than at the test setup. The fix is a `drain` inside the loop, and the guard is
that the sample size is now asserted rather than assumed. A test whose margin is its only defence has
to prove the margin exists. More generally: a test that fills a mailbox is measuring something other
than what it says.

What the driver could and couldn't check. It checks the whole feature in three browsers: the row fits
the dock, a shouted roll reaches all three, a whispered one reaches two and leaves the third's count
unchanged, and the room wrote the sentence. One trap in it: `\d` inside the template literal that
carries JS to the browser isn't a recognised escape and arrives as a plain `d`, so the pattern still
compiles, still runs, and silently matches nothing. Character classes like `[0-9]` can't be broken
that way. The dice counts in that file are also *differences* rather than absolute numbers, for the
same reason it already used per-run text: the room is memory that outlives a run.

## 41. The room's music

Done 2026-09-06. One looping track the DM picks, playing on every screen that turned it on. See
`docs/sound.md`.

**The second milestone to take something off the non-goal list, and it went the way 40 did.**
"Audio" was on that list by name with no argument attached, and like "dice rolling" it was a
*category* broad enough that nothing could be designed against it until it was renamed to what was
actually wanted. Once the request became "one background track under the scene" rather than "audio",
the design was the backdrop's and the question was settled. The general form: a non-goal that names
a category rather than a behaviour can't be reasoned about, only obeyed, and the first useful step is
finding out which behaviour was meant. `docs/chat.md` had already said so: sound was *"not argued
against — simply not built, and worth an argument before it is"*. So this was a gap the project had
written down, not a refusal being overturned.

The feature is `SetBackdrop` copied, and the one line that differs is the one worth reading. Same
`Option<String>`, same `require_dm`, same `MAX_URL_LEN`, same unfiltered `message_for` arm, same place
on `RoomView`. The difference: `audio` isn't on `Saved`, because `audio.src = url` isn't idempotent
the way `drawImage` is. A backdrop survives being re-adopted on every `Restored`; reassigning an audio
source restarts the file from the beginning. On the ring, the DM undoing a wall trace would have
restarted the boss theme on seven machines mid-fight.

That gave a cheaper version of a rule the project had paid for twice. The scratchpad and a player's
colour each need *two* lines to stay off the undo ring (a `None` in `undid` and an exemption in the
`Undo` arm of `apply`) because they're persisted state somebody else wrote. Music needed neither:
`adopt` assigns only `Saved` fields, so a restore can't reach a field that isn't on one. **The general
rule, now three for three: the cheapest way to keep something off the ring is to keep it off the
disk**, and the two questions are the same question. `an_undo_does_not_change_the_music` and
`the_music_is_not_in_the_save_file` are the pair that enforce it, and the second is the one that fails
loudly the day somebody adds the field to `store.rs` for consistency.

Four things cost more than the state model, and one cost nothing.

- The format gate was the only new server code, and it's where `Library` stopped being only for
  images. "What may a library hold" had been a const asked in three places (the listing, the
  stem-strip in `filename`, and `image_format`'s magic bytes), none of which knew which library it was
  serving. It's now `library::Formats` passed through, a table rather than a boolean, and
  `Library::formats()` is one *grouped* arm. That grouping guarantees a fourth library was added
  rather than the other three changed, and a test says so. The test worth keeping is
  `a_riff_container_is_a_webp_here_and_a_wav_there`: the same twelve leading bytes are an image in one
  library and audio in another, which is only unambiguous because each checks against its own table.
- `.m4a` was refused, and not because of cost. An MP4 `ftyp` brand doesn't say whether there's a
  *video* track beside the audio. `M4A ` is audio-only, but ordinary AAC files carry `mp42` or `isom`,
  which is what a film carries. Accepting any `ftyp` lets a film into the music library, where it
  plays its soundtrack and looks like a bug; accepting only `M4A ` refuses files that are fine.
  Re-exporting is the way around it. The MP3 check is also the loosest in the codebase (eleven sync
  bits), and the code says so.
- Autoplay is the part no architecture fixes, and it conflicts with a decision made in milestone 27.
  A browser refuses to start audio that no user gesture asked for, and a dropped socket reloads the
  page, so every reconnect uses up whatever gesture that page had. On home broadband that's routine,
  not an edge case. The answer is to attempt playback and highlight the button when it's refused.
  Never fail silently: silence with nothing on screen to explain it can't be told apart from the DM
  not having put music on. Chrome grants autoplay based on engagement history, which makes this
  intermittent and hard to reproduce; the highlighted button is the part that's always correct.
- WAV is supported for a reason unrelated to audio quality. It's the only audio format this repo can
  *generate*, so `gen-assets.mjs` writes a three-second drone and `tracks/` isn't empty on a fresh
  clone. It's also the only one a plain Chromium build can decode (`cdp.mjs`'s browser list includes
  `/usr/bin/chromium`, which ships without the MP3 codec), so a driver whose test file was an MP3
  would fail on the format rather than on anything this project wrote.
- The client cost nothing it wasn't already paying. `sound.ts` is one module, with
  `Stage.reloadBackdrop`'s `if (url === playing) return;` copied into it: an optimisation there and
  required here. Volume and on/off are in `localStorage` for the same reason as the initiative fold,
  and that's correct, not a shortcut: everyone at this table balances it against Discord voice at
  their own level, so a room-wide volume would be wrong for six of the seven. It's the one thing this
  has over a music bot, which was its real competitor.

Two counts to check against, since both are easy to get one short. A protocol tag is six copies once
`protocol-tags.json` and the client's `Record` are counted with the four in Rust, and the Rust pair
that *doesn't* stop the crate compiling is the one that fails the suite with a message blaming the
fixture. And `docs/` was then fourteen files. The two lists naming them had already drifted, both
still saying twelve and both missing `dice.md` from milestone 40.

One flaw, recorded rather than fixed. `tools/audit-uploads.mjs` works out "in use" from the save
file, so a `track-` copy in `uploads/` is *always* listed as unreferenced, because `audio` isn't on
`Saved` and can never be found there. Following its `rm` while the room is playing gives a 404 on the
next loop. Fixing it properly means the audit reading live room state, which is exactly the automatic
cleanup that script exists to refuse.

## 42. Duplicate and fit board

Done 2026-09-09. Two small things found by playing rather than planned, built together because
neither touches Rust: milestone 18, 26 and 36's pattern a fourth time. See *Tokens* in
`docs/tokens.md` and *The bottom-right corner* in `docs/frontend.md`.

Duplicate is `create_token` with the fields read from a token instead of from the form. What made it
a client-only change is that the server already assigns the id and already snaps the position. A
`DuplicateToken` command would have cost six protocol edits and four enumerated arms to reach code
that was already correct. The token panel had kept its fields after a create since milestone 9 (six
goblins is six clicks), so what was missing was never the *form* state. It was the art, the total,
the light, the owner and the marks of a creature built earlier in the evening, which have to be read
from a token.

Two decisions worth keeping. It searches outward from the original rather than from the middle of the
view, the one way it differs from a create: a copy is a second of something and belongs beside the
first. `spaceFor` already did the ring search, so that was a changed argument rather than new code.
And `staged_pos` isn't on `CreateToken`, so a copy arrives unplanned. That's correct, not a gap: a
plan is a cell, and two creatures don't want the same one.

Fit board is the first control added to `#corner` since the spells link, and the link's own comment
turned out to be the argument for it: it arms nothing, so it owes the rail no `stop`, and it shows no
count, so it doesn't need a dock tab. Three things came out of building it.

It frames the play area, while a map load still frames the whole image. Those look like the same
question and aren't: a load is followed by calibrating, where the margin is part of what the DM is
looking at, while fit is used mid-fight by somebody who has lost the board. `fitToMap` became a
wrapper over `fitToRect` rather than gaining a branch.

**The minimum on `fitToRect`'s sides matters.** `playRect` clips to the image and returns a
zero-width rectangle for a saved play area that no longer overlaps it (a map replaced with a smaller
image), and dividing by that gives an infinite zoom and a camera at `NaN`: a board that doesn't come
back without a refresh, from the control whose whole job is getting the board back.

`Home` is the third global key in this client and the second to need `typingIn`, which was exported
from `undo.ts` rather than copied. Escape is bound four times and gets away without the guard only
because the element-scoped handlers beside it call `stopPropagation`. `Home` is start-of-line in the
chat box, and a board that jumped while a whisper was half typed is the one way this control could be
actively annoying.

`tools/drive-fit.mjs` opens two browsers for one reason: this control is for everybody, and the
failure it guards against is it being built inside the `identity.isDm` half of `onWelcome`, where
nearly every other control lives.

## 43. Token markers

Done 2026-09-09; the pips became a band and gained `dead` on 2026-09-10. Six colours and a dead mark
the DM puts on a creature, and nothing anywhere that knows what any of them means. See *Markers* in
`docs/tokens.md`.

**It's the first public field on a token, and that's what's new about it.** Every earlier asymmetry
on `Token` runs one way: `hp`, `light_ft`, `staged_pos` and `staged_only` all reach the DM and nobody
else, so `view_for` had only ever been asked to redact. This one is copied unconditionally, because a
mark nobody at the table can see isn't a mark. It's `NamesChanged` beside `FogChanged` rather than
beside `WallsChanged`, at token scale.

The server half followed milestone 39's pattern and cost almost nothing. Travelling on `CreateToken`
and `UpdateToken` meant no new command, no new event, no arm in `message_for`, no entry in
`persists`, `undid` or `moves_sight` (all three match `UpdateToken { .. }`), and `protocol-tags.json`
untouched. Undo came with the rest, without the two lines the scratchpad and a player's colour each
needed.

Two things about the bound are worth keeping. `Marker` is a fieldless serde enum, so an unknown marker
fails to deserialize and `check` needs no validity arm: the same arrangement as `ShapeKind`. And the
count bound isn't a number. `Marker::ALL` is closed at six and duplicates are refused, so "no
repeats" caps the list at six however long the array on the wire was. That satisfies `docs/net.md`'s
two-limits rule through the type rather than a constant tuned against the frame, which is the better
approach wherever it's available: a constant can drift, and this can't. *(`dead` made the set seven
the next day.)*

Four things cost more than the state model, which was one enum and one field, and all four were on
the client.

The permission check that isn't free. The hit point bar and the damage box on an initiative row don't
check who's reading them, because `view_for` nulls `hp` for a player and there's nothing to decline to
draw: invariant 4 failing safe, three times on that panel. A public field leaves no null to fail safe
on, so the row's toggles needed a real `isDm`. `valueField` was the precedent rather than a new rule,
but the general form is worth having: invariant 4's safe failure is a property of redaction, not of
the panel, and the first public field on a redacted type is where that stops being free.

The placement was wrong the first time, and only a picture showed it. The pips began as a column down
the token's right-hand edge, the one space around a token nothing else uses (the bar owns above and
the name owns below), and that was the problem: two creatures standing next to each other put one's
pips against the other's rim, and in a fight adjacent is normal. Centred above is what makes them
clearly this token's, the same argument the bar makes by being wider than a one-cell token and
legible anyway. Six pips in a column also don't fit a one-cell token at 100%; centred, they overhang
evenly.

`#initiative button` beat `.marker.is-on`, and no suite could see it. An id plus a type selector
outranks any number of classes, so the panel's shared button style won, and every swatch on a row
drew hollow whatever it was set to, which looks like the toggle being broken. `aria-pressed` was
correct throughout and the driver asserting it passed; only a computed style shows otherwise.
`#initiative button:not(.marker)` is the fix, `.map-library-pick` is the same trap one panel over, and
the lesson is that a driver asserting the DOM isn't asserting the paint. Read `getComputedStyle` when
what changed is a colour.

The token panel had to render its swatches once at startup. Every other field in that form is
initialised by the markup and only rewritten by `show`, and `show` doesn't run until something is
selected, so a fresh page offered no swatches at all. There's no markup for six generated buttons. A
small bug, and how it was found is the interesting part: by trying to take a screenshot of the
feature, which is worth doing for anything with a visual side.

The sharpest check in `tools/drive-panels.mjs` isn't the toggle but the hit: a `-3` typed on a marked
creature has to leave the marks alone, because `update_token` replaces the token and the damage box
builds a whole one. TypeScript catches the omission at the send site (the field is required rather
than optional for that reason), but the failure would have been silent, a moment later, in a
different control.

The pips lasted a day. They were legible but in the wrong category: a dot beside a creature reads as
decoration, and a band on it reads as a state. Making them bigger wouldn't have fixed that, which is
worth recording because "too small" was the obvious diagnosis and the wrong one. What shipped is a
band of arcs drawn *inside* the token's own rim. One mark takes the whole ring and more divide it
evenly, so the footprint is the same whether a creature carries one mark or seven.

The band avoids the hue collision by position. Three of the six colours sit next to rings already in
use: yellow against the gold that means *yours*, blue against the blue that means *in progress*,
purple against the violet that means *hidden*. The original argument for pips was that a pip isn't
part of the ring vocabulary at all, which is true of a dot and false of anything ring-shaped, so a
band had to solve the collision rather than inherit the answer. Inside the rim is the one place on a
token nothing else draws, and every state ring is outside it, so gold lands just outside a yellow arc
instead of competing with it. A band drawn outside the selection ring would bring the collision back,
and would also be further from the creature, which is the complaint it exists to fix. Two smaller
things followed: `HP_STACK_H` and `HP_FONT_PX` had no reader left once nothing stacked above the
numerals, and the arcs are sorted into `MARKERS` order so two creatures carrying the same marks draw
the same picture. The room stores them in the order the DM added them, and a row of pips hadn't
cared.

**`dead` is the seventh, added because the table needed it, and the boundary is more interesting
than the code.** It's one enum variant, one entry in `Marker::ALL`, an X across the portrait instead
of an arc in the band, and one attribute selector for its swatch. The rule it seems to break (*a
marker is named for its colour and nothing else*) turned out to be how the real rule looked while
every member happened to be a colour. The real rule is that nothing in Slate knows what a mark means,
and the test is mechanical: does anything *follow* from it? Nothing follows from `dead`: the creature
still moves, still holds its initiative row, still keeps its total. `Poisoned` fails that test the day
after it's added, because a condition implies that a duration, a saving throw or a subtracted number
is tracked somewhere, and none of that exists here. `Prone` and `Concentrating` get the same answer.
`drive-panels.mjs` asserts the negative half (a dead creature keeps its row and its total), because
that boundary is the feature and something should fail the day it stops holding.

Its swatch is read with `getComputedStyle`. An X rather than a disc is entirely a stylesheet
difference over identical markup, the same category as the `#initiative button` collision above and
just as invisible to `aria-pressed`. Applying that lesson up front, rather than after the fact, was
most of what it cost.

## 44. The keyboard pass

Done 2026-09-17. Delete for whatever has a selection ring, `N` for the next turn. Milestone 42's
pattern a fifth time: nothing on the wire, nothing in Rust, two drivers extended rather than a new
one. See *Tokens* and *Initiative* in `docs/tokens.md`.

Delete treats the two rings as one question, because the renderer already draws them as one. The
panel's token and the shift-click group were kept apart on purpose in milestone 25 (a group must not
feed the form, or it becomes a multi-edit form), and that separation is about *editing*. Deleting
isn't editing: the confirm names every creature and sends one ordinary `delete_token` each, so a union
costs nothing the group drag hadn't already settled. `TokenTool.remove(ids)` is all that was added;
the panel's own button became a call to it with one id. Backspace is bound beside Delete for Mac
keyboards, which is why the handler stands down while the wall editor is armed: Backspace removes a
corner there.

Two decisions that look like omissions. The confirm stays on the keyboard path even though undo can
bring a token back: undo is one step per token, and the case the key exists for is six of them. And
nothing removes a deleted id from the group. Ids are the server's UUIDs and never reused, and
`selection` is only ever read through `scene.tokens`, so a stale member is invisible, and pruning
would add a method on `InputState` for a set that already can't hit anything.

**`N` is the first unmodified letter key**, which is why it needs care. A bare letter is a letter in
every field, so `typingIn` is required, and Ctrl+N is the browser's new window, so the modifier check
runs first. It sits inside the panel's `isDm` branch beside the button it duplicates, so a player has
no binding at all rather than a refused one. No `P` for previous: what was asked for was `n`, and a
DM who overshoots has the button.

Both drivers found the same problem in themselves. `tokenIn` in `drive-select.mjs` reads the panel by
*plain-clicking the cell*, and a plain click is exactly what clears a group, so a check asking "is the
panel still on A" dissolved the group it was about to Delete, and the failure looked like the key
deleting one of two. Read the form field directly when the question is about the form; click when the
question is about the click. And the field the negative test types into has to be one that does *not*
stop propagation. The chat box does, so a letter typed there passes even with `typingIn` deleted, and
the check would have been testing the wrong guard. The token panel's name box listens only for Enter.

## Designs written before building

These were written in advance and kept as written after they were built, so a reader can compare
what was predicted with what happened. Notes in italic parentheses mark where the build went
differently. The current rules are in `docs/`.

### The right dock

Built in milestone 23; 24 added the second tab and 41 the third. `dock.ts` is the strip. The notes
were a second entry in `DockTab` and a second entry in the array `main.ts` passes to `createDock`,
which is the same cost the rail's strip puts on a panel. Everything below held. The argument for why
this isn't a generalised `createRail` is in `docs/chat.md`.

Milestones 23 and 24 share one piece of client infrastructure and should be built with it rather
than around it: **a collapsible dock on the right edge with a tab strip**, following the left rail's
pattern instead of inventing floating windows.

Settled by milestone 26: the initiative panel stays a fixed panel on that edge and the dock sits
*beneath* it, rather than initiative becoming a third tab here. The dock is for reading and replying;
initiative is for glancing at, and the rule below about not auto-opening is the same reason its head
row has to survive being folded.

Everybody sees the same two tabs, Chat and Notes. That's the first time both sides of the application
have had the same furniture, and it follows from neither feature being the DM's. The left rail's two
rules are satisfied without effort, since neither panel arms a tool, and the wall editor is on the
opposite edge, so nothing here can hide an armed left mouse button.

An unread count sits on a collapsed tab, and an arriving message also shows for a few seconds beside
the dock. A whisper nobody notices is the main way this feature fails a table where half the players
aren't technical, and a badge in a corner assumes they're already looking at it. It doesn't auto-open
the dock: expanding a panel reflows the layout under whoever is mid-drag, which is what the ping
arrow and the initiative panel each avoided for the same reason. One box. *(The dock's panels later
stacked instead of opening one at a time; see milestone 24.)*

### Cursors

Built as milestone 28 on 2026-08-19; see `docs/presence.md`. This section was left without a number
because milestone 19 might have made it unnecessary, and that couldn't be known before playing a
session with pings in it. After playing, the answer was that it hadn't: a ping is a deliberate
gesture, and cursors give background presence.

The text below was written before ping existed. Notes mark three places it stopped being true: the
dependency on 27d, the fog gate (which milestone 28 moved onto the DM's pointer alone; read 28's
entry before arguing from the third bullet), and this section's reason for waiting.

Everyone's pointer drawn on everyone's board. What was already settled:

- It's `Ping`'s shape but more ephemeral: a throttled `CursorMoved` carrying a `Pos`, no persistence,
  absent from the snapshot, never dirty. Nothing has to be built first. *(No longer true: it depends
  on 27d, because a cursor is a colour with a name beside it, and the roster-position palette is what
  player-picked colours replace.)*
- It would be **the busiest thing in the room by an order of magnitude.** Drag frames exist only while
  a token is moving; cursor frames exist whenever anybody's hand is on the mouse. Seven clients at
  15Hz is still nothing at this scale, but this is the first feature where that has to be said rather
  than assumed. Send only on movement, and decay after a few seconds of stillness.
- The fog question isn't settled the way ping's is, and probably lands the other way. A ping is a
  deliberate gesture and a cursor isn't, so "the DM's pointer drifted across an unexplored room" is a
  different question from "the DM pointed at it". Gate on `known`, which is the answer ping was able
  to refuse. *(Half right, and the half it got wrong is whose pointer. It gates on `known` only for
  the DM's pointer. This bullet names the DM's drifting hand and then generalises to everybody's,
  which it never justified. A player can point only at what their own client drew.)*
- Seven pointers moving over a board that already has tokens, nameplates, hit point bars, rulers,
  trails, shapes and fog is a real cost against a real benefit: background presence, and knowing
  where somebody is looking without them having to gesture. That trade can only be judged in a live
  session, which is the other reason this waits. *(It waited, and the sessions came down on the side
  of the benefit, which is what scheduled it. The cost is still real and is the thing to watch: if the
  board is unreadable with seven pointers on it, the decay time is the setting to change.)*

### Multi-room

Built as milestone 33; see *Room actor* in `.claude/CLAUDE.md` and `docs/rooms.md`. A Halloween
one-shot was the second room this section was waiting for.

This is what was written in advance. Three of the six items landed as designed and three were
overturned; the corrections are marked inline.

**Don't build the screen first.** It's the cheap half of a feature whose expensive half is a room
registry, and CLAUDE.md is explicit that the registry doesn't get built before there's a second room.
A campaign picker in front of one hardcoded room is scaffolding for a feature that doesn't exist,
which the working agreement forbids. *(Held, and it's why this waited at all. The screen took an
afternoon; the part worth arguing about was where the save files go.)*

What it costs, so its size is known rather than guessed:

- `RwLock<HashMap<RoomId, RoomHandle>>` replacing `AppState.room`, touched on connect and disconnect
  only and never on a token move. This is the one piece CLAUDE.md has already designed; everything
  above it in the architecture was built to allow this, and none of it is waiting for it.
  *(Overturned, and cheaper. `ROOMS` is a const, so the rooms exist before the first socket opens and
  the map is built once and only read: a plain `Arc<HashMap<..>>` with no lock. A lock guards a table
  that changes. The `RwLock` is what a room the DM could create at runtime would need, and that isn't
  built. The rest of the item held: the connect path was the only thing that changed, and nothing on
  the hot path knows rooms are plural.)*
- `SLATE_STATE` becomes a directory, where today it's the single path `Store::new` takes. One save
  file per room, and the Pi's backup procedure in `deploy/pi/README.md` changes with it.
  *(Overturned. `SLATE_STATE` still names the primary room's file, and every other room's is a
  sibling `<id>.json`, because that needs no migration: the Pi's env file is unchanged, the live
  campaign save keeps working, and the backup that greps the tar for `slate-state.json` keeps
  passing. `store.rs` didn't change at all. The cost is that the rule is a sentence rather than a
  structure: `save_path` carries it and two tests pin it. A directory is a migration to do on purpose
  if there are ever enough rooms to want one.)*
- A `dm_secret` per room, rather than one for the process. A DM running two campaigns wants two links,
  and a link that opens every room is worse than one that opens one. *(Overturned. One secret for the
  process. This item's case is a DM running campaigns for different groups; this is one DM, one group,
  one tunnel, and two links to keep straight is worse than one. It's the right answer if a link ever
  goes to somebody who shouldn't reach the other campaign, and not before.)*
- A room id in the WebSocket URL, and in `localStorage` beside `player_id`. The second is the fiddly
  part: `player_id` is currently one value for one room, and a player in two campaigns has two slugs.
  *(Held, both parts, and it was right to call it fiddly, though the difficulty was on the client and
  not in the key: `boot` had to be split so the room is settled before `connect`. The key itself is
  `slate.player_id.<roomId>` and took four lines. Nothing would have leaked with one key, since
  `hello` refuses a slug from another room's roster; it would just have sent a switching player back
  to the picker every time.)*
- `maps/`, `portraits/` and the uploads directory stay shared. It's the same DM with the same art, and
  splitting them gains nothing and costs a copy of every goblin. *(Held, with one consequence:
  `audit-uploads.mjs` had to start reading every room's save. With shared libraries and separate
  boards, a portrait on a one-shot token is referenced by a file the campaign's save has never heard
  of, and reading one room alone printed an `rm` for every other room's art.)*

**The roster becoming per-room is the actual point.** A second campaign is a different cast, and every
other item above serves that one. If a request arrives that a smaller change satisfies (a second
roster on one room, say), that's the smaller change, and this section isn't the answer to it.

*(Half wrong, and the smaller change was tried first. The request was a Halloween one-shot, and it
did propose exactly the smaller change this paragraph invites: two rosters on one room. That doesn't
work, and the reason is what this paragraph got backwards. The roster is the cast list. Swapping it
leaves `tokens`, `map`, `staged`, `initiative`, `walls`, `revealed`, `overrides` and `shapes` exactly
where they were, and those are the fields the one-shot needed cleared. The board is what makes a
second room work; the roster is what makes it pleasant. The paragraph's instinct was still right where
it mattered: check for the smaller change before building this. It was checked, and it lost on the
merits.)*

### Drawings

Built, both halves: see *Drawings* in `docs/drawings.md` and *Drawings on ground the party cannot
see* in `docs/fog.md`.

The anchored half shipped in milestone 14. `shapes_for` withholds a shape whose anchor the recipient
can't see, and since 16a that question includes line of sight with no extra line. An anchored shape's
visibility follows its anchor token rather than its own footprint.

The unanchored half shipped in 16b, and it gates on `known` rather than `visible`. A shape is painted
on the floor rather than standing on it, so it belongs with the terrain: a player's own marker stays
after they leave the room, and nothing on the board flickers as the party moves.

### Fog of war

Built, both halves; see `docs/fog.md` for what shipped and why. What follows is the design as written
before either half existed, kept to show how much of it held. Where it didn't, milestone 16 says so.

The constraints this section was written to protect all held:

- Per-client `mpsc` instead of `broadcast`
- `Event` separate from `ServerMsg`
- `snapshot_for(client)` instead of `snapshot()`
- Grid-unit token positions, which make the token-to-cell lookup free
- `coveredCells`, which already answers "which cells does this shape occupy" for the drawing layer:
  the same question a shape's fog visibility asks, on the client side
- The walls themselves, which are built (see `docs/walls.md`). `RoomState.walls` is a `Vec<Wall>` of
  segments in image pixels, doors carry their open state, and none of it reaches a player. What's
  missing is anything that reads them.

Cell-based visibility over the grid. This said *symmetric shadowcasting*, the one line here that
didn't survive; see milestone 16a and *Raycasting, not shadowcasting* in `docs/fog.md`. Everything the
algorithm was chosen to deliver held; the algorithm didn't.

**Fog is party-shared, not per-player.** One `revealed` bitset (explored terrain, persistent) and one
`visible` bitset (current line of sight), each the union over every player-owned token. Five people
narrating to each other on Discord get nothing out of per-player fog but confusion and five times the
state. Terrain gates on `revealed`; tokens gate on `visible`. Vision comes from tokens a player
*owns*, so handing a token over grants vision with no extra rule. *(Terrain now gates on `known`,
which is `revealed` widened by one cell; see milestone 16.)*

*(Still what ships, and still the default, but no longer the only setting designed. Milestone 29 puts
`visible` behind a switch and leaves `revealed` alone, which takes this paragraph's confusion argument
seriously rather than overruling it: the explored map stays the party's map. Read 29 before this
paragraph, not instead of it; the objection above is why it's a switch.)*

Tokens don't block line of sight; only walls do. The play-area boundary is an implicit wall, so
vision doesn't spill into the void off the edge of the map. Nothing in the wall editor produces that
boundary and nothing should, since it's already on `MapInfo`. *(Built, and it needed a second half
the design didn't foresee: a map with no play area still has to bound what the party can explore, or
a token dragged to cell one million puts a cell there, and the rectangle packing it alongside the
dungeon is the whole map's worth of characters on every send.)*

Players infer the geometry from the edges of the fog, which is why walls stay out of their snapshot
even though fog is the only place they see the walls' effect.

Walls block sight and never movement. The decision and its four reasons are in `docs/fog.md`, under
*What milestone 16 did not do*. If the DM finds themselves saying "there is a wall there" often, the
answer is a hint on their own screen: a movement ruler drawn in a warning colour when a drag crosses
a wall or a shut door. No command, no event, no refusal, and it can't leak, because a player has no
walls for their client to test against. *(Built in milestone 17, and all of that held. What it didn't
predict is how good a test it makes. Proving something can't leak is normally the hard part, and here
it's one drag photographed from two connections: amber on the DM's screen, blue on the player's, and
no identity check anywhere in the code that produces the difference.)*

The same hint on the player's screen, workshopped 2026-08-11, is still unscheduled and is in
`ROADMAP.md`.

Vision range is one DM-set radius per map, stored in feet on `MapInfo` and converted to cells where
it's used. This asked for a generous `Default`, because the container-level `#[serde(default)]` means
a save written before the field existed would load it as zero and every restored room would go pitch
black. *(`fog: bool` beside it handles that instead, and better: a switch defaulting to off can't
darken an old save whatever the radius loads as, which lets the radius default to a playable 60 feet
rather than a defensive number. Both are remembered per URL in `Calibration`, which milestone 31
wrapped in `Prepared`.)*

Visibility is recomputed in `apply`, never in the visibility filter. The filter runs against `&self`
while the client map is borrowed, so it can't mutate the bitsets, and it's better kept pure anyway.
*(It runs in `refresh_fog`, called right after `apply` for commands that `moves_sight` names.)*
Recompute on drop, not on drag frames: the raycast is cheap enough at 30 Hz, but sending a bitset
thirty times a second isn't. A bitset doesn't fit the frame cap as a JSON array of per-cell values
either, so pack it into a single string field. That's still one readable frame in devtools, which is
what the wire protocol rule actually protects.

Recalibrating the grid invalidates the bitsets, which are in grid space. This is where fog differs
from the walls, which a recalibration leaves alone because they're in image pixels. Loading a new map
clears them outright, and promoting a staged map is loading a new map, so it clears them too. That's
`sweep_board`, which the walls and drawings already go through.

### 16b: the DM's manual override

Built; see `docs/fog.md`. What this section asked for held. The two questions it left open are
answered under milestone 16: `ForceRevealed` became two brushes, and `ForceHidden` does hide a
creature the party otherwise has line of sight on.

The rest held as written:

- Independent of line of sight, and a state per cell rather than a write into `revealed`, because a
  manual hide that just clears `revealed` is undone the next time a token has line of sight on that
  cell.
- The reveal tool is a flood fill bounded by walls, and it previews before it commits: otherwise one
  gap in a traced room reveals the whole dungeon in a single click, and there's no undo. *(Undo
  arrived in milestone 22.)*
- It lands as a different answer from `in_sight` rather than a fourth question. `unseen_by_table` is
  the function every filter goes through, and it stayed one line.

Two things the design didn't foresee, both covered under milestone 16: the fill runs on the *client*
and the command carries cells rather than a seed, and the override travels like the walls rather than
like the fog. Those two turned out to be what the feature is about.

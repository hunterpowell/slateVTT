# Drawings and distance

Spell areas, sketches, the coverage rule, the movement ruler, and the ping: everything anyone puts
on the board that isn't a token or a wall.

Read this before touching `shapes.ts`, `drawtool.ts`, `ruler.ts`, `pings.ts`, or
`Shape`/`ShapeKind`/`Sketch`/`Ping` on the server. The geometry here is one function doing two
jobs, distance and coverage are counted differently on purpose, and the ping is the one thing in
this project that no visibility filter touches.

## Drawings

Spell areas and measuring shapes: line, circle, cone, rectangle. **Anyone may draw.** It's the only
thing in the room a player can add, and the only thing they can delete. `by: Owner` records who
drew it, and `can_erase` allows the DM or that person.

**All four kinds are one struct: a kind and two points.** A line is its two ends, a rectangle its
opposite corners, a circle its centre and a point on the rim, a cone its apex and its tip. So
there's one hit test and one coverage rule rather than four of each. `to` is an *offset* from the
origin rather than a second position, which is what makes an anchored shape move with its token
instead of stretching towards a fixed cell.

Geometry is in grid units, like a token and unlike `play_area`. A shape is measured in cells, so
recalibrating leaves a 20 ft circle 20 ft across. Walls are the other case (image pixels; see
`docs/walls.md`).

`Origin` is an enum rather than a position beside an `Option<TokenId>`, for the same reason
`Identity` is one: an anchored shape carrying a position nothing reads has a field that can go
stale, and the two could disagree. `Shape::anchor()` is the only thing that asks which it is.

**There is no `ShapeView`.** The extra layer `TokenView` provides doesn't exist here and shouldn't
be added. Fog gates a shape *whole* (all or nothing, on whether any cell it covers has been
explored), so the filtering happens in `message_for` dropping it, and a view type would have no
field to redact. That guess held when 16b built the filter.

### Sketches, and what "ephemeral" means

A shape being swept out is on the wire but not in the room. `ClientMsg::Sketch` carries `drawing`,
as `MoveToken` carries `dragging`: frames are throttled client-side, relayed to everyone *except*
the sweeper (who is drawing it from their own pointer and would see it rubber-band), and never
written to disk. `drawing: false` releases it.

**Whether a release keeps anything is decided by the client alone.** The measure tool stops at the
release; the three area tools follow it with `AddShape`. The server accepts all four kinds, stores
whatever it's told to, and never learns which tool was in use, by the same rule that keeps it from
learning the DM is previewing. A "keep this line" toggle would be a change to `drawtool.ts` and
nothing else.

**The measure tool draws in the sweeper's own colour, and the three area tools use the picked
swatch.** That's the third thing the chosen tool decides, besides what gets swept and whether the
release keeps anything, and it splits the same way as the other two. A line that vanishes when you
let go is a *gesture*, so what watchers want to know is who is measuring, the same question
`Pinged` carries an `Owner` to answer. A shape that stays on the board is an object, not a person,
and `PLAYER_HUES` isn't a set of colours for spell areas: six of them mean six people, and a
fireball isn't anyone.

Nothing on the wire changed for it. `Sketch` is keyed by `ClientId` rather than `Owner`, so a
recipient can't work out whose line it is the way it does for a ping's colour; the colour has to
travel, and it already did. What changed is the one line that reads `drawTool.color` at
pointerdown, and `colourOf` gained a reader. The alpha is `SHAPE_ALPHA`, written out because
`colourOf` answers in `#rrggbb` and `shape_fields` on the server accepts only the eight-digit form.

The swatch row goes **inert while the measure tool is armed** rather than hidden. A highlighted
swatch that isn't what would be drawn is as misleading as a live tab on a dead panel, and the pick
is kept and comes back with the next area tool. The DM's own hue is `DM_HUE`, which is exactly the
palette's chalk, so the DM's measure line looks as it always did and nothing about this change is
visible on the DM's screen.

**A stranded sketch is removed on disconnect, not on a timeout.** The room is told when a socket
closes, so `RoomCmd::Disconnected` dispatches `SketchEnded` unconditionally. An id nobody is
drawing is a no-op on arrival, and that's cheaper than keeping "is this client sketching" as
state. This is the one place the movement ruler can't copy: nothing announces that a drag stopped,
so the ruler has to guess with `STALE_MS`.

### What one event has to cover

`Event::ShapesChanged` has no payload and is built per recipient, like `InitiativeChanged`. It
covers adding, erasing and clearing, and three changes that come from elsewhere:

- **Deleting a token deletes what's anchored to it**, like its initiative row.
- **Hiding or revealing a token rebuilds the list**, but only if something is actually anchored to
  it. An unconditional rebuild would tell the table that *something happened* every time the DM
  hid anything, which is the very thing being withheld. The initiative panel uses the same check.
- **A load into the live slot sweeps the board, and a recalibration must not.** It's the same
  `loading` flag that tells those two apart for the calibration table and the staged plans. A
  promote counts as a load.

`shapes_for` withholds a shape whose anchor the recipient can't see, through `unseen_by_table`, so
all three reasons apply. **This is fog's rule arriving early, and it had to**: the roadmap filed
anchor visibility under fog, but `hidden` already existed, and an aura on a monster the DM took off
the board shows that monster's position in colour. It fails closed: an anchor that isn't in the
room at all is withheld too.

**An *unanchored* shape asks a different question**, and that check is milestone 16b's: it's
withheld unless one of the cells it covers is in `known`, the ground the party has explored. Not
what they can see right now: a shape is painted on the floor rather than standing on it, so it's
gated on `known` with the terrain rather than on `visible` with the creatures. A player's marker
stays after they leave the room, and the board doesn't flicker as the party moves. See *Drawings on
ground the party cannot see* in `docs/fog.md`, which also covers why the coverage test exists twice
in two languages, and why the two copies only have to agree loosely.

Refusals are worded the same on purpose. Anchoring to a token you can't see is refused in the same
words as one that doesn't exist, and erasing a shape you were never sent reads as "already gone"
rather than "not yours". Otherwise, trying every id would map out the DM's monsters.

### Shapes belong to the board

There are no staged shapes, and the draw tool is inert while previewing. The staged map has nothing
to draw on, so unlike tokens nothing here forks, and none of these four commands has a `staged`
flag.

### On screen

Shapes are drawn over the tokens. A spell area is on screen because someone is asking about it
(where it reaches, and who is caught in it), so it has to show across the creatures inside it
rather than disappear behind the two standing on top of it. The fill is translucent enough that a
token under it is still recognisable, and names and hit points are drawn later still, in screen
space, so nothing a shape covers becomes unreadable. `shapeOrigin` plays the role here that
`shownPos` plays for tokens.

**An area shape tints every cell whose centre it reaches, give or take `COVERAGE_SLACK`.** The
slack enlarges the *shape*, rather than testing a ring of sample points around the cell. Sampling
is generous only in the directions that get sampled, and a cone's edges run along diagonals that a
handful of offsets never covers. Zero is the strict reading, and about 0.71 (half a diagonal) means
"touches any corner". The constant sits near the strict end, and it's the one number here worth
tuning at the table. So the tint reaches a little past the drawn outline, intentionally: the
outline is the shape, and the tint is which squares it's counted against.

The cone test projects a point onto the wedge's own axis (a dot and a cross product against the
unit axis) rather than comparing angles. That avoids a westward cone tripping over the ±π wrap,
lets the slack be a distance in cells rather than an angle that would mean different things at the
apex and the tip, and puts the **apex inside the shape**, which an arc-cosine can't: there's no
angle from a point to itself, so a cone used to leave its own square untinted.

This is where distance and coverage disagree, on purpose. *Distance* counts a diagonal step in
cells, under which "everything within 20 ft" is a square. A circle here is a circle, and the cells
it covers form a round blob. They disagree at the corners because they answer different questions
(how far something walked, and what a shape covers), and the tint is what makes the second
countable. A shape's own label is its actual length rounded to five feet, for the same reason.

The diagonal setting doesn't affect this. It changes what a *step* costs, which is the distance
side of the disagreement. A length and a light radius are geometry and stay Euclidean whichever way
the room counts. A DM who sets 5-10-5 to get closer to true distance hasn't asked for their
fireballs to change shape.

The coverage rule and the hit test are one function, `containsPoint`. That's what makes
click-to-erase nearly free: the tint has to ask it about every cell centre anyway.

A cone is as wide as it is long (`atan(0.5)`), which is a statement about a wedge, not about any
particular breath weapon. Its far edge is an arc, because the far edge of a wedge is every point the
same distance from the apex, for the same reason a circle isn't a square.

### Both ends snap

**A sweep is snapped at both ends, and the two ends snap to different things**: `snapOrigin` and
`snapExtent`. They were the first snapping rules on the client.

**The origin goes to the nearest point on the half-cell lattice.** Cell centres, the corners between
them and the middle of every cell edge are one set rather than three. Together they're every
half-integer point, so the rule is rounding to the nearest half, with no search over candidate sets.
Which of the three a sweep lands on depends on where the hand was. A centre is where a circle on
someone's square goes, a corner is where the table actually places a fireball, and an edge midpoint
comes for free. This replaced snapping to cell centres alone, under which a rectangle couldn't be
drawn aligned to the squares it covers at all: its outline ran through the middle of four rows, and
only the tint was correct.

**The extent goes to whole cells, so what's drawn matches what's read**, and the split is by what a
kind's label says. A rectangle reads as two numbers and a line is dragged at a square, so both snap
*per axis*; from an origin on the lattice, that puts the far point on the lattice too, corner to
corner and centre to centre. A circle and a cone read as one number that is a *length*, and per-axis
snapping doesn't make a length whole: four cells across and four up is a radius of 5.66 cells, drawn
as 28 ft under a label reading 30. So those two snap the **magnitude** and leave the direction free.
A cone points wherever it's pointed, and the rim of a 20 ft circle is 20 ft away in every direction.
`feetOf`'s rounding is still there and still needed, for an Alt sweep and for an anchored one whose
origin was set by something else, but it no longer decides whether a spell area is the size the DM
said out loud.

**Alt sweeps freely, and it's read on each move rather than fixed at pointerdown** with the tool and
the colour. That's what keeps it from colliding with the other thing Alt means on the way down:
holding it to sweep straight through a creature mustn't also discard the origin snap. The origin has
no way off the lattice at all. Nobody has wanted that end of a sweep off the grid, and it snapped
before this was a feature.

**A sweep that snapped to nothing keeps nothing.** The release frame still goes out, because five
other screens were shown the sketch, but a zero extent isn't committed: a shape with no size is one
nobody can see or find to erase. Rounding is what makes that possible; drawn freehand, a sweep past
the click slop always had *some* extent.

**"Nothing" is defined per kind, in `hasExtent`.** A circle and a cone snap their magnitude, so they
reach nothing only when both axes are zero. A rectangle snaps per axis, so a drag slightly off
horizontal keeps its three cells of width and rounds its height to zero. What that commits has no
*area*, and it fails the rule above in the half that's easy to miss: it's visible (from a
cell-centre origin it tints a whole row) but not clickable, because `containsPoint` at zero slack
matches a flat rectangle only along the exact line through it. From a corner origin it covers no
cell centres at all and draws as a hairline. Either way, "clear all" was the only way to remove it,
which is why a rectangle needs both axes and the other three need one.

Neither rule is the token rule written twice. `snap_to_cell` depends on how wide a token is (an even
width settles on the corner where four cells meet), and it lives on the server as the only copy of
itself. A shape has no width to settle by, so it's offered every point on the lattice and the hand
chooses. The two lattices coincide, which is what lets an anchored shape skip all of this and still
sit on one of these points. And it *has* to be decided on the client. A token's drop is echoed back
with its settled position, so the client can afford never to snap, but a sweep is relayed and never
echoed, and an origin settled on the server would arrive after five people had watched the circle
being drawn somewhere else. An anchored shape sits on its token, which the server has already
settled: an aura on a 2×2 creature belongs on the creature, not in one of the four cells under it.

That snap is also why a sweep and a click are told apart by **pointer travel in screen pixels**
rather than by the offset still being zero. From a snapped origin, the offset is up to half a cell
the moment the hand twitches, and the old test would have turned every erase into a kept circle.
Snapping the far end doesn't make the old test usable again: the offset now rounds to zero over a
whole cell of travel, which is the same mistake in the other direction.

**A sweep starting on a token anchors to it**, with Alt to sweep straight through. It needs no extra
UI, and it's where most auras start. The tool and colour are fixed at pointerdown, like a drag's
`staged` flag: a sweep can't change shape halfway, and it has to survive the tool being put away
with Escape mid-sweep, or the release frame never goes out and the line is left on five screens.

## Distance

A grid cell is five feet, and distance is counted in cells crossed. **What a diagonal step costs is
the DM's setting, one for the room**: `Diagonals::Equal` charges one cell for every step, and
`Alternating` charges double for every second diagonal. Both keep every reading a multiple of five,
which is the property worth protecting, because it's what the table says out loud. This section
used to say "straight-line", which would make a one-cell diagonal 7 ft, and later said `Equal` was
the rule rather than the default. Each rewording admitted the same thing: how a table counts is a
house rule, not a fact about the software. Nothing here knows a creature's speed; that's a character
sheet.

The two are one expression. A straight move on a lattice where diagonal steps are allowed breaks
down exactly one way, into `min(|Δx|, |Δy|)` diagonal steps with the rest orthogonal, and the
conventions differ only in what the diagonals cost:

```
equal        5 × max
alternating  5 × (max + ⌊min / 2⌋)
```

**`⌊min / 2⌋` counts from the start of each reading, not across a turn.** The first diagonal of
anything anyone measures costs five. That's intentional, and it's what makes the alternating rule
affordable here: there's no movement budget in this project to carry a remainder in, and a number
that depended on how far you'd already come couldn't be checked by looking at it.

It's one field on `RoomState`, plus `SetDiagonals` and `DiagonalsChanged`. It's the third setting
shaped like `show_names`: DM-only to set and sent to everyone, because who may set it is a
permission question and its value isn't a secret. It sits **beside that switch on the table tab**,
which is where both ended up once the rule was stated: a panel matches where its fields live, and
both of these belong to the room. This one spent four milestones in the token panel under a comment
admitting it was there "for want of a better home". **The server stores it and relays it and never
computes with it**: there's no movement distance anywhere in that crate. What the room guarantees is
that six clients agree, which it couldn't if this lived in `localStorage`. `Equal` is the default
because it's what the ruler did before the setting existed, so a save written without the field
reads as it always did.

The setting changes the ruler and nothing else. A drawn circle's radius and a token's vision are
geometry and stay Euclidean on both settings; see the paragraph above about distance and coverage
disagreeing, where this setting changes only the distance side.

The movement ruler shows how far the dragged token has come from where its drag began. `feetMoved`
rounds the difference to whole cells before converting, which needs no knowledge of where a token
settles: a drag starts from a settled position, and the lattice is one cell apart whatever the
token's size, so the difference between the two ends is a whole number of cells. Which cell it
lands *in* is decided by `snap_to_cell`, which stays on the server as the only copy of that rule.

### The trail

**The ruler also tints the squares the move crossed**, and they're the squares of the *straight
line* from the origin to where the token is now, not the path the mouse took. Under `Equal` that
makes the trail a picture of the reading: a rasterised line is exactly `max + 1` cells, the reading
is `max × 5`, and both are computed from the same two integers, so they can't disagree. Counting the
lit squares and reading the label give the same answer.

It also costs nothing. `trailCells` is derived from `ruler.from` and where the token is, both of
which every client watching the drag already has, so all six screens rasterise the same line with
nothing added to the wire or the room. Recording the path would have been *worse* for what this
feature is for: drag frames are throttled, so a watcher's recording is coarser than the dragger's,
and the same move would draw differently on each screen.

Under `Alternating` the trail no longer matches the number: a three-cell diagonal lights four
squares and reads 20 ft. That's the documented cost of the mode. Shading every second diagonal to
show where the doubling fell was considered and left out, as noise supporting a number the label
already gives.

A step can land exactly on a cell boundary, and `floor` takes the later cell. Either choice is
defensible when the line runs along the join. What matters is that every client gets the same answer
from the same two integers, and that dragging the line backwards lights the same squares. The ties
fall on whole numbers, which floor to themselves from both directions.

A wide token traces its centre, one cell across whatever its size. The trail answers "which way did
it come", and a 4×4 footprint swept over four cells of travel is a smear rather than a path.

**The trail stays about two seconds after the drop, and the line and the reading fade with it.** One
alpha covers all three, because they're one annotation, and a halo outliving its line by a frame
looks like a rendering bug. That's a second timer beside `STALE_MS`, with a different purpose.
`STALE_MS` is a guess about a client that vanished mid-drag, and this is an intentional pause on a
move that landed. The drop is the moment everyone looks up, and a trail that disappears on the same
frame it arrives is a trail nobody read. So `end` starts a ruler fading rather than deleting it, and
`forget` is what actually removes it: a token deleted or hidden mid-drag mustn't leave a line
pointing at where it went.

### The wall hint

**A drag that passes through a wall or a shut door draws the DM's ruler and trail in amber.** This
is the idea the original fog design (in `docs/history.md`) proposed and never scheduled, and it's a
*hint*: nothing is blocked, no command is refused, and the DM says "there's a wall there" as they
would at a table. A server that rejected the move would reveal the floor plan to anyone who dragged
a token around and watched which moves stuck.

It can't leak, and not because anything checks who is asking: a player's scene has no walls, so
`crossesWall` finds nothing to cross and their trail is blue. The driver asserts exactly that
difference: one drag, one set of frames, amber on one screen and blue on the other.

`segmentsCross` is four signed areas with no division, so a wall traced exactly vertical needs no
special case. Collinear overlap counts as not crossing: a move sliding *along* a wall hasn't gone
through it. `blocksSight` is `Wall::blocks` written a second time in a second language, which is
acceptable for the same reason as `shape_covers`: a disagreement changes what a line looks like on
one screen, never what anyone is allowed to see. The whole trail changes colour, not just the two
squares either side of the wall. The DM is being told this move went through something, and the
hint isn't precise enough to say which step did it.

**Every client draws a ruler for any token it sees moving, not only the one dragging it.** That
costs nothing on the wire, which is what makes it affordable. `TokenMoved` already says whether a
frame is a drag or a drop, and a watcher's copy of a token stays at its settled position until the
first drag frame arrives, so that position *is* the origin. It's read before the frame is applied
and ignored on every later frame, or the ruler would measure from itself. No command, no event,
nothing persisted. Nothing can leak either: the frames it's built from are the ones the room already
decided to send, so a hidden token's ruler goes exactly where a hidden token goes.

A drop frame ends a ruler. The fallback for a client that vanishes mid-drag is a timeout, and it has
to be a generous one. Drag frames come from `pointermove`, so a drag that merely pauses sends
nothing, and silence means "they stopped moving the mouse" far more often than "they're gone". A
ruler that expires while the DM is still holding a token is worse than a line left on screen for a
few seconds by a browser that closed.

**A group drag draws one ruler on the dragger's screen and one per token on everyone else's**, and
that difference is intended, not overlooked. The dragger's client knows which token the pointer went
down on and starts a ruler for that one alone. A watcher only knows several tokens are moving,
because the frames it builds rulers from are ordinary `TokenMoved`s and none says which was grabbed.
Making the two agree would need an anchor flag on that message: a new field on the busiest token
message in the project, spent on a hint that refuses nothing and persists nothing. See *Moving
several at once* in `docs/tokens.md`.

A ruler belongs to the board its drag is on, and only the board on screen draws it (`shownBoard`
again). The DM planning a move on the staged map measures there, and the table, who are sent no such
frame, see nothing.

## Ping

Hold the left mouse button with no tool armed and a ring appears where everyone can see it. It's
Foundry's gesture, chosen because half the table has already used it. The code is `pings.ts` on the
client and `ClientMsg::Ping`, `Event::Pinged` and `ServerMsg::Pinged` on the server, and nothing
else.

### It's told apart by duration, not by target

Everything else follows from this. On `pointerdown` with nothing modal armed, a ~400ms timer starts
*alongside* whatever the press also began. A few pixels of movement cancels it (that was a pan or a
drag). An early release cancels it, and the click underneath runs exactly as before, **so doors
still swing**. When the timer fires it consumes the gesture, so the following `pointerup` does
nothing.

That's what makes it fit at all. A click already means five things depending on what's under it and
what tool is armed, and a door is the one place where a click's meaning depends on what it *lands
on*. A ping defined by target would have had to join that logic. Defined by duration, it stays out
of it, and no existing branch had to know about it.

`HOLD_SLOP_PX` is set **equal** to the draw tool's `DRAW_CLICK_SLOP_PX`, and the hold is checked
first on every move. If it were larger, a press could cross into sweeping and *then* fire, killing a
sketch that five other screens had already been shown, with no release frame left to remove it from
them. **The two must stay equal**; the comment in `input.ts` says so.

A hold **on a token** pings. A drag only begins on movement, so a stationary hold on a creature is
free, and pointing at one is most of what pinging is for. Firing undoes what the press started:
`rulers.forget`, because otherwise a zero-length ruler measuring a move nobody made would be left on
the board. The DM's *selection* is kept: it happened on the way down, it's visible, and deselecting a
creature someone just pointed at is the opposite of what they meant.

**Ping ignores the draw tool specifically**, the one exception to "an armed tool takes the button
first". That tool is pinned to the rail rather than the tab strip, everyone has it, and it's used
mid-fight, so a player who leaves it selected between uses would lose the gesture permanently with
no hint why. A gesture that silently does nothing is invisible, and the people least likely to
report it are the ones this feature is for. The cost is real and small: a *slow* click on a shape
pings instead of erasing it. The other candidate was disarming the tool after every completed shape,
rejected because the measure tool is used repeatedly, and re-arming it after every measurement costs
more than a slow erase.

### The ring grows before it fires

The ring starts growing at ~150ms, shown only locally until the ping fires. It isn't decoration. Two
arguments pull in opposite directions and reach the same answer: 400ms of nothing happening makes a
long press feel broken, and a ring that has *started* growing is how an accidental ping gets noticed
in time to let go.

`startedAt` is the moment the button went down rather than the moment it fires, which makes the
preview and the landed ring **one drawing**. Firing moves the same object out of `holding` and into
the list without changing it, so nothing on screen restarts, jumps or blinks. The cost is that the
pinger's own ring expires `HOLD_MS` before everyone else's, which nobody can notice.

Sized in **screen pixels**, positioned in world space. A ring measured in cells disappears when the
camera zooms out, and zooming out to see the whole dungeon is exactly when someone needs to point at
a corner of it.

### No fog gate

**A ping is relayed to everyone wherever it lands, including ground the party has never explored.**
It's the one message in this project carrying a position that no filter on either side of the wire
touches, and the one way something the DM places appears to the table over unexplored ground.

There are three reasons, and the first is what makes it safe rather than just convenient:

- **There's nothing in it to read.** A ping carries a position and a sender. A ring over black says
  someone is gesturing in a direction, not what's standing there. It's the same information the DM
  would give by saying "over there" on Discord.
- The DM can see their own fog while they hold the button, so they know what they're pointing at
  before it goes out.
- The alternative is an intentional 400ms gesture that *sometimes silently does nothing*. A gesture
  you can't tell has failed is one you stop trusting, and the failure would hit hardest the players
  least likely to work out why.

The other half is asserted separately and matters as much: **a ping doesn't light anything up.**
`Ping` isn't in `moves_sight`, so no cell changes state and no `FogChanged` goes out. Pointing at a
room must not explore it. `drive-ping.mjs` checks both on one gesture: the ring lands on the
player's black area, and once it fades, the ground under it is exactly as dark as before.

The cursor feature (milestone 28, `docs/presence.md`) went the other way for the DM's pointer: a
ping is a deliberate act and a moving pointer isn't, so "the DM's cursor wandered across an
unexplored room" is a different question from "the DM pointed at it".

### Ephemeral in every respect

No persistence, absent from `snapshot_for`, doesn't mark the room dirty, not in `persists`. That's
more ephemeral than a sketch on every count, and comparing the two shows why. A sketch at least
exists *between* two pointer events, so the room is involved in its lifetime: the next frame
replaces it, a release closes it, and a socket dying has to close it too. A ping is one frame that
arrives, is relayed, and is over. Only the clock on each client ends one, which is why `active` is
the only thing that ever removes one from a board.

`apply` is a misnomer for exactly one command, and this is it: there's no `&mut self` in that arm.
It goes through the four-step pipeline anyway rather than short-circuiting earlier, because
permission and delivery live in those steps, and a command with a path around them is how one of
the two gets forgotten.

`finite` is still checked. Everywhere else that check protects the save file. Here there's no save
file to protect, and the reason is the other one: a NaN would reach six clients and draw a ring
nowhere.

### Whose ring it is

`ServerMsg::Pinged` carries an **`Owner`**, not a `ClientId`, and that's the one place it differs
from `Sketch`. A sketch is keyed by connection because the recipient has to replace the previous
frame from that socket and end it on release. A ping replaces nothing and ends by itself, so the
recipient needs to know whose ring to draw, not which socket sent it. A `ClientId` means nothing to
a player and changes every time someone refreshes.

The colour is **looked up, never sent**: `colourOf` returns the sender's picked colour if they have
one, and otherwise indexes a fixed palette by their position in the roster, which every client holds
from the same `Welcome`. Nothing extra goes on the wire with the ping, and six clients can't
disagree. The name is written beside the ring because colour alone doesn't scale to seven people,
and it's the roster name rather than the slug.

Letting players pick their own colour was kept out of this feature because it needed a command a
player may send, persisted state keyed to them, and an answer to how a personal colour relates to
the draw palette. Milestone 27d built it by changing the body of `colourOf` and nothing else, with
the roster-position colours as the defaults for anyone who never picks. See `docs/presence.md`.
Milestone 23's chat attribution reads the same two functions.

The sender isn't echoed their own ping, for `Sketch`'s reason and more so: it has been on their
board since the hold was 150ms old, and a copy arriving a round trip later would restart it.

### The arrow at the edge

**A ping outside your view draws an arrow at the edge of the screen for its lifetime**, pointing at
it. Six players looking at different parts of the map is the normal case, and a ping nobody sees is
worse than no ping.

It **doesn't** pan the camera. Moving the board under someone mid-drag is what the initiative panel
also refuses to do on a turn change, and being told where to look is different from being taken
there.

`edgeMarker` places it where the line from the middle of the view to the ping leaves a rectangle,
inset enough to fit the arrowhead and the name. Computing the crossing rather than clamping each axis
keeps a ping directly above the camera at the top middle instead of in a corner. The inset is capped
at half the view, or a narrow window turns the rectangle inside out and every arrow lands behind the
camera.

### On screen, and not on the staged board

Pings are drawn last, over the names and the hit point bars. Nothing else justifies that position:
a ping is someone saying *look here*, it matters more for two seconds than anything it covers, and
it uncovers it again by itself.

Nothing is drawn while previewing, and nothing can be pinged from there. A ping's position is in the
live board's grid units, so painting it on the map being prepared would put the ring in a cell
nobody pointed at. The shapes and the walls follow the same rule. The DM misses pings while
preparing the next room, which is the same trade preview makes with everything else on the board.

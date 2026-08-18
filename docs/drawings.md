# Drawings and distance

Spell areas, sketches, the coverage rule, the movement ruler, and the ping. Everything anyone puts
on the board that is not a token or a wall.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`shapes.ts`, `drawtool.ts`, `ruler.ts`, `pings.ts`, or `Shape` / `ShapeKind` / `Sketch` / `Ping` on
the server** — the geometry here is one function doing two jobs, the honest inconsistency between
how distance counts and how coverage counts is deliberate, and the ping is the one thing in this
project that no visibility filter touches.

## Drawings

Spell areas and measuring shapes: line, circle, cone, rectangle. **Anyone may draw** — this is the
only thing in the room a player can add, and the only thing they can destroy. `by: Owner` records
who, and `can_erase` is the DM or them.

**All four kinds are one struct: a kind and two points.** A line is its two ends, a rectangle its
opposite corners, a circle its centre and a point on the rim, a cone its apex and its tip. So there
is one hit test and one coverage rule rather than four of each, and `to` is an *offset* from the
origin rather than a second position — which is what makes an anchored shape translate with its
token instead of stretching towards a fixed cell.

Geometry is in grid units, like a token and unlike `play_area`. A shape is measured in cells, so
recalibrating leaves a 20 ft circle 20 ft across. Walls will be the other case.

`Origin` is an enum rather than a position beside an `Option<TokenId>`, the way `Identity` is one:
an anchored shape carrying a position nothing reads is a field that can go stale, and the pair
could disagree. `Shape::anchor()` is the only thing that asks which it is.

**There is no `ShapeView`.** The third layer that `TokenView` is does not exist here and should not
be added: fog gates a shape *whole* — all-or-nothing on whether any cell it covers has been explored
— so the filtering seam is `message_for` dropping it, and a view type would have no field to redact.
That guess held when 16b actually built the arm.

### Sketches, and what "ephemeral" means

A shape being swept out is on the wire and is not in the room. `ClientMsg::Sketch` carries
`drawing`, exactly as `MoveToken` carries `dragging`: frames are throttled client-side, relayed to
everyone *but* the sweeper — who is drawing it from their own pointer, and would rubber-band — and
worth no disk write. `drawing: false` releases it.

**Whether a release keeps anything is the client's decision alone.** The measure tool stops at the
release; the three area tools follow it with `AddShape`. The server takes all four kinds, stores
whatever it is told to, and never learns which tool was in hand — the same rule that keeps it from
learning the DM is previewing. A "keep this line" toggle would be a change to `drawtool.ts` and to
nothing else.

**A stranded sketch dies on disconnect, not on a timeout.** The room is told when a socket closes,
so `RoomCmd::Disconnected` dispatches `SketchEnded` unconditionally — an id nobody is drawing is a
no-op on arrival, and that is cheaper than keeping "is this client sketching" as state. This is the
one place a movement ruler cannot follow: nothing announces that a drag stopped, so that one has to
guess with `STALE_MS`.

### What one event has to reach into

`Event::ShapesChanged` is payload-free and built per recipient, like `InitiativeChanged`. It covers
adding, erasing and clearing, and three things that reach in from outside:

- **Deleting a token deletes what is anchored to it**, like its initiative row.
- **Hiding or revealing a token rebuilds the list** — but only if something is actually anchored to
  it. An unconditional rebuild would tell the table that *something happened* every time the DM hid
  anything, which is the thing being withheld. Same gate the initiative panel uses.
- **A load into the live slot sweeps the board, and a recalibration must not.** The same `loading`
  that tells those two apart for the calibration table and for the staged plans. Promote is a load.

`shapes_for` withholds a shape whose anchor the recipient cannot see, through `unseen_by_table` so
all three reasons compose. **This is fog's rule arriving early and it had to**: the roadmap filed
anchor visibility under fog, but `hidden` existed already, and an aura on a monster the DM took off
the board is that monster's position drawn in colour. It fails closed — an anchor that is not in the
room at all is withheld too.

**An *unanchored* shape asks a different question**, and that arm is milestone 16b's: it is withheld
unless one of the cells it covers is somewhere the party has explored. Not somewhere they can
currently see — a shape is painted on the floor rather than standing on it, so it gates on `revealed`
with the terrain rather than on `visible` with the creatures. A player's marker survives them leaving
the room, and the board does not flicker as the party moves. See *Drawings on ground the party cannot
see* in `docs/fog.md`, which also covers why the coverage test exists twice in two languages and why
the two copies only have to agree loosely.

Refusals are uniform on purpose. Anchoring to a token you cannot see is refused in the same words
as one that does not exist, and erasing a shape you were never sent reads as "already gone" rather
than "not yours" — otherwise sweeping the id space maps out the DM's monsters.

### Shapes belong to the board

There are no staged shapes, and the draw tool is inert while previewing. The staged map has nothing
to draw on, so unlike a token nothing here forks — no `staged` flag on any of these four commands.

### On screen

Drawn over the tokens. A spell area is being asked about at the moment it is on screen — where it
reaches, and who is caught in it — so it has to read across the creatures inside it rather than
disappear behind the two standing on top of it. The fill is translucent enough that a token under
one is still a token, and names and hit points are drawn later still in screen space, so nothing a
shape covers becomes unreadable. `shapeOrigin` is the `shownPos` of this feature.

**An area shape tints every cell whose centre it reaches, give or take `COVERAGE_SLACK`.** The
slack grows the *shape*, not a ring of sample points around the cell — sampling is generous only
along whichever directions get sampled, and a cone's edges are cut on the diagonals that a handful
of offsets never covers. Zero is the strict reading and about 0.71 (half a diagonal) is "grazes any
corner"; the constant sits near the strict end and is the one number here worth tuning at the
table. The tint therefore reaches a little past the drawn outline, deliberately: the outline is the
shape, the tint is which squares it is being counted against.

The cone test resolves a point along the wedge's own axis — a dot and a cross product against the
unit axis — rather than comparing angles. That keeps a westward cone from tripping over the ±π
wrap, lets the slack be a distance in cells rather than an angle that would mean different things
at the apex and the tip, and puts the **apex inside the shape**, which an arc-cosine cannot say:
there is no angle from a point to itself, so a cone left its own square untinted.

This is where the honest inconsistency lives. *Distance* counts a diagonal step in cells, under which "everything within
20 ft" is a square; a circle here is a circle, and the cells it covers are a round blob. They
disagree at the corners because they answer different questions — how far something walked, and
what a shape covers — and the tint is what makes the second countable. A shape's own reading is its
actual length quantised to five feet, for the same reason.

The diagonal switch does not touch this. It changes what a *step* costs, which is the left half of
the disagreement; a length and a radius of light are geometry and are Euclidean whichever way the
room is counting. A DM who sets 5-10-5 to get closer to true distance has not asked for their
fireballs to change shape.

The coverage rule and the hit test are `containsPoint`, one function. That is what makes
click-to-erase nearly free: the tint has to ask it of every cell centre anyway.

A cone is as wide as it is long (`atan(0.5)`), which is a statement about a wedge and not about a
breath weapon. Its far edge is an arc, because the far edge of a wedge is every point the same
distance from the apex — the same reason a circle is not a square.

**A free-placed shape starts at the centre of the cell it began in.** `originCell`, and it is the
one snapping rule that lives in the client — deliberately, and it is not the token rule written
twice. `snap_to_cell` depends on how wide a token is; a shape has no width to settle by, so its
origin is always a cell centre. And it *has* to be decided here: a token's drop is echoed back
carrying its settled position, so the client can afford never to snap, whereas a sweep is relayed
and never echoed, and an origin settled on the server would arrive after five people had watched
the circle being drawn somewhere else. An anchored shape skips it and sits on its token, which the
server has already settled — an aura on a 2×2 creature belongs on the creature, not in one of the
four cells under it.

That snap is also why a sweep and a click are told apart by **pointer travel in screen pixels**
rather than by the offset still being zero: from a snapped origin the offset is up to half a cell
the instant the hand twitches, and the old test would have turned every erase into a kept circle.

**A sweep starting on a token anchors to it**, with Alt to sweep straight through. No extra UI, and
it is where most auras start. The tool and colour are fixed at pointerdown like a drag's `staged`
flag: a sweep cannot change shape halfway, and it has to survive the tool being put away with
Escape mid-sweep — or the release frame never goes out and the line strands on five screens.

## Distance

A grid cell is five feet, and distance is counted in cells crossed. **How much a diagonal step
costs is the DM's to set, one switch for the room** — `Diagonals::Equal` charges one cell for every
step, `Alternating` charges double for every second diagonal. Both keep every reading a multiple of
five, which is the property worth protecting: it is what the table says out loud. This section used
to say "straight-line", which would make a one-cell diagonal 7 ft, and then said `Equal` was the
rule rather than the default; each rewording is the same admission, that how a table counts is a
house rule and not a fact about the software. Nothing here knows a creature's speed: that is a
character sheet.

The two are one expression. A straight move on a king-move lattice decomposes exactly one way, into
`min(|Δx|, |Δy|)` diagonal steps and the rest orthogonal, and the conventions differ only in what
the diagonals cost:

```
equal        5 × max
alternating  5 × (max + ⌊min / 2⌋)
```

**`⌊min / 2⌋` counts from the start of each reading, not across a turn.** The first diagonal of
anything anybody measures costs five. That is deliberate and it is what makes the alternating rule
affordable here: there is no movement budget in this project to carry a remainder in, and a number
that depended on how far you had already come could not be checked by looking at it.

It is one field on `RoomState`, `SetDiagonals`, and `DiagonalsChanged` — the third thing shaped like
`show_names`, DM-only to set and sent to everyone, because who may set it is a permission and what
it says is not a secret. It sits **beside that switch on the table tab**, which is where the two of
them ended up once the rule was stated: a panel mirrors where its fields live, and both of these are
the room's. This one spent four milestones in the token panel under a comment admitting it was there
"for want of a better home", which is as clear a report as a codebase ever files against itself. **The server stores it and relays it and never computes with it**: there is
no movement distance in that crate at all. What the room is authoritative over is that six clients
agree, which is exactly what it would not own if this lived in `localStorage`. `Equal` is the
default, and that is not luck — it is what the ruler did before the switch existed, so a save
written without the field reads as it always did.

The switch moves the ruler and nothing else. A drawn circle's radius and a token's vision are
geometry and stay Euclidean on both settings; see the paragraph above about the honest
inconsistency, which the switch changes only the left half of.

The movement ruler shows how far the token being dragged has come from where its drag began.
`feetMoved` rounds the delta to whole cells before converting, which needs no knowledge of where a
token settles — a drag starts from a settled position and the lattice is one cell apart whatever
the token's size, so the difference between the two ends is a whole number of cells. Which cell it
lands *in* is `snap_to_cell`'s business, and stays on the server as the only copy of that rule.

### The trail

**The ruler also tints the squares the move crossed**, and they are the squares of the *straight
line* from the origin to where the token is now — not the path the mouse wandered along. Under
`Equal` that makes the trail a picture of the reading: a rasterised line is exactly `max + 1` cells,
the reading is `max × 5`, and the two are computed from the same two integers, so they cannot
disagree. Counting the lit squares and reading the label are the same act.

It also costs nothing. `trailCells` is derived from `ruler.from` and where the token is, both of
which every client watching the drag already holds, so all six screens rasterise an identical line
with nothing added to the wire and nothing added to the room. The recorded-path alternative would
have been *worse* for the thing this feature is for: drag frames are throttled, so a watcher's
recording is coarser than the dragger's, and the same move would draw differently on each screen.

Under `Alternating` the trail stops being a picture of the number — a three-cell diagonal lights
four squares and reads 20 ft. That is the documented cost of the mode. Shading every second diagonal
to show where the doubling fell was considered and left out: it is noise in aid of a number the
label already states.

A step can land exactly on a cell boundary, and `floor` takes the later cell. Either is defensible
when the line runs down the join; what matters is that every client gets the same answer from the
same two integers, and that dragging the line backwards lights the same squares — the ties fall on
whole numbers, which floor to themselves from both directions.

A wide token traces its centre, one cell across whatever it is. The trail answers "which way did it
come", and a 4×4 footprint swept over four cells of travel is a smear rather than a path.

**The trail lingers about two seconds after the drop, and the line and the reading fade with it.**
One alpha over all three, because they are one annotation and a halo outliving its line by a frame
reads as a rendering fault. That is a second clock beside `STALE_MS` and a different one: `STALE_MS`
is a guess about a client that vanished mid-drag, and this is a deliberate pause on a move that
landed. The drop is the moment everyone looks up, and a trail that goes out on the same frame as it
arrives is a trail nobody read. `end` therefore starts a ruler fading rather than deleting it, and
`forget` is the one that really removes it — a token that was deleted or hidden mid-drag must not
leave a line pointing at where it went.

### The wall hint

**A drag that passes through a wall or a shut door draws the DM's ruler and trail in amber.** This
is the idea `ROADMAP.md` filed under fog of war and never built, and it is a *hint*: nothing is
blocked, no command is refused, and the DM says "there is a wall there" the way they would at a
table. A server that rejected the move would hand the floor plan to anyone who dragged a token
around and watched which moves stuck.

It cannot leak, and not because anything checks who is asking: a player's scene carries no walls, so
`crossesWall` finds nothing to cross and their trail is blue. The driver asserts exactly that
asymmetry — one drag, one set of frames, amber on one screen and blue on the other.

`segmentsCross` is four signed areas and no division, so a wall traced exactly vertical needs no
special case. Collinear overlap reads as false: a move sliding *along* a wall has not gone through
it. `blocksSight` is `Wall::blocks` written a second time in a second language, which is affordable
for `shape_covers`' reason — a disagreement changes what a line looks like on one screen, never what
anybody is permitted to see. The whole trail changes colour rather than the two squares either side
of the wall: the DM is being told this move went through something, and which step did it is a
precision the hint does not have.

**Every client draws a ruler for any token it sees moving, not only the one dragging it.** That
costs nothing on the wire, which is what makes it affordable: `TokenMoved` already says whether a
frame is a drag or a drop, and a watcher's copy of a token sits at its settled position until the
first drag frame lands — that position *is* the origin. So it is read before the frame is applied
and ignored on every frame after, or the ruler measures from itself. No command, no event, nothing
persisted. Nothing can leak, either: the frames it is built from are the ones the room already
decided to send, so a hidden token's ruler goes exactly where a hidden token goes.

A drop frame ends a ruler. The backstop for a client that vanishes mid-drag is a timeout, and it
has to be a generous one — drag frames come from `pointermove`, so a drag that merely pauses sends
nothing at all, and silence means "they stopped moving the mouse" far more often than "they are
gone". A ruler that expires while the DM is still holding a token is worse than a line left on
screen for a few seconds by a browser that closed.

**A group drag draws one ruler on the dragger's screen and one per token on everybody else's**, and
that asymmetry is deliberate rather than overlooked. The dragger's client knows which token the
pointer went down on and begins a ruler for that one alone; a watcher knows only that several tokens
are moving, because the frames it builds rulers from are ordinary `TokenMoved`s and none of them
says which was grabbed. Putting an anchor flag on that message is what it would cost to make the two
agree — a new field on the hottest message in the project, spent on a hint that refuses nothing and
persists nothing. See *Moving several at once* in `docs/tokens.md`.

A ruler belongs to the board its drag is happening on, and only the board on screen draws it —
`shownBoard` again. The DM planning a move on the staged map measures there, and the table, who
are sent no such frame, see nothing.

## Ping

Hold the left mouse button with no tool in hand and a ring appears where everyone can see it.
Foundry's gesture, chosen because half the table has already used it. `pings.ts` on the client,
`ClientMsg::Ping` and `Event::Pinged` and `ServerMsg::Pinged` on the server, and nothing else.

### It separates by duration, not by target

This is the design, and everything else follows from it. On `pointerdown` with nothing modal armed,
a ~400ms timer starts *alongside* whatever the press also began. A few pixels of movement cancels it
— that was a pan or a drag. An early release cancels it and the click underneath runs exactly as it
always did, **so doors still swing**. The timer firing consumes the gesture, so the `pointerup` that
follows does nothing.

Separating this way is what makes it fit at all. A click already means five things depending on what
is under it and what is in hand, and a door is the one place where what a click means depends on
what it *lands on*. A ping defined by target would have had to join that argument; defined by
duration it does not participate in it, and no existing branch had to learn about it.

`HOLD_SLOP_PX` is deliberately **equal** to the draw tool's `DRAW_CLICK_SLOP_PX` and the hold is
checked first on every move. Larger, and a press could cross into sweeping and *then* fire, killing
a sketch that five other screens had already been shown with no release frame left to take it off
them. The equality is load-bearing; the comment in `input.ts` says so.

A hold **on a token** pings. A drag only begins on movement, so a stationary hold on a creature is
free — and pointing at one is most of what pinging is for. Firing takes back what the press started:
`rulers.forget`, because a zero-length ruler measuring a move nobody made would otherwise be left on
the board. The DM's *selection* is deliberately kept: it happened on the way down, it is visible, and
un-selecting a creature somebody just pointed at is the opposite of what they meant.

**Ping ignores the draw tool specifically**, which is the one exception to "an armed tool takes the
button first". That tool is pinned to the rail rather than the tab strip, everybody has it, and it is
used in the middle of a fight — so a player who leaves it selected between uses would lose the
gesture permanently and get no hint as to why. A dead gesture is invisible, and the people least
likely to report it are the ones this feature is for. The cost is real and small: a *slow* click on a
shape pings instead of erasing it. Disarming the tool after every completed shape was the other
candidate and was rejected because the measure tool is used repeatedly, and re-arming it after every
measurement is a worse tax than a slow erase.

### The ring grows before it fires

From ~150ms, local-only until it commits. That is not decoration and the two arguments for it pull
in opposite directions and both land in the same place: 400ms of nothing happening is how a long
press feels broken, and a ring that has *started* growing is how an accidental ping gets noticed in
time to let go.

`startedAt` is the moment the button went down rather than the moment it fires, which is what makes
the preview and the landed ring **one drawing**. Committing moves the same object out of `holding`
and into the list without touching it, so nothing on screen restarts, jumps or blinks. The cost is
that the pinger's own ring expires `HOLD_MS` before everyone else's, which nobody can perceive.

Sized in **screen pixels**, positioned in world space. A ring measured in cells vanishes when the
camera pulls back, and pulling back to see the whole dungeon is exactly when somebody needs to point
at a corner of it.

### No fog gate, and that is the decision

**A ping is relayed to everyone wherever it lands, including ground the party has never explored.**
It is the one message in this project carrying a position that no filter on either side of the wire
touches, and the one place something the DM places appears to the table over unexplored ground.

Three reasons, and the first is the one that makes it safe rather than merely convenient:

- **There is nothing in it to read.** A ping carries a position and a sender. A ring over black says
  somebody is gesturing in a direction, not what is standing there — which is the same information
  the DM would give by saying "over there" on Discord.
- The DM can see their own fog while they hold the button, so they know what they are pointing over
  before it goes.
- The alternative is a deliberate 400ms gesture that *sometimes silently does nothing*. A gesture you
  cannot tell has failed is one you stop trusting, and the failure would land hardest on the players
  least likely to work out why.

The other half is asserted separately and matters as much: **a ping does not light anything up.**
`Ping` is not in `moves_sight`, so no cell changes state and no `FogChanged` goes out. Pointing at a
room must not explore it. `drive-ping.mjs` checks both directions on one gesture — the ring lands on
the player's black, and once it fades the ground under it is exactly as dark as it was.

Contrast this with the cursor feature `ROADMAP.md` leaves unscheduled, which probably lands the other
way: a ping is a deliberate act and a drifting pointer is not, so "the DM's cursor wandered across an
unexplored room" is a different question from "the DM pointed at it".

### Ephemeral, whole

No persistence, absent from `snapshot_for`, does not mark the room dirty, not in `persists`. Stronger
than a sketch on every count, and the comparison is the clearest way to see the shape: a sketch at
least exists *between* two pointer events, so the room participates in its lifetime — the next frame
replaces it, a release closes it, and a socket dying has to close it too. A ping is one frame that
lands, is relayed, and is over. Nothing ends one but the clock on each client, which is why `active`
is the only thing that ever takes one off a board.

`apply` is a misnomer for exactly one command and this is it: there is no `&mut self` in that arm. It
goes through the four-step pipeline anyway rather than short-circuiting somewhere earlier, because
those steps are where permission and delivery live and a command with a path around them is how one
of the two gets forgotten.

`finite` is still checked. Everywhere else that guard protects the save file; here there is no save
file to protect and the reason is the other one — a NaN reaches six clients and draws a ring nowhere.

### Whose ring it is

`ServerMsg::Pinged` carries an **`Owner`**, not a `ClientId`, and that is the one place it differs
from `Sketch`. A sketch is keyed by connection because the recipient has to replace the previous
frame from that socket and end it on release. A ping replaces nothing and ends by itself, so what the
recipient needs is not which socket sent it but whose ring to draw — and a `ClientId` is a number
that means nothing to a player and a different number every time somebody refreshes.

Colour is **derived, not chosen**: `colourOf` indexes a fixed palette by the sender's position in the
roster, which every client holds from the same `Welcome`. Nothing on the wire, nothing persisted,
nothing anybody sets at the start of a session, and six clients cannot disagree. The name is written
beside the ring because colour alone does not scale to seven people, and it is the roster name rather
than the slug.

Letting players pick their own colour is a feature worth having and is deliberately **not** this one
— it needs a command a player may send, persisted state keyed to them, and an answer to how a
personal colour relates to the draw palette. When it lands it replaces the body of `colourOf` and
touches nothing else, with these as the defaults for whoever never picks. Milestone 23's chat
attribution reads the same two functions.

The sender is not echoed their own ping, for `Sketch`'s reason twice over: it has been on their board
since the hold was 150ms old, and a copy arriving a round trip later would restart it.

### The arrow at the edge

**A ping off the edge of your view draws an arrow at the edge of the screen for its lifetime**,
pointing at it. Six players looking at different parts of the map is the normal case, and a ping
nobody sees is worse than no ping at all.

It is **not** a camera pan. Moving the board under whoever is mid-drag is the same thing the
initiative panel refuses to do on a turn change, and being told where to look is a different act from
being taken there.

`edgeMarker` puts it where the line from the middle of the view to the ping leaves a rectangle inset
by the room the arrowhead and the name need. Computing the crossing rather than clamping each axis is
what keeps a ping directly above the camera at the top middle instead of in a corner. The inset is
clamped to half the view, or a narrow window turns the rectangle inside out and every arrow lands
behind the camera.

### On screen, and not on the staged one

Drawn last, over the names and the hit point bars, and it is the only thing that earns that: it is
somebody saying *look here*, it is worth more for two seconds than anything it covers, and it
uncovers it again by itself.

Nothing draws while previewing, and nothing can be pinged from there. A ping's position is in the
live board's grid units, so painting it onto the map being prepared would put the ring in a cell
nobody pointed at — the rule the shapes and the walls already follow. The DM misses pings while they
are preparing the next room, which is the trade preview already makes with every other board-level
thing on screen.

# Drawings and distance

Spell areas, sketches, the coverage rule, and the movement ruler. Everything measured in cells
and read out in feet.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`shapes.ts`, `drawtool.ts`, `ruler.ts`, or `Shape` / `ShapeKind` / `Sketch` on the server** — the
geometry here is one function doing two jobs, and the honest inconsistency between how distance
counts and how coverage counts is deliberate.

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
be added: fog gates a shape *whole* — all-or-nothing on whether any cell it covers is visible — so
the filtering seam is `message_for` dropping it, and a view type would have no field to redact.

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

`shapes_for` withholds a shape whose anchor the recipient cannot see, through `Token::unseen` so
both reasons compose. **This is fog's rule arriving early and it had to**: the roadmap files anchor
visibility under fog, but `hidden` exists now, and an aura on a monster the DM took off the board
is that monster's position drawn in colour. It fails closed — an anchor that is not in the room at
all is withheld too.

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

This is where the honest inconsistency lives. *Distance* counts a diagonal step as one cell, under which "everything within
20 ft" is a square; a circle here is a circle, and the cells it covers are a round blob. They
disagree at the corners because they answer different questions — how far something walked, and
what a shape covers — and the tint is what makes the second countable. A shape's own reading is its
actual length quantised to five feet, for the same reason.

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

A grid cell is five feet, and distance is counted in cells crossed — a diagonal step costs what an
orthogonal one costs, so every reading is a multiple of five. This section used to say
"straight-line", which would make a one-cell diagonal 7 ft; the table counts in fives and the
wording changed to match. The 5e variant where every *other* diagonal costs double is still a rule
and still a non-goal, and nothing here knows a creature's speed: that is a character sheet.

The movement ruler shows how far the token being dragged has come from where its drag began.
`feetMoved` rounds the delta to whole cells before converting, which needs no knowledge of where a
token settles — a drag starts from a settled position and the lattice is one cell apart whatever
the token's size, so the difference between the two ends is a whole number of cells. Which cell it
lands *in* is `snap_to_cell`'s business, and stays on the server as the only copy of that rule.

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

A ruler belongs to the board its drag is happening on, and only the board on screen draws it —
`shownBoard` again. The DM planning a move on the staged map measures there, and the table, who
are sent no such frame, see nothing.

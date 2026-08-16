# Walls and doors

The geometry the DM traces over the map image, and the editor that produces it. Nothing consumes
it yet — fog of war is the next milestone, and this one exists so that when fog arrives, tracing a
dungeon is not the reason nobody turns it on.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`walls.ts`, `walltool.ts`, `Wall` / `WallKind` / `Px` on the server, or `sweep_board`** — the
coordinate space here is the one exception to invariant 1, and the reason a run stops existing the
moment it is stored is the thing that looks like a mistake and is not.

Where this panel sits on the left rail is `rail.ts`'s to decide rather than this file's; *The rail*
below says what that leaves the wall editor itself responsible for.

## Image pixels, not cells

**A wall is stored in image pixels.** This is invariant 1's stated exception and not a violation of
it: a wall traces a feature painted on the map, so it is anchored to the art rather than to a cell.
Stored in grid units, every wall would slide off the wall it was tracing the moment the DM
corrected the grid. `play_area` is in this space already, for the same reason. Calibrate first,
then trace.

`Px` is its own type beside `Pos` rather than the same two floats reused. The spaces are not
interchangeable and mixing them up is silent — a wall a hundred cells long and a wall a hundred
pixels long are both numbers that serialise fine. Making the compiler tell them apart costs one
struct.

## Flat segments, and why the run is not a thing

The DM authors a **polyline** — click, click, click, double-click — and the room stores **one `Wall`
per gap between corners**. The run is not stored anywhere. It exists in `walltool.ts` until the last
click and then it is gone.

That is the whole reason the feature is worth a milestone. Per-segment click-drag across a
two-hundred-segment dungeon is what makes people quietly stop using fog of war, so authoring is a
run; but everything downstream asks about segments one at a time — erasing one bad segment of a long
trace, swinging one door, and the shadowcast that will read these. Keeping the run would mean the
list had two shapes and every consumer had to flatten it.

`AddWalls` therefore carries `points` and the server invents an id per segment, the way it invents
one for a shape. `RemoveWall` takes one id. There is no "erase this run", and that is the feature:
correcting a trace does not mean redrawing it.

## A door is a kind of wall, not a wall with a flag

```rust
enum WallKind { Solid, Door(bool) }
```

An enum rather than `door: bool` beside `open: bool`, for the reason `Origin` is one: a solid wall
carrying an open flag that nothing reads is a field that can go stale, and the pair could disagree
about what the segment even is. "A solid wall that is open" is unrepresentable.

`Solid` is the `Default`, and that matters beyond loading an older save: a segment that defaulted to
an open door would quietly stop blocking anything the moment fog arrived. `Wall::door()` returns
`Option<bool>` and is the only thing outside the editor that asks.

**Milestone 21 made a door load-bearing rather than decorative.** On a map lit a room at a time, a
shut door seals a room and an open one is what the party sees *through* — so a swing is the
difference between the table being handed the next chamber and being handed a doorway's worth of it.

Three readers now, and the rule is one line: **only sight reads `blocks()`.** Both fills — the DM's
reveal fill and room lighting's — bound on every traced segment whatever it is swung to, which is
what makes an archway *a door left open*, on a map being painted and on a map being played alike.
Room lighting shipped disagreeing with that and was corrected; `docs/fog.md` has the story.

Doors are traced **shut**. A door the DM has to close after drawing it is a door they will forget to
close. `ToggleDoor` is refused on masonry rather than ignored — a toggle landing on a wall means the
client and the room disagree about what that segment is, and doing nothing quietly hides it.

**A door swings at any time, with no tool in hand.** Opening a door is not editing the map: it
happens in the middle of a fight, several times an evening, while the DM is dragging monsters
around. Making them arm the wall editor first would put a modal tool between them and the board
every time the party opens a door, which is how a feature ends up unused. So the click is available
whenever nothing *else* has claimed the left button — see *A door is the one thing here that is not
a mode* below.

## Walls reach the DM or nobody

There is no `WallView` and there should not be one. Per-field redaction is what `TokenView` is for,
and there is no field on a wall a player may hold: they may hold none of it. `snapshot_for` sends
them an empty list, and **empty is also what an untraced map looks like**, so the two are
indistinguishable from the client side — the same trick `staged` being `None` plays.

`Event::WallsChanged` reaches the DM and **nobody else, not even as an empty list**. A frame a
player cannot use still tells them the DM just did something, and once fog exists it would tell them
*when a door opened* on the one board they cannot see through. That is `TokenPlanChanged`'s rule
arriving for the second time, and this is the least ambiguous case of it yet.

Every wall command is DM-only, and unlike the drawings there is no per-item permission underneath:
the walls are all the DM's, so "may this client touch a wall" and "is this client the DM" are the
same question. `can_erase` has no counterpart here.

## What sweeps them away

**A load into the live slot sweeps the walls, and a recalibration must not.** This is the third
feature to turn on the same `loading` flag — after the remembered calibration table and the staged
token plans — and it is the arm that gets missed each time. Correcting the grid after tracing is an
ordinary thing to do; loading a different image is a different dungeon where none of the tracing
means anything.

Shapes and walls now go together in `sweep_board`, which a load and a promote both call. Both halves
are gated on being non-empty, and that gate is load-bearing for the shapes rather than tidy: an
unconditional `ShapesChanged` on every map load tells the table something happened to a board that
had nothing on it. Same gate the initiative panel uses.

Walls are **persisted**. Half an hour of tracing belongs to a map that will still be on the board
next week, and this is the one thing on `Saved` that would make its feature unusable if it were left
in memory.

## The staged map has walls of its own

This section used to say there were none, and that the DM had to promote a map before they could
wall it. Milestone 20 is that cost being paid off: `StagedBoard` holds a map, its walls and its fog
overrides together, and the next dungeon is traced on a Tuesday out of sight of the table.

**It is still one slot, and it is still not the scene concept.** Two boards, not a list of maps each
owning their own geometry — a promote *moves* one list into the other rather than a list existing
per map, and `ClearStaged` throws the second one away.

Three things made this the cheapest subsystem in the project to stage, and they are worth reading
together because the first is the one that generalises:

- **Walls reach the DM or nobody**, so there was no filter to widen. A staged wall added *zero* new
  visibility surface — contrast `staged_only`, which had to grow `unseen_by_table` a third reason
  and change the meaning of `was_unseen` at four sites. The section below is unchanged and now
  covers twice as many walls.
- **The whole slot leaves by one door.** `ServerMsg::StagedChanged` carries the bundle rather than
  the map, so `snapshot_for`'s single `None` withholds the masonry and the paint along with the
  image — and a staged load sweeping its walls, or a staged recalibration dropping its paint, needs
  no frame of its own. There is therefore none to forget.
- **Every command names a slot**, which is the `SetMap` / `MoveToken` / `CreateToken` pattern for
  the fourth time. On `RemoveWall` and `ToggleDoor` the flag is *redundant* — the ids are UUIDs and
  a lookup could search both lists — and it is there anyway, because a search of both is a search
  that erases live masonry on a frame sent while the DM was looking at the staged board.

**A staged door is traced shut like any other and promotes however the DM left it.** Swinging one
before the promote is not play, because nobody is playing on that map yet; it is the DM deciding
which doors the party finds open when they walk in. Same click, because a door being clickable is
what makes it a door — see *A door is the one thing here that is not a mode* below, which now
applies to both boards and means something different on each.

### What sweeps a staged wall

The live board's rules, mirrored, which is the argument for the two slots holding the same three
things:

| | staged walls | staged overrides |
| --- | --- | --- |
| a **load** into the staged slot | swept | swept |
| a **recalibration** of it | kept | swept |
| **promote** | move to the live board | move to the live board |
| **discard** | gone | gone |

The middle row is the one that gets missed, and it is the same split it has always been: a wall is
image pixels and still traces the same painted line after the grid moves, and an override is a cell
whose square has just moved out from under it.

**Deliberately out: previewing the staged map's fog.** "Will they see the dragon when the door
opens" is a real question and it is a second raycast; nothing casts a ray on a map the table has not
been shown. See *No staged fog* in `docs/fog.md`.

## The editor

Three modes — `wall`, `door`, `erase` — and an off switch.

**Erase is its own mode, which the draw tool does not need.** There, a sweep is a drag and a click
is therefore free, so clicking a shape erases it. Here a click is how a corner gets placed, so the
only gesture that could mean "erase" is already spoken for. Three buttons is the honest answer.

### A door is the one thing here that is not a mode

**Clicking a door swings it, whether or not the editor is armed.** This is the one place in the
project where what a click means depends on what is under it, and it is worth the exception because
opening a door is a play-time action rather than an editing one.

It is available whenever nothing else has claimed the left button — calibrating, a shape tool, and
the wall editor's own `wall` and `erase` modes each mean something specific by a click, and none of
them should quietly also mean "and swing that door". Two more things lose to it:

- **A token on top of a door wins.** It was grabbed at pointerdown and the swing is never reached.
  Drag the creature out of the doorway, or use the door mode, which hit-tests the wall directly.
- **Mid-trace, every click is a corner**, so a run can be carried straight over a doorway.

The gesture has to coexist with panning, since the map is dragged from wherever the pointer happens
to be. It does, by reading off the *pan* drag rather than starting one of its own: a click that
never moved swings the door, and a click that moved was a pan. That is the same `moved` flag that
already decides whether releasing the map clears the token selection — and a swing takes precedence
over clearing it, because a DM opening a door did not ask to deselect anything.

`Escape` backs out of one thing at a time — the run first, then the tool. Escaping out of both at
once would lose a forty-corner trace to a keypress meant to end the last segment. `Backspace` drops
the last corner and has to `preventDefault`, or the browser reads it as "go back" and loses the
session rather than one corner. `Enter` finishes, like the double-click.

Two clicks in one corner are one corner. That is what makes the second click of a double-click
harmless, and it is also what a DM who double-clicked by accident meant.

### Snapping lives in the client

`snapToCorner` is the second snapping rule on this side of the wire, after `originCell`, and it is
here for the same reason: a run is authored one click at a time and the DM has to watch each corner
land where it will actually sit, with the rubber band drawn from it. A snap applied on the server
would arrive after the polyline had already been drawn somewhere else, and the whole trace would
jump on release.

It is also not `snap_to_cell` written twice. A token settles by how wide it is, onto cell centres or
the corners between them; a wall has no width and always wants the corner, because that is where the
line is painted on the map.

**Alt places freely**, which is what makes a diagonal cave wall traceable on a square lattice. Alt
means to this tool what it means to the draw tool — ignore what this would otherwise attach itself
to — which is why it is that key and not another.

### On screen

Drawn **over everything**, including the tokens, and for a different reason than the shapes are: a
wall is not about what is standing on it, it is the room the tokens are standing *in*, and it has to
be traceable across a crowded board.

Rose for masonry and amber for a door, neither of which the board says anything else with — the ring
vocabulary is gold, blue, white, violet and teal, and the drawing palette avoids all five. **An open
door draws dashed and a shut one draws solid**, which is the same thing the line is about to mean
once there is sight to block. The segment under the pointer draws white, so a click is never a
surprise. The run being traced is blue, like every other in-progress thing on this board.

Masonry is **always on the DM's screen, faint, and full strength while the editor is armed**. It is
never on anybody else's, so the only question was how loudly: faint is enough to answer "have I
traced this room" during a fight without opening the panel.

**Doors are exempt and stay legible always**, because a door can be clicked at any moment and
anything clickable should be drawn like it is. That rule is also what keeps the faintness honest:
the things that recede into the map are exactly the things a click would do nothing to.

### The rail

The wall panel was the fourth on the left rail and one panel more than the layout had room for:
`#tokentool` was the flex item that gave up height, and at an 860-pixel window it was squeezed to a
scrollbar and a heading. That is fixed, and not here — the rail now opens **one editing panel at a
time** behind a tab strip, so the walls panel is a tab rather than a share of the rail's height, and
nothing about it has to be compact to fit. The reasoning is in `rail.ts`.

Two things about this panel survive the move and are still worth knowing. Closing the tab calls
`WallTool.stop()`, which is not tidiness: `erase` and `wall` both take the left mouse button, and a
mode left armed under a hidden panel is a click doing something with nothing on screen saying why.
And a preview makes the **tab** inert as well as the panel — there are no staged walls, so a way in
to a panel that can do nothing is the same lie as the panel sitting there looking armed.

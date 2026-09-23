# Walls and doors

The geometry the DM traces over the map image, and the editor that produces it. It was built the
milestone before fog of war, which reads it, so that when fog arrived, tracing a dungeon wouldn't
be the reason nobody turned it on.

Read this before touching `walls.ts`, `walltool.ts`, `Wall`/`WallKind`/`Px` on the server, or
`sweep_board`. Walls are the one exception to invariant 1's coordinate rule, and a run of wall
stops existing as soon as it's stored. That second point looks like a mistake and isn't.

Where this panel sits on the left rail is decided by `rail.ts`, not here. *The rail* below says
what that leaves the wall editor responsible for.

## Image pixels, not cells

**A wall is stored in image pixels.** This is invariant 1's stated exception: a wall traces a
feature painted on the map, so it's anchored to the art rather than to a cell. Stored in grid
units, every wall would slide off what it was tracing as soon as the DM corrected the grid.
`play_area` is in this space already, for the same reason. Calibrate first, then trace.

`Px` is its own type beside `Pos` rather than the same two floats reused. The spaces aren't
interchangeable, and mixing them up fails silently: a wall a hundred cells long and a wall a
hundred pixels long are both numbers that serialise fine. Making the compiler tell them apart costs
one struct.

## Flat segments: the run isn't stored

The DM draws a **polyline** (click, click, click, double-click), and the room stores **one `Wall`
per segment between corners**. The run isn't stored anywhere. It exists in `walltool.ts` until the
last click and then it's gone.

This is why the feature was worth a milestone. Click-dragging each segment of a two-hundred-segment
dungeon is what makes people stop using fog of war, so authoring works in runs. But everything
downstream asks about one segment at a time: erasing one bad segment of a long trace, swinging one
door, and the fog raycast that reads them. Storing the run would give the list two shapes, and
every consumer would have to flatten it.

So `AddWalls` carries `points`, and the server assigns an id per segment, as it does for a shape.
`RemoveWall` takes one id. There's no "erase this run", and that's intended: correcting a trace
doesn't mean redrawing it.

## A door is a kind of wall, not a wall with a flag

```rust
enum WallKind { Solid, Door(bool) }
```

An enum rather than `door: bool` beside `open: bool`, for the same reason `Origin` is one: an open
flag on a solid wall is a field nothing reads, which can go stale, and the two flags could disagree
about what the segment is. "A solid wall that is open" can't be represented.

`Solid` is the `Default`, and that matters beyond loading an older save: a segment that defaulted
to an open door would stop blocking sight without anyone noticing. `Wall::door()` returns
`Option<bool>` and is the only thing outside the editor that asks.

**Since milestone 21 a door affects what the table sees.** On a map lit one room at a time, a shut
door seals a room and an open one is what the party sees *through*. Swinging it decides whether the
table is shown the next chamber or only a doorway's worth of it.

There are three readers, and the rule is one line: **only sight reads `blocks()`.** Both fills (the
DM's reveal fill and room lighting's) are bounded by every traced segment, however it's swung. That
makes an archway a door left open, whether the map is being painted or played. Room lighting shipped
disagreeing with that and was corrected; `docs/fog.md` has the details.

Doors are traced **shut**. A door the DM has to close after drawing it is a door they'll forget to
close. `ToggleDoor` on a solid wall is refused rather than ignored: a toggle landing on a wall means
the client and the room disagree about what that segment is, and doing nothing would hide that.

**A door swings at any time, with no tool armed.** Opening a door isn't editing the map. It happens
mid-fight, several times an evening, while the DM is dragging monsters around. Requiring the wall
editor to be armed first would put a modal tool between the DM and the board every time the party
opens a door, and a feature used that way ends up unused. So the click works whenever nothing else
has claimed the left button. See *A door is the one thing here that is not a mode* below.

## Walls reach the DM or nobody

There's no `WallView` and there shouldn't be one. Per-field redaction is what `TokenView` is for,
and a player may hold no field of a wall at all. `snapshot_for` sends them an empty list, and
**empty is also what an untraced map looks like**, so the client can't tell the two apart. `staged`
being `None` works the same way.

`Event::WallsChanged` reaches the DM and **nobody else, not even as an empty list**. A frame a
player can't use still tells them the DM just did something, and with fog on it would tell them
*when a door opened* on the one board they can't see through. That's `TokenPlanChanged`'s rule
again, and the clearest case of it.

Every wall command is DM-only, and unlike the drawings there's no per-item permission underneath.
The walls are all the DM's, so "may this client touch a wall" and "is this client the DM" are the
same question. `can_erase` has no counterpart here.

## What sweeps them away

**Loading into the live slot sweeps the walls, and a recalibration must not.** This was the third
feature to branch on the same `loading` flag, after the calibration table and the staged token
plans, and the recalibration branch is the one that gets missed each time. Correcting the grid
after tracing is an ordinary thing to do. Loading a different image means a different dungeon,
where none of the tracing applies.

Shapes and walls go together in `sweep_board`, which a load and a promote both call. Each half is
skipped when its list is empty, and for the shapes that check matters: an unconditional
`ShapesChanged` on every map load tells the table something happened to a board that had nothing
on it. The initiative panel uses the same check.

Walls are **persisted**. Half an hour of tracing belongs to a map that will still be on the board
next week, and of everything on `Saved`, this is the one whose feature would be unusable if it
were kept only in memory.

**Since milestone 31 the sweep moves the walls rather than deleting them.** What was traced on the
outgoing image is filed under its URL and comes back when that image is loaded again: one table
entry per map, keyed the same way the grid calibration already was. Nothing above changes. A load
still sweeps the board, a recalibration still must not, and the walls that arrive are the ones
traced on the incoming image. Two details carry over here. The outgoing URL is **passed into**
`sweep_board` rather than read from `self.map`, because its two callers assign the map on opposite
sides of the call. And the staged slot doesn't go through `sweep_board` at all: a staged board is
filed where the load arm takes the slot, and again in `ClearStaged`. That's the seventh case of an
easily-missed branch. See *The shelf* in `docs/maps.md`.

## The staged map has walls of its own

This section used to say there were none, and that the DM had to promote a map before walling it.
Milestone 20 removed that cost: `StagedBoard` holds a map, its walls and its fog overrides
together, and the next dungeon can be traced on a Tuesday out of sight of the table.

**It's still one slot, and it's still not a scene system.** There are two boards, not a list of
maps each owning its own geometry. A promote *moves* one wall list into the other, and
`ClearStaged` throws the second one away.

Three things made walls the cheapest subsystem to stage. The first is the one that generalises:

- **Walls reach the DM or nobody**, so there was no filter to widen. A staged wall added no new
  visibility surface. Compare `staged_only`, which added a third reason to `unseen_by_table` and
  changed the meaning of `was_unseen` at four sites. The section above is unchanged and now covers
  twice as many walls.
- **The whole slot leaves in one message.** `ServerMsg::StagedChanged` carries the bundle rather
  than just the map, so `snapshot_for`'s single `None` withholds the walls and the paint along with
  the image. A staged load sweeping its walls, or a staged recalibration dropping its paint, needs
  no message of its own, so there's none to forget.
- **Every command names a slot**, following `SetMap`, `MoveToken` and `CreateToken`. On
  `RemoveWall` and `ToggleDoor` the flag is *redundant*: the ids are UUIDs, and a lookup could
  search both lists. It's there anyway, because searching both would erase a live wall on a frame
  sent while the DM was looking at the staged board.

**A staged door is traced shut like any other and is promoted however the DM left it.** Swinging
one before the promote isn't play, since nobody is playing on that map yet. It's the DM deciding
which doors the party finds open when they walk in. It's the same click, because being clickable
is what makes it a door. See *A door is the one thing here that is not a mode* below, which applies
to both boards and means something different on each.

### What sweeps a staged wall

The live board's rules, mirrored. That's the argument for both slots holding the same three things.

| | staged walls | staged overrides |
| --- | --- | --- |
| a **load** into the staged slot | swept | swept |
| a **recalibration** of it | kept | swept |
| **promote** | move to the live board | move to the live board |
| **discard** | gone | gone |

The middle row is the one that gets missed, and it's the same split as always: a wall is in image
pixels and still traces the same painted line after the grid moves, while an override is a cell
whose square has just moved.

**Left out: previewing the staged map's fog.** "Will they see the dragon when the door opens" is a
real question, but answering it takes a second raycast, and nothing casts a ray on a map the table
hasn't been shown. See *No staged fog* in `docs/fog.md`.

## The editor

Three modes (`wall`, `door`, `erase`) and an off switch.

**Erase is its own mode here, which the draw tool doesn't need.** There, a sweep is a drag, so a
click is free and clicking a shape erases it. Here a click places a corner, so the only gesture
that could mean "erase" is already taken. Hence three buttons.

### A door is the one thing here that is not a mode

**Clicking a door swings it, whether or not the editor is armed.** This is the one place in the
project where what a click means depends on what's under it. It's worth the exception because
opening a door is a play-time action, not an editing one.

It works whenever nothing else has claimed the left button. Calibrating, a shape tool, and the wall
editor's own `wall` and `erase` modes each give a click a specific meaning, and none of them should
also swing a door. Two more things take priority over it:

- **A token on top of a door wins.** The token was grabbed at pointerdown and the swing is never
  reached. Drag the creature out of the doorway, or use the door mode, which hit-tests the wall
  directly.
- **Mid-trace, every click is a corner**, so a run can be carried straight over a doorway.

The gesture has to coexist with panning, since the map can be dragged from anywhere. It does this
by reading the *pan* drag rather than starting its own: a click that never moved swings the door,
and a click that moved was a pan. It's the same `moved` flag that already decides whether releasing
the map clears the token selection, and a swing takes precedence over clearing it, because a DM
opening a door didn't ask to deselect anything.

`Escape` backs out of one thing at a time: the run first, then the tool. Escaping both at once
would lose a forty-corner trace to a keypress meant to end the last segment. `Backspace` drops the
last corner and has to call `preventDefault`, or the browser treats it as "go back" and loses the
session rather than one corner. `Enter` finishes, like the double-click.

Two clicks in the same corner count as one corner. That makes the second click of a double-click
harmless, and it's also what a DM who double-clicked by accident meant.

### Snapping happens on the client

`snapToCorner` is the third snapping rule on the client, after `snapOrigin` and `snapExtent`, and
it's here for the same reason: a run is drawn one click at a time, and the DM has to see each corner
land where it will actually sit, with the rubber band drawn from it. A snap applied on the server
would arrive after the polyline had already been drawn somewhere else, and the whole trace would
jump on release.

It also isn't `snap_to_cell` written twice. A token snaps according to its width, onto cell centres
or the corners between them. A wall has no width and always wants the corner, because that's where
the line is painted on the map.

**Alt places freely**, which is what makes a diagonal cave wall traceable on a square grid. Alt
means the same to this tool as to the draw tool (ignore what this would otherwise snap to), which
is why it's that key.

### On screen

Walls are drawn **over everything**, including the tokens, for a different reason than the shapes
are: a wall isn't about what's standing on it, it's the room the tokens are standing *in*, and it
has to be traceable across a crowded board.

Rose for solid walls and amber for doors, colours the board uses for nothing else. The rings use
gold, blue, white, violet and teal, and the drawing palette avoids all five. **An open door is drawn
dashed and a shut one solid**, matching what the line means for sight. The segment under the
pointer is drawn white, so a click is never a surprise. The run being traced is blue, like every
other in-progress thing on the board.

Solid walls are **always on the DM's screen: faint normally, full strength while the editor is
armed**. They're never on anyone else's, so the only question was how prominent to make them.
Faint is enough to answer "have I traced this room" during a fight without opening the panel.

**Doors are exempt and always stay legible**, because a door can be clicked at any moment and
anything clickable should look it. The same rule keeps the faintness consistent: the things drawn
faintly are exactly the things a click would do nothing to.

### The rail

The wall panel was the fourth on the left rail, and one more than the layout had room for:
`#tokentool` was the flex item that gave up height, and in an 860-pixel window it was squeezed to a
scrollbar and a heading. That was fixed elsewhere. The rail now shows **one editing panel at a
time** behind a tab strip, so the walls panel is a tab rather than a share of the rail's height,
and it doesn't have to be compact. The reasoning is in `rail.ts`.

Two things about this panel still matter. Closing the tab calls `WallTool.stop()`, and that's
necessary: `erase` and `wall` both take the left mouse button, and a mode left armed under a hidden
panel is a click doing something with nothing on screen to explain it. And the panel edits
whichever board is on screen: over a preview it traces the staged map, and its idle hint says so,
because solid walls look identical on both boards and tracing the next dungeon onto the one the
table is playing on is the mistake this feature makes possible.

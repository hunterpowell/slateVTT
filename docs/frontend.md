# The frontend shell

The camera, the left rail, the bottom-right corner and the right-hand column. Milestones 1, 20
and 24 between them.

Read this before touching `coords.ts`, `rail.ts`, `dock.ts`, `Stage.fit`/`fitToRect`, `#corner`,
or the order of the right-hand column. The rail and the dock look like the same widget and are
separate on purpose, and the two places where a plausible generalisation breaks something are both
below.

## The camera

Camera is `{ x, y, zoom }`. `screenToWorld` and `worldToScreen` are the only places coordinate math
lives. Render by setting the canvas transform once and draw everything in world coordinates;
hit-test in world coordinates too. The transform is
`ctx.setTransform(s, 0, 0, s, -cam.x * s, -cam.y * s)` with `s = cam.zoom * view.dpr`, in
`render.ts`, which is the only place device pixel ratio enters the chain.

This layer is the hardest part of the client to get right. That's why it was built and verified on
its own against a hardcoded map, before any WebSocket code existed, and why the two functions have
their own file with a unit test beside it. Everything downstream relies on them, and a sign error in
either shows up only as "the board feels wrong".

**The camera is a local in `start()`, and nothing outside the board holds one.** Anything that wants
to move it goes through `Stage`: `lookAt` for a creature, `fit` for the whole board. It's the same
rule `createRail` returning `void` enforces for the rail (below): the shape of the API allows only
one owner.

`fit` frames the play area if the DM has drawn one, and the whole image otherwise. A map load
doesn't do that: it frames the whole image, because the next thing that happens to a new map is
calibration, and the margin is part of what the DM needs to see. The fit control is used mid-fight
by someone who has lost the board, and the board is the part ruled into cells.

`fitToRect` puts a floor of one pixel on each side. `playRect` clips to the image and returns a
zero-width rectangle for a saved play area that no longer overlaps it (after a map is replaced with a
smaller image). Dividing by that zero gives an infinite zoom and a camera at `NaN`, and the board
doesn't come back without a refresh.

## The left rail: one panel at a time

The rail shows one of the DM's editing panels at a time, behind a tab strip. A new panel is an entry
in `RailTab` and in the array `main.ts` passes to `createRail`. It's never another `<aside>` stacked
on the others. Stacking is how the rail ran out of vertical room at four panels, and the strip
replaced it.

Which panel a control belongs on depends on where its field lives: `MapInfo` is the map tab, `Token`
is the token tab, and room-wide `RoomState` is the table tab.

That rule came from a mistake. `show_names` and `diagonals` sat under the token panel's form for
four milestones, separated from the token fields by a divider and two comments explaining that they
weren't token fields. A control that needs a paragraph explaining which panel it isn't on is on the
wrong panel. Moving them to a table tab removed the divider, both comments and the question.

Four rules come with the strip:

1. **A new panel is a `RailTab` entry, not an `<aside>`.** See above.
2. **Closing a tab must put down whatever that panel armed**, via the panel's `stop`. The
   calibration box and the wall editor both take the left mouse button, and a tool still holding it
   under a hidden panel makes a click do something with nothing on screen to explain it.
3. **A panel that goes inert in some state makes its tab inert too.** A tab leading to a panel that
   can do nothing misleads in the same way as a panel that looks armed and isn't.
4. **Only a click on a tab changes which tab is open.** Nothing on the board and nothing on the wire
   moves the rail.

Rule 4 came from experience and cost `createRail` its return value. Selecting a token used to open
the token tab, on the argument that picking a creature up off the board means you want to edit it.
That missed which thing is scarce. The rail is where the DM is working, and swapping the panel out
from under a half-traced wall to show a form nobody asked for costs more than the click it saves.
The selection was never at risk, since it's a ring on the board, and the token panel's `stop`
already relies on that. With that one caller gone nothing else changed the strip, so `createRail`
now returns `void` and the rule is enforced by the type rather than a comment.

The open tab is remembered in `localStorage` as `slate.rail.open`, validated against the panels
actually built rather than cast. It's the same line `panel.ts` draws for the initiative fold: how
much of a panel someone wants on their own screen is a per-person preference, not a `RoomState`
field like `diagonals`. The rail used to open nothing on connect, on the argument that the board
should come first. That forgot `docs/presence.md`: **a dropped socket reloads the page**, so "on
connect" also happens mid-evening, and a rail that emptied itself mid-fight made every reconnect
visible.

Rule 3 applies in both directions, as the staged board showed. When the staged map got its own
walls and fog mask, the wall and fog panels stopped being inert over a preview, and the fix was to
delete the CSS that greyed their tabs. The rule is that the tab and the panel agree. A tab wrongly
greyed out is the same bug as one wrongly active.

The draw tool isn't on the strip. It's the one panel everybody has and it's used in the middle of a
fight, so it stays pinned to the bottom of the rail. It's the same reason a door opens with no tool
armed: something used mid-combat shouldn't be behind a mode.

## The bottom-right corner

`#corner` is a right-anchored row holding the gesture hint, the fit control and the `/spells/`
link. They share the reason for being here: none of them arms anything, so none owes the rail a
`stop`, and none carries an unread count, so none needs a dock tab. That test is written on the
spells link in the markup, and a control that passes it belongs in the corner rather than in either
strip.

Two rules come with the row. **Only `#hint` grows**, so everything to its right keeps its position
and everything to its left would slide. That's why the link is last, and why the fit control went
before it rather than after. And anything here that describes the board hides with the board:
`body.covered` hides the zoom readout, the hint and the fit control together, because a zoom
percentage over a backdrop and an offer to frame a board nobody can see are both wrong.

### The hint is the mouse/trackpad switch

`#hint` is a button (milestone 45). Clicking it swaps between mouse and trackpad gestures, and its
text, written by `gestures.ts`, starts with the active mode and lists the gestures that mode has.
It passes the corner's test: it arms no tool and carries no count. It's the only thing in the
corner with `pointer-events` back on besides the fit control and the link.

- **Mouse** (the default): every wheel event zooms, exactly as before the switch existed.
- **Trackpad**: a wheel event with `ctrlKey` zooms at `PINCH_SENSITIVITY` (a pinch, or ctrl+wheel
  on a mouse, which is then fast), and a plain one pans by `deltaX`/`deltaY`. Browsers report both
  trackpad gestures as `wheel` events; Safari's pinch wasn't checked.

It's a switch because no browser API says which device sent a wheel event. Guessing from step size
was rejected: it depends on OS scroll settings and display scaling, and a wrong guess makes a mouse
wheel pan. Keeping mouse zoom unchanged matters more than trackpad convenience, so it's off by
default.

The switch is the hint line because that's where someone stuck without a pan looks. With it off, a
trackpad can't pan at all: a click-drag is a selection box (`docs/tokens.md`, *The box*), a
two-finger slide zooms, and most touchpads have no right-drag. It's in `localStorage`, like the
initiative fold and the volume, and never on `RoomState`.

`PINCH_SENSITIVITY` is a starting value. Nobody had a trackpad to tune it on when it shipped, and
no suite can see it, so it's tuned on the first report from someone who uses one.

The fit control is also for everyone, unlike most buttons. A player who has zoomed into a corner is
as lost as the DM would be, so it's built outside the `identity.isDm` half of `onWelcome`.
`tools/drive-fit.mjs` opens two browsers for that reason.

## The right-hand column: three things, in this order

Presence strip pinned at the top, then the initiative panel, then the dock at the bottom. The order
matters. The presence strip is at the top because that's the one edge of the column that never
moves: the initiative panel folds and the dock grows upward, so anything placed between them shifts
when either changes size. Chips that jump around while you're trying to read who's connected are
worse than no chips.

The initiative panel and the dock share a flex column for the same reason the left rail is one: the
panel's height depends on how many creatures are in the fight, so nothing below it can be pinned at
a fixed offset.

## The dock is not the rail generalised

`dock.ts` is a second tab strip in a separate file. Four things differ, and a shared implementation
would need a branch for each:

- **Every tab is built on every connection.** Rail panels are built once per socket by `onWelcome`,
  and only for the DM. The dock's tabs (`chat`, `notes`, `sound`) are everybody's.
- **Nothing behind it arms the canvas, so there's no `stop`.** Rail rule 2 has no counterpart here.
- **A tab here can carry an unread count.** No rail tab has needed one.
- **Its panels stack.**

The last one is the real difference. One rail panel is open at a time because rail panels are
editing modes, and a second armed mode is a bug. Nothing in the dock is a mode. A log and a
scratchpad are both things you read while something else is going on, so opening one must not close
another.

The dock grows upward from the bottom, so opening a panel never moves the initiative panel above it.
Its strip is its last child rather than its first: the edge that grows is the top one, so a strip
placed first would slide down the screen every time a panel was toggled. It's the rail's argument (a
tab that moves when you toggle its neighbour is hard to click) applied at the other end of the
column.

See `docs/chat.md`, `docs/notes.md` and `docs/sound.md` for what lives in it, and
`docs/presence.md` for the strip above it.

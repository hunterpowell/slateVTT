# The frontend shell

The camera, the left rail, and the right-hand column. Milestones 1, 20 and 24 between them.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`coords.ts`, `rail.ts`, `dock.ts`, or the order of the right-hand column** — the rail and the dock
look like the same widget and are deliberately not, and the two places a plausible generalisation
breaks something are both below.

## The camera

Camera is `{ x, y, zoom }`. Two functions, `screenToWorld` and `worldToScreen`, are the only places
coordinate math lives. Render by setting the canvas transform once
(`ctx.setTransform(zoom, 0, 0, zoom, -cam.x * zoom, -cam.y * zoom)`) and draw everything in world
coordinates; hit-test in world coordinates too.

Getting this layer right is the hardest part of the client, which is why it was built and verified
standalone against a hardcoded map with no networking, before any WebSocket code existed. It is also
why the two functions are a file of their own with a unit test beside them: everything downstream
trusts them, and a sign error in either is visible only as "the board feels wrong".

## The left rail: one panel at a time

**The rail shows one of the DM's editing panels at a time, behind a tab strip.** A new panel is an
entry in `RailTab` and an entry in the array `main.ts` passes to `createRail`. It is never another
`<aside>` stacked on the others — that is how the rail ran out of vertical room at four panels, and
the strip is what replaced stacking rather than what decorated it.

**Which panel a control belongs on is decided by where its field lives**: `MapInfo` is the map tab,
`Token` is the token tab, and room-wide `RoomState` is the table tab.

That rule was extracted rather than designed. `show_names` and `diagonals` sat under the token
panel's form for four milestones, separated from the token fields by a divider and two comments
explaining that they were not really token fields. The comments were the smell: a control that needs
a paragraph saying which panel it is *not* on is on the wrong panel. Moving them to a table tab
deleted the divider, both comments, and the question.

Four rules come with the strip:

1. **A new panel is a `RailTab` entry, not an `<aside>`.** See above.
2. **Closing a tab must put down whatever that panel armed**, via the panel's `stop`. The
   calibration box and the wall editor both take the left mouse button, and a tool still holding it
   under a hidden panel is a click doing something with nothing on screen saying why.
3. **A panel that goes inert in some state must make its tab inert too.** A way in to a panel that
   can do nothing is the same lie as the panel sitting there looking armed.
4. **Only a click on a tab changes which tab is open.** Nothing on the board, and nothing on the
   wire, moves the rail.

Rule 4 was learned rather than designed, and it cost `createRail` its return value. Selecting a
token used to open the token tab, on the argument that picking a creature up off the board is the
request to edit it. What that missed is which thing is scarce: the rail is *where the DM is
working*, and swapping the panel out from under a half-traced wall to show a form nobody asked for
costs more than the click it saved. The selection was never the thing at risk — it is a ring on the
board, which is exactly what the token panel's `stop` already relies on. With that one caller gone
there was no second hand on the strip at all, so `createRail` now returns `void`: the rule is in the
type rather than in a comment asking future callers to respect it.

The rail's memory is the other half of the same rule. The open tab is in `localStorage` —
`slate.rail.open`, validated against the panels actually built rather than cast — which is the line
`panel.ts` draws for the initiative fold, and drawn for the same reason: how much of a panel
somebody wants on their own screen is nobody else's business, so it is a preference and not a
`RoomState` field like `diagonals`. The rail used to open nothing on connect, on the argument that
the change was about giving the board back. That argument forgot `docs/presence.md`: **a dropped
socket reloads the page**, so "on connect" is not only the start of an evening, and a rail that
empties itself mid-fight is the reconnect making itself felt.

Rule 3 cuts both ways, and the staged board is the proof. When the staged map grew walls and a fog
mask of its own, the wall and fog panels stopped being inert over a preview — and what got deleted
was the CSS that greyed their tabs. The rule is not "grey the tab", it is "the tab and the panel
agree"; a tab wrongly greyed is the same defect as a tab wrongly live.

**The draw tool is deliberately not on the strip.** It is the one panel everybody has and it is used
in the middle of a fight, so it stays pinned to the bottom of the rail. Same reasoning as a door
swinging with no tool in hand: a thing used mid-combat does not get put behind a mode.

## The right-hand column: three things, in this order

Presence strip pinned at the top, initiative panel, dock at the bottom. **The order is not a layout
choice.** The presence strip is at the top because that is the one edge of the column that never
moves — the initiative panel folds and the dock grows upward, so anything placed between them shifts
when either changes size. Chips that jump around while you are trying to read who is connected are
worse than no chips.

The initiative panel and the dock share a flex column for the same reason the left rail is one: the
panel's height is however many creatures are in the fight, so nothing below it can be pinned at a
fixed offset.

## The dock is not the rail generalised

`dock.ts` is a second tab strip and a separate file. Four things differ, and each of them is a
branch that a shared implementation would have to carry:

- **Both its tabs are built on every connection.** Rail panels are built once per socket by
  `onWelcome`; the dock's are not conditional on being the DM.
- **Nothing behind it arms the canvas, so there is no `stop`.** Rail rule 2 has no analogue here.
- **A tab here can carry an unread count.** No rail tab has ever wanted one.
- **Its panels stack.**

That last one is the real difference. One rail panel is open at a time because rail panels are
editing **modes**, and a second armed mode is a bug. Nothing in the dock is a mode — a log and a
scratchpad are both things you read while something else is going on, so opening one must not close
the other.

**It grows upward from the bottom**, so opening a panel never moves the initiative panel above it.
And **its strip is its last child** rather than its first: the edge that grows is the top one, so a
strip placed first would slide down the screen every time you toggled a panel. That is the rail's
own argument — a tab that moves when you toggle its neighbour is a tab you cannot aim at — pointed
at the other end of the column.

See `docs/chat.md` and `docs/notes.md` for what lives in it, and `docs/presence.md` for the strip
above it.

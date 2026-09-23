# Slate roadmap

What isn't built yet, and the order everything was built in.

`.claude/CLAUDE.md` holds the rules that apply to every feature and is loaded into every session.
This file isn't, because it's design for features that don't exist yet and most sessions don't need
it. `docs/` has one file per subsystem explaining why each built feature works the way it does, and
`docs/history.md` records each milestone as it was built: what it cost, what the design got wrong,
and what building it found.

**Read this before starting a milestone.** The invariants in CLAUDE.md are what let everything here
be added without a rewrite. If a decision here conflicts with one of them, the invariant wins and
this file changes.

When a milestone lands, mark it in the list below with the date and where it's documented, and move
its design, with notes on what building it found, into `docs/history.md`.

## Build order

Don't work ahead. Each milestone should run and be usable before starting the next.

1. Client only, no server. Hardcoded map image, pan, zoom, drag a token around. No networking.
2. Server with a single hardcoded room, no identity, no permissions. Two browser tabs stay in sync.
3. Identity (DM secret, player roster) and the permission check.
4. Initiative panel: add, reorder, next/previous turn, round counter.
5. Debounced JSON persistence and restore on boot.
6. Map upload and grid calibration UI.
7. Package for Windows session hosting and deploy behind a Cloudflare Tunnel.

Everything from 8 on was planned after the original seven: 17 and 18 after 16 landed, 19–24 after
18, and 27–29 on 2026-08-18 after 26. That batch was the first written down while nothing in it
existed, and all three were written to overturn something the roadmap already said (each entry names
what). 28 also overturned part of its own design.

**Everything through 44 is built except 29.** 25, 26, 34 and 38 were never planned and were built out
of order; their entries in `docs/history.md` say why. 33 is multi-room, which was unscheduled until a
Halloween one-shot became the second room it was waiting for.

8. Map library: list `maps/`, pick one, remember its calibration. `docs/maps.md`.
9. Token lifecycle: create and delete tokens with an image, a size and a reassignable owner.
   `docs/tokens.md`.
10. Staged map, and the DM preview mode that makes it possible to calibrate. `docs/maps.md`.
11. Hidden tokens, then hit points, both visible only to the DM. `docs/tokens.md`.
12. Preparing the next room: `staged_pos` and `staged_only` on tokens. `docs/tokens.md`.
13. Movement ruler. `docs/drawings.md`.
14. Drawing layer. `docs/drawings.md`.
15. Wall and door editor. `docs/walls.md`.
16. Fog of war: 16a automatic line of sight, 16b the DM's manual override. `docs/fog.md`.
17. The movement pass: the trail, the diagonal switch, and the DM's wall hint. `docs/drawings.md`.
18. The initiative panel: portraits, hit points, and clicking a row to find the creature.
    `docs/tokens.md`.
19. Ping. `docs/drawings.md`.
20. Walls and fog overrides on the staged map. `docs/walls.md`, `docs/fog.md`.
21. Room lighting. `docs/fog.md`.
22. Undo, for the DM. `docs/undo.md`.
23. Whisper and shout. `docs/chat.md`.
24. The scratchpad. `docs/notes.md`.
25. Shift-click selection and the group drag. Out of order. `docs/tokens.md`.
26. The panel pass: a table tab, a folding initiative panel, softer fog edges, solo sight. Out of
    order. `docs/tokens.md`, `docs/fog.md`.
27. The presence pass: connected players, "your turn", reconnect on drop, player-picked colours.
    2026-08-19. `docs/presence.md`.
28. Cursors. 2026-08-19. `docs/presence.md`.
29. **Not built.** Party sight and split sight. Design below.
30. The backdrop. 2026-08-22. `docs/maps.md`.
31. Prepared maps, remembered per URL. 2026-08-22. `docs/maps.md`.
32. Writable libraries. 2026-08-22. `docs/maps.md`.
33. Multi-room. 2026-08-23. `docs/rooms.md`.
34. Player view. 2026-08-25. Out of order. `docs/fog.md`.
35. The controls pass: the rail pass, and the DM's own pointer. 2026-08-27. `docs/frontend.md`,
    `docs/presence.md`.
36. The damage box. 2026-08-31. `docs/tokens.md`.
37. The status page. 2026-08-31. `client/status/README.md`.
38. Isometric grids. 2026-08-31. Out of order. `docs/maps.md`.
39. Light sources. 2026-09-01. `docs/fog.md`.
40. The loaner die. 2026-09-03. `docs/dice.md`.
41. The room's music. 2026-09-06. `docs/sound.md`.
42. Duplicate and fit board. 2026-09-09. `docs/tokens.md`, `docs/frontend.md`.
43. Token markers. 2026-09-09, revised 2026-09-10. `docs/tokens.md`.
44. The keyboard pass. 2026-09-17. `docs/tokens.md`.

## 29. Party sight and split sight

Not built. A switch between today's party-shared fog and a per-player `visible`, so the rogue
scouting ahead sees what the rest of the table doesn't.

This reopens a question milestone 26 answered no, and it can be reopened because 26 answered its own
closing argument. That argument was *"there is no defensible answer for what the DM's own board
should then show"*, and `solo.ts`, which shipped in the same milestone, is that answer: the DM's
board shows the party union, and the sight check is how they ask about one creature. That stays true
under either setting, so the tool built instead of this feature is what makes it defensible.

**Building this means turning the sight check back on**: `SOLO_SIGHT` in `fogtool.ts`, which
milestone 34 switched off. That's consistent with why it went off. The check went off because player
view answers *what is the table looking at* for the whole party at once, and once `visible` is
per-player there's no single answer for it to mirror. Player view then has to name somebody, and
asking about one creature is no longer a narrower version of anything. Each of the two controls is
redundant exactly while the other one gives the accurate answer.

What hasn't been answered is the objection in the fog design as originally written (*Fog of war* in
`docs/history.md`): "Five people narrating to each other on Discord get nothing out of per-player fog
but confusion and five times the state." That's why this is a switch and not a replacement, and why
it's the middle of three possible depths rather than the deepest.

### Three depths, and why the middle one

- **Creatures only.** `unseen_by_table` becomes `unseen_by(&Identity, ...)`, the fog picture stays
  identical for everybody, and only *which creatures you're sent* changes. By far the cheapest, and
  it needs no client code, since it's exactly what `hidden` already does. Rejected as too little: a
  lit room with a creature silently missing from it looks the same as an empty room, and the table
  can't tell which they're looking at.
- **Per-player `visible`.** What ships. `revealed` and `known` stay party-shared and persisted
  exactly as now, so the explored map stays the party's map. That keeps the board navigable, and it
  stops a player who owns no token from staring at a black screen.
- **Full per-player, `revealed` too.** Three sets times seven, persisted times seven, and each
  player's map becomes a different map. This is the version the fog design argues against by name,
  and that argument hasn't weakened.

### The switch is on `RoomState`, on the table tab

`fog`, `vision_ft` and `lighting` are on `MapInfo` because each is a fact about the dungeon's
geometry: open ground versus rooms. Whether the party splits vision is a fact about how this table
plays, like `show_names` and `diagonals`, and milestone 26's rule is that a panel mirrors where its
field lives. It's an enum with a `Party` default, like `Lighting`, so no existing save changes
behaviour.

The counter-argument is real and was declined: on `MapInfo` it would sit beside the other three sight
fields and get per-URL memory for free. Recorded so it isn't argued again.

### The cost is more than the six call sites it looks like

Read this part first. Milestone 26 counted `unseen_by_table` becoming `unseen_by(client)` at six
sites and stopped there. Two more things follow, and neither is small:

- **`struct Sight` gains a per-identity dimension.** It's the snapshot of "what the table held a
  moment ago" that `refresh_fog` compares against, and its three fields (`fog`, `seen`, `shapes`) are
  each one answer for the whole table. Under split sight each becomes an answer per recipient, or the
  room can't work out which client is owed which frame.
- **So `was_unseen` stops being a bool.** CLAUDE.md: *"Every `was_unseen` on an event asks the same
  question, evaluated before the change it describes."* Under split sight it's a different answer per
  recipient. Milestone 16a recorded what missing one of those sites costs (a `TokenRemoved` naming an
  id a client has never held, which reveals that the id exists), and that was the last time this
  question changed shape. This would be the third.

`visible` also gets a per-player counterpart, memory-only and derived on boot like `known`. The union
is still needed: `revealed` takes the union of all sight, and the DM's board still shows the whole
party's.

`FogView` stops being the one message identical for every recipient while the switch is on. Three
files say that in prose and need amending rather than deleting, because under `Party` it still holds.
That's also the argument for the switch being an enum on the room rather than a rewrite.

It needs another three-browser driver. `tools/drive-chat.mjs` is the precedent: the assertion is that
player A is sent a creature and player B isn't, and two connections can't show that. Use fixed debug
ports, as milestone 26 established.

## Unscheduled

### A wall hint on the player's screen

Workshopped 2026-08-11 and not scheduled: playtest the current arrangement first and count how often
the DM actually says "there is a wall there". Twice a session isn't a feature. This note exists so
the reasoning isn't worked out again, and not worked out wrong: the naive version is a
dungeon-mapping exploit, and there are two versions that aren't.

The DM already has this hint (milestone 17): a drag that crosses a wall shows amber on their screen.
Players don't, because they're never sent walls.

Both versions depend on an observation from the fog design: in explored territory the party can
already see where the walls are, because they infer the geometry from the edges of the fog. That's
the stated reason walls stay out of their snapshot, and it works the other way too. A hint gated on
both ends of the move being in `revealed` tells them almost nothing they aren't already looking at,
and the probe stops working as soon as they drag into the dark.

**Its specific leak is secret doors.** A shut door in an explored corridor looks like a wall in the
fog, so a move that fails to show amber through one reveals that it's a door. The mitigation is what
the DM would do anyway: trace a secret door as `Solid` and convert it once the party finds it.

Two ways to build it, and they're not close in cost:

- **Send the player the walls that bound explored cells.** Straightforward, and expensive where this
  project is least willing to spend: it means a `WallView`, a filter that changes shape every time
  the fog grows, and the end of "walls reach the DM or nobody", which is one of the few rules with no
  exceptions and so nothing to get wrong.
- **Derive it on the client from the fog it already has.** Amber when the move crosses the boundary
  of `known`. Nothing new on the wire, no new filter, and it can't leak because it reads only what
  that client was already sent.

The second is clearly better and has one problem: under `Dynamic` lighting, a fog edge is usually
just the vision radius rather than a wall, so it would show amber constantly and mean nothing. Under
milestone 21's `Room` lighting, a fog edge is almost always a wall, because the fill is bounded by
them. So reopen this after `Room` lighting has been played on, not before. (The same session was also
to answer whether an archway needs its own `WallKind`. Milestone 21's revision answered that one: it
doesn't.)

### Also left open

Smaller things the record leaves open. Each is explained in its milestone's entry in
`docs/history.md`.

- The "your turn" notice fires for the DM on every monster's turn. If play says that's noise, a
  `localStorage` off switch is the cheap follow-up (27b).
- Marquee select. The selection set exists and only the gesture would be new, but a drag on empty
  ground is already pan (25).
- A fog preview on the staged map. If it's ever wanted it's client-only; don't put it in the room
  (20).
- `tools/audit-uploads.mjs` always lists `track-` copies as unreferenced, because `audio` isn't
  saved. Fixing it means reading live room state, which the audit exists to avoid (41).
- `SLATE_STATE` as a directory, if there are ever enough rooms to want one, and a DM secret per room,
  if a link ever goes to someone who shouldn't reach the other campaign (33).

## Lessons from building

Patterns that recur across subsystems. Each is explained in the milestone named, in
`docs/history.md`.

- **Invariant 2 protects a field being added, not a field changing shape.** The default that lets an
  old save load also discards what a reshaped field held. Only a test with the old JSON written by
  hand catches it (20).
- Staging something that already reaches the DM or nobody is nearly free, because there's no filter
  to widen (20).
- A feature that changes what a filter is given, rather than what it decides, is nearly free (21,
  35b).
- A feature that only asks a question the client already has the data for is nearly free (26, 27b).
- When a neighbouring subsystem already answers a question, the burden is on diverging from it (21).
- When a request seems to need a bigger version of something you have, check whether it needs that
  thing at all (30).
- A non-goal that names a category rather than a behaviour can only be obeyed. Find out which
  behaviour was meant (40, 41).
- A feature that adds a dimension to something shared makes every tool that reads it wrong at once
  (33).
- Since 27c, every "on connect" decision in the client is also a mid-session decision (35a).
- Before gating a new gesture on `is_dm`, check whether the hit test already limits it (25).
- A filter that stops asking about a role has to ask about a pair, and the pair includes the sender
  (23).
- The undo ring may only hold state the person undoing wrote. Keeping something off the disk keeps it
  off the ring for free (22, 41).
- Invariant 4 fails safe only through redaction. The first public field on a redacted type needs a
  real permission check (43).
- A field that's true for two unrelated reasons isn't a status (37).
- Rebuilding a panel wholesale is fine until a control in it is used twice in a row (36).
- A server test can't see a missing button. A permission test proves the room allows something; only
  a driver proves someone can do it (40).
- A panel describing the board isn't evidence about the board, and a driver asserting the DOM isn't
  asserting the paint (38, 43).
- A test that fills a mailbox is measuring something else. When a sample size is a test's only
  defence, assert it (40).
- A driver may assume neither the map it was written against, where the server puts a token, nor the
  shape of a widget (21, 26, 32).
- Some conflicts are only visible in the subsystem doc, not the code. Read it before designing
  against a subsystem (25).

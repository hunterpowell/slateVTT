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

**Everything through 54 is built.** 25, 26, 34 and 38 were never planned and were
built out of order; their entries in `docs/history.md` say why. 33 is multi-room, which was
unscheduled until a Halloween one-shot became the second room it was waiting for.

49–52 were planned on 2026-10-14 from the notes Hunter took running a one-shot as the DM, and are
all built.

53 and 54 came on 2026-10-19 from playtest feedback: Hunter's brother after running sessions on the
second site, and the main campaign's DM. The same feedback asked for a sidebar of maps, which Hunter
set aside: the shelf already keeps each map's walls and encounter, and switching between several maps
in play is the scene system.

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
29. Party sight and split sight. 2026-10-19. `docs/fog.md`.
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
45. Marquee select, right-drag pan, and trackpad gestures. 2026-09-23. `docs/tokens.md`,
    `docs/frontend.md`.
46. A second site, and the roster the DM edits. 2026-09-24. `docs/rooms.md`.
47. Kept lines and freehand drawing. 2026-10-05. `docs/drawings.md`.
48. A player's phone. 2026-10-09. `docs/frontend.md`.
49. Initiative: the round reset, and the DM's monster roll. 2026-10-14. `docs/tokens.md`,
    `docs/dice.md`.
50. Round dividers in chat. 2026-10-14. `docs/chat.md`.
51. Encounters on the shelf. 2026-10-15. `docs/maps.md`, `docs/tokens.md`.
52. Ghost and path, then move. 2026-10-19. `docs/drawings.md`, `docs/undo.md`.
53. Players enter their own initiative. 2026-10-19. `docs/tokens.md`.
54. Pointing at the backdrop: pings, cursors and a fading pen. 2026-10-19. `docs/maps.md`.

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
- The initiative panel's Clear button is hidden while the panel is folded. It probably contributed
  to the round bug fixed in 49 and may not need changing once removing the last row resets the
  round (one-shot, 2026-10-14).
- A fog preview on the staged map. If it's ever wanted it's client-only; don't put it in the room
  (20).
- `tools/audit-uploads.mjs` always lists `track-` copies as unreferenced, because `audio` isn't
  saved. Fixing it means reading live room state, which the audit exists to avoid (41).
- `SLATE_STATE` as a directory, if there are ever enough rooms to want one (33). A DM secret per room
  was the other half of this line; a link for somebody who mustn't reach the campaign now gets a
  second site instead (46).
- Under split sight, deleting a token still re-sends every player's initiative and shapes panels,
  because `delete_token`'s events aren't narrowed the way `refresh_fog`'s are. Nothing leaks, but
  it can tell a player that something only a friend could see changed (29).
- Split sight's cost per drop was measured on a desktop, not on the Pi (29).

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
- A filter that answers per recipient also has to decide who is sent anything. An unchanged frame
  re-sent still tells the recipient that something changed somewhere (29).
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

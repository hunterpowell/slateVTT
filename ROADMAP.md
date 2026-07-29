# Slate roadmap

What is not built yet, and the order it gets built in.

`.claude/CLAUDE.md` describes Slate as it is today and is loaded into every session. This file is
not, deliberately — it is design for features that do not exist, and it would otherwise cost
context in every session that has nothing to do with it.

**Read this before starting a new milestone.** The invariants in CLAUDE.md are what make
everything below addable without a rewrite; if a decision here turns out to conflict with one of
them, the invariant wins and this file is what changes.

## Build order

Do not work ahead. Each milestone should run and be usable before starting the next.

1. Client only, no server. Hardcoded map image, pan, zoom, drag a token around. No networking.
2. Server with a single hardcoded room, no identity, no permissions. Two browser tabs stay in sync.
3. Identity (DM secret, player roster) and the permission check.
4. Initiative panel — add, reorder, next/previous turn, round counter.
5. Debounced JSON persistence and restore on boot.
6. Map upload and grid calibration UI.
7. Package for Windows session hosting and deploy behind a Cloudflare Tunnel.

Milestones 1–14 are done. Everything from 8 on was planned after the original seven, and the
order of what remains is deliberate:

8. **Done.** Map library — list `maps/`, pick one, remember its calibration. The smallest thing
   on this list and the only one that touched nothing else.
9. **Done.** Token lifecycle — the DM creates and deletes tokens, with a custom image, a size in
   grid units, and a reassignable `owner`. That last part is the whole wild shape story: build a
   large token, hand it to the player, take it back or delete it when the spell ends. See
   *Tokens* in CLAUDE.md for what the size rule turned out to be. Deleting reaches into
   initiative today and will have to reach into anchored drawings when they exist.
10. **Done.** Staged map, and the DM preview mode that makes it calibratable. This is where
    `snapshot_for` started genuinely filtering rather than merely having the shape for it, and
    where `message_for` grew its first arm that drops a message for *who a recipient is*. See
    *Staged maps* in CLAUDE.md. The pattern turned out to be three lines in each of those two
    functions; the rest of the milestone was the client, which had to learn that "the map" and
    "the map on screen" are different questions.
11. **Done.** `hidden` on tokens, then hit points. Both DM-only-visible. See *Hidden tokens and
    hit points* in CLAUDE.md.

    Per-field redaction turned out to be a type rather than a rule: `TokenView`, built by
    `Token::view_for`, is what the wire carries, so a secret added to `Token` and forgotten is
    absent from the wire instead of broadcast. That is the shape milestone 12's `staged_pos` and
    `staged_only` should be filtered with — add them to `Token`, and they reach nobody until
    `view_for` says so.

    Two things cost more than expected and are worth knowing before building on this. Telling
    "it just vanished" from "you were never told" needs the token's *previous* `hidden`, which
    `message_for` cannot read off `&self` — hence `was_hidden` on the events. And a hidden
    creature's initiative row had to be filtered too, which means a token edit can now have to
    rebuild the panel; a feature that hides something and leaves it named in a panel has not
    hidden it.
12. **Done.** Preparing the next room — `staged_pos` and `staged_only` on tokens, and the reversal
    of milestone 10's rule that nothing in preview is interactive. See *Preparing the next room*
    in CLAUDE.md.

    Milestone 11's guess was right: per-field redaction was already a type, so the two fields
    reached nobody until `view_for` named them, and the interesting work was elsewhere. Three
    things cost more than the state model did.

    `was_hidden` had to become `was_unseen`. There are two independent reasons the table cannot
    see a token now, they compose, and every filter has to ask about both — so the question moved
    onto `Token::unseen()` and nothing reads either field for it directly. Anything that filters
    on one and forgets the other is a leak, and a rename is cheaper than remembering.

    Promote stopped fitting the existing events. The DM needs a whole token, because their client
    holds two fields that have just been emptied and no `TokenMoved` can say so; the table needs a
    creation or a move depending on whether they have met it. That is `Event::Promoted`, three
    arms. And discarding a plan needed `Event::TokenPlanChanged`, which reaches the DM alone —
    reusing `TokenChanged` would have sent players a frame identical to what they already held,
    which carries no data and still announces the moment the DM changed their mind.

    The client half was the milestone-10 shape again: `shownPos` is `shownBoard`'s twin, one
    function answering "where is this token on the board that is on screen", and everything that
    draws or hit-tests goes through it. Ghosting was deleted rather than adjusted, as predicted.
13. **Done.** Movement ruler. See *Distance* in CLAUDE.md, which was reworded rather than the code
    bent to fit it: counting a diagonal step as one cell makes every reading a multiple of five,
    which is what the table counts in, and "straight-line" no longer described what ships.

    The drawing was the easy half. Two things were not.

    A ruler is not the dragger's alone — every client draws one for any token it sees moving — and
    that turned out to need nothing new on the wire. `TokenMoved` already carries `dragging`, and a
    watcher's copy of a token sits at its settled position until the first drag frame lands, which
    is exactly the origin. Read it a frame later and the ruler measures from itself.

    What it does need is a timeout for the client that disconnects mid-drag and never sends its
    drop, and the first guess at that was wrong by an order of magnitude. Drag frames come from
    `pointermove`, so a drag that pauses sends nothing at all; a ruler that expires after a second
    of silence vanishes off the table's screens while the DM is still holding the token. Caught by
    driving two clients at once, which is the only way that arm shows up.
14. **Done.** Drawing layer. See *Drawings* in CLAUDE.md.

    Two decisions made this bigger than the state model, and both were the more expensive branch.

    An ephemeral shape is *shared* — everyone watches the sweep — which means it is on the wire
    rather than local, and so it needed the `dragging` protocol a second time at shape scale. What
    it did not need was the ruler's timeout: the room is told when a socket closes, so a stranded
    sketch dies on `Disconnected`. Nothing announces that a *drag* stopped, which is why milestone
    13 had to guess and this one does not.

    And a circle tints the cells it covers as well as drawing an outline, which meant a point-in-
    shape test — and that turned out to pay for itself twice, because it is also what makes
    click-to-erase free. The tint is where this feature openly disagrees with *Distance*: a
    diagonal step costs one cell there, so "within 20 ft" is a square, while a circle here is a
    circle. Different questions, left different on purpose.

    The thing worth knowing before fog: **anchor visibility could not wait for it.** This file
    filed "an aura on a monster in the dark advertises where it is standing" under fog of war, but
    `hidden` has existed since milestone 11, so the rule shipped here — through `Token::unseen`, so
    both reasons compose. Adding shapes without it would have been a leak the day it landed.

    `Event::ShapesChanged` also had to be gated: emitting it on every token hide would tell the
    table *something happened* even when nothing was drawn on that token. Same gate the initiative
    panel already used, and the second time that trap has come up.
15. Wall and door editor. Polyline authoring — click, click, double-click to end — snapped to
    grid corners, with a modifier for free placement. This is not polish: per-segment click-drag
    across a two-hundred-segment dungeon is what makes people quietly stop using fog of war.
16. Fog of war.

## Drawings

Built — see *Drawings* in CLAUDE.md for what shipped. What remains here is the part that is still
design, because it depends on a milestone that does not exist yet:

Once fog exists, shapes are filtered server-side like everything else, all-or-nothing on
overlap: if any cell a shape covers is visible, the whole shape is sent. Drawing shapes
underneath the fog overlay and calling them hidden would put the data on the client and paint
over it, which is precisely what invariant 4 forbids. That filtering goes in `shapes_for`, which
already exists and already withholds a shape whose *anchor* the recipient cannot see — the arm
that could not wait for fog, since `hidden` predates it. An anchored shape's visibility follows its
anchor token's rather than its own footprint, which is what that arm already does.

## Fog of war and walls

Do not implement this ahead of its milestone. The following constraints exist so it can be
added without a rewrite — they are already reflected in the rules in CLAUDE.md:

- Per-client `mpsc` instead of `broadcast`
- `Event` separate from `ServerMsg`
- `snapshot_for(client)` instead of `snapshot()`
- Grid-unit token positions, which make the token-to-cell lookup free
- `coveredCells`, which already answers "which cells does this shape occupy" for the drawing
  layer — the same question a shape's fog visibility asks, on the client side of it

Cell-based visibility over the grid, using symmetric shadowcasting.

**Fog is party-shared, not per-player.** One `revealed` bitset (explored terrain, persistent)
and one `visible` bitset (current line of sight), each the union over every player-owned token.
Five people narrating to each other on Discord get nothing out of per-player fog but confusion
and five times the state. Terrain gates on `revealed`; tokens gate on `visible`. Vision comes
from tokens a player *owns*, so handing a token over grants vision with no extra rule.

**Walls are `Vec<Segment>` in image pixels.** A wall traces a feature painted on the map, so it
is anchored to the art and not to a cell; stored in grid units, every wall would slide off the
wall it was tracing the moment the DM recalibrated. See invariant 1 — this is not an exception
to it. Calibrate the grid before tracing walls.

**Walls and doors never enter a player's snapshot.** Not sent-and-not-rendered — genuinely
absent, per invariant 4. Players infer the geometry from the edges of the fog.

Doors are walls carrying an open/closed state, toggled by the DM only. Tokens do not block line
of sight; only walls do. The play-area boundary is an implicit wall, so vision does not spill
into the void off the edge of the map.

Vision range is one DM-set radius per map, stored in feet on `MapInfo` and converted to cells
where it is used. It needs a generous value in `MapInfo`'s `Default` impl: the container-level
`#[serde(default)]` means a save written before the field existed would otherwise load it as
zero, and every restored room would go pitch black.

The DM also gets a manual override, independent of line of sight. It is a tri-state per cell —
`Auto`, `ForceRevealed`, `ForceHidden` — and *not* a write into `revealed`, because a manual
hide that merely clears `revealed` evaporates the next time a token has line of sight on that
cell. The reveal tool is a flood fill bounded by walls, and it previews before it commits: one
gap in a traced room otherwise reveals the whole dungeon in a single click, and there is no undo.

Visibility is recomputed in `apply`, never in the visibility filter — the filter runs against
`&self` while the client map is borrowed, so it cannot mutate bitsets, and it is better kept
pure regardless. Recompute on drop, not on drag frames: the shadowcast is cheap enough at 30 Hz,
but shipping a bitset thirty times a second is not. A bitset does not fit the frame cap as a
JSON array of per-cell values either — pack it into a single string field. That is still one
readable frame in devtools, which is what the wire protocol rule actually protects.

Recalibrating the grid invalidates the bitsets, which are inherently grid-space. Loading a new
map clears them outright — and promoting a staged map is loading a new map, so it clears them
too. Walls go the same way for the same reason. Staging pre-traced walls alongside the map they
belong to is the scene concept CLAUDE.md rules out, not this.

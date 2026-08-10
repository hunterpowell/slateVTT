# Slate roadmap

What is not built yet, and the order it gets built in.

`.claude/CLAUDE.md` holds the rules that hold across every feature and is loaded into every
session. This file is not, deliberately — it is design for features that do not exist, and it
would otherwise cost context in every session that has nothing to do with it. `docs/maps.md`,
`docs/tokens.md` and `docs/drawings.md` are out of context for the same reason from the other
direction: they are why each built feature is the shape it is, and only the session touching that
subsystem needs them.

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
   *Tokens* in `docs/tokens.md` for what the size rule turned out to be. Deleting reaches into
   initiative today and will have to reach into anchored drawings when they exist.
10. **Done.** Staged map, and the DM preview mode that makes it calibratable. This is where
    `snapshot_for` started genuinely filtering rather than merely having the shape for it, and
    where `message_for` grew its first arm that drops a message for *who a recipient is*. See
    *Staged maps* in `docs/maps.md`. The pattern turned out to be three lines in each of those two
    functions; the rest of the milestone was the client, which had to learn that "the map" and
    "the map on screen" are different questions.
11. **Done.** `hidden` on tokens, then hit points. Both DM-only-visible. See *Hidden tokens and
    hit points* in `docs/tokens.md`.

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
    in `docs/tokens.md`.

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
13. **Done.** Movement ruler. See *Distance* in `docs/drawings.md`, which was reworded rather than the code
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
14. **Done.** Drawing layer. See *Drawings* in `docs/drawings.md`.

    Two decisions made this bigger than the state model, and both were the more expensive branch.

    An ephemeral shape is *shared* — everyone watches the sweep — which means it is on the wire
    rather than local, and so it needed the `dragging` protocol a second time at shape scale. What
    it did not need was the ruler's timeout: the room is told when a socket closes, so a stranded
    sketch dies on `Disconnected`. Nothing announces that a *drag* stopped, which is why milestone
    13 had to guess and this one does not.

    And a circle tints the cells it covers as well as drawing an outline, which meant a point-in-
    shape test — and that turned out to pay for itself twice, because it is also what makes
    click-to-erase free. The tint is where this feature openly disagrees with *Distance*, further
    down the same file: a diagonal step costs one cell there, so "within 20 ft" is a square, while
    a circle here is a circle. Different questions, left different on purpose.

    The thing worth knowing before fog: **anchor visibility could not wait for it.** This file
    filed "an aura on a monster in the dark advertises where it is standing" under fog of war, but
    `hidden` has existed since milestone 11, so the rule shipped here — through `Token::unseen`, so
    both reasons compose. Adding shapes without it would have been a leak the day it landed.

    `Event::ShapesChanged` also had to be gated: emitting it on every token hide would tell the
    table *something happened* even when nothing was drawn on that token. Same gate the initiative
    panel already used, and the second time that trap has come up.
15. **Done.** Wall and door editor. See `docs/walls.md`.

    The state model was the easy half again, and its shape came from two questions that look like
    one and are not: what the DM *draws* is a run, and what the room *stores* is a segment. Keeping
    the run would have given the list two shapes and made every consumer flatten it — including the
    shadowcast that has not been written yet.

    Three things cost more than expected.

    **Walls needed their own point type.** `Pos` is grid units and a wall is image pixels, and two
    structs holding two floats are perfectly happy to be swapped for one another. `Px` is not
    ceremony: it is the only thing standing between "a wall a hundred cells long" and "a wall a
    hundred pixels long", both of which serialise fine and one of which is a line across the middle
    of the dungeon.

    **A click was already spoken for.** The draw tool erases on click *because* a sweep is a drag,
    which leaves the click free; here a click places a corner, so erase had to become a third mode.
    The one exception is a door, which swings on a click with no tool in hand at all — opening one
    is a play-time action rather than an edit, and putting it behind arming a tool is how a feature
    goes unused. It is the single place in this project where what a click means depends on what is
    under it, and it coexists with panning by reading off the pan drag's own `moved` flag.

    **The rail ran out of room.** A fourth DM panel squeezed the token panel down to a scrollbar and
    a heading, which nothing in the state model or the protocol would ever have caught. Layout is a
    constraint on what this UI can grow, and the next panel will have to displace something rather
    than be added beside it.

    *Since resolved, before milestone 16 rather than during it — see `rail.ts`.* The DM's editing
    panels are behind a tab strip and only one is open at a time, so fog's panel costs a tab rather
    than a share of the rail's height, and stacking is no longer the constraint on what gets built.
    Two rules came with it and apply to anything added to the strip: closing a tab must put down
    whatever that panel armed, because a tool holding the left mouse button under a hidden panel is
    a click with nothing on screen explaining it; and a panel that is inert in some state must make
    its **tab** inert too. The draw tool is deliberately not on the strip — it is the one panel
    everybody has and it is used mid-fight, which is the same reason a door swings with no tool in
    hand.

    Also worth knowing before adding anything to `RoomView`: growing it by one field pushed
    `ServerMsg::Welcome` past clippy's large-variant threshold, because every message in every
    client's mailbox is sized at the largest variant. `state` is boxed now, invisibly — serde sees
    straight through it and the frame on the wire is unchanged.
16. Fog of war, in two halves. **16a is done** — automatic line of sight, which is what finally
    reads the walls. See `docs/fog.md`.

    The state model was three lines again. Four things cost more.

    **Symmetric shadowcasting had to go**, and the reason is the one thing here worth reading before
    building on it: shadowcasting wants opacity to be a property of a *cell*, and a wall in this
    project is an arbitrary segment in image pixels that the DM may have traced diagonally.
    Rasterising a segment into blocking cells is not a lossy version of the truth, it is a different
    dungeon — a wall traced along a cell boundary, which is where `snapToCorner` puts most of them,
    would blind the cells on both sides and shrink every room it encloses. What ships is a ray from
    the viewer's centre to each cell centre, culled to the walls within reach. One sentence, a page
    of code, and explicable to a player who asks why they cannot see something.

    **`Token::unseen` stopped being the only question any filter asks.** Two of the three reasons a
    token is unseen are facts about the token; the third is a fact about the room, so it cannot be
    answered from `&Token` and the funnel moved up to `RoomState::unseen_by_table`. That is the
    third time a filtering question has had to grow, and the first time it changed type.

    **`was_unseen` had to change meaning at four sites**, exactly as milestone 11's note warned it
    would. Missing one is a live leak rather than a cosmetic bug: renaming a monster standing in the
    dark would send the table a `TokenRemoved` naming an id they have never held, which announces
    that the id exists. `Event::Promoted` grew a third outcome for the same reason.

    And **fog needed an off switch**, which this file did not plan for. Without one every map is
    fogged including the outdoor ones, and every existing save goes dark the day it ships. `fog: bool`
    beside the radius on `MapInfo` also carries the warning below about a radius defaulting to zero,
    which frees the radius to default to a playable number instead of a defensive one.

    **16b is done too** — the DM's manual override, the flood-fill reveal tool, and the unanchored
    shape filter milestone 14 left for whenever fog existed. See `docs/fog.md`.

    Both questions this file left open were answered by building it. `ForceRevealed` became **two**
    brushes rather than one: `Explored` hands over the ground and `Lit` hands over what is standing
    on it, because the conservative answer alone made the DM use two controls to say one thing.
    `ForceHidden` **does** hide a creature the party otherwise has line of sight on — anything else
    is the failure `hidden` was built to prevent.

    And the file's own guess about how to land it was right: it is a different answer from
    `in_sight` and not a fourth question. `Dark` subtracts from `visible` before anything reads it,
    so `unseen_by_table` is still one line and nothing downstream knows the word "override".

    Four things cost more than the state model, which was three lines again.

    **The override had to be a mask and never a write**, which this file called, but the ordering
    inside the mask is the part it could not have: `Dark` has to leave `visible` *before* the union
    into `revealed` or a blacked-out cell enters the party's memory by the back door, and leave
    `revealed` last or it does not take the memory. `Lit` and `Explored` as floors with `Dark` as
    the one ceiling is what makes the rest of it order-independent.

    **The fill runs on the client, and the command carries cells rather than a seed.** That looks
    like the server giving up authority and is not: the DM may reveal whatever they like, so there
    is no answer for the server to defend — only a size to bound and a board to clip against. What
    it buys is that the preview and the result are *the same array*, rather than two runs of two
    implementations that would have to agree. It is also not the raycast written twice; connectivity
    and line of sight are different questions that happen to read the same walls.

    **The override travels like the walls, not like the fog**, and that pairing is the thing worth
    keeping: the walls and the override are what the DM authored, and the fog is the shadow both of
    them cast. It reaches the DM or nobody, and the table is owed only the `FogChanged` beside it.
    On the DM's own board it needs a tint of its own — with no undo, telling a blacked-out room from
    a wall's shadow is the whole usability of the tool, and both are simply dark otherwise.

    **The shape filter needed geometry the server did not have.** `coveredCells` and `containsPoint`
    are client-only TypeScript, so `shape_covers` is a second copy in a second language. It is
    affordable because the two only have to agree *loosely* — a disagreement changes whether a frame
    is sent, never how it draws — and a `Line` needed a rule of its own, since `contains_point` is
    false everywhere on one and every measuring line would otherwise have been withheld. `Sight`
    grew a second reading with it: an unanchored shape's visibility can change with no token
    involved, which the token loop gating `ShapesChanged` could not see.

    One thing that was not foreseen at all: **the fog panel gained its first `stop()`**. 16a's note
    that it was the one tab arming nothing was true *because the party's tokens are what move the
    fog* — and the override is the one part the DM places by hand.

## Drawings

**Built, both halves** — see *Drawings* in `docs/drawings.md` and *Drawings on ground the party
cannot see* in `docs/fog.md`.

The anchored arm shipped in milestone 14: `shapes_for` withholds a shape whose anchor the recipient
cannot see, and as of 16a that question includes line of sight without another line. An anchored
shape's visibility follows its anchor token's rather than its own footprint.

The unanchored arm shipped in 16b, and it gates on `revealed` rather than on `visible`. A shape is
painted on the floor rather than standing on it, so it belongs with the terrain — a player's own
marker survives them leaving the room, and nothing on the board flickers as the party moves.

## Fog of war

**16a is built — see `docs/fog.md` for what shipped and why.** What remains here is 16b: the DM's
manual override and the reveal tool, plus the notes below that turned out to be right and are worth
keeping for whoever builds it.

The constraints this section was written to protect all held. They are listed here as they were,
because the point of the list is that none of them had to change:

- Per-client `mpsc` instead of `broadcast`
- `Event` separate from `ServerMsg`
- `snapshot_for(client)` instead of `snapshot()`
- Grid-unit token positions, which make the token-to-cell lookup free
- `coveredCells`, which already answers "which cells does this shape occupy" for the drawing
  layer — the same question a shape's fog visibility asks, on the client side of it
- **The walls themselves, which are built** — see `docs/walls.md`. `RoomState.walls` is a
  `Vec<Wall>` of segments in image pixels, doors carry their open state, and none of it reaches a
  player. What is missing is anything that reads them.

Cell-based visibility over the grid. This said *symmetric shadowcasting* and that is the one line
here that did not survive contact — see milestone 16a above, and *Raycasting, not shadowcasting* in
`docs/fog.md`. Everything the algorithm was chosen to deliver held; the algorithm did not.

**Fog is party-shared, not per-player.** One `revealed` bitset (explored terrain, persistent)
and one `visible` bitset (current line of sight), each the union over every player-owned token.
Five people narrating to each other on Discord get nothing out of per-player fog but confusion
and five times the state. Terrain gates on `revealed`; tokens gate on `visible`. Vision comes
from tokens a player *owns*, so handing a token over grants vision with no extra rule.

Tokens do not block line of sight; only walls do. **The play-area boundary is an implicit wall**,
so vision does not spill into the void off the edge of the map — nothing in the wall editor
produces that boundary and nothing should, since it is already on `MapInfo`. (Built, and it needed
a second half this file did not foresee: a map with *no* play area still has to bound what the party
can explore, or a token dragged to cell one million puts a cell there and the rectangle packing it
alongside the dungeon is the whole map's worth of characters on every send.)

Players infer the geometry from the edges of the fog, which is the reason walls stay out of their
snapshot even though fog is the only thing they can see the effect of.

**Walls block sight and never movement. Decided, not deferred — do not add collision.** A token may
be dragged through a shut door or off the play area, exactly as it can today, and the DM says "there
is a wall there" the way they would at a table. Four reasons, the first of which is the one that
makes this a rule rather than a preference:

- **A refused move is information.** Walls are withheld from players entirely, so a server that
  rejects a `MoveToken` for hitting one hands back a floor plan to anybody who drags their token
  around the board and watches which moves stick. It is the trap `docs/drawings.md` names for shape
  ids — sweeping the id space to map out the DM's monsters — with the whole dungeon as the prize.
- Squeezing, climbing, flying, misty step, and a wall traced two pixels wrong each turn into "the
  VTT will not let me move" in the middle of a fight. The DM adjudicating costs one sentence and is
  never wrong.
- A half-traced map would block inconsistently, which is worse than not blocking.
- Fog already does the practical work: a player who cannot see into a room does not drag a token
  into it.

If the DM finds themselves saying "there is a wall there" often, the answer is a *hint on their own
screen* — a movement ruler drawn in a warning colour when a drag crosses a wall or a shut door. No
command, no event, no refusal, and it cannot leak, because a player holds no walls for their client
to test against. That is the whole of the idea; it is not built and needs no groundwork.

Vision range is one DM-set radius per map, stored in feet on `MapInfo` and converted to cells
where it is used. This asked for a generous `Default`, because the container-level `#[serde(default)]`
means a save written before the field existed would load it as zero and every restored room would go
pitch black. **`fog: bool` beside it carries that instead**, and better: a switch defaulting to off
cannot darken an old save whatever the radius loads as, which frees the radius to default to a
playable 60 feet rather than a defensive number. Both are remembered per URL in `Calibration`.

Visibility is recomputed in `apply`, never in the visibility filter — the filter runs against
`&self` while the client map is borrowed, so it cannot mutate bitsets, and it is better kept
pure regardless. Recompute on drop, not on drag frames: the raycast is cheap enough at 30 Hz,
but shipping a bitset thirty times a second is not. A bitset does not fit the frame cap as a
JSON array of per-cell values either — pack it into a single string field. That is still one
readable frame in devtools, which is what the wire protocol rule actually protects.

Recalibrating the grid invalidates the bitsets, which are inherently grid-space — and this is
where fog differs from the walls beside it, which a recalibration deliberately leaves alone
because they are in image pixels. Loading a new map clears them outright, and promoting a staged
map is loading a new map, so it clears them too; that is `sweep_board`, which the walls and the
drawings already go through.

### 16b — the DM's manual override

**Built — see `docs/fog.md`.** What this section asked for held, and the two questions it left open
are answered under milestone 16 above: `ForceRevealed` became two brushes rather than one, and
`ForceHidden` does hide a creature the party otherwise has line of sight on.

The rest of it survived contact intact and is worth keeping as it was written, since the point of the
list is that none of it had to change:

- Independent of line of sight, and a state per cell rather than a write into `revealed`, because a
  manual hide that merely clears `revealed` evaporates the next time a token has line of sight on
  that cell.
- The reveal tool is a flood fill bounded by walls, and it previews before it commits: one gap in a
  traced room otherwise reveals the whole dungeon in a single click, and there is no undo.
- It lands as a different answer from `in_sight` rather than as a fourth question. `unseen_by_table`
  is the funnel every filter goes through and it stayed one line.

Two things this file did not foresee, both recorded under milestone 16: the fill runs on the *client*
and the command carries cells rather than a seed, and the override travels like the walls rather than
like the fog — which is the pair the whole feature turns out to be about.

# Slate roadmap

What is not built yet, and the order it gets built in.

`.claude/CLAUDE.md` holds the rules that hold across every feature and is loaded into every
session. This file is not, deliberately — it is design for features that do not exist, and it
would otherwise cost context in every session that has nothing to do with it. `docs/maps.md`,
`docs/tokens.md`, `docs/drawings.md`, `docs/walls.md` and `docs/fog.md` are out of context for the
same reason from the other direction: they are why each built feature is the shape it is, and only
the session touching that subsystem needs them.

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

Milestones 1–21 are done, and so is 25, which was never planned and is out of order for the reason
its own entry gives. Everything from 8 on was planned after the original seven; 17 and 18 were
workshopped after 16 landed, and 19–24 after 18:

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

    **And one thing after both, which this file never considered: `known` is `revealed` widened by
    one cell.** A traced wall runs between cell centres, so the rays stop at the floor inside the
    room and the drawn masonry is past it — fog that stopped at the rays showed the table floor and
    then nothing, and rooms read as holes. `with_fringe` is eight neighbours clipped to the board,
    applied on the way into `known` alone: not into `visible`, which would hand over the creature
    behind the wall, and not into `revealed`, which is rays only. See *One cell of fringe* in
    `docs/fog.md`.

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

17. **Done.** The movement pass — the trail, the diagonal switch, and the wall hint this file asked
    for under *Fog of war* and never scheduled. See *Distance* in `docs/drawings.md`.

    The trail was chosen to be the ruler's **straight line** rather than the path the mouse took,
    and that decision paid for the feature twice. It is derived from `ruler.from` and where the
    token is — both of which every watching client already holds — so it cost nothing on the wire
    and nothing in the room. And under the existing convention a rasterised line is exactly
    `max + 1` cells against a reading of `max × 5`, which makes the trail *a picture of the number*
    rather than a second thing that has to be kept in step with it. The recorded-path version would
    have been worse at the actual job: drag frames are throttled, so a watcher's recording is
    coarser than the dragger's and the same move draws differently on six screens.

    Three things cost more than the state model, which was one function and one field.

    **The diagonal switch is `show_names` a third time, and the shape is now unmistakable.** DM-only
    to set, identical for every recipient, `DiagonalsChanged` beside `FogChanged` rather than beside
    `WallsChanged`. It is the sharpest instance of that pattern because the server *never computes
    with it* — there is no movement distance in the crate — so the only thing the room is
    authoritative over is that six clients agree. That is also the whole argument against
    `localStorage`, which is where a client-only reading would otherwise want to live.

    **The rule had to be per-measurement, not per-turn.** `5 × (max + ⌊min/2⌋)` counts diagonals
    from the start of each reading, so the first one anybody measures costs five. The alternative
    needs a movement budget to carry a remainder in, which is a character sheet, and produces a
    number that cannot be checked by looking at it.

    **Two clocks, not one.** `end` had to stop deleting a ruler and start it fading, which meant
    `forget` for the case where the token itself goes away — a trail left behind by a token that
    just vanished is a line pointing at where it went. And `active` had to stop applying `STALE_MS`
    to a ruler that has landed, since one that landed has stopped receiving frames by definition.

    The wall hint turned out to be the cheapest part and the best test. `crossesWall` is four signed
    areas, and the assertion that it cannot leak needs no mock and no identity check: one drag, one
    set of frames, amber on the DM's screen and blue on the player's, because their client holds no
    walls to test against. `tools/drive-ruler.mjs` measures exactly that.

18. **Done.** The initiative panel — portraits on the rows, hit points on the DM's, and clicking a
    row to look at that creature. See *Initiative* in `docs/tokens.md`.

    The whole milestone touched no Rust at all, which is worth recording as the shape of a certain
    kind of feature: `panel.update` was already handed the entire `Scene`, so every row could
    already resolve its id to the token and read `img` and `hp` off it. Nothing was missing from the
    wire; something was missing from the panel.

    The one interesting line is the one that is not there. The hit point bar has **no check for who
    is reading it**, because `hp` is redacted in `TokenView` and a player's copy carries null. That
    is invariant 4 failing the safe way round, and it is the same argument `drawHitPoints` already
    made on the canvas — a secret added to `Token` and forgotten in `view_for` goes missing from the
    DM's own panel rather than appearing in everybody's. The driver asserts the negative directly.

    The only real cost was layout: the portrait and the bar both eat the column the name had to
    itself, so the panel went from 208px to 248px and the name learned to ellipsis. Layout is a
    constraint on what this UI can grow, which milestone 15 already said about the rail.

19. **Done.** Ping — hold the left mouse button and a ring appears where everyone can see it. See
    *Ping* in `docs/drawings.md`.

    Everything this file specified held, including the parts that read like guesses: the ~400ms
    timer, the 150ms growth, the arrow rather than a pan, and the no-fog-gate decision, which is the
    thing worth reading before anything else is added that the table can see.

    Two things this file left open were answered by building it, and both went the way it thought
    less likely.

    **Ping ignores the draw tool** rather than the draw tool disarming. Disarming is the tidier rule
    and it taxes the wrong tool: the measure line is the one used repeatedly in a fight, and
    re-arming it after every single measurement is a worse cost than the one thing ignoring it
    actually breaks — a *slow* click on a shape pings instead of erasing. That trade is only visible
    once you notice which of the four tools gets used most.

    **The owner's colour had to be invented, and it is derived rather than chosen.** This file said
    "the owner's colour" as though one existed; nothing in the project had ever needed one.
    `colourOf` indexes a fixed palette by roster position, which every client resolves identically
    from the `Welcome` it already holds — nothing on the wire, nothing persisted, nothing to set at
    the start of a session. Players picking their own is a real feature and was deliberately split
    out: it needs a command a *player* may send, persisted state keyed to them, and an answer to how
    a personal colour relates to the draw palette. It replaces the body of one function when it comes.

    Three things cost more than the state model, which was no state model at all.

    **`HOLD_SLOP_PX` has to equal `DRAW_CLICK_SLOP_PX` and be checked first.** Larger, and a press can
    cross into sweeping and *then* fire — killing a sketch that five other screens have already been
    shown, with no release frame left to take it off them. The two constants look independent and are
    not, which is exactly the kind of coupling that survives being noticed once and then gets tuned
    apart later.

    **Firing has to take back what the press started.** The gesture runs alongside whatever the
    button also began, which is the whole trick — and it means a hold on a token has already told
    the ruler where a drag began. Left alone that is a zero-length ruler on the board measuring a
    move nobody made. The selection is deliberately *not* taken back, which is the same call from the
    other side: un-selecting a creature somebody just pointed at is the opposite of what they meant.

    **`startedAt` is the button going down, not the moment it fires.** That one line is what makes
    the growing preview and the landed ring one drawing rather than two with a handoff between them —
    committing moves the same object between two lists and nothing on screen restarts. The obvious
    alternative flickers for 150ms at the exact moment everyone is looking at it.

    The negative assertion this project asks for landed in the *opposite* shape from every previous
    one: `drive-ping.mjs` asserts that a second connection **was** sent something over ground it
    cannot see, and that the ground under it is exactly as dark afterwards. One gesture, both halves.

20. **Done.** Walls and fog overrides on the staged map — the next dungeon traced before the table
    is shown it, rather than in front of them after the promote. See *The staged map has walls of
    its own* in `docs/walls.md` and *The staged board has a mask of its own* in `docs/fog.md`.

    This file's prediction held almost exactly, which is the first time that has happened at this
    scale. The cheapness argument was right and worth restating because it *generalises*: **a
    subsystem that already reaches the DM or nobody is nearly free to stage**, because there is no
    filter to widen. `snapshot_for` grew no arm, `message_for` grew no arm, `unseen_by_table` was not
    touched, and no `was_unseen` changed meaning — set against milestone 12, where staging two token
    fields cost all four of those.

    Three things cost more than the state model, which was one struct.

    **The bundle had to flatten its map, and that is a save-file fact rather than a style choice.**
    `staged` was an `Option<MapInfo>` on disk, so an existing save holds the map's own fields
    directly under that key. Nesting them under `map` inside a new struct deserializes every one of
    them as *missing* — and because invariant 2 puts `#[serde(default)]` on the container, that is
    not an error. It is a staged slot holding a blank image with an empty URL, silently, with the
    DM's next-map tab opening onto nothing. `#[serde(flatten)]` reads them where they already are.
    **The general trap: invariant 2 protects a field being added, and does nothing for a field
    changing shape** — there, the default that makes an old file load is the same default that eats
    what it was holding. A test asserting the old JSON by hand is the only thing that catches it.

    **`StagedChanged` carrying the whole board is what kept the event count flat.** The obvious
    shape is a `WallsChanged { staged: true }` beside every staged sweep — and then a staged load, a
    staged recalibration, a promote and a discard each have to remember to emit one, which is four
    places to forget. Carrying the bundle means the frame the DM was already being sent describes
    all of it, and the two staged-slot events that *do* exist are only for editing.

    **The negative assertion landed in two places rather than one, and the browser half needed the
    network trick.** The server suite says a player is sent no staged wall and no staged paint; the
    driver had to say it about a real second browser, and the pixel reading could not — the board
    they were on was fully fogged and so was the one arriving, so black replacing black reads as
    nothing having happened. `drive-staged.mjs` asks the *resource timeline* whether they ever
    fetched the next dungeon's image, which is `drive-fog.mjs`'s trick on token art applied to a
    map. It also has to clear the timings first: the room lives in memory across runs, so a map
    staged this time was very likely the live board last time, and a whole-history reading reports
    an honest old fetch as a leak.

    Two smaller things, both predicted and both true. `rulerBlocked`'s early return was exactly the
    marker this file said it was — deleting it is the whole of that change, and a plan is now
    measured against the dungeon it is a plan for. And the client half was the milestone-10 shape a
    third time: `shownWalls` and `shownOverrides` beside `shownBoard`.

    One thing this file did not consider: **the rail's inertness rule ran backwards.** Milestone 15
    established that a panel which can do nothing must grey its tab; here the staged board gained
    something for both panels to do, so the work was *deleting* two CSS rules. The fog switch and
    radius came with them — they have been on `MapInfo` since 16a and only the client was refusing
    them — so the next dungeon's lights are set before the promote. `ResetFog` is the one control
    still live-only, because half of it forgets where the *party* explored and they have not
    explored a map they have not been shown.

    **Deliberately out, as planned: previewing the staged map's fog.** Nothing raycasts a board
    nobody has been shown. The visible cost is that the DM paints a staged map with no wash under
    the tint to react against, and the panel's hint says so in words because the board cannot. If it
    is ever wanted it is client-only and costs the room nothing — `shape_covers` is the precedent
    for a geometry rule living in two languages. Do not put it in the room.

21. **Done.** Room lighting. See *Two lighting modes, and one question underneath* in `docs/fog.md`.

    This file's design held in full, including the parts written as warnings: the door rule, the
    radius bound and the four-neighbour instinct all shipped as specified, and the paragraph below
    about `fillFrom` is the one that saved the most time — the temptation to reuse it is real and it
    would have been wrong in exactly the way predicted.

    The state model was one enum and one field, and **the mode cost no arm anywhere**. `sight_cells`
    picks between the two implementations and nothing downstream reads `lighting` at all:
    `recompute_sight` is unchanged past that one call, `message_for` grew nothing, `unseen_by_table`
    was not touched, no `was_unseen` changed meaning, and the wire carries one more `MapInfo` field
    and no new message. Milestone 20's generalisation has a twin here: **a feature that changes what
    a filter is given, rather than what it decides, is nearly free.**

    Three things cost more than the state model.

    **`fillFrom`'s dead-end rule had to come across, and only that rule.** The two fills disagree
    about doors and agree about a cell a wall runs *through* — a chamfered corner is a hole in a fill
    whatever it is filling, and here a hole hands the table a room they have not reached. So
    `cut_by_wall` in `fog.rs` is a second copy of the client's, asked only of the walls that block,
    while `crosses` beside it stays permissive for the raycast that has tests named after its ties.
    Two files, one lattice fact, three different right answers to it.

    **The union had to be per source.** The raycast short-circuits on a cell another torch already
    lit, and copying that here is a real bug rather than a slow path: skipping such a cell stops
    *this* source expanding through it, so a party member standing one square behind another lights
    nothing past them. Six fills over a radius each is nothing at this scale, and the sharing that
    looks like an optimisation is the thing that breaks it.

    **The driver had to build its own dungeon and its own torch**, which is the part worth reading
    before writing another one. Room lighting has no shape without a wall, so `drive-fog.mjs` traces
    one — and a driver may neither assume the board it was written against nor erase the DM's work to
    make room for its own, so it runs only on an untraced board, erases what it traced, and skips
    with a note otherwise. Finding a party token to stand beside turned out to be the harder half:
    where six of them are standing is a fact about whatever room this is, a ring search wide enough
    to find one costs a click per square, and both clients frame the board for themselves. Building a
    token and handing it to a player puts a vision source in the first free cell out from the middle
    of the view, which is the one place both browsers are certainly looking.

    **Revised the same day, by playing on it.** The design above said an open door is how light
    reaches the next room, and the flood read `blocks()` to make that true. On a real dungeon that
    makes an open door **a hole in the room boundary**: a one-cell hallway hands the table the whole
    chamber past it, and the only marker that bounds a room is a shut door the DM has to swing by
    hand as the party moves. The obvious fix is the `WallKind::Archway` this file wondered about
    below, and it is not needed:

    - **The flood now bounds on every traced segment, open or shut** — `fillFrom`'s rule, which
      `docs/fog.md` has taught since 16b as *an archway is a door left open*. Room lighting was the
      one place in the project that disagreed with it, and the disagreement is what leaked. One
      deleted `.filter(|w| w.blocks())`.
    - **`Room` became a union with the raycast**, which is what lets the flood give the doorway up:
      *you see the whole room you are standing in, plus whatever you have a straight line to.* An
      open door hands over the wedge visible through it rather than the room behind it, which is what
      opening a door does at a table, and the mode can never show less than `Dynamic` would. Three
      lines — both algorithms already existed and were already radius-bounded.

    So **only sight reads a door's state**, which is one rule fewer than the two the entry above was
    proud of, and the answer to this file's own open question is that an archway does *not* want a
    `WallKind` of its own. A third variant in a closed set costs the editor's mode strip, the
    renderer, `AddWalls` and the client's two-state `Wall.door`; an open door is already exactly it.

    The general lesson is about where a rule is allowed to be new. Milestone 21 invented a door rule
    rather than adopting the one the project already had, and it read as a *decision* in the roadmap
    and the docs right up until a dungeon was traced against it. **When a subsystem next door already
    answers the question, the burden is on diverging, not on matching** — and the tell was there in
    writing: `docs/fog.md` described a fill bounded by everything traced, one section away from a
    fill that was not.

    One thing this file did not consider, and it is a property of the memory rather than of the mode:
    **switching back to `Dynamic` does not take the room away.** `revealed` is rays only and
    cumulative, so ground the flood handed over stays on the table's board as explored terrain. That
    is right — it is the same rule that keeps the corridor behind them — but it means the driver's
    reading has to be taken after a reset, and it means the DM's way to un-light a room they lit by
    accident is `reset all` rather than the mode button.

    The original design, kept because none of it had to change:

    `lighting: Dynamic | Room` on `MapInfo`, beside `fog` and `vision_ft` and
    remembered per URL with them, so the outdoor map keeps line of sight and the dungeon reveals a
    room at a time.

    Under `Room`, `recompute_sight` stops raycasting and becomes a flood fill from each party token's
    cell, bounded by traced segments and shut doors, unioned over the party. It is connectivity
    rather than the raycast written twice — the same walls read a different way.

    **It is not `fillFrom` ported to Rust, and the difference is doors.** 16b's reveal tool bounds on
    every traced segment *whatever it is swung to*, and that is deliberate: which cells make up a room
    must not change when somebody opens its door, or the region a click selects depends on play-time
    state. The argument is written out above `fillFrom` in `client/src/overrides.ts` and is worth
    reading before starting, because room lighting asks the opposite question — an open door is how
    light reaches the next room, and a shut one sealing a room is the whole point of the mode. So this
    fill reads `Wall::blocks()`, exactly as `visible_cells` beside it already does. Two fills, two door
    rules, and neither is a copy of the other.

    What they do share is four-neighbour stepping and the instinct behind it: a fill that stops short
    is a smaller failure than one that escapes. Here that is sharper than it is for the DM's paint —
    an escaped fill hands the table a room they have not reached.

    And unlike `shape_covers` this one has **no client twin**: the table is sent a `FogView` and asks
    nothing. There is no second copy to keep loosely in step with.

    **The fill is bounded by the radius as well as by the walls**, and that is not a detail. A pure
    fill does not respect corners: walk into a winding corridor and the whole of it lights to its far
    end, around every bend. Bounding by `vision_ft` stops it at the radius, keeps that number
    meaningful in both modes rather than dead in one, and still reads as a whole-room reveal in any
    room the radius covers. A hall bigger than the radius is a map whose radius should be raised; do
    not add a second number.

    Leaving a room un-lights it. Terrain gates on `revealed` and creatures on `visible`, so the room
    stays dimmed and whatever wandered into it while the party was away does not show — the existing
    rule doing its job rather than a new one.

    Two things this mode buys past the reveal itself. **A shut door genuinely seals a room**, which
    makes doors load-bearing rather than decorative. And a bad trace fails *loudly* — one gap merges
    two rooms in front of everybody — instead of leaking a sliver of sight nobody notices. That
    second one is why **20 came first**: it is an argument for tracing carefully out of sight, and
    it is a dependency of quality rather than of code. That dependency is now satisfied — the DM can
    trace and check a whole dungeon before anybody is looking at it, which is exactly the working
    habit this mode needs.

    **And the question this unblocks, which is now worth reopening**: the player-side wall hint under
    *A hint on the player's screen* further down. Its cheap version ambers when a move crosses the
    boundary of `known`, which meant nothing under `Dynamic` because a fog edge there is usually just
    the vision radius. Under `Room` a fog edge is a wall almost by definition — more so now that the
    flood stops at every traced segment. Play on it first. (The other half of that sentence, whether
    an archway wants a `WallKind` of its own, was answered by the revision recorded above: it does
    not.)

22. **Undo, for the DM.** One stack, roughly ten deep, no redo.

    Nearly all of it falls out of things that already exist.

    **`persists` is already the trigger list.** It is enumerated, it is already exactly "commands
    that changed something worth keeping", and it already excludes drag frames — a stack growing
    thirty times a second while a token is dragged is the obvious failure here, and this avoids it
    without a rule of its own.

    **A snapshot is the persisted subset**, which is to say the save file kept in memory instead of
    written to disk. Defining it that way is what keeps `clients` and `pending` out of it: restoring
    a live socket table from ten commands ago is the one way this feature hard-fails, and reusing the
    disk serializer's own definition of what is state means never deciding it a second time.

    **Minus anything persisted that the DM did not author**, and today that is exactly milestone 24's
    scratchpads. The rule above is otherwise a quiet way to lose a player's paragraph: an undo of a
    wall erase would restore every note in the room to what it said ten commands ago, with nothing on
    screen to say it happened and no way for its author to get it back. The ring holds the persisted
    subset less the notes, and the general form is the part to keep — **the undo stack may only
    contain state the undoing hand wrote.** Anything persisted and owned by somebody else has to be
    excluded when it is added, or it inherits this bug silently. Milestone 23's log dodges it for
    free by never being persisted at all.

    **Restoring re-sends `Welcome` to everyone.** Reconnection is already a full resync, so undo
    needs no new event type and no diffing — "there is no diffing or resync protocol" is the rule
    that makes this affordable rather than the rule it strains against.

    The alternative, an inverse per command, dies on `sweep_board`: a map load destroys walls, shapes
    and fog together, and writing an inverse for that is most of a second state model. A snapshot
    restores it for free — and that case is also the one that makes undo worth having at all.

23. **Whisper and shout.** Not chat, and the distinction is the whole design. **Two destinations and
    no third** — a player whispers the DM, or shouts to the table.

    The non-goal in CLAUDE.md was written on the premise that the group uses Discord. Half the table
    has a Discord account because the DM made them one, and tabbing out of the browser to send one
    sentence is friction the VTT itself created. That premise is what changed, and the non-goal has
    been amended in place rather than left to contradict this file — go and read it, because the
    bounded version is the specification and the boundary is most of it.

    The motivating case is six people posting initiative rolls without clogging voice, which is why
    the general channel that "six people already talking get nothing from" earned its place after
    all. What stays out is player-to-player: **no DMs between players**, which is table-splitting at
    a voice table and is also the entire reason a player's box needs no recipient picker. Two
    buttons. The DM picks a player to whisper; a player never picks anything.

    - **Kept in session memory, never written to disk.** The last ~200 messages live on `RoomState`
      and go out in `Welcome`, so a browser hiccup mid-combat does not eat the initiative rolls; they
      are gone next game night, and old whispers are never durable on a disk. The cap is a cap, not a
      policy — trim from the front.
    - That log is **per-recipient in `snapshot_for`**, because a whisper cannot go to everyone. It is
      invariant 3 doing exactly its job, on the first piece of state where getting it wrong hands
      over words rather than positions.
    - No history between sessions, no formatting, no emotes, no commands, no dice. A shout is text
      and is filtered by nothing at all; the fog does not apply to words.
    - **No coupling to the initiative panel.** A shouted number is text and a panel row is state, and
      they stay strangers — parsing chat content to fill a row makes this milestone reach into a
      subsystem it otherwise touches none of. The DM reads the number and types it.

    Architecturally it is the cleanest thing this project could be asked for: `Whispered` is the
    first message whose **content** is per-recipient rather than per-recipient-*filtered*. That is
    precisely what refusing `tokio::sync::broadcast` bought, and it has never once been spent.

    A whisper and a shout interleave in **one log**, styled apart, rather than living in two panes.
    Attribution is the roster name in the owner's colour, the same pair milestone 19's ring uses.

24. **The scratchpad.** One box of text per person, private to whoever wrote it. A
    `HashMap<Owner, String>` on `RoomState`, one `SetNotes` carrying only the text — the sender's
    own key is never on the wire, because a key a client could name is a key it could name somebody
    else's — and an `Event::NotesChanged` that reaches its author and nobody else.

    **It is the first state in this project Slate does not send the DM**, and that is worth pausing
    on: every asymmetry so far runs the other way, so `snapshot_for` and `message_for` have both only
    ever been asked to withhold *downward*. There is no `is_dm` in either arm here. A scratchpad the
    DM's client can open is not a scratchpad, it is a surveillance feature, and the reason it stays
    out is the same reason it is worth having at all — nobody writes honestly in a box somebody else
    can read.

    Be accurate about how far that goes, though, and do not describe it to the table as privacy.
    The notes are in the save file and the DM hosts the server, so anyone holding the JSON can read
    every one of them. What this milestone guarantees is that **no client is ever sent somebody
    else's notes**, which is the only guarantee this project's architecture can make about anything
    and is the same one the walls and the hit points get.

    What it is worth over the Notepad window everyone already tabs to is one thing: it is in the
    window, and it persists with the room. That is enough and it is also the entire scope.

    **It cannot be a rail tab.** Only one rail panel is open at a time, notes have to stay readable
    while a tool is armed, and the rail is the DM's furniture in the first place while this belongs
    to everybody.

    The line to hold: **a second document makes it a journal.** No titles, no pages, no sharing, no
    handout button.

25. **Done, and out of order.** Shift-click selection and the group drag — six goblins cross a
    corridor in one drag rather than six. See *Moving several at once* in `docs/tokens.md`.

    It is numbered last and was built first because it depends on nothing and nothing depends on it.
    The rule about not working ahead exists to stop a later milestone's design being guessed at
    early; this one touches no milestone above, so obeying the letter of that rule would have bought
    nothing.

    The interesting part is how little there was. **The server was not touched at all**, and that
    was not the plan going in — it fell out of the fact that a group move is N ordinary
    `MoveToken`s. Permission, snapping and `moves_sight` are each per-command and each already
    correct; a batched command would have had to re-answer all three for a collection and would have
    got the same answers. The client change is one widening — the `token` arm of `Drag` holds a list
    instead of a token — and four call sites that loop.

    **The permission question answered itself**, which is worth remembering the shape of. The
    intention was DM-only, on the assumption that a player selecting a mixed bag would need
    filtering. It does not: membership comes from `tokenAt`, which has always been blind to tokens
    you cannot move, so a group can only ever hold what `can_move` would allow anyway. The feature
    that needed a new rule needed no rule. **The instinct to gate a new gesture on `is_dm` is worth
    checking against the hit test before acting on it** — this is the second time the affordance
    turned out to be the boundary already.

    Two things cost more than the state model, which was a `Set<string>`.

    Escape drops a group, added after the rest of it was working: five tools in the rail already
    answer that key and a sixth thing you can be holding that ignores it is the odd one out. The
    case a click on empty map does not cover is a board with no empty square left to click on.

    **Marquee select was the original request and is deliberately not built.** A marquee is a drag
    on empty ground, which is exactly what pan is, so it needs a modifier or a rail tab and it needs
    a rubber band drawn — where shift-click needs neither and gets most of the value. If it is ever
    wanted, the selection set is already there and the only new work is the gesture. What made the
    smaller version obviously right was noticing that the left button already carries pan, token
    drag, ping, door swing and shape erase, and that the ping post-mortem two entries up is a record
    of what it costs to add to that pile.

    **One ruler for a group is only true on the dragger's screen**, and this is the one place the
    feature is knowingly inconsistent. Watchers build rulers from `TokenMoved` and nothing on the
    wire says which token was grabbed, so the table sees one per moving token. The fix is a field on
    the hottest message in the project, for a hint that refuses nothing and persists nothing, and it
    was declined — but *the conflict was only visible from `docs/drawings.md`*, not from the code,
    which is the argument for reading the subsystem doc before designing against a subsystem.

### The right dock

Milestones 23 and 24 share one piece of client infrastructure and should be built with it rather
than around it: **a collapsible dock on the right edge with a tab strip**, mirroring the left rail's
established pattern instead of inventing floating windows.

Everybody sees the same two tabs, Chat and Notes — which is the first time the two sides of this
application have had the same furniture, and it falls out of the fact that neither feature is the
DM's. The left rail's two rules are satisfied for nothing, since neither panel arms a tool, and the
wall editor is on the opposite edge so nothing here can hide an armed left mouse button.

An unread count sits on a collapsed tab, and an arriving message **also surfaces for a few seconds
beside the dock**. A whisper nobody notices is the main way this feature fails a table where half
the players are not technical, and a badge in a corner asks them to already be looking at it. It
does not auto-open the dock: expanding a panel reflows the layout under whoever is mid-drag, which
is what the ping arrow and the initiative panel each declined to do for the same reason. One box.

## Cursors — unscheduled

Everyone's pointer drawn on everyone's board. Written down deliberately without a number, because
**milestone 19 may absorb the entire need** and that is not knowable before playing a session with
pings in it.

What is already settled, so the question can be reopened cheaply rather than re-argued:

- It is `Ping`'s shape with the ephemerality turned up — a throttled `CursorMoved` carrying a `Pos`,
  no persistence, absent from the snapshot, never dirty. Nothing has to be built first.
- It would be **the busiest thing in the room by an order of magnitude.** Drag frames exist only
  while a token is moving; cursor frames exist whenever anybody's hand is on the mouse. Seven clients
  at 15Hz is still nothing at this scale, but this is the first feature where that sentence has to be
  said out loud rather than assumed. Send only on movement, decay after a few seconds of stillness.
- **The fog question is not settled the way 19's is, and probably lands the other way.** A ping is a
  deliberate gesture and a cursor is not, so "the DM's pointer drifted across an unexplored room" is
  a different question from "the DM pointed at it" — gate on `known`, which is the answer 19 was able
  to refuse.
- Seven pointers twitching over a board that already carries tokens, nameplates, hit point bars,
  rulers, trails, shapes and fog is a real cost against a real benefit — ambient presence, and
  knowing where somebody is looking without them having to gesture. That trade only reads correctly
  in a live session, which is the other reason this waits.

## Drawings

**Built, both halves** — see *Drawings* in `docs/drawings.md` and *Drawings on ground the party
cannot see* in `docs/fog.md`.

The anchored arm shipped in milestone 14: `shapes_for` withholds a shape whose anchor the recipient
cannot see, and as of 16a that question includes line of sight without another line. An anchored
shape's visibility follows its anchor token's rather than its own footprint.

The unanchored arm shipped in 16b, and it gates on `known` rather than on `visible`. A shape is
painted on the floor rather than standing on it, so it belongs with the terrain — a player's own
marker survives them leaving the room, and nothing on the board flickers as the party moves.

## Fog of war

**Built, both halves — see `docs/fog.md` for what shipped and why.** What is kept below is the
design as it was written before either half existed, because the point of it is how much of it
survived contact; where it did not, milestone 16 above says so.

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
to test against.

**Built in milestone 17**, and every word of the paragraph above held. What it did not predict is
how good a *test* it makes: the leak-proofness is normally the hard thing to assert, and here it is
one drag photographed from two connections — amber on the DM's screen, blue on the player's, no
identity check anywhere in the code that produces the difference.

### A hint on the player's screen — unscheduled, and what it would cost

Workshopped 2026-08-11 and deliberately not scheduled: playtest the current arrangement first and
count how often the DM actually says "there is a wall there." Twice a session is not a feature. This
note exists so the reasoning is not re-derived, and so it is not re-derived *wrong* — the naive
version is a dungeon-mapping exploit, and there are two non-naive versions that are not.

The observation both of them turn on is one this file already makes from the other direction:
**in explored territory the party can already see where the walls are**, because they infer the
geometry from the edges of the fog. That is the stated reason walls stay out of their snapshot, and
it cuts the other way too — a hint **gated on both ends of the move being in `revealed`** tells them
almost nothing they are not already looking at, and the probe stops working the moment they drag
into the dark.

Its specific leak is worth naming rather than hand-waving: **it outs secret doors.** A shut door in
an explored corridor reads as a wall in the fog, so a move that fails to amber through one announces
that it is a door. The mitigation is what the DM would do anyway — trace a secret door as `Solid`
and convert it once the party finds it.

Two ways to land it, and they are not close in cost:

- **Send the player the walls that bound explored cells.** Straightforward and expensive in the
  place this project is least willing to spend: it means a `WallView`, a filter that changes shape
  every time the fog grows, and the end of "walls reach the DM or nobody" — which is currently one
  of the few rules with no exceptions and therefore nothing to get wrong.
- **Derive it on the client from the fog it already holds.** Amber when the move crosses the
  boundary of `known`. Nothing new on the wire, no new filter, and it is leak-proof *by
  construction* rather than by argument, since it reads only what that client was already sent.

The second is obviously better and has one problem: under `Dynamic` lighting a fog edge is usually
just the vision radius rather than a wall, so it would amber constantly and mean nothing. **Under
milestone 21's `Room` lighting the fog edge is a wall almost by definition**, because the fill is
bounded by them. So this whole question should be reopened after 21 has been played on, not before —
the same session that answers whether an archway needs a `WallKind` of its own.

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

# Slate roadmap

What is not built yet, and the order it gets built in.

`.claude/CLAUDE.md` holds the rules that hold across every feature and is loaded into every
session. This file is not, deliberately — it is design for features that do not exist, and it
would otherwise cost context in every session that has nothing to do with it. The twelve files in
`docs/` — `maps.md`, `tokens.md`, `drawings.md`, `walls.md`, `fog.md`, `undo.md`, `chat.md`,
`notes.md`, `presence.md`, `rooms.md`, `frontend.md` and `net.md` — are out of context for the same
reason from the other direction: they are why each built feature is the shape it is, and only the
session touching that subsystem needs them.

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

**Everything through 28 is built, and so are 30 through 36; 29 is not.** 25, 26 and 34 were
never planned and are out of order for the reasons their own entries give. 33 is *Multi-room*, which was
unscheduled until a Halloween one-shot became the second room it was waiting for. Everything from 8 on was planned after the original
seven; 17 and 18 were workshopped after 16 landed, 19–24 after 18, and 27–29 on 2026-08-18 after 26.
That batch was the first one written down while nothing in it existed; 27 and 28 both landed on
2026-08-19 and their entries are now records like the rest, while 29 is still design. All three
exist to **overturn something this file already says**, which their own entries open by naming —
and 28 also overturned something *its own* design section said, which its entry records.

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

22. **Done.** Undo, for the DM. See `docs/undo.md`.

    Every claim this file made about the server held, and the milestone was small there for exactly
    the reasons given: `persists` was already the trigger list, a snapshot really is the persisted
    subset, and defining it that way really does keep `clients` and `pending` out without a rule.
    Two additions the design did not have, both small and both load-bearing.

    **`undid` had to exist beside `persists`.** The trigger needs a label — the button names what it
    would take, because with no redo an unpredictable press is unrecoverable — and the same list
    turned out to be where `Undo` excludes *itself*. Without that the ring grows a new top every time
    the DM walks down it and the second press returns to where the first started. So it is
    `persists`'s and `moves_sight`'s third sibling, enumerated the same way, and a step is a command
    both of them agree about.

    **The ring is post-state and the constructors seed a floor.** Snapshotting *before* each command
    is the obvious shape and cannot consult `persists`, which answers about the events a command
    produced — so it would clone the whole room thirty times a second during a drag and discard all
    but one. Pushing afterwards costs one clone per step. The floor goes in `hardcoded` and
    `restored` rather than in `spawn`, which is where `recompute_sight` lives: sight is derived from
    state, but a floor is part of *being* a room, and every test in the crate builds one by hand.

    **The one thing this file got wrong was on the other side of the wire.** "Restoring re-sends
    `Welcome` to everyone" is true of the server and false of the client: `onWelcome` *builds* the
    pings, the panels, the four tools, the rail and the board, once, on the stated assumption of one
    Welcome per socket — and `start()` captures `room.scene` by reference. A second one would
    construct a second of everything, register another `window` keydown listener per tool, and hand
    the DM a fresh camera at the moment they are looking at what they just undid. So `Restored` is
    its own message carrying state alone, and `adoptView` mutates the scene **in place**, sharing its
    field list with `sceneFromView` through a `fromView` typed `Omit<Scene, 'previewing'>` — the one
    field a restore must not touch, excluded by the type rather than by remembering.

    That was the whole cost of the milestone, and it is worth stating as a general shape:
    **"reconnection is already a full resync" was a claim about the protocol, and the protocol was
    not the part that had to be true.** The client had never actually been asked to resync.

    Two smaller things. `rulers.forgetExcept` is the one thing a restore needed that no other frame
    did — a restore removes several tokens at once and there is no per-token frame to hang a `forget`
    on. And `UndoChanged` rides beside every persisting command, which put a trailing frame in every
    DM-side assertion in the server suite; `drain` filters it and `drain_all` does not, so those
    tests stay about what they are about and `undo.rs` asserts the pairing directly.

    **One step per command, as chosen.** A long wall trace fills the ring and cannot be taken back as
    a unit; `ClearWalls` is the way out of a bad one and is itself one step. Coalescing a run was the
    alternative and was declined because it is a rule `persists` does not already contain — depth is
    the cheap thing to tune after a session, and the trigger is not.

    The original design, kept because the server half of it needed no changes:

    One stack, roughly ten deep, no redo.

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

23. **Done.** Whisper and shout — not chat, and the distinction is the whole design. **Two
    destinations and no third**: a player whispers the DM, or shouts to the table. See
    `docs/chat.md`.

    Every design decision below shipped as written, including the ones this file called out as
    load-bearing — the two destinations, the session-memory log, the per-recipient snapshot, the
    dock rather than a floating window, and the badge that does not auto-open anything. What is
    worth recording is the one prediction that was half wrong, and three things the design did not
    have.

    **"The first message whose *content* is per-recipient" was true of the snapshot and false of
    the delta.** `RoomView::chat` is genuinely different text per client, and it is what refusing
    `tokio::sync::broadcast` finally bought. But `ServerMsg::Said` is withheld *whole* or sent
    whole — `WallsChanged`'s shape, not a new one. What is actually new about it is smaller and
    sharper than this file guessed: **it is the first filter in the project that draws its line
    between two players.** Every other one separates the DM from the table and asks `is_dm`;
    `party_to` never asks it, and the DM holds every whisper because they are one end of all of
    them rather than because they are the DM. The general form worth keeping: *a filter that stops
    asking about a role has to start asking about a pair, and the pair includes the sender* —
    leaving that half out makes the person who said something the only person unable to see it.

    **The sender is echoed their own, which nothing else in this project does.** `Sketch`, `Pinged`
    and mid-drag `TokenMoved` all skip the originator, and every one of those was decided on the
    same argument — the sender is already drawing it, so an echo restarts an animation. It does not
    generalise, because **a log is a sequence**: where a line lands in it is the room's to decide,
    and a client appending its own would have two orderings to reconcile the first time two people
    typed at once. The tell that this was going to be different is that nothing here is predicted
    locally at all.

    **Not persisting it was one decision that paid three times**, and only one of the three was
    planned. Old whispers stay off a disk in somebody's front room; a refresh mid-combat keeps the
    initiative rolls; and **an undo cannot eat what the table said** — milestone 22 wrote down that
    the ring may only hold state the undoing hand wrote, and this is the first thing to test the
    rule. It passes without being named anywhere: a snapshot is a `Saved`, and the log is not on
    one. Milestone 24's scratchpads *are* persisted and will not get this for free, which is the
    thing to remember when they land.

    **The sticky destination was chosen over two fire-and-forget buttons, and it cost a second
    marker.** Enter sends where the box is pointed, which is one keystroke each way in a
    back-and-forth and has exactly one failure — forgetting which way it points and shouting
    something private. So the armed chip is not the only sign: the input itself takes the amber
    border and says `whisper Torrin…` in its placeholder, because the thing somebody is looking at
    while they type is the thing they are typing into. A control with state needs the state where
    the eyes are, not only where the choice was made.

    Two smaller things. **`stopPropagation` on the input's keydown** — every tool in this project
    listens on `window`, four disarm on Escape and the calibration box applies on Enter, and none of
    them should be reachable from a sentence somebody is typing; `undo.ts`'s `typingIn` is the same
    argument from the other side and was the precedent. And **the driver needed three browsers**,
    which is a first: the assertion is that a whisper is absent from *another player's* page, and no
    two connections can show that. `drive-chat.mjs` also has to tag its lines per run — the log is
    session memory rather than persisted, which sounds like it makes the driver idempotent and does
    not, because the room lives in memory across runs and there is no command that clears a log.

    The original design, kept because all of it held:

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

24. **Done.** The scratchpad — one box of text per person, private to whoever wrote it. See
    `docs/notes.md`.

    What it cost: a `HashMap<Owner, String>`, one command, one event, one 100-line `notes.ts` and a
    dock tab. **The design below was right about all of it except one line**, and the exception is
    the interesting part — see *the dock stacks now* at the end.

    A `HashMap<Owner, String>` on `RoomState`, one `SetNotes` carrying only the text — the sender's
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
    to everybody. Milestone 26's dock answered all three — and then, **the dock stacks now**, which
    is the one line above that changed. Its panels were one-at-a-time because that is what the rail
    does; the reason the *rail* is one-at-a-time is that its panels are editing modes and two armed
    tools would be two meanings for one mouse button. Nothing in the dock is a mode, so making notes
    close the chat would have rebuilt on that edge the complaint that kept the scratchpad off this
    one. A `Set<DockTab>` and a `toggle`, and two flex items instead of a fixed height.

    The line to hold: **a second document makes it a journal.** No titles, no pages, no sharing, no
    handout button.

    Two things about the build that the design did not say. **The undo exemption needs two halves**,
    not one: keeping `SetNotes` off the ring leaves a paragraph typed *between* two other commands
    on the snapshot the later one pushed, so the `Undo` arm takes the notes out and puts them back
    around `adopt` — the only exception `adopt` has ever needed, and it is `docs/undo.md`'s own
    prediction arriving. And the one frame this feature sends turns out to be for **your other tab**:
    the author's socket is excluded, which is `Pinged`'s rule rather than `Said`'s, because writing
    the text back a round trip later moves the caret.

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

26. **Done, and out of order.** The panel pass — a table tab, a folding initiative panel, softer fog
    edges, and the DM's solo sight. Numbered after 25 and built before 23 because none of it depends
    on anything unbuilt, and because three of the four came out of playing on what exists rather than
    from this file.

    **The table tab is the one with a rule attached, and the rule is worth more than the tab.**
    `show_names` and `diagonals` are `RoomState` fields and both were living under the token panel's
    form — which describes one selected creature — behind a divider, with two comments in the markup
    explaining the placement. One of them said in as many words that the dropdown was there "for want
    of a better home". **A panel mirrors where its fields live**: `MapInfo` is the map tab, `Token` is
    the token tab, room-wide state is the table tab. That arrangement was the only violation of it.

    Cost: one entry in `RailTab`, one entry in the array `main.ts` passes to `createRail`, and a
    fourteen-line `table.ts`. **Exactly what milestone 15's tab strip was built to make a panel cost**,
    which is the first time that claim has been tested by adding one. No Rust at all — both commands
    already existed. It is named *table* and not *room* because `Lighting::Room` is a fog mode one tab
    over, and two meanings for one word in adjacent panels is worse than a slightly odd name.

    **The initiative panel folds the list and never the turn.** Collapsed renders only the current
    row, through the loop that was already there, so the folded panel is the unfolded one's
    highlighted line rather than a second drawing of it. The turn buttons stay: advancing the turn
    from a folded panel is most of what folding it is for. Collapsing to a bare tab was the obvious
    shape and is the door-swing mistake with information instead of an action — `panel.ts` says of
    itself that glancing at it is all it is for. In `localStorage` and pointedly not on the room,
    which is the line `diagonals` falls on the other side of. See *It folds the list and never the
    turn* in `docs/tokens.md`, which also settles the right dock question below.

    **The fog edge is feathered now, and the interesting part is why the one-line version is wrong.**
    Turning `imageSmoothingEnabled` back on over a one-pixel-per-cell canvas ramps across the whole
    square *and moves the boundary half a cell*, because bilinear sampling anchors on pixel centres —
    which is exactly the displacement the old "smoothing is off" comment was defending against. It was
    right about the danger and wrong that a hard edge was the only cure. Drawing each cell as a solid
    block of `SUBCELLS` pixels first keeps the boundary where the server put it and confines the ramp
    to a quarter of a cell. The override tint keeps its hard edge, deliberately: a fog edge
    approximates a wall, an override edge is exactly the squares the DM clicked.

    **Solo sight is the answer to "should fog be per-player", and the answer is no.** That question
    was asked directly and the architecture would take it — per-client `mpsc`, `snapshot_for`,
    `FogView` already built per recipient. The cost is play, not code: `unseen_by_table` becomes
    `unseen_by(client)` at six call sites, `FogView` stops being the one message identical for
    everyone, and **there is no defensible answer for what the DM's own board should then show**,
    which is usually the sign a question was posed wrong. What a table actually asks is narrower and
    has one answer: *can the rogue see it*. That is `solo.ts`, it is client-only, and it needed no
    command, no event, no filter and no line of Rust.

    It is leak-proof **by construction rather than by a check**, which is `crossesWall`'s argument for
    the movement hint word for word — a player's client holds no walls, so it could not compute this
    if it tried. Every piece was already there: `crossesWall` for `Dynamic`, `fillFrom` for `Room`
    (one optional radius bound added), and `fogFromWire` for the picture, so there is no second
    rendering path to keep in step. **The generalisation to keep is milestone 21's twin: a feature
    that only asks a question the client already has the data for is nearly free.**

    Four things cost more than any of the state models, which were a `RailTab` variant, a boolean and
    a `WireFog`.

    **One button with three states, and the order of its branches is load-bearing.** *Arm*, *an answer
    is up*, *neither*. It shipped toggling `checking` first, so pressing it with a creature picked
    re-armed instead of going back to the table's board — leaving the DM holding one creature's sight
    with no control on screen that takes it away, while the panel's own hint promised otherwise. The
    driver caught it. Anything on the board comes off first.

    **Ported UI takes its drivers with it.** Renaming two ids broke four drivers, and one of them
    (`drive-undo`) failed on an assertion that had nothing to do with the change — it opened the token
    tab, and the thing it was checking had moved. A rename is not a rename when a test names the id.

    **`drive-panels.mjs` opened both browsers on the same debug port**, so "the player" was the DM's
    own page. The two pixel readings came back *identical* and read as a leak; two more runs went into
    chasing a bug in `solo.ts` that was never there. The ports are fixed — 9333, 9334, 9335 — and they
    are not a detail. The control measurement is what settled it: a noise floor of 0.00% on a board
    where nothing is happening turns every later number into evidence.

    **A driver must not assume where the server puts a token.** Looking up a creature by name and
    clicking where it ought to be failed repeatedly on a board with two of them side by side. Clicking
    its initiative row centres the camera on it, which is one click instead of a hundred and cannot
    miss — and then the driver asserts *which* creature it picked from what the panel says rather than
    from what it assumed. Per-run token names, and a cleanup that sweeps by pattern rather than by
    exact name, are what keep a failed run from poisoning the next one.

27. **Done**, on 2026-08-19, and all four parts of it. What the design below did not anticipate is
    in the four notes marked **On landing**; everything else held, including the claim that three
    of the four touch no Rust and that the fourth is where all the teeth are. See
    `docs/presence.md`.

    The presence pass — who is here, and who they are. Four parts, and the theme is
    what makes them one milestone rather than four: this application currently has no answer to
    *is the DM still connected*, no answer to *it is your turn*, no answer to *my socket dropped*,
    and colours nobody chose. Milestone 26 is the precedent for a four-part pass held together by
    a theme rather than by a dependency.

    Three of the four touch no Rust at all. The fourth is where all the teeth are, and it is not
    the one that looks it.

    **27a — connected players.** `roster` is the cast list and not who is connected; that sentence
    is in CLAUDE.md and this is what finally wants the other thing. The server already computes it:
    `roster_slots()` builds `claimed` by scanning `clients`, and today only sockets sitting on the
    identity picker ever see the answer. Both emit points exist and already do neighbouring work —
    `hello`'s success path calls `refresh_pickers`, and the `Disconnected` arm calls it *and*
    dispatches `Event::SketchEnded`.

    - `ServerMsg::Presence { here: Vec<Owner> }`. **`Owner` rather than `RosterSlot`**, because the
      thing a table most wants to know is whether the *DM* is there and `RosterSlot` cannot say it —
      and because `colourOf` and `nameOf` already resolve an `Owner` to a name and a colour with
      nothing on the wire, which is `Pinged`'s argument reused whole.
    - **A set of identities, not a count.** `RosterSlot`'s own doc comment says a player on a laptop
      and a phone is legitimate, so two connections as one person is one entry.
    - `here` on `RoomView` as well as on the delta, so the join snapshot carries it — invariant 3 —
      and `Restored` is right for free. `state` is already boxed, so milestone 15's large-variant
      warning does not bite.
    - `NamesChanged`-shaped: identical for every recipient, no filter, no permission. **Off `Saved`**,
      so off the undo ring by construction exactly as `chat` is. The room already wrote the sentence
      that makes this correct rather than convenient, in the `Disconnected` arm: *"Who happens to be
      connected is not part of the room."*
    - On screen it is a row of chips at the **top of the right-hand flex column**. That is the one
      end of that column which never moves — the initiative panel folds and the dock grows upward,
      which is `dock.ts`'s own argument for putting its strip last. Absent players **dim rather than
      disappear**, so the row never reflows. Dim the chat destination chips too: whispering somebody
      who is not there is the specific failure this feature exists to prevent.

    **On landing:** all of the above held. The one thing not designed for was the *test suite* —
    a `Presence` now rides beside every join and leave, and every test in the server suite opens
    two or three connections, so `drain` had to filter it exactly as it already filters
    `UndoChanged`. Three tests using raw `try_recv` needed a `settle` after their joins. That is
    the cost of a frame nobody asked for arriving in a suite built around "and nothing else".

    **27b — "your turn".** When `initiative.current` becomes a token you own, flash the title while
    the tab is hidden and surface beside the dock. Client-only — `panel.update` is already handed the
    whole `Scene` and `identity.ts` holds your id — which is milestone 26's generalisation again: *a
    feature that only asks a question the client already has the data for is nearly free.*

    It **must not fire on `Welcome` or `Restored`**. Adopting state is not a turn change, and a
    restore mid-combat that nudges six people is worse than the feature is good; seed the previous
    value from the snapshot. It does not open or move anything, which is the rule the ping arrow, the
    initiative panel and the chat badge each already follow for the same reason.

    One thing left open on purpose rather than pre-solved: it fires for the DM on every monster's
    turn, because monsters are `Owner::Dm` and it genuinely *is* their turn to act. That may be right
    or may be noise, a `localStorage` off-switch is the cheap follow-up, and **play decides** — the
    same shape as milestone 19's draw-tool question, which was also only answerable by using it.

    **On landing:** built as designed, with `update` and `adopt` as two methods so the seeding
    rule is in the type rather than in a comment. The line got **its own box** beside the chat
    toast rather than sharing it — a whisper arriving must not wipe out the news that you are up,
    and both can be true in the same second.

    **27c — reconnect on drop.** CLAUDE.md states the gap outright: *"A keepalive is not a
    reconnect — when the socket does close, the page still says so and waits for a refresh."* Back
    off on close and **`location.reload()`** when a fresh socket opens.

    The reload is the design and not a shortcut, and milestone 22 is why: `onWelcome` builds the
    pings, the panels, the four tools, the rail and the board once per socket on the stated
    assumption of one Welcome per socket, so a second one constructs a second of everything and
    registers another `window` keydown listener per tool. That is the same wall `Restored` was
    invented to avoid, and here there is nothing to invent — a reload is already the supported path,
    and this only automates what the page currently asks the user to do by hand. Keep today's banner
    as the floor for when the backoff gives up.

    **On landing:** built as designed. `onClose` split into `onLost` and `onClose`, which is what
    "keep today's banner as the floor" turned out to mean in practice. Nine attempts over about a
    minute; verified by hand both ways — the reload fires when the server comes back, and the
    give-up banner lands at ~80s when it does not. **No driver**, deliberately: driving it means
    stopping and starting the server, which is not something the README's run-all loop should do.

    **27d — player-picked colours.** Split out of milestone 19 and already priced there: *"it
    replaces the body of `colourOf` below and touches nothing else, with these as the defaults for
    whoever never picks."* That is true and it is the **client** half. The server half is new
    persisted state and is the whole cost of this milestone.

    - `colours: HashMap<Owner, String>` on `RoomState`, persisted.
    - **`SetColour` carries no key** — whose colour it is comes from the socket. That is `Say`'s rule
      and `SetNotes`'s rule a *third* time, and three instances is a pattern worth naming in
      `docs/`: a key a client could name is a key it could name somebody else's with.
    - **Public, unlike the notes**, because everyone needs everyone's colour to draw pings and chat
      attribution. So this is the first player-writable state in the project that is *not* private,
      which is the axis it differs from the scratchpad on and the reason it does not simply inherit
      `notes_for`.
    - **A closed palette, not free hex, and the reason is already written down.** `pings.ts` records
      that the six hues deliberately avoid the token ring vocabulary in `render.ts` — gold is
      ownership, blue is in progress, white is the turn, violet is hidden, teal is staged-only. Free
      hex lets a player pick gold and make their own ring lie about ownership, which is the board
      saying something false about a creature. So the command carries an **index into a fixed set**,
      validated server-side the way `Token.size` is, and there is no colour-picker UI to build.
    - **The undo exemption, and it needs both halves.** Milestone 22's rule is that the ring may only
      hold state the undoing hand wrote, and a player's colour is not the DM's. So `undid` returns
      `None` for `SetColour`, *and* the `Undo` arm of `apply` lifts the colours out and puts them
      back around `adopt` — because a colour picked *between* two commands is on the snapshot the
      later one pushed. **This is the second thing to need that exemption**, which turns
      `docs/notes.md`'s "the only thing exempted by hand" into a rule with two instances. Update it
      and `docs/undo.md` when this lands.
    - The control is **your own chip on the presence strip**, which is where every colour is already
      visible. Not a third dock tab for one control — `dock.ts` argues against that itself, since its
      panels are things you read while something else is going on.

    What it will owe on landing: a `docs/presence.md` and a CLAUDE.md section pointing at it, and a
    `tools/drive-presence.mjs` on **fixed** debug ports — two browsers listing each other, then one
    closed and the other's strip dimming that name. Milestone 26's `drive-panels` post-mortem is what
    makes the fixed ports non-optional rather than tidiness.

    **On landing:** all of it held, and it owed and paid all three. Four things the design did not
    settle and the build did:

    - **The table is a `BTreeMap<PlayerId, u8>` and not a `HashMap<Owner, String>`.** `PlayerId` is
      a newtype over `String`, so it is a legal JSON object key — which is exactly what `Owner` is
      not, and why `notes` had to be a sorted list of pairs. `BTreeMap` sorts itself, so the file
      does not churn. One type in the room, on the wire and on the disk, and `to_saved` is a clone.
    - **The value stored is the index, not the resolved hue.** The server has no copy of
      `PLAYER_HUES` and no opinion about what `3` looks like — it holds the list's *length* as
      `PALETTE` and nothing else, so changing a colour touches no Rust.
    - **Two people may pick the same swatch and nothing refuses it.** `pings.ts` already argued
      that colour does not scale to seven and the name beside a ring is the real answer, so a
      duplicate is legible rather than broken — and it keeps `check` to a bounds test.
    - **The DM is refused `SetColour` outright**, at three layers: the table is keyed by
      `PlayerId` so a DM entry is unrepresentable, `check` says no, and `colourOf` answers `dm`
      before it reads the table. A rule only the UI keeps is not a rule.

    The driver opens **three** browsers rather than the two designed for: a colour has to reach
    somebody who did not pick it, and with two the picker and the observer are the same window.

28. **Done**, on 2026-08-19. Cursors — everyone's pointer drawn on everyone's board. See
    *Cursors* below, which held its design without a number until then, and `docs/presence.md`,
    which 28 was written into rather than getting a file of its own: a cursor is a colour with a
    name beside it, and this milestone is about the people looking at the board like the four
    before it.

    **What the design got right**, and it was most of it: `Ping`'s shape with the ephemerality
    turned up, a throttled frame carrying a `Pos`, nothing persisted, nothing in the snapshot,
    send only on movement, decay after a few seconds of stillness, and 27d first so `colourOf`
    was not swapped underneath it.

    **What it got wrong is the fog, and it is the one thing worth reading here.** This file said
    to gate on `known` — for everybody. What shipped gates **the DM alone**, because the gate is
    only ever protecting against a hand that knows something, and the only hand at the table that
    does is the DM's. A player can point only at what their own client drew, so gating a player's
    pointer buys nothing and costs the feature on exactly the ground the party is fighting over.
    The section below is left as it was written; this paragraph is the amendment.

    **Three things the build settled that the design did not:**

    - **The switch is new state**, and was not in the design at all. `show_cursors` is
      `show_names`' and `diagonals`' third sibling on `RoomState`, on the table tab by the rule
      that a panel mirrors where its field lives. It stops the **relay** and not the drawing —
      this is the busiest message in the protocol, and a switch that saved none of that would be
      a preference rather than a dial. It defaults **on**, which is the one place it differs from
      `show_names`: that one defaults on because it is what the board was already doing, and this
      one because a feature switched off in every room that predates it is a feature nobody finds.
    - **The client stops sending while previewing the staged board.** A position there is in a
      different dungeon's grid units, and the server must not learn preview exists — so it is one
      condition at the send site, exactly as every other `staged` decision is client-side.
    - **Two numbers moved within the hour of first use, and both moved the same way.** It
      shipped at ~15Hz with a full-strength arrow, on the argument that a pointer is ambient
      and should be neither the smoothest nor the loudest thing on the board. Half of that
      was right and half was backwards: *quieter* was right and went further — a small dot at
      55% rather than an arrow at full — and *slower* was wrong, because a hand has no
      inertia and 15Hz reads as a stutter where 25Hz on a token reads as fine. 30Hz and a dot
      is what plays. The switch is still the dial if the cost ever bites.
    - **`drive-ping.mjs` needed a change, and it is the interesting one.** A parked pointer draws
      into the pixel boxes that driver measures on the *other* client's screen, so a baseline
      taken while an arrow was up and read once it had decayed reported a difference that had
      nothing to do with a ring. It now switches pointers off for its own run. That is the first
      time a feature in this project has made an existing driver lie, and the lesson is narrow:
      **a driver that diffs a box on somebody else's screen now has a second thing moving in it.**

    **Ping did not absorb the need.** That section was written deliberately unscheduled because
    milestone 19 might have made it pointless and *"that is not knowable before playing a session
    with pings in it."* Sessions have now been played and the answer is no: a ping is a deliberate
    gesture and what this buys is ambient presence — knowing where somebody is looking without them
    having to ask for attention. Everything else that section settled still stands, including the two
    warnings worth re-reading before starting: it would be the busiest thing in the room by an order
    of magnitude, and **the fog question lands the opposite way from ping's** — gate on `known`,
    because a pointer that drifts across an unexplored room is not a claim about anything.

    **It depends on 27d and must not be built before it.** A cursor is a colour with a name beside
    it, and `colourOf` indexing a fixed palette by roster position is exactly the arrangement
    player-picked colours replace. Building this first builds it against a function that is about to
    change underneath it, for no gain — 27d is a body swap either way.

29. **Not built.** Party sight and split sight — a switch between today's party-shared fog and a
    per-player `visible`, so the rogue scouting ahead sees what the rest of the table does not.

    **This reopens a question milestone 26 answered no**, and the reason it can be reopened is that
    26's closing argument has been answered by 26 itself. That argument was *"there is no defensible
    answer for what the DM's own board should then show"* — and `solo.ts` shipped in the same
    milestone and **is** that answer: the DM's board shows the party union, and sight check is how
    they ask about one creature. That stays true under either setting, so the tool built instead of
    this feature is now the thing that makes it defensible.

    **Building this means turning the sight check back on** — `SOLO_SIGHT` in `fogtool.ts`, which
    milestone 34 switched off. That is not an obstacle, it is the same argument arriving from the
    other end: the check went off because player view answers *what is the table looking at* for the
    whole party at once, and the moment `visible` is per-player there is no single answer for it to
    mirror. Player view then has to name somebody, and asking about one creature stops being the
    narrow version of anything. The two controls are each redundant exactly while the other is the
    honest one.

    What has *not* been answered is the objection under *Fog of war* below — "five people narrating
    to each other on Discord get nothing out of per-player fog but confusion and five times the
    state." That is why this is a **switch and not a replacement**, and why it is the middle of three
    possible depths rather than the deepest.

    **The three rungs, and why the middle one.**

    - **Creatures only.** `unseen_by_table` becomes `unseen_by(&Identity, ...)`, the fog picture stays
      identical for everybody, and only *which creatures you are sent* changes. Cheapest by far and
      needs no client code at all, since it is exactly what `hidden` already does. Rejected as too
      little: a lit room with a creature silently missing from it is the same picture as an empty
      room, and the table cannot tell which they are looking at.
    - **Per-player `visible`.** What ships. `revealed` and `known` stay party-shared and persisted
      exactly as today, so the explored map stays the party's map — that is what keeps the board
      navigable, and it is what stops a player who owns no token from staring at a black screen.
    - **Full per-player, `revealed` too.** Three sets times seven, persisted times seven, and your
      map and my map become different maps. This is the version *Fog of war* below argues against by
      name and the argument has not weakened.

    **The switch is on `RoomState`, and it belongs on the table tab.** `fog`, `vision_ft` and
    `lighting` are on `MapInfo` because each is a fact about the dungeon's geometry — open ground
    versus rooms. Whether the party splits vision is a fact about *how this table plays*, which is
    `show_names` and `diagonals`, and milestone 26's rule is that a panel mirrors where its field
    lives. An enum with a `Party` default, like `Lighting`, so no existing save changes behaviour.
    The counter-argument is real and was declined: it would sit naturally beside the other three
    sight fields and would get per-URL memory for free. Recorded so it is not re-litigated.

    **The cost is not the six call sites it looks like, and this is the part to read first.**
    Milestone 26 counted `unseen_by_table` becoming `unseen_by(client)` at six sites and stopped
    there. Two more things follow from it and neither is small:

    - **`struct Sight` grows a per-identity dimension.** It is the "what did the table hold a moment
      ago" snapshot that `refresh_fog` diffs against, and its three fields — `fog`, `seen`, `shapes` —
      are each *one answer for the whole table*. Under split sight each becomes an answer per
      recipient, or the room cannot work out which client is owed which frame.
    - **Therefore `was_unseen` stops being a bool.** CLAUDE.md: *"Every `was_unseen` on an event asks
      the same question, read before the change it describes."* Under split sight it is a different
      answer per recipient. Milestone 16a already recorded what missing one of those sites costs — a
      `TokenRemoved` naming an id a client has never held, which announces that the id exists — and
      that was the *last* time this question changed shape. It is the third.

    `visible` also gains a per-player sibling, memory-only and derived on boot like `known` is. The
    union is still needed and does not go away: `revealed` unions in from all sight, and the DM's
    board still shows the whole party's.

    **`FogView` stops being the one message identical for every recipient** while the switch is on.
    Three files assert that in prose and want amending rather than deleting, because under `Party` it
    still holds — which is itself the argument for the switch being an enum on the room rather than a
    rewrite.

    **It needs the project's second three-browser driver.** `tools/drive-chat.mjs` is the precedent:
    the assertion is that player A is sent a creature and player B is not, and no two connections can
    show that. Fixed debug ports, per milestone 26.

30. **Done**, on 2026-08-22. The backdrop — a picture the DM shows the table *instead of* the
    board. See *Backdrop* in `docs/maps.md`.

    **The request was for scenes and the answer was not to build them**, which is the part worth
    recording. The DM wanted a forested clearing or a campsite on everyone's screen during
    dialogue-heavy stretches, and the obvious reading is "Slate needs more than two map slots".
    What made that reading wrong is what `sweep_board` does: a `SetMap` whose URL changed clears
    the drawings, clears the walls, calls `forget_fog` and drops the DM's paint. Showing a campfire
    between two fights was not merely awkward, it cost the encounter — which is *why* it felt like
    a scene system was missing.

    **The thing being asked for is not a map.** No grid, nothing standing on it, nothing traced
    across it, nobody exploring it. A scene system would have paid for all of that and used none of
    it. One `Option<String>` on `RoomState` did the whole job, and `apply`'s arm is an assignment
    and an event — *the arm staying that short is the feature*, because everything a scene concept
    would have had to fork simply goes on existing behind the picture.

    **Generalise it as: when a request seems to need a bigger version of something you have, check
    whether it needs that thing at all.** Two other milestones read the same way in hindsight — the
    chat that is two destinations, the journal that is one box.

    Three things fell out cheaper than expected, and one cost more:

    - **The presets are the folder.** "A few presets" sounded like a list in the state model and is
      a third `Library` beside `maps/` and `portraits/` — the same code a third time, taking the
      portraits' answer on both axes it chooses between. The room holds *which one is up* and
      nothing else, which is the line that keeps this from being a scene manager under a new noun.
    - **Unfiltered, so there was no filter to write.** `BackdropChanged` is `NamesChanged`'s
      neighbour: who may put a picture up is a permission, which picture it is is not a secret.
    - **The board stops responding through one CSS rule**, `body.covered #stage { pointer-events:
      none }`, rather than a guard per handler in `input.ts`. No pointer events delivered means no
      pan, no drag, no ping, no door, no sweep and no cursor relay, by construction. This is the
      same shape as the fog and the walls being leak-proof by *absence* rather than by a check.
    - **The one branch that had to be argued is `shownBackdrop`.** A backdrop is what the *table*
      is looking at, so the DM previewing the staged map has to win — otherwise putting a campfire
      up means the DM cannot prepare anything without taking it off six other screens. It is
      `shownBoard`'s fourth twin and answers one question earlier than the other three: they pick
      which board, this decides whether a board is drawn at all.

31. **Done**, on 2026-08-22. Prepared maps, remembered per URL — so a DM can trace three dungeons
    on a Tuesday and find all three still traced on Saturday. See *The shelf* in `docs/maps.md`.

    **This is milestone 30's other half and came out of the same conversation**, where the ask was
    "I'd like to save map states and prep a handful of maps before a session". Read 30 first: the
    two look like one feature and are not, and the reason they split is that a backdrop is about
    what is on the screens while this is about what the DM has already done to a map.

    **Most of it already exists.** `Calibration` is "everything the DM learned about this map,
    keyed by URL, persisted, never sent" — grid, offset, play area, and `fog`/`vision_ft`/
    `lighting` too. The only prep it does not remember is the traced **walls** and the painted
    **overrides**, which `store.rs` itself calls the one thing on `Saved` that would make the
    feature unusable if it were not persisted — and which are persisted for the current board
    alone.

    So it was one table entry growing, and two write sites — three, once `ClearStaged` was counted:

    - the outgoing board's walls and overrides are recorded under **its** URL as it is swept
    - the load arm of `SetMap` restores them, exactly as it already restores the grid

    No new commands, no new events, no list in the state model, no panel UI, `staged: bool` on the
    wire unchanged, and **no filter to widen** — walls already reach the DM or nobody, which is the
    same thing that made milestone 20 cheap. The disk shape stays compatible and an old save loads
    with empty walls per entry. **The shelf is the folder**, which is milestone 30's line again.

    **A wrapper, not two more fields on `Calibration`.** This entry originally said to put `walls`
    and `overrides` inside `Calibration` itself, and reading the code says not to:

    ```rust
    struct Prepared { calibration: Calibration, walls: Vec<Wall>, overrides: OverrideView }

    // Field name kept, so `#[serde(rename)]` holds the disk shape unchanged.
    calibrations: HashMap<String, Prepared>
    ```

    `Calibration` is **what the client sent**, and the room builds one as a bare struct literal
    from the `SetMap` fields — `given`, in the arm. Growing that type conflates "what the DM typed
    into the panel" with "what the room has learned", and the three costs below are all that
    conflation showing up. Keep the wrapper and every one of them disappears.

    **Three traps, all read out of the code on 2026-08-22 rather than remembered.** The first is
    silent, which is why the wrapper is worth the extra type.

    - **The recalibration clobber.** `self.calibrations.insert(url.clone(), given.clone())` in the
      `SetMap` arm fires on **every recalibration**, not only on a first load. With walls inside
      `Calibration` the struct literal above it stops compiling, the obvious fix is
      `..Default::default()`, and that inserts *empty* walls — so nudging the grid on a traced
      dungeon quietly erases what the room remembered about it. The board keeps its walls (a
      recalibration does not sweep), so nothing looks wrong until the DM loads away and back. With
      a wrapper the insert cannot reach the walls at all.
    - **`sweep_board` cannot ask which map it is sweeping.** Its two call sites order the map
      assignment *opposite* ways round: `SetMap` does `self.map = finished` and **then** sweeps,
      while `PromoteStaged` sweeps and **then** assigns. So `self.map.url` inside `sweep_board` is
      the incoming map on a load and the outgoing one on a promote — recording against it files a
      dungeon's masonry under the name of the map that replaced it, and the walls come back on the
      wrong image. **Pass the URL in.** `showing` is already computed at the top of the `SetMap`
      arm, before anything is assigned, and is exactly the outgoing URL.
    - **The staged slot is a second write site with a different shape.** Staged walls never reach
      `sweep_board`; they die in the `carried` match at `self.staged.take()`, where the load arm
      discards the old board. Easier than the live one — `board.map.url` is in hand right there —
      but it is a separate edit and exactly the kind that gets missed. "The arm that gets missed"
      is already written into six places across `room.rs`, `docs/maps.md` and `docs/walls.md`;
      this milestone adds a seventh unless both sites land together.

    Also: `Calibration` derives `PartialEq` and `Wall` does not, so the two cannot be combined
    without one of them changing. Another thing the wrapper settles by not arising.

    **Two deliberate omissions, and the second is the boundary.**

    - **Token plans.** `staged_pos`/`staged_only` are on `Token`, singular, and stay bound to
      whatever is in the staged slot. The DM preps *terrain* for many maps and *the encounter* for
      the one they are about to run. Moving plans onto a prepared board is a real refactor and is
      not what was asked for.
    - **`revealed` is not remembered.** Returning to a dungeon means the party re-explores it.
      Remembering it would make a map swap a partial scene restore, which immediately raises "why
      not token positions too" — and that road ends at the feature `docs/maps.md` refuses. The
      split to hold is **the DM's authoring is remembered; the party's play state is not.**

    **The thing to watch when building it** is that this weakens the case `docs/undo.md` makes for
    the undo ring — "the case that makes undo worth having is `sweep_board`". A load that gives the
    walls back on the way in is a less catastrophic load. Undo is still right for the other nine
    reasons; the doc's argument wants rewording rather than the ring wants deleting.

    **Two smaller consequences.** There is **no frame-cap question** here, which is worth saying
    out loud because the "a command carrying a collection has two bounds" rule in `CLAUDE.md` looks
    like it should apply: this table never reaches the wire, so `MAX_WALLS` is the only bound and
    nothing new needs a `largest_..._fits_in_a_frame` test. And **`drive-staged.mjs` gets more
    order-sensitive** — it asserts `the staged map is untraced` after picking library map #1, which
    stops being true on any second run against a persisted scratch state once walls come back with
    a map. The driver notes already say to start from a fresh `SLATE_STATE`; this makes that
    load-bearing rather than advisory, and the check wants rewording to say what it means.

    **What building it found.** The three traps above were read out of the code before a line was
    written and all three were real; the wrapper made the first one unsayable rather than merely
    avoided, which is what it was for. Four things beyond them are worth recording:

    - **`ClearStaged` is a third write site, and it is the rule rather than an extra.** The shelf
      is keyed by image and not by slot, so which of the slot's two exits the DM took must not
      change what next week's load finds. Throwing the *prep* away is `ClearWalls`; this throws the
      slot away. That also settles what gets filed in general: **whatever the board was actually
      holding, empty included** — filing only non-empty lists would make starting a bad trace again
      unsayable.
    - **A fourth ordering trap, and it is the one this entry missed.** The live arm cleared the
      overrides in its `reshaped` branch *before* the sweep ran, so on a load the DM's paint would
      have gone onto the shelf as nothing. The two arms are now exclusive — `if loading { … } else
      if reshaped { … }` — which is behaviour-identical because a load clears everything the
      reshape arm clears, and the comment there says why the order is not free.
    - **Two frames wanted deduplicating.** A load between two traced maps fires both the sweep's
      `WallsChanged` gate and the restore's, and both are materialised at *dispatch* against
      whatever the room holds then — so the second names the same list as the first.
      `swapping_between_two_traced_maps_names_the_walls_once` holds it.
    - **The client needed nothing at all.** `scene.walls` is on the `Scene` and not on the `Board`,
      so `MapChanged` replacing the board does not touch it and the `WallsChanged` behind it lands
      normally. Driven in a real browser: trace a map, load another, load the first back, and the
      masonry is on screen.

    `drive-staged.mjs` was the one thing that needed changing, and it needed more than a reword:
    its *staged* slot now comes back holding the door it hung last run, so it clears the slot's
    walls the way it already clears the board's, and the check below that says what it is really
    asserting — that the board's own masonry did not follow the map into the slot.

32. **Done**, on 2026-08-22. The libraries are writable — the DM adds an image to `maps/`,
    `portraits/` or `backdrops/` from the panel, and removes one from the list. See *Adding and
    removing* in `docs/maps.md`.

    **Milestone 31's other half, and it came out of using it.** The shelf makes a map remember
    what was traced on it, which is only worth anything for a map that is *in* the library — and
    the only way to put one there was an `scp` onto the Pi. An uploaded map landed in `uploads/`
    under a fresh UUID: a one-off that could not be found again next session, and that a second
    upload of the same file duplicated under a second URL with a second set of walls under it.

    **So uploading became adding, rather than a second button beside it.** The upload control each
    panel already had now belongs to the library widget: it writes into the folder and then *picks
    what it wrote*, so an uploaded map is a library map in every respect because it is one. Three
    things fell out of that:

    - **The two upload routes went.** `/api/map` and `/api/token` had one handler between them and
      no callers left, and `uploads/` went back to being purely the serving directory rather than
      a second library. `docs/maps.md` had a paragraph defending "an uploaded map gets a fresh
      UUID" as a deliberate asymmetry; it was deliberate while the folder was read-only and was
      not worth defending once it was not.
    - **The backdrop panel gained an upload it never had.** Not because anybody asked for a fourth
      button, but because the widget grew adding and all three panels are the widget. That is the
      argument for putting it there rather than in each panel.
    - **Twelve operations, four handlers.** Three libraries times list/pick/add/remove was going to
      be twelve one-line wrappers on top of the six that existed, so the folder became a path
      segment: `/api/{library}`, with `Library::named` refusing anything else. Fewer lines than
      before the milestone.

    **The two rules that carry the risk.** A client-supplied path reaches the filesystem in exactly
    two places now, and they are guarded differently on purpose: a **pick** may name a
    subdirectory, so it is normalised and then checked against the canonicalised root; an **add**
    must be a single component, so it *cannot* leave the folder rather than being proven not to
    have — taking the last segment of `../../evil.png` would accept a traversal by quietly meaning
    something else. The rest is Windows, which is a deployment target: the characters it reserves,
    the device names it resolves ahead of files, and the trailing dots it strips, since a file
    written as something other than what the DM typed is one they cannot then remove.

    And a **remove deletes the library file and nothing else** — not the copy in `uploads/`, so the
    board keeps working and the calibration and the walls stay on the shelf. Re-adding the same
    name later lands on the same URL and finds all of it. That is what makes the destructive button
    safe, and it is a property of a pick being a copy rather than anything new.

    **What building it found, and one of them was a bug this milestone caused.**

    - **A row grew a second button and a driver was one index off.** `drive-backdrop.mjs` staged a
      map with `querySelectorAll('#map-library-list button')[1]`, which had been the second row and
      became the *first row's remove* — and `cdp.mjs` stubs `confirm` to `true`, so it deleted a
      map from `maps/` and then failed two checks about staging. Recovered with `git checkout`,
      because the libraries are in git. The fix is a class of its own on the pick button rather
      than three corrected selectors: `.map-library-pick` cannot be off by one. **The general
      lesson is `board.mjs`'s, one layer up** — a driver may not assume the map it was written
      against, and it may not assume the shape of a widget either.
    - **`ProtectSystem=strict` would have refused every add on the Pi.** The libraries lived under
      `/opt/slate`, which is outside `ReadWritePaths` and root-owned, so the feature would have
      worked on Windows and failed on the actual deployment. They moved to `/var/lib/slate`
      alongside `uploads/` — which fixes the permission, the ownership, *and* the deploy wiping
      them, all three of which had to be solved anyway. The repo's folders became seed content
      copied in once at install.
    - **`backdrops/` was missing from the Pi deploy entirely**, never added when milestone 30
      landed. It did not matter while nothing wrote there; it does now.

    **Not built, deliberately: renaming, and folders.** An add lands one file directly in the
    library root, so there are no directories to create and none to tidy up after a remove — the
    picker still *lists* subdirectories, because a DM who arranges the folder by hand should see
    it. Renaming is remove-then-add, which is also how replacing a portrait's art works, and both
    are two-step for the same reason: the one-step version is a silent overwrite with no undo.

33. **Done**, on 2026-08-23. Multi-room — a Halloween one-shot on the same server as the
    campaign, without clearing the campaign's board to run it. See `docs/rooms.md`, and the
    *Multi-room* section at the foot of this file, which is the design as it was written down in
    advance with its corrections marked inline.

    **It is numbered here late.** The design and its post-mortem both landed in that section rather
    than in this list, in the annotate-in-place style *Cursors* uses, and the number was never
    written down beside them. Nothing is restated here that either of those already says — three of
    the six items held, three were overturned, and the overturned ones are correct where they are.

    What is worth pulling up into the numbered record is the shape of it, because it is the one
    milestone whose cost landed somewhere this file did not look. **The room registry was the cheap
    half.** `ROADMAP.md` and `CLAUDE.md` had both budgeted an `RwLock<HashMap<..>>` for it; what
    shipped is a const and an `Arc<HashMap<..>>` built once in `main`, because a lock guards a table
    that changes and nothing changes this one. The expensive half was **the twenty-odd files that
    were not about rooms at all** — every `tools/drive-*.mjs` needed `?room=campaign` appended, and
    `audit-uploads.mjs` had to start reading *every* room's save or it would print an `rm` for
    every other room's art. Shared libraries with unshared boards is what did that.

    The generalisation, and it is the mirror of milestone 21's: **a feature that adds a dimension to
    something shared makes every tool that reads it wrong at once.** The room actor did not care that
    rooms are plural; the things standing outside it all did.

34. **Done**, on 2026-08-25. Player view — the DM's own board, redrawn as the board the table is
    looking at. One button on the fog panel; see *Player view* in `docs/fog.md`.

    **Unplanned, like 25 and 26, and it comes from the same place they did: playing.** The DM holds
    more of the room than anybody else by design, and the cost of that is the one thing every other
    screen has for free — knowing what it is showing. Before this the only way to check was to open
    a second browser and claim a player's slot.

    **It exists because the fog is party-shared**, which is the whole argument for its smallness.
    There is one answer to "what can the table see", so the mirror is a fact rather than a choice
    between six — and `asTable` is a pure function over a scene the DM's client already holds. No
    command, no event, no filter, nothing on the wire: milestone 26's shape for the second time, and
    the second feature to be leak-proof by construction rather than by a check.

    **Milestone 29 is the entry this one talks to.** If `visible` ever becomes per-player, `asTable`
    is where a name has to go and this feature needs a defence it does not need today. 26 answered
    the objection that killed per-player fog; this one is the reason to want it *less*, since the
    question a DM actually asks — what is on their screens — now has a button.

    **What building it found:**

    - **The initiative panel had to mirror too, and that was not obvious.** A mirrored scene alone
      leaves a hidden creature's row drawing as a raw id, which is exactly the failure
      `initiative_for` exists to prevent — the server's filter, rediscovered by removing it. It is
      *told* rather than handed a narrowed scene, because it redraws on arrival and the board
      redraws every frame.
    - **The fog is not filtered, it is drawn darker**, so it needed a second canvas rather than a
      second answer. `Fog` grew `table`, built only on the DM's client, and `drawFog` picks between
      them on one line that resolves all four cases without asking who is reading.
    - **`Fog` had to keep its packed `cells`.** The canvas answers how dark a square is; the mirror
      has to ask whether the table can see what is standing on it, which is the same characters read
      for a different question.
    - **Editing is deliberately untouched.** The DM can drag and click through the mirror. Refusing
      would have made it a second opinion about permissions, which is a thing this project has
      exactly one of and wants to keep that way.

    **And then it took the sight check off the panel**, days later and on the strength of using it:
    a DM reaching for *can the rogue see it* was nearly always asking what the table's board looks
    like, which is now one button. `SOLO_SIGHT` in `fogtool.ts` is the whole of the suspension —
    `solo.ts`, its tests and the render path are untouched, and milestone 29 is what turns it back
    on, for the reason that entry now gives. `drive-panels.mjs` lost its solo half and gained the
    check that fails when the const flips.

35. **Done**, on 2026-08-27. The controls pass — the rail stops surprising the person operating
    it, and the DM can take their own pointer off the table's boards. Two parts, held together by a
    theme rather than a dependency, which is milestones 26 and 27's shape: neither came out of this
    file, both came out of playing, and each is a control that was doing something other than what
    the hand reaching for it expected.

    **35a — the rail pass.** Two changes and one deleted return value. Selecting a token used to
    open the token tab; now **only a click on a tab changes which tab is open**, which is rule 4 in
    `docs/frontend.md` and is there in full. The thing to keep is what the rule cost: with its one
    caller gone there was no second hand on the strip at all, so `createRail` returns `void` — **the
    rule is in the type rather than in a comment asking future callers to respect it**, which is the
    same move `Omit<Scene, 'previewing'>` made for the undo in milestone 22.

    And the rail remembers its open tab in `localStorage`. It used to open nothing on connect, on
    the argument that the change was about giving the board back — and **that argument forgot
    milestone 27c.** A dropped socket reloads the page, so "on connect" is not only the start of an
    evening, and a rail that opens empty there empties itself in the middle of a fight. Worth
    recording as a general trap: **since 27c, every "on connect" decision in this client is also a
    mid-session decision**, and the two have different right answers more often than not.

    **35b — the DM's own pointer.** `show_dm_cursor`, `show_cursors`' narrower sibling: the DM's
    pointer off the players' boards with everybody else's untouched, for a DM who wants their hand
    out of sight while the party argues about which door to open. On `RoomState`, DM-only to set,
    unfiltered, persisted, a step on the ring, on the table tab, defaulting on — `show_names`'
    fourth instance and by now an entirely unsurprising one. See `docs/presence.md`.

    **It cost four lines of filter because `cursor_seen` already existed to answer exactly this
    question**, and already answered *no* for one case: the dark. The switch is that case widened
    from "over ground the party has not explored" to "anywhere". That is milestone 21's
    generalisation for the third time — *a feature that changes what a filter is given, rather than
    what it decides, is nearly free* — and it is the reason a full-stack change with a new command,
    a new event and a `protocol-tags.json` entry still touched no visibility rule.

    **The ordering inside `cursor_seen` is the load-bearing part.** It is read after the two yeses
    and **before** the `map.fog` guard. Read the other way round it is a switch that does nothing
    until the DM turns fog on, which is the one arrangement nobody would ask for — and it would
    have tested clean on every fogged map in the project.

    Where it parts company with its neighbour: **it stops the relay and not the sending.**
    `show_cursors` is a dial and takes every client's frames off the wire with it; this is one
    client in seven, so a second condition at the send site would buy a branch in `input.ts` to save
    nothing measurable, and the DM's client would then have to decide whether a second DM tab counts.

36. **Done**, on 2026-08-31. The damage box — the DM types `-12` on a creature's initiative row
    instead of doing the subtraction in their head on the token tab. See *The damage box* in
    `docs/tokens.md`.

    Milestones 26 and 35's shape a third time: it came out of playing rather than out of this file,
    and it is a control that was making the hand reaching for it do arithmetic. It is also
    **milestone 18's shape a second time — no Rust at all.** `panel.update` is handed the whole
    `Scene`, so the row resolves its own token and has every field `UpdateToken` needs; the box works
    out the absolute and sends an ordinary edit. Nothing was missing from the wire, and there is
    still no `SetHp`.

    Three things are worth keeping.

    **The permission check is the one that is not there, again.** The box is built inside the
    existing `hp !== null` branch and gated on nothing else, so a player's panel cannot contain one:
    `view_for` redacts `hp`, and `asTable` strips it for player view. That is invariant 4 the safe
    way round for the third time on this panel — the bar, the numbers, and now the control that
    edits them, none of which asks who is reading it. The driver asserts it as the absence of
    `.init-damage` anywhere on the second browser's page.

    **The rule that had to be *invented* is about the caret, not about the numbers.** This panel is
    rebuilt wholesale on every token delta, which has always been fine because nothing on a row was
    worth typing into for long — `valueField` wears the same hazard and a misheard roll is corrected
    once. A damage box is used repeatedly on the same creature, and the room's echo of the hit
    destroys the element it was typed into. So `update` records which `data-hp-for` held focus and
    restores it after `replaceChildren`. The general form: **wholesale rebuild is affordable until a
    control is used twice in a row**, and the tell is not visible in the state model at all. Drag
    frames were the thing to check and are safe — `onTokenMoved` does not reach `afterTokens`.

    **A delta box makes the absolute box load-bearing.** `-3` on the row now means three damage, so
    the token tab's `hp`/`max` pair is the only place left that can write a creature *down* to minus
    three — which `token_fields` allows, since `-MAX_HP..=MAX_HP` is a bound on magnitude and
    "a creature cannot go below zero" is the rules knowledge this project refuses. Keeping the tab
    absolute-only was the decision that made the row's grammar free of ambiguity, and it is the
    reason not to "simplify" the two into one behaviour later.

    One thing the build corrected, and it is a driver fact rather than a design one:
    `drive-panels.mjs`'s `build()` had to write the hit point fields on *every* token including the
    one meant to have none. The token panel deliberately keeps its fields after a create — six
    goblins is six clicks — so a total typed for the first creature was still sitting there for the
    second, and the check that a row without hit points has no box passed nothing and failed loudly.

### The right dock

**Built in milestone 23, and 24 put the second tab on it.** `dock.ts` is the strip; the notes were a
second entry in `DockTab` and a second entry in the array `main.ts` passes to `createDock`, which is
what the rail's strip already costs a panel. Everything below held and is kept as the record of why
— including the argument for why this is not a generalised `createRail`, which is in `docs/chat.md`.

Milestones 23 and 24 share one piece of client infrastructure and should be built with it rather
than around it: **a collapsible dock on the right edge with a tab strip**, mirroring the left rail's
established pattern instead of inventing floating windows.

**Settled by milestone 26, so it need not be re-argued:** the initiative panel stays a fixed panel on
that edge and this dock sits *beneath* it, rather than initiative becoming a third tab here. The dock
is read-and-reply; initiative is glance-state, and the rule below about not auto-opening is the same
reason its head row has to survive being folded.

Everybody sees the same two tabs, Chat and Notes — which is the first time the two sides of this
application have had the same furniture, and it falls out of the fact that neither feature is the
DM's. The left rail's two rules are satisfied for nothing, since neither panel arms a tool, and the
wall editor is on the opposite edge so nothing here can hide an armed left mouse button.

An unread count sits on a collapsed tab, and an arriving message **also surfaces for a few seconds
beside the dock**. A whisper nobody notices is the main way this feature fails a table where half
the players are not technical, and a badge in a corner asks them to already be looking at it. It
does not auto-open the dock: expanding a panel reflows the layout under whoever is mid-drag, which
is what the ping arrow and the initiative panel each declined to do for the same reason. One box.

## Cursors

**Built, as milestone 28**, on 2026-08-19 — see `docs/presence.md`. Everything below is kept as
it was, including the bullet this milestone **overturned**: the fog gate landed on the DM's
pointer alone rather than on everybody's, and milestone 28's entry above is the amendment. Read
that before arguing from the third bullet.

This section was written deliberately without a number, because
**milestone 19 might have absorbed the entire need** and that was not knowable before playing a
session with pings in it. It has been played, and the answer is that ping did not absorb it: a ping
is a deliberate gesture, and what this buys is ambient presence.

Everything below was written before ping existed and is kept as it was. Two bullets are annotated
in place where they stopped being true, and neither is the design — one is the dependency below and
the other is this section's own reason for waiting, now discharged. The **fog gate is untouched**,
which is worth saying because it is the line a reader is most likely to assume milestone 19 settled:
it did not, and it still lands the other way.

The one addition this section could not have made, because the feature it now depends on did not
exist when it was written: **28 depends on milestone 27d.** A cursor is a colour with a name beside
it, and the palette indexed by roster position below is exactly the arrangement player-picked
colours replace.

Everyone's pointer drawn on everyone's board. What was already settled, kept as it was written:

- It is `Ping`'s shape with the ephemerality turned up — a throttled `CursorMoved` carrying a `Pos`,
  no persistence, absent from the snapshot, never dirty. Nothing has to be built first. *(No longer
  true, and it is the only line here that stopped being: 27d does, per the note above.)*
- It would be **the busiest thing in the room by an order of magnitude.** Drag frames exist only
  while a token is moving; cursor frames exist whenever anybody's hand is on the mouse. Seven clients
  at 15Hz is still nothing at this scale, but this is the first feature where that sentence has to be
  said out loud rather than assumed. Send only on movement, decay after a few seconds of stillness.
- **The fog question is not settled the way 19's is, and probably lands the other way.** A ping is a
  deliberate gesture and a cursor is not, so "the DM's pointer drifted across an unexplored room" is
  a different question from "the DM pointed at it" — gate on `known`, which is the answer 19 was able
  to refuse. *(Half right, and the half it got wrong is who. It gates on `known` and only for the
  **DM's** pointer: the sentence above names the DM's drifting hand and then generalises to
  everybody's, which is a step this paragraph never justified. A player can point only at what their
  own client drew.)*
- Seven pointers twitching over a board that already carries tokens, nameplates, hit point bars,
  rulers, trails, shapes and fog is a real cost against a real benefit — ambient presence, and
  knowing where somebody is looking without them having to gesture. That trade only reads correctly
  in a live session, which is the other reason this waits. *(Waited, and the sessions came down on
  the benefit — which is what scheduled it. The cost is still real and is the thing to watch when
  it lands: if the board is unreadable with seven pointers on it, the decay is the dial.)*

## Multi-room

**Built**, as milestone 33 — see *Room actor* in `.claude/CLAUDE.md` and `docs/rooms.md`. A Halloween
one-shot was the second room this section was waiting for.

Everything below is what was written down in advance. Three of the six items landed as designed;
three were overturned, and the corrections are marked inline in the same style *Cursors* above uses
for its own.

**Do not build the screen first.** It is the cheap half of a feature whose expensive half is a room
registry, and CLAUDE.md is explicit that the registry does not get built before there is a second
room. A campaign picker in front of one hardcoded room is scaffolding for a feature that does not
exist, which the working agreement forbids by name. *(Held, and it is the reason this waited at all.
The screen took an afternoon; the half worth arguing about was where the save files go.)*

What it costs, so the size of it is known rather than guessed:

- **`RwLock<HashMap<RoomId, RoomHandle>>` replacing `AppState.room`**, touched on connect and
  disconnect only and never on a token move. This is the one piece CLAUDE.md has already designed;
  everything above it in the architecture was built to allow this and none of it is waiting for it.
  *(**Overturned, and cheaper than this.** `ROOMS` is a const, so the rooms exist before the first
  socket opens and the map is built once and only ever read — a plain `Arc<HashMap<..>>` with no
  lock. A lock guards a table that changes. The `RwLock` is what a room the DM could create at
  runtime would need, and that is not built. The rest of the sentence held exactly: the connect path
  was the only thing that changed, and nothing on the hot path knows rooms are plural.)*
- **`SLATE_STATE` becomes a directory**, where today it is the single path `Store::new` takes. One
  save file per room, and the Pi's backup procedure in `deploy/pi/README.md` changes shape with it.
  *(**Overturned.** `SLATE_STATE` still names the primary room's file and every other room's is a
  sibling `<id>.json`, because that needs no migration: the Pi's env file is unchanged, the live
  campaign save keeps working, and the backup that greps the tar for `slate-state.json` keeps
  passing. `store.rs` did not change at all. The cost is that the rule is a sentence rather than a
  shape — `save_path` carries it and two tests pin it. A directory is a migration to do on purpose
  if there are ever enough rooms to want one.)*
- **A `dm_secret` per room**, rather than one for the process. A DM running two campaigns wants two
  links, and a link that opens every room is worse than one that opens one.
  *(**Overturned.** One secret for the process. This paragraph's case is a DM running campaigns for
  *different groups*; this is one DM, one group, one tunnel, and two links to keep straight is worse
  than one. The right answer if a link ever goes to somebody who should not reach the other
  campaign, and not before.)*
- **A room id in the WebSocket URL, and in `localStorage` beside `player_id`.** That second one is
  the fiddly part: `player_id` is currently one value for one room, and a player in two campaigns is
  two slugs.
  *(Held, both halves, and it was the right thing to call fiddly — though the fiddliness turned out
  to be on the client and not in the key: `boot` had to be split so the room is settled before
  `connect`. The key itself is `slate.player_id.<roomId>` and took four lines. Nothing would have
  leaked with one key, since `hello` refuses a slug from another room's roster — it would just have
  sent a switching player back to the picker every time.)*
- **`maps/`, `portraits/` and the uploads directory stay shared.** It is the same DM with the same
  art, and splitting them buys nothing and costs a copy of every goblin.
  *(Held, and it had one consequence worth recording: `audit-uploads.mjs` had to start reading every
  room's save. Shared libraries with unshared boards means a portrait on a one-shot token is
  referenced by a file the campaign's save has never heard of, and reading one room alone printed an
  `rm` for every other room's art.)*

**The roster becoming per-room is the actual point.** A second campaign is a different cast, and
every other item above is machinery in service of that one. If a request ever arrives that is
satisfied by something smaller — a second roster, say, on one room — that is the smaller change and
this section is not the answer to it.

*(**Half wrong, and the escape hatch was tried first.** The request that arrived was a Halloween
one-shot, and it did propose exactly the smaller change this paragraph invites: two rosters on one
room. That does not work, and the reason is what this paragraph got backwards. The roster is the
cast list; swapping it leaves `tokens`, `map`, `staged`, `initiative`, `walls`, `revealed`,
`overrides` and `shapes` exactly where they were — and those are the fields the one-shot needed
cleared. The board is what makes a second room work; the roster is what makes it pleasant. The
paragraph's instinct was still right in the way that mattered: check for the smaller change before
building this. It was checked, and it lost on the merits.)*

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

*Still what ships, and still the default — but no longer the only setting on offer. Milestone 29
puts `visible` behind a switch and leaves `revealed` alone, which is this paragraph's confusion
argument taken seriously rather than overruled: the explored map stays the party's map. Read 29
before this paragraph, not instead of it — the objection above is why it is a switch.*

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

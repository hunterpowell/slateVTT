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

Milestones 1–11 are done. Everything from 8 on was planned after the original seven, and the
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
12. Preparing the next room — the DM places monsters on the staged map and plans where the party
    lands, none of which the table sees until promote. See *Preparing the next room* below. The
    largest of the remaining non-fog milestones, and it revises milestone 10's preview rules
    rather than only adding to them.
13. Movement ruler.
14. Drawing layer.
15. Wall and door editor. Polyline authoring — click, click, double-click to end — snapped to
    grid corners, with a modifier for free placement. This is not polish: per-segment click-drag
    across a two-hundred-segment dungeon is what makes people quietly stop using fog of war.
16. Fog of war.

## Preparing the next room

Milestone 10 gave the DM the next map. This gives them the next *encounter*: monsters placed on
that map before the party arrives, and a plan for where the party lands when it does. Nothing
here reaches the table until promote.

Milestone 10 decided that token interaction is off during preview. **This milestone reverses
that decision**, so it edits the *Staged maps* section of CLAUDE.md rather than only appending to
it. That reversal is most of the cost: the panel, hit-testing, and the ghosting rule were all
built on "nothing on this board is a piece", and all three change.

### Two features, one bill

Placing monsters and planning party positions look like separable features and are not. Placing
monsters already requires the token panel usable in preview, tokens hit-testable and draggable
against the staged grid, and a rendering language for "not on the board yet". Once a drag in
preview works, routing that drag to a second position instead of the live one is an optional
field and a filter arm. Build them together; splitting pays the whole bill and collects half the
value.

The mental model that falls out is worth stating on its own, because it is what the UI has to
teach: **everything you do in preview happens on promote.** A board where some tokens can be
moved and others cannot is worse than either extreme.

### State

One token, not two worlds:

```rust
struct Token {
    id, name, x, y, owner, img, size,
    hidden: bool, hp: Option<Hp>,   // milestone 11 — built
    /// Where this token lands when the staged map is promoted.
    staged_pos: Option<Pos>,
    /// Does not exist on the live board yet. Cleared by promote.
    staged_only: bool,
}

struct Pos { x: f32, y: f32 }
```

Both new fields are DM-only, and milestone 11 left the machinery for that in place: add them to
`Token`, leave them out of `Token::view_for`, and they reach nobody. Adding them *to* `view_for`
is then the deliberate act of deciding the DM's own client needs them — which it does, since the
DM's board is what draws a planned position.

A parallel `staged.tokens` collection is the obvious alternative and is a trap: two copies of a
token means a rename, a re-art or a resize has to be applied to both, and the two drift. Only
*position* and *existence* fork. Name, art, size and owner stay single-valued and shared, which
is also what a DM wants — nobody needs a goblin with different art on two maps.

`Pos` exists so that "half a position" is unrepresentable. Two bare `Option<f32>` fields can be
set one at a time; this cannot, the same way `Identity` makes "a DM with a roster slot"
unrepresentable rather than merely unexpected.

This does **not** strain invariant 1. That invariant is about grid units versus pixels, not about
how many positions a token has. A staged position is in cells like every other, which is exactly
what makes recalibrating the staged map after placing monsters safe: they stay in their cells.

A token is therefore in one of three states, and the DM has to be able to tell them apart on
sight:

| State | Live board | Preview |
|---|---|---|
| Live, unplanned | at `x, y` | at `x, y` — staying put |
| Live, planned | at `x, y` | at `staged_pos` — will move on promote |
| Staged-only | **absent, including for the DM** | at `staged_pos` |

Staged-only tokens being absent from the DM's own live board is not a detail. Switching back to
`Map` mode must show the board as the table sees it, or the DM loses the one view they have of
what everyone else is looking at.

### Wire

`MoveToken` and `CreateToken` each gain `staged: bool`, the same flag `SetMap` already carries
and for the same reason: it names which slot, and changes nothing else about the command.
`ServerMsg::TokenMoved` needs the flag too, so the DM's client knows whether a frame writes to
the token's position or its plan.

**Preview is client-only state — the server does not know the DM is previewing**, and must not
learn. That is why intent rides on the command rather than on a mode. It also means the server
cannot refuse an operation "because the DM is previewing"; anything that should not happen in
preview is the client declining to offer it.

`UpdateToken` gets no flag. The fields it carries — name, art, size, owner, `hidden`, `hp` — are
shared by both boards, so an edit applies immediately and everywhere, which is the honest
behaviour rather than a special case.

There is no command to un-plan a single token. Dragging it back onto its live cell leaves a
`staged_pos` that promote applies as a no-op, which is the same outcome for a fraction of the
surface area.

### Promote, discard, and the pitfalls that come with them

Promote stops being one line and becomes a fan-out, and it is the one moment the whole table sees
a batch of changes at once:

- `map = staged.take()`, as today
- every `staged_pos` is adopted as `x, y`, then cleared
- every `staged_only` flag is cleared
- players receive `TokenChanged` for each token that just came into existence, and `TokenMoved`
  for each one that moved — two messages for two genuinely different situations, consistent with
  what each already means

The pitfalls are all variations on one thing: **staged token state belongs to the staged map, and
has to die with it.**

- `ClearStaged` clears every `staged_pos` and deletes every `staged_only` token. Otherwise the
  next map inherits monsters placed on a map nobody will ever see again.
- **Staging a different map does the same.** This is the one that will get missed. `SetMap`
  already distinguishes a load from a recalibration by URL; a load into the staged slot clears
  staged token state, and a recalibration must not. Recalibrating after placing monsters is a
  normal thing to do and must not sweep them away.
- Deleting a live token takes its `staged_pos` with it, like any other field.
- A staged-only token cannot be added to initiative — refuse it, the way a nonexistent token is
  refused today. Combat is the fight happening now, and building next room's order in advance
  needs rolls nobody has made.

### Client

`shownBoard` has a token-shaped twin: one function answering "where is this token, given which
board is on screen", and every draw and hit-test goes through it. That indirection is the whole
client-side feature, exactly as it was for boards in milestone 10 — and for the same reason,
since without it a planned position gets written into the live one by a single missing branch.

The ghosting rule needs replacing rather than adjusting. Ghosting currently means "not
interactive", and nothing in preview is un-interactive any more. The distinction worth drawing is
staged-only versus live, which belongs in the ring vocabulary the renderer already uses for
ownership, turn and selection.

### Not in this milestone

- Still not a scene system. One staged slot; no walls or fog per map.
- No pre-built initiative for the next fight.
- No staged edits to name, art, size, owner, `hidden` or `hp` — only position and existence fork.
- Nothing that lets a player learn a monster exists before the DM promotes it, by any route.

## Drawings

Spell areas and measuring shapes: line, circle, cone, rectangle. Anyone may draw. Only the
person who drew a shape, or the DM, may delete it.

A shape may anchor to a token, `anchor: Option<TokenId>`, so an aura follows the creature it
belongs to. An anchored shape needs no position updates on the wire at all — the client has the
anchor's position already and derives the rest. Deleting a token deletes the shapes anchored to it.

Measuring lines are ephemeral and vanish when released. Spell areas persist until deleted.

Once fog exists, shapes are filtered server-side like everything else, all-or-nothing on
overlap: if any cell a shape covers is visible, the whole shape is sent. Drawing shapes
underneath the fog overlay and calling them hidden would put the data on the client and paint
over it, which is precisely what invariant 4 forbids. An anchored shape's visibility follows
its anchor token's rather than its own footprint — otherwise an aura on a monster in the dark
advertises exactly where that monster is standing.

## Fog of war and walls

Do not implement this ahead of its milestone. The following constraints exist so it can be
added without a rewrite — they are already reflected in the rules in CLAUDE.md:

- Per-client `mpsc` instead of `broadcast`
- `Event` separate from `ServerMsg`
- `snapshot_for(client)` instead of `snapshot()`
- Grid-unit token positions, which make the token-to-cell lookup free

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

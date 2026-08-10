# Tokens

The token struct, where a token settles, its two DM-only field pairs, and how one token change
leaves the room in several different shapes.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`tokens.ts`, `panel.ts`, `library.ts`, `snap_to_cell`, `Token` / `TokenView`, or any `message_for`
arm** — the per-recipient filtering below is where a leak would come from, and the arms that drop a
message entirely are the ones that get missed.

## Tokens

A token is a square `size` cells across, centred on the position stored for it. `size` is one of
`0.5, 1, 2, 3, 4` — a closed set, checked on the server and offered to the DM as a dropdown rather
than a number field. Nothing here knows the words "large" or "huge"; that is rules knowledge. The
half exists for a druid who is currently a rat.

**Where a token settles depends on how wide it is.** An odd width has a middle cell and settles on
that cell's centre; an even width has no middle cell and settles on the corner four cells meet at.
Either way its edges land on grid lines, which is the point. Anything below one cell settles like a
single-cell token rather than on a sub-cell lattice of its own — a tiny creature belongs in a
square with the rest of the party, not tucked into a quarter of one. Resizing re-snaps, or a token
grown from 1×1 to 2×2 straddles half a cell until somebody happens to drag it. A `staged_pos` is a
position on the same lattice and re-snaps with it. This rule lives in `snap_to_cell` on the server
and nowhere else; the client never snaps.

Creating, deleting and editing a token are DM-only, and the id is the server's to invent. One
`UpdateToken` carries every editable field, the way `SetMap` carries the whole grid — position is
deliberately not among them, because `MoveToken` owns that and an edit made from a panel must not
drag a token out from under whoever is moving it. It carries no `staged` flag either, unlike the
two commands beside it: every field on it is shared by both boards. `TokenChanged` covers creation and editing alike:
an id the client has not seen is the creation. That is one message instead of two that would have
to be kept in step, and it is what a hidden token becomes a `TokenRemoved` for players and a
`TokenChanged` for the DM out of.

**Deleting a token takes its initiative row and its anchored drawings with it.** The order
otherwise holds a row naming something that no longer exists, which the panel draws as a bare id
and `next_turn` hands the turn to; an anchored shape otherwise follows a token with no position.

Token art is optional: a token without it draws as a named disc, so the sixth goblin of the evening
costs the DM nothing. `img` is held to a site-relative path — art on somebody else's server is art
that vanishes the evening that server is down, and the one thing in a save the uploads directory
would not back. Uploading it shares the map upload's handler, since proving some bytes are an image
and giving them a name of ours is the same operation either way; the two routes differ only in the
size they cap at.

### The portrait library

`portraits/` is to token art what `maps/` is to maps, and deliberately not a second mechanism: the
DM lists what is there and picks one by path, the pick **copies into the uploads directory**, and
what lands on the token is the same kind of URL an upload gives back. Everything downstream —
`img`, the save file, what a player is sent — cannot tell the two apart, which is the point. The
directory is `SLATE_PORTRAITS`, defaulting to `../portraits`. The reasoning for all of it is in
*Maps and the map library* in `docs/maps.md`; this is that feature one folder over, and both sides
of it are shared code rather than a copy — `Library` in `main.rs`, `library.ts` on the client.

**The one thing the second library added is a prefix.** Copy names are derived from the source
path, so `cave.png` in `maps/` and `cave.png` in `portraits/` would otherwise resolve to one file:
the second pick finds the first already written, skips the write, and hands back a map as somebody's
portrait. `Library::prefix` is what separates them, and **maps keep the empty prefix** — the
remembered calibration table is keyed on the URL those names produce, so giving maps a prefix would
silently orphan every map the DM has ever calibrated.

Why it exists: the party's six portraits are the same six files every session, and the tokens they
go on are rebuilt whenever a map changes. Uploading the same face by hand each time is the work a
folder can do instead. Listing and picking are DM-only, like every route under `/api` — a player has
no credential to offer, and would only be reading off the DM's cast list for next week.

## Hidden tokens and hit points

Two DM-only fields on a token, and the place per-field redaction was invented. Staging withholds
a whole message; these withhold a *field on a token the table otherwise sees*, which is why they
came before fog — getting it wrong costs one monster's hit points rather than the entire map.

**`hidden` means genuinely absent, not drawn faintly.** A hidden token is filtered out of a
player's `snapshot_for`, its `TokenMoved` frames are dropped for them, and its initiative row is
gone from their panel. It applies whoever owns the token; a uniform filter is worth more than a
rule forbidding the DM from hiding a player's own token, which is merely a strange thing to do.

**`hp: Option<Hp>` reaches the DM and nobody else, on every token including a player's own.**
`None` is both "the DM keeps no total on this one" — the usual state — and "you are not the DM",
indistinguishable from the client side, the way `staged` being `None` is. The pair travels
together so "half a hit point total" is unrepresentable. Bounds are on magnitude only: whether
`current` may exceed `max` is a question about what a hit point *means*, and that is the rules
knowledge this does not have. Players track their own totals on their own sheets — character
sheets are a non-goal.

### The three shapes one event leaves in

`Event::TokenChanged` becomes a `TokenChanged` for the DM, a redacted `TokenChanged` for a player
who may see it, a `TokenRemoved` for a player it has just been hidden from, and **nothing at all**
for a player it was already hidden from. That last arm is the one that gets missed: a
`TokenRemoved` naming an id they never held tells them a token exists, which is the whole thing
being withheld.

Telling those last two apart needs the token's visibility from *before* `apply` ran, which
`message_for` cannot read off `&self`. So `Event::TokenChanged` and `Event::TokenRemoved` each
carry `was_unseen`. A token that has just been created counts as unseen, because nobody holds it
yet — which is exactly what makes a create-hidden announce nothing.

**"Unseen" and not "hidden", because there are two reasons now.** `Token::unseen()` is
`hidden || staged_only`, and it is the only question any filter asks — `snapshot_for`,
`initiative_for`, and all three `message_for` arms go through it. A creature the DM took off the
board and one that was never on it are different facts about different maps, and they compose;
anything that filters on one and forgets the other is a leak. See *Preparing the next room*.

### Initiative

`initiative_for(is_dm)` drops rows naming a token the recipient cannot see, and nulls `current`
when it names one. Both halves matter: the panel names its rows by looking the token up in the
scene, so a row with no token draws as a raw id — the monster the DM just hid, advertised by the
one panel always on screen. `current` is an id, and an id is data. The round number is not a
secret and is sent as it is; the table watches the turn pass to something they cannot see, which
is what is happening.

**Hiding a token that is in the order therefore emits `InitiativeChanged` as well**, the way
deleting one does. Nothing else about a token edit rebuilds the panel, so without it the table
keeps a row naming a token their client has just been told to forget.

### On screen

Hidden tokens are the DM's alone, so the client never has to defend against drawing one — the
question is only how the DM tells them apart. They draw faded *and* with a dashed violet ring:
faded alone is what a slow-loading portrait looks like, dashed alone is what a selection is, and
violet collides with nothing the ring vocabulary already means. Fading multiplies with preview
ghosting rather than replacing it. The same violet marks the row in the DM's initiative panel,
because their panel and the table's now differ and the DM is the one who has to know which they
are reading.

Hit points draw as a bar above the token with the numbers over it, in screen space like a name.
Three colour bands rather than a gradient — a DM glancing at six monsters wants to sort them, and
nothing here knows the word "bloodied". Taking damage is the token panel with a new number and
Enter; there is no `SetHp`, because it would carry one field of the several `UpdateToken` already
sends together.

## Preparing the next room

The staged map gives the DM the next *map*; these two fields give them the next *encounter*.
Monsters placed on that map before the party arrives, and a plan for where the party lands when it
does. Nothing here reaches the table until promote.

**One token, not two worlds.** `staged_pos: Option<Pos>` is where a token lands on a promote, and
`staged_only: bool` says it does not exist on the live board yet. A parallel `staged.tokens`
collection is the obvious alternative and is a trap: two copies means a rename, a re-art or a
resize has to be applied to both, and they drift. Only *position* and *existence* fork. Name, art,
size, owner, `hidden` and `hp` stay single-valued and shared, which is also what a DM wants —
nobody needs a goblin with different art on two maps. That is why `UpdateToken` alone carries no
`staged` flag.

`Pos` exists so "half a position" is unrepresentable, the way `Hp` does. This does **not** strain
invariant 1: a staged position is in cells like every other, which is exactly what makes
recalibrating the staged map after placing monsters safe.

A token is therefore in one of three states:

| State | Live board | Preview |
|---|---|---|
| Live, unplanned | at `x, y` | at `x, y` — staying put |
| Live, planned | at `x, y` | at `staged_pos` — will move on promote |
| Staged-only | **absent, including for the DM** | at `staged_pos` |

**Staged-only tokens being absent from the DM's own live board is not a detail.** Switching back
to `Map` mode must show the board as the table sees it, or the DM loses the one view they have of
what everyone else is looking at. It is also why the live board marks a planned token in no way at
all: plans live in preview, and a mirror with annotations is not a mirror.

Both fields are DM-only and reach the DM's client because `Token::view_for` names them —
deliberately, since the DM's board is what draws a plan. There is no command to un-plan a single
token: dragging it back onto its live cell leaves a `staged_pos` that promote applies as a no-op,
which is the same outcome for a fraction of the surface area.

### Promote, discard, and what dies with the staged map

Promote is a fan-out and the one moment the whole table sees a batch of changes at once. Every
`staged_pos` is adopted as `x, y` and cleared, every `staged_only` is cleared, and
`Event::Promoted` leaves in **three shapes**: a whole `TokenChanged` for the DM, whose client
holds the two fields that were just emptied and cannot learn that from a `TokenMoved`; a
`TokenChanged` for a player meeting the token for the first time; and a plain `TokenMoved` for one
who has been watching it all along. A token that is still `hidden` gets none of them — a promote
settles `staged_only` and says nothing about the other reason.

The pitfalls are all one thing: **staged token state belongs to the staged map and has to die with
it.**

- `ClearStaged` clears every `staged_pos` and deletes every `staged_only` token.
- **A load into the staged slot does the same, and a recalibration must not.** `SetMap` already
  tells the two apart by URL; this is the same `loading`. Correcting the grid after placing an
  ambush is an ordinary thing to do and must not sweep the ambush away. This is the arm that gets
  missed.
- A load into the *live* slot does not touch them. A plan describes a cell on the staged map,
  which that command has not touched.
- Deleting a token takes its `staged_pos` with it, like any other field on it.
- `MoveToken`/`CreateToken` with `staged: true` are refused when nothing is staged, and a
  `staged_only` token cannot be moved on the live board or added to initiative — all refused the
  way a token that does not exist is refused. Combat is the fight happening now.

**Clearing a plan is a DM-only message.** `Event::TokenPlanChanged` is the `StagedChanged` shape at
token scale: a player's copy of that token is identical either side of it, so the only thing a
frame could carry them is the news that the DM just threw a plan away — which is news, and
invariant 4 is about what a client may know.

### On screen

Staged-only tokens draw with a teal ring; nothing fades for being previewed any more. Hidden still
fades and still dashes, so a monster built on the next map *and* hidden reads as teal, faint and
dashed — three marks for three independent facts, none cancelling another.

`shownPos(scene, token)` is the token-shaped twin of `shownBoard`, returning `null` for a token
absent from the board on screen, and every draw and hit-test goes through it. That indirection is
the whole client-side feature: without it a planned position gets written into the live one by a
single missing branch.

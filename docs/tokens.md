# Tokens

The token struct, where a token settles, its two DM-only field pairs, and how one token change
leaves the room in several different shapes.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`tokens.ts`, `panel.ts`, `library.ts`, `snap_to_cell`, `SetShowNames`, `Token` / `TokenView`, or any
`message_for` arm** — the per-recipient filtering below is where a leak would come from, and the arms
that drop a message entirely are the ones that get missed.

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

**The second library added two rules, and they are the same rule twice: what a copy's name is
derived from decides what a re-pick resolves to.**

The first is a prefix. Copy names are derived from the source path, so `cave.png` in `maps/` and
`cave.png` in `portraits/` would otherwise resolve to one file: the second pick finds the first
already written, skips the write, and hands back a map as somebody's portrait. `Library::prefix` is
what separates them.

The second is that **a portrait is fingerprinted by its bytes rather than by its path**
(`Library::names_by_content`). Named from the path, a copy is written once and never again: the DM
replaces the art in `portraits/`, re-picks it, builds a fresh token, and is handed the old image
every time — the pick reads the new bytes, computes the same name, sees the file is there and skips
the write. Hashing the contents makes replaced art a genuinely different copy under a different URL,
which the token then picks up through the ordinary `update_token` that follows every pick. It also
makes the skip honest: the same name now means the same bytes, rather than merely the same path
asked for twice. Old copies are left behind rather than overwritten, which is the point — a token
already wearing one keeps it until the DM re-picks, instead of every token sharing that URL changing
at once, in every saved room.

**Maps opt out of both**, and this is the trap to avoid: the remembered calibration table is keyed
on the URL those names produce, so either a prefix or a content fingerprint would silently orphan
every map the DM has ever calibrated. The cost is that replacing a map's art in `maps/` still does
nothing — see *Maps and the map library* in `docs/maps.md`, which owns that reasoning.

Why it exists: the party's six portraits are the same six files every session, and the tokens they
go on are rebuilt whenever a map changes. Uploading the same face by hand each time is the work a
folder can do instead. Listing and picking are DM-only, like every route under `/api` — a player has
no credential to offer, and would only be reading off the DM's cast list for next week.

## Moving several at once

Shift-click gathers tokens into a **group**, and dragging any member moves all of them. Six goblins
crossing a corridor is one drag rather than six, which is the whole of what it is for.

**The server does not know this feature exists, and nothing was added to let it.** A group move is N
ordinary `MoveToken`s from one client — the room has always taken them one at a time, checks
`can_move` on each, snaps each with `snap_to_cell`, and recomputes sight on each drop. There is no
batched command and there is no group on `RoomState`. That is not a shortcut taken to save work; a
batch would have to re-answer permission, snapping and `moves_sight` for a collection, and every one
of those answers already exists for a single token and is the same answer.

**The permission question answers itself**, which is the reason this stayed small. Membership comes
from `tokenAt`, and tokens you cannot move are already transparent to the pointer there — so a group
can only ever hold tokens this client may move, and a player gathering their own two summons needs
no new rule. It is deliberately not DM-only for that reason: making it so would be a rule where
there is currently none.

Three rules make it a thing you have to be holding deliberately, so that no ordinary drag acquires a
second meaning:

- **Empty is the ordinary case.** Only shift-click puts anything in a group, so every gesture that
  does not use the modifier behaves exactly as it did before this existed.
- **Grabbing a member takes the group; grabbing anything else puts it down first.** A plain click on
  a token outside the group clears it, which is what keeps a plain drag a plain drag.
- **A click on empty map gives it up**, alongside clearing the panel's selection — both are "never
  mind this token". A pan does not, for the reason a pan has never cleared the panel either.
- **So does Escape**, which is what that key means to every tool in the rail. A group is a thing
  being held and the way out of anything held here is the same key; a board with walls traced across
  every square may not *have* an empty square to click on, which is the case the first rule alone
  does not cover. A drag already under way is unaffected — it captured its members at pointerdown
  and is a rigid body from then on, so Escape mid-drag still lands the move, exactly as it always
  has for one token.

A shift-click is **local and silent**: it commits on the way down, has no drag, and puts nothing on
the wire. It is checked above the ping timer for that reason and must stay there — a modifier held
deliberately is not somebody pointing at the board, and letting it reach `beginHold` would make a
slow gather into a ring on six screens. It sits *below* the three modal tools and behind
`sweeping()`, because an armed tool takes the button first and ping is the one exception this
project has agreed to have.

**The group is a rigid body, and each token still lands on its own cell.** Offsets are captured once
at pointerdown, so the formation that leaves is the formation that arrives; but they are held in
grid units and the server snaps every token separately, so a group of *mixed sizes* can settle half
a cell off the spacing it started with. That is `snap_to_cell` depending on how wide a token is, and
the alternative is a second copy of that rule on the client, which is the thing this project has
kept the server the sole owner of.

**One ruler for a group, not one per member** — the anchor's, the token the pointer actually went
down on. A reading is a single creature's question and six lines with six labels is a board nobody
can read. Be accurate about how far that goes, though: it decides the *dragger's* screen and only
that. Every other client builds its rulers from the `TokenMoved` frames it receives, and nothing on
the wire says which token was grabbed, so the table sees one ruler per moving token. Marking the
anchor on the wire was the alternative, and it is a poor trade — a new field on a hot message, for a
hint that refuses nothing and persists nothing. See *The trail* in `docs/drawings.md` for why the
rulers are built that way in the first place.

Members draw the same dashed ring the DM's edited token draws, and share the branch with it: they
are one question — which tokens is this gesture about — and two rings at one radius on the token
that is both would be one ring drawn twice. The group does **not** feed the token panel. That panel
edits one token and this gesture is about several, so building a group leaves the form describing
whatever was last plain-clicked; wiring them together would be signing up for a multi-edit form, and
"set size on eight tokens" is a feature nobody asked for.

`tools/drive-select.mjs` is where this is verified, because a pointer gesture over a canvas is
invisible to every other suite: there is no pure function in it for `npm test`, and the room cannot
tell one group drag from six separate ones. Its two sharpest checks are on the second connection —
that a shift-click changes nothing at all on the table's screen, and that a drag of one token moves
the other one there too.

## Names on the board

The board writes each token's name under it, and `RoomState::show_names` is the DM's switch for
whether it does. Off, the board is portraits and rings; on, it is portraits and rings and eight
labels. Six familiar party tokens do not need naming and a room full of goblins does, which is why
this is a switch rather than a decision.

**Room-wide, and the DM sets it for everybody.** Three placements were available and two are wrong.
Per map is where `fog` went and would be wrong here: it would fork the answer between the live and
staged slots and reset it every time a dungeon was loaded, and swapping the map is not a request to
relabel the tokens standing on it. Per token is wrong in the other direction — six checkboxes to
answer one question about the board. So it is a field on the room, `ClientMsg::SetShowNames` is its
own command rather than a field on `SetMap` or `UpdateToken`, and neither of those had to grow.

**It reaches everyone, which makes it `FogChanged`'s neighbour and not `WallsChanged`'s** — and that
is the interesting thing about it, because everything else the DM alone may *set* is also something
the table alone may not *see*. Not here: who flips it is a permission, what it says is not a secret.
A name the table can already read off their own initiative panel is not being withheld by leaving it
off the board, and the whole point of the switch is that one board is not labelled differently from
another. So `RoomView::show_names` is the same value for every recipient, `snapshot_for` does not
branch on identity for it, and `Event::NamesChanged` produces the same message for the DM and the
table alike — including an echo to the DM who sent it, because nothing on that panel is predicted
locally and that frame is how their own checkbox settles.

**It defaults to shown, and that costs `Saved` its only field-level serde default.** Every other
field on that file falls back to the container's `Default`, where a bool is `false` — so a save
written before this existed would load with every label gone. `#[serde(default = "shown")]` is what
keeps an upgrade from stripping a board nobody asked to strip; it is `MapInfo::grid_px`'s trap and
`fog: false`'s argument pointing the other way, and `a_save_from_an_older_schema_loads_with_defaults`
is what holds it.

The hit point bar is untouched by the switch. A running total is not a label, it already reaches
nobody but the DM, and hiding it here would be two features on one checkbox.

On the panel it sits **below a rule**, under the hint. Everything above that line describes the one
token in the form — including `hidden from the table`, which is a checkbox of the same shape two rows
up — and this describes the board. Without the divider it reads as a seventh field of whatever
happens to be selected. `tools/drive-names.mjs` drives the whole of it in two browsers at once,
because the half that matters happens on a connection the DM's client knows nothing about.

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

**A row carries a portrait, and the DM's rows carry hit points.** Neither needed anything on the
wire: `update` is handed the whole `Scene`, so it resolves each row's id to the token and reads
`img` and `hp` off it. The portrait is a `<span>` whose `background-color` is the same `#5a6472` the
canvas fills a token with, so "no art" degrades to the same grey disc in both places and there is no
image cache and no second download — the browser already has the URL.

The hit point bar has **no check for who is reading it**, and that is the point rather than an
oversight. `hp` is redacted in `TokenView`, so a player's copy of the token carries null and there is
nothing to decline to draw. It is invariant 4's shape, the same reason `drawHitPoints` needs no
guard, and it fails the safe way round: a secret added to `Token` and forgotten in `view_for` goes
missing from the DM's own panel rather than appearing in everyone's. `hpColour` is imported from
`render.ts` rather than copied, so the bar in a row and the bar over the token cannot come to
disagree about which monster is nearly down.

**The dropdown offers only what has not rolled**, and the row's own number is a field the DM can
type in. Those are one change rather than two: `Initiative::set` re-values a token already in the
order, so before this the way to correct a misheard roll was to pick the creature out of the
dropdown a second time — which is precisely the entry the filtered list stops offering. The command
is the same either way; only where it is typed moved. A list that goes on naming the six creatures
already in the fight is a list the DM reads past to find the seventh, and finding the seventh is the
only thing that list is for.

Three details the field needs and the span did not. It commits on `change` rather than on `input`,
because the order re-sorts on every value the server accepts and a row that moved on the first digit
would take the caret with it. It stops the click reaching the row, for the reason the `×` does. And
Escape puts the number back *before* blurring, since a blur commits and abandoning an edit has to be
possible. The player's row is still a span — re-valuing is the DM's, and their copy of the panel has
nothing to say about it.

When everything is in the order the picker holds one disabled placeholder and stops taking clicks.
That is the rail's rule about inert tabs, applied in the one part of this UI that is not a tab: a
control that looks armed and can do nothing is the same lie either way.

**Clicking a row looks at that creature** — the camera centres on it at whatever zoom is already
set, since somebody who wants to see something has not asked to be zoomed somewhere else. Everyone
gets it, not just the DM: the panel already lists only what that client may see. It is deliberately
*not* an automatic pan on turn change, which would yank the view out from under whoever was
mid-drag. The `×` stops the click propagating, because a click that deletes something is the last
one that should also be doing something else.

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

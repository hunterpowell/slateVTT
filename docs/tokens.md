# Tokens

The token struct, where a token settles, its five DM-only fields and its one public one, and how a
single token change leaves the room as different messages for different recipients.

Read this before touching `tokens.ts`, `panel.ts`, `markers.ts`, `library.ts`, `snap_to_cell`,
`SetShowNames`, `Token`/`TokenView`, or any `message_for` arm. The per-recipient filtering below is
where a leak would come from, and **the arms that drop a message entirely are the ones that get
missed.**

## Tokens

A token is a square `size` cells across, centred on its stored position. `size` is one of
`0.5, 1, 2, 3, 4`, a closed set checked on the server and offered to the DM as a dropdown rather
than a number field. Nothing here knows the words "large" or "huge"; that's rules knowledge. The
half size exists for a druid who is currently a rat.

**Where a token settles depends on how wide it is.** An odd width has a middle cell and settles on
that cell's centre; an even width has no middle cell and settles on the corner where four cells
meet. Either way its edges land on grid lines. Anything smaller than one cell settles like a
single-cell token rather than on a finer lattice of its own: a tiny creature belongs in a square with
the rest of the party, not tucked into a quarter of one. Resizing re-snaps, or a token grown from
1×1 to 2×2 would straddle half a cell until someone dragged it. A `staged_pos` is a position on the
same lattice and re-snaps with it. This rule lives in `snap_to_cell` on the server and nowhere else;
the client never snaps.

Creating, deleting and editing a token are DM-only, and the server assigns the id. One
`UpdateToken` carries every editable field, the way `SetMap` carries the whole grid. Position isn't
among them, because `MoveToken` owns that, and an edit made from a panel mustn't pull a token out
from under whoever is moving it. It carries no `staged` flag either, unlike the two commands beside
it, because every field on it is shared by both boards. `TokenChanged` covers creation and editing
alike: an id the client hasn't seen is a creation. That's one message instead of two that would
have to be kept in step, and it's the message that becomes a `TokenRemoved` for players and a
`TokenChanged` for the DM when a token is hidden.

Duplicating a token is `create_token` with the fields read from a token instead of from the
form, and it's client-only. The server already assigns the id and snaps the position, so a
`DuplicateToken` command would add a protocol tag and four enumerated arms and nothing else. The
form already keeps its fields after a create (six goblins is six clicks), so what duplicating adds
is the art, the hit point total, the light, the owner and the markers of a creature built earlier in
the evening, read from a token rather than typed again. It searches for a free spot outward from the
original rather than from the middle of the view, which is the one way it differs from a create: a
copy belongs beside the original. `staged_pos` isn't on `CreateToken` and isn't copied, so a copy
arrives with no plan; a plan is a cell, and two creatures don't want the same one.

**Deleting a token also removes its initiative row and its anchored drawings.** Otherwise the order
holds a row naming something that no longer exists, which the panel draws as a bare id and
`next_turn` hands the turn to, and an anchored shape follows a token with no position.

The Delete key deletes every token with a selection ring: the panel's token, the group, or both. The renderer already treats the two as one question (which tokens is this gesture
about; see *Moving several at once*), and the key does the same. The handler builds the union and
hands it to `TokenTool.remove`, which confirms once, naming every creature, and sends N ordinary
`delete_token`s, as a group drag sends N moves. There's no batch command, and a batch would answer
nothing differently. Backspace does the same, because that's the key a Mac labels "delete". It's
bound in `start()` in `main.ts`, the one place both selections are in scope, and only when a token
tool exists, so a player's Delete does nothing instead of getting a refusal for a command they may
not send. It's ignored inside a field (`typingIn`) and while the wall editor is armed, where
Backspace already means "remove the last corner" and a stray press mid-trace mustn't delete a
creature. The keyboard path still confirms: undo can bring a token back, but one step at a time, and
six dead goblins are six steps.

Token art is optional: a token without it draws as a named disc, so the sixth goblin of the evening
costs the DM nothing. `img` must be a site-relative path. Art on someone else's server disappears
the evening that server is down, and it's the one thing in a save the uploads directory wouldn't
back up. Uploading art goes through the same `add` handler as maps, since proving some bytes are an
image and naming them ourselves is the same operation either way. Both libraries accept the same
image formats; they differ in the size cap and in how the copy is named (below).

### The portrait library

`portraits/` is to token art what `maps/` is to maps, and it's the same mechanism, not a second
one. The DM lists what's there and picks one by path, the pick copies into the uploads
directory, and the token gets the same kind of URL an upload returns. Nothing downstream (`img`,
the save file, what a player is sent) can tell the two apart. The directory is `SLATE_PORTRAITS`,
defaulting to `../portraits`. The reasoning is in *Maps and the map library* in `docs/maps.md`;
this is the same feature over a different folder, and both sides are shared code rather than a
copy: `Library` in `main.rs`, `library.ts` on the client.

Since milestone 32, uploading art means adding it to `portraits/`. The "upload art…" button
belongs to the library widget now, so a picture the DM drags in for one monster is in the folder for
the next one, and the token panel has one code path instead of two. Each row of the list has a
remove button, which deletes the file in `portraits/` and not the copy the token is using. *Adding
and removing* in `docs/maps.md` has the rules for every library folder.

This affects the rule below. A portrait is fingerprinted by its bytes, so replacing art in the
folder gives a new copy under a new URL. And an add refuses a name that's already taken, so
replacing a portrait through the panel is two steps: remove, then add. That's intended. A silent
overwrite is the one outcome here with no undo, and the two-step version is the one where the DM
sees the file go.

The second library added two rules, and both are about what a copy's name is derived from,
because that decides what a re-pick resolves to.

The first is a prefix. Copy names come from the source path, so `cave.png` in `maps/` and
`cave.png` in `portraits/` would otherwise resolve to one file: the second pick finds the first
already written, skips the write, and returns a map as someone's portrait. `Library::prefix` keeps
them apart.

The second is that a portrait is fingerprinted by its bytes rather than its path
(`Library::names_by_content`). Named from the path, a copy is written once and never again. The DM
replaces the art in `portraits/`, re-picks it, builds a new token, and gets the old image every time:
the pick reads the new bytes, computes the same name, sees the file exists and skips the write.
Hashing the contents makes replaced art a different copy under a different URL, which the token then
picks up through the ordinary `update_token` that follows every pick. It also makes the skip
correct: the same name now means the same bytes, not just the same path requested twice. Old copies
are left in place rather than overwritten, on purpose: a token already using one keeps it until the
DM re-picks, instead of every token sharing that URL changing at once, in every saved room.

**Maps opt out of both, and this is the trap to avoid.** The remembered calibration table is keyed
on the URLs those names produce, so either a prefix or a content fingerprint would orphan every map
the DM has ever calibrated, without any error. The cost is that replacing a map's art in `maps/`
still does nothing. *Maps and the map library* in `docs/maps.md` has that reasoning.

Why it exists: the party's six portraits are the same six files every session, and the tokens they
go on are rebuilt whenever the map changes. Uploading the same faces by hand each time is work a
folder can do. Listing and picking are DM-only, like every route under `/api`: a player has no
credential to offer, and could only use it to read the DM's cast list for next week.

## Moving several at once

Shift-click, or a box dragged across bare board, gathers tokens into a group, and dragging any
member moves all of them. Six goblins crossing a corridor is one drag instead of six, and that's all
it's for.

**The server doesn't know this feature exists, and nothing was added to it.** A group move is N
ordinary `MoveToken`s from one client. The room has always taken them one at a time: it checks
`can_move` on each, snaps each with `snap_to_cell`, and recomputes sight on each drop. There's no
batch command and no group on `RoomState`. That isn't a shortcut. A batch would have to answer
permission, snapping and `moves_sight` again for a collection, and each of those already has an
answer for a single token that's also the right answer here.

The permission question answers itself, which is why this stayed small. Membership comes from
`tokenAt` and `inMarquee`, and both skip tokens you can't move, so a group can only ever hold tokens
this client may move. A player gathering their own two summons needs no new rule.
That's why it isn't DM-only: making it so would add a rule where there currently is none.

These rules make a group something you have to be holding on purpose, so that no ordinary drag
gains a second meaning:

- Empty is the normal state. Only shift-click and a box add anything to a group. A box is a left
  drag on bare board, which used to pan; pan moved to the right and middle buttons (*The box*,
  below) so that no drag has two meanings.
- Grabbing a member takes the group; grabbing anything else drops the group first. A plain click
  on a token outside the group clears it, which keeps a plain drag a plain drag.
- A click on empty map drops the group, along with clearing the panel's selection; both mean
  "never mind this token". A pan doesn't, for the same reason a pan has never cleared the panel,
  and a right or middle click is never a click on empty map (`clicks` on the pan drag).
- So does Escape, which is what that key means to every tool in the rail. A group is something
  being held, and Escape is how you let go of anything held here. A board with walls traced across
  every square may not have an empty square to click on, which the previous rule alone doesn't
  cover. A drag already in progress is unaffected: it captured its members at pointerdown and moves
  as one from then on, so Escape mid-drag still completes the move, as it always has for one token.

A shift-click is **local and silent**: it takes effect on the way down, has no drag, and sends
nothing. For that reason it's checked before the ping timer and must stay there. Holding a
modifier on purpose isn't pointing at the board, and letting it reach `beginHold` would turn a slow
gather into a ring on six screens. It's checked *after* the three modal tools and after
`sweeping()`, because an armed tool gets the button first, and ping is the one exception to that
this project has agreed to.

The group moves as one shape, and each token still lands on its own cell. Offsets are captured
once at pointerdown, so the formation that leaves is the formation that arrives. But they're held in
grid units and the server snaps each token separately, so a group of *mixed sizes* can end up half a
cell off its starting spacing. That's `snap_to_cell` depending on how wide a token is, and the
alternative is a second copy of that rule on the client, which the project avoids by keeping the
server the only place snapping happens.

A group gets one ruler, not one per member: the anchor's, the token the pointer actually went
down on. A distance reading is a question about one creature, and six lines with six labels is a
board nobody can read. This only applies to the *dragger's* screen, though. Every other client builds
its rulers from the `TokenMoved` frames it receives, and nothing on the wire says which token was
grabbed, so the table sees one ruler per moving token. The alternative was marking the anchor on the
wire, and it's a poor trade: a new field on a high-frequency message, for a hint that refuses
nothing and persists nothing. *The trail* in `docs/drawings.md` explains why rulers are built that
way.

Members draw the same dashed ring as the token the DM is editing, and share the code branch with it:
both answer which tokens this gesture is about, and a token that's both would otherwise get the same
ring drawn twice at one radius. The group does not feed the token panel. That panel edits one
token and this gesture is about several, so building a group leaves the form showing whichever token
was last plain-clicked. Connecting them would mean building a multi-edit form, and "set size on
eight tokens" is a feature nobody asked for.

### One group

**A token with a ring is in the group** (milestone 45). The ring and the Delete key cover the
panel's token as well as `selection`, and before this a drag moved only `selection`: plain-click
the fighter, shift-click two goblins, drag a goblin, and the fighter stayed behind with its ring on
while Delete still asked about all three.

- A shift-click or a shift+box adds the panel's token to `selection` along with what it gathers,
  so from then on the ring set and `selection` are one set. A plain-clicked token with nothing
  gathered is a group of one, which already dragged correctly.
- A shift-click on the panel's token drops it from `selection` and clears the panel, including when
  it's a group of one. Dropping it from `selection` alone would leave it ringed and outside the
  group again.
- Escape empties `selection` and leaves the panel's token ringed: a group of one.

`input.ts` reads the panel's token through the `selected` getter passed beside `onSelect`. Nothing
else needs to know, because the panel's token is set in one place (a plain click on the board) and
every other path only clears it. Only the DM has a panel, so none of this applies to a player.

This doesn't reverse the rule above. The form still shows the token last plain-clicked; what
changed is which tokens a drag moves.

### The box

A mouse's left-drag on bare board draws a box, and on release every token whose centre is inside
it, among those `tokenAt` would let you grab, joins the group. A plain box replaces the group and
clears the panel, as a click on empty ground does, since otherwise the panel's token would keep a
ring outside the group. Clearing the panel loads nothing into the form, so it isn't the form
following the group. Shift+box adds. A box that never left the click slop (`DRAW_CLICK_SLOP_PX`,
not a pan's "any pixel", so a jittery click on a door still swings it) is a click on empty ground,
unless shift was down, in which case it does nothing: shift only ever adds.

It's local and silent like a shift-click, and computed once on release. Only the box is drawn
during the drag, from `InputState.marquee`, in world coordinates. `inMarquee` in `marquee.ts` is the
membership rule and is a pure function with its own tests.

Two consequences, both deliberate:

- **Pan moved to the right and middle buttons**, and right-drag also pans with a modal tool armed.
  The canvas suppresses `contextmenu`; the rail and dock keep the browser's. A touch or pen drag on
  bare board still pans, because a finger has no right button and touch mustn't break, so the box is
  gated on `pointerType === 'mouse'`.
- **The door-swing-or-clear branch belongs to a left click on bare board, not to the pan.** Before
  this it ran for any pan that didn't move, so a middle-click on a door swung it. With right-drag
  panning, a reflexive right-click on a door would have opened it on every screen. It now runs for
  a box that never moved and for a touch or pen pan that never moved (`clicks` on the pan drag), and
  a right or middle release does nothing.

A shift-press that misses every token skips `beginHold`, for the shift-click's reason above: a
shift+box that paused before moving would otherwise ping every screen.

A trackpad reports as a mouse, so this took away click-drag panning from trackpad users, and most
have no right-drag. *The bottom-right corner* in `docs/frontend.md` covers the switch that gives
them two-finger pan.

`tools/drive-select.mjs` tests this, because a pointer gesture over a canvas is invisible to every
other suite: the only pure function in it is `inMarquee`, and the room can't tell one group drag
from six separate ones. Its most important checks are on the second connection: that a shift-click
or a box changes nothing at all on the table's screen, and that dragging one token moves the other
there too. `drive-ui.mjs` checks that a right-click on a door doesn't swing it, and
`drive-ping.mjs` that a held shift-press doesn't ping.

## Names on the board

The board writes each token's name under it, and `RoomState::show_names` is the DM's switch for
whether it does. Off, the board shows portraits and rings; on, it shows portraits, rings and eight
labels. Six familiar party tokens don't need names and a room full of goblins does, which is why
this is a switch rather than a fixed choice.

It's room-wide, and the DM sets it for everyone. There were three possible places for it and
two are wrong. Per map is where `fog` went, and would be wrong here: it would split the setting
between the live and staged slots and reset it every time a dungeon was loaded, and changing the map
isn't a request to relabel the tokens on it. Per token is wrong the other way: six checkboxes to
answer one question about the board. So it's a field on the room, `ClientMsg::SetShowNames` is its
own command rather than a field on `SetMap` or `UpdateToken`, and neither of those had to grow.

It's sent to everyone, so it goes with `FogChanged`, not `WallsChanged`. That's what makes it
notable: nearly everything else only the DM may *set* is also something only the DM may *see*. Not
here. Who flips it is a permission question; what it says isn't a secret. A name the table can
already read in their own initiative panel isn't being withheld by leaving it off the board, and the
purpose of the switch is that every board is labelled the same way. So `RoomView::show_names` is the
same value for every recipient, `snapshot_for` doesn't branch on identity for it, and
`Event::NamesChanged` produces the same message for the DM and the table. That includes an echo to
the DM who sent it, because nothing on that panel is predicted locally and that frame is how their
own checkbox updates.

**It defaults to on, which needs a serde default on the field itself.** It was the first field on
`Saved` with one; `show_cursors` and `show_dm_cursor` have since added two more. Every other field
falls back to the container's `Default`, where a bool is `false`, so a save from before this
existed would load with every label gone. `#[serde(default = "shown")]` stops an upgrade from
changing a board nobody asked to change. It's the same trap as `MapInfo::grid_px`, and the same
argument as `fog: false` applied in the other direction.
`a_save_from_an_older_schema_loads_with_defaults` tests it.

The switch doesn't affect the hit point bar. A running total isn't a label, it already reaches only
the DM, and hiding it here would put two features on one checkbox.

It's on the table tab, and it took four milestones to get there. It used to sit under a divider
at the bottom of the token panel, with two comments in the markup explaining why a control about the
board was inside a form about one creature. Needing two comments to explain a placement was the sign
it was wrong. `show_names` is a `RoomState` field, so it goes where `RoomState` fields go. The rule
that came out of moving it matters more than the move: **a panel goes where its fields live**.
`MapInfo` is the map tab, `Token` is the token tab, room-wide state is the table tab, and this was
the only exception before the move. At the time, `table.ts` was fourteen lines of listener and
`createTableTool` armed nothing, so the rail needed no `stop()` from it. The backdrop picker has
since given it one (see *Backdrop* in `docs/maps.md`); the panel is still never inert, so its tab
never greys.

`tools/drive-names.mjs` tests all of it in two browsers at once, because the half that matters
happens on a connection the DM's client knows nothing about.

## Hidden tokens, hit points, and the light it carries

Three DM-only fields on a token, and where per-field redaction started. Staging withholds a whole
message; these withhold a field on a token the table otherwise sees. That's why they came before
fog: getting it wrong costs one monster's hit points rather than the whole map.

`hidden` means absent, not drawn faintly. A hidden token is filtered out of a player's
`snapshot_for`, its `TokenMoved` frames are dropped for them, and its initiative row is removed from
their panel. It applies whoever owns the token. A uniform filter is worth more than a rule stopping
the DM from hiding a player's own token, which is just a strange thing to do.

`light_ft: Option<f32>` is the third field, and it's shaped exactly like `hp`. It's how far
this token lights the board: a lantern on a token the party owns, and what makes a brazier a light
at all on any other token. It reaches the DM and nobody else, and `None` means both "carries no
light" and "you're not the DM". The table learns what a light does from the fog it casts, the same
argument the walls make. `docs/fog.md` has the rule and the line-of-sight check. What belongs here
is that **`UpdateToken` replaces the token whole**, so anything building one from a token it already
has must carry this field through, or it puts the lantern out. The damage box on the initiative row
builds one, and it's the case the compiler caught.

`hp: Option<Hp>` reaches the DM and nobody else, on every token including a player's own.
`None` means both "the DM keeps no total on this one" (the usual state) and "you're not the DM", and
a client can't tell the two apart, the same as `staged` being `None`. The pair travels together so
half a hit point total can't be represented. Bounds are on magnitude only: whether `current` may
exceed `max` is a question about what a hit point *means*, and that's rules knowledge Slate doesn't
have. Players track their own totals on their own sheets; character sheets are a non-goal.

### The three shapes one event leaves in

`Event::TokenChanged` becomes a `TokenChanged` for the DM, a redacted `TokenChanged` for a player
who may see the token, a `TokenRemoved` for a player it has just been hidden from, and **nothing at
all** for a player it was already hidden from. That last arm is the one that gets missed: a
`TokenRemoved` naming an id they never had tells them a token exists, which is exactly what's being
withheld.

Telling those last two apart needs the token's visibility from *before* `apply` ran, which
`message_for` can't read from `&self`. So `Event::TokenChanged` and `Event::TokenRemoved` each carry
`was_unseen`. A newly created token counts as unseen, because nobody has it yet, which is what makes
creating a hidden token announce nothing.

"Unseen" rather than "hidden", because there are three reasons now. `Token::unseen()` is
`hidden || staged_only`, the two reasons that are facts about the token. The third is line of
sight, a fact about the room, so the question every filter asks is
`RoomState::unseen_by_table(&Token)`, which is `token.unseen() || !self.in_sight(token)`.
`snapshot_for`, `initiative_for` and all three `message_for` arms go through it. A creature the DM
took off the board, one that was never on it, and one the party can't see are different facts, and
they combine; anything that filters on one and forgets another is a leak. **Calling
`Token::unseen` directly from a filter checks two of the three.** (Vision sources do call it
directly, because what the party can see can't be an input to computing what the party can see.)
See *Preparing the next room*.

### Initiative

`initiative_for(is_dm)` drops rows naming a token the recipient can't see, and nulls `current` when
it names one. Both halves matter. The panel names its rows by looking the token up in the scene, so a
row with no token draws as a raw id: the monster the DM just hid, advertised by the one panel that's
always on screen. `current` is an id, and an id is data. The round number isn't a secret and is sent
as is; the table sees the turn pass to something they can't see, which is what's happening.

**So hiding a token that's in the order also emits `InitiativeChanged`**, as deleting one does.
Nothing else about a token edit rebuilds the panel, so without it the table keeps a row naming a
token their client has just been told to forget.

`N` advances the turn, with no modifier (Ctrl+N belongs to the browser) and not inside a field,
where it's a letter. It's the first unmodified letter key in the client, given to the button the DM
presses more than any other in a fight. It's bound in `createPanel` inside the `isDm` branch, so a
player's `n` sends nothing rather than a refused command. It isn't guarded on an empty order, because
the button isn't, and the room's `next_turn` does nothing there rather than returning an error.

A row shows a portrait, and the DM's rows show hit points. Neither needed anything on the wire:
`update` is given the whole `Scene`, so it looks up each row's id and reads `img` and `hp` from the
token. The portrait is a `<span>` whose `background-color` is the same `#5a6472` the canvas fills a
token with, so "no art" looks like the same grey disc in both places, and there's no image cache
and no second download because the browser already has the URL.

The hit point bar has no check for who is reading it, and that's correct. `hp` is redacted in
`TokenView`, so a player's copy of the token carries null and there's nothing to skip drawing. That's
invariant 4 in practice, the same reason `drawHitPoints` needs no guard, and it fails safe: a secret
added to `Token` and forgotten in `view_for` goes missing from the DM's own panel rather than
appearing in everyone's. `hpColour` is imported from `render.ts` rather than copied, so the bar on a
row and the bar over the token can't disagree about which monster is nearly down.

The dropdown offers only creatures that haven't rolled, and each row's own number is a field the
DM can type in. Those are one change, not two. `Initiative::set` re-values a token already in the
order, so before this, correcting a misheard roll meant picking the creature from the dropdown a
second time, which is exactly the entry the filtered list no longer offers. The command is the same
either way; only where it's typed moved. A list that keeps naming the six creatures already in the
fight is one the DM has to read past to find the seventh, and finding the seventh is all that list
is for.

The field needs three things the span didn't. It commits on `change` rather than `input`, because
the order re-sorts on every value the server accepts, and a row that moved on the first digit would
take the caret with it. It stops the click reaching the row, for the same reason the `×` does. And
Escape restores the number *before* blurring, since a blur commits and abandoning an edit has to be
possible. The player's row is still a span: re-valuing is the DM's job, and the player's copy of the
panel has no use for it.

### The damage box

Damage is typed on the row, because the row is what the DM is looking at. Before this, taking
twelve off a monster meant: click it on the board, open the token tab, subtract twelve in your head,
type the new total. This removes three of those four steps. The box sits beside the bar that's
already on screen, and it takes the *number rolled* rather than the resulting total.

`-12` is damage, `+7` is healing, and a bare `35` is the new total. `parseHpEntry` is the whole
grammar. It's a pure function with a table of cases in `panel.test.ts`, and anything that isn't one
of those three forms returns `null`, which the box handles by clearing itself without a message.
That's `valueField`'s rule that a row resets itself rather than sending the server something to
interpret. The box is also emptied after a successful commit, because it holds an *instruction*
rather than a value, and a `-6` left in it is a hit waiting to be applied twice.

It isn't on the token tab, and that doesn't break `docs/frontend.md`'s rule. That rule decides
which *rail panel* a control goes on, and the initiative panel isn't one. It's the same exception
`valueField` already is, for the same reason: correcting a number belongs on the row showing it.
What stayed on the token tab is the absolute `hp`/`max` pair, and it's now needed, not just left
alone: `-3` in the row's box means three damage, so the tab is the only place left that can set a
creature's total *to* minus three, which the server allows.

No permission check, the same as the bar beside it. The box is built inside the `hp !== null`
branch and gated on nothing else. `view_for` redacts `hp`, so a player's copy of every token
carries null and the branch never runs for them; `asTable` strips it the same way, so player view
doesn't show it either. That's invariant 4 failing safe again: a secret added to `Token` and
forgotten in `view_for` goes missing from the DM's own panel rather than appearing on everyone's.

**The one extra thing it needed was keeping focus.** This panel is rebuilt completely on every token
delta, including the room's echo of the hit just applied, so committing a number destroys the box it
was typed into. Two hits on the same creature in a row is the normal case, so `update` records which
`data-hp-for` had focus and restores it after `replaceChildren`. Drag frames aren't a problem here:
`onTokenMoved` doesn't rebuild this panel, which is the only reason an input on a row is practical at
all.

Nothing on the wire changed. The box does the arithmetic and sends an ordinary `UpdateToken`, built
by read-modify-write from the token the row already looked up. That's the same approach as
milestone 18, and why this touched no Rust.

When everyone is already in the order, the picker holds one disabled placeholder and ignores clicks.
That's the rail's rule about inert tabs applied to the one part of this UI that isn't a tab: a
control that looks usable but can do nothing is misleading either way.

Clicking a row centres the camera on that creature at the current zoom, since someone who wants
to see something hasn't asked to zoom somewhere else. Everyone gets this, not just the DM: the panel
already lists only what that client may see. It's intentionally *not* an automatic pan on turn
change, which would move the view out from under whoever was mid-drag. The `×` stops the click
propagating, because a click that deletes something shouldn't also do anything else.

### It folds the list and never the turn

A dozen rows of portrait, name and hit point bar take up most of a screen's height, permanently, in
the corner. The chevron in `.init-head` reclaims that space, and collapsed means `update` renders
only the current row, filtered before the existing row loop. No second header, no duplicate
portrait code, and the folded panel is literally the unfolded one's highlighted row rather than a
second rendering of it.

**It never collapses to a bare tab**, and that's the rule this depends on. This panel exists to be
glanced at, and whose turn it is is the most-asked question at a table. Hiding it behind a click is
the mistake that letting doors open with no tool armed already avoids, and worse here, because what
would be hidden is information rather than an action. So the turn buttons stay available beside the
one row; advancing the turn from a folded panel is most of what folding is for. The DM's roll form
and clear button fold with the rows they edit.

The collapsed state is in `localStorage`, and that's where the line falls that puts `diagonals`
on the other side. `diagonals` is on `RoomState` because the server's job there is making six
clients agree on a *rule*. How much of a panel someone wants on their own screen is nobody else's
business, and nothing has to agree on it. The read is wrapped the way `identity.ts` wraps its own,
because some private browsing modes throw on the property itself.

One case needed its own rule: collapsed, with a fight running, and whoever's turn it is not on
this client's board. A hidden creature's row is filtered out of the table's copy on the server, so
the folded list has nothing to draw, and `#init-list:empty::after` would then say "no combat", which
is false. `is-quiet` suppresses that, and the round counter in the header shows what's true.

No auto-collapse outside combat. It was considered and dropped: the panel is already small when
the list is empty, so there's nothing to reclaim. It's only large during a fight, which is when it's
wanted.

Decided at the same time, so milestones 23 and 24 don't reopen it: the initiative panel stays a
fixed panel with the right-hand dock beneath it, rather than becoming the dock's third tab. The
dock is for reading and replying; this is state to glance at. The dock's own design already refuses
to open by itself, for the same reason the header row here has to stay visible when folded.

### On screen

Hidden tokens are only ever sent to the DM, so the client never has to guard against drawing one;
the only question is how the DM tells them apart. They're drawn faded *and* with a dashed violet
ring. Faded alone looks like a slow-loading portrait, dashed alone looks like a selection, and violet
doesn't clash with any existing ring meaning. Fading multiplies with preview ghosting rather than
replacing it. The same violet marks the row in the DM's initiative panel, because the DM's panel and
the table's now differ, and the DM is the one who needs to know which they're reading.

Hit points draw as a bar above the token with the numbers over it, in screen space like a name.
Three colour bands rather than a gradient: a DM glancing at six monsters wants to sort them, and
nothing here knows the word "bloodied". Damage is typed as a change on the initiative row (see *The
damage box* above). There's no `SetHp`, because it would carry one of the several fields
`UpdateToken` already sends together, and the box sends an absolute total it computed itself.

## Preparing the next room

The staged map gives the DM the next *map*; these two fields give them the next *encounter*:
monsters placed on that map before the party arrives, and a plan for where the party lands when it
does. Nothing here reaches the table until promote.

One token, not two copies. `staged_pos: Option<Pos>` is where a token lands on promote, and
`staged_only: bool` says it doesn't exist on the live board yet. A separate `staged.tokens`
collection is the obvious alternative and a trap: with two copies, a rename, new art or a resize has
to be applied to both, and they drift apart. Only *position* and *existence* differ between boards.
Name, art, size, owner, `hidden` and `hp` have one value, which is also what a DM wants; nobody needs
a goblin with different art on two maps. That's why `UpdateToken` alone has no `staged` flag.

`Pos` exists so half a position can't be represented, as `Hp` does for hit points. This doesn't
conflict with invariant 1: a staged position is in cells like every other position, which is what
makes recalibrating the staged map after placing monsters safe.

So a token is in one of three states:

| State | Live board | Preview |
|---|---|---|
| Live, unplanned | at `x, y` | at `x, y`, staying put |
| Live, planned | at `x, y` | at `staged_pos`, will move on promote |
| Staged-only | **absent, including for the DM** | at `staged_pos` |

**Staged-only tokens must be absent from the DM's own live board.** Switching back to `Map` mode
has to show the board as the table sees it, or the DM loses the one view they have of what everyone
else is looking at. It's also why the live board doesn't mark a planned token at all: plans are shown
in preview, and the live board has to match what the table sees.

Both fields are DM-only and reach the DM's client because `Token::view_for` includes them for the
DM, since the DM's board is what draws a plan. There's no command to cancel one token's plan:
dragging it back onto its live cell leaves a `staged_pos` that promote applies as a no-op, which has
the same result with far less code.

### Promote, discard, and what goes with the staged map

Promote is a batch, and the one moment the whole table sees many changes at once. Every `staged_pos`
is adopted as `x, y` and cleared, every `staged_only` is cleared, and `Event::Promoted` goes out in
three shapes. The DM gets a whole `TokenChanged`, because their client holds the two fields that
were just emptied and can't learn that from a `TokenMoved`. A player seeing the token for the first
time gets a `TokenChanged`. A player who could already see it gets a plain `TokenMoved`. A token
that's still `hidden` gets none of them: a promote settles `staged_only` and says nothing about the
other reason.

The pitfalls all come down to one rule: **staged token state belongs to the staged map and has to
go when it goes.**

- `ClearStaged` clears every `staged_pos` and deletes every `staged_only` token.
- **A load into the staged slot does the same, and a recalibration must not.** `SetMap` already
  tells the two apart by URL; this uses the same `loading`. Correcting the grid after placing an
  ambush is a normal thing to do and mustn't delete the ambush. This is the arm that gets missed.
- A load into the *live* slot doesn't touch them. A plan describes a cell on the staged map, which
  that command hasn't changed.
- Deleting a token removes its `staged_pos` with it, like any other field.
- `MoveToken`/`CreateToken` with `staged: true` are refused when nothing is staged, and a
  `staged_only` token can't be moved on the live board or added to initiative. All of these are
  refused the way a nonexistent token is. Initiative is for the fight happening now.

Clearing a plan is a DM-only message. `Event::TokenPlanChanged` is the token-level equivalent of
`StagedChanged`. A player's copy of the token is identical before and after, so the only thing a
frame could tell them is that the DM just threw a plan away. That's still information, and
invariant 4 is about what a client may know.

### On screen

Staged-only tokens draw with a teal ring; nothing fades for being previewed any more. Hidden tokens
still fade and still get a dashed ring, so a monster built on the next map *and* hidden shows as
teal, faint and dashed: three marks for three independent facts, none cancelling another.

`shownPos(scene, token)` is `shownBoard`'s counterpart for tokens. It returns `null` for a token
absent from the board on screen, and every draw and hit-test goes through it. That function is the
entire client-side feature: without it, a single missing branch writes a planned position into the
live one.

## Markers

Six colours and `dead`. The names are the feature. What "red" means tonight is between the DM
and the table. A variant called `Poisoned` would be the 5e rules knowledge this project refuses, and
once one exists something downstream wants to know what it *does*: how long it lasts, what it
subtracts, whether it ends on a save. Slate draws arcs and an X and knows nothing about any of that,
and there's nowhere in `drawMarks` or `markers.ts` for a rule to go.

### Why `dead` is allowed and `Poisoned` isn't

`dead` was added a day after the six colours, because the table needed it, and a marker meaning
"this one is out of the fight" is like a coin placed on a mini, not a rules engine. It's worth being
precise about the line it doesn't cross, because the obvious reading is that it crosses it.

The rule was never "colours only". That was just how the set looked when every member happened to be
a colour, and reading it as the rule is what would make `dead` look like a violation. The rule is
that **nothing in Slate knows what a mark means**, and the test is mechanical: *does anything follow
from it?* Nothing follows from `dead`. The creature still moves, keeps its initiative row, keeps
whatever total the DM has on it, blocks nothing and lights nothing. The X is a picture, as a red arc
is.

`Poisoned` would fail that test the day after it was added, and that's the whole difference. A
condition implies something is tracked (a duration, a saving throw, a number it subtracts), and none
of that exists here. So the field would either do nothing and misrepresent what the tool does, or
grow into the thing this project refuses. `Prone` and `Concentrating` get the same answer for the
same reason.

`drive-panels.mjs` tests the negative half directly: a creature marked dead keeps its initiative row
and its total. That check is cheap and looks a little odd, and it's there because this boundary is
what the feature is. The day a marker starts skipping a turn, the argument above stops being true,
and something should fail when that happens.

**It's the only public field on a token.** Every other difference in what `Token` sends goes one way
(`hp`, `light_ft`, `staged_pos` and `staged_only` all reach the DM and nobody else), so `view_for`
had only ever been asked to redact. This field is copied for everyone, because *a mark nobody at the
table can see isn't a mark*. It's the same reasoning that puts `NamesChanged` with `FogChanged`
rather than `WallsChanged`, applied to one token: who may set it is a permission question, and what
it says isn't a secret.

It needs no filter of its own, and couldn't usefully have one. A creature the table can't see takes
its marks with it through `unseen_by_table`, like every other fact about it, so the negative
assertion holds without any code defending it.
`a_mark_on_a_creature_the_table_cannot_see_reaches_nobody` tests it because the doc makes the claim,
not because anything branches on it.

The set is closed, and serde checks it rather than hand-written code. `Marker` is a fieldless
enum, so an unknown marker fails to deserialize and `check` needs no validity arm. `ShapeKind` and
`Diagonals` work the same way, and `check` says so explicitly. Adding `dead` was one variant in that
enum and one entry in `Marker::ALL`: no command, no event, no filter and no `protocol-tags.json`
entry, because the closed set is all there is to a marker. The colours are `MARKER_HUES` in
`markers.ts`, and the server has no opinion about what any of them looks like, just as `PLAYER_HUES`
belongs only to the client.

The list is a set, and refusing duplicates is what limits its length. There's no `MAX_MARKERS`
beside `MAX_TOKENS`, and none is needed: `Marker::ALL` is a closed set, so "no repeats" caps the list
at that set's length however long the array on the wire was. That held with no edit at all when the
set grew from six to seven, which is the advantage of a limit that's a type rather than a number.
It's the count limit `docs/net.md` requires of every command carrying a variable-length collection,
and `UpdateToken` was the second command in the project to need one. That file covers the byte limit
beside it.

It travels in `CreateToken` and `UpdateToken`, as `light_ft` did in milestone 39, which is what
made it cheap. No new command, no new event, no arm in `message_for`, no entry in `persists`,
`undid` or `moves_sight` (all three match `UpdateToken { .. }`), and `protocol-tags.json` is
untouched. Undo works with no extra code: `taking_back_a_mark_is_an_ordinary_undo` is all it took.
`UpdateToken`'s own doc comment is the argument against a separate `SetMarkers`, the same one that
keeps `SetHp` from existing.

### Where they're toggled, and the check that isn't automatic

In two places, the same as `hp`: the token tab, where a creature is built, and the initiative
row, which is what the DM is looking at during a fight. That's *The damage box* above applied to a
different field: a control that costs a tab switch and two clicks during a turn is one nobody uses.
`markerRow` in `markers.ts` builds both, so the swatch on the panel and the mark on the board can't
disagree about which colour `blue` is, as with `hpColour`.

**It's the first control on an initiative row that needs a real check for who's reading it.** The
bar and the damage box need none because `view_for` nulls `hp` for a player, so their copy of a
token has nothing to draw. That's invariant 4 failing safe, three times on this panel. Markers are
public, so a player's copy does carry them, and there's no null to make the branch fail safe.
`if (isDm && token !== undefined)` is that check, and `valueField` is the precedent, not a new rule:
the player's initiative number is a span for the same reason.

The token panel renders its swatches once when it's created, which nothing else in that form
needs. Every other field is initialised by the markup and only rewritten by `show`, and `show`
doesn't run until something is selected, so a panel opened on a fresh page showed no swatches at
all. There's no markup for six generated buttons, so that initial call is what provides them before
anything is selected.

### On screen

A band of arcs drawn inside the token's rim, and an X across the portrait for `dead`. Both are
drawn in `drawMarks`, which is called from `drawTokens` rather than `drawTokenChrome`. That reflects
what they are: a mark is a property of the *creature*, so it's drawn on the creature, while
everything in `drawTokenChrome` is a property of the situation and draws around it. World space,
unlike the name and the numbers, with line widths divided by `zoom` so they keep a constant weight on
screen as the rings do. The caller has already set `globalAlpha`, so a hidden creature's marks fade
with the rest of it at no extra cost.

Two layouts were wrong before this one, and each was only visible when drawn. The first was a
column of pips down the token's right-hand edge, the only space around a token nothing else used
(the bar and numbers are above, the name below), and that was the problem: two creatures side by
side put one's pips against the other's rim, and in a fight adjacent tokens are normal. Centring the
pips above the token fixed that but left the second problem: a dot beside a creature reads as
decoration, and a band on it reads as a state. That isn't about legibility, and bigger pips
wouldn't have fixed it.

Arcs divide one band; they never stack. One mark takes the whole ring; two or more split it
evenly, clockwise from twelve o'clock, with `MARKER_ARC_GAP` between them. Dividing keeps the
footprint the same whether a creature has one mark or six, which the pip column didn't, and it's why
a ring per marker was never considered: three state rings plus six marker rings turns a
half-cell token into a target. A continuous dark track under the arcs does what a halo would, plus
one thing a halo wouldn't: it makes the gaps read as gaps rather than as the portrait showing through.

The marker colours overlap the player palette and the ring colours, and three are close enough
to matter: yellow against the gold that means *yours*, blue against the blue that means *in
progress*, purple against the violet that means *hidden*. `pings.ts` limits its own colour set to
avoid exactly that, and markers can't, because the six are the DM's to mean anything.

**Position separates them, not hue.** The band is drawn inside the rim, the one place on a token
nothing else draws, and every state ring is outside it, so gold ownership sits just outside a yellow
arc instead of competing with it for the same space. Move the band outward past the rim and the
clash comes back, because hue is then all a reader has. That's also why the band was chosen over a
ring outside the selection: further out is further from the creature, which is the problem it was
built to fix.

The X is drawn like a label, not like a ring. `MARKER_HUES.dead` is the same bone colour the
names use, with the same halo, which is this canvas's convention for anything that has to read on
both parchment and a cave floor. So `dead` looks like a different kind of mark before anyone has
worked out which colour is which, and it combines with the others: a creature can be marked dead
*and* red, and the two don't share a slot.

The list is sorted into `MARKERS` order before drawing, and the room's order is left alone. A
token's marks are stored in the order the DM added them, and the server has no opinion about that,
so two creatures both marked red and blue can hold them in either order. A row of pips didn't care;
a band does, because recognising the same state on two monsters at a glance is the reason this
stopped being pips. The sort is client-side and changes no state.

`HP_STACK_H` is gone, and removing it simplified the layout. It existed only so the pip row
could stack above the hit point display without drawing through it. Nothing is stacked over the
numbers any more, so nothing read the sum, and `HP_FONT_PX` went with it. The column over a token is
a bar and a total again, and its height doesn't affect anything else.

**The swatches had to be excluded from `#initiative button` by name.** An id plus a type selector
beats any number of classes, so `.marker.is-on` setting a fill lost to the panel's shared button
style, and every swatch on a row drew hollow whatever its state, which looks like the toggle not
working. `#initiative button:not(.marker)` is the fix, and `.map-library-pick` is the same trap on
another panel. No suite can see it: `aria-pressed` was correct throughout, and only a computed style
shows the problem.

`tools/drive-panels.mjs` tests all of it. Its most important check isn't the toggle but the *hit*:
a `-3` typed on a marked creature has to leave the marks alone, because `update_token` replaces the
token and the damage box builds a whole one. That failure is silent and shows up a moment later, in
a different control.

The `dead` swatch is checked with `getComputedStyle`, not with `aria-pressed`. It's an X rather
than a disc, and that difference comes entirely from the stylesheet (identical markup, one attribute
selector). That's the same kind of problem as the `#initiative button` collision above, including
being invisible to every assertion about the DOM. Reading the computed `::before` content applies
the lesson from that bug in advance rather than after the fact.

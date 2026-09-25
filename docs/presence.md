# Presence

Who is here, whose turn it is, what happens when a socket drops, what colour each person draws in,
and where everyone's pointer is. This is milestone 27's four parts and milestone 28. What makes them
one subject: **every other feature in Slate is about the board, and these are about the people
looking at it.**

Milestone 28 is in this file rather than its own for that reason and one more. A cursor *is* a
colour with a name beside it, resolved through the same `colourOf` and `nameOf` the strip uses, and
it was scheduled after 27d because those two functions were about to change.

Read `.claude/CLAUDE.md` first for the summary. This file explains why each part is shaped the way
it is, and what a change to it must not break.

Covers: `presence.ts`, `turn.ts`, `cursors.ts`, the reconnect half of `net.ts`,
`RoomState::colours`, `RoomState::here`, `RoomState::show_cursors`,
`RoomState::show_dm_cursor`, `cursor_seen`, `Event::PresenceChanged`,
`Event::ColoursChanged`, `Event::CursorMoved`, `Event::CursorsChanged`,
`Event::DmCursorChanged`, and `SetColour`/`Presence`/`ColoursChanged`/`MoveCursor`/
`CursorMoved`/`SetShowCursors`/`CursorsChanged`/`SetShowDmCursor`/`DmCursorChanged` on
the server.

---

## 27a: who is connected

### The room already knew, and told nobody

`roster_slots()` has computed exactly this since milestone 5, by scanning `clients` for each slot.
It went only to sockets sitting on the identity picker, so that a slot taken while someone was
deciding stopped looking free. Everyone who had already chosen was never told anything about
anyone. All of 27a is routing an answer the room was already computing to the people who wanted it.

Both emit points already existed and did related work: `hello`'s success path calls
`refresh_pickers`, and the actor loop's `Disconnected` arm calls it *and* dispatches
`Event::SketchEnded`. `Event::PresenceChanged` was added beside each.

### `Owner`, not `RosterSlot`

**A list of slots can't say the DM is there**, and that's the connection a table most wants to be
sure of: a game stops when the DM's laptop sleeps, and it doesn't stop when one player's does.
`RosterSlot` has no variant for someone who occupies no slot, so a presence frame built from it
would answer a different question from the one being asked.

It costs nothing on the client either, which is `Pinged`'s argument again: `colourOf` and `nameOf`
already turn an `Owner` into a colour and a name using the roster every client has held since
`Welcome`. So the frame is seven short objects and nothing else has to travel.

### A set of identities, not a count

`RosterSlot`'s doc comment records that a player on a laptop and a phone is legitimate: `claimed`
is advisory and doesn't prevent it. So `here()` deduplicates, and two sockets with the same
`Identity::Player` are one entry. Counting sockets would seat seven people at a table of six, and
the first time someone opened a second tab it would look like a stranger had joined.

`here()` is ordered: the DM, then the roster's own order. Nothing downstream depends on that,
because the strip draws every slot and dims the absent ones. It's there so a test doesn't assert on
`HashMap` iteration order.

### It isn't part of the room

The `Disconnected` arm already carried the sentence that decides this: *who happens to be connected
is not part of the room.* Three things follow, and none of them needed a rule of its own.

- `persists` is `false`. It's the one arm on that list that refuses on principle rather than
  because the thing is short-lived: a save file that recorded five people connected would boot
  claiming a full house when nobody is there.
- So it's off `Saved`, which keeps it off the undo ring, exactly as with the chat log. Nothing in
  `undo.rs` mentions presence and nothing needs to.
- Nothing marks the room dirty. Joining and leaving cost the disk nothing.

### `here` is on the view as well as the delta

Invariant 3, on a field where it's easy to get wrong the cheap way: send the delta, forget the
snapshot, and the strip stays blank until the next person arrives or leaves, which reads as nobody
being here. It also makes `Restored` correct for free, since that frame is a whole `RoomView`
through the same `snapshot_for`.

`state` was already boxed (milestone 15's large-variant warning), so growing `RoomView` again cost
nothing.

### The frame is sent unconditionally

A second connection as the same person changes nothing about the list, and a `Presence` frame goes
out anyway. The alternative is the room remembering what it last said so it can compare, which is
state kept only to avoid repainting seven chips. `refresh_pickers` beside it is unconditional for
the same reason.

### One exit path for both kinds of leaving

A socket leaves the room for two reasons, and for a while only one of them told anyone.

`RoomCmd::Disconnected` is the ordinary hang-up, and it does the whole departure: drop the entry,
refresh the pickers because a roster slot just came free, and dispatch `SketchEnded` and
`PresenceChanged`. The other reason is `dispatch` itself. A client whose outbound mailbox is full
is stuck, and dropping it is better than stalling the room on one bad peer. That path used to be a
bare `clients.remove`, and because the disconnect arm only runs if the entry is *still there*, the
socket closing afterwards found nothing to do, and every step above was skipped silently.

Nothing leaked. The room's own `here` was right the whole time, because it's derived from
`clients` rather than stored. What was wrong was what the **other** clients had last been told: a
name in the strip belonging to nobody, a roster slot that read as taken and couldn't be claimed, and
a half-drawn sketch line with no one to end it. All three stayed until some unrelated join or leave
happened to refresh them.

So there's one `RoomState::remove_client`, and both callers go through it. It's re-entrant through
`dispatch`, and bounded because every call removes an entry before dispatching, so a client stuck
on the frames it's sent is removed by the nested call rather than visited a second time.
`a_wedged_client_leaves_as_loudly_as_one_that_hung_up` is the test. It asserts on what the
*remaining* clients were sent, which is the only place the bug was ever visible.

### On screen

**The strip is at the top of the right-hand flex column, the one edge of that column that never
moves.** The initiative panel folds and the dock grows upward from the bottom, so anything between
them shifts when either does. A strip answering *is the DM still there* is useless if it's
somewhere different every time you look. `dock.ts` makes the same argument in the other direction
about its own strip being its last child.

**Absent people are dimmed, not removed.** Every roster slot is drawn from the first frame and none
leaves when its player does, so the row keeps one layout while people come and go. A chip that
vanished would move its neighbours under the pointer, and would make "nobody is here" and "there is
no such person" look the same. The strip is rebuilt only when the DM edits the cast
(`RosterChanged`, `docs/rooms.md`), which is the one time the row *should* change.

**The chat destination chips are dimmed from the same answer.** Whispering someone who isn't there
is the specific failure this feature exists to prevent, so `chat.ts` asks `presence.connected`
about each destination. They're dimmed and never *disabled*. A whisper to someone who stepped away
is a reasonable thing to type (the log lasts the session, and they'll read it when they're back),
and a chip that couldn't be pressed would change the selected destination under someone
mid-sentence.

The table is the one destination with no person behind it, so it's never shown as away.

---

## 27b: "it's your turn"

**Client-only, and the cheapest feature in this project.** `initiative.current` already arrives on
every change, the scene already says who owns each token, and `identity.ts` already says who we
are. There's no command, event or filter, and nothing for the room to know. Whose turn it is isn't
a secret; it's in the panel two inches away. This is milestone 26's observation again: *a feature
that only asks a question the client already has the data for is nearly free.*

### It must not fire on `Welcome` or `Restored`

This is the rule that would ruin it. Adopting state isn't a turn change:

- A refresh mid-combat would announce whoever was already up, so the notice would fire falsely on
  every reload.
- A DM undoing something would nudge six people at once for a turn that didn't move, which does
  more harm than the feature does good.

That's why `turn.ts` has **two methods**: `update` compares and may fire, and `adopt` silently takes
a value as the current one. `onInitiativeChanged` calls `update`; `createTurn` is seeded from the
join, and `onRestored` calls `adopt`.

### It doesn't open or move anything

The title flashes while the tab is hidden, and a line appears beside the dock. No panel opens and
the camera doesn't pan. The ping arrow, the folded initiative panel and the chat badge each already
avoid changing the layout under someone who might be mid-drag, and this is the fourth.

The line has **its own box** rather than sharing the chat toast's. A whisper arriving must not wipe
out the news that you're up, and both can happen in the same second. It sits above the chat toast,
and both grow from the bottom, following the dock's rule.

The title only flashes while the tab is *hidden*, because a background tab is the case the title is
for, and it stops as soon as the tab is looked at.

### Left open on purpose

**It fires for the DM on every monster's turn**, because monsters are `Owner::Dm` and it really is
the DM's turn to act. That may be right or may be noise, and only playing a session with it will
tell. Milestone 19's draw-tool question was the same kind, and also only answerable by use. If it
turns out to be noise, the cheap answer is a `localStorage` off-switch, not a rule invented before
anyone has complained.

A creature the table can't see is missing from their token list entirely, so `update` finding no
token gives the same answer as the turn not being theirs, and needs no case of its own.

---

## 27c: reconnect on drop

`.claude/CLAUDE.md` stated the gap outright: *a keepalive is not a reconnect — when the socket does
close, the page still says so and waits for a refresh.* Now it backs off and retries, and **when a
fresh socket opens it calls `location.reload()`.**

### The reload is the design, not a shortcut

`onWelcome` in `main.ts` builds the pings, the panels, the four tools, the rail and the board
**once per socket**, assuming one `Welcome` per socket. A second one would construct a second copy
of each and register another `window` keydown listener per tool. That's the same obstacle
`ServerMsg::Restored` was invented to get around for undo. Here there's nothing to invent, because
a refresh is *already* the supported way back. This only stops asking the person at the keyboard to
do it by hand.

So the socket the backoff opens is a **probe**. Nothing is sent on it, and the only handler attached
to it is the one that reloads the page. `net.ts` says so.

**The DM comes back as the DM.** That wasn't true when this shipped, and it matters because it's
the one identity a reload could lose. The secret is stripped from the address bar on boot, so it
used to live in a closure and disappear with the page, and this reconnect handed the DM their own
character picker in the middle of a session. `takeDmSecret` now remembers it in `localStorage`. See
*The secret is remembered in the browser* in `docs/rooms.md` for why that doesn't weaken the
stripping, and why the per-tab version it first shipped with was too narrow to work on the Pi.

### The backoff

`BACKOFF_MS` climbs from 500ms to 10s over nine attempts, about a minute in total. It climbs so a
laptop lid closed for a minute isn't a hundred requests. It *stops* so a machine left open overnight
against a server that's gone doesn't reconnect at dawn to a board nobody is looking at. A minute
covers the cases this exists for: the Pi's service restarting, or the tunnel dropping briefly
mid-session.

### Two banners instead of one

`onLost` shows "connection lost — reconnecting…" and adds the `offline` class straight away. The
board is stale from the moment the socket closes, because the room carried on without us and
there's no resync protocol. `onClose` shows the old "disconnected — refresh to rejoin", which is now
the **last resort**, reached when the backoff gives up rather than immediately.

---

## 27d: the colour a player draws in

Split out of milestone 19 and estimated there: *"it replaces the body of `colourOf` and touches
nothing else, with these as the defaults for whoever never picks."* That turned out to be exactly
true of the **client**. The server half (one persisted table, one command, one undo exemption) is
the whole cost.

### The command carries no key

`SetColour { colour }` names no slot. Whose colour it is comes from the socket, as with `Say`'s
sender and `SetNotes`' box. **Three instances make it a pattern worth naming: a key a client could
name is a key it could use to name someone else's.**

### Public, unlike the scratchpad

This is where a colour differs from a note. Both are yours to set, but only one is any use if
nobody else can see it: everyone has to draw everyone else's rings and attribute everyone else's
lines. So `colours` goes whole to every client with no filter at all, which makes it the **first
player-writable state in this project that isn't private**. It doesn't inherit `notes_for`, and it
shouldn't.

### What reads it

`colourOf` is the only way in. Its readers are the ring a ping draws, the dot and name a cursor
draws, the chip in the presence strip, the attribution in the chat log, and **the measure tool**.
The measure tool is the one that isn't a label beside someone's name but something drawn on the
board. The argument still holds: a measure line is a gesture that ends on release, so what matters
is whose it is rather than what it is. The three area tools keep the draw palette, because they
outlast the gesture that made them. See `docs/drawings.md`.

### An index into a closed palette, not free hex

`pings.ts` records that its six hues avoid the token ring colours in `render.ts`: gold is
ownership, blue is in progress, white is the turn, violet is hidden, teal is staged-only. **Free hex
would let a player pick gold and make their own ring misstate who owns a creature**, which is the
board saying something false. So the wire carries an index, `PALETTE` on the server bounds it the
way a token's size is bounded, and there's no colour-picker widget to build.

`PLAYER_HUES` in `pings.ts` is the only place the hues exist. The server stores a number and holds
the list's *length*; it has no opinion about what `3` looks like. Changing a hue touches no Rust.

### Duplicates are allowed

Nothing on either side refuses two people the same swatch. `pings.ts` already argues that **colour
alone doesn't scale to seven people, and the name written beside a ring is the real answer**, so a
duplicate is still legible, and refusing one would mean telling a player no about something
cosmetic. It also keeps `check` to a bounds test.

### The DM has no colour

The DM's hue is outside the six on purpose: theirs is the one ring at the table that isn't a
player's. Three things enforce it, and each is needed at its own layer.

- `colours` is keyed by `PlayerId`, so **the type can't represent a DM entry at all**.
- `check` refuses `SetColour` from the DM. A rule only the UI enforces isn't a rule.
- `colourOf` answers `dm` before it looks at the table, so a hand-crafted entry couldn't reach the
  board even if one existed.

So `presence.ts` builds no swatches on a DM connection. It isn't a hidden button: the control
simply isn't built, because it could only ever produce a red banner.

### Storage: a `BTreeMap`, and why it differs from the notes

`colours: BTreeMap<PlayerId, u8>` is the same type in the room, on the wire and on disk, and
`to_saved` is a clone. The scratchpads are the opposite case, and comparing the two explains both:

- `Owner` is an adjacently tagged enum, and **JSON has no object key that can hold one**, so
  `notes` had to be flattened into a list of pairs and then sorted by hand to stop the file changing
  on every write.
- `PlayerId` is a newtype over `String`, so it *is* a legal key, and `BTreeMap` sorts itself, which
  covers the sorting for free.

### The undo exemption, and both halves of it

Milestone 22's rule is that the ring may hold only **state the undoing hand wrote**. A player's
colour isn't the DM's, so:

- `undid` returns `None` for `SetColour`, which keeps the command from being a step;
- the `Undo` arm of `apply` lifts `colours` out and puts it back around `adopt`.

**Both are needed**, and the second is the one that matters in practice: a colour picked *between*
two DM commands is on the snapshot the later one pushed, so without it a restore would put the old
colour back.

**Colours were the second thing to need this exemption by hand**, which turned `docs/notes.md`'s
"the only thing exempted by hand" into a rule with two instances. Anything persisted that a player
writes will need the same two lines.

### The control is your own chip

The control is where your colour already is. It isn't a third dock tab; `dock.ts` argues against
that itself, since the dock is for things you read while something else is going on, and this is
one click twice a campaign. Clicking your chip opens a row of six swatches, and picking one sends
the command and closes the row.

Nothing is predicted locally. The highlighted swatch is the room's answer coming back, in the same
frame that tells everyone else. That's why the sender **is** echoed here, unlike `NotesChanged`:
there's no caret to move and nothing was drawn locally.

### What repaints

`Presence` holds the table, and everything reads it at draw time rather than copying it. The render
loop puts `presence.colours` on each frame, so a ring already on the board changes colour on the
next frame without anything being recomputed. `chat.ts` is the exception that has to be told,
because its log is DOM written once. `repaint()` rebuilds the rows from the lines it kept and
preserves the scroll position. A log left in old colours would attribute half a conversation to the
wrong person.

---

## 28: everyone's pointer

### `Ping`'s shape, minus the intent

The roadmap estimated this as *"`Ping`'s shape with the ephemerality turned up"*, and that held line
for line. `MoveCursor` carries a `Pos` and nothing else, `CursorMoved` carries an `Owner` and a
`Pos`, the sender isn't echoed, nothing is persisted, nothing is in `snapshot_for`, and `apply`'s
arm for it never writes to the room.

What the roadmap couldn't estimate is the distinction that decides everything below: **a ping is a
gesture someone chose to make, and a cursor is just where their hand happens to be.** Every
difference between the two follows from that.

- Pings accumulate. Two rings can be on screen at once, because they're two things someone did. A
  cursor is *replaced*: `cursors.ts` is a `Map` keyed by person, because a hand is only in one
  place.
- A ping ends on its own timer from the moment it was made. A cursor ends when it **stops moving**,
  which is a different clock and means something different. A client that has stopped moving sends
  nothing, and each recipient's own decay timer does the rest. No frame ends a cursor, which is also
  why a dropped socket costs nothing: a closed laptop fades out on the same timer as a hand that let
  go of the mouse.
- A ping is relayed wherever it lands. A cursor isn't; see the next section.

### The one thing withheld, the opposite way from pings

`cursor_seen` is the whole filter, and three of its four cases are *yes*:

- **The DM as recipient**: yes, always. They can already see the whole board.
- **A player's pointer**: yes, wherever it goes. A player can only point at what their own client
  drew, so a player's pointer over the dark is someone waving at a black rectangle.
- **An unfogged map**: yes. `known` is empty with fog off, so the `!map.fog ||` guard is needed
  exactly as it is in `shape_seen`. Without it, the DM's pointer would vanish from every board as
  soon as fog was switched off, which is most rooms most of the time.
- **The DM's pointer over ground the party hasn't explored**: withheld. The DM's hand *lingers where
  the DM is working*, which is over the ambush in the unlit chamber and the creature the table
  can't see. That's the one thing in this frame worth reading.

**This departs from what was originally written down**, and the change is recorded because the
argument matters. The *Cursors* design in `docs/history.md` proposed gating on `known` for
**everyone**; what shipped gates only the DM. The gate only protects against a hand that knows
something, and the only hand at the table that does is the DM's. Gating a player's pointer gains
nothing and loses the feature on exactly the ground the party is fighting over.

`drive-ping.mjs` and `drive-cursors.mjs` assert *opposite outcomes about the same kind of square*,
on purpose. That's not an inconsistency to tidy up later; it's the distinction between the two
features, written down twice where it will fail visibly.

### `known`, not `visible`

This is the same split every other reader downstream of the fog makes. A pointer is over the
terrain rather than standing on it, so it goes with the explored map and not with the creatures.
That's `shape_seen`'s rule for an unanchored shape, applied to a second kind of thing.

It also means the DM's own mask applies for free: a room they've painted `Dark` hides their pointer
too. That's the right reading of having blacked it out, and it needed no code of its own, because
`known` already includes the overrides.

### The switch stops the relay and the sending

`show_cursors` is the third setting like `show_names` and `diagonals`: on `RoomState`, DM-only to
set, identical for every recipient, and on the table tab because that's where a room-wide field's
control goes. It's persisted, it's a step on the undo ring, and it defaults **on**.

The default is the one place it differs from `show_names`, and the reason is worth keeping.
`show_names` defaults on because *that's what the board already did* before the switch existed.
There's no such argument here, since before this milestone there were no pointers at all. It
defaults on because **a feature switched off in every room that predates it is a feature nobody
finds**. The DM who doesn't want it has one checkbox; the DM who never learns it exists has nothing.

**Off means the room drops every `CursorMoved` in `message_for`, and every client stops sending its
own.** Both halves, because this is the busiest message in the protocol by an order of magnitude.
Drag frames exist while a token is moving; these exist whenever anyone's hand is on the mouse. A
switch that let the frames cross the wire and just didn't draw them would be a display preference
rather than a way to reduce traffic, and that's why this is room state and not `localStorage` like
the initiative panel's fold.

What's intentionally *not* done is refusing `MoveCursor` in `check`. A client that hasn't been told
yet is in the middle of a `pointermove`, and a red banner per frame is far worse than a frame nobody
is sent.

### The second switch: the DM's own pointer

`show_dm_cursor` is the switch above narrowed to one person: **the DM's pointer isn't drawn on the
players' boards, and everyone else's still is.** It has the same shape as `show_cursors` in every
way that matters: on `RoomState`, DM-only to set, identical for every recipient, persisted, a step
on the undo ring, on the table tab, and defaulting **on**, so a room that predates it doesn't lose a
pointer from six screens without anyone noticing.

**It's read in `cursor_seen` and nowhere else**, which is why it cost four lines. That function
already answered exactly this question (*may this recipient be shown the DM's pointer here*), and
already answered "no" for one case, the dark. The switch widens that case from "over ground the
party hasn't explored" to "anywhere". **The order inside the function matters**: it's read after
the two yeses (`to_dm`, and a player's pointer) and **before** the `map.fog` guard, so it works on
an unfogged map. The other way round, it would be a switch that did nothing until the DM turned fog
on, which nobody would want.

**It stops the relay but not the sending, which is where it differs from `show_cursors`.** That one
covers every pointer in the room, so every client stops sending frames as well. This one covers one
client in seven, so a second condition at the send site would add a branch in `input.ts` to save
nothing measurable, and the DM's client would then have to decide whether a second DM tab still
counts. The room drops the frame, and no client can tell the difference.

**A player is sent the frame and does nothing with it.** `DmCursorChanged` is unfiltered, like the
four room-wide switches beside it, on the same principle: who may flip it is a permission question,
and its value isn't a secret. It could have been withheld from everyone but the DM (`WallsChanged`'s
rule), but that would be a second visibility rule invented for one bool that reveals nothing. What
reads it back is the DM's own table panel, in a second tab or after a refresh.

**On screen it's nested under "pointers on the board" and greyed out while that's off**, following
the fog panel's rule for the fog panel's reason: "including yours" isn't a question the DM needs to
answer while nobody's pointer is being drawn, and a control that vanishes is one they'll go looking
for. It's a second checkbox rather than a third state on the first, because "everyone's pointers"
and "the DM's pointer" are two questions, and a select answering both would make the common case
(all on) cost reading a menu.

What it's for: a DM who wants their pointer off the table's screens while the party argues about
which door to open, without taking the other six pointers away from each other.

### The throttle, and the missing trailing edge

About 30Hz, leading edge only. That's **faster than a drag frame's 25Hz**, the opposite of what
this feature shipped with. The first argument was that a pointer is background information, and
the busiest message in the protocol shouldn't be the smoothest thing on screen. Play disproved that
within the hour. A token drag is a heavy object everyone watches land, and a hand is *quick*, so the
rate that looks fine on a token looks like a stutter here. It's affordable for the same reason as
before (seven clients is nothing at this scale), and if it ever stops being affordable, the room's
switch is the coarse control and this number is the fine one.

The two throttles above it in `input.ts` send a trailing frame and this one doesn't; that's the one
way it differs from them. Theirs exists because a drag or a sweep *ends by stopping* and leaves
something behind that has to be correct. A pointer leaves nothing behind. Without a trailing frame,
a hand that stops just after an interval boundary sits up to 33ms out of date on other screens for
the two and a half seconds it takes to fade. Nobody can see that, and no later frame has to correct
it.

It's sent **before every branch** in the `pointermove` handler, outside all of them. Where a hand
is doesn't depend on what it's holding, so a pointer goes out while a token is being dragged, while
a wall is being traced, and while nothing is happening at all.

### Nothing while previewing

The DM's client sends no pointer while it's showing the staged board. A position there is in a
different dungeon's grid units, so the table would see a pointer moving across cells nobody is
pointing at. And the server, which doesn't know preview exists and mustn't learn, would be gating
it against the live board's `known`.

It's client-only, one condition at the send site, and the same trade `drawPings` and `drawShapes`
already make from the other direction: while previewing, the DM stops taking part in the board's
short-lived marks.

### On screen

**A small dot, not an arrow**, in the owner's colour with their name under it. Both are sized in
screen pixels, for `ringRadius`' reason: a pointer that shrank as the camera zoomed out would stop
working as a pointer.

The arrow was tried first, on the argument that every desktop already draws one, so it needs no
explanation. What that missed was *how many*: seven arrows on a board already carrying tokens,
nameplates, hit point bars, rulers, trails, shapes and fog read as seven things demanding to be
clicked. A dot marks a spot and claims nothing, which is what background presence should do. It
says a hand is here, not that it's about to do something.

It's also drawn **below full strength**, at `CURSOR_ALPHA`, on top of its own fade. That constant is
the only opacity setting among the drawing constants here, and the reason is worth keeping:
everything else on this canvas is something someone decided to put there, and a cursor is the only
mark that just reports a fact. It should be legible when you look for it and unnoticeable when you
don't. Lower it before the decay.

**The name is always shown**, which is `pings.ts`' argument where it matters most: colour doesn't
scale to seven people, two people may pick the same swatch and nothing refuses it, and the name
beside the mark is the real answer to who is who.

**A pointer outside the view draws nothing**, and this is where the ping design is intentionally
not reused. `edgeMarker` exists because a ping is a deliberate gesture that would otherwise be
missed. Seven permanent markers around the border for hands that are simply elsewhere is the
clutter this feature is most at risk of. The canvas clips them for free.

Cursors are drawn under the ping rings and over everything else, which is the right order for the
two gestures. Nothing is drawn while previewing, for the same reason pings and shapes aren't.

**If the board looks cluttered with seven pointers on it, adjust the decay first.** The roadmap
says so explicitly, and it's the number to lower before anything else here is reconsidered.

### Testing

**`server/src/room/tests/cursors.rs`** is where the filter is asserted, and half that file is about
a frame that didn't leave. It's the first visibility test in the suite whose subject is the *DM's*
own hand. `walls.rs` asserts what a player is never told, `chat.rs` asserts what one player is told
and another isn't, and this one asserts what the DM can't reveal by accident. The paint case
(`the_dms_own_paint_swallows_their_pointer_too`) is the one worth keeping: it pins `known` rather
than `revealed`, which is the line a later reader would be most tempted to simplify.

The narrower switch has five tests of its own in the same file. The one that pins the design is
`the_dm_switch_reaches_past_the_dark_onto_a_lit_map`: it fails if the check is moved below the
`map.fog` guard, which is the only plausible way to get the order wrong.
`switching_the_dms_off_leaves_everybody_elses_alone` is the other half. It shows this isn't just
`SetShowCursors` again: a player's pointer still arrives, and a second DM tab still sees the first.

**`client/src/cursors.test.ts`** covers what a single process can see: one pointer per person, the
decay, and `clear()`.

**`tools/drive-cursors.mjs`** opens two browsers on the fixed ports. Two is the minimum at which this
feature means anything: the assertion is that a real mouse moving in one window drew a dot in
another, and that the DM's pointer over the dark *didn't*, which one window can't tell apart from
the DM not having moved.

Its lit square is **built, not found**. A token given to a player is a vision source; it's placed in
the first free cell out from the middle of the view, and deleted again at the end. Looking for a lit
square instead would depend on whatever room the driver was pointed at, and the run this replaced
skipped its own positive check on the built-in map. A check that skips itself isn't a check.

---

## Testing: milestone 27

(Milestone 28's tests are under its own heading above, with the feature they belong to.)

**`server/src/room/tests/presence.rs`** holds both presence and colours. They share a file because
they share a milestone and a strip, and very little else: presence is the room reporting on its own
sockets, and a colour is a player writing into a table everyone reads.

The suite-wide change to know about: **`drain` now filters out `Presence` as well as
`UndoChanged`.** Same reasoning from the other side: `UndoChanged` comes with every command,
`Presence` comes with every join and leave, and every test in the suite starts by connecting two or
three people. Without the filter, every expectation in the project would carry an extra leading
frame and partly test who is connected. Tests that *are* about presence use `drain_all`, and
`settle` is how a test using raw `try_recv` says "and now everyone is here".

**`tools/drive-presence.mjs`** opens three browsers on the fixed ports. Presence is the first
feature in Slate whose whole subject is the other connections, so one browser can see nothing about
it. Two browsers show a name appearing and dimming when one is closed, and the third is what makes
the colour half meaningful: a colour has to reach someone who didn't pick it. The turn notice is
tested in the same driver because its assertion has the same shape: *one* of two players was told.

The colour check picks **a swatch different from the current one** rather than a fixed index,
because a colour persists and a second run would otherwise read its own leftovers.

**27c has no driver.** The only way to drive it is to stop the server and start it again, which the
README's run-all loop shouldn't do to a room. It was verified by hand: kill the server, watch the
banner change to "connection lost — reconnecting…", bring it back, and watch the page reload and the
strip fill in.

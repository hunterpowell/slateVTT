# Presence

Who is here, whose turn it is, what happens when a socket drops, and what colour each
person draws in. Milestone 27, four parts, and the theme is what makes them one thing:
**every other feature in Slate is about the board, and these four are about the people
looking at it.**

Read `.claude/CLAUDE.md` first for the summary. This file is why each part is the shape
it is, and what a change to it must not break.

Covers: `presence.ts`, `turn.ts`, the reconnect half of `net.ts`, `RoomState::colours`,
`RoomState::here`, `Event::PresenceChanged`, `Event::ColoursChanged`, and
`SetColour`/`Presence`/`ColoursChanged` on the server.

---

## 27a — who is connected

### The room already knew, and told nobody

`roster_slots()` has computed exactly this since milestone 5, by scanning `clients` for
each slot — and it went only to sockets sitting on the identity picker, so a slot taken
while somebody was deciding stopped looking free. Everyone who had already chosen was
never told anything about anyone. The whole of 27a is routing an answer the room was
already computing to the people who wanted it.

Both emit points existed too, and both already did neighbouring work: `hello`'s success
path calls `refresh_pickers`, and the actor loop's `Disconnected` arm calls it *and*
dispatches `Event::SketchEnded`. `Event::PresenceChanged` was added beside each.

### `Owner`, not `RosterSlot`

**A list of slots cannot say the DM is there**, and that is the connection a table most
wants to be sure of — a game stops when the DM's laptop sleeps, and it does not stop when
one player's does. `RosterSlot` has no variant for somebody who occupies no slot, so a
presence frame built from it would answer a different question from the one being asked.

It costs nothing on the client either, which is `Pinged`'s argument reused whole:
`colourOf` and `nameOf` already turn an `Owner` into a colour and a name out of the roster
every client has held since `Welcome`. So the frame is seven short objects and nothing
else has to travel.

### A set of identities, not a count

`RosterSlot`'s own doc comment records that a player on a laptop and a phone is
legitimate — `claimed` is advisory and deliberately does not stop it. So `here()`
deduplicates: two sockets with the same `Identity::Player` are one entry. Counting sockets
would seat seven people at a table of six, and the first time somebody opened a second tab
it would look like a stranger had joined.

`here()` is ordered — the DM, then the roster's own order. Nothing downstream depends on
that, because the strip draws every slot and dims the absent ones. It is there so a test
does not assert on `HashMap` iteration order.

### It is not part of the room

The `Disconnected` arm already carried the sentence that decides this: *who happens to be
connected is not part of the room.* Three things follow and none of them needed a rule of
its own.

- `persists` is `false`. It is the one arm on that list that refuses on a principle rather
  than on the thing being fleeting — a save file that recorded five people connected would
  boot claiming a house is full when nobody is in it.
- It is therefore off `Saved`, so it is off the undo ring **by construction**, exactly as
  the chat log is. Nothing in `undo.rs` mentions presence and nothing needs to.
- Nothing marks the room dirty. Joining and leaving cost the disk nothing.

### `here` is on the view as well as the delta

Invariant 3, on a field it would be easy to get wrong in the cheap direction: send the
delta, forget the snapshot, and the strip stays blank until the next person moves — which
reads as nobody being here. It also makes `Restored` right for free, since that frame is a
whole `RoomView` through the same `snapshot_for`.

`state` was already boxed (milestone 15's large-variant warning), so growing `RoomView`
again cost nothing.

### The frame is sent unconditionally

A second connection as the same person changes nothing about the list, and a `Presence`
frame goes out anyway. The alternative is the room remembering what it last said so it can
compare — state kept purely to avoid a repaint of seven chips. `refresh_pickers` beside it
is unconditional for the same reason.

### On screen

**The top of the right-hand flex column, which is the one edge of that column that never
moves.** The initiative panel folds and the dock grows upward from the bottom, so anything
between them shifts when either does — and a strip answering *is the DM still there* is
worth nothing if it is somewhere different every time you look. `dock.ts` makes the same
argument in the opposite direction about its own strip being its last child.

**Absent people dim rather than disappearing.** Every roster slot is drawn from the first
frame and none of them ever leaves, so the row has one layout for the whole session. A
chip that vanished would move its neighbours under the pointer, and would make "nobody is
here" and "there is no such person" the same picture.

**The chat destination chips dim from the same answer.** Whispering somebody who is not
there is the specific failure this feature exists to prevent, so `chat.ts` asks
`presence.connected` about each destination. They are dimmed and never *disabled*: a
whisper to somebody who stepped away is a reasonable thing to type — the log is the
session's and they will read it when they come back — and a chip that could not be pressed
would move the armed destination out from under somebody mid-sentence.

The table is the one destination with no person behind it, and is therefore never away.

---

## 27b — "it is your turn"

**Client-only, and the cheapest thing in this project.** `initiative.current` already
arrives on every change, the scene already says who owns each token, and `identity.ts`
already says who we are. There is no command, no event, no filter and nothing for the room
to know — whose turn it is is not a secret, it is the panel two inches away. This is
milestone 26's generalisation again: *a feature that only asks a question the client
already has the data for is nearly free.*

### It must not fire on `Welcome` or `Restored`

The rule that would ruin it. Adopting state is not a turn change:

- A refresh mid-combat would announce whoever was already up, so the notice would cry wolf
  on every reload.
- A DM undoing something would nudge six people at once for a turn that did not move,
  which is worse than the feature is good.

So `turn.ts` has **two methods and that is why**: `update` compares and may fire, `adopt`
takes a value as the current one silently. `onInitiativeChanged` calls the first;
`createTurn` is seeded from the join and `onRestored` calls the second.

### It does not open or move anything

The title flashes while the tab is hidden, and a line surfaces beside the dock. No panel
opens and no camera pans — the ping arrow, the folded initiative panel and the chat badge
each already refuse to reflow the layout under somebody who might be mid-drag, and this is
the fourth thing to refuse it.

The line has **its own box** rather than the chat toast's: a whisper arriving must not wipe
out the news that you are up, and both can be true in the same second. It sits above the
chat toast, and both grow from the bottom, which is the dock's rule one screen over.

The title only flashes while the tab is *hidden*, because a background tab is the whole
case the title is for, and it stops the moment the tab is looked at.

### Left open on purpose

**It fires for the DM on every monster's turn**, because monsters are `Owner::Dm` and it
genuinely is the DM's turn to act. That may be right or may be noise, and only playing a
session with it decides — the same shape as milestone 19's draw-tool question, which was
also only answerable by using it. The cheap answer if it turns out to be noise is a
`localStorage` off-switch, not a rule invented before anybody had the complaint.

A creature the table cannot see is absent from their token list entirely, so `update`
finding no token is the same answer as the turn not being theirs, and needs no case of its
own.

---

## 27c — reconnect on drop

`.claude/CLAUDE.md` stated the gap outright: *a keepalive is not a reconnect — when the
socket does close, the page still says so and waits for a refresh.* Now it backs off and
tries, and **when a fresh socket opens it calls `location.reload()`.**

### The reload is the design, not a shortcut

`onWelcome` in `main.ts` builds the pings, the panels, the four tools, the rail and the
board **once per socket**, on the stated assumption of one `Welcome` per socket. A second
one would construct a second of each and register another `window` keydown listener per
tool. That is the exact wall `ServerMsg::Restored` was invented to get around for the
undo — and here there is nothing to invent, because a refresh is *already* the supported
way back. All this does is stop asking the person at the keyboard to do it by hand.

So the socket the backoff opens is a **probe**. Nothing is sent on it and the only handler
attached to it is the one that throws the page away. `net.ts` says so.

### The backoff

`BACKOFF_MS` climbs 500ms → 10s over nine attempts, a little over a minute in total. It
climbs so a laptop lid closed for a minute is not a hundred requests; it *stops* so a
machine left open overnight against a server that is gone does not reconnect at dawn to a
board nobody is looking at. A minute covers the case this exists for — the Pi's service
restarting, or the tunnel blipping mid-session.

### Two banners now, not one

`onLost` is "connection lost — reconnecting…", and it puts the `offline` class on straight
away: the board is stale from the moment the socket closes, because the room went on
without us and there is no resync protocol. `onClose` is the old "disconnected — refresh to
rejoin", which is now the **floor** — reached when the backoff gives up rather than reached
for immediately.

---

## 27d — the colour a player draws in

Split out of milestone 19 and priced there: *"it replaces the body of `colourOf` and
touches nothing else, with these as the defaults for whoever never picks."* That turned out
to be exactly true of the **client**. The server half — one persisted table, one command,
one undo exemption — is the whole cost of it.

### The command carries no key

`SetColour { colour }` names no slot. Whose colour it is comes from the socket, exactly as
`Say`'s sender and `SetNotes`' box do. **Three instances is a pattern worth naming: a key a
client could name is a key it could name somebody else's with.**

### Public, unlike the scratchpad

This is the axis a colour differs from a note on. Both are yours to set; only one of them is
any use if nobody else can see it — everybody has to draw everybody else's rings and
attribute everybody else's lines. So `colours` goes whole to every client and there is no
filter on it at all, which makes it the **first player-writable state in this project that
is not private**. It does not inherit `notes_for` and it should not.

### An index into a closed palette, not free hex

`pings.ts` records that its six hues deliberately avoid the token ring vocabulary in
`render.ts` — gold is ownership, blue is in progress, white is the turn, violet is hidden,
teal is staged-only. **Free hex lets a player pick gold and make their own ring lie about
who owns a creature**, which is the board saying something false. So the wire carries an
index, `PALETTE` on the server bounds it the way a token's size is bounded, and there is no
colour-picker widget to build.

`PLAYER_HUES` in `pings.ts` is the only place the hues exist. The server stores a number and
holds the list's *length*; it has no opinion about what `3` looks like. Changing a hue
touches no Rust.

### Duplicates are allowed, deliberately

Nothing on either side refuses two people the same swatch. `pings.ts` already argues that
**colour alone does not scale to seven and the name written beside a ring is the real
answer** — so a duplicate is legible rather than broken, and refusing one would mean telling
a player no about something cosmetic. It also keeps `check` to a bounds test and nothing
else.

### The DM has no colour

Their hue sits outside the six on purpose: theirs is the one ring at the table that is not a
player's. Three things enforce it and each is needed at its own layer.

- `colours` is keyed by `PlayerId`, so **the type makes a DM entry unrepresentable** rather
  than merely unusual.
- `check` refuses `SetColour` from the DM. A rule only the UI keeps is not a rule.
- `colourOf` answers `dm` before it looks at the table at all, so a hand-crafted entry could
  not reach the board even if one existed.

`presence.ts` therefore builds no swatches on a DM connection — not a hidden button, but a
control that would only ever produce a red banner.

### Storage: a `BTreeMap`, and why it is not the notes' shape

`colours: BTreeMap<PlayerId, u8>` is the same type in the room, on the wire and on disk, and
`to_saved` is a clone. That is the mirror image of the scratchpads, and the pair is the whole
argument for either shape:

- `Owner` is an adjacently tagged enum and **JSON has no object key that can carry one**, so
  `notes` had to be flattened into a list of pairs and then sorted by hand to stop the file
  churning on every write.
- `PlayerId` is a newtype over `String`, so it *is* a legal key — and `BTreeMap` sorts
  itself, which is that list's other half for free.

### The undo exemption, and both halves of it

Milestone 22's rule is that the ring may hold **state the undoing hand wrote**. A player's
colour is not the DM's, so:

- `undid` returns `None` for `SetColour`, which keeps the command from being a step;
- the `Undo` arm of `apply` lifts `colours` out and puts it back around `adopt`.

**Both are needed**, and the second is load-bearing: a colour picked *between* two DM
commands is on the snapshot the later one pushed, so a restore would put the old one back
without it.

**This is the second thing to need that exemption by hand**, which is what turned
`docs/notes.md`'s "the only thing exempted by hand" into a rule with two instances. Anything
persisted that a player writes will want the same two lines.

### The control is your own chip

Where your colour already is. Not a third dock tab — `dock.ts` argues against that itself,
since what belongs there is something you read while something else is going on, and this is
one click twice a campaign. Clicking your chip opens a row of six swatches; picking one
sends the command and closes the row.

Nothing is predicted locally: the armed swatch is the room's answer coming back, which is
the same frame that tells everybody else. That is why the sender **is** echoed here, unlike
`NotesChanged` — there is no caret to move and nothing was drawn locally.

### What repaints

`Presence` holds the table and everything reads it at draw time rather than copying it: the
render loop puts `presence.colours` on each frame, so a ring already on the board changes
colour on the next frame with nothing recomputing anything. `chat.ts` is the exception that
needs telling — its log is DOM that was written once — so `repaint()` rebuilds the rows from
the lines it kept, preserving the scroll position. A log left in yesterday's colours would
attribute half a conversation to the wrong person.

---

## Testing

**`server/src/room/tests/presence.rs`** holds both halves. The two features share a file
because they share a milestone and a strip, and share almost nothing else — presence is the
room reporting on its own sockets, a colour is a player writing into a table everybody reads.

The suite-wide change worth knowing about: **`drain` now filters `Presence` as well as
`UndoChanged`.** The reasoning is the same from the other end — `UndoChanged` rides beside
every command, `Presence` rides beside every join and leave, and every test in the suite
starts by connecting two or three people. Without the filter every expectation in the project
would carry a leading frame and be partly a test of who is connected. Tests that *are* about
it use `drain_all`, and `settle` is how a test with raw `try_recv` says "and now everybody is
here".

**`tools/drive-presence.mjs`** opens three browsers on the fixed ports. Presence is the first
feature in Slate whose whole subject is the other connections, so one browser can see nothing
about it: two show a name appearing and dimming when one is closed, and the third is what
makes the colour half meaningful — a colour has to reach somebody who did not pick it. The
turn notice rides along in the same driver because its assertion is the same shape: *one* of
two players was told.

The colour check picks **a swatch different from the current answer** rather than a fixed
index, because a colour persists and a second run would otherwise read its own leftovers.

**27c has no driver**, and that is deliberate: the only way to drive it is to stop the server
and start it again, which is not something the README's run-all loop should do to a room.
It was verified by hand — kill the server, watch the banner become "connection lost —
reconnecting…", bring it back, watch the page reload and the strip fill in.

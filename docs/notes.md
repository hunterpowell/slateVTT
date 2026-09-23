# The scratchpad

One box of text per person, private to whoever wrote it. Milestone 24.

Read this before touching `RoomState::notes`, `notes_for`, `is_owner`, `SetNotes`/`NotesChanged`
on the server, `notes.ts`, or the `Undo` arm of `apply`. The last of those is where a
plausible-looking simplification would delete someone's paragraph without anyone noticing.

The boundary is in `.claude/CLAUDE.md` and it is the specification: **a second document makes it a
journal.** No titles, no pages, no sharing, no handout button.

## What it's for

It's in the window, and it persists with the room. That's all it offers. The Notepad window
everyone already has does the rest of what a scratchpad does, and does it fine. What Notepad can't
do is sit beside the board, and still be there next Tuesday without anyone saving anything.

Every feature that would make this a better document (a title, a second page, formatting, a share
button) makes it worse as a scratchpad, because each one gives people a reason to think about the
box instead of the game. Keeping that in mind is what keeps the scope.

## The first state the DM is not sent

Every earlier asymmetry in this project runs the other way. `snapshot_for` and `message_for` had
only ever withheld things from players: the walls, the staged map, the overrides, a hidden monster's
hit points, the undo label. This is the first thing withheld from the DM, and there's no `is_dm` in
either filter.

A scratchpad the DM's client could open would be surveillance, not a scratchpad. It's worth having
only because nobody writes freely in a box they know someone else can read.

### How far that goes

The notes are in the save file, and the DM hosts the server. Anyone with the save file (on the Pi,
`/var/lib/slate/slate-state.json`) can read all of them. There's no encryption and no plan for any:
this project builds no authentication, and this isn't the place to start.

What the milestone guarantees is narrower, and it's the only kind of guarantee the architecture
makes about anything: **no client is ever sent someone else's notes.** The walls and hit points get
the same guarantee. Don't describe it to the table as privacy. Describe it as a box the other
screens don't have.

## The command carries no key

```rust
ClientMsg::SetNotes { text: String }
```

A key a client could name is a key it could use to name someone else's. So whose box it is comes
from the socket, the same way `Say`'s sender does. There's no ownership argument for the server to
validate, which is why `check` has no permission test here, only a size cap. The one thing that
could go wrong can't be expressed on the wire.

The text is sent whole, not patched. It's one string of a few thousand characters that changes when
someone stops typing, and a diff format would add machinery for no gain.

Emptying a box removes the entry instead of storing an empty string, the same rule as the fog
override's `Auto`. There's one representation of "nothing here", so someone who never opened the box
leaves no trace in the save file.

## Who is told

`notes_for(identity)` is the entire visibility rule, and it asks one question: is this your box?
`is_owner` answers it. It was pulled out of `party_to`'s inner closure when this became the second
feature to ask. It's `drawn_by`'s inverse, and a free function for the same reason: it needs nothing
from the room.

Both routes out go through it, per invariant 3: `snapshot_for` for a join or a restore, and
`message_for` for the delta. Forgetting the snapshot would hand a joining client everyone's notes in
the one frame nobody reads closely.

### The delta is for one recipient: your other tab

`Event::NotesChanged { by: ClientId, owner: Owner, text: String }` reaches clients whose identity is
`owner`, **except the socket that typed it.**

That follows `Pinged` and `Sketch`, not `Said`. The three cases:

- **`Said` echoes the sender** because a log is a sequence, and where a line lands in it is for the
  room to decide.
- **`Pinged` and `Sketch` don't**, because the sender already drew it, and a copy arriving a round
  trip later restarts an animation.
- **`NotesChanged` doesn't**, because the text is already in that box, and writing it back
  mid-sentence moves the caret out from under someone who's still typing.

After that exclusion, the only audience left is the author's second tab. That's why this is an event
at all: the DM has two tabs open often enough that `docs/undo.md` discusses it, and without the event
the other tab would keep showing a paragraph that no longer exists.

The client half is in `notes.ts`: an arriving frame is ignored while a send is pending, because
whatever is being typed right now was typed after the frame that just arrived.

## Persisted, and excluded from undo

`Saved::notes` is a `Vec<SavedNote>` rather than the `HashMap<Owner, String>` the room holds. JSON
has no object key an adjacently tagged enum can be written as, and a list can be sorted. `HashMap`
order varies per process, so an unsorted list would rewrite the whole file every time anyone typed.

A snapshot on the undo ring is a `Saved`, so persisting the notes put them on the ring
automatically. `docs/undo.md` predicted this would break milestone 22's rule that the ring holds only
state the undoing hand wrote, and named the scratchpads as the case the rule was written for.

The chat log avoided this by never being persisted. A scratchpad can't: surviving a restart is most
of its value. So the exclusion is written out in two places, and **both are needed**:

- **`undid` returns `None` for `SetNotes`**, so writing a note never pushes a step. This was the
  first case where `undid` and `persists` disagree; everywhere else, worth saving and worth undoing
  were the same answer.
- **The `Undo` arm of `apply` takes the notes out and puts them back around `adopt`.** `undid` alone
  isn't enough: a paragraph typed between two other commands is on the snapshot the second command
  pushed, whoever typed it. Without this, the DM's undo would delete a player's paragraph, with
  nothing on screen to say so and no way to get it back.

`adopt` itself restores the notes like everything else. It's the one inverse of `to_saved`, and two
field lists would be the trap `docs/undo.md` describes: a field read on boot and forgotten on undo
loads correctly and undoes to a stale value, and neither shows up as an error. Boot wants the notes
back; a restore doesn't. Saying so once, at the call site that needs it, keeps `adopt` the single
definition of "what is a saved room".

The player colours were later excluded the same way, with the same two lines.

## The client half

### It sends on a pause

There's no send button, because the text is the state. Something has to decide when a paragraph is
finished, and a 500ms idle debounce does it: type, stop, saved. `blur` flushes whatever the timer is
still holding. Without that, a sentence typed just before clicking back onto the board would be
lost.

There's no "saved" indicator. It would be the first piece of UI in this project that reports on the
network, and it would make the scratchpad look like a document, which is what the boundary guards
against.

The cap is `MAX_NOTES_LEN` (10,000 characters) on the server, and the textarea's `maxlength` is the
same number, so typing just stops instead of the paragraph being refused after it's written. The
server's check is the backstop for a client without the limit.

**A dropped socket takes the focus away from the box.** `Net.send` drops a frame written while the
socket isn't open: it returns nothing, and there's nowhere for the frame to go. `flush` records the
text as sent before it can know that, so a flush into a dead socket loses the paragraph. Reconnecting
reloads the page, so there's no in-page recovery to write: the box comes back holding whatever the
server last stored.

`body.offline` already greyed the panel and turned off its pointer events. That doesn't remove
focus: a caret already in the textarea keeps taking keystrokes, so the person most likely to lose a
paragraph is the one who was typing when the socket dropped. `onLost` now blurs it, which flushes
what the debounce is holding while the socket may still be open, and takes the box away from the
keyboard.

A blur is the right size of fix, and it's why there's still no "saved" chip. An indicator would
report on the network at every keystroke to prevent a loss that needs a dead socket and an unflushed
timer at the same moment. Removing focus says the same thing with no new UI.

### A keystroke in the box belongs to the box

This is `chat.ts`'s rule, and it matters more here: this is the one place in the app where someone
types for a minute at a time with the board behind them. Every tool listens on `window`, the rail's
tools disarm on Escape, and `undo.ts` binds Ctrl+Z. The Ctrl+Z binding already ignores keys inside a
textarea, and this box is the main reason it does.

Escape isn't swallowed to blur, unlike in the chat box. That box is one line and you leave it once
you've said something. This one people leave focused while they read, and the way out is clicking
the board, which they were going to do anyway.

### It's a dock tab, and dock panels stack

The roadmap ruled out the rail for three reasons: only one rail panel is open at a time, notes have
to stay readable while a tool is armed, and the rail is the DM's while this belongs to everyone. The
dock solves all three. See *The right dock* in `docs/chat.md`.

To fit it, **the dock's panels now stack**. One rail panel is open at a time because rail panels are
editing modes, and two armed tools would give one mouse button two meanings. Nothing in the dock is
a mode: a scratchpad and a log are both read while something else is going on, and making notes
close the chat would have recreated the rail's problem on the other side of the screen. `#chat` and
`#notes` are flex items in the dock's column for that reason: with both open they shrink against the
rail's bottom edge, and the initiative panel gives way first.

So `dock.ts` holds a `Set<DockTab>` and a `toggle`, where it used to hold a nullable tab and a
`show`. Badges are still per tab.

The second tab is also why **the strip moved to the bottom of the dock.** The dock grows upward, so
opening a panel moves its top edge and never its bottom one, and a strip on top slid out from under
the pointer on every toggle. See `docs/chat.md`.

## Not built

- **A second box, or a title on the first.** A second document makes it a journal, which is the
  non-goal this was carved out of.
- **Sharing, handouts, "show the table".** The feature is that nobody else is sent it. A share
  button would be a second visibility rule for the same string.
- **Formatting or markdown.** It's `value` in a textarea, `textContent` and never `innerHTML`, and
  nothing anyone types becomes markup.
- **Per-map or per-scene notes.** That's a journal keyed on something, and the key isn't what makes
  it a journal.
- **An indicator, word count or autosave chip.** See above: the box doesn't report on itself.
- **Undo, or anyone else's button reaching it.** Both halves are tested in
  `server/src/room/tests/notes.rs`.

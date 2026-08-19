# The scratchpad

One box of text per person, private to whoever wrote it. Milestone 24.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`RoomState::notes`, `notes_for`, `is_owner`, `SetNotes`/`NotesChanged` on the server, `notes.ts`,
or the `Undo` arm of `apply`** — the last of those is the one place a plausible-looking
simplification quietly eats somebody's paragraph.

The boundary is in `.claude/CLAUDE.md` and it is the specification, not a summary of one: **a
second document makes it a journal.** No titles, no pages, no sharing, no handout button.

## What it is worth

One thing, and being honest about it is the only way to keep the scope: **it is in the window, and
it persists with the room.** The Notepad window everybody already tabs to does the rest of what a
scratchpad does, and it does it fine — what it cannot do is be there when somebody is looking at
the board, and be there again next Tuesday without anybody having saved anything.

That is the whole of it. Every feature that would make this better as a *document* — a title, a
second page, formatting, a share button — makes it worse as the thing it is, because each of them
is a reason to think about the box instead of about the game.

## The first state the DM is not sent

Every asymmetry in this project before this one runs the other way. `snapshot_for` and
`message_for` have only ever been asked to withhold **downward**: the walls, the staged map, the
overrides, a hidden monster's hit points, the undo label. This is the first thing that goes the
other way, and there is **no `is_dm` in either arm**.

That is not a nicety. A scratchpad the DM's client can open is not a scratchpad, it is a
surveillance feature — and the reason it stays out is the same reason the feature is worth having:
nobody writes honestly in a box they know somebody else can read.

### Be accurate about how far that goes

The notes are in the save file, and the DM hosts the server. Anybody holding
`/var/lib/slate/slate-state.json` can read every one of them, and there is no encryption here and
no plan for one — this project builds no authentication and this is not the place it starts.

What this milestone guarantees is narrower and is the only guarantee the architecture makes about
anything: **no client is ever sent somebody else's notes.** It is the same guarantee the walls and
the hit points get. Do not describe it to the table as privacy; describe it as a box the other
screens do not have.

## The command carries no key

```rust
ClientMsg::SetNotes { text: String }
```

**A key a client could name is a key it could name somebody else's with.** So whose box this is
comes from the socket, exactly as `Say`'s sender does, and there is no ownership argument for the
server to validate — which is why `check` has no permission test in it at all, only a size cap.
The one thing that could go wrong here cannot be expressed on the wire.

Written whole rather than patched. It is one string of a few thousand characters that changes when
somebody stops typing; a diff format would be machinery bought with nothing.

**Emptying a box removes the entry** rather than storing an empty string — the fog override's
`Auto` rule again. One representation of "there is nothing here", so somebody who never opened this
leaves no trace in the save file.

## Who is told

`notes_for(identity)` is the whole visibility rule and it asks one question: is this your box.
`is_owner` is where that question lives, pulled out of `party_to`'s inner closure when this became
the second feature to ask it — `drawn_by`'s inverse, and a free function for the same reason that
one is.

Both routes out go through it, which is invariant 3 again: `snapshot_for` for a join or a restore,
and `message_for` for the delta. Forgetting the snapshot is how a joining client would be handed
the whole table's private notes in the one frame nobody reads twice.

### The delta exists for exactly one recipient: your other tab

`Event::NotesChanged { by: ClientId, owner: Owner, text: String }` reaches clients whose identity is
`owner` — **minus the socket that typed it.**

That exclusion is `Pinged`'s and `Sketch`'s rather than `Said`'s echo, and the difference between
those two rules is worth keeping straight, because this feature is the third case and lands on the
first side:

- **`Said` echoes the sender** because a log is a *sequence* and where a line lands in it is the
  room's to decide.
- **`Pinged` and `Sketch` do not** because the sender already drew it, and a copy arriving a round
  trip later restarts an animation.
- **`NotesChanged` does not** because the text is already in that box, and writing it back
  mid-sentence moves the caret out from under somebody who is still typing.

What is left after the exclusion is the author's *second tab*, and that is the whole audience this
event has. It is why it is an event rather than nothing at all: the DM has two tabs open often
enough that `docs/undo.md` argues about it, and a tab holding a paragraph that no longer exists is
the failure this fixes.

The client half of that guard is in `notes.ts`: an arriving frame is **ignored while a flush is
pending**, because anything being typed here right now was typed later than the frame that just
arrived.

## Persisted, and exempt from the undo

`Saved::notes` is a `Vec<SavedNote>` rather than the `HashMap<Owner, String>` the room holds, for
two reasons that both come from it being a file: JSON has no object key an adjacently tagged enum
can be written as, and a list can be **sorted**, which keeps the file from being rewritten whole
every time anybody types.

Then the interesting half. A snapshot on the undo ring **is** a `Saved`, so being persisted put
these on the ring by construction — which is exactly what `docs/undo.md` predicted would fail
milestone 22's rule:

> **State the undoing hand wrote.** Milestone 24's scratchpads will not qualify, and they are the
> case this rule was written for.

The chat log dodged this for free by never being persisted. A scratchpad cannot: surviving a
restart is most of what it is worth. So the exemption is spelled out in two places, and **both are
needed**:

- **`undid` returns `None` for `SetNotes`**, so writing a note never pushes a step. This is the
  first disagreement between `undid` and `persists` — everywhere else, worth saving and worth
  undoing are the same answer.
- **The `Undo` arm of `apply` takes the notes out and puts them back around `adopt`.** This is the
  load-bearing one, and `undid` alone is not enough: a paragraph typed *between* two other commands
  is on the snapshot the second one pushed, whoever typed it. Without this, the DM's undo eats a
  player's paragraph, with nothing on screen to say it happened and no way to get it back.

`adopt` itself restores them like everything else, because it is the one inverse of `to_saved` and
two field lists would be the trap that file names — a field read on boot and forgotten on undo
loads correctly and undoes to a stale value, and neither shows up as an error. **Boot wants these
back; a restore does not.** Saying so once, at the call site that means it, is what keeps `adopt`
the single answer to "what is a saved room".

## The client half

### It sends on a pause

There is no send button, because the text *is* the state. So something has to decide when a
paragraph is finished, and a 500ms idle debounce does it: type, stop, saved. `blur` flushes
whatever the timer is still holding, which is the case that would otherwise lose a sentence —
somebody types a line and clicks straight back onto the board.

**There is no "saved" indicator, deliberately.** It would be the first piece of UI in this project
that narrates the network, and it would make a scratchpad look like a document, which is the
direction the boundary is drawn against.

The cap is `MAX_NOTES_LEN` on the server and the same number as the textarea's `maxlength`, so
typing simply stops rather than bouncing off a refusal after the paragraph is written. The server's
copy is the backstop for a client that does not have one.

**A dropped socket lets go of the box, and that is the honest version of an indicator.** `Net.send`
drops a frame written while the socket is not open — it returns nothing and there is nowhere for it
to go — and `flush` records the text as sent before it learns that, so a flush into a dead socket
loses the paragraph. The reconnect is a page reload, so there is no in-page recovery to write: the
box comes back holding whatever the server last stored.

What `body.offline` already did was grey the panel and take its pointer events. That is not the same
as letting go of it — a caret already in the textarea keeps taking keystrokes, so the one person
most likely to lose a paragraph is the one who was mid-paragraph when the socket died. `onLost` now
blurs it, which both flushes what the debounce is holding while the socket may still be open and
puts the box beyond the keyboard.

**Still no "saved" chip, and this is why a blur is the right size of fix.** An indicator would
narrate the network on every keystroke to prevent a loss that needs a dead socket and an unflushed
timer at the same moment. Letting go of the box says the same thing with no new UI at all.

### A keystroke in the box belongs to the box

`chat.ts`'s rule, and it matters more here: this is the one place in the application where somebody
types for a minute at a time with the board behind them. Every tool listens on `window`, four
disarm on Escape, and `undo.ts` binds Ctrl+Z — which already stands down inside a textarea, and
this is the surface that rule was really for.

Escape is *not* swallowed to blur, unlike the chat box. That box is one line and you leave it when
you have said the thing; this one people leave focused while they read, and the way out is the
board they were going to click anyway.

### It is a dock tab, and the dock stopped being one-at-a-time

The roadmap ruled out the rail: only one rail panel is open at a time, notes have to stay readable
while a tool is armed, and the rail is the DM's furniture while this belongs to everybody. The dock
answers all three — see *The right dock* in `docs/chat.md`.

What changed to take it is that **the dock's panels now stack**. One *rail* panel is open at a time
because rail panels are editing modes and two armed tools would be two meanings for one mouse
button. Nothing in the dock is a mode: a scratchpad and a log are both things you read while
something else is going on, and making notes close the chat would have rebuilt the rail's complaint
on the other edge of the screen. `#chat` and `#notes` are flex items in the dock's column for that
reason — with both open the pair shrinks against the rail's bottom edge, and the initiative panel
gives first.

`dock.ts` therefore holds a `Set<DockTab>` and a `toggle`, where it held a nullable tab and a
`show`. The badge rule is unchanged and still per tab.

**And the strip moved to the bottom of the dock**, which the second tab is what made necessary: the
dock grows upward, so opening a panel moves its top edge and never its bottom one, and a strip on
top slides out from under the pointer on every toggle. See *The right dock* in `docs/chat.md`.

## What is deliberately not here

- **No second box, and no title on the first.** A second document makes it a journal, which is the
  non-goal this was carved out of.
- **No sharing, no handout, no "show the table".** The whole feature is that nobody else is sent it.
  A share button would be a second visibility rule for the same string.
- **No formatting and no markdown.** `value` in a textarea, `textContent` nowhere near `innerHTML`,
  and nothing anybody types ever becomes markup.
- **No per-map or per-scene notes.** That is a journal keyed on something, and the key is not the
  part that makes it one.
- **No indicator, no word count, no autosave chip.** See above: the box does not talk about itself.
- **Not in the undo ring, and not reachable by anybody else's button.** Both halves of that are
  tested in `server/src/room/tests/notes.rs`.

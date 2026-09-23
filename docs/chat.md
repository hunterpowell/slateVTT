# Whisper and shout

Why the table's text messages work the way they do. Covers `ClientMsg::Say`, `ServerMsg::Said`,
`ChatTo`, `ChatLine`, `RoomState::chat`, `party_to`, `chat_for`, `client/src/chat.ts` and
`client/src/dock.ts`.

The boundary is in `.claude/CLAUDE.md` and it is the specification. Read it before adding anything
here: **no player-to-player messages, no channels, no threads, no history between sessions, no
formatting, no emotes, no commands.** The feature is called "whisper and shout" rather than "chat"
because chat tends to grow, and this is meant to stay the size it is.

Dice were on that list until milestone 40, and they're the one item that came off it. They came off
as a command, not as a syntax: nothing anybody types is parsed, and `/roll` doesn't exist. A thrown
die produces an ordinary `ChatLine` that goes through this feature unchanged. See `docs/dice.md`,
which now holds the boundary that matters for dice.

## What it is

Two destinations, never a third. A player sends to the table or to the DM; the DM sends to the table
or to one player. That's all of `ChatTo`. The missing case, one player to another, is left out on
purpose: it splits the table in a game played over voice, and leaving it out is also why a player's
box needs no recipient picker.

The motivating case is six people posting initiative rolls without talking over each other on voice.
Half the table has a Discord account only because the DM made them one, and tabbing out of the
browser to send one sentence was friction the VTT itself created. That's what changed the non-goal,
and the exception was specific: this feature, not messaging in general.

## The room keeps it and never writes it down

`RoomState::chat` is a `VecDeque<ChatLine>`, capped at `MAX_CHAT_LINES` (200), trimmed from the
front, and **absent from `Saved`**. That one decision covers three things that would otherwise each
need a rule:

- **A browser refresh mid-combat doesn't lose the initiative rolls.** The log goes out in `Welcome`,
  so a refresh gets everything that client is party to. Reconnecting is already a full resync, and
  the log comes with it.
- **Old whispers are never stored.** The save file is on a Raspberry Pi in somebody's front room,
  and what was whispered on a Tuesday isn't something this project should keep. The next game night
  starts empty if the server was restarted, and otherwise the cap limits what's left: the cap and
  the process lifetime are the only two things holding it.
- **An undo can't take back what somebody said.** Milestone 22's rule is that the ring may only hold
  state the undoing hand wrote, and the chat log was the first thing to test it. A snapshot is a
  `Saved`, the log isn't on one, so `adopt` leaves it alone. Nothing in `undo.rs` mentions the chat
  log, and nothing has to.

The cap is just a number. If 200 lines is ever wrong, change it.

## Who may see a line

`party_to(identity, line)` is the entire visibility rule, and it's a rule about two people, not
about a role:

```rust
ChatTo::Table     => true
ChatTo::Dm        => the DM, or whoever sent it
ChatTo::Player(p) => that player, or whoever sent it
```

The "or whoever sent it" half is easy to leave out and immediately wrong without it: the DM's own
whisper to Saelyn would be missing from the DM's log, and the person who said something would be the
only one unable to see that they said it.

It's a free function beside `can_move` and `can_erase`, because it needs nothing from the board.
`shape_seen` is on `RoomState` because it has to know where the party is standing. A sentence isn't
hidden the way a monster is, and the fog doesn't apply to words.

**This is the first filter in the project that separates one player from another.** Every other one
(the walls, the staged map, the overrides, the undo label) separates the DM from the table and asks
`is_dm`. This one never asks it. The DM sees every whisper because they're one end of all of them,
not because they're the DM.

### Both routes out go through it

`chat_for` in `snapshot_for`, and the `Event::Said` arm of `message_for`. That's invariant 3 at its
most important: filtering the deltas correctly and forgetting the snapshot would hand a joining
player the whole evening's whispers in one frame. `server/src/room/tests/chat.rs` tests both, as two
code paths over one rule.

### The one field whose content differs per recipient

`RoomView::chat` is different text for two different clients, not the room's single copy with rows
dropped: two players hold two different conversations. The roadmap predicted this would be what
refusing `tokio::sync::broadcast` finally paid for, and it was half right. The snapshot has
per-recipient content, while the delta has per-recipient filtering: `Said` is withheld whole or sent
whole, as `WallsChanged` is. What's new about the delta is that its audience isn't defined by role.

## The sender is echoed their own line

`Said` goes back to whoever sent it, which no other relayed frame in this project does. `Sketch` and
`Pinged` both skip the sender, and `TokenMoved` skips them mid-drag. The difference is that **a log
is a sequence**. A sketch and a ping ring are drawn on the sender's screen before the frame leaves,
and an echo would restart the animation. A line of text has to land somewhere in an order, and the
room decides where. A client that appended its own lines would have two orderings to reconcile the
first time two people typed at once.

So nothing here is predicted locally, and the box is cleared on send rather than when the echo
arrives. What's in the box is what hasn't been said yet, and keeping the sentence there until a
round trip completes is how someone ends up sending it twice.

## The right dock

`dock.ts` is `rail.ts` on the other side of the screen, and the resemblance is intended: a tab strip
is the shape this project already uses, and a floating window would have been a second answer to a
settled question. Four things differ, and they're why it's its own file rather than a generalised
`createRail`:

- **The rail is the DM's; the dock is everybody's.** Every dock tab is built on every connection. It
  was the first time both kinds of client had the same thing on screen.
- **The rail's `stop` rule doesn't apply.** That rule exists because the map, wall and fog panels
  take the left mouse button. Nothing in the dock touches the canvas, so a panel here can just be
  hidden. There's no `stop` in `dock.ts`, and one would mean something had gone wrong.
- **A tab here carries a count.** A rail tab describes what you could do; a dock tab describes what
  happened while you weren't looking.
- **The panels stack.** One rail panel is open at a time because rail panels are editing modes, and
  two armed tools would give one mouse button two meanings. Nothing in the dock is a mode: a log and
  a scratchpad are both read while something else is going on. Milestone 24 added the second tab and
  this rule with it, because making notes close the chat would have recreated here the problem that
  kept the scratchpad off the rail. So `dock.ts` holds a `Set<DockTab>` and a `toggle`, where it
  used to hold a nullable tab and a `show`. `#chat` and `#notes` are flex items, so with both open
  the pair shrinks against the rail's bottom edge.

It sits beneath the initiative panel rather than being a third tab on it. The dock is for reading
and replying, and initiative is for glancing at. That's the same distinction that makes the folded
initiative panel keep its current row instead of collapsing to a bare tab.

**The strip is the dock's last child, not its first.** This is the one place the dock is upside down
from the rail, and it's needed. The dock grows upward, so its top edge moves every time a panel opens
and its bottom edge never does. With the strip on top, every toggle slid the buttons out from under
the pointer aiming at them. That was tolerable with one tab and not with two, which is why it changed
in milestone 24 rather than 23. The rail grows downward and puts its strip on top for the same
reason. `drive-notes.mjs` asserts the strip's position across all four open/shut combinations of
chat and notes.

The panels stack in document order, never in the order they were opened: sound at the top, then
notes, then chat against the strip. A layout that depended on which tab was pressed first would put
a panel somewhere different each session, which is the moving-buttons problem again and worse. Chat
is last because the box people type into belongs nearest the bottom edge, where the send button and
the tabs already are, and because a log grows downward, so the newest line belongs at the bottom of
the dock rather than in the middle. Sound is first because it's the panel people touch least.
`dock.ts` hides and shows panels and doesn't decide where they sit; `index.html` is the only place
that does.

`#right-rail` is a flex column for the same reason the left rail is one. The initiative panel's
height depends on how many creatures are in the fight and whether it's folded, so anything pinned
under it at a fixed offset would be a number a later feature makes wrong. The dock takes
`margin-top: auto` and grows upward, so opening it never moves the panel above it.

## Nobody notices a whisper

This is the main way the feature fails at a table where half the players aren't technical. It gets
two answers, because a badge in the corner only works if someone is already looking at the corner:

- **A count on the collapsed tab**, cleared when the panel opens. It's on the dock rather than in the
  chat panel, because the panel is hidden exactly when the number matters.
- **The line itself appears beside the dock** for a few seconds. `#chat-toast` is outside the dock in
  the document, because it's what shows when the dock doesn't.

**It doesn't open the dock automatically.** Expanding a panel reflows the layout under whoever is
mid-drag, which is the reason the ping's edge arrow and the folding initiative panel also don't.

Your own line never counts as unread, since you just typed it. A shout counts as much as a whisper,
because the case this exists for is six people posting numbers.

## The sticky destination

One chip is armed and Enter sends there. That's one keystroke each way in a back-and-forth, and it
has one failure: forgetting where the box points and shouting something private.

So **the destination is shown twice.** The armed chip is where the choice was made. The input itself
changes colour and names the destination in its placeholder, because what someone looks at while
typing is the box they're typing into. Amber is already this project's colour for "not what the
table is seeing", and a whisper is exactly that.

The chips are labelled with the roster slug rather than the display name (`saelyn`, `bronzebeard`).
It fits, it matches the lowercase labels on the rail's tabs, and it avoids truncating "Thornwhistle
Fernbark". The full name is in the tooltip.

## One line, one format

`Saelyn → DM: i pick the lock` is what the sender sees and what the recipient sees. There's no "am I
the sender" branch anywhere in `chat.ts`, which is why `ChatLine` carries `to` as well as `by`. With
`by` alone, neither end could tell a whisper from a shout, and the DM couldn't tell their whisper to
Saelyn from Saelyn's whisper back.

Names and colours come from `nameOf` and `colourOf` in `pings.ts`. A player's colour is the one they
picked if they picked one (the public `colours` table), and otherwise their roster position's
default; the DM has a fixed colour. See `docs/presence.md`. Chat needed nothing new for this.

Lines are rendered with `textContent`, never `innerHTML`, and that's the only rule this feature has
about content. There's no formatting, so nothing anybody types ever becomes markup.

## A keystroke in the box belongs to the box

`chat.ts` calls `stopPropagation` on keydown in the input. Every tool in this project listens on
`window` (the rail's tools disarm on Escape, and the calibration box applies on Enter), and none of
them should be triggered by a sentence someone is typing. `undo.ts` makes the same argument from the
other side with `typingIn`, and that was the precedent. Escape blurs the box, since nothing else in
it wants the key.

## Not built

- **Player-to-player anything.** Not a chip, not a `ChatTo` variant, not a refusal that could be
  relaxed later without anyone noticing.
- **Commands, or any parsing of content.** Nothing anybody types is inspected for meaning: not a
  slash, not a colon, not a die. Milestone 40 put dice in this log with a command of its own so that
  this stays true. `ClientMsg::Roll` is a frame, not a syntax. Once a message body is scanned for
  anything, this becomes a chat system.
- **A link to the initiative panel.** A shouted number is text and a panel row is state, and a thrown
  number is still text, so milestone 40 changed nothing here. The DM reads the number and types it
  in. Parsing messages to fill a row would make this reach into a subsystem it otherwise doesn't
  touch, and it's the first step toward what the non-goal forbids.
- **A fog check.** Words aren't on the board. `moves_sight` is false for `Say`, and `Said` isn't in
  any visibility filter that reads a cell.
- **Timestamps, read receipts, editing or deleting.** A line said is said.
- **Sound.** Not argued against, just not built, and worth an argument before it is. Milestone 41
  added music to the room and didn't answer this: music playing under the scene and a ding when a
  whisper arrives are different features, and `docs/sound.md` says the same. The argument is still
  owed.

# Whisper and shout

Why the talking is the shape it is. Covers `ClientMsg::Say`, `ServerMsg::Said`, `ChatTo`,
`ChatLine`, `RoomState::chat`, `party_to`, `chat_for`, `client/src/chat.ts` and
`client/src/dock.ts`.

The boundary of this feature is in `.claude/CLAUDE.md` and it is the specification, not a summary
of one. Read it before adding anything here: **no player-to-player messages, no channels, no
threads, no history between sessions, no formatting, no emotes, no commands.** The noun is
"whisper and shout" rather than "chat" because chat is a thing that grows, and this is a file
about a thing that must not.

**Dice were on that list until milestone 40 and are the one item that came off it.** They came off
as a *command* rather than as a syntax — there is still no parsing of anything anybody types, and
`/roll` is exactly as absent as it ever was. What a thrown die produces is an ordinary `ChatLine`
riding this feature's own path. See `docs/dice.md`, whose boundary is the one that matters now.

## What it is

Two destinations, and never a third. A player says something to the table or to the DM; the DM
says it to the table or to one player. That is the whole of `ChatTo`, and the missing case — one
player to another — is missing on purpose: it is table-splitting at a voice table, and it is also
the reason a player's box needs no recipient picker.

The motivating case is six people posting initiative rolls without clogging voice. Half the table
has a Discord account because the DM made them one, and tabbing out of the browser to send one
sentence is friction the VTT itself created. That is what changed the non-goal, and it is worth
remembering that the amendment was specific: the exception is *this*, not "some messaging".

## The room keeps it and never writes it down

`RoomState::chat` is a `VecDeque<ChatLine>`, capped at `MAX_CHAT_LINES`, trimmed from the front,
and **absent from `Saved`**. That single decision pays for three things that would otherwise each
need a rule:

- **A browser hiccup mid-combat does not eat the initiative rolls.** The log goes out in `Welcome`,
  so a refresh is handed everything that client is party to. Reconnection is already a full resync
  and this rides on it.
- **Old whispers are never durable.** The save file is on a Raspberry Pi in somebody's front room.
  What was whispered on a Tuesday is not something this project should be storing, and next game
  night starts empty because the server was restarted or because it was not — either way the cap
  and the process are the only two things holding it.
- **An undo cannot take back what somebody said.** Milestone 22's rule is that the ring may only
  hold state the undoing hand wrote, and this is the first thing to test it. A snapshot is a
  `Saved`; the log is not on one; `adopt` therefore leaves it exactly where it is. Nothing names
  the chat log anywhere in `undo.rs` and nothing has to.

A cap is a cap and not a policy. If 200 lines is ever the wrong number, change the number.

## Who may see a line

`party_to(identity, line)` is the whole visibility rule, and it is a rule about **two people
rather than about a role**:

```rust
ChatTo::Table    => true
ChatTo::Dm       => the DM, or whoever sent it
ChatTo::Player(p) => that player, or whoever sent it
```

The `or whoever sent it` half is the one that is easy to leave out and immediately wrong: without
it, the DM's own whisper to Saelyn is absent from the DM's log, and the person who said something
is the only person unable to see they said it.

It is a free function beside `can_move` and `can_erase`, because it asks nothing of the board.
`shape_seen` lives on `RoomState` because it has to know where the party is standing; hiding a
sentence is not like hiding a monster, and the fog does not apply to words.

**This is the first filter in the project that draws its line between two players.** Every other
one — the walls, the staged map, the overrides, the undo label — separates the DM from the table,
and asks `is_dm`. This one never asks it. The DM holds every whisper because they are one end of
all of them, not because they are the DM.

### Both routes out go through it

`chat_for` in `snapshot_for`, and the `Event::Said` arm of `message_for`. That is invariant 3 with
the sharpest teeth in the project: filtering the deltas correctly and forgetting the snapshot would
hand a joining player the whole evening's whispers in one frame. `server/src/room/tests/chat.rs`
asserts both, deliberately as two code paths over one rule.

### The one field that is per-recipient *content*

`RoomView::chat` is genuinely different text for two different clients, rather than the room's
single copy with rows dropped. Two players hold two different conversations. The roadmap predicted
this would be what refusing `tokio::sync::broadcast` finally bought, and it was half right: the
**snapshot** is per-recipient content, while the delta is per-recipient *filtering* — `Said` is
withheld whole or sent whole, exactly as `WallsChanged` is. What is new about the delta is not that
its content varies but that its audience is not a role.

## The sender is echoed their own

`Said` goes back to whoever sent it, which no other relayed frame in this project does — `Sketch`
and `Pinged` both skip the originator, and `TokenMoved` skips them mid-drag. The difference is that
**a log is a sequence**. A sketch and a ring are drawn on the sender's screen before the frame
leaves, and an echo restarts an animation; a line of text has to land *somewhere in an order*, and
the room is what decides where. A client appending its own would have two orderings to reconcile
the first time two people typed at once.

So nothing about this feature is predicted locally, and the box is cleared on send rather than on
the echo: what is in the box is what has not been said yet, and holding the sentence until a round
trip completes is how somebody types it twice.

## The right dock

`dock.ts` is `rail.ts` on the other edge of the screen, and the resemblance is the point — a tab
strip is the shape this project already uses, and inventing a floating window would have been a
second answer to a settled question. Four things differ, and they are why it is its own file rather
than a generalised `createRail`:

- **The rail is the DM's furniture; this is everybody's.** Both tabs are built on every connection.
  It is the first time the two sides of this application have had the same thing on screen.
- **The rail's `stop` rule does not apply.** That rule exists because the map, wall and fog panels
  take the left mouse button. Nothing in the dock touches the canvas, so a panel here can simply be
  hidden. There is no `stop` in `dock.ts` and one would mean something had gone wrong.
- **A tab here carries a count.** A rail tab describes what you could do; a dock tab describes what
  happened while you were not looking.
- **The panels stack.** One rail panel is open at a time because rail panels are *editing modes*,
  and two armed tools would be two meanings for one mouse button. Nothing in the dock is a mode: a
  log and a scratchpad are both things you read while something else is going on. Milestone 24
  added the second tab and this rule with it — making notes close the chat would have rebuilt on
  this edge the complaint that kept the scratchpad off the other one. `dock.ts` therefore holds a
  `Set<DockTab>` and a `toggle`, where it held a nullable tab and a `show`; `#chat` and `#notes`
  are flex items so the pair shrinks against the rail's bottom edge with both open.

It sits *beneath* the initiative panel rather than becoming a third tab on it. The dock is
read-and-reply and initiative is glance-state — the same distinction that makes the folded
initiative panel keep its current row instead of collapsing to a bare tab.

**The strip is the dock's last child, not its first** — the one place this is upside down from the
rail, and it is not a style choice. The dock grows *upward*, so its top edge moves every time a
panel opens and its bottom edge never does; with the strip on top, every toggle slid the buttons out
from under the pointer that was aiming at them. That was tolerable with one tab and is not with two,
which is why it changed in milestone 24 rather than 23. The rail grows downward and puts its strip
on top for the same reason read the other way round. `drive-notes.mjs` asserts the strip's rectangle
across all four open/shut combinations.

**The panels stack in document order, never in the order they were opened** — notes above, chat
against the strip. A layout that depended on which tab was pressed first would put a panel somewhere
different every session, which is the buttons-moving complaint again and worse. Chat is last because
the box somebody types into wants to be nearest the bottom edge, where the send button and the tabs
already are, and because a log grows downward — the newest line belongs at the bottom of the dock
rather than in the middle of it. `dock.ts` hides and shows panels and has no opinion about where
they sit; `index.html` is the only place that says.

**`#right-rail` is a flex column for the reason the left rail is one.** The initiative panel's
height is however many creatures are in the fight and whether it is folded, so anything pinned
under it at a fixed offset is a number a later feature makes wrong. The dock takes `margin-top:
auto` and grows upward, so opening it never moves the panel above it.

## Nobody notices a whisper

This is the main way the feature fails a table where half the players are not technical, and it
gets two answers rather than one, because a badge in the corner asks somebody to already be
looking at the corner:

- **A count on the collapsed tab**, cleared when the panel opens. It lives on the dock rather than
  in the chat panel, because the panel is hidden at exactly the moment the number matters.
- **The line itself surfaces beside the dock** for a few seconds. `#chat-toast` is outside the dock
  in the document, because it is what shows when the dock does not.

**It does not auto-open the dock.** Expanding a panel reflows the layout under whoever is mid-drag,
which is what the ping's edge arrow and the folding initiative panel each declined to do for the
same reason.

Your own line is never news — you just typed it — and a shout counts as much as a whisper does,
because the case this exists for is six people posting numbers.

## The sticky destination

One chip is armed and Enter sends there. That is one keystroke each way in a back-and-forth, and
it has exactly one failure: forgetting which way the box points and shouting something private.

So **the destination is shown twice**. The armed chip is where the choice was made; the input
itself changes colour and says where it is going in its placeholder, because the thing somebody is
looking at while they type is the thing they are typing into. Amber is already this project's
colour for "not what the table is seeing", which is what a whisper is about words.

The chips are labelled with the roster **slug** rather than the display name — `saelyn`,
`bronzebeard` — which fits, matches the lowercase labels the rail's tabs use, and sidesteps
ellipsising "Thornwhistle Fernbark". The full name is on the tooltip.

## One line, one shape

`Saelyn → DM: i pick the lock` is what the sender sees and what the recipient sees. There is no
"am I the sender" branch anywhere in `chat.ts`, and that is why `ChatLine` carries `to` as well as
`by`: with `by` alone, neither end could tell a whisper from a shout, and the DM could not tell
their whisper to Saelyn from Saelyn's whisper back.

Attribution is `nameOf` and `colourOf` from `pings.ts` — the roster position indexes a palette, so
six clients agree with nothing on the wire. Nothing new was needed for this; the DM already had a
colour there.

`textContent`, never `innerHTML`, and that is the only rule this feature has about content. There
is no formatting, so nothing anybody types ever becomes markup.

## A keystroke in the box belongs to the box

`chat.ts` calls `stopPropagation` on keydown in the input. Every tool in this project listens on
`window` — four disarm on Escape, the calibration box applies on Enter — and none of them should be
reachable from a sentence somebody is typing. `undo.ts` makes the same argument from the other side
with `typingIn`, which is the precedent rather than a coincidence. Escape blurs the box, since
nothing else in here wants the key.

## What is deliberately not here

- **No player-to-player anything.** Not a chip, not a `ChatTo` variant, not a refusal that could be
  relaxed later without noticing.
- **No commands, and no parsing of content at all.** Nothing anybody types is inspected for
  meaning — not a slash, not a colon, not a die. Milestone 40 put dice in this log and did it with
  a *command of its own*, precisely so that this line could stay true: `ClientMsg::Roll` is a
  frame, not a syntax. The moment a message body is scanned for anything, this is a chat.
- **No coupling to the initiative panel.** A shouted number is text and a panel row is state — and
  a *thrown* one is still text, so milestone 40 changed nothing here. The DM reads the number and
  types it. Parsing content to fill a row makes this reach into a subsystem it otherwise touches
  none of, and it is the first step towards the thing the non-goal forbids.
- **No fog gate.** Words are not on the board. `moves_sight` is false for `Say` and `Said` is in no
  visibility filter that reads a cell.
- **No timestamps, no read receipts, no edit, no delete.** A line said is said.
- **No sound.** Not argued against — simply not built, and worth an argument before it is.

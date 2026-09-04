# The loaner die

A bag of plastic for whoever came without one. Milestone 40.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`ClientMsg::Roll`, `roll`, `rolled_text`, `may_address`, `RoomState::log`, `ChatLine::rolled`,
`DICE_SIDES`/`MAX_DICE`, or the die row in `client/src/chat.ts`.**

The boundary is in `.claude/CLAUDE.md` and it is the specification, not a summary of one:
**counts, and no arithmetic.** Read `docs/chat.md` beside it, because everything below rides on
that feature and adds almost nothing to it.

## Why the non-goal moved

It said *"Dice rolling (the group uses physical dice)"*, and that was a fact about the table
rather than an argument about software. On 2026-09-02 it stopped being true for one person for
one evening: a player came without his dice and the table rolled for him all night.

**So what was missing was not a dice system. It was a spare bag.** Six people roll plastic and
type the number into chat, and this is the seventh bag for whoever is short. The noun matters for
the reason "whisper and shout" and "the scratchpad" matter — a *dice roller* is a thing that
grows, and a *loaner die* is a thing with a job.

## The scope test: could a bag of plastic do this?

That is the whole rule, and it is sharper than "is this scope creep" because it answers questions
before they are arguments.

- **A bag has counts.** `8d6` for a fireball is in scope, and it is the case that most wants a
  loaner — nobody owns eight d6 even on a night they remembered their dice.
- **A bag has no arithmetic.** No `+3`, no expression field, no macros. **Modifiers are where a
  character sheet starts living**, and that is what the original non-goal was actually guarding.
- **A bag can throw two d20s.** Which one to keep is the player's, so advantage needs no code and
  gets none. This is the test doing real work: the feature people ask for next is already
  answered, and answered with *nothing to build*.

The one thing here that is not literally plastic is the total on a handful, and it is deliberate:
Slate knowing that 4 and 1 and 6 make 11 is not Slate knowing what a hit point means. The
individual dice are always printed beside it, so nothing hides behind the sum.

## It is a line of talk, and that is the whole implementation

`Roll` produces an ordinary `ChatLine` and emits the **existing** `Event::Said`. There is no
`ServerMsg` beside it, no new `Event`, and no new visibility rule.

```rust
ClientMsg::Roll { sides: u8, count: u8, to: ChatTo }
```

That one decision is where the feature's smallness comes from, the way naming the room in the
WebSocket URL is where multi-room's came from. Everything downstream is reused unchanged:
`party_to` decides who is party to it, `chat_for` puts it in the snapshot, the `Said` arm of
`message_for` sends it, and the cap, the dock badge and the toast were already built. `persists`
and the `spoken` match in `refresh_fog` were not touched at all, because both key on `Event` and
there is no new one.

**It carries no sender**, exactly as `Say` does not — who threw it is what the socket proved.

**The room throws, not the client.** A number a client rolled for itself is one it could throw
again until it liked the answer. This is the only reason the command exists rather than the
client inserting a number into the chat box, and `ChatLine::rolled` is what makes it visible.

## Private rolls cost nothing, and are what beats plastic

`to: ChatTo` was going to be on the command anyway, so a player whisper-rolling the DM and the DM
whisper-rolling one player needed **no code at all**. A physical die on a shared table cannot do
this, and it is the one place the loaner is better than the thing it stands in for.

On the client it needed no second picker either: the die throws to whichever destination chip is
already armed. The sticky destination that `docs/chat.md` argues for is doing double duty.

## The one divergence from `Say`

`may_address` is the shared rule and it never asks `is_dm` to grant anything — only to decide
which of two lists of destinations is yours. Both commands go through it. They differ in exactly
one arm, handled before either reaches it:

| | `Say` | `Roll` |
|---|---|---|
| DM addressing themselves | refused | allowed |

**`Say` refuses it because a note to self is what the scratchpad is for.** `Roll` allows it
because a monster's save has nowhere else to go, and `party_to`'s existing `Dm` arm already
resolves it correctly with no change — the DM matches both halves of it, gets exactly one copy,
and no player is party to a line addressed there.

`the_dm_may_roll_where_only_they_can_see_it` pins both halves, deliberately: widening `Roll` must
not have widened `Say` underneath it.

### It needed a control of its own, and shipped without one

**The server allowed this from the day it was written and there was no way to reach it.** The
DM's destination chips are `[table, ...roster]` — `destinations` gives them no `dm` entry, because
`Say` to their own ear is refused — so `ChatTo::Dm` was unreachable from the DM's screen while the
server test passed. That test drives `RoomState` directly, and **a server test cannot see a missing
button**. `drive-chat.mjs` now asserts the control exists, which is where the assertion belonged.

The fix is not a chip. Adding `{ kind: 'dm' }` to the DM's list would arm a destination the text
box cannot send to, which is the same lie as a rail tab that opens a panel that can do nothing —
so the control is a **toggle on the die row**: privacy here is a property of the *throw*, not of
the conversation. Armed, every throw goes to `ChatTo::Dm` whatever the chips say, and the driver
checks exactly that by arming `table` first.

It is marked twice, like a whisper — the button goes amber and so do the dice, because the dice are
what the eye is on when one is picked, and a sticky destination has one failure: forgetting which
way it points. In the log the line reads `DM → hidden` rather than `DM → DM`, which is true and
reads badly; the only way both ends are the DM is a hidden roll, so the label says what it is.

## Two bounds, not one

`.claude/CLAUDE.md`'s rule about a command carrying a variable-length collection applies here in a
form it has not taken before. The count is bounded by `MAX_DICE`; the thing that has to fit is not
a *frame* but a `ChatLine`, which is capped at `MAX_CHAT_LEN` — a roll the room accepted and then
stored a 500-character sentence about would be a line no `Say` could ever have produced.

`the_largest_roll_fits_a_chat_line` builds the largest legal instance and measures it, rather than
driving `check` and trusting the two numbers relate. That is the same test
`largest_override_fits_in_a_frame` is, asked of a different pair.

`DICE_SIDES` is a closed set checked on the server, exactly as `TOKEN_SIZES` is — seven buttons is
a better answer to "which die" than a number field.

## The randomness is the one already in the tree

`server/Cargo.toml` has no `rand` and does not need one. `uuid` is already a dependency with `v4`
enabled — it is what `main` mints the DM secret from — and a v4 is sixteen bytes from the OS
CSPRNG through `getrandom`. `roll` takes its entropy from there and mints another UUID when it
runs dry.

**Rejection sampling rather than `byte % sides`**, which would bias low faces: 256 is not a
multiple of 100, so on a d100 the bytes below 56 would land twice as often as the rest. The
discarded range is at most 55 values in 256.

`every_face_is_in_range_and_every_face_is_reachable` asserts both halves, and the second half is
the load-bearing one — a bounds check alone passes against a function that returns 1 forever. The
RNG is the OS's and there is no seed the test could fix, so its only defence is a margin, and the
margin is deliberately enormous: 4,000 faces per die.

## The client half

The die row lives **inside the chat panel**, between the destination chips and the input, and is
built in `chat.ts` rather than a module of its own: it needs `to` and `send`, both already local
to that closure.

- **Outside `#chat-form` on purpose.** These are not a way of composing a sentence, and inside the
  form every one of them is a submit button to argue with.
- **The die is the button.** One click throws. The common case is one die to the table, and a
  separate *roll* control in front of that is a form for pressing a d20.
- **The count box stops keystrokes**, the way `#chat-text` does — every tool in this project
  listens on `window`, and none of them should fire because somebody typed a 2 in there.
- **`hidden roll` is DM-only and gets its own line**, `flex: 0 0 100%`, so the seven dice keep the
  full width they are already tight in.
- **`d%` is the hundred**, which is what a table calls it and what keeps seven buttons on one row.

`DICE_SIDES` and `MAX_DICE` are mirrored in `chat.ts` from the room's, the way `MAX_FILL_CELLS`
mirrors the override cap. A die missing here is one nobody can ask for; a die added that the room
does not know is a red banner.

### `rolled` is styled, never filtered on

One class on the row, which is `to`'s job exactly — `.is-rolled` beside `.is-whisper`. Because
`draw` is the only render site, the toast gets it for free.

The field is nearly free: `ChatLine` is session memory and `Serialize` only, so it touches no
disk, needs no `#[serde(default)]`, and is not on `Saved` and therefore not on the undo ring. What
it buys is the thing the server-side throw was for — a witnessed number and a claimed one being
tellable apart. `a_typed_line_is_not_marked_as_thrown` is the assertion.

## What is deliberately not here

- **No modifiers, no expressions, no macros.** The scope test above, and the on-ramp the original
  non-goal was guarding. `2d6+3` is a character sheet with two fields filled in.
- **No advantage, no disadvantage, no keep-highest.** Throw two d20s; deciding is yours. This
  needs *no code*, which is the point.
- **No coupling to the initiative panel.** `docs/chat.md` refuses this for a shouted number and
  the refusal is unchanged for a thrown one — a roll is text and a panel row is state, and
  parsing one into the other is the first step towards the thing the non-goal forbids. The DM
  reads the number and types it.
- **No per-token or per-character dice.** A die belongs to a person, not to a creature, and a
  `Token` that owned dice would be a stat block.
- **No history between sessions.** The log is session memory and a roll is a line in it. An undo
  cannot take one back either — `an_undo_does_not_take_back_a_throw` — which matters more here
  than for talk: un-throwing a die somebody is reading the number off is worse than useless.
- **No animation and no sound.** Not argued against, simply not built. `docs/chat.md` says the
  same of sound, and this inherits it.

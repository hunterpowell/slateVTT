# The loaner die

A die for whoever came without one. Milestone 40.

Read this before touching `ClientMsg::Roll`, `roll`, `rolled_text`, `may_address`,
`RoomState::log`, `ChatLine::rolled`, `DICE_SIDES`/`MAX_DICE`, or the die row in
`client/src/chat.ts`. Read `docs/chat.md` too: a roll is a chat line, and nearly everything here
reuses that feature.

The scope rule is in `.claude/CLAUDE.md`: **counts, no arithmetic.**

## Why it exists

The non-goal used to read *"Dice rolling (the group uses physical dice)"*. On 2026-09-02 a player
forgot his dice and the table rolled for him all night. What was missing was a spare set, not a
dice system, and the name "loaner die" is there to keep it that size.

## The scope test: could a bag of plastic do this?

- **Counts, yes.** `8d6` for a fireball is in scope, and it's the case where a loaner helps most.
- **Arithmetic, no.** No `+3`, no expressions, no macros. Modifiers are where a character sheet
  starts, and that is what the original non-goal was guarding against.
- **Advantage needs no code.** Throw two d20s and the player picks one.

The total of a handful is the one thing plastic doesn't give you. It's allowed because summing
dice isn't rules knowledge, and the individual dice are always printed next to it.

## Implementation: a roll is a chat line

```rust
ClientMsg::Roll { sides: u8, count: u8, to: ChatTo }
```

`Roll` builds an ordinary `ChatLine` and emits the existing `Event::Said`. There is no new
`ServerMsg`, `Event` or visibility rule. `party_to` decides who sees it, `chat_for` puts it in the
snapshot, the `Said` arm of `message_for` sends it, and the chat cap, dock badge and toast all
apply unchanged. `persists` and the `spoken` match in `refresh_fog` key on `Event`, so they
weren't touched.

It carries no sender, same as `Say`: the socket identifies who threw it.

The server throws the dice, not the client. A client that rolled for itself could reroll until it
liked the result. That is the reason this is a command instead of the client typing a number into
chat, and `ChatLine::rolled` is what marks the line as thrown by the server.

## Private rolls

`to: ChatTo` was needed anyway, so a player rolling privately to the DM, or the DM to one player,
took no extra code. The client throws to whichever destination chip is already selected, so no
second picker was needed either.

## How `Roll` differs from `Say`

Both go through `may_address`. It only uses `is_dm` to choose which list of destinations applies,
never to grant anything. The two commands differ in one case, handled before `may_address`:

| | `Say` | `Roll` |
|---|---|---|
| DM addressing themselves | refused | allowed |

`Say` refuses it because notes to self belong in the scratchpad. `Roll` allows it because a
monster's saving throw needs somewhere hidden to go. `party_to`'s existing `Dm` arm already handles
this correctly: the DM gets one copy and no player sees it.

`the_dm_may_roll_where_only_they_can_see_it` tests both columns, so widening `Roll` can't also
widen `Say`.

### The hidden-roll toggle

The server allowed DM-to-self rolls from the start, but the UI had no way to send one. The DM's
destination chips are `[table, ...roster]`, and `destinations` gives them no `dm` entry because
`Say` to themselves is refused. The server test passed because it drives `RoomState` directly and
can't see that a button is missing. `drive-chat.mjs` now asserts the control exists.

It's a toggle on the die row, not a `{ kind: 'dm' }` chip. A chip would also select a destination
the text box can't send to. With the toggle on, every throw goes to `ChatTo::Dm` whatever chip is
selected. The driver tests this by selecting `table` first.

When it's on, both the button and the dice turn amber. People look at the dice when throwing, and
the main risk with a sticky setting is forgetting it's on. In the log the line reads
`DM → hidden` instead of `DM → DM`.

## Two limits

`MAX_DICE` bounds the count. The resulting sentence also has to fit in `MAX_CHAT_LEN`: the server
shouldn't store a line longer than any `Say` could produce.
`the_largest_roll_fits_a_chat_line` builds the largest legal roll and measures it, the same
pattern as `largest_override_fits_in_a_frame`.

`DICE_SIDES` is a closed set checked on the server, like `TOKEN_SIZES`. Seven buttons work better
than a number field.

## Randomness

There's no `rand` dependency. `uuid` is already a dependency with `v4` enabled (it generates the
DM secret), and a v4 UUID is 16 bytes from the OS CSPRNG via `getrandom`. `roll` takes bytes from
one and generates another when it runs out.

It uses rejection sampling, not `byte % sides`. Modulo would bias toward low faces: 256 isn't a
multiple of 100, so on a d100 the bytes below 56 would come up twice as often. At most 55 of 256
values get discarded.

`every_face_is_in_range_and_every_face_is_reachable` checks both. The reachability half matters
more, since a function that always returns 1 passes a range check. The OS RNG can't be seeded, so
the test uses a large margin instead: 4,000 throws per face.

## Client

The die row is inside the chat panel, between the destination chips and the input. It's built in
`chat.ts` because it needs `to` and `send`, which are local to that closure.

- It sits outside `#chat-form`. Inside the form every die would be a submit button.
- Clicking a die throws it. The common case is one die to the table, so there's no separate
  roll button.
- The count box stops keystroke propagation, like `#chat-text`. Tools listen on `window`, and
  typing a 2 shouldn't trigger one.
- The DM-only `hidden roll` toggle gets its own line (`flex: 0 0 100%`) so the seven dice keep the
  full width.
- `d%` is the d100. It's what tables call it, and it keeps seven buttons on one row.

`DICE_SIDES` and `MAX_DICE` are copied into `chat.ts` from the server, as `MAX_FILL_CELLS` is for
overrides. A die missing on the client can't be requested. A die the server doesn't know gets an
error banner.

### `rolled` is only for styling

It adds `.is-rolled` to the row, next to `.is-whisper`. `draw` is the only render path, so the
toast gets the style too. Nothing filters on it.

`ChatLine` is session memory and only `Serialize`, so the field never touches disk, needs no
`#[serde(default)]`, and isn't on `Saved` or the undo ring. It lets a reader tell a thrown number
from a typed one. `a_typed_line_is_not_marked_as_thrown` tests that.

## Not built

- **Modifiers, expressions, macros.** See the scope test. `2d6+3` is a character sheet with two
  fields filled in.
- **Advantage, disadvantage, keep-highest.** Throw two d20s and choose.
- **Linking rolls to initiative.** `docs/chat.md` refuses this for typed numbers, and the same
  applies to thrown ones: a roll is text, an initiative row is state, and parsing one into the
  other leads toward rules knowledge. The DM reads the number and types it in.
- **Per-token or per-character dice.** A die belongs to a person. A token that owned dice would
  be a stat block.
- **History between sessions.** The log is session memory. Undo can't take back a roll either
  (`an_undo_does_not_take_back_a_throw`), which matters because people may already be reading the
  number.
- **Animation and sound.** Not argued against, just not built. `docs/chat.md` says the same about
  sound, including that milestone 41's music is a separate feature and didn't address it.

# Undo

One ring, ten deep (`MAX_UNDO`), no redo, and the DM's alone. Milestone 22.

Read this before touching `RoomState::undo`, `remember`, `adopt`, `undid`, `Event::Restored`,
`undo.ts`, or `adoptView` in `scene.ts`. Three of those six are places where a plausible-looking
change breaks the ring without an error, and the client half exists for a reason you can't see from
the server.

## A snapshot is the save file, kept in memory

```rust
struct Snapshot { did: String, state: Saved }
undo: VecDeque<Snapshot>,
```

A snapshot is a whole `Saved`, not a hand-picked subset, and that's why this milestone was small.
The disk serializer already defines "this room, minus the parts that die with the process", so
`clients` and `pending` are left out because `Saved` has no field for them, not because of a rule
someone has to remember. Restoring a live socket table from ten commands ago (handing the room a list
of connections that have since dropped) is the one way undo could fail badly, and it can't happen,
because what counts as state wasn't decided a second time.

`to_saved` and `adopt` are the two halves, and **`adopt` is the only inverse.** Booting from disk and
undoing are the same operation against the same definition: `RoomState::restored` is `empty` +
`adopt`, and the undo arm calls `adopt` again. Two field lists would repeat milestone 20's mistake. A
field added to `Saved` and read in only one of them loads correctly and undoes to a stale value, or
the reverse, and neither shows up as an error.

`adopt` leaves alone whatever a `Saved` doesn't contain: `dm_secret`, `roster`, `clients`,
`pending`, and the ring itself. The ring matters most. Restoring it would make the second undo walk
back into a history the first one had already rewound.

## Each entry is the state after a change

The ring is pushed after a command, not before it. An undo pops that entry and adopts whatever is
behind it, so the back of the ring is always the present.

```
[ loaded the room ][ the map ][ tracing walls ][ a drawing ]
                                                     ↑ where the DM is now
undo →  pop, adopt "tracing walls"
```

This was chosen over snapshotting before each command for two reasons:

- **Nothing is cloned speculatively.** Snapshotting before each command would clone the whole room
  before every command and throw it away when nothing came of it, thirty times a second per person
  during a drag. `persists` can't be consulted first, because it answers about the events a command
  produced, and those don't exist yet.
- **The ring is never empty.** Every constructor (`restored`, `blank`, `hardcoded`) ends with
  `floor()`, which seeds it with the room as it was built. Without that, the first command of a
  session becomes the bottom of the ring and can't be undone, and the bug looks like the ring being
  too shallow rather than a missing line.

`floor()` is in the constructors, not in `spawn`, where `recompute_sight` is. The difference is
intended. Sight is derived from state, so it's rebuilt once where the room is started. A floor is
part of being a room, and every test in the crate builds a `RoomState` by hand without going near
`spawn`.

## What counts as a step

`undid` is the third list alongside `persists` and `moves_sight`, enumerated the same way (no
wildcard) for the same reason: a command added later and forgotten there would stop being undoable
with no error.

A step exists when a command has a label in `undid` and produced something `persists` says is worth
writing to disk. Asking `persists` keeps drag frames out automatically, which would otherwise be this
feature's main failure: a ring that turns over thirty times a second while a token moves. It also
means the two lists can't drift apart about what a change is.

The exclusions `persists` can't express:

- **`Undo` itself has no label.** That stops the ring growing a new top every time the DM steps back
  through it. Without this, the second press would return to where the first started.
- `Hello`, the three ephemeral commands (`Sketch`, `Ping`, `MoveCursor`), and `Say` and `Roll`
  persist nothing either. Their `None` is a second guard, not the only one.

**The labels are `&'static str` and aren't built from the room.** A name looked up at push time is
the name after the change, so undoing a rename would offer to undo the new name.

### One step per command, and what that costs

A wall trace is one `AddWalls` per segment, so a long trace fills the ring and can't be taken back as
a unit, only its last ten pieces. That's accepted. The way out of a bad trace is `ClearWalls`, which
is itself one undoable step.

Coalescing a run of same-kind commands was the alternative, and was declined. It would be a rule
`persists` doesn't already contain, and this feature stays small by having no rules of its own. The
depth is easy to change later; what triggers a step isn't.

## What may go on the ring

**Only state the undoing hand wrote.** Everything else that's persisted qualifies, players' drawings
included. A shape belongs to the room and the DM can already erase any of them. An undo that
skipped them would be worse: a restore restores everything, so it would take back the drawing and the
DM's last command together. Keeping a player's action as its own step is what keeps undo in
chronological order.

**The scratchpads don't qualify**, and they're the case this rule was written for: one box of text
per person, private to its author. Restoring one from ten commands ago deletes someone's paragraph,
with nothing on screen to say so and no way for them to get it back. The chat log avoids this by
never being persisted. A scratchpad can't, because surviving a restart is most of its value.

So the exclusion is written out in two places, and **both are needed.** `undid` returns `None` for
`SetNotes`, which was the first case where `undid` and `persists` disagree (everywhere else, worth
saving and worth undoing are the same answer). And the `Undo` arm of `apply` takes the notes out and
puts them back around `adopt`. That second half is the one that can't be skipped: a paragraph typed
between two other commands is on the snapshot the second one pushed, whoever typed it, so keeping
`SetNotes` off the ring isn't enough on its own.

Player colours (milestone 27) are excluded the same way, with the same two lines: `undid` returns
`None` for `SetColour`, and the `Undo` arm puts `colours` back around `adopt`. A colour is a player's
the same way a paragraph is, and one picked between two other commands is on the snapshot the later
one pushed. The second instance is what made this a rule rather than a special case.

`adopt` still restores both, because it's the one inverse and two field lists are the mistake
described above. Boot wants them back and a restore doesn't. Saying so once, at the call site that
needs it, keeps `adopt` the single definition of "what is a saved room". See `docs/notes.md` and
`docs/presence.md`.

`SetAudio` is also in `undid`'s `None` arm, but needs no second half: music isn't on `Saved`, so a
restore can't reach it. See `docs/sound.md`.

## It restores by re-sending the world

`Event::Restored` becomes `ServerMsg::Restored { state: Box<RoomView> }`, built by `snapshot_for`,
the same function a join goes through.

That's invariant 3 applied somewhere new. `Restored` is the second message that carries the whole
world, and filtering every delta correctly and then sending an unfiltered snapshot is the most common
way this project could leak. Going through `snapshot_for` means there's no second filter to keep in
step: a player's restore carries no walls, no staged map and no undo label, for the same reasons
their `Welcome` doesn't.

**Everyone is sent one**, because the room changed underneath all of them.

### Why not a diff

The case undo exists for is `sweep_board`: one map load removes the walls, the drawings and the fog
together, and writing the inverse of that is most of a second state model. A snapshot restores all
three for free. `undoing_a_map_load_gives_back_the_walls_the_shapes_and_the_fog_together` records
this, and it's the test to read before anyone proposes an inverse-per-command undo.

Milestone 31 weakened this argument but didn't overturn it. A map load now files the walls and the
fog paint under the outgoing map's URL and brings back whatever was traced on the incoming one, so a
load loses less: the tracing is on the shelf, and loading the map back is another way to reach it.
What a load still removes outright is the drawings and everywhere the party had explored. The
argument itself still holds, since writing an inverse for a command that replaces three collections
at once is still most of a second state model. Read it as "undo is right, and this is no longer the
strongest example", not as a reason to delete the ring.

### `UndoChanged`, and the frame that goes with it

`ServerMsg::UndoChanged { label }` goes to **the DM or nobody**. It was the first message with that
rule where what's withheld isn't a secret, just a label for a button players don't have. It's sent
beside every command that adds a step and every undo that removes one, the same pairing as
`OverridesChanged` / `FogChanged`: the room changed, and so did what the DM's button should say.

It keeps the button right when the DM's other tab, or a player's drawing, is what moved the ring. A
client can't work out its own label, for that reason.

**The test helper `drain` filters it out.** It's sent beside every persisting command, so leaving it
in would add a trailing frame to the expected output of every DM-side test in the crate and make each
of them partly a test of undo. (`drain` drops `Presence` too, for its own reasons.) `drain_all` is the
unfiltered version, and `undo.rs` uses it to assert the pairing `drain` hides.

## The client half, which took the most work

**`onWelcome` builds the page.** It constructs the pings, the room, the initiative panel, the draw
tool, the map, token, wall and fog tools, the rail and the board, once, on the assumption that there
is exactly one `Welcome` per connection. `start()` then captures `room.scene` by reference and draws
from that object every frame.

So `ROADMAP.md`'s plan ("restoring re-sends `Welcome` to everyone") was true of the server and false
of the client. A second `Welcome` would build a second copy of everything, register another `window`
keydown listener for every tool, and give the DM a fresh camera just as they're looking at what they
undid.

Two things follow:

- **`Restored` is its own message**, carrying state and nothing else. No `your_id`, no `is_dm`, no
  roster: identity is settled by the socket and can't change under it, and an undo can't edit the
  cast list.
- **`adoptView` changes the scene in place.** Assigning a new object to `room.scene` would leave the
  renderer drawing the old one forever. It shares its field list with `sceneFromView` through
  `fromView`, whose return type is `Omit<Scene, 'previewing'>`, so the one field a restore must not
  touch is excluded by the type rather than by the author remembering. `previewing` is local state
  about where the DM is looking, and a frame from the room says nothing about it.

`rulers.forgetExcept` is the one thing a restore needs that no other frame did. A restore can take
several tokens off the board at once, and there's no per-token frame to hang a `forget` on. It's the
same argument `onTokenRemoved` makes: a movement trail left by a token that just vanished is a line
pointing at where it went.

**`drive-undo.mjs` is where this is actually checked.** Counting the rail's tabs and reading the HUD
after an undo is the only place the rebuild bug would show up. Nothing on the canvas would reveal it,
and the room would agree with itself throughout.

## The button

It's pinned above the rail's tab strip, not on it. Undo isn't an editing panel; the DM reaches for it
while using one. That's the same reason the draw tool is pinned at the other end of the rail.

**It names what it would undo**: `undo: tracing walls`. With no redo, a press the DM can't predict
can't be recovered from, so like the fog fill's preview it shows the result before it happens instead
of confirming afterwards. A confirm dialog was considered and declined: `ResetFog` has one because
it's rare and total, and undo is neither.

It's disabled when there's nothing to undo, which is the rail's inert-panel rule in its simplest
form, and it spares the DM a refusal from the room. It's disabled rather than hidden, so the rail's
height doesn't jump the first time anyone changes anything.

Ctrl+Z was the client's first modifier binding and its first global key other than Escape. It's
ignored inside inputs, textareas and selects (`typingIn`), where it belongs to the browser: taking it
there would make a text field the one place in the app where the standard shortcut does something
drastic and unrelated. It's also ignored when the ring is empty, so the browser's own shortcut isn't
swallowed.

## Not built

- **Redo.** The label replaces it. The mistake worth protecting against is the one nobody sees coming,
  and a button that says what it will undo has already been read by the time it's pressed.
- **Per-client undo.** The ring is the room's and only the DM can use it. A player undoing their own
  drawing is a different feature, and it would need an answer for what happens when two rings
  interleave.
- **Persistence.** The ring is in memory and dies with the process. It isn't on `Saved`, which would
  double the size of every save, and nobody wants an evening's undo history after a restart.

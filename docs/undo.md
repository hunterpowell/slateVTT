# Undo

One stack, roughly ten deep, no redo, and the DM's alone. Milestone 22.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`RoomState::undo`, `remember`, `adopt`, `undid`, `Event::Restored`, `undo.ts`, or `adoptView` in
`scene.ts`** — three of those six are places where a plausible-looking change quietly breaks the
ring, and the client half exists for a reason that is invisible from the server.

## A snapshot is the save file, kept in memory

```rust
struct Snapshot { did: String, state: Saved }
undo: VecDeque<Snapshot>,
```

**`Saved` and not a hand-picked subset**, and that is the whole reason this milestone was small. The
disk serializer already answers "what is this room, minus the parts that die with the process", so
`clients` and `pending` stay out **by construction** rather than by a rule somebody has to remember.
Restoring a live socket table from ten commands ago is the one way undo could hard-fail — handing the
room a list of connections that have since dropped — and it cannot happen, because what counts as
state was not decided a second time.

`to_saved` and `adopt` are the two halves, and **`adopt` is the only inverse there is**: booting from
disk and undoing are the same operation against the same definition, so `RoomState::restored` is
`empty` + `adopt` and the undo arm is `adopt` again. Two field lists here would be milestone 20's
trap in a new place — a field added to `Saved` and read in only one of them loads correctly and
undoes to a stale value, or the reverse, and neither shows up as an error.

What `adopt` deliberately leaves alone is what a `Saved` has no opinion about: `dm_secret`, `roster`,
`clients`, `pending`, **and the ring itself**. That last one is load-bearing — restoring the ring
would make the second undo walk back into a history the first one had already rewound.

## Post-state, so the back of the ring is the present

The ring is pushed **after** a command, not before it. An undo pops that entry and adopts whatever is
behind it.

```
[ loaded the room ][ the map ][ tracing walls ][ a drawing ]
                                                     ↑ where the DM is now
undo →  pop, adopt "tracing walls"
```

Two things follow, and both are the reason this shape was chosen over snapshotting before each
command:

- **Nothing is cloned speculatively.** The pre-state alternative has to snapshot the whole room
  before every command and throw it away when nothing came of it — thirty times a second per person
  during a drag. `persists` cannot be consulted first, because it answers about the *events a command
  produced*, which do not exist yet.
- **The ring is never empty.** Both constructors end with `floor()`, which seeds it with the room as
  it was built. Without that the first command of a session becomes the bottom of the ring and cannot
  be undone — and the bug would look like the ring being shallow rather than like a missing line.

`floor()` is in the constructors and **not in `spawn`**, which is where `recompute_sight` lives and
is a real difference rather than an inconsistency. Sight is derived from state, so it is rebuilt once
where the room is started; a floor is part of *being* a room, and every test in the crate builds a
`RoomState` by hand without going near `spawn`.

## What counts as a step

**`undid` is `persists`'s and `moves_sight`'s third sibling**, enumerated the same way and for the
same reason: a command added later and forgotten there silently stops being undoable.

A step exists when a command **has a label and produced something worth writing to disk** — `undid`
and `persists` are asked together. Sharing `persists` is what keeps drag frames out for free, which
is the failure mode this feature would otherwise have: a ring that turns over thirty times a second
while a token is moving. It also means the two lists cannot drift about what a change *is*.

The two exclusions `persists` cannot express are the interesting half:

- **`Undo` itself has no label**, and that is what stops the ring growing a new top every time the DM
  walks down it. Without it the second press returns to where the first started.
- `Hello` and the three ephemeral commands, which persist nothing either — belt and braces rather
  than the only guard.

**The labels are `&'static str` and are not built from the room.** A name looked up at push time is
the name *after* the change, so undoing a rename would offer to undo the new name.

### One step per command, and what that costs

A wall trace is one `AddWalls` per segment, so a long trace fills the ring and cannot be taken back
as a unit — only its last ten pieces. That is deliberate, and the way out of a bad trace is
`ClearWalls`, which is itself one undoable step.

Coalescing a run of same-kind commands was the alternative and was declined: it is a rule `persists`
does not already contain, and this feature's whole economy is that it contains no rules of its own.
Depth is the cheap thing to change afterwards; the trigger is not.

## What may go on the ring

**State the undoing hand wrote.** Everything persisted today qualifies, players' drawings included —
a shape is the room's, the DM can already erase any of them, and an undo that skipped them would be
worse rather than better: it would take the drawing *and* the DM's last command together, because a
restore restores everything either way. Keeping a player's action as a step of its own is what makes
undo chronological.

**Milestone 24's scratchpads will not qualify**, and they are the case this rule was written for: one
box of text per person, private to its author. Restoring one from ten commands ago eats somebody's
paragraph, with nothing on screen to say it happened and no way for them to get it back. When they
land they come out of the snapshot. Milestone 23's log dodges it for free by never being persisted.

## It restores by re-sending the world

`Event::Restored` becomes `ServerMsg::Restored { state: Box<RoomView> }`, built by **`snapshot_for`**
— the same function a join goes through.

That is invariant 3 arriving somewhere new. `Restored` is the second message in this project that
hands over the whole world, and filtering every delta correctly and then sending an unfiltered
snapshot is the most common way this project could leak. Routing it through `snapshot_for` means
there is no second filter to keep in step: a player's restore carries no walls, no staged map and no
undo label, for exactly the reasons their `Welcome` does.

**Everyone is sent one**, because the room changed underneath all of them.

### Why not a diff

The case undo exists for is `sweep_board`: one map load destroys the walls, the drawings and the fog
together, and writing the inverse of that is most of a second state model. A snapshot restores all
three for nothing. `undoing_a_map_load_gives_back_the_walls_the_shapes_and_the_fog_together` is the
test that records this, and it is the one to read before anybody proposes an inverse-per-command
undo.

### `UndoChanged`, and the frame that rides along

`ServerMsg::UndoChanged { label }` reaches **the DM or nobody** — the fourth message with that rule,
and the first where what is withheld is not a secret but a label for a button a player does not have.
It goes out beside every command that adds a step and every undo that takes one away, which is the
`OverridesChanged` / `FogChanged` pairing again: the room changed, and so did what the DM can say
about it next.

It is what keeps the button right when the DM's *other tab*, or a player's drawing, is what moved the
ring. A client cannot derive its own label for that reason.

**The test suite filters it out of `drain`.** It rides beside every persisting command, so leaving it
in would put a trailing frame in the expectation of every DM-side test in the crate and make each of
them partly a test of undo. `drain_all` is the unfiltered one, and `undo.rs` asserts the pairing that
`drain` hides.

## The client half, which is the part that was not free

**`onWelcome` builds the page.** It constructs the pings, the room, the initiative panel, the draw
tool, the map, token, wall and fog tools, the rail and the board — once, on the stated assumption
that there is exactly one Welcome per connection. `start()` then captures `room.scene` **by
reference** and draws from that object every frame.

So `ROADMAP.md`'s plan — "restoring re-sends `Welcome` to everyone" — is true of the server and false
of the client. A second `Welcome` would build a second of everything, register another `window`
keydown listener for every tool, and hand the DM a fresh camera at the moment they are looking at
what they just undid.

Two things follow:

- **`Restored` is its own message**, carrying state and nothing else. No `your_id`, no `is_dm`, no
  roster: identity is settled by the socket and cannot change under it, and an undo cannot edit the
  cast list.
- **`adoptView` mutates the scene in place.** Assigning a new object over `room.scene` would leave
  the renderer drawing the old world forever. It shares its field list with `sceneFromView` through
  `fromView`, whose return type is `Omit<Scene, 'previewing'>` — so the one field a restore must not
  touch is excluded *by the type* rather than by the author remembering. `previewing` is local state
  about where the DM is looking, and a frame from the room has no opinion about it.

`rulers.forgetExcept` is the one thing a restore needs that no other frame did: a restore can take
several tokens off the board at once and there is no per-token frame to hang a `forget` on. Same
argument `onTokenRemoved` already makes — a trail left by a token that just vanished is a line
pointing at where it went.

**`drive-undo.mjs` is where this is actually checked.** Counting the rail's tabs and reading the HUD
after an undo is the only place the rebuild bug would ever show up: nothing on the canvas would say
so, and the room would agree with itself throughout.

## The button

Pinned above the tab strip, not on it. Undo is not an editing panel — it is what the DM reaches for
in the middle of using one, which is the draw tool's argument for being pinned at the other end of
the same rail.

**It names what it would take**: `undo: tracing walls`. With no redo, a press the DM cannot predict is
unrecoverable, so this is the fog fill's answer to the same problem — show the result before it lands
rather than confirm after. A confirm was considered and declined: `ResetFog` has one because it is
rare and total, and undo is neither.

Disabled when there is nothing to take, which is the rail's inertness rule in its plainest form, and
it also spares the DM a refusal from the room. Inert rather than hidden, so the rail's height does
not jump the first time anybody changes anything.

**Ctrl+Z is the client's first modifier binding and first global key that is not Escape.** It stands
down inside inputs, textareas and selects, where it belongs to the browser — stealing it there would
make a text field the one place in the application where the standard shortcut does something violent
and unrelated. It also stands down when the ring is empty, rather than swallowing the browser's own.

## What this milestone did not do

- **No redo.** The label is what replaces it: the mistake worth protecting against is the one nobody
  sees coming, and a button that names its victim before taking it is one the DM has already read.
- **No per-client undo.** The ring is the room's and the DM's alone. A player undoing their own
  drawing is a different feature and needs an answer to what happens when two rings interleave.
- **Nothing persisted.** The ring is in memory and dies with the process — it is not on `Saved`,
  which would double every save, and an evening's undo history is not something anybody reaches for
  after a restart.

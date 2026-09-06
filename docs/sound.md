# The room's music

One looping track, chosen by the DM, playing on every screen that asked for it. Milestone 41.

`.claude/CLAUDE.md` is loaded into every session; this file is not. **Read it before touching
`RoomState::audio`, `SetAudio`/`AudioChanged` on the server, `Library::Tracks`,
`library::Formats`/`sniff`, `client/src/sound.ts`, or the `sound` tab in `dock.ts`.**

The boundary is in `.claude/CLAUDE.md` and it is the specification rather than a summary of one:

> **The room holds one track. A list of tracks is a mixer, and a mixer is the scene system for
> ears.**

Three songs in the folder is not a mixer. The collection is `tracks/`, exactly as
`ROADMAP.md`'s backdrop entry decided that "a few presets" was the `backdrops/` folder and not a
list in the state model; the room holds *which one is up* and nothing else.

## What it overturned

Audio is a non-goal in `.claude/CLAUDE.md`, and unlike voice and video it was named and dropped
with no argument attached. `docs/chat.md` is the only place the project ever said anything further
— *"**No sound.** Not argued against — simply not built, and worth an argument before it is"* —
and nothing in two thousand lines of `ROADMAP.md` had ever costed it. So this is not a refusal
being overturned. It is a debt the project wrote down and then paid.

The way it came off the list is the way chat, the scratchpad and the dice each came off it: find
the version small enough to state in one sentence, and write that sentence down as the boundary.

## What it is worth over a Discord bot

The group is already on Discord, which has a music bot and a soundboard and screen share, so this
has to earn its place against something that costs nothing. It does, on one thing, and the rest is
convenience:

**Everybody mixes it against voice themselves.** A bot's volume is one number for seven pairs of
headphones and is therefore wrong for six of them; the person who wants a bed under the scene and
the person who mostly wants to hear their friends cannot both be served by a single fader. Here
the music is a separate stream on each machine and every person sets their own level — or turns it
off entirely, which is a thing a bot in the voice channel cannot offer at all.

After that: the DM does not alt-tab mid-scene, a late joiner hears what the table is hearing, and
a refresh does not lose it. Those are worth something and none of them would have been enough.

## It is the backdrop's twin, with one deviation

Almost everything here is `SetBackdrop` copied. `RoomState::audio` is an `Option<String>`,
`require_dm` guards it, `MAX_URL_LEN` bounds it, `message_for` returns the same frame to every
recipient, and it is on `RoomView` so a join carries it. The `check` arm and the `apply` arm are
the backdrop's word for word.

**The deviation is that it is not persisted, and it is the interesting part.** `audio` is not a
field on `Saved`. It sits with `RoomState::chat`: present in `empty` and `blank`, present in
`snapshot_for`, absent from `adopt` and `to_saved`. Two reasons, and the first is the one that
would have caused a visible bug:

**`audio.src = url` is not idempotent the way `drawImage` is.** A backdrop survives being re-
adopted on every `Restored` because redrawing a picture is free. Re-assigning an audio source
starts the file again from the top. Had this gone on `Saved`, it would have gone on the undo ring
by construction, and the DM undoing a wall trace would have restarted the boss theme on seven
machines mid-fight.

**And a room reopened on Saturday should come back quiet** rather than resuming whatever the DM
was prepping to on Tuesday.

What that bought is worth naming, because it is the cheapest version of a rule this project has
paid for twice before. `docs/undo.md` records that the scratchpad and the colours each needed
*two* lines to stay off the ring — a `None` in `undid` and an exemption in the `Undo` arm of
`apply` — because they are persisted state a player wrote. Music needed **neither**. `adopt`
assigns only `Saved` fields, so a restore cannot reach a field that is not on one.
`an_undo_does_not_change_the_music` and `the_music_is_not_in_the_save_file` are the two tests that
hold it, and the second is what fails loudly the day somebody adds the field to `store.rs` for the
look of the thing.

`undid` still has an arm, because the list is exhaustive. It is the only one of the five
exclusions there that `persists` already agrees with.

## The room holds a URL, not a playhead

Nothing on the wire says where in the track anybody is. Two browsers that turned sound on at
different moments are at different points in the same loop, and that is correct for a bed. It is
also why this is not the place to put a dramatic sting: a one-shot that has to land *together*
would need a clock the room does not have, and syncing playheads is the mixer's sibling.

The consequence to know about: turning sound off pauses, so turning it back on resumes where this
browser's element left off rather than where anybody else's did.

## Autoplay, and why it interacts with reconnects

A browser refuses to start audio no gesture asked for. So sound starts **off** on every screen and
the panel's button is the gesture. That is also just correct — everyone here is already listening
to voice chat, and a page that started making noise on load would be a page people muted at the
operating system.

**The Slate-specific part is that a dropped socket reloads the page.** That is `net.ts`'s reconnect
design and it is right for the reasons `docs/presence.md` gives, but it means every reconnect
throws away whatever gesture this page had. At a table on domestic broadband that is not an edge
case. So `sound.ts` remembers `wanted` in `localStorage`, *attempts* `play()` on the way back, and
**lights the button when the attempt is refused**. It never fails silently: silence with nothing on
screen to explain it is the one way this feature goes wrong without anybody being able to tell it
apart from the DM simply not having put music on.

**The control is a speaker and not a word, and that is not decoration.** It was a button labelled
`sound on` / `sound off` first, and the label is ambiguous in the one way that matters: *"sound
on"* reads as a statement of what is currently true exactly as easily as an offer to change it, so
somebody who cannot hear anything has no way to tell whether the button is describing their
problem or offering the fix. A crossed-out speaker cannot be read the wrong way round, and it is
the glyph already on the key at the top of everybody's keyboard.

The split that falls out of it is worth keeping: **the icon carries the state and the text carries
the action**. `aria-label` and `title` say "Turn the music on" / "Turn the music off" / "Start the
music" — the verb, which an icon cannot say and which a screen reader has nothing else to read.
Exactly one of the waves and the cross is ever drawn, and `drive-sound.mjs` asserts that pair
together with the label, because a class that quietly stopped being toggled is invisible to every
other assertion in that file: the audio would still play and every `src` check would still pass.

The blocked state is the one thing an icon cannot carry, so it is words in `#sound-blocked` rather
than a fourth glyph. Chrome's Media Engagement Index means a site somebody has played media on
often enough will usually be allowed to start without a gesture. Do not build on it — it makes this look intermittent
and hard to reproduce, and the lit button is the half that is always correct.

`console.warn` and pointedly not `console.error` for the rejection: `cdp.mjs` collects errors and
fails a driver on them, and a browser declining to autoplay is the ordinary case.

**Off means paused, never muted.** A muted element goes on fetching the file, and the file comes
off a Raspberry Pi through a tunnel. With `preload="none"` on the element, six people who never
turn sound on cost the room nothing at all.

## Volume is `localStorage` and is never on the wire

The precedent is the initiative fold and the open rail tab: a preference is not a `RoomState`
field. `docs/presence.md` draws the same line from the other side — `diagonals` is on the room
*because* six clients must agree about it, and how loud something is on one person's headphones is
the opposite kind of question.

There is deliberately no volume control on the DM's panel and there should not be one. A DM who
could set the table's level would be setting it wrong for most of the table.

## The per-library format gate

This was the only genuinely new server code, and it exists because `tracks/` is the first library
that does not hold pictures.

Before it, "what may a library hold" was a constant asked in three places: `IMAGE_EXTENSIONS` in
`library.rs`, consumed by the listing and by the stem-strip in `filename`, and `image_format` in
`main.rs`, which sniffed magic bytes. None of them knew which library they were serving.

Now `library::Formats` carries three things — the sniffers, the extensions worth listing, and the
noun phrase both refusals are built from — and `Library::formats()` is **one grouped arm**:

```rust
Self::Maps | Self::Portraits | Self::Backdrops => &library::IMAGES,
Self::Tracks                                   => &library::AUDIO,
```

That grouping is the guarantee, and `every_library_but_the_tracks_holds_pictures` is it as an
assertion: a fourth library was added rather than the other three changed.

**A predicate per format rather than an `(offset, literal)` table**, because MP3 is the one that
needs masking. The confidence levels differ and the code says so:

- `OggS` and `RIFF`/`WAVE` and `ID3` are unambiguous.
- **A bare MPEG frame header is eleven sync bits**, which is loose enough that something else could
  open with one by accident. The three masks after it reject the combinations MPEG itself calls
  reserved or invalid, which is as far as leading bytes can go. A false positive is a track the
  browser visibly refuses to play, on a route only the DM can reach.

`a_riff_container_is_a_webp_here_and_a_wav_there` is the pair worth keeping: the same twelve
leading bytes are an image in one library and audio in another, which is only unambiguous *because*
each library sniffs against its own table.

**`.m4a` is refused deliberately.** An MP4 `ftyp` brand does not say whether there is a video track
beside the audio — `M4A ` is audio-only, but ordinary AAC files are stamped `mp42` or `isom`, which
is what a film carries too. Accepting any `ftyp` lets a film into the music library, where it plays
its soundtrack and reads as a bug; accepting only `M4A ` refuses files that are fine. The way out
is to re-export. If that ever stops being acceptable, the addition is one arm checking both boxes.

Ogg covers Vorbis and Opus and both are written `.ogg`: the leading bytes are identical, the codec
is named inside the stream, and browsers read it from there. Worth knowing: **Safari does not play
Ogg**, so MP3 is the format that is safe everywhere.

## Sizing, and why the Pi does not care

`MAX_TRACK_BYTES` is 16 MiB — around seventeen minutes at 128 kbps, and about ninety seconds of
uncompressed WAV, which is the cap doing its job rather than failing at it.

**Each browser fetches a track once and never again.** `/uploads` is served
`immutable, max-age=31536000` by `cache_forever` and a library copy's name is a fingerprint of its
bytes, so the loop restarting reads from cache and so does the page reload after a dropped socket.
The only cost is the first fetch, seven copies through the tunnel, and `preload="none"` means only
the people who actually turned sound on pay it.

## What is not built, and one wart

- **No one-shot stings.** A door slam is a gesture rather than state — `Ping`'s shape for ears —
  and it would be cheap. It is left out because it wants to land *together*, and the room holds no
  playhead. Argue that before building it, not after.
- **No fades, no crossfade, no queue, no playlist, no per-map ambience.** Each of these is the
  mixer arriving one field at a time.
- **No notification sound.** `docs/chat.md` and `docs/dice.md` both say "no sound" and both mean a
  *ding on an arriving whisper or a rolled die*. That is a different feature from this one, it is
  still unbuilt, and it is still owed the argument those files ask for. Music playing does not
  answer it.
- **No YouTube or any embed.** Weighed and refused: it needs a third-party script on every client,
  where Slate currently has none; the IFrame API needs a visible player, so it is a video pane
  rather than an audio source; ads would play on six screens at the dramatic beat; and it fails
  per-client and silently on region locks and removed videos. The minimal version of the ask needs
  no code at all — paste the link in chat.
- **The wart:** `tools/audit-uploads.mjs` computes what is in use from the save file, so a track
  copy in `uploads/` is *always* listed as unreferenced — `audio` is not on `Saved` and never can
  be found there. Do not follow its `rm` for a `track-` file while music is playing. Fixing it
  properly means the audit reading live room state, which is the reaper that file refuses to be.

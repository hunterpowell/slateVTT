# The room's music

One looping track, chosen by the DM, playing on every screen that turned sound on. Milestone 41.

Read this before touching `RoomState::audio`, `SetAudio`/`AudioChanged` on the server,
`Library::Tracks`, `library::Formats`/`sniff`, `client/src/sound.ts`, or the `sound` tab in
`dock.ts`.

The boundary is in `.claude/CLAUDE.md` and it is the specification. Its test: **is this still one
track?** A second channel, crossfade, queue, playlist or per-map ambience each turns it into a mixer.

Three songs in the folder is not a mixer. The collection is `tracks/`, the same way the backdrop
entry in `docs/history.md` decided that "a few presets" meant the `backdrops/` folder rather than a
list in the state model. The room holds which track is playing and nothing else.

## Why it exists

Audio was a non-goal in `.claude/CLAUDE.md`, and unlike voice and video it was listed with no
argument attached. `docs/chat.md` was the only place the project said anything more: *"No sound. Not
argued against, just not built, and worth an argument before it is."* Nothing in the roadmap had
ever costed it. So this didn't overturn a refusal. It settled a question the project had written
down and left open.

It came off the list the way chat, the scratchpad and the dice did: find a version small enough to
state in one sentence, and write that sentence down as the boundary.

## Why not a Discord bot

The group is already on Discord, which has a music bot, a soundboard and screen share, so this has
to justify itself against something free. It does on one point, and the rest is convenience.

**Everyone sets their own music volume against voice.** A bot's volume is one number for seven pairs
of headphones, so it's wrong for six of them. The person who wants music under the scene and the
person who mostly wants to hear their friends can't both be served by one fader. Here the music is a
separate stream on each machine and each person sets their own level, or turns it off, which a bot
in the voice channel can't offer at all.

After that: the DM doesn't alt-tab mid-scene, a late joiner hears what the table hears, and a
refresh doesn't lose it. Those are worth something, but none of them would have been enough alone.

## It copies the backdrop, with one difference

Almost everything here is `SetBackdrop` copied. `RoomState::audio` is an `Option<String>`,
`require_dm` guards it, `MAX_URL_LEN` bounds it, `message_for` sends the same frame to every
recipient, and it's on `RoomView` so a join carries it. The `check` and `apply` arms are the
backdrop's, word for word.

**The difference is that it isn't persisted.** `audio` isn't a field on `Saved`. It's treated like
`RoomState::chat`: present in `empty` and `blank`, present in `snapshot_for`, absent from `adopt` and
`to_saved`. There are two reasons, and the first would have caused a visible bug.

`audio.src = url` isn't idempotent the way `drawImage` is. A backdrop survives being re-adopted on
every `Restored` because redrawing a picture costs nothing. Re-assigning an audio source starts the
file again from the beginning. Anything on `Saved` goes on the undo ring, so the DM undoing a wall
trace would have restarted the boss theme on seven machines mid-fight.

The second: a room reopened on Saturday should come back silent, not resume whatever the DM was
prepping to on Tuesday.

This is the cheapest version of a rule the project had already paid for twice. `docs/undo.md`
records that the scratchpad and the colours each needed two lines to stay off the ring (a `None` in
`undid` and an exemption in the `Undo` arm of `apply`), because they're persisted state a player
wrote. Music needed neither. `adopt` assigns only `Saved` fields, so a restore can't reach a field
that isn't on one. `an_undo_does_not_change_the_music` and `the_music_is_not_in_the_save_file` are
the two tests that hold this, and the second fails loudly if someone adds the field to `store.rs`
for consistency.

`undid` still has an arm for `SetAudio`, because the match is exhaustive. Of the five commands
excluded there, it's the only one `persists` already agrees with.

## The room holds a URL, not a playback position

Nothing on the wire says where in the track anyone is. Two browsers that turned sound on at
different moments are at different points in the same loop, and for background music that's fine.
It's also why this can't carry a dramatic sting: a one-shot sound that has to play for everyone at
once needs a clock the room doesn't have, and syncing playback positions is the next step toward a
mixer.

One consequence: turning sound off pauses, so turning it back on resumes where this browser left
off, not where anyone else is.

## Autoplay, and why it interacts with reconnects

Browsers refuse to start audio without a user gesture. So sound starts off on every screen, and the
panel's button is the gesture. That's also the right default: everyone is already listening to voice
chat, and a page that started playing sound on load would get muted at the operating system.

**The Slate-specific part is that a dropped socket reloads the page.** That's how `net.ts`
reconnects, for the reasons in `docs/presence.md`, and it means every reconnect throws away the
page's gesture. On home broadband that happens often enough to matter. So `sound.ts` remembers
`wanted` in `localStorage`, tries `play()` on the way back, and highlights the button when the
browser refuses. It never fails silently: silence with nothing on screen to explain it would look
exactly like the DM not having put music on.

The control is a speaker icon, not a word. It was first a button labelled `sound on` / `sound off`,
and that label is ambiguous where it matters: "sound on" reads as a description of the current state
as easily as an offer to change it, so someone who can't hear anything can't tell whether the button
is describing the problem or offering the fix. A crossed-out speaker can't be misread that way, and
it's the symbol already on everyone's keyboard.

So the icon carries the state and the text carries the action. `aria-label` and `title` say "Turn
the music on", "Turn the music off" or "Start the music": the verb, which an icon can't say and which
a screen reader needs. Exactly one of the waves and the cross is drawn at a time, and
`drive-sound.mjs` asserts that pair together with the label. A class that stopped being toggled would
be invisible to every other assertion in that file: the audio would still play and every `src` check
would still pass.

The blocked state is the one thing the icon can't show, so it's text in `#sound-blocked` rather than
a fourth icon. Chrome's Media Engagement Index means a site where someone has played media often
enough is usually allowed to start without a gesture. Don't rely on it: it makes the behaviour look
intermittent and hard to reproduce, and the highlighted button is always correct.

The refusal is logged with `console.warn`, not `console.error`: `cdp.mjs` collects errors and fails a
driver on them, and a browser declining to autoplay is the normal case.

**Off means paused, never muted.** A muted element keeps fetching the file, and the file comes off a
Raspberry Pi through a tunnel. With `preload="none"` on the element, six people who never turn sound
on cost the room nothing.

## Volume is in `localStorage`, never on the wire

The precedent is the initiative fold and the open rail tab: a preference isn't a `RoomState` field.
`docs/presence.md` draws the same line from the other side: `diagonals` is on the room because all
the clients must agree on it, and how loud something is in one person's headphones is the opposite
kind of question.

There's no volume control on the DM's panel, and there shouldn't be. A DM who set the table's level
would set it wrong for most of the table.

## The per-library format check

This was the only new server code, and it exists because `tracks/` is the first library that
doesn't hold pictures.

Before it, "what may a library hold" was one constant asked in three places: `IMAGE_EXTENSIONS` in
`library.rs`, used by the listing and by the extension-stripping in `filename`, and `image_format` in
`main.rs`, which sniffed magic bytes. None of them knew which library they were serving.

Now `library::Formats` holds three things: the sniffers, the extensions worth listing, and the noun
phrase both refusal messages are built from. `Library::formats()` (in `main.rs`) is one grouped arm:

```rust
Self::Maps | Self::Portraits | Self::Backdrops => &library::IMAGES,
Self::Tracks                                   => &library::AUDIO,
```

That grouping is the guarantee that the image libraries didn't change, and
`every_library_but_the_tracks_holds_pictures` asserts it: a fourth library was added and the other
three were left alone.

Each format is a predicate rather than an `(offset, literal)` table entry, because MP3 needs
masking. The confidence levels differ, and the code says so:

- `OggS`, `RIFF`/`WAVE` and `ID3` are unambiguous.
- **A bare MPEG frame header is eleven sync bits**, which is loose enough that another file could
  start with one by accident. The three masks after it reject the combinations MPEG itself calls
  reserved or invalid, which is as far as leading bytes can go. A false positive is a track the
  browser visibly refuses to play, on a route only the DM can reach.

`a_riff_container_is_a_webp_here_and_a_wav_there` is the test worth keeping: the same twelve
leading bytes are an image in one library and audio in another, which is only unambiguous because
each library sniffs against its own table.

`.m4a` is refused. An MP4 `ftyp` brand doesn't say whether there's a video track beside the audio.
`M4A ` is audio-only, but ordinary AAC files are stamped `mp42` or `isom`, the same as a film.
Accepting any `ftyp` lets a film into the music library, where it plays its soundtrack and looks
like a bug; accepting only `M4A ` refuses files that are fine. The workaround is to re-export. If
that ever stops being acceptable, the fix is one arm that checks both boxes.

Ogg covers Vorbis and Opus, and both are written `.ogg`: the leading bytes are identical, the codec
is named inside the stream, and browsers read it from there. **Safari doesn't play Ogg**, so MP3 is
the format that works everywhere.

## Size, and why the Pi doesn't mind

`MAX_TRACK_BYTES` is 16 MiB: around seventeen minutes at 128 kbps, or about ninety seconds of
uncompressed WAV. Refusing long WAVs is the cap working as intended.

Each browser fetches a track once. `/uploads` is served `immutable, max-age=31536000` by
`cache_forever`, and a library copy's name is a fingerprint of its bytes, so the loop restarting
reads from cache, and so does the page reload after a dropped socket. The only cost is the first
fetch, seven copies through the tunnel, and `preload="none"` means only the people who turned sound
on pay it.

## Not built, and one known problem

- **One-shot stings.** A door slam is a gesture rather than state, like `Ping` but for sound, and it
  would be cheap. It's left out because it has to play for everyone at once, and the room holds no
  playback position. Argue that before building it, not after.
- **Fades, crossfade, queue, playlist, per-map ambience.** Each of these is a step toward a mixer.
- **Notification sounds.** `docs/chat.md` and `docs/dice.md` both say "no sound" and both mean a
  ding when a whisper or a roll arrives. That's a different feature from this one, still unbuilt, and
  still owed the argument those files ask for. Music playing doesn't answer it.
- **YouTube or any embed.** Considered and refused. It needs a third-party script on every client,
  where Slate currently has none. The IFrame API needs a visible player, so it's a video pane rather
  than an audio source. Ads would play on six screens at the dramatic moment. And it fails per client,
  silently, on region locks and removed videos. The smallest version of the request needs no code:
  paste the link in chat.
- **The known problem:** `tools/audit-uploads.mjs` works out what's in use from the save file, so a
  track copy in `uploads/` is always listed as unreferenced, since `audio` isn't on `Saved`. Don't
  follow its `rm` for a `track-` file while music is playing. Fixing it would mean the audit reading
  live room state, which would make it the automatic cleanup that script refuses to be.

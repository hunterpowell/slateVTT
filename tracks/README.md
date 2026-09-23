# Tracks

The music the room plays: an ambient loop for exploring, something heavier for a boss, a tavern for
the evenings that are mostly talking. Drop MP3, Ogg or WAV files in here, in subfolders if you like,
and they appear in the table panel under **put music on…**.

**One track at a time.** The room stores which one is playing and nothing else. Storing a list of
tracks in the room would turn it into a mixer, which is the scene system `docs/maps.md` rules out
under another name, so the collection is this folder, which costs the room nothing. Switching from
the ambient loop to the boss theme replaces it; there's no crossfade, no second channel and no queue.
See `docs/sound.md`.

Each track loops. The room doesn't track a playback position, so two browsers that started at
different moments are at different points in the same loop. That's fine for background music, and
it's why this isn't the place for a dramatic sting.

**Everyone controls their own volume, and the DM can't set it for them.** The whole table is
already listening to voice chat at seven different levels, so a single room-wide volume would be
wrong for six of them. Sound also starts **off** on every screen until each person turns it on.
That's partly a browser rule (a page may not start audio nobody asked for) and partly the right
default anyway.

Keep them small. There's a 16 MiB cap, which is about seventeen minutes at 128 kbps or ninety
seconds of uncompressed WAV. Each browser downloads a track once and never again (`/uploads` is
served `immutable`), but the first fetch is seven copies off a Raspberry Pi through a tunnel, so a
3 MB Ogg loop is better here than a 15 MB one.

MP3 plays everywhere. Ogg is smaller at the same quality but doesn't play in Safari. `.m4a` isn't
accepted: an MP4 container doesn't say in its header whether there's a video track alongside the
audio, so accepting it would let a film into the music library. Re-export to MP3 or Ogg.

Picking one **copies it into the uploads directory** rather than serving it from this folder, the
same rule maps, portraits and backdrops follow.

`drone.wav` is a placeholder from `tools/gen-assets.mjs`, here so the picker isn't an empty list on a
fresh clone and so `tools/drive-sound.mjs` has something to pick. Delete it once there's real music
in the folder.

Point this somewhere else with `SLATE_TRACKS`.

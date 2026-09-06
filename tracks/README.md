# Tracks

The music the room plays — one ambient bed for exploring, something heavier for a boss, a
tavern for the evenings that are mostly talking. Drop MP3, Ogg or WAV files in here, subfolders
and all, and they appear in the table panel under **put music on…**.

**One track at a time.** The room holds which one is up and nothing else. A list of tracks in
the room would be a mixer, and a mixer is the scene system `docs/maps.md` refuses, wearing
different clothes — so the collection is this folder, which costs the room nothing. Switching
from the ambient bed to the boss theme replaces it; there is no crossfade, no second channel and
no queue. See `docs/sound.md`.

Each track loops. There is no playhead on the wire, so two browsers that started at different
moments are at different points in the same loop — which is correct for a bed and is why this is
not the place to put a dramatic sting.

**Everyone controls their own volume, and the DM cannot set it for them.** The whole table is
already listening to voice chat at seven different levels; a single room-wide volume would be
wrong for six of them. Sound also starts **off** on every screen until somebody turns it on,
which is partly a browser rule — a page may not start audio nobody asked for — and partly just
correct.

Keep them small. A 16 MiB cap applies, which is around seventeen minutes at 128 kbps and about
ninety seconds of uncompressed WAV. Each browser downloads a track once and never again
(`/uploads` is served `immutable`), but the first fetch is seven copies off a Raspberry Pi
through a tunnel, so a 3 MB Ogg loop is worth more here than a 15 MB one.

MP3 is the format that plays everywhere. Ogg is smaller at the same quality and does not play in
Safari. `.m4a` is deliberately not accepted — an MP4 container does not say in its header whether
there is a video track beside the audio, so accepting it would let a film into the music library;
re-export to MP3 or Ogg.

Picking one **copies it into the uploads directory** rather than serving this folder, the same
rule maps, portraits and backdrops follow.

`drone.wav` is a placeholder from `tools/gen-assets.mjs`, here so the picker is not an empty list
on a fresh clone and so `tools/drive-sound.mjs` has something to pick. Delete it once there is
real music in the folder.

Point this somewhere else with `SLATE_TRACKS`.

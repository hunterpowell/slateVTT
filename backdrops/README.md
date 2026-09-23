# Backdrops

Pictures the DM shows the table **instead of** the board (a forested clearing, a campsite, the
inside of a tavern) for the stretches of an evening where there's nothing to move and nothing to
measure. Drop PNG, JPEG or WebP files in here, in subfolders if you like, and they appear in the
table panel under **show a backdrop…**.

A backdrop isn't a map, which is why it has its own folder rather than living in `maps/`. It has no
grid, nothing stands on it, nothing is traced across it and nobody explores it. Loading a *map*
clears the board (the walls, the drawings and everywhere the party has been), because a new image is
a new dungeon. Putting a picture in front of the table clears nothing: the encounter is still there,
untouched, and taking the backdrop down puts everyone back exactly where they were. See *Backdrop*
in `docs/maps.md`.

Size them like maps rather than portraits, since a backdrop fills the window. It's drawn to fit,
centred and whole, with no cropping and no camera, so the image can be any shape and letterbox bars
are normal.

Picking one **copies it into the uploads directory** rather than serving it from this folder, the
same rule maps and portraits follow. **upload a backdrop…** on the same panel writes a file into this
folder and then picks it, so an uploaded backdrop stays in the list for next time.

`dusk.png` is a placeholder from `tools/gen-assets.mjs`, here so the picker isn't an empty list on a
fresh clone. Delete it once there's real art in the folder.

`maps/` already holds several images that work well as backdrops, the two *Forest Encampment* files
in particular. Copy them across rather than picking them as maps.

Point this somewhere else with `SLATE_BACKDROPS`.

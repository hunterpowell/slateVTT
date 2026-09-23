# Portraits

Token art the DM picks from, the way `maps/` is the folder of maps. Drop PNG, JPEG or WebP files in
here (subfolders are fine and show up as a path prefix in the list) and they appear in the token
panel under **choose from library…**.

A portrait is drawn inside a circle as wide as the token (one cell for most creatures), so anything
much past a few hundred pixels square is more image than the board can show. **Use square images.**
The canvas stretches the image to a square and clips it to the circle, so a portrait-shaped picture
comes out squashed rather than cropped.

Picking one **copies it into the uploads directory** rather than serving it from this folder, so the
host's data directory (`%LOCALAPPDATA%\Slate` or `/var/lib/slate`) holds every portrait the room uses.
**upload art…** on the token panel writes a file into this folder and then picks it. Maps follow the
same rule, and the reasoning is in `docs/maps.md`. Nothing here is ever sent to a player: only the DM can list or pick, and what
reaches the table is the copy, on a token they can already see.

Point this somewhere else with `SLATE_PORTRAITS`.

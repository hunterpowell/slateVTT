# Portraits

Token art the DM picks from, the way `maps/` is the folder of maps. Drop PNG, JPEG or WebP files in
here (subfolders are fine and show up as a path prefix in the list) and they appear in the token
panel under **choose from library…**.

A portrait is drawn inside a circle one cell across, so anything much past a few hundred pixels
square is more image than the board can show. Square images crop best; the canvas centres the image
and fills the circle with it.

Picking one **copies it into the uploads directory** rather than serving it from this folder, so
`%LOCALAPPDATA%\Slate` is a complete backup on its own. Maps follow the same rule, and the reasoning
is in `docs/maps.md`. Nothing here is ever sent to a player: only the DM can list or pick, and what
reaches the table is the copy, on a token they can already see.

Point this somewhere else with `SLATE_PORTRAITS`.

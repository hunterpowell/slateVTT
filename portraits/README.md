# Portraits

Token art the DM picks from, the way `maps/` is the folder of maps. Drop PNG, JPEG or WebP
files in here — subfolders are fine and show up as a path prefix in the list — and they appear
in the token panel under **choose from library…**.

A portrait is drawn inside a circle one cell across, so anything much past a few hundred pixels
square is more image than the board can show. Square images crop best; the canvas centres and
covers.

Picking one **copies it into the uploads directory** rather than serving this folder, so
`%LOCALAPPDATA%\Slate` stays a complete backup on its own — the same rule maps follow, and the
reasoning is in `docs/maps.md`. Nothing here is ever sent to a player: listing and picking are
DM-only, and what reaches the table is the copy, on a token they can already see.

Rename this folder with `SLATE_PORTRAITS` if it lives somewhere else.

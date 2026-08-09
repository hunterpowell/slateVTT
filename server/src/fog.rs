//! What the party can see, and what they have seen.
//!
//! The walls have existed since milestone 15 and nothing read them. This is what
//! reads them.
//!
//! Two sets of cells, both party-shared rather than per-player: `visible` is
//! current line of sight, `revealed` is everywhere the party has ever had it.
//! Terrain gates on `revealed` and tokens gate on `visible` — the room does that
//! part; this module only answers which cells are which.
//!
//! **Read `docs/fog.md` before changing anything here.** In particular the
//! coordinate story, which is the trap: a cell is grid units, a wall is image
//! pixels, and every ray in this file is cast in image pixels because that is the
//! space the walls live in. `Cell` is the only grid-unit thing here and it is
//! converted the moment it is used.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::protocol::{MapInfo, Px, Rect, Wall};
use crate::room::MAX_MAP_PX;

/// A cell of the grid, by its integer coordinates. The cell a token at
/// `(3.5, 3.5)` stands in is `(3, 3)`.
///
/// A tuple rather than a struct, unlike `Pos` and `Px`: it is an index into a
/// lattice rather than a position on the board, it is never serialized as itself
/// — `FogView` packs it — and it wants to be a `HashSet` key, which is one derive
/// instead of four.
pub type Cell = (i32, i32);

/// A grid cell is five feet. The one piece of tabletop arithmetic in the server,
/// here because a vision radius is set in feet and used in cells.
///
/// The client says the same thing in `ruler.ts`. Two constants rather than one on
/// the wire because it is a fact about the game rather than about this room, and
/// a frame carrying it would be a frame that could disagree with itself.
pub const FEET_PER_CELL: f32 = 5.0;

/// How far a vision radius may be set, in feet. The ceiling is not fussiness: the
/// cell sweep below is quadratic in it, and on a map with no play area to clip
/// against it is the only thing bounding the loop at all.
pub const MIN_VISION_FT: f32 = 5.0;
pub const MAX_VISION_FT: f32 = 500.0;

/// How large the packed rectangle may get, in cells on a side.
///
/// Defensive rather than a rule anybody meets: the box is the bounding box of
/// explored terrain, and explored terrain is clipped to the board, so reaching
/// this needs the smallest legal grid on the largest legal image — a
/// configuration that already costs the client hundreds of thousands of grid
/// lines a frame, which is what `MIN_GRID_PX` exists to talk about. Past it the
/// fog packs as nothing, which the client draws as a dark board: a visible
/// failure on one map rather than an allocation that takes the room down for
/// everyone.
const MAX_FOG_SIDE: u32 = 4096;

/// Never seen. The client draws this solid.
const DARK: char = '#';
/// Seen once, not in sight now — explored terrain. Drawn dim: the map is
/// remembered, the creatures standing on it are not.
const KNOWN: char = 'o';
/// In sight right now. Drawn clear.
const SEEN: char = '.';

/// The fog as it goes on the wire, and as it goes to disk.
///
/// A rectangle of cells packed one character each, row-major, rather than a JSON
/// array of per-cell values: the wire protocol asks for frames a human can read
/// in devtools, and a few thousand numbers is not one. A few thousand characters
/// laid out as a map *is* — the shape of the dungeon is legible in the string.
///
/// The rectangle is the bounding box of everything the party has revealed, so an
/// unexplored map packs to nothing at all. **Every cell outside it is `DARK`**,
/// which is what lets the box shrink to the interesting part instead of covering
/// the image.
///
/// `None` in place of one of these means the map is not fogged — and, like
/// `staged` being `None`, it is the only thing the server could mean by it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FogView {
    /// Cell coordinates of the top-left of the packed rectangle.
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// `w * h` characters, row-major: `#` never seen, `o` explored, `.` in sight.
    pub cells: String,
}

/// Packs two cell sets into one rectangle of characters.
///
/// One character carries both facts because `visible` is a subset of `revealed`
/// — seeing a cell reveals it, and the room unions them in that order — so the
/// three states are a total description and no cell needs two fields.
pub fn pack(revealed: &HashSet<Cell>, visible: &HashSet<Cell>) -> FogView {
    let Some((x0, y0, x1, y1)) = bounds(revealed) else {
        return FogView::default();
    };

    let w = x1.abs_diff(x0) + 1;
    let h = y1.abs_diff(y0) + 1;
    if w > MAX_FOG_SIDE || h > MAX_FOG_SIDE {
        return FogView::default();
    }

    let mut cells = String::with_capacity((w * h) as usize);
    for y in y0..=y1 {
        for x in x0..=x1 {
            cells.push(if visible.contains(&(x, y)) {
                SEEN
            } else if revealed.contains(&(x, y)) {
                KNOWN
            } else {
                DARK
            });
        }
    }

    FogView {
        x: x0,
        y: y0,
        w,
        h,
        cells,
    }
}

/// The revealed cells back out of a packed rectangle, for a room coming off disk.
///
/// Both lit states count as revealed, so this is the exact inverse of `pack`'s
/// first question and does not care which of the two the file happened to record.
/// `visible` is deliberately not recovered: it is derived from where the tokens
/// are standing, which the same file already holds, and deriving it is how a save
/// written before a wall moved cannot describe sight through it.
pub fn unpack(view: &FogView) -> HashSet<Cell> {
    let mut revealed = HashSet::new();
    // A `w` that disagrees with the string is a damaged file rather than a schema
    // change, and `chars().nth()` per cell would be quadratic. Walking the
    // characters in order and deriving the row is total either way.
    for (i, c) in view.cells.chars().enumerate() {
        if c == DARK || view.w == 0 {
            continue;
        }
        let i = i as u32;
        revealed.insert((view.x + (i % view.w) as i32, view.y + (i / view.w) as i32));
    }
    revealed
}

/// The smallest box containing every cell, or `None` for an empty set.
fn bounds(cells: &HashSet<Cell>) -> Option<(i32, i32, i32, i32)> {
    let mut iter = cells.iter();
    let &(mut x0, mut y0) = iter.next()?;
    let (mut x1, mut y1) = (x0, y0);
    for &(x, y) in iter {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Some((x0, y0, x1, y1))
}

/// Every cell at least one of `sources` can see.
///
/// **Raycasting to cell centres, not shadowcasting.** The roadmap asked for
/// symmetric shadowcasting and that turned out not to fit: shadowcasting wants
/// opacity to be a property of a *cell*, and a wall here is an arbitrary segment
/// in image pixels that the DM may have traced diagonally. Rasterizing a segment
/// into blocking cells is not a lossy version of the truth, it is a different
/// dungeon — a wall traced along a cell boundary, which is the common case, would
/// blind the cells on both sides of the line and shrink every room it encloses.
///
/// So the rule is one sentence instead: **a cell is visible when the straight
/// line from the viewer's centre to that cell's centre crosses no solid wall and
/// no shut door.** It reads the segments as they were traced, it is explicable to
/// a player who asks why they cannot see something, and it is a page of code
/// rather than three.
///
/// The radius is Euclidean, so vision is a circle. That agrees with a drawn
/// circle and disagrees with the movement ruler, where a diagonal step costs one
/// cell and "within 20 ft" is a square — the same disagreement `docs/drawings.md`
/// already names and leaves standing. A radius of light is a circle.
///
/// Cost is the product of cells swept and walls not culled, per source. Both
/// halves are bounded before the loop: walls further from the viewer than the
/// radius cannot be crossed by any of its rays and are dropped once per source
/// rather than once per cell, and the sweep is clipped to the play area.
pub fn visible_cells(map: &MapInfo, walls: &[Wall], sources: &[Px]) -> HashSet<Cell> {
    let mut seen: HashSet<Cell> = HashSet::new();
    if sources.is_empty() || map.grid_px <= 0.0 {
        return seen;
    }

    let radius_cells = (map.vision_ft / FEET_PER_CELL).max(0.0);
    let radius = radius_cells * map.grid_px;
    let reach = radius_cells.ceil() as i32;

    let blockers: Vec<(Px, Px)> = walls
        .iter()
        .filter(|wall| wall.blocks())
        .map(|wall| (wall.from, wall.to))
        .chain(boundary(map.play_area))
        .collect();

    for &source in sources {
        // Once per source, not once per ray. A dungeon is a couple of hundred
        // segments and a viewer stands within reach of a handful of them.
        let near: Vec<&(Px, Px)> = blockers
            .iter()
            .filter(|(a, b)| distance_to_segment(source, *a, *b) <= radius)
            .collect();

        let origin = cell_of(map, source);
        for dy in -reach..=reach {
            for dx in -reach..=reach {
                let cell = (origin.0 + dx, origin.1 + dy);
                // Already lit by somebody else. The party stands close together,
                // so this drops most of the work of the second torch onward.
                if seen.contains(&cell) {
                    continue;
                }
                let centre = cell_centre(map, cell);
                if hypot(centre.x - source.x, centre.y - source.y) > radius {
                    continue;
                }
                // The play-area boundary is in `blockers` as well, which is what
                // stops a viewer standing off the board seeing onto it. This is
                // the other direction: the void beyond the edge is not somewhere
                // the party explores, whatever the geometry says.
                //
                // And when there is no play area, the same question still has to
                // be answered — a token dragged to cell one million would
                // otherwise reveal cells there, and the rectangle packing them
                // alongside the dungeon is the whole map's worth of characters on
                // every send. `MAX_MAP_PX` is where the walls stop too.
                if !on_board(map.play_area, centre) {
                    continue;
                }
                if near.iter().any(|(a, b)| crosses(source, centre, *a, *b)) {
                    continue;
                }
                seen.insert(cell);
            }
        }
    }

    seen
}

/// The play area's four edges as segments, or nothing when the map has none.
///
/// The roadmap calls this the implicit wall, and it is the reason no editor
/// produces one: it is already on `MapInfo`, and a DM asked to trace the edge of
/// their own map would rightly wonder why.
fn boundary(area: Option<Rect>) -> impl Iterator<Item = (Px, Px)> {
    let corners = area.map(|r| {
        let (l, t) = (r.x, r.y);
        let (right, bottom) = (r.x + r.w, r.y + r.h);
        [
            (Px { x: l, y: t }, Px { x: right, y: t }),
            (
                Px { x: right, y: t },
                Px {
                    x: right,
                    y: bottom,
                },
            ),
            (
                Px {
                    x: right,
                    y: bottom,
                },
                Px { x: l, y: bottom },
            ),
            (Px { x: l, y: bottom }, Px { x: l, y: t }),
        ]
    });
    corners.into_iter().flatten()
}

/// Whether a point in image pixels is somewhere the party could stand.
///
/// The play area when there is one. When there is not — which is what the DM's
/// own "whole map" button leaves behind, so it is the common case rather than the
/// odd one — the image is as big as anything else in this coordinate space is
/// allowed to be, and that is the answer.
fn on_board(area: Option<Rect>, at: Px) -> bool {
    match area {
        None => at.x.abs() <= MAX_MAP_PX && at.y.abs() <= MAX_MAP_PX,
        Some(r) => at.x >= r.x && at.x <= r.x + r.w && at.y >= r.y && at.y <= r.y + r.h,
    }
}

/// The cell a point in image pixels falls in.
pub fn cell_of(map: &MapInfo, at: Px) -> Cell {
    (
        ((at.x - map.offset_x) / map.grid_px).floor() as i32,
        ((at.y - map.offset_y) / map.grid_px).floor() as i32,
    )
}

/// The middle of a cell, in image pixels — where every ray in this file points.
fn cell_centre(map: &MapInfo, cell: Cell) -> Px {
    Px {
        x: map.offset_x + (cell.0 as f32 + 0.5) * map.grid_px,
        y: map.offset_y + (cell.1 as f32 + 0.5) * map.grid_px,
    }
}

/// A position in grid units as a point in image pixels. The one conversion
/// between the two coordinate spaces on this side of the wire.
pub fn grid_to_px(map: &MapInfo, x: f32, y: f32) -> Px {
    Px {
        x: map.offset_x + x * map.grid_px,
        y: map.offset_y + y * map.grid_px,
    }
}

/// Whether segments `p→q` and `a→b` cross, for the purpose of stopping a ray.
///
/// Touching is the whole difficulty here, and it is systematic rather than rare:
/// cell centres and `snapToCorner`'d wall corners sit on the same lattice, so a
/// ray passing exactly through a wall's endpoint is the common case and not a
/// coincidence. The rule is **ties at the ray's own ends are permissive, ties in
/// the middle of it are not**, and it decides three cases:
///
/// - A viewer standing *on* a wall is not blinded by the wall they are standing
///   on, which is what happens to a creature in a doorway otherwise. That is a
///   tie at `p`.
/// - A ray *ending* exactly on a wall's endpoint slips past its tip — corner
///   peeking, which every VTT has and which errs towards showing the player
///   something. That is a tie at `q`.
/// - A wall's corner sitting exactly *across* the ray stops it. That is a tie in
///   the middle, and it is the one that used to depend on which end the ray was
///   cast from: negating a side flips a negative to positive but leaves a zero
///   reading as "not positive", so the same wall blocked sight one way along the
///   line and passed it the other. It is now the same answer both ways, which is
///   the point — a wall that stops a ray has to stop it whoever is looking.
fn crosses(p: Px, q: Px, a: Px, b: Px) -> bool {
    // The ray has to pass from one side of the wall's line to the other. `p` and
    // `q` are the only two points of the ray this test looks at, so a zero here
    // is contact at one of them — the two permissive cases above.
    let d1 = cross(a, b, p);
    let d2 = cross(a, b, q);
    if d1 == 0.0 || d2 == 0.0 || (d1 > 0.0) == (d2 > 0.0) {
        return false;
    }

    // And the wall has to span the ray. A zero here is a wall *corner* lying on
    // it, and that corner cannot be `p` or `q` — either would have returned
    // above — so it is strictly between them whenever it is between them at all.
    let d3 = cross(p, q, a);
    let d4 = cross(p, q, b);
    if d3 == 0.0 {
        return within(p, q, a);
    }
    if d4 == 0.0 {
        return within(p, q, b);
    }
    (d3 > 0.0) != (d4 > 0.0)
}

/// Whether `c`, already known to lie on the line through `p` and `q`, lies
/// between them. Collinear, so the bounding box is the whole question and there
/// is no length to divide by.
fn within(p: Px, q: Px, c: Px) -> bool {
    c.x >= p.x.min(q.x) && c.x <= p.x.max(q.x) && c.y >= p.y.min(q.y) && c.y <= p.y.max(q.y)
}

/// Which side of `a→b` the point `c` is on, by sign.
fn cross(a: Px, b: Px, c: Px) -> f32 {
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

/// Perpendicular distance from a point to a segment, clamped to its ends. The
/// same rule `walls.ts` uses to decide which segment the DM clicked; here it is
/// what culls a wall out of a viewer's reach.
fn distance_to_segment(p: Px, a: Px, b: Px) -> f32 {
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let length_squared = dx * dx + dy * dy;
    if length_squared == 0.0 {
        return hypot(p.x - a.x, p.y - a.y);
    }
    let along = ((p.x - a.x) * dx + (p.y - a.y) * dy) / length_squared;
    let t = along.clamp(0.0, 1.0);
    hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

fn hypot(x: f32, y: f32) -> f32 {
    (x * x + y * y).sqrt()
}

/// Every cell a token stands on, given that it is a square `size` cells across
/// centred on its position.
///
/// A monster is visible when *any* cell it covers is, which is why this exists at
/// all: a four-cell ogre leaning into a lit corridor is an ogre the party can
/// see, and asking only about its centre would hide half of it behind the wall it
/// is standing beside.
///
/// Anything smaller than a cell covers the cell it is in, matching `snap_to_cell`
/// — a druid who is currently a rat is standing in one square, not a quarter of
/// one.
pub fn covered_cells(x: f32, y: f32, size: f32) -> Vec<Cell> {
    let half = size.max(1.0) / 2.0;
    // A token's edges land exactly on grid lines, so `floor` and `ceil` are
    // deciding an exact tie at both ends. The nudge is what keeps a 2×2 at
    // (4.0, 4.0) covering cells 3 and 4 rather than 3, 4 and 5.
    let slack = 1e-4;
    let x0 = (x - half + slack).floor() as i32;
    let x1 = (x + half - slack).floor() as i32;
    let y0 = (y - half + slack).floor() as i32;
    let y1 = (y + half - slack).floor() as i32;

    let mut cells = Vec::new();
    for cy in y0..=y1 {
        for cx in x0..=x1 {
            cells.push((cx, cy));
        }
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::WallKind;

    fn cells(of: &[Cell]) -> HashSet<Cell> {
        of.iter().copied().collect()
    }

    #[test]
    fn an_unexplored_map_packs_to_nothing() {
        let empty = pack(&HashSet::new(), &HashSet::new());
        assert_eq!(empty, FogView::default());
        assert!(empty.cells.is_empty());
    }

    #[test]
    fn the_rectangle_is_the_bounding_box_of_what_is_explored() {
        // Not the map, not the play area. Everything outside it is dark by
        // definition, which is what lets the box shrink to the interesting part.
        let view = pack(&cells(&[(2, 1), (4, 3)]), &HashSet::new());
        assert_eq!((view.x, view.y, view.w, view.h), (2, 1, 3, 3));
    }

    #[test]
    fn the_three_states_pack_one_character_each_row_major() {
        // `visible` is a subset of `revealed` — the room unions them in that
        // order — which is what makes one character a total description.
        let view = pack(&cells(&[(0, 0), (1, 0), (1, 1)]), &cells(&[(1, 1)]));
        assert_eq!((view.w, view.h), (2, 2));
        assert_eq!(view.cells, "oo#.");
    }

    #[test]
    fn a_negative_origin_survives_the_round_trip() {
        // The party can walk off the top-left of the image, and a cell index is
        // signed for that reason.
        let explored = cells(&[(-3, -2), (-3, 4), (5, 0)]);
        assert_eq!(unpack(&pack(&explored, &HashSet::new())), explored);
    }

    #[test]
    fn both_lit_states_unpack_as_explored() {
        // The wire records where the party is standing and the file does not, so
        // `unpack` has to read either without being told which it is looking at.
        let explored = cells(&[(1, 1), (2, 1), (2, 2)]);
        let lit = cells(&[(2, 2)]);
        assert_eq!(unpack(&pack(&explored, &lit)), explored);
        assert_eq!(unpack(&pack(&explored, &HashSet::new())), explored);
    }

    #[test]
    fn a_token_covers_the_squares_its_edges_land_on() {
        // The lattice `snap_to_cell` settles onto: an odd token on a cell centre,
        // an even one on the corner four cells meet at. Both have edges exactly
        // on grid lines, so this is deciding an exact tie at both ends.
        assert_eq!(covered_cells(3.5, 3.5, 1.0), vec![(3, 3)]);
        assert_eq!(
            covered_cells(3.5, 3.5, 0.5),
            vec![(3, 3)],
            "a rat is in one square"
        );
        assert_eq!(
            covered_cells(4.0, 4.0, 2.0),
            vec![(3, 3), (4, 3), (3, 4), (4, 4)]
        );
        assert_eq!(covered_cells(4.5, 4.5, 3.0).len(), 9);
    }

    /// A map with the default grid: cell `(c, r)` centres on `(64c + 32, 64r + 32)`.
    fn map(vision_ft: f32) -> MapInfo {
        MapInfo {
            fog: true,
            vision_ft,
            ..MapInfo::default()
        }
    }

    fn masonry(x1: f32, y1: f32, x2: f32, y2: f32) -> Wall {
        Wall {
            from: Px { x: x1, y: y1 },
            to: Px { x: x2, y: y2 },
            ..Wall::default()
        }
    }

    fn at(cell: Cell) -> Px {
        Px {
            x: cell.0 as f32 * 64.0 + 32.0,
            y: cell.1 as f32 * 64.0 + 32.0,
        }
    }

    #[test]
    fn sight_reaches_exactly_as_far_as_the_radius_and_is_a_circle() {
        // Euclidean, so a radius of light is a circle — agreeing with a drawn
        // circle and disagreeing with the movement ruler, where a diagonal step
        // costs one cell. `docs/drawings.md` already names that disagreement.
        let seen = visible_cells(&map(30.0), &[], &[at((0, 0))]);
        assert!(seen.contains(&(6, 0)), "six cells due east is thirty feet");
        assert!(!seen.contains(&(7, 0)), "and seven is not");
        assert!(
            !seen.contains(&(6, 6)),
            "a square would reach the corner; a circle does not"
        );
    }

    #[test]
    fn masonry_stops_a_ray_and_an_open_door_does_not() {
        let map = map(60.0);
        let solid = masonry(256.0, 0.0, 256.0, 256.0);
        let mut open = solid.clone();
        open.kind = WallKind::Door(true);
        let mut shut = solid.clone();
        shut.kind = WallKind::Door(false);

        for (name, wall, expected) in [
            ("masonry", solid, false),
            ("a shut door", shut, false),
            ("an open door", open, true),
        ] {
            let seen = visible_cells(&map, &[wall], &[at((1, 1))]);
            assert_eq!(
                seen.contains(&(5, 1)),
                expected,
                "{name} should {} sight",
                if expected { "pass" } else { "stop" }
            );
        }
    }

    #[test]
    fn a_viewer_standing_on_a_wall_is_not_blinded_by_it() {
        // A tie at `p`, and permissive. Otherwise a creature in a doorway can
        // see nothing at all, which is where they most want to.
        //
        // Their own square is not enough to assert: it passed while the wall
        // still blinded them westward and not eastward, because a zero side
        // reads as "not positive" and negating the other side flipped it.
        let seen = visible_cells(
            &map(60.0),
            &[masonry(96.0, 0.0, 96.0, 256.0)],
            &[at((1, 1))],
        );
        assert!(seen.contains(&(1, 1)), "their own square");
        assert!(seen.contains(&(3, 1)), "and both ways along the wall");
        assert!(seen.contains(&(-1, 1)), "not just the one the sign favoured");
    }

    #[test]
    fn a_wall_corner_on_the_ray_stops_it_whichever_end_is_looking() {
        // The lattice makes this systematic: cell centres and snapped wall
        // corners are on the same grid, so a ray straight through a wall's
        // endpoint is the common case. It used to depend on the direction of
        // travel — one of these two saw the other and was not seen back.
        let wall = [masonry(128.0, 128.0, 128.0, 320.0)];
        let corner = map(60.0);

        let from_above = visible_cells(&corner, &wall, &[at((0, 0))]);
        let from_below = visible_cells(&corner, &wall, &[at((3, 3))]);
        assert!(!from_above.contains(&(3, 3)));
        assert!(!from_below.contains(&(0, 0)), "and not the other way either");
    }

    #[test]
    fn a_ray_ending_on_a_wall_tip_slips_past_it() {
        // A tie at `q`, and permissive: corner peeking, which errs towards
        // showing the player something. The wall's tip is cell (1, 1)'s centre,
        // so the ray to that cell ends exactly on it.
        let seen = visible_cells(
            &map(60.0),
            &[masonry(96.0, 96.0, 96.0, 320.0)],
            &[at((-1, -1))],
        );
        assert!(seen.contains(&(1, 1)));
    }

    #[test]
    fn no_torches_light_nothing() {
        assert!(visible_cells(&map(60.0), &[], &[]).is_empty());
    }
}

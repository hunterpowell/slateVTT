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
//! space the walls live in.
//!
//! The one exception is the **radius**, which is set in feet and is therefore a
//! whole number of cells: the sweeps take their sources in grid units and measure
//! the reach there, because the cells sitting exactly on the circle are a tie and
//! scaling that tie into pixels answers it differently on each side. See *The
//! radius is measured in cells* in `docs/fog.md`.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::protocol::{GridShape, Lighting, MapInfo, Pos, Px, Rect, ShapeKind, Wall};
use crate::room::{MAX_MAP_PX, MAX_SHAPE_CELLS};

/// A cell of the grid, by its integer coordinates. The cell a token at
/// `(3.5, 3.5)` stands in is `(3, 3)`.
///
/// A tuple rather than a struct, unlike `Pos` and `Px`: it is an index into a
/// lattice rather than a position on the board, and it wants to be a `HashSet`
/// key, which is one derive instead of four.
///
/// **Outbound it is never serialized as itself — `FogView` packs a whole
/// rectangle of them into one string. Inbound it is**: `SetFogOverride` carries
/// `Vec<Cell>`, one `[x,y]` pair per cell, because the DM's client computes the
/// fill to preview it and the preview and the result have to be the same array.
/// This comment used to claim the packing held in both directions, which is how
/// `MAX_OVERRIDE_CELLS` came to be 25× what a frame could hold.
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

/// One thing that lights the board, and how far it reaches.
///
/// Grid units like `Pos` and unlike the walls, for the reason `visible_cells`
/// gives at length: the radius is compared in cells because the four cells at
/// exactly that distance are a tie, and scaling a tie into pixels answers it
/// differently on each side.
///
/// **`radius_ft` is `None` for "as far as this map lets anyone see"** — which
/// is what every source in this file was before milestone 39 put a lantern on a
/// token. Keeping that fallback here rather than at the call sites is what lets
/// `room.rs` hand over `token.light_ft` unchanged for a party member and for a
/// brazier alike: the `?? vision_ft` rule exists once, in `radius_cells`.
#[derive(Debug, Clone, Copy)]
pub struct Source {
    pub at: Pos,
    pub radius_ft: Option<f32>,
}

impl Source {
    /// The reach of this source, in cells, which is the space it is compared in.
    fn radius_cells(&self, map: &MapInfo) -> f32 {
        (self.radius_ft.unwrap_or(map.vision_ft) / FEET_PER_CELL).max(0.0)
    }
}

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

/// No override on this cell — sight decides it. The hole in an `OverrideView`,
/// and the only one of the four that is never stored: `Auto` is the *absence* of
/// an entry in the map, so "not overridden" has one representation rather than
/// two that could disagree.
const AUTO: char = '-';
/// Forced explored, whatever the rays say. Terrain the DM handed over.
const FORCED_KNOWN: char = 'o';
/// Forced in sight, which shows the creatures standing there as well.
const FORCED_SEEN: char = '*';
/// Forced dark, which is the one that takes something away.
const FORCED_DARK: char = '#';

/// A rectangle of cells packed one character each, row-major, rather than a JSON
/// array of per-cell values: the wire protocol asks for frames a human can read
/// in devtools, and a few thousand numbers is not one. A few thousand characters
/// laid out as a map *is* — the shape of the dungeon is legible in the string.
///
/// Two things are packed this way and they are named separately below, because
/// what a character *means* differs and the audiences are opposites. The encoding
/// is one thing and lives here; which alphabet a given rectangle is written in is
/// a fact about the field carrying it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct CellRect {
    /// Cell coordinates of the top-left of the packed rectangle.
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
    /// `w * h` characters, row-major.
    pub cells: String,
}

/// The fog as it goes on the wire, and as it goes to disk.
///
/// The rectangle is the bounding box of everything the party has revealed, so an
/// unexplored map packs to nothing at all. **Every cell outside it is `DARK`**,
/// which is what lets the box shrink to the interesting part instead of covering
/// the image.
///
/// `None` in place of one of these means the map is not fogged — and, like
/// `staged` being `None`, it is the only thing the server could mean by it.
///
/// The same value reaches every recipient, which is the opposite of the type one
/// line down: the geometry is the secret, and this is the shadow it casts.
pub type FogView = CellRect;

/// The DM's manual override, packed the same way and reaching the DM alone.
///
/// `#` forced dark, `o` forced explored, `*` forced in sight, `-` no override.
/// The rectangle is the bounding box of the overridden cells, so a map nobody has
/// painted on packs to nothing — and an empty one is therefore both "nothing
/// overridden" and "you are not the DM", exactly as an empty wall list is.
///
/// A `Vec<(Cell, Override)>` would be the obvious shape and is the wrong one: a
/// flood fill is thousands of cells, and thousands of JSON pairs is the frame
/// `FogView` exists to avoid.
pub type OverrideView = CellRect;

/// What the DM has said about a cell, overriding what the rays say.
///
/// Three variants and not four: `Auto` is the absence of an entry, so a cell set
/// back to it is removed rather than stored. Independent of line of sight by
/// construction — writing into `revealed` instead would evaporate the next time
/// a torch reached the cell, which is the whole reason this is its own state.
///
/// **`Explored` and `Lit` are floors and `Dark` is a ceiling**, which is what
/// makes the application in `recompute_sight` order-independent and total.
/// `Explored` does not demote a cell the rays already lit; "show the room but not
/// the ambush in it" is what `hidden` is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Override {
    /// At least explored: the ground, remembered, without the creatures on it.
    Explored,
    /// At least in sight, which shows whatever is standing there.
    Lit,
    /// Dark whatever the rays say, and it takes the memory with it.
    Dark,
}

impl Override {
    fn glyph(self) -> char {
        match self {
            Self::Explored => FORCED_KNOWN,
            Self::Lit => FORCED_SEEN,
            Self::Dark => FORCED_DARK,
        }
    }

    fn from_glyph(c: char) -> Option<Self> {
        match c {
            FORCED_KNOWN => Some(Self::Explored),
            FORCED_SEEN => Some(Self::Lit),
            FORCED_DARK => Some(Self::Dark),
            _ => None,
        }
    }
}

/// Packs two cell sets into one rectangle of characters.
///
/// One character carries both facts because `visible` is a subset of `revealed`
/// — seeing a cell reveals it, and the room unions them in that order — so the
/// three states are a total description and no cell needs two fields.
pub fn pack(revealed: &HashSet<Cell>, visible: &HashSet<Cell>) -> FogView {
    pack_by(revealed.iter().copied(), |cell| {
        if visible.contains(&cell) {
            SEEN
        } else if revealed.contains(&cell) {
            KNOWN
        } else {
            DARK
        }
    })
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
    for (cell, c) in walk(view) {
        if c != DARK {
            revealed.insert(cell);
        }
    }
    revealed
}

/// Packs the DM's overrides, bounded by the cells they have actually painted.
pub fn pack_overrides(overrides: &HashMap<Cell, Override>) -> OverrideView {
    pack_by(overrides.keys().copied(), |cell| {
        overrides.get(&cell).map_or(AUTO, |o| o.glyph())
    })
}

/// The overrides back out, for a room coming off disk. Unlike the fog beside it
/// this is restored whole: it is what the DM said, not what the rays found, and
/// nothing in the room can derive it.
pub fn unpack_overrides(view: &OverrideView) -> HashMap<Cell, Override> {
    walk(view)
        .filter_map(|(cell, c)| Override::from_glyph(c).map(|o| (cell, o)))
        .collect()
}

/// Packs whatever `char_at` says about every cell in the bounding box of
/// `within`. The one place the row-major layout is written down.
fn pack_by(within: impl Iterator<Item = Cell>, char_at: impl Fn(Cell) -> char) -> CellRect {
    let Some((x0, y0, x1, y1)) = bounds(within) else {
        return CellRect::default();
    };

    let w = x1.abs_diff(x0) + 1;
    let h = y1.abs_diff(y0) + 1;
    if w > MAX_FOG_SIDE || h > MAX_FOG_SIDE {
        return CellRect::default();
    }

    let mut cells = String::with_capacity((w * h) as usize);
    for y in y0..=y1 {
        for x in x0..=x1 {
            cells.push(char_at((x, y)));
        }
    }

    CellRect {
        x: x0,
        y: y0,
        w,
        h,
        cells,
    }
}

/// Every cell of a packed rectangle with the character that describes it.
///
/// A `w` that disagrees with the string is a damaged file rather than a schema
/// change, and `chars().nth()` per cell would be quadratic. Walking the
/// characters in order and deriving the row is total either way.
fn walk(view: &CellRect) -> impl Iterator<Item = (Cell, char)> + '_ {
    view.cells
        .chars()
        .enumerate()
        .filter(|_| view.w != 0)
        .map(|(i, c)| {
            let i = i as u32;
            (
                (view.x + (i % view.w) as i32, view.y + (i / view.w) as i32),
                c,
            )
        })
}

/// The smallest box containing every cell, or `None` for an empty set.
fn bounds(cells: impl Iterator<Item = Cell>) -> Option<(i32, i32, i32, i32)> {
    let mut cells = cells;
    let (mut x0, mut y0) = cells.next()?;
    let (mut x1, mut y1) = (x0, y0);
    for (x, y) in cells {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    Some((x0, y0, x1, y1))
}

/// Every cell at least one of `sources` has line of sight on — `Lighting::Dynamic`,
/// and what every map did before there were two modes.
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
/// **And it is measured in cells, which is why `sources` is grid units where
/// every other coordinate in this file is pixels.** A radius set in feet is a
/// whole number of cells, so the four cells at exactly that distance sit exactly
/// on the circle — a tie, like the wall-corner ones `crosses` settles. Measured
/// in pixels the two sides of that tie round differently and the circle loses a
/// cell off one edge and keeps it on the other; in cells the arithmetic is exact
/// and both sides answer together. See *A tie is answered the same way from both
/// ends* in `docs/fog.md`.
///
/// Cost is the product of cells swept and walls not culled, per source. Both
/// halves are bounded before the loop: walls further from the viewer than the
/// radius cannot be crossed by any of its rays and are dropped once per source
/// rather than once per cell, and the sweep is clipped to the play area.
pub fn visible_cells(map: &MapInfo, walls: &[Wall], sources: &[Source]) -> HashSet<Cell> {
    let mut seen: HashSet<Cell> = HashSet::new();
    if sources.is_empty() || map.grid_px <= 0.0 {
        return seen;
    }

    let blockers: Vec<(Px, Px)> = walls
        .iter()
        .filter(|wall| wall.blocks())
        .map(|wall| (wall.from, wall.to))
        .chain(boundary(map.play_area))
        .collect();

    for src in sources {
        // Each source brings its own reach since milestone 39, which is why this
        // sits inside the loop where it used to sit above it. A source naming no
        // radius takes the map's — see `Source`.
        let eye = src.at;
        let radius_cells = src.radius_cells(map);
        let radius = radius_cells * px_per_cell(map);
        let reach = radius_cells.ceil() as i32;

        // The rays are cast in pixels because that is the space the walls live
        // in; the radius is checked in cells, where it is exact.
        let source = grid_to_px(map, eye.x, eye.y);
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
                if hypot(cell.0 as f32 + 0.5 - eye.x, cell.1 as f32 + 0.5 - eye.y) > radius_cells {
                    continue;
                }
                let centre = cell_centre(map, cell);
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

/// Every cell the party can see, by whichever question this map asks.
///
/// The one place the mode is read, so `recompute_sight` stays a single call and
/// neither implementation has to know the other exists.
///
/// ```text
/// Dynamic   rays
/// Room      flood ∪ rays
/// ```
///
/// **`Room` is a union and not a replacement**, which is the correction milestone
/// 21 needed after a session on a real dungeon. One sentence for the DM: *you see
/// the whole room you are standing in, plus whatever you have a straight line to.*
/// It can never show less than `Dynamic` would, and it is what makes a doorway
/// carry **sight** rather than light — see `lit_cells`, which stops at every
/// segment the DM traced, open or shut.
pub fn sight_cells(map: &MapInfo, walls: &[Wall], sources: &[Source]) -> HashSet<Cell> {
    match map.lighting {
        Lighting::Dynamic => visible_cells(map, walls, sources),
        Lighting::Room => {
            let mut lit = lit_cells(map, walls, sources);
            lit.extend(visible_cells(map, walls, sources));
            lit
        }
    }
}

/// Whether any of `eyes` has a clear straight line to `at`, **at any distance**.
///
/// The gate on a light nobody is carrying, and milestone 39's whole answer to the
/// question that would otherwise sink the feature: a brazier the DM placed while
/// preparing a dungeon must not light a room the party cannot see, or promoting
/// that map hands over every lit chamber on the level at once. `visible` is one
/// flat union of its sources with no "and somebody can see it" term in it, so the
/// term has to be applied to the source list before the sweep runs.
///
/// **It is deliberately not `visible_cells` narrowed to one cell, and the
/// difference is the point.** This asks about the geometry and never about a
/// radius: vision set at thirty feet and a brazier at forty is a brazier the party
/// can plainly see, so gating on their reach would answer a question nobody asked.
/// It is why there is no wall cull here — a cull is bounded by a radius, and
/// there is none. It is also what makes this cheap: a segment test per eye, where
/// gating on `visible` would have been a second sweep.
///
/// The same blockers the rays stop at, so an open door carries this exactly as it
/// carries sight, and `crosses`'s permissive end ties come with it: a light traced
/// onto a wall's corner activates rather than sitting dark against its own masonry.
pub fn in_line_of_sight(map: &MapInfo, walls: &[Wall], eyes: &[Source], at: Pos) -> bool {
    if eyes.is_empty() || map.grid_px <= 0.0 {
        return false;
    }

    let target = grid_to_px(map, at.x, at.y);
    // A light off the edge of the board lights nothing, which is the bound the
    // sweeps clip to. The boundary is among the blockers as well, and that
    // answers the other direction; this is for a party standing off the board.
    if !on_board(map.play_area, target) {
        return false;
    }

    let blockers: Vec<(Px, Px)> = walls
        .iter()
        .filter(|wall| wall.blocks())
        .map(|wall| (wall.from, wall.to))
        .chain(boundary(map.play_area))
        .collect();

    eyes.iter().any(|eye| {
        let from = grid_to_px(map, eye.at.x, eye.at.y);
        !blockers.iter().any(|(a, b)| crosses(from, target, *a, *b))
    })
}

/// Every cell reachable on foot from one of `sources` without crossing anything
/// the DM traced, out to the radius — half of `Lighting::Room`, the other half
/// being the rays `sight_cells` unions in.
///
/// **Connectivity rather than the raycast written twice.** A cell is lit when a
/// four-neighbour walk reaches it, which is what makes a room light as a room:
/// the party steps into a chamber and it arrives whole rather than in the wedge
/// their torches happen to point at.
///
/// **Every traced segment bounds it, open or shut, and that is `fillFrom`'s rule
/// in `overrides.ts` rather than the raycast's.** It shipped the other way round
/// and one session put it right: reading `blocks()` here makes an open door a hole
/// in the room boundary, so a one-cell hallway hands over the whole chamber past
/// it and the only marker that bounds a room is a shut door the DM has to swing by
/// hand. So an archway is traced as a door left open — the idiom the DM already
/// holds for the reveal tool, arriving where it was missing.
///
/// What an open door does instead is pass **sight**: the rays run alongside this
/// and stop at `blocks()`, so the party gets the wedge they can see through the
/// doorway rather than the room behind it. Only sight reads a door's state now,
/// which is one rule fewer than the two this file used to carry.
///
/// It is therefore the same *question* `fillFrom` asks, in a second language, and
/// the duplication stays deliberate for `shape_covers`'s reason: that one previews
/// what the DM is about to paint, this one decides what the party is handed, and a
/// disagreement at the fringe changes a preview rather than a permission.
///
/// **The radius bounds it as well as the walls**, and that is not a detail. A pure
/// fill does not respect corners: walk into a winding corridor and the whole of it
/// lights to its far end, around every bend. Euclidean from the source, like the
/// raycast's — so the number means the same thing in both modes rather than dying
/// in one, and a hall bigger than the radius is a map whose radius should be
/// raised rather than a reason for a second number.
///
/// One fill per source, unioned, **and deliberately not one sweep sharing a
/// visited set**. The raycast may short-circuit on a cell another torch already
/// lit because its rays are independent; here skipping such a cell would stop this
/// source expanding *through* it, and a fill that never enters the corridor never
/// reaches the room past it.
pub fn lit_cells(map: &MapInfo, walls: &[Wall], sources: &[Source]) -> HashSet<Cell> {
    let mut lit: HashSet<Cell> = HashSet::new();
    if sources.is_empty() || map.grid_px <= 0.0 {
        return lit;
    }

    // Every segment, unlike the raycast's list one function up: a door bounds a
    // room whatever it is swung to, and what an open one passes is sight.
    let blockers: Vec<(Px, Px)> = walls
        .iter()
        .map(|wall| (wall.from, wall.to))
        .chain(boundary(map.play_area))
        .collect();

    for src in sources {
        // In cells for the step test and in pixels for the wall cull, which is
        // the raycast's split and is there for its reason. Per source, as the
        // raycast takes it, since milestone 39.
        let eye = src.at;
        let radius_cells = src.radius_cells(map);
        let radius = radius_cells * px_per_cell(map);

        let source = grid_to_px(map, eye.x, eye.y);
        // Once per source, as the raycast does it. The margin is the half cell
        // between a token's position and the centre of the square it stands in:
        // every step this fill tests runs between two centres within the radius,
        // except the first, which starts from wherever the token happens to be.
        let near: Vec<&(Px, Px)> = blockers
            .iter()
            .filter(|(a, b)| distance_to_segment(source, *a, *b) <= radius + px_per_cell(map))
            .collect();

        let start = cell_of(map, source);
        if !cell_on_board(map, start) {
            continue;
        }

        let mut seen: HashSet<Cell> = HashSet::from([start]);
        let mut queue: Vec<Cell> = vec![start];
        while let Some(cell) = queue.pop() {
            lit.insert(cell);
            let from = cell_centre(map, cell);
            // A cell a wall runs *through* is taken by whichever fill reached it
            // and expanded out of by none — `cutByWall` in `overrides.ts`, whose
            // rule this now matches segment for segment. Corner-snapped masonry
            // cannot produce such a cell, but a wall at 45 degrees hits a centre
            // every other cell and a chamfered room corner is made of exactly
            // those: without this the fill walks in one side and out of the
            // other, and one such cell hands the table the whole map.
            //
            // The seed is not special-cased, for the same reason it is not there:
            // letting it expand would put both sides of the wall in one fill. A
            // token standing inside masonry lights the square it is standing in,
            // which is visibly wrong in a way the DM will go and fix.
            if cut_by_wall(&near, from) {
                continue;
            }
            for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
                let to = (cell.0 + dx, cell.1 + dy);
                if seen.contains(&to) {
                    continue;
                }
                if hypot(to.0 as f32 + 0.5 - eye.x, to.1 as f32 + 0.5 - eye.y) > radius_cells {
                    continue;
                }
                let at = cell_centre(map, to);
                // The same two bounds the raycast takes, and for the same
                // reasons: the void off the edge is not somewhere the party
                // explores, and a cell out there sits in the packed rectangle
                // from then on.
                if !on_board(map.play_area, at) {
                    continue;
                }
                if near.iter().any(|(a, b)| crosses(from, at, *a, *b)) {
                    continue;
                }
                seen.insert(to);
                queue.push(to);
            }
        }
    }

    lit
}

/// Whether a traced segment runs straight through a cell's centre.
///
/// Asked of everything in `near`, doors included and whatever they are swung to —
/// the same list the steps are tested against, so a cell the fill may not leave is
/// decided by the same geometry that decided it may not step across.
fn cut_by_wall(near: &[&(Px, Px)], centre: Px) -> bool {
    near.iter()
        .any(|(a, b)| cross(*a, *b, centre) == 0.0 && within(*a, *b, centre))
}

/// A cell set with the ring of cells touching it added — the party's memory
/// widened by one square in every direction.
///
/// **What this is for is the masonry.** `snapToCorner` puts a traced wall on the
/// corner lattice, so it runs *between* cell centres and the last cell a ray
/// reaches is the floor square inside the room. If the DM traced along the inner
/// face of the wall — the natural way to trace one — the drawn wall itself is
/// past that cell and the table is shown floor, then nothing. Rooms read as
/// holes rather than as rooms. One cell of fringe puts the wall on their board.
///
/// **It is a set operation and knows nothing about walls**, so the fringe lands
/// in every direction and not only across masonry: one cell further down an open
/// corridor as well, which is `vision_ft` plus a square for terrain. That reads
/// as the corridor ahead fading rather than cutting, and asking the raycast
/// which cells it was *blocked* into instead would be a different return type
/// for a picture nobody would tell apart.
///
/// Only `known` is built through this — never `visible`, which gates the
/// creatures, and never `revealed`, which is memory and is rays only. The set is
/// a superset of its input **by construction**: the cell itself goes in before
/// the board is consulted, so `visible ⊆ known` cannot depend on where some other
/// bound happened to clip. The ring is clipped, because the void off the edge of
/// the map is not somewhere the party explores and a fringe there is a cell in
/// the packed rectangle.
///
/// Eight neighbours and not four: a four-neighbour ring leaves a notch bitten out
/// of every room corner, which is more visible than the thing this fixes.
pub fn with_fringe(map: &MapInfo, cells: &HashSet<Cell>) -> HashSet<Cell> {
    let mut out: HashSet<Cell> = HashSet::with_capacity(cells.len() * 2);
    for &(x, y) in cells {
        out.insert((x, y));
        for dy in -1..=1 {
            for dx in -1..=1 {
                let cell = (x + dx, y + dy);
                if cell_on_board(map, cell) {
                    out.insert(cell);
                }
            }
        }
    }
    out
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

/// Whether a cell is one the party could stand in — asked of the DM's overrides
/// before any of them are stored.
///
/// The same bound the sweep above clips itself to, and needed for the same
/// reason: an override on cell one million puts that cell in the bounding box of
/// `pack_overrides`, and the rectangle spanning it and the dungeon is the whole
/// map's worth of characters on every send. A client bug is enough to do it.
pub fn cell_on_board(map: &MapInfo, cell: Cell) -> bool {
    on_board(map.play_area, cell_centre(map, cell))
}

/// The two cell axes in image pixels: where `(1, 0)` and `(0, 1)` land.
///
/// **The one place `GridShape` is read on this side of the wire.** An isometric
/// grid is an affine image of a square one, so every question below goes on being
/// asked of a lattice and none of them learns there is more than one shape — the
/// same discipline `sight_cells` keeps over `Lighting`. `gridBasis` in
/// `client/src/scene.ts` is its twin and must agree with it exactly.
///
/// The square case is `((grid_px, 0), (0, grid_px))`, which reduces the three
/// conversions below to the arithmetic they held before there was a basis. That
/// is the argument that a board saved as squares is untouched by any of this.
fn basis(map: &MapInfo) -> (Px, Px) {
    match map.grid_shape {
        GridShape::Square => (
            Px {
                x: map.grid_px,
                y: 0.0,
            },
            Px {
                x: 0.0,
                y: map.grid_px,
            },
        ),
        // A diamond `grid_px` tall and `grid_px * ratio` wide, so the two axes
        // run to its right-hand and left-hand corners. Mirrored about vertical
        // rather than free, which is what makes one dragged edge enough to
        // calibrate one — see `docs/maps.md`.
        GridShape::Iso { ratio } => {
            let half_w = map.grid_px * ratio / 2.0;
            let half_h = map.grid_px / 2.0;
            (
                Px {
                    x: half_w,
                    y: half_h,
                },
                Px {
                    x: -half_w,
                    y: half_h,
                },
            )
        }
    }
}

/// How far one cell of grid distance can reach in image pixels.
///
/// The largest singular value of the basis, which is exactly the number the wall
/// culls below want: a ray of `n` cells cannot travel further than `n * scale`
/// pixels, whichever direction it is cast. On a square grid it is `grid_px`, so
/// the culls drop exactly the walls they always did.
///
/// Not `|u| + |v|`, which is also safe and is looser — on a square grid that
/// would be `2 * grid_px` and would quietly halve the culling on every map in
/// the project.
fn px_per_cell(map: &MapInfo) -> f32 {
    let (u, v) = basis(map);
    let frobenius = u.x * u.x + u.y * u.y + v.x * v.x + v.y * v.y;
    let det = (u.x * v.y - u.y * v.x).abs();
    // `frobenius^2 - 4*det^2` is zero for a square grid and non-negative for any
    // basis; `max(0.0)` is float slop rather than a real case.
    ((frobenius + (frobenius * frobenius - 4.0 * det * det).max(0.0).sqrt()) / 2.0).sqrt()
}

/// The cell a point in image pixels falls in.
pub fn cell_of(map: &MapInfo, at: Px) -> Cell {
    let (u, v) = basis(map);
    let det = u.x * v.y - u.y * v.x;
    // Non-zero: `grid_px` is bounded away from zero and so is an isometric
    // ratio, which is what `check` refuses a degenerate lattice for.
    if det == 0.0 {
        return (0, 0);
    }
    let dx = at.x - map.offset_x;
    let dy = at.y - map.offset_y;
    (
        ((dx * v.y - dy * v.x) / det).floor() as i32,
        ((dy * u.x - dx * u.y) / det).floor() as i32,
    )
}

/// The middle of a cell, in image pixels — where every ray in this file points.
fn cell_centre(map: &MapInfo, cell: Cell) -> Px {
    grid_to_px(map, cell.0 as f32 + 0.5, cell.1 as f32 + 0.5)
}

/// A position in grid units as a point in image pixels. The one conversion
/// between the two coordinate spaces on this side of the wire.
pub fn grid_to_px(map: &MapInfo, x: f32, y: f32) -> Px {
    let (u, v) = basis(map);
    Px {
        x: map.offset_x + x * u.x + y * v.x,
        y: map.offset_y + x * u.y + y * v.y,
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

/// Half the angle at a cone's apex, as a slope and a cosine — `atan(0.5)`, which
/// makes a wedge exactly as wide at its far end as it is long. `shapes.ts` says
/// the same thing; see `shape_covers` for why it is said twice.
const CONE_SLOPE: f32 = 0.5;
/// `cos(atan(0.5))`, written out because `f32::cos` is not a `const fn`.
const CONE_COS: f32 = 0.894_427_2;
/// How far outside a shape a cell centre may sit and still count as covered, in
/// cells. Matches `COVERAGE_SLACK` in `shapes.ts`, and for the reason named
/// there: a cone is narrow near its apex, and the squares plainly in front of it
/// were the ones falling out.
const COVERAGE_SLACK: f32 = 0.15;

/// Whether any cell this shape covers is one of `cells`.
///
/// **All-or-nothing.** A shape is sent whole or withheld whole, so this asks for
/// one cell rather than narrowing the geometry — drawing the rest under the fog
/// overlay would put it on the client, which is what invariant 4 forbids.
///
/// This is the same rule `coveredCells` applies in `shapes.ts`, written a second
/// time in a second language, and that duplication is deliberate rather than
/// unfortunate. The filter has to run where the decision is made, and the client
/// has to run it to tint the cells it draws. **The two only have to agree
/// loosely**: a disagreement at the fringe changes whether a frame is sent, never
/// how it draws, because the client draws exactly what it is given.
///
/// Walks the shape's bounding box rather than `cells`, which is what keeps the
/// cost proportional to the shape instead of to how much dungeon the party has
/// explored. The box is clipped to the largest shape `check` will accept, so a
/// hand-edited save cannot turn one drawing into a sweep of the whole lattice.
pub fn shape_covers(kind: ShapeKind, origin: Pos, to: Pos, cells: &HashSet<Cell>) -> bool {
    if cells.is_empty() {
        return false;
    }

    // A line encloses nothing, so `contains_point` is false everywhere on it and
    // the box below would find nothing at all. What a line covers is the ground
    // it is drawn across, which is a walk rather than a test.
    if matches!(kind, ShapeKind::Line) {
        return line_cells(origin, to).any(|cell| cells.contains(&cell));
    }

    let reach = match kind {
        ShapeKind::Rect => (to.x.abs(), to.y.abs()),
        _ => {
            let r = hypot(to.x, to.y);
            (r, r)
        }
    };
    let clip = |v: f32| v.min(MAX_SHAPE_CELLS) + COVERAGE_SLACK;
    let (rx, ry) = (clip(reach.0), clip(reach.1));

    let x0 = (origin.x - rx).floor() as i32;
    let x1 = (origin.x + rx).ceil() as i32;
    let y0 = (origin.y - ry).floor() as i32;
    let y1 = (origin.y + ry).ceil() as i32;

    for cy in y0..=y1 {
        for cx in x0..=x1 {
            // The hash lookup first: it is the cheaper of the two questions, and
            // it skips the geometry for every cell the party has never seen.
            if cells.contains(&(cx, cy))
                && contains_point(kind, origin, to, cx as f32 + 0.5, cy as f32 + 0.5)
            {
                return true;
            }
        }
    }
    false
}

/// The cells a line is drawn across, from its origin to its far point.
///
/// Sampled at half a cell rather than walked with Bresenham: the step cannot skip
/// a cell it passes through, the count is bounded by the same cap the areas are,
/// and it is four lines instead of twenty. Duplicates are fine — the caller is
/// asking whether *any* of them is somewhere, not counting them.
fn line_cells(origin: Pos, to: Pos) -> impl Iterator<Item = Cell> {
    let length = hypot(to.x, to.y).min(MAX_SHAPE_CELLS);
    let steps = (length * 2.0).ceil().max(1.0) as i32;
    (0..=steps).map(move |i| {
        let t = i as f32 / steps as f32;
        (
            (origin.x + to.x * t).floor() as i32,
            (origin.y + to.y * t).floor() as i32,
        )
    })
}

/// Whether a point in grid units falls inside a shape, grown by `COVERAGE_SLACK`.
///
/// The port of `containsPoint` in `shapes.ts`, cone test and all: resolved along
/// the wedge's own axis rather than into an angle, so a cone pointing due west
/// cannot trip over the discontinuity two `atan2` results have.
fn contains_point(kind: ShapeKind, origin: Pos, to: Pos, px: f32, py: f32) -> bool {
    let dx = px - origin.x;
    let dy = py - origin.y;

    match kind {
        ShapeKind::Line => false,
        ShapeKind::Circle => hypot(dx, dy) <= hypot(to.x, to.y) + COVERAGE_SLACK,
        ShapeKind::Rect => {
            let (lo_x, hi_x) = (
                to.x.min(0.0) - COVERAGE_SLACK,
                to.x.max(0.0) + COVERAGE_SLACK,
            );
            let (lo_y, hi_y) = (
                to.y.min(0.0) - COVERAGE_SLACK,
                to.y.max(0.0) + COVERAGE_SLACK,
            );
            dx >= lo_x && dx <= hi_x && dy >= lo_y && dy <= hi_y
        }
        ShapeKind::Cone => {
            let length = hypot(to.x, to.y);
            if length == 0.0 || hypot(dx, dy) > length + COVERAGE_SLACK {
                return false;
            }
            let (ux, uy) = (to.x / length, to.y / length);
            let along = dx * ux + dy * uy;
            let perp = (dx * uy - dy * ux).abs();
            // The wedge as a perpendicular *distance* to its edge rather than as
            // an angle, which is what a slack measured in cells can be compared
            // against — and it is the same test at the apex as at the tip.
            (perp - along * CONE_SLOPE) * CONE_COS <= COVERAGE_SLACK
        }
    }
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

    // The lattice itself. Everything below this point asks questions *of* a
    // grid; these four ask what a grid is, which is the only thing an isometric
    // map changed on this side of the wire.

    /// A map whose cells are diamonds `grid_px` tall and `grid_px * ratio` wide.
    fn iso_map(grid_px: f32, ratio: f32) -> MapInfo {
        MapInfo {
            grid_px,
            grid_shape: GridShape::Iso { ratio },
            ..MapInfo::default()
        }
    }

    #[test]
    fn a_square_basis_is_the_arithmetic_it_replaced() {
        // The whole argument that no existing board moved. `grid_to_px` used to
        // be `offset + n * grid_px` written out; if the basis does not reduce to
        // exactly that, every token on every saved map is somewhere new.
        let map = MapInfo {
            grid_px: 70.0,
            offset_x: 3.0,
            offset_y: -4.0,
            ..MapInfo::default()
        };
        for (x, y) in [(0.0, 0.0), (3.5, 12.5), (-2.0, 7.25)] {
            let at = grid_to_px(&map, x, y);
            assert_eq!((at.x, at.y), (3.0 + x * 70.0, -4.0 + y * 70.0));
        }
        assert_eq!(
            px_per_cell(&map),
            70.0,
            "a square cell reaches exactly grid_px, or the wall culls tighten or slacken"
        );
    }

    #[test]
    fn an_isometric_cell_is_as_wide_as_its_ratio_and_as_tall_as_grid_px() {
        // A diamond with its corners on the axes: one cell along `x` goes right
        // and down by half of each, and one along `y` goes left and down.
        let map = iso_map(64.0, 2.0);
        let origin = grid_to_px(&map, 0.0, 0.0);
        let right = grid_to_px(&map, 1.0, 0.0);
        let left = grid_to_px(&map, 0.0, 1.0);
        assert_eq!((right.x - origin.x, right.y - origin.y), (64.0, 32.0));
        assert_eq!((left.x - origin.x, left.y - origin.y), (-64.0, 32.0));

        // The diamond the two axes span: 128 across and 64 down, which is what
        // "twice as wide as it is tall" has to mean for the DM's dragged edge.
        let far = grid_to_px(&map, 1.0, 1.0);
        assert_eq!((far.x - origin.x, far.y - origin.y), (0.0, 64.0));
    }

    #[test]
    fn a_point_and_the_cell_it_falls_in_agree_on_an_isometric_grid() {
        // `cell_of` is `grid_to_px` inverted and floored, and it is the pair the
        // raycast leans on twice per ray. An inverse that is subtly wrong shows
        // up as fog one cell out, which is hard to see and easy to ship.
        let map = iso_map(48.0, 2.0);
        for cell in [(0, 0), (3, 1), (-2, 5), (7, -4)] {
            let centre = grid_to_px(&map, cell.0 as f32 + 0.5, cell.1 as f32 + 0.5);
            assert_eq!(cell_of(&map, centre), cell, "the centre of {cell:?}");
        }
    }

    #[test]
    fn nothing_reaches_further_than_a_cell_can() {
        // `px_per_cell` bounds the wall culls, so it has to be at least as long
        // as the longest a cell's worth of grid distance can draw in pixels. Both
        // diagonals of the diamond are that, and the wider one is the answer.
        let map = iso_map(64.0, 2.0);
        let scale = px_per_cell(&map);
        let origin = grid_to_px(&map, 0.0, 0.0);
        for (x, y) in [(1.0, 0.0), (0.0, 1.0), (0.707, 0.707), (0.707, -0.707)] {
            let at = grid_to_px(&map, x, y);
            let reach = hypot(at.x - origin.x, at.y - origin.y);
            assert!(
                reach <= scale + 1e-3,
                "a unit of grid distance drew {reach} pixels against a bound of {scale}"
            );
        }
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

    /// A viewer standing in the middle of `cell`, in the grid units the sweeps
    /// take. Half-integers, which is where `snap_to_cell` puts an odd-sized
    /// token and where the radius ties live.
    fn at(cell: Cell) -> Source {
        Source {
            at: Pos {
                x: cell.0 as f32 + 0.5,
                y: cell.1 as f32 + 0.5,
            },
            // The map's radius, which is what every source in this file was
            // before a light could carry one of its own.
            radius_ft: None,
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
    fn the_circle_is_the_same_on_both_sides_of_the_viewer() {
        // A radius set in feet is a whole number of cells, so the cells at
        // exactly that distance sit exactly on the circle: due east, due west,
        // and — at twenty-five feet — the two ends of every 3-4-5 triangle. A
        // tie, and the rule `crosses` already follows is that a tie is answered
        // the same way whichever end is asking.
        //
        // Measured in pixels it was not. `(c + 0.5) * grid_px - x * grid_px` and
        // `radius_cells * grid_px` are two roundings of the same number and they
        // disagree in the last bit, so the cell six east landed inside the circle
        // and the cell six west outside it — a lopsided circle that changed shape
        // as the token walked. A power-of-two grid hides it, which is why the
        // grids here are the awkward ones a DM's map actually calibrates to.
        for grid_px in [35.65, 72.3, 28.4, 100.0] {
            for (offset_x, offset_y) in [(0.0, 0.0), (7.0, 13.5), (120.0, 3.25)] {
                for vision_ft in [20.0, 25.0, 30.0, 60.0] {
                    for cell in [(0, 0), (2, 2), (7, 3), (13, 9)] {
                        let map = MapInfo {
                            grid_px,
                            offset_x,
                            offset_y,
                            fog: true,
                            vision_ft,
                            ..MapInfo::default()
                        };
                        let seen = visible_cells(&map, &[], &[at(cell)]);
                        for &(x, y) in &seen {
                            for mirror in [
                                (2 * cell.0 - x, y),
                                (x, 2 * cell.1 - y),
                                (2 * cell.0 - x, 2 * cell.1 - y),
                            ] {
                                assert!(
                                    seen.contains(&mirror),
                                    "{grid_px}px grid, {vision_ft}ft from {cell:?}: {:?} is lit and {mirror:?} is not",
                                    (x, y)
                                );
                            }
                        }
                    }
                }
            }
        }
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
        assert!(
            seen.contains(&(-1, 1)),
            "not just the one the sign favoured"
        );
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
        assert!(
            !from_below.contains(&(0, 0)),
            "and not the other way either"
        );
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

    #[test]
    fn a_closed_room_contains_its_own_light_and_one_missing_cell_does_not() {
        // The property every other wall test here implies and none of them
        // states: masonry alone encloses a room, with no door needed anywhere.
        //
        // The second half is the one worth having. A gap of a *single cell* —
        // an untraced doorway, or a polyline run that never returned to its
        // first corner — is not a small leak, it is the whole map. There is
        // nothing gradual about it, which is why a room that looks traced can
        // behave as though it were not, and why the fill previews before it
        // commits.
        let room = |south: Vec<Wall>| {
            let mut walls = vec![
                masonry(128.0, 128.0, 448.0, 128.0),
                masonry(448.0, 128.0, 448.0, 448.0),
                masonry(128.0, 448.0, 128.0, 128.0),
            ];
            walls.extend(south);
            walls
        };
        let escaped = |walls: &[Wall]| {
            visible_cells(&map(300.0), walls, &[at((4, 4))])
                .iter()
                .filter(|(x, y)| !(2..7).contains(x) || !(2..7).contains(y))
                .count()
        };

        let closed = room(vec![masonry(448.0, 448.0, 128.0, 448.0)]);
        assert_eq!(escaped(&closed), 0, "masonry alone encloses a room");

        // The same wall with cells 4..5 of it left out.
        let gap = vec![
            masonry(448.0, 448.0, 320.0, 448.0),
            masonry(256.0, 448.0, 128.0, 448.0),
        ];
        assert!(
            escaped(&room(gap.clone())) > 500,
            "and one cell of it missing spills sight across the whole board"
        );

        // Which is what hanging a shut door in the gap is for.
        let mut shut = gap;
        shut.push(Wall {
            from: Px { x: 256.0, y: 448.0 },
            to: Px { x: 320.0, y: 448.0 },
            kind: WallKind::Door(false),
            ..Wall::default()
        });
        assert_eq!(escaped(&room(shut)), 0, "a shut door closes it again");
    }

    // --- room lighting ------------------------------------------------------

    /// The same map with the lights worked out a room at a time.
    fn lit_map(vision_ft: f32) -> MapInfo {
        MapInfo {
            lighting: Lighting::Room,
            ..map(vision_ft)
        }
    }

    /// A room five cells on a side, from cell (2,2) to (6,6), traced along the
    /// corner lattice the way the client's snap produces.
    ///
    /// `door` hangs one in the middle of the south wall; `None` walls that wall
    /// solid instead. Every test below says which it wants, because which of the
    /// two it is is the whole subject of half of them.
    fn chamber(door: Option<bool>) -> Vec<Wall> {
        let mut walls = vec![
            masonry(128.0, 128.0, 448.0, 128.0),
            masonry(448.0, 128.0, 448.0, 448.0),
            masonry(128.0, 448.0, 128.0, 128.0),
        ];
        match door {
            None => walls.push(masonry(448.0, 448.0, 128.0, 448.0)),
            Some(open) => {
                walls.push(masonry(448.0, 448.0, 320.0, 448.0));
                walls.push(masonry(256.0, 448.0, 128.0, 448.0));
                walls.push(Wall {
                    from: Px { x: 256.0, y: 448.0 },
                    to: Px { x: 320.0, y: 448.0 },
                    kind: WallKind::Door(open),
                    ..Wall::default()
                });
            }
        }
        walls
    }

    #[test]
    fn a_room_lights_whole_and_a_shut_door_seals_it() {
        // The mode in one test. The viewer stands in a corner of the chamber
        // with a shut door in its south wall: every square of the room arrives
        // whether or not a straight line reaches it, and nothing past the door
        // does.
        let lit = lit_cells(&lit_map(100.0), &chamber(Some(false)), &[at((2, 2))]);
        for cell in [(2, 2), (6, 6), (2, 6), (6, 2)] {
            assert!(lit.contains(&cell), "the whole room, including {cell:?}");
        }
        assert!(!lit.contains(&(4, 7)), "and a shut door seals it");
        assert_eq!(lit.len(), 25, "five by five and nothing else");
    }

    #[test]
    fn an_open_door_bounds_the_flood_like_everything_else_traced() {
        // The DM's fill's rule, arriving where it was missing. Reading `blocks()`
        // here made an open door a hole in the room boundary, so a one-cell
        // hallway handed over the whole chamber past it — and the only marker
        // that bounded a room was a shut door somebody had to swing by hand.
        //
        // The source stands in the doorway's own column, which is the case that
        // used to leak hardest.
        let lit = lit_cells(&lit_map(100.0), &chamber(Some(true)), &[at((4, 4))]);
        assert!(lit.contains(&(4, 6)), "the room, up to its south wall");
        assert!(!lit.contains(&(4, 7)), "and not a step through the doorway");
        assert!(!lit.contains(&(4, 8)), "nor the ground past it");
    }

    #[test]
    fn what_an_open_door_passes_is_sight() {
        // The other half of the union, and the reason the flood could give the
        // doorway up: the party gets the wedge they can see through it rather
        // than the room behind it. Straight down the door's own column reaches;
        // a cell whose ray hits the masonry beside it does not.
        let seen = sight_cells(&lit_map(100.0), &chamber(Some(true)), &[at((4, 4))]);
        assert!(seen.contains(&(4, 8)), "straight through the doorway");
        assert!(
            !seen.contains(&(2, 8)),
            "and nothing the doorway does not show"
        );
    }

    #[test]
    fn a_shut_door_passes_neither() {
        // Both halves stop, which is what "a shut door seals a room" now means:
        // the flood bounds on it like any segment, and the rays stop because it
        // blocks.
        let seen = sight_cells(&lit_map(100.0), &chamber(Some(false)), &[at((4, 4))]);
        assert!(seen.contains(&(4, 6)), "the room");
        assert!(!seen.contains(&(4, 7)), "and not one square past the door");
    }

    #[test]
    fn the_fill_is_bounded_by_the_radius_as_well_as_by_the_walls() {
        // Without this a pure fill does not respect corners: one step into a
        // winding corridor lights the whole of it, around every bend. The
        // radius is Euclidean like the raycast's, so the number means the same
        // thing in both modes.
        let lit = lit_cells(&lit_map(30.0), &[], &[at((0, 0))]);
        assert!(lit.contains(&(6, 0)), "six cells due east is thirty feet");
        assert!(!lit.contains(&(7, 0)), "and seven is not");
        assert!(
            !lit.contains(&(6, 6)),
            "a radius of light is a circle here too"
        );
    }

    #[test]
    fn a_wall_the_fill_cannot_cross_is_not_one_it_can_walk_along() {
        // The other half of the previous test's bound: what stops the fill
        // inside the radius is the masonry, and a room bigger than the radius
        // is a map whose radius should be raised rather than a second number.
        let lit = lit_cells(&lit_map(100.0), &chamber(None), &[at((2, 2))]);
        assert!(
            lit.iter()
                .all(|(x, y)| (2..=6).contains(x) && (2..=6).contains(y)),
            "nothing outside the chamber, in any direction"
        );
    }

    #[test]
    fn a_cell_a_wall_runs_through_is_a_dead_end() {
        // A chamfered corner: a wall at 45 degrees hits a cell centre every
        // other cell, and every step touching such a cell ties at one end or
        // the other — so without the dead-end rule the fill walks in one side
        // and straight out of the other, and one such cell is the whole map.
        //
        // The chamfer is taken by the fill that reached it, which is what keeps
        // a room's own corner from coming back ragged.
        let mut walls = chamber(None);
        walls.push(masonry(128.0, 128.0, 448.0, 448.0));

        let lit = lit_cells(&lit_map(100.0), &walls, &[at((5, 2))]);
        assert!(lit.contains(&(5, 2)), "its own square");
        assert!(lit.contains(&(3, 3)), "up to the diagonal");
        assert!(
            !lit.contains(&(2, 5)),
            "and not out through it to the far side"
        );
    }

    #[test]
    fn two_torches_light_two_rooms_and_neither_lights_the_others() {
        // One fill per source, unioned — deliberately not one sweep sharing a
        // visited set, which would stop the second source expanding through a
        // cell the first had already taken.
        let walls = chamber(Some(false));
        let map = lit_map(30.0);

        let outside = lit_cells(&map, &walls, &[at((4, 10))]);
        assert!(
            !outside.contains(&(4, 4)),
            "the chamber is sealed from out here"
        );

        let two = lit_cells(&map, &walls, &[at((3, 3)), at((4, 10))]);
        assert!(two.contains(&(6, 6)), "and the union holds the chamber");
        assert!(
            two.contains(&(4, 15)),
            "and ground five cells from the second torch and twelve from the first"
        );
    }

    #[test]
    fn the_mode_is_the_maps_and_a_room_is_never_less_than_sight() {
        // `sight_cells` is the one place the mode is read, which is what keeps
        // `recompute_sight` a single call — and `Room` is a *union*, so it can
        // never hand the table less than line of sight already would.
        // A spur inside the chamber, so there is somewhere the rays cannot reach
        // and the flood can. In a bare room the two agree exactly, which is true
        // and proves nothing.
        let mut walls = chamber(None);
        walls.push(masonry(320.0, 128.0, 320.0, 384.0));
        let seed = [at((2, 2))];
        let rays = visible_cells(&map(100.0), &walls, &seed);

        assert_eq!(
            sight_cells(&map(100.0), &walls, &seed),
            rays,
            "a map that says nothing is a map that casts rays"
        );

        let room = sight_cells(&lit_map(100.0), &walls, &seed);
        assert!(rays.iter().all(|cell| room.contains(cell)));
        assert!(
            room.len() > rays.len(),
            "and adds the ground behind the spur, which no ray reaches"
        );
    }

    #[test]
    fn a_room_lit_map_reaches_a_corner_the_rays_cannot() {
        // The thing the mode is for, stated as a difference rather than as a
        // count: an L-shaped alcove off the chamber arrives whole under `Room`
        // and only in the wedge the torch points at under `Dynamic`.
        let mut walls = chamber(None);
        walls.push(masonry(320.0, 128.0, 320.0, 384.0));

        let rays = visible_cells(&map(100.0), &walls, &[at((2, 2))]);
        let filled = lit_cells(&lit_map(100.0), &walls, &[at((2, 2))]);
        assert!(!rays.contains(&(5, 2)), "behind the spur, out of sight");
        assert!(filled.contains(&(5, 2)), "and in the same room");
    }

    // --- the DM's overrides -------------------------------------------------

    #[test]
    fn an_unpainted_map_has_no_overrides_to_pack() {
        assert_eq!(pack_overrides(&HashMap::new()), OverrideView::default());
    }

    #[test]
    fn the_three_states_pack_in_their_own_alphabet() {
        // A different alphabet from the fog beside it, and it has to be: `o` and
        // `#` mean the same thing in both, but `*` is a thing the fog cannot say
        // and `-` is a hole, which the fog has none of.
        let painted = HashMap::from([
            ((0, 0), Override::Dark),
            ((2, 0), Override::Explored),
            ((2, 1), Override::Lit),
        ]);
        let view = pack_overrides(&painted);
        assert_eq!((view.x, view.y, view.w, view.h), (0, 0, 3, 2));
        assert_eq!(view.cells, "#-o--*");
    }

    #[test]
    fn the_overrides_survive_the_round_trip_including_the_holes() {
        // The holes are the point: a cell nobody painted has to come back as an
        // *absent* entry rather than as a fourth variant, because that is the one
        // representation of `Auto` the room stores.
        let painted = HashMap::from([
            ((-3, -2), Override::Lit),
            ((4, 5), Override::Dark),
            ((4, 6), Override::Explored),
        ]);
        let back = unpack_overrides(&pack_overrides(&painted));
        assert_eq!(back, painted);
        assert!(!back.contains_key(&(0, 0)), "and nothing in between");
    }

    // --- what a shape covers ------------------------------------------------

    fn pos(x: f32, y: f32) -> Pos {
        Pos { x, y }
    }

    fn covers(kind: ShapeKind, origin: (f32, f32), to: (f32, f32), cell: Cell) -> bool {
        shape_covers(
            kind,
            pos(origin.0, origin.1),
            pos(to.0, to.1),
            &cells(&[cell]),
        )
    }

    #[test]
    fn a_circle_covers_the_cells_a_circle_covers() {
        // Radius four, centred on a cell centre. The same blob `coveredCells`
        // tints on the client, which is the point of porting it rather than
        // approximating it with the bounding box.
        let o = (4.5, 4.5);
        let r = (4.0, 0.0);
        assert!(covers(ShapeKind::Circle, o, r, (4, 4)), "its own square");
        assert!(
            covers(ShapeKind::Circle, o, r, (8, 4)),
            "due east, at reach"
        );
        assert!(!covers(ShapeKind::Circle, o, r, (9, 4)), "and past it");
        assert!(
            !covers(ShapeKind::Circle, o, r, (8, 8)),
            "a circle does not reach the corner of its own box"
        );
    }

    #[test]
    fn a_cone_is_a_wedge_and_its_apex_is_inside_it() {
        // The apex was the case the client's first draft got wrong — there is no
        // angle from a point to itself — so it is asserted here too.
        let o = (2.5, 2.5);
        let to = (6.0, 0.0);
        assert!(covers(ShapeKind::Cone, o, to, (2, 2)), "the apex");
        assert!(covers(ShapeKind::Cone, o, to, (6, 2)), "down the axis");
        assert!(covers(ShapeKind::Cone, o, to, (7, 4)), "inside the wedge");
        assert!(!covers(ShapeKind::Cone, o, to, (7, 7)), "outside it");
        assert!(!covers(ShapeKind::Cone, o, to, (-2, 2)), "behind it");
    }

    #[test]
    fn a_rect_covers_its_own_corner_whichever_way_it_was_drawn() {
        // `to` is an offset and may be negative in either axis, which is what
        // dragging up and to the left produces.
        for to in [(3.0, 2.0), (-3.0, -2.0)] {
            let inside = if to.0 > 0.0 { (6, 6) } else { (3, 4) };
            assert!(covers(ShapeKind::Rect, (5.5, 5.5), to, inside), "{to:?}");
            assert!(!covers(ShapeKind::Rect, (5.5, 5.5), to, (12, 12)), "{to:?}");
        }
    }

    #[test]
    fn a_line_covers_the_ground_it_is_drawn_across() {
        // `contains_point` is false everywhere on a line, so without its own walk
        // a measuring line would be withheld from everybody on a fogged map.
        let o = (1.5, 1.5);
        let to = (6.0, 0.0);
        assert!(covers(ShapeKind::Line, o, to, (1, 1)), "where it starts");
        assert!(covers(ShapeKind::Line, o, to, (4, 1)), "the middle of it");
        assert!(covers(ShapeKind::Line, o, to, (7, 1)), "where it ends");
        assert!(!covers(ShapeKind::Line, o, to, (4, 3)), "and nowhere else");
    }

    #[test]
    fn a_shape_over_nothing_at_all_covers_nothing() {
        // The empty set is what an unexplored map is, and every shape on it is
        // withheld — which is the direction this has to fail.
        assert!(!shape_covers(
            ShapeKind::Circle,
            pos(0.0, 0.0),
            pos(30.0, 0.0),
            &HashSet::new()
        ));
    }
}

//! Everything that crosses the wire, plus the state types the room owns.
//!
//! `ServerMsg` is the outbound wire format. The room's internal `Event` type
//! lives in `room.rs` and is deliberately not this type — see `message_for`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::fog::{Cell, FogView, Override, OverrideView};

/// Server-assigned, unique per connection. Not an identity — it dies with the
/// socket. `PlayerId` is the thing that survives a refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClientId(pub u64);

/// A roster slot. This *is* the player's identity: claiming "Saelyn" means your
/// `player_id` is literally `saelyn`, so a refresh reclaims the same slot and no
/// token is ever orphaned. There is no separate claim table.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PlayerId(pub String);

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TokenId(pub String);

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ShapeId(pub String);

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct WallId(pub String);

impl TokenId {
    pub fn new(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl PlayerId {
    pub fn new(s: &str) -> Self {
        Self(s.to_owned())
    }
}

/// Adjacently tagged: `{"kind":"dm"}` / `{"kind":"player","id":"saelyn"}`.
/// Internal tagging cannot express a newtype variant wrapping a string, and
/// serde's default external tagging would produce two different JSON shapes.
// `Hash` and `Ord` are here for the scratchpads: this keys `RoomState::notes`,
// and the saved form of that table is sorted so the file does not churn on
// every write — the reason `to_saved` sorts the tokens.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Owner {
    /// The default on purpose: a token restored from a schema that predates
    /// ownership becomes DM-only, which fails closed. Defaulting to any player
    /// would hand a stranger's token to whoever happened to claim that slot.
    #[default]
    Dm,
    Player(PlayerId),
}

/// Which palette entry each player has chosen, by roster slug. A slot with no
/// entry never chose one, and the client's default for that slot stands.
///
/// **A `BTreeMap` rather than the `HashMap` every other table in this project
/// is**, for two reasons that are the scratchpads' two reasons answered the
/// other way round. `PlayerId` is a newtype over `String`, so it is a legal JSON
/// object key — which `Owner` is not, and which is why `notes` had to become a
/// sorted list of pairs on the disk. Sorted keys are that list's other half: a
/// `HashMap` iterates in a different order every process, so the file would
/// churn on every write.
///
/// The value is an **index into a palette this crate does not hold.** The six
/// hues live in `client/src/pings.ts` and nowhere else, because a second copy
/// here would be a second thing to keep in step for no gain — the server has no
/// opinion about what `3` looks like, only that it names a colour. See
/// `PALETTE`.
pub type Colours = BTreeMap<PlayerId, u8>;

/// How many colours there are to choose between.
///
/// The length of `PLAYER_HUES` in `client/src/pings.ts`, and the only thing this
/// crate knows about that list. It is here so `SetColour` can be refused the way
/// a token's size is — a closed set checked on the server — and the reason the
/// set is closed rather than free hex is written on `ClientMsg::SetColour`.
pub const PALETTE: u8 = 6;

// Invariant 2 wants `#[serde(default)]` on every persisted field. Declaring it
// on the container is equivalent for deserialization and strictly safer: a
// field added in a later schema cannot be forgotten, because there is no
// per-field attribute to forget.

/// A rectangle in image pixels, like everything else on `MapInfo`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MapInfo {
    pub url: String,
    pub grid_px: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    /// The overlay colour, as `#rrggbbaa`.
    ///
    /// Alpha is part of the value rather than a field of its own because how
    /// hard the grid reads matters more than its hue, and because `aa = 00` is
    /// then how a DM turns the overlay off on a map that already has a grid
    /// printed on it. The client draws a contrasting halo under whatever this
    /// is, so it stays legible without the DM having to think about it.
    pub grid_color: String,
    /// The playable region of the image. The grid is ruled only here, and the
    /// rest of the image is dimmed.
    ///
    /// `None` means the whole image — which is both what a save written before
    /// this field means and the only thing the server *could* mean by it, since
    /// it never learns the image's dimensions. Only the client, which has the
    /// decoded image, can turn "all of it" into numbers.
    pub play_area: Option<Rect>,
    /// Whether the party's sight is limited on this map.
    ///
    /// Per map rather than per room, and remembered per URL like the rest of the
    /// calibration: a dungeon wants fog and the meadow outside it does not, and
    /// the DM should not have to remember which is which when they swap between
    /// them. Off by default, which is the whole of the roadmap's warning about
    /// this: a room restored from a save that predates fog is a room nobody asked
    /// to darken, and a switch that defaults to off cannot make that mistake
    /// whatever `vision_ft` happens to load as.
    pub fog: bool,
    /// How far a player-owned token sees, in feet. One radius for the map rather
    /// than one per token — nothing here knows the word "darkvision".
    ///
    /// Read only when `fog` is on, so its default is a playable number rather
    /// than a defensive one. Both modes below read it, which is the whole reason
    /// the room fill is bounded by it as well as by the walls.
    pub vision_ft: f32,
    /// How this map's sight is worked out. Per map like the two above and
    /// remembered per URL with them: the outdoor map keeps line of sight and the
    /// dungeon reveals a room at a time.
    pub lighting: Lighting,
    /// What shape a cell is. Per map and remembered per URL like the rest of the
    /// calibration — see `docs/maps.md`.
    ///
    /// `Square` is the default, which is what keeps a save written before this
    /// field describing exactly the board it always did. Nothing downstream of
    /// `fog::basis` knows there is more than one shape.
    pub grid_shape: GridShape,
}

/// What "can the party see this cell" means on a given map.
///
/// Two questions read out of the same walls rather than two answers to one:
/// `Dynamic` asks whether a straight line reaches the cell, `Room` asks whether a
/// walk does. Neither is the other written twice — see `visible_cells` and
/// `lit_cells` in `fog.rs`, which sit beside each other for that reason.
///
/// Per map rather than per room, unlike `Diagonals`: a dungeon of sealed chambers
/// and the meadow outside it want different answers, and the DM should not have
/// to remember which is which when they swap between them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lighting {
    /// Line of sight: a cell is lit when nothing stands between the viewer's
    /// centre and it. The default, which is what keeps a save written before this
    /// field existed reading exactly as it did — invariant 2 protects the field
    /// being added, and this is what makes the default the old behaviour.
    #[default]
    Dynamic,
    /// The room a token is standing in, out to the radius: a cell is lit when a
    /// walk reaches it without crossing masonry or a shut door. **An open door is
    /// how light reaches the next room, and a shut one seals this one** — which
    /// is what makes a door load-bearing rather than decorative.
    Room,
}

/// The shape of one cell, and so of the whole lattice.
///
/// **An isometric grid is an affine image of a square one**, which is the whole
/// reason this is one field rather than a second coordinate system. `fog::basis`
/// turns it into the two cell axes and is the only place either variant is read
/// on this side of the wire; `gridBasis` in `client/src/scene.ts` is its twin.
///
/// A descriptor rather than the four numbers of a basis, because a basis has no
/// honest `Default` — "square" depends on `grid_px`, which is a sibling field —
/// and because `MIN_GRID_PX` has something to bound only while `grid_px` still
/// means the size of a cell.
///
/// This is flat: a diamond lattice, not a 2.5D renderer. Nothing here has a
/// height, and `Wall` is still a segment in image pixels — see `docs/maps.md`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GridShape {
    /// An axis-aligned square of side `grid_px`. The shape every map had before
    /// there were two, so a save that predates the field describes the same
    /// board after loading it.
    #[default]
    Square,
    /// A diamond `grid_px` tall and `grid_px * ratio` wide, for isometric art.
    /// `2.0` is the common projection; the bound is checked on the server, where
    /// `grid_px` is bounded, so the width cannot escape the same range.
    Iso { ratio: f32 },
}

impl Default for MapInfo {
    fn default() -> Self {
        Self {
            url: String::new(),
            // A zero grid size would be a division by zero on the client, so
            // this has to be a usable square rather than `f32::default()`.
            grid_px: 64.0,
            offset_x: 0.0,
            offset_y: 0.0,
            // White at ~32%. Faint on its own, but the halo underneath is what
            // carries it on a light map.
            grid_color: "#ffffff52".to_owned(),
            play_area: None,
            // The safe direction, and the only one: a map nobody has turned fog
            // on for is a map the table can see all of, which is exactly what
            // every room saved before this field existed was.
            fog: false,
            // Only read once `fog` is on, so this is a sensible torch rather than
            // a guard against the zero that `#[serde(default)]` would otherwise
            // supply — the flag above is what guards that.
            vision_ft: 60.0,
            // The mode every map had before there were two, so a save that
            // predates the field describes the same dungeon after loading it.
            lighting: Lighting::Dynamic,
            // The same argument as `lighting`, and the stronger one: this decides
            // where every cell *is*, so anything but `Square` here would move the
            // tokens on a board saved before the field existed.
            grid_shape: GridShape::Square,
        }
    }
}

/// A `MapInfo` with the URL taken off: everything the DM sets by calibrating.
///
/// The room keeps one of these per map URL so that re-picking a map out of the
/// library comes back the way it was left. Persisted, but never sent — it is not
/// on `RoomView` and no `ServerMsg` carries it. The room applies it and the
/// finished `MapInfo` is what reaches the wire, so remembering a calibration
/// adds no client state and no message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Calibration {
    pub grid_px: f32,
    pub offset_x: f32,
    pub offset_y: f32,
    pub grid_color: String,
    pub play_area: Option<Rect>,
    /// Remembered with the grid rather than kept beside it. Whether a map is
    /// fogged, how far its torches reach and how sight is worked out on it are
    /// facts about that dungeon, and re-picking it out of the library should
    /// bring all three back with the rest.
    pub fog: bool,
    pub vision_ft: f32,
    pub lighting: Lighting,
    pub grid_shape: GridShape,
}

impl Default for Calibration {
    /// Taken from `MapInfo` rather than restated, so the grid size that must
    /// never be zero cannot quietly become zero on this side.
    fn default() -> Self {
        MapInfo::default().into()
    }
}

impl From<MapInfo> for Calibration {
    fn from(map: MapInfo) -> Self {
        Self {
            grid_px: map.grid_px,
            offset_x: map.offset_x,
            offset_y: map.offset_y,
            grid_color: map.grid_color,
            play_area: map.play_area,
            fog: map.fog,
            vision_ft: map.vision_ft,
            lighting: map.lighting,
            grid_shape: map.grid_shape,
        }
    }
}

impl Calibration {
    /// The map this describes, once it is known which image it belongs to.
    pub fn into_map(self, url: String) -> MapInfo {
        MapInfo {
            url,
            grid_px: self.grid_px,
            offset_x: self.offset_x,
            offset_y: self.offset_y,
            grid_color: self.grid_color,
            play_area: self.play_area,
            fog: self.fog,
            vision_ft: self.vision_ft,
            lighting: self.lighting,
            grid_shape: self.grid_shape,
        }
    }
}

/// Everything the DM has prepared on one map, keyed by that map's URL.
///
/// The shelf. `Calibration` above is *what the client sent* — the room builds
/// one as a struct literal out of the `SetMap` fields — and this is what the
/// room has learned about that image since. Keeping them apart is not
/// bookkeeping: a recalibration overwrites the calibration and must not be able
/// to reach the tracing, and with one type the obvious way to write that arm
/// files empty walls over half an hour's work. Here the insert cannot reach
/// them.
///
/// Server-side only, like the calibration it wraps: nothing here is on
/// `RoomView` and no `ServerMsg` carries it, because the finished `MapInfo` and
/// the board's own `walls` already say everything a client needs.
///
/// `Calibration` is flattened, so the disk shape is what it always was with two
/// keys added beside it — `StagedView`'s trick, and for the same reason: a save
/// written before this milestone loads as a calibrated map with nothing traced
/// on it, which is exactly what it was.
///
/// No `PartialEq`, unlike `Calibration`. `Wall` does not derive it, and a
/// comparison of two shelves is not something anything here wants.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Prepared {
    #[serde(flatten)]
    pub calibration: Calibration,
    /// Traced over this image and filed under it as the map leaves the board,
    /// so a dungeon walled on a Tuesday is still walled on Saturday. Bounded
    /// where it is traced — `MAX_WALLS` — and never on the wire, so there is no
    /// frame-cap question here.
    pub walls: Vec<Wall>,
    /// Painted over this image, and remembered beside the walls because both
    /// are the DM's authoring. Packed like every other override list that goes
    /// to disk, and for the same reason: `Cell` is a tuple and JSON has no key
    /// shaped like one.
    pub overrides: OverrideView,
}

/// What the DM is counting down on a creature. Not a stat block: nothing here
/// knows what a hit point *means*, only that the DM wrote two numbers down.
///
/// The pair travels together so that "half a hit point total" is
/// unrepresentable — a bare `current` with no `max` is a number the board cannot
/// draw a bar for, and two `Option<i32>` fields could be set one at a time.
/// `Option<Hp>` on the token is how "the DM keeps no total on this one" is said.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Hp {
    pub current: i32,
    pub max: i32,
}

/// A position in grid units, for the one place a token has a second one.
///
/// It exists so that "half a position" is unrepresentable: two bare
/// `Option<f32>` fields could be set one at a time, and a plan with an x and no
/// y is not a cell anything can land on. Same reason `Hp` keeps its pair
/// together, and the same reason `Identity` is an enum.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Pos {
    pub x: f32,
    pub y: f32,
}

/// A point in image pixels — the other coordinate space, and the one invariant 1
/// names as its exception.
///
/// A separate type from `Pos` rather than the same two floats reused, because
/// the two spaces are not interchangeable and mixing them up is silent: a wall
/// traces a feature painted on the map, so it is anchored to the art, and one
/// stored in grid units would slide off the wall it was tracing the moment the
/// DM recalibrated. `Rect` is in this space too, for the same reason.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Px {
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Token {
    pub id: TokenId,
    pub name: String,
    /// Grid units, measured to the token's centre. Never pixels — invariant 1.
    pub x: f32,
    pub y: f32,
    pub owner: Owner,
    /// Site-relative, or empty for a token with no art. Empty is a legitimate
    /// state, not a missing one: the client draws a named disc, so the sixth
    /// goblin of the evening costs the DM nothing.
    pub img: String,
    /// Width and height in grid cells. One cell unless the DM says otherwise.
    ///
    /// Nothing here knows the words "large" or "huge" — that would be rules
    /// knowledge. It is a count of squares, and the only thing it changes
    /// besides the drawing is where the token settles: see `snap_to_cell`.
    pub size: f32,
    /// The table cannot see this token at all. Not drawn-but-faint: it is absent
    /// from a player's snapshot, its moves are not relayed to them, and its
    /// initiative row is filtered out of their panel — invariant 4.
    ///
    /// Applies whoever owns it. Hiding a player's own token is a strange thing
    /// to do and is not worth a rule to forbid; the filter is uniform instead.
    pub hidden: bool,
    /// The DM's note on a creature, and nobody else's business. `None` is the
    /// usual state — most tokens are party members the DM keeps no total for.
    pub hp: Option<Hp>,
    /// How far this token lights the board, in feet, or `None` for a token that
    /// carries no light of its own.
    ///
    /// One field doing two things, which is the whole of milestone 39. On a token
    /// a player owns it *replaces* `MapInfo::vision_ft` — a lantern, and the
    /// per-token radius this project spent five milestones not building. On
    /// anything else it is what makes the token a source at all: a brazier, a
    /// torch on a wall, a goblin carrying one. `fog::Source` is where the two
    /// become one rule.
    ///
    /// DM-only, like `hp` beside it. What a light does reaches the table as fog,
    /// which is the argument the walls already make — the geometry is the DM's
    /// authoring and the shadow it casts is what the table plays with. So `None`
    /// here is both "carries no light" and "you are not the DM".
    pub light_ft: Option<f32>,
    /// Where this token lands when the staged map is promoted, in grid units
    /// like `x, y`. `None` is "staying where it is".
    ///
    /// DM-only, and a plan rather than a position: it is adopted into `x, y` by
    /// a promote and thrown away with the staged map by anything else. Only
    /// position and existence fork between the two boards — a rename, a resize
    /// or a re-art applies to one token and therefore to both.
    pub staged_pos: Option<Pos>,
    /// This token does not exist on the live board yet: it was built on the map
    /// the DM is preparing, and the table learns of it when that map is
    /// promoted. DM-only, and cleared by the promote that makes it real.
    ///
    /// Absent from the DM's own live board too. Switching back to `Map` mode
    /// has to show the board as the table sees it, or the DM loses the one view
    /// they have of what everyone else is looking at.
    pub staged_only: bool,
}

impl Default for Token {
    /// Hand-written for `size` alone. The derived `Default` would make it zero,
    /// and the container-level `#[serde(default)]` above means every token saved
    /// before this field existed would load at zero — drawn with no radius, and
    /// so invisible and impossible to grab. Same trap `MapInfo::grid_px` avoids.
    ///
    /// `hidden` is the opposite case and the derived `false` is right: a token
    /// saved before the field existed was one the table could see, and defaulting
    /// it to `true` would make an upgrade empty the board. `staged_only` is the
    /// same shape and takes the same answer.
    fn default() -> Self {
        Self {
            id: TokenId::default(),
            name: String::new(),
            x: 0.0,
            y: 0.0,
            owner: Owner::default(),
            img: String::new(),
            size: 1.0,
            hidden: false,
            hp: None,
            light_ft: None,
            staged_pos: None,
            staged_only: false,
        }
    }
}

/// A token as one particular client may see it — the token-shaped counterpart to
/// `RoomView`, and the reason `Token` itself never reaches the wire.
///
/// This is the per-field redaction everything filtered so far did without. A
/// staged map reaches the DM or nobody, whole; hit points are a field on a token
/// the players *do* otherwise see, so their copy has to be a different shape.
///
/// Redaction is by construction rather than by blanking: `view_for` names every
/// field that leaves the room, so a secret added to `Token` and forgotten here is
/// absent from the wire rather than quietly sent to everyone. That direction is
/// the point — the failure mode is a field the DM's own client is missing, which
/// is visible, instead of one the table can read in devtools, which is not.
#[derive(Debug, Clone, Serialize)]
pub struct TokenView {
    pub id: TokenId,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub owner: Owner,
    pub img: String,
    pub size: f32,
    /// Only ever true on the DM's copy. A player is not sent a hidden token at
    /// all, so this is false for them by construction rather than by rule.
    pub hidden: bool,
    /// `None` for a player, always. Also `None` for a DM who keeps no total on
    /// this creature — the two are indistinguishable from the client side, the
    /// way `staged` being `None` is both "nothing staged" and "not the DM".
    pub hp: Option<Hp>,
    /// `None` for a player, always — and the table loses nothing by it, since
    /// what a light does reaches them as fog. Also `None` for a DM's token that
    /// carries none, indistinguishable in the way `hp` is.
    pub light_ft: Option<f32>,
    /// `None` for a player, always — a plan for a map they cannot see is a fact
    /// about that map. Also `None` for a DM whose token is staying put.
    pub staged_pos: Option<Pos>,
    /// Only ever true on the DM's copy: a player is not sent a token that does
    /// not exist on their board yet, so this is false for them by construction.
    pub staged_only: bool,
}

impl Token {
    /// The copy this recipient is allowed to hold. Callers decide whether an
    /// unseen token is sent at all; this decides what is in it once it is.
    ///
    /// Adding a field here is the deliberate act of deciding the DM's own client
    /// needs it. `staged_pos` and `staged_only` are here because the DM's board
    /// is what draws a plan — leaving them out would have reached nobody, which
    /// is the direction this type fails in.
    pub fn view_for(&self, is_dm: bool) -> TokenView {
        TokenView {
            id: self.id.clone(),
            name: self.name.clone(),
            x: self.x,
            y: self.y,
            owner: self.owner.clone(),
            img: self.img.clone(),
            size: self.size,
            hidden: self.hidden,
            hp: if is_dm { self.hp } else { None },
            light_ft: if is_dm { self.light_ft } else { None },
            staged_pos: if is_dm { self.staged_pos } else { None },
            staged_only: is_dm && self.staged_only,
        }
    }

    /// Whether the table cannot see this token at all — the one question every
    /// filter in `room.rs` asks, and now two fields answer.
    ///
    /// `hidden` is a creature the DM took off the board; `staged_only` is one
    /// that was never on it. Different facts about different maps, and they
    /// compose: a monster built on the next map and hidden there is both, and
    /// stays unseen through the promote that settles the second of them.
    /// Anything that filters on one and forgets the other is a leak, so nothing
    /// in the room asks this question of either field directly.
    pub fn unseen(&self) -> bool {
        self.hidden || self.staged_only
    }
}

/// The four things anyone can draw on the board. A closed set, checked by serde
/// rather than by hand — an unknown kind fails to deserialize, the way an
/// unknown `ClientMsg` does.
///
/// Nothing here knows what a spell is. A cone is a wedge as wide as it is long,
/// which is geometry; that it happens to be how a breath weapon is measured is
/// the table's business, not this file's.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShapeKind {
    /// Two points and the distance between them. The default because it is the
    /// one kind that encloses nothing: a save from a schema that predates this
    /// field cannot invent an area out of it.
    #[default]
    Line,
    /// Centred on the origin, out to the second point.
    Circle,
    /// Apex at the origin, pointing at the second point.
    Cone,
    /// The two points are opposite corners.
    Rect,
}

/// How the movement ruler charges a diagonal step. Room-wide, the DM's to set.
///
/// **The server stores this and relays it and never computes with it.** There is
/// no movement distance in this crate to compute — `feetMoved` is client-only,
/// deliberately, because a reading is drawn and never enforced. What the room
/// owns is that all six clients agree on the convention, which is the same thing
/// `show_names` owns and the same reason it cannot live in `localStorage`.
///
/// Not on `MapInfo` beside `fog`, for the reason `show_names` is not: this is a
/// house rule about counting, and swapping the map is not a request to change
/// how the table counts.
///
/// It moves the ruler and nothing else. A drawn circle's radius and a token's
/// vision are geometry — `contains_point` and `visible_cells` stay Euclidean,
/// and the disagreement between the two that `docs/drawings.md` names is
/// deliberate on both sides of the switch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Diagonals {
    /// Every step costs one cell, orthogonal or not — "5-5-5" at the table. The
    /// default, which is what keeps a save written before this field existed
    /// reading exactly as it did.
    #[default]
    Equal,
    /// The second diagonal of a move costs double, and every other one after —
    /// "5-10-5". Counted from the start of each reading rather than across a
    /// turn: nothing here holds a creature's movement budget, and the first
    /// diagonal of anything anyone measures costs five.
    Alternating,
}

/// Where a shape's first point is.
///
/// An enum rather than a position beside an `Option<TokenId>`, for the reason
/// `Identity` is one: an anchored shape carrying a position nothing reads is a
/// field that can go stale, and the pair could disagree. Here they cannot.
///
/// `Token` is the anchor the roadmap asks for — an aura that follows the
/// creature it belongs to. It needs no position updates on the wire at all,
/// because every client already holds the token and derives the rest.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "at", rename_all = "snake_case")]
pub enum Origin {
    /// A cell on the board, in grid units like everything else a token knows.
    Point(Pos),
    /// A token, wherever it currently stands.
    Token(TokenId),
}

impl Default for Origin {
    fn default() -> Self {
        Self::Point(Pos::default())
    }
}

/// A drawn shape: a spell area, or anything else worth putting on the board.
///
/// Unlike `Token` this reaches the wire as itself, and deliberately: there is no
/// `ShapeView` because there is nothing on it one client may hold and another
/// may not. Fog will gate a shape *whole* — all-or-nothing on whether any cell
/// it covers is visible — so the seam is `message_for`, which drops it, rather
/// than a view type, which would have no field to redact.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Shape {
    pub id: ShapeId,
    pub kind: ShapeKind,
    pub from: Origin,
    /// The second point, as an offset from the origin in grid units.
    ///
    /// An offset rather than a position so that an anchored shape translates
    /// with its token instead of stretching towards a fixed cell. Grid units,
    /// not pixels: a shape is measured in cells the way a token is placed in
    /// them, so recalibrating the grid leaves a 20 ft circle 20 ft across.
    pub to: Pos,
    /// Who drew it, and so who may delete it besides the DM. The same type a
    /// token's `owner` is, and the same idea — but a shape is nobody's to move,
    /// so this is named for what it actually answers.
    pub by: Owner,
    /// `#rrggbbaa`, like `MapInfo::grid_color` and validated by the same rule.
    /// The client picks from a small palette; the server only checks the shape.
    pub color: String,
}

impl Shape {
    /// The token this shape follows, if it follows one. Every filter asks this
    /// rather than matching on `from` itself — the same reason `Token::unseen`
    /// exists.
    pub fn anchor(&self) -> Option<&TokenId> {
        match &self.from {
            Origin::Token(id) => Some(id),
            Origin::Point(_) => None,
        }
    }
}

/// Whether a segment is masonry or a way through it.
///
/// An enum rather than `door: bool` beside `open: bool`, for the reason `Origin`
/// is one: a solid wall carrying an open flag nothing reads is a field that can
/// go stale, and the pair could disagree about what the segment even is. Here
/// "a solid wall that is open" is unrepresentable.
///
/// Adjacently tagged like `Owner`, so the two variants are `{"kind":"solid"}`
/// and `{"kind":"door","open":true}` rather than two different JSON shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "open", rename_all = "snake_case")]
pub enum WallKind {
    /// Masonry. Blocks line of sight once there is line of sight to block.
    Solid,
    /// A way through, and whether it is standing open. Toggled by the DM alone.
    Door(bool),
}

impl Default for WallKind {
    /// A save from a schema that predates doors describes masonry, and masonry
    /// is also the safe way round: a segment that defaults to an open door would
    /// quietly stop blocking anything the moment fog arrives.
    fn default() -> Self {
        Self::Solid
    }
}

/// One traced segment of wall, in image pixels.
///
/// **Not in grid units — this is invariant 1's stated exception.** A wall traces
/// a feature painted on the map, so it belongs to the art rather than to a cell;
/// stored in cells, every wall would slide off the thing it was tracing the
/// moment the DM corrected the grid. Calibrate first, then trace.
///
/// Flat segments rather than the polylines they are drawn as: the run is an
/// authoring convenience, and everything downstream — erasing one bad segment,
/// toggling one door, and the shadowcast that will read these — asks about
/// segments one at a time.
///
/// There is no `WallView`. Walls do not reach a player at all, whole or
/// redacted, so the seam is `message_for` dropping the message and
/// `snapshot_for` sending an empty list — the same seam `staged` leaves by.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Wall {
    pub id: WallId,
    pub from: Px,
    pub to: Px,
    pub kind: WallKind,
}

impl Wall {
    /// Whether this segment is a door, and whether it is open. `None` is
    /// masonry — the one question the editor's neighbours ask.
    pub fn door(&self) -> Option<bool> {
        match self.kind {
            WallKind::Door(open) => Some(open),
            WallKind::Solid => None,
        }
    }

    /// Whether sight stops here. The one question `fog.rs` asks, and the reason
    /// `WallKind::default` is `Solid`: a segment restored from a schema that
    /// predates doors has to keep blocking, and one that defaulted to an open
    /// door would quietly stop.
    pub fn blocks(&self) -> bool {
        !matches!(self.kind, WallKind::Door(true))
    }
}

/// Where something somebody typed is going.
///
/// **Two destinations for anyone, and never a third.** A player says it to the
/// table or to the DM; the DM says it to the table or to one player. There is
/// no player-to-player variant and adding one is what would turn this into
/// chat — see the non-goal in `.claude/CLAUDE.md`, which is the specification.
///
/// `Owner`'s neighbour rather than `Owner` itself, and the difference is
/// `Table`: an owner is a person, and this is a person *or* everybody. Reusing
/// `Owner` would have meant either a `Table` variant on the type a token's
/// ownership is written with, or a `None` meaning "everyone", and both of those
/// are worse than one enum that says what it is.
///
/// Adjacently tagged like `Owner`, and for the same reason — a newtype variant
/// wrapping a string cannot be internally tagged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ChatTo {
    /// A shout: everybody, filtered by nothing at all. The fog does not apply
    /// to words.
    Table,
    /// A whisper to the DM. What a player's second button says, and the only
    /// destination on this list a player may name that is not the table.
    Dm,
    /// A whisper to one player, which only the DM may send.
    Player(PlayerId),
}

/// One thing somebody said, as the room keeps it and as it goes out.
///
/// **Never `Deserialize`, and that is a fact about the feature rather than an
/// omission**: the log is session memory, so nothing ever reads one of these
/// back — not off the disk, because it is not written there, and not off the
/// wire, because a client sends a `Say` and the room decides who said it.
///
/// It carries `to` as well as `by` because a whisper has to *look* like one on
/// the screen of both people party to it, and neither of them can work that out
/// from `by` alone — the DM sees their own whisper to Saelyn and Saelyn's
/// whisper to them side by side in one log.
#[derive(Debug, Clone, Serialize)]
pub struct ChatLine {
    /// Who said it. An `Owner` because that is what the roster resolves to a
    /// name and a colour, exactly as `Pinged` carries one.
    pub by: Owner,
    pub to: ChatTo,
    /// Trimmed and length-checked on the way in. Text and nothing else: no
    /// formatting, no emotes, no commands.
    pub text: String,
    /// The room threw this rather than somebody typing it.
    ///
    /// **The whole of what the loaner die adds to the log**, and it is a fact
    /// about the line rather than a flag guarding behaviour: a witnessed number
    /// reads differently from a claimed one at a glance, which is the same rule
    /// and the only rule `to` is used for on the client.
    ///
    /// It is free because this struct is session memory and `Serialize` only —
    /// no disk, so no migration and no `#[serde(default)]`; not on `Saved`, so
    /// not on the undo ring. See `docs/dice.md`.
    pub rolled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RosterEntry {
    pub id: PlayerId,
    pub name: String,
}

/// A roster slot as offered to someone choosing an identity. `claimed` is
/// advisory — it stops two people picking Saelyn by accident, it does not stop
/// anyone deliberately (a player on both a laptop and a phone is legitimate).
#[derive(Debug, Clone, Serialize)]
pub struct RosterSlot {
    pub id: PlayerId,
    pub name: String,
    pub claimed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct InitiativeEntry {
    pub token: TokenId,
    /// Whatever the table rolled. The DM types it; nothing here knows about d20s.
    pub value: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Initiative {
    /// Always sorted by `value` descending. Ties keep insertion order, because
    /// the sort is stable — the first creature the DM entered goes first.
    pub entries: Vec<InitiativeEntry>,
    /// Whose turn it is, by token rather than by list position. Re-sorting after
    /// an edited value must never silently move the turn to someone else.
    pub current: Option<TokenId>,
    pub round: u32,
}

impl Default for Initiative {
    fn default() -> Self {
        // Combat starts on round 1, not round 0.
        Self {
            entries: Vec::new(),
            current: None,
            round: 1,
        }
    }
}

/// The staged slot as it is written down: the map the DM is preparing, and the
/// walls and overrides they have prepared *on* it.
///
/// One bundle rather than three fields side by side, because the three are one
/// thing and they arrive, sweep and promote together. `RoomState` holds the live
/// board's three flat and this for the staged one — the asymmetry is honest, the
/// live board is the room's own and this is a parcel waiting to be delivered.
///
/// **The map is `#[serde(flatten)]`ed, which is what keeps an older save
/// loading.** A file written before this existed holds `"staged": {"url": …,
/// "grid_px": …}` — the map's fields at exactly the level flatten reads them
/// from — so the map comes back and the two new lists default to empty, which is
/// what a staged map with nothing traced on it is anyway. Nesting it under a
/// `map` key instead would have deserialized every one of those fields as
/// missing and handed the DM a staged slot holding a blank image.
///
/// The same type on the wire and on disk, the way `MapInfo` already is: what the
/// DM may hold of the staged slot and what the file must hold of it are the same
/// thing, because a player holds none of it either way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StagedView {
    #[serde(flatten)]
    pub map: MapInfo,
    /// Traced over the staged image, and swept with it. There is no filtered
    /// form for the reason the live board's have none: walls reach the DM or
    /// nobody, and a staged wall adds no visibility surface a live one did not.
    pub walls: Vec<Wall>,
    /// Painted over the staged board by hand. Packed like the live board's, and
    /// withheld like them.
    ///
    /// There is no staged *fog* to sit under this, deliberately — see
    /// `docs/fog.md`. What the DM is painting is what the party will be handed
    /// the moment the map is promoted, not a preview of what they can see now.
    pub overrides: OverrideView,
}

/// A room as one particular client is allowed to see it. Produced only by
/// `RoomState::snapshot_for` — there is no unfiltered `snapshot()`.
#[derive(Debug, Clone, Serialize)]
pub struct RoomView {
    pub map: MapInfo,
    /// The map the DM is preparing with its own walls and overrides, if there is
    /// one — and only if this view belongs to the DM. A player's copy is always
    /// `None`, which is also what "nothing is staged" looks like, so the two are
    /// indistinguishable from the client side. That is the point: invariant 4
    /// wants the next dungeon genuinely absent from a player's snapshot, not
    /// merely undrawn.
    ///
    /// One `None` now withholds three things rather than one, which is the whole
    /// reason the bundle is worth having: there is no second staged field to
    /// forget to filter.
    pub staged: Option<StagedView>,
    /// Already filtered *and* redacted: a token the table cannot see — hidden,
    /// or built on the next map and not here yet — is absent rather than
    /// flagged, and what survives carries only the fields this client may hold.
    pub tokens: Vec<TokenView>,
    /// Rows naming a token this client cannot see are gone from here, and
    /// `current` with them. A row the players can read but not explain is the
    /// bare id of the thing `hidden` was supposed to conceal.
    pub initiative: Initiative,
    /// Draw order, and already filtered: a shape anchored to a token this
    /// client cannot see is absent, because an aura on a hidden monster is that
    /// monster's position drawn in colour.
    ///
    /// Sketches are not here. One lasts as long as somebody is holding the
    /// mouse down, so a client that joins mid-sweep missing it is not a state
    /// to reconcile — it is a line that was about to vanish anyway.
    pub shapes: Vec<Shape>,
    /// The traced walls and doors — and **empty for a player, always**. Not
    /// sent-and-not-rendered: a player who could read these in devtools would
    /// have the dungeon's floor plan, which is precisely what fog will be
    /// hiding. Invariant 4, and the same door `staged` leaves by.
    ///
    /// Empty is therefore both "nothing traced" and "you are not the DM",
    /// indistinguishable from the client side.
    pub walls: Vec<Wall>,
    /// What the party can see and what they have explored, or `None` on a map
    /// with fog turned off.
    ///
    /// **The same value for everyone, and that is not an oversight.** Fog is
    /// party-shared, so there is one answer rather than one per client; the DM is
    /// sent it so their own board can show, faintly, what the table is looking
    /// at. It is the walls that stay DM-only — a player infers the geometry from
    /// the edges of this instead, which is the whole shape of the feature.
    ///
    /// Lives in `fog.rs` beside the two functions that pack and unpack it, unlike
    /// every other type here, because the encoding is the interesting part of it
    /// and splitting the two would leave a string nothing explains.
    pub fog: Option<FogView>,
    /// The cells the DM has overridden by hand — and **empty for a player,
    /// always**, exactly as `walls` is.
    ///
    /// It sits between its two neighbours and belongs with the first: the walls
    /// and this are what the DM authored, the fog is the shadow both of them cast.
    /// A player reads the result off `fog` above and is never told which parts of
    /// it were decided rather than computed.
    ///
    /// Empty is therefore both "nothing painted" and "you are not the DM". Same
    /// door `staged` and `walls` leave by.
    pub overrides: OverrideView,
    /// Whether the board writes each token's name under it.
    ///
    /// **The same value for everyone, like `fog` and unlike everything else here
    /// that only the DM may set.** Who may flip it is a permission; what it says
    /// is not a secret — a name the table can already read off their own
    /// initiative panel is not withheld by leaving it off the board, and the
    /// point of the switch is that the DM's board and theirs agree about what is
    /// written on it. Room-wide rather than per map: it is a fact about how
    /// tokens are labelled, and swapping the map is not a request to relabel them.
    pub show_names: bool,
    /// How the movement ruler charges a diagonal.
    ///
    /// **The same value for everyone, for the reason `show_names` above is.** It
    /// is a counting convention the table shares, so a client holding a different
    /// one from its neighbour is the only way this can be wrong.
    pub diagonals: Diagonals,
    /// Whether everybody's pointer is drawn on everybody's board.
    ///
    /// The third of these, and the same value for everyone for the same reason.
    /// It is on the view because a client reads it to decide whether to *send*
    /// — the only one of the three that governs traffic out as well as what is
    /// drawn — and a join that did not carry it would have every fresh page
    /// shipping cursors into a room that has switched them off.
    pub show_cursors: bool,
    /// Whether the DM's own pointer is drawn on the players' boards.
    ///
    /// **The narrower half of the switch above**, and the same value for
    /// everyone for the reason all five of these are: who may flip it is a
    /// permission and what it says is not a secret. A player never draws it
    /// themselves (they are sent no frame to draw), so this is on the view for
    /// the DM's own panel to read back — `show_cursors` above is on it for a
    /// second reason this one does not share, since nothing here changes what a
    /// client *sends*.
    pub show_dm_cursor: bool,
    /// The picture the table is looking at instead of the board, or `None` when
    /// they are looking at the board.
    ///
    /// **The fourth of these, and the same value for everyone**: the DM decides
    /// what is on the screens and nobody is being kept from anything. It is not a
    /// map and there is no `MapInfo` here — no grid, no walls, no fog, nothing to
    /// stand on — which is the whole reason the board underneath survives it.
    pub backdrop: Option<String>,
    /// Who is connected right now, the DM among them.
    ///
    /// **The same value for everyone**, which puts it with the two fields above
    /// rather than with the six below — there is no permission here and nothing
    /// to withhold: a table that cannot tell whether the DM is still on the other
    /// end of the line is the whole reason this exists.
    ///
    /// `Owner` rather than `RosterSlot`, unlike the identity picker's list, and
    /// that is the difference between the two: a slot cannot say "the DM", and
    /// the DM is the connection most worth knowing about. It also means
    /// `colourOf` and `nameOf` on the client resolve these with nothing further
    /// on the wire, which is the argument `Pinged` already made.
    ///
    /// **A set of identities and not a count.** Somebody on a laptop and a phone
    /// is one entry — `RosterSlot::claimed` says that arrangement is legitimate,
    /// so counting sockets would report seven people at a table of six.
    ///
    /// It is on the view as well as on `ServerMsg::Presence` so a join is filled
    /// in by the same path as every delta, which is invariant 3 — and it is what
    /// makes `Restored` right without a line of its own.
    pub here: Vec<Owner>,
    /// Which colour each player picked for themselves.
    ///
    /// **Public, unlike the scratchpad below**, and it is the first thing in this
    /// project a player may write that everybody else is then sent. That is not
    /// an oversight in the direction of the notes: everyone has to draw everyone
    /// else's pings and attribute everyone else's lines, so a colour that only
    /// its owner could see would not be a colour at all.
    ///
    /// A slot with no entry has not chosen, and the client's default for that
    /// slot stands — which is what keeps a room that predates this field looking
    /// exactly as it did.
    pub colours: Colours,
    /// What the DM's undo would take back, or `None` when there is nothing to
    /// take back — and **`None` for a player, always**, which is the walls' rule
    /// arriving for the fourth time.
    ///
    /// It is a label rather than a depth because that is the whole of what the
    /// button needs to say: with no redo, a press the DM cannot predict is
    /// unrecoverable, so the control names its next victim instead of counting
    /// them. `None` is therefore both "the ring holds only where you started"
    /// and "you are not the DM", indistinguishable from the client side.
    ///
    /// The ring itself never leaves the room. A client cannot undo twice without
    /// being told what the second press would do, and it is told by the
    /// `UndoChanged` that rides on the first.
    /// What has been said in this session that this client is party to.
    ///
    /// **The one field here that is genuinely different text per recipient
    /// rather than the same text filtered.** Every list above is the room's own
    /// with rows dropped out of it; two clients holding this hold two different
    /// conversations, because a whisper is only ever in the copies of the two
    /// people at either end of it. That is what refusing `tokio::sync::broadcast`
    /// bought, and this is the first thing to spend it.
    ///
    /// Oldest first, capped, and never on disk: it is session memory, so a
    /// browser hiccup mid-combat does not eat the initiative rolls and next game
    /// night starts empty. Invariant 3 matters more here than anywhere else in
    /// this struct — getting it wrong hands over somebody's words rather than a
    /// position.
    pub chat: Vec<ChatLine>,
    pub undo: Option<String>,
    /// This client's own scratchpad, and never anybody else's.
    ///
    /// **The second field here that is per-recipient content rather than the
    /// room's copy with rows dropped**, after `chat` above it — and the first
    /// one where the DM's copy is narrower than the room's rather than wider.
    /// Every other filter in this struct withholds downward; `notes_for` asks
    /// only whose box it is, and the DM has exactly one like everybody else.
    ///
    /// Empty is both "you have written nothing" and, for a client that has not
    /// claimed a slot, "there is no box to fill" — indistinguishable, and
    /// nothing downstream cares which.
    pub notes: String,
}

/// Inbound. Not `#[serde(default)]`: a malformed frame from a client should be
/// rejected, not silently filled in with zeroes.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    /// First frame on every connection. Sent again, with a chosen slot, after
    /// the player picks from the roster.
    Hello {
        dm_secret: Option<String>,
        player_id: Option<PlayerId>,
    },
    MoveToken {
        id: TokenId,
        x: f32,
        y: f32,
        dragging: bool,
        /// Which of the token's two positions this is: where it stands now, or
        /// where it lands when the staged map is promoted.
        ///
        /// Intent rides on the command rather than on a mode because the server
        /// does not know the DM is previewing and must not learn — preview is
        /// client-only state. DM-only, and refused when nothing is staged: a
        /// plan needs a map to be a plan about.
        staged: bool,
    },

    // The token lifecycle. All DM-only, including `owner` — handing a player a
    // token the DM built is how a wild shape reaches the table.
    /// Carries no id: that is the server's to invent, so two DMs on two tabs
    /// cannot propose the same one.
    CreateToken {
        name: String,
        img: String,
        size: f32,
        owner: Owner,
        /// Where it lands, in grid units. Snapped like any other drop.
        x: f32,
        y: f32,
        /// Built out of sight of the table. The ambush that is already in place
        /// when the party walks in is one command, not a create and a hide.
        hidden: bool,
        hp: Option<Hp>,
        /// How far this token lights the board, or `None` for one carrying no
        /// light. A brazier is built in one command like the ambush above it.
        light_ft: Option<f32>,
        /// Built on the map the DM is preparing rather than on the board: `x, y`
        /// becomes the token's plan and it does not exist for the table, or for
        /// the DM's own live board, until the promote.
        ///
        /// The same flag `SetMap` and `MoveToken` carry, naming the same slot.
        staged: bool,
    },
    /// Every editable field at once, the way `SetMap` carries the whole grid.
    /// Position is deliberately absent — `MoveToken` owns that, and an edit made
    /// from a panel must not drag a token out from under whoever is moving it.
    ///
    /// `hidden` and `hp` are editable fields like the rest. Taking damage is
    /// this command with a new `hp`, which is why there is no `SetHp`: it would
    /// carry one field of the five the panel already sends together.
    ///
    /// No `staged` flag, unlike its two neighbours. Every field here is shared
    /// by both boards — nobody wants a goblin with different art on two maps —
    /// so an edit applies immediately and everywhere, which is the honest
    /// behaviour rather than a special case. Only position and existence fork.
    UpdateToken {
        id: TokenId,
        name: String,
        img: String,
        size: f32,
        owner: Owner,
        hidden: bool,
        hp: Option<Hp>,
        /// Shared by both boards like every other field here: a lantern is a
        /// fact about the creature and not about which map it is standing on.
        light_ft: Option<f32>,
    },
    DeleteToken {
        id: TokenId,
    },
    /// Whether the board writes each token's name under it. DM-only, and the one
    /// command in this block that is about no particular token.
    ///
    /// Its own command rather than a field on `SetMap`, which is where `fog`
    /// went: this belongs to the room and not to the image, so riding on a map
    /// change would fork it between the two slots and reset it every time the DM
    /// loaded a dungeon. It is not on `UpdateToken` either, for the mirror of
    /// that reason — there is one answer for the board, not one per creature.
    SetShowNames {
        show: bool,
    },
    /// How the movement ruler charges a diagonal. DM-only, and `SetShowNames`'s
    /// neighbour in every respect: room-wide, about no particular token, and not
    /// a field on `SetMap` because the table's counting outlives the dungeon.
    SetDiagonals {
        diagonals: Diagonals,
    },

    /// Whether everybody's pointer is drawn on everybody's board. DM-only, and
    /// `SetShowNames`' neighbour for the third time: room-wide, about no
    /// particular token, and not a field on `SetMap` because how much the table
    /// wants on their screens outlives the dungeon.
    ///
    /// **What it switches off is the relay and not the drawing.** Seven pointers
    /// twitching over a board that already carries tokens, nameplates, hit point
    /// bars, rulers, trails, shapes and fog is a real cost against a real
    /// benefit, and when the table decides against it the traffic should stop
    /// too — a switch that left `MoveCursor` flowing and merely declined to draw
    /// the result would be the one control here that costs what it claims to
    /// save.
    SetShowCursors {
        show: bool,
    },

    /// Whether the DM's own pointer is drawn on the players' boards. DM-only,
    /// and the narrower half of the switch above it.
    ///
    /// **It stops the relay of one client's pointer, not the drawing and not
    /// the sending.** That is the one thing it does not share with
    /// `SetShowCursors`: switching every pointer off is a dial on the busiest
    /// message in the protocol, and switching off the DM's alone is one client
    /// in seven, so buying it a second condition at the send site would cost a
    /// branch to save nothing measurable. The room drops the frame in
    /// `cursor_seen`, which is where the DM's pointer is already withheld over
    /// unexplored ground — this widens that from "the dark" to "everywhere".
    ///
    /// A DM who wants their hand off the table's screens while the party is
    /// deciding something, without taking the other six pointers away from each
    /// other, is the whole of what it is for.
    SetShowDmCursor {
        show: bool,
    },

    /// Put a picture in front of the table, or take it away. DM-only.
    ///
    /// `SetShowNames`' neighbour for the fourth time — room-wide, about no
    /// particular token, not a field on `SetMap` — and the fourth reason is the
    /// sharpest of them. Riding on `SetMap` would make showing a picture a *map
    /// load*, and a map load sweeps the walls, the drawings and everywhere the
    /// party has explored. That none of that happens is the whole command.
    ///
    /// One field and not two. `None` is "put it away", and re-showing is two
    /// clicks in the picker — a remembered URL beside a shown/hidden flag would
    /// be a second thing to keep in step, for nothing.
    SetBackdrop {
        /// Where the picture is served, or `None` for the board.
        url: Option<String>,
    },

    /// The map image and its grid, in one command. DM-only.
    ///
    /// Uploading a new map and calibrating the grid on the current one are the
    /// same message — a calibration simply repeats the URL it already had. Two
    /// commands would only differ in which fields they left alone.
    SetMap {
        url: String,
        grid_px: f32,
        offset_x: f32,
        offset_y: f32,
        grid_color: String,
        play_area: Option<Rect>,
        /// Whether this map is fogged, how far a token sees on it, and how that
        /// sight is worked out.
        ///
        /// Here rather than on a command of their own for the reason the grid
        /// colour is here: they are fields of `MapInfo`, they are remembered per
        /// URL with the rest of the calibration, and a `SetFog` would be a second
        /// way to write one map that could arrive out of order with this one.
        fog: bool,
        vision_ft: f32,
        lighting: Lighting,
        /// What shape this map's cells are. Here for the same reason as the
        /// three above: it is a field of `MapInfo` and is remembered per URL
        /// with the rest of the calibration, so it rides on the one command
        /// that writes a calibration rather than racing a second one.
        grid_shape: GridShape,
        /// Which slot this is about: the board the table is looking at, or the
        /// one the DM is preparing.
        ///
        /// It names the slot and nothing else. The rule that a URL alone decides
        /// between loading a map and recalibrating one is unchanged — this only
        /// says which slot's URL that comparison runs against, and an empty
        /// staged slot is therefore always a load.
        staged: bool,
    },
    /// The staged map becomes the board, and every plan made on it comes true.
    /// DM-only, and refused when nothing is staged rather than quietly doing
    /// nothing.
    ///
    /// A token with no plan keeps its grid coordinates and the DM repositions
    /// it: cells mean nothing across two unrelated images, and pretending
    /// otherwise would move tokens for reasons nobody asked for. A plan is how
    /// the DM says where one should land instead.
    PromoteStaged,
    /// Throw the staged map away, and the plans made on it with it. DM-only.
    ClearStaged,

    // Drawing. Anyone may draw — this is the first part of the room a player
    // can add to.
    /// A shape being swept out right now, relayed to everyone watching and
    /// stored by nobody. `drawing: false` is the release that ends it.
    ///
    /// The `dragging` shape one scale up: in-flight frames are throttled
    /// client-side, never reach the sender back, and are not worth a disk write.
    /// What a release *means* is the client's business — the measuring tool
    /// stops here and the area tools follow with an `AddShape`. The server is
    /// uniform over all four kinds and never learns which tool was in hand, the
    /// same way it never learns the DM is previewing.
    ///
    /// It carries no anchor. A sketch lives for a second or two, during which
    /// nothing it could anchor to is going anywhere, so absolute cells say
    /// everything and the anchor is a question only a kept shape has to answer.
    Sketch {
        kind: ShapeKind,
        at: Pos,
        to: Pos,
        color: String,
        drawing: bool,
    },
    /// Keep the shape just swept out. Carries no id — that is the server's to
    /// invent, like a token's.
    AddShape {
        kind: ShapeKind,
        from: Origin,
        to: Pos,
        color: String,
    },
    /// Whoever drew it, or the DM. Not a permission a player has anywhere else,
    /// and the reason `Shape::by` is stored at all.
    RemoveShape {
        id: ShapeId,
    },
    /// Sweep the board. DM-only: it reaches into five other people's drawings.
    ClearShapes,

    /// Look here. A ring on everyone's board where this lands, for a second or
    /// two, and then nothing.
    ///
    /// `Sketch` with the state turned all the way down, and the comparison is
    /// worth making because of what is *missing* against it. There is no
    /// `drawing` flag, because a ping is one frame rather than a stream — the
    /// gesture is a hold and the hold is over by the time this is sent. There is
    /// no `kind` and no `color`: what it looks like is decided by who sent it,
    /// which every client can work out for itself from the roster it already
    /// holds. And there is no anchor for the reason a sketch has none, one scale
    /// smaller: a ping outlives nothing.
    ///
    /// **It is not gated on the fog**, which makes it the one thing in this
    /// project the table is shown over ground they have never explored. That is
    /// safe precisely because there is nothing in it to read but a position — a
    /// ring over black says somebody is gesturing in a direction, not what is
    /// standing there — and the alternative is a deliberate 400ms gesture that
    /// silently does nothing. See *Ping* in `docs/drawings.md`.
    Ping {
        at: Pos,
    },

    /// Where this client's pointer is now, in grid units.
    ///
    /// **`Ping`'s shape with the ephemerality turned all the way up, and its
    /// deliberateness turned all the way down** — which is the whole difference
    /// between the two and decides everything else about this one. A ping is a
    /// 400ms gesture somebody chose to make; this is where a hand happens to be,
    /// sent whenever it moves and true of nothing a moment later.
    ///
    /// It carries no sender for `Say`'s reason, no colour for `Ping`'s, and no
    /// `drawing` flag because there is no stream to close: stillness ends a
    /// cursor, and the client that stopped moving says nothing at all. Nothing
    /// in the room remembers one arrived.
    ///
    /// **The busiest command in this protocol by an order of magnitude.** Drag
    /// frames exist while a token is moving; these exist whenever anybody's hand
    /// is on the mouse. Throttled to ~30Hz on the client and sent only on
    /// movement, which at seven clients is still nothing at this scale — but it
    /// is the first message here where that sentence has to be said out loud
    /// rather than assumed, and it is why the room's switch stops the *relay*
    /// rather than only the drawing.
    MoveCursor {
        at: Pos,
    },

    /// Say something: to the table, or to one person.
    ///
    /// **One command for both, because a whisper and a shout differ only in
    /// where they are going.** Two commands would be one field's worth of
    /// difference and two permission checks to keep in step, and the destination
    /// is exactly the thing the check is about: a player may name the table or
    /// the DM, and the DM may name the table or a player. Nobody may name
    /// another player, which is the whole boundary of the feature.
    ///
    /// It carries no sender. Who said it is what the socket already proved, and
    /// a `by` on the wire is a field a client could lie in.
    Say {
        to: ChatTo,
        text: String,
    },

    /// Throw `count` dice of `sides` faces, and say the result to `to`.
    ///
    /// **The loaner die: a bag of plastic for whoever came without one.** It
    /// produces an ordinary `ChatLine` and the existing `Event::Said`, so there
    /// is no `ServerMsg` beside this, no new event, and no new visibility rule —
    /// `party_to` already decides who is party to a line, and a private roll to
    /// the DM costs nothing because `to` was going to be here anyway.
    ///
    /// It carries no sender, exactly as `Say` does not, and the room does the
    /// throwing: a number a client rolled for itself is one it could throw again
    /// until it liked the answer.
    ///
    /// `sides` is checked against a closed set and `count` against a cap, the
    /// way `Token::size` is checked against `TOKEN_SIZES`. There is no modifier
    /// and no expression here and there must not be: counts are what a dice bag
    /// has and arithmetic is where a character sheet starts. See `docs/dice.md`.
    Roll {
        sides: u8,
        count: u8,
        to: ChatTo,
    },

    /// Replace this client's own scratchpad with `text`.
    ///
    /// **It carries no key, and that is the whole security of the feature.** A
    /// key a client could name is a key it could name somebody *else's* with —
    /// so whose box this is comes from the socket, exactly as `Say`'s sender
    /// does, and there is no argument here for a server to validate.
    ///
    /// The whole box every time rather than an edit or a diff. It is one string
    /// of a few thousand characters that changes when somebody stops typing, so
    /// a patch format would be machinery bought with nothing.
    SetNotes {
        text: String,
    },

    /// Pick the colour this client's rings and lines are drawn in.
    ///
    /// **It carries no key either**, and that is the same rule for the third
    /// time: whose colour this is comes from the socket, exactly as `Say`'s
    /// sender and `SetNotes`' box do. A key a client could name is a key it
    /// could name somebody else's with.
    ///
    /// **An index into a closed palette rather than free hex**, and the reason
    /// is on the board rather than in the protocol. `pings.ts` records that its
    /// six hues deliberately avoid the token ring vocabulary in `render.ts` —
    /// gold is ownership, blue is in progress, white is the turn, violet is
    /// hidden, teal is staged-only. A player who could send `#d4af37` could
    /// make their own ring lie about who owns a creature, which is the board
    /// saying something false. So the set is closed and the bound is `PALETTE`,
    /// checked here the way a token's size is.
    ///
    /// **The DM may not send it.** Their hue sits outside the six on purpose —
    /// it is the one ring at the table that is not a player's — and a DM who
    /// took a player's colour would erase that. Refused rather than merely
    /// unbuilt on their client, because a rule only the UI keeps is not a rule.
    SetColour {
        colour: u8,
    },

    // Walls and doors. All DM-only, and unlike the drawings above, invisible to
    // everyone else — a player is not told these commands happened at all.
    //
    // **Every one of them names a slot**, which is the `SetMap` / `MoveToken` /
    // `CreateToken` pattern for the fourth time and for the same reason: preview
    // is client-only and the server must not learn the DM is in it, so the
    // intent rides on the command rather than on a mode. On the two that carry
    // an id the flag is strictly redundant — ids are UUIDs and could be looked
    // up in both lists — and it is here anyway, because a lookup that searches
    // both is a lookup that can erase a live wall while the DM is looking at the
    // staged board.
    /// One traced run, in image pixels: `points` are its corners in order, and
    /// the segments between them become that many walls.
    ///
    /// The run is how the DM authors and not how the room stores. Sending the
    /// whole polyline in one command rather than a segment per click is the
    /// point of the milestone — a two-hundred-segment dungeon is two hundred
    /// round trips otherwise — and it is where the ids get invented, like a
    /// token's or a shape's.
    ///
    /// `door` applies to every segment of the run. A door is normally a single
    /// segment across an opening; nothing here enforces that, because "how wide
    /// is a door" is the DM's business.
    AddWalls {
        points: Vec<Px>,
        door: bool,
        staged: bool,
    },
    /// One segment. There is no "erase this run" — the run stopped existing the
    /// moment it was stored, which is what makes fixing one bad segment of a
    /// long trace possible without redrawing it.
    RemoveWall {
        id: WallId,
        staged: bool,
    },
    /// Open or shut a door. Refused on masonry, the way a command naming a token
    /// that does not exist is refused.
    ///
    /// On the live board this is a play-time action — the party opens a door
    /// mid-fight. On the staged board it is authoring: a door left open is the
    /// door the party finds open when the map lands, which is how the DM says
    /// "this one is already ajar" in advance.
    ToggleDoor {
        id: WallId,
        staged: bool,
    },
    /// Every wall on one board. DM-only like the rest, and unlike `ClearShapes`
    /// it reaches into nobody else's work — it is all the DM's.
    ClearWalls {
        staged: bool,
    },

    // The manual fog override. DM-only, like the walls it is stored beside.
    /// Says one thing about a set of cells: force them explored, force them lit,
    /// force them dark, or hand them back to the rays.
    ///
    /// **The cells are the payload, not a seed to flood-fill from.** The DM's
    /// client already holds the walls and already has to compute the fill to
    /// preview it; sending the previewed cells is what makes the preview and the
    /// result the same object rather than two runs of two implementations that
    /// have to agree. Nothing is being adjudicated here — the DM may reveal
    /// whatever they like — so the server stores what it is told, having clipped
    /// it to the board and counted it.
    ///
    /// A brush and a fill send the same frame; the only difference is which cells
    /// end up in it.
    ///
    /// `staged` names the board, like the wall commands above. Painting the
    /// staged one is not previewing what the party will see there — there is no
    /// staged fog to preview — it is deciding in advance what they are handed
    /// the moment the map is promoted.
    SetFogOverride {
        cells: Vec<Cell>,
        /// `None` hands the cells back to line of sight. Null rather than a
        /// fourth variant, because "no override" is the absence of one — the same
        /// thing the room stores by removing the entry.
        state: Option<Override>,
        staged: bool,
    },
    /// The fog back to the start of the evening: every override cleared *and*
    /// everywhere the party has explored forgotten, then line of sight recomputed
    /// from where the tokens are standing right now.
    ///
    /// Both halves in one command because they are one gesture — "this map has
    /// not been seen yet" — and splitting them would offer a reset that leaves the
    /// map lit, which is the state nobody asks for. It is not `ClearWalls`'s
    /// neighbour any more for exactly that reason: the walls are all the DM's
    /// work, and half of this is the party's.
    ResetFog,

    // Initiative. All DM-only.
    /// Adds the token at that value, or re-values it if already listed. One
    /// command covers "add" and "reorder", since ordering *is* the value.
    SetInitiative {
        token: TokenId,
        value: i32,
    },
    RemoveFromInitiative {
        token: TokenId,
    },
    ClearInitiative,
    NextTurn,
    PreviousTurn,

    /// Put the room back the way it was before the last thing that changed it.
    /// DM-only, and the one command here that names no subsystem — it is about
    /// the room's recent history rather than about any part of it.
    ///
    /// Carries nothing at all, not even how far back to go. The ring lives in
    /// the room and only its top is undoable, so a depth on the wire would be a
    /// number the server had to check against a stack the client cannot see —
    /// and a client that undoes twice does so by sending this twice, which is
    /// also what keeps each step's label honest.
    Undo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Sent to a connection that has not established an identity. Deliberately
    /// carries no room state — invariant 4 means an unidentified client is told
    /// nothing about the world, not merely prevented from changing it.
    ///
    /// Re-sent to everyone still choosing whenever a slot is taken or freed, so
    /// a picker left open does not go stale.
    ChooseIdentity {
        roster: Vec<RosterSlot>,
    },
    Welcome {
        your_id: ClientId,
        is_dm: bool,
        /// `None` for the DM, who occupies no roster slot.
        player_id: Option<PlayerId>,
        /// Boxed, and invisibly so — serde sees straight through it, and the
        /// frame on the wire is unchanged.
        ///
        /// Every `ServerMsg` in every client's mailbox is sized at the largest
        /// variant, and there are 256 slots per client. This one is sent exactly
        /// once per connection, so keeping the whole world out of the size of a
        /// token move costs one allocation on join.
        state: Box<RoomView>,
        /// Who the DM can hand a token to.
        ///
        /// Not on `RoomView`, and deliberately not `RosterSlot`: this is the
        /// cast list, not who is connected, so there is nothing here to go
        /// stale between deltas. A player is sent it too — they were offered
        /// the same names by the picker — so it is not a filtered field
        /// pretending to be one.
        roster: Vec<RosterEntry>,
    },
    TokenMoved {
        id: TokenId,
        x: f32,
        y: f32,
        dragging: bool,
        /// Which position this frame is: the token's, or its plan for the staged
        /// map. The DM's client has to know which of the two to write, and a
        /// frame carrying a plan reaches nobody else.
        staged: bool,
    },
    /// A token that was created or edited — one message for both, because the
    /// client's answer to each is the same: take this token as the truth for
    /// this id. A `TokenChanged` for an id the client has never seen is the
    /// creation, and no separate `TokenAdded` has to be kept in step with it.
    ///
    /// A `TokenView`, not a `Token`: this is also the frame a player's copy of a
    /// token is redacted out of.
    TokenChanged {
        token: TokenView,
    },
    /// Deleted — or hidden, which is the same news to a client that is not
    /// allowed to know the difference. That is the whole reason the room's
    /// `Event` carries an id and this carries a token: one `TokenChanged` event
    /// becomes this message for the table and a `TokenChanged` for the DM.
    TokenRemoved {
        id: TokenId,
    },
    /// The whole `MapInfo`, for the same reason `InitiativeChanged` carries the
    /// whole panel: it is four fields and only a deliberate DM action moves it.
    MapChanged {
        map: MapInfo,
    },
    /// The board now writes token names under them, or it does not.
    ///
    /// **Identical for every recipient, which makes it `FogChanged`'s neighbour
    /// rather than `WallsChanged`'s** — the DM decides it and everyone is told,
    /// because the whole point is that one board is not labelled differently from
    /// another. Echoed to the DM who sent it, like `MapChanged`: nothing here is
    /// predicted locally, so this frame is how their own checkbox settles.
    NamesChanged {
        show: bool,
    },
    /// The ruler counts diagonals differently now.
    ///
    /// `NamesChanged`'s neighbour and `FogChanged`'s: identical for every
    /// recipient, echoed to the DM who sent it. A client left holding the old
    /// convention would read a different number off the same move than the
    /// person beside it, which is the one failure this message exists to prevent.
    DiagonalsChanged {
        diagonals: Diagonals,
    },

    /// There is a picture in front of the table now, or there is not.
    ///
    /// `NamesChanged`'s neighbour for the reason it is `FogChanged`'s: identical
    /// for every recipient, no filter, echoed to the DM who sent it. **Nothing
    /// travels with it** — the board is not being changed, it is being covered,
    /// so no map, wall, shape or fog frame accompanies this one and none is owed.
    BackdropChanged {
        url: Option<String>,
    },

    /// Pointers are drawn on every board now, or they are not.
    ///
    /// The two frames above it in every respect: identical for every recipient,
    /// no filter, echoed to the DM who flipped it. What is different is what a
    /// client does about it — this is the one of the three that changes what a
    /// client *sends*, because the room stops relaying cursors and a client that
    /// went on shipping them would be paying the whole cost of a feature nobody
    /// at the table can see.
    CursorsChanged {
        show: bool,
    },
    /// The DM's pointer is drawn on the players' boards now, or it is not.
    ///
    /// **The frame above it, minus the second job.** `CursorsChanged` changes
    /// what a client sends; this one changes only what the room relays, so a
    /// player receiving it has nothing to do about it — it is sent to everyone
    /// anyway, because the panel that reads it back is the DM's second tab and
    /// the value is nobody's secret.
    DmCursorChanged {
        show: bool,
    },
    /// Somebody joined or left. The whole list, because it is at most seven
    /// names and nothing is predicted locally.
    ///
    /// **`NamesChanged`'s shape rather than `WallsChanged`'s**: identical for
    /// every recipient, no filter, no permission — and unlike either of them,
    /// nobody sent a command to cause it. It is dispatched from the two places
    /// the socket table changes, which is why it is the one message in this enum
    /// that never rides beside a disk write: who happens to be connected is not
    /// part of the room.
    ///
    /// Sent whenever a connection is claimed or lost rather than only when the
    /// list differs. A second connection as the same person changes nothing, and
    /// a frame saying what the client already holds is a repaint of the same
    /// chips.
    Presence {
        here: Vec<Owner>,
    },
    /// A player picked their colour. The whole table, for `Presence`'s reason.
    ///
    /// Its neighbour above in every respect that matters — identical for every
    /// recipient, no filter — and the difference is that a *player* caused this
    /// one. It is the first frame in this protocol carrying something a player
    /// wrote to everybody else, which is the axis a colour differs from a
    /// scratchpad on: both are yours to set, and only one of them is any use if
    /// nobody else can see it.
    ///
    /// **The sender is echoed**, like `NamesChanged` and unlike `NotesChanged`.
    /// There is no caret to move and nothing was drawn locally, so this frame is
    /// how the chosen swatch settles on the client that chose it.
    ColoursChanged {
        colours: Colours,
    },
    /// The staged board — its map, its walls and its paint — or `None` once
    /// there is not one. Reaches the DM and nobody else; this is the first
    /// message that exists for one identity rather than for one action.
    ///
    /// One message covers staging, recalibrating, discarding, and the slot
    /// emptying on a promote, for the same reason `TokenChanged` covers both
    /// creation and editing: two messages would have to be kept in step, and
    /// the client's answer to all four is the same — this is the staged slot now.
    ///
    /// **Carrying the whole board rather than the map is what keeps that true
    /// now that the slot holds three things.** A staged load sweeps its walls
    /// and a staged recalibration drops its paint; both are already described
    /// here, so neither needs a `WallsChanged` or an `OverridesChanged` of its
    /// own — and there is therefore none to forget.
    StagedChanged {
        board: Option<StagedView>,
    },
    /// The whole panel, not a per-entry delta. It is a handful of rows and only
    /// changes on a deliberate DM action, so a diff would cost more than it saves.
    ///
    /// Built per recipient: a hidden creature's row is not in the copy the table
    /// receives, so the DM's panel and the players' genuinely differ.
    InitiativeChanged {
        initiative: Initiative,
    },
    /// Somebody else's in-progress sweep. `by` is their connection, which is
    /// what a client keys the drawing on — one sweep per socket, so a DM with
    /// two tabs open can be measuring two things at once and both are drawn.
    ///
    /// Never sent back to the client doing the sweeping: they are already
    /// drawing it from their own pointer, and echoing it is the rubber-banding
    /// that `TokenMoved` avoids for the same reason.
    Sketch {
        by: ClientId,
        kind: ShapeKind,
        at: Pos,
        to: Pos,
        color: String,
    },
    /// That sweep is over — released, or the client holding it went away.
    ///
    /// The second case is why this exists rather than a client-side timeout:
    /// the room is told when a socket closes, so it can say so. A movement
    /// ruler has to guess, because nothing announces that a drag stopped.
    SketchEnded {
        by: ClientId,
    },
    /// Every shape this client may see. The whole list rather than a per-shape
    /// delta, for the reason `InitiativeChanged` carries the whole panel: it is
    /// a handful of entries that only change on a deliberate act.
    ///
    /// Built per recipient, and that is load-bearing rather than tidy — hiding
    /// a monster takes the aura anchored to it off the table's board and leaves
    /// it on the DM's, from this one message.
    ShapesChanged {
        shapes: Vec<Shape>,
    },
    /// Every wall the DM has traced. The whole list rather than a delta, for the
    /// reason `ShapesChanged` carries the whole list — except that this one only
    /// ever has one recipient.
    ///
    /// **It reaches the DM or nobody.** Not an empty list for the players: a
    /// frame they cannot use still tells them the DM just did something, and
    /// invariant 4 is about what a client may know. That is `TokenPlanChanged`'s
    /// rule, arriving for the second time.
    ///
    /// `staged` says which board's list this is, because there are two now and
    /// the whole frame is a replacement rather than a delta. It is the same word
    /// the command carried, handed back — the DM's client does not infer which
    /// list it just changed from which one it is looking at, because a promote
    /// can move the board out from under a frame in flight.
    WallsChanged {
        walls: Vec<Wall>,
        staged: bool,
    },
    /// What the party can see now, and everywhere they have been. `None` once the
    /// map is not fogged, which is also what a map that never was looks like.
    ///
    /// The one filtered-looking frame that is identical for every recipient: fog
    /// is party-shared, so there is nothing per-client in it to build. The DM
    /// gets it to draw faintly over their own board.
    ///
    /// Sent on a drop and never on a drag frame. The shadow of a party walking a
    /// corridor is worth a few kilobytes when they arrive somewhere and is not
    /// worth thirty a second on the way.
    FogChanged {
        fog: Option<FogView>,
    },
    /// Every cell the DM has overridden by hand, packed. The whole rectangle
    /// rather than a delta, for the reason `WallsChanged` carries the whole list.
    ///
    /// **It reaches the DM or nobody**, and it is the third message to have that
    /// rule. What the table is owed arrives in the `FogChanged` above it, which is
    /// the difference this made rather than the decision behind it.
    ///
    /// `staged` names the board for the reason `WallsChanged` above carries one.
    OverridesChanged {
        overrides: OverrideView,
        staged: bool,
    },

    /// Somebody pinged. Draw a ring there for a second or two.
    ///
    /// `by` is an `Owner` and not a `ClientId`, which is the one place this
    /// differs from `Sketch` above and the difference is deliberate. A sketch is
    /// keyed by connection because the recipient has to *replace* the previous
    /// frame from that socket and end it on release; a ping replaces nothing and
    /// ends by itself, so what the recipient needs is not which socket sent it
    /// but whose ring to draw. `Owner` is what the roster resolves to a name and
    /// a colour, and it is the pair a whisper will be attributed with.
    ///
    /// Not sent back to the pinger, for `Sketch`'s reason twice over: their ring
    /// has been on their own screen since the hold was 150ms old, and a copy
    /// arriving a round trip later would restart it.
    ///
    /// **Sent to everyone else regardless of the fog.** The only message in this
    /// file with a position in it that no visibility filter touches.
    Pinged {
        by: Owner,
        at: Pos,
    },

    /// Somebody's pointer is here now. Draw it until it stops arriving.
    ///
    /// `Pinged`'s twin above in everything it carries — an `Owner` rather than a
    /// `ClientId`, for the identical reason, and not echoed to the hand that
    /// moved — and its opposite in one respect that matters more than any of
    /// them: **this one is filtered.**
    ///
    /// **The DM's pointer is withheld from a player when it is over ground the
    /// party has not explored.** A ping is a deliberate gesture and a ring over
    /// black says only that somebody is pointing in a direction; a cursor is
    /// nobody's decision, and the DM's hand *lingers where the DM is working* —
    /// over the ambush in the unlit chamber, over the creature the table cannot
    /// see. That is the one thing in this frame worth reading, so it is the one
    /// case the filter exists for. A player's cursor is relayed wherever it
    /// goes, and the DM is sent every one of them: they can see the whole board
    /// already.
    CursorMoved {
        by: Owner,
        at: Pos,
    },

    /// Somebody said something you are party to.
    ///
    /// **Sent to the sender as well**, which is where this parts company with
    /// `Pinged` and `Sketch` directly above it. Those two are drawn on the
    /// sender's own screen before the frame ever leaves, so an echo restarts an
    /// animation; a line of text is not predicted locally at all, because the
    /// log is a *sequence* and the room is what decides where in it this lands.
    /// A client that appended its own would have two orderings to reconcile the
    /// first time two people typed at once.
    ///
    /// Withheld whole from anyone not party to it — there is no redacted form of
    /// a whisper, so this travels like `WallsChanged` rather than like
    /// `FogChanged`. What is new is that the rule is no longer about identity:
    /// this is the first frame withheld from one *player* and sent to another.
    Said {
        line: ChatLine,
    },

    /// Your scratchpad now reads this.
    ///
    /// **The first message in this file the DM is not entitled to**, and it is
    /// worth pausing on: every other rule here separates the DM from the table,
    /// and this one has no `is_dm` in it at all. It reaches the author and
    /// nobody — a scratchpad somebody else's client can open is not a
    /// scratchpad.
    ///
    /// Not sent back to the socket that typed it, which is `Sketch`'s and
    /// `Pinged`'s rule rather than `Said`'s: what would arrive is the text
    /// already in the box, a round trip later, and writing it back mid-sentence
    /// moves the caret. What it *is* for is the author's second tab, which holds
    /// a box that would otherwise be showing a paragraph that no longer exists.
    NotesChanged {
        text: String,
    },

    /// The room was put back to an earlier state — take this as the truth for
    /// all of it.
    ///
    /// **The whole world rather than a diff, and that is the feature working
    /// rather than giving up.** An undo restores a snapshot, and the one thing
    /// the room genuinely cannot describe as a delta is `sweep_board`: a map
    /// load destroys the walls, the shapes and the fog together, so the inverse
    /// of it is most of a second state model. Re-sending everything costs one
    /// frame on a deliberate DM action and no machinery at all.
    ///
    /// A `RoomView` like `Welcome`'s and built by the same `snapshot_for`, so a
    /// restore is filtered exactly as a join is — invariant 3, on the one
    /// message that would otherwise be a second place to get it wrong. Boxed for
    /// `Welcome`'s reason: every message in every client's mailbox is sized at
    /// the largest variant.
    ///
    /// It is a separate message from `Welcome` rather than a second one of
    /// those, and the reason is on the client: `onWelcome` *builds* the panels,
    /// the tools and the board, once, on the assumption there is exactly one per
    /// connection. This one only hands over state. No `your_id`, no `is_dm`, no
    /// roster — identity is settled by the socket and cannot change under it,
    /// and an undo cannot edit the cast list.
    Restored {
        state: Box<RoomView>,
    },
    /// What the DM's undo would take back now, or `None` for nothing.
    ///
    /// **It reaches the DM or nobody**, the fourth message with that rule — and
    /// the first one where the reason is not secrecy but relevance: a player has
    /// no undo button for this to label. `RoomView::undo` is the same value on
    /// join, and this is how it changes afterwards.
    ///
    /// Rides alongside every command that adds a step and every undo that takes
    /// one away, which is the same pairing `OverridesChanged` and `FogChanged`
    /// have — the state changed, and so did what the DM could say about it next.
    UndoChanged {
        label: Option<String>,
    },

    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The tag of every variant, and the compiler is what keeps the list whole.
    ///
    /// A `match` with no wildcard: adding a variant to the enum stops this file
    /// compiling until it is named here, which is the only enforcement available
    /// when the other copy of the union is in another language.
    fn client_tag(msg: &ClientMsg) -> &'static str {
        match msg {
            ClientMsg::Hello { .. } => "hello",
            ClientMsg::MoveToken { .. } => "move_token",
            ClientMsg::CreateToken { .. } => "create_token",
            ClientMsg::UpdateToken { .. } => "update_token",
            ClientMsg::DeleteToken { .. } => "delete_token",
            ClientMsg::SetShowNames { .. } => "set_show_names",
            ClientMsg::SetDiagonals { .. } => "set_diagonals",
            ClientMsg::SetShowCursors { .. } => "set_show_cursors",
            ClientMsg::SetShowDmCursor { .. } => "set_show_dm_cursor",
            ClientMsg::SetBackdrop { .. } => "set_backdrop",
            ClientMsg::SetMap { .. } => "set_map",
            ClientMsg::PromoteStaged => "promote_staged",
            ClientMsg::ClearStaged => "clear_staged",
            ClientMsg::Sketch { .. } => "sketch",
            ClientMsg::AddShape { .. } => "add_shape",
            ClientMsg::RemoveShape { .. } => "remove_shape",
            ClientMsg::ClearShapes => "clear_shapes",
            ClientMsg::Ping { .. } => "ping",
            ClientMsg::MoveCursor { .. } => "move_cursor",
            ClientMsg::Say { .. } => "say",
            ClientMsg::Roll { .. } => "roll",
            ClientMsg::SetNotes { .. } => "set_notes",
            ClientMsg::SetColour { .. } => "set_colour",
            ClientMsg::AddWalls { .. } => "add_walls",
            ClientMsg::RemoveWall { .. } => "remove_wall",
            ClientMsg::ToggleDoor { .. } => "toggle_door",
            ClientMsg::ClearWalls { .. } => "clear_walls",
            ClientMsg::SetFogOverride { .. } => "set_fog_override",
            ClientMsg::ResetFog => "reset_fog",
            ClientMsg::SetInitiative { .. } => "set_initiative",
            ClientMsg::RemoveFromInitiative { .. } => "remove_from_initiative",
            ClientMsg::ClearInitiative => "clear_initiative",
            ClientMsg::NextTurn => "next_turn",
            ClientMsg::PreviousTurn => "previous_turn",
            ClientMsg::Undo => "undo",
        }
    }

    fn server_tag(msg: &ServerMsg) -> &'static str {
        match msg {
            ServerMsg::ChooseIdentity { .. } => "choose_identity",
            ServerMsg::Welcome { .. } => "welcome",
            ServerMsg::TokenMoved { .. } => "token_moved",
            ServerMsg::TokenChanged { .. } => "token_changed",
            ServerMsg::TokenRemoved { .. } => "token_removed",
            ServerMsg::MapChanged { .. } => "map_changed",
            ServerMsg::NamesChanged { .. } => "names_changed",
            ServerMsg::DiagonalsChanged { .. } => "diagonals_changed",
            ServerMsg::BackdropChanged { .. } => "backdrop_changed",
            ServerMsg::CursorsChanged { .. } => "cursors_changed",
            ServerMsg::DmCursorChanged { .. } => "dm_cursor_changed",
            ServerMsg::Presence { .. } => "presence",
            ServerMsg::ColoursChanged { .. } => "colours_changed",
            ServerMsg::StagedChanged { .. } => "staged_changed",
            ServerMsg::InitiativeChanged { .. } => "initiative_changed",
            ServerMsg::Sketch { .. } => "sketch",
            ServerMsg::SketchEnded { .. } => "sketch_ended",
            ServerMsg::ShapesChanged { .. } => "shapes_changed",
            ServerMsg::WallsChanged { .. } => "walls_changed",
            ServerMsg::FogChanged { .. } => "fog_changed",
            ServerMsg::OverridesChanged { .. } => "overrides_changed",
            ServerMsg::Pinged { .. } => "pinged",
            ServerMsg::CursorMoved { .. } => "cursor_moved",
            ServerMsg::Said { .. } => "said",
            ServerMsg::NotesChanged { .. } => "notes_changed",
            ServerMsg::Restored { .. } => "restored",
            ServerMsg::UndoChanged { .. } => "undo_changed",
            ServerMsg::Error { .. } => "error",
        }
    }

    /// The two unions are written out by hand twice — once here and once in
    /// `client/src/protocol.ts` — and nothing generates either from the other.
    /// `protocol-tags.json` is the third copy and the one both are measured
    /// against; `protocol.test.ts` is the far half of this test.
    ///
    /// Variant-level only. A renamed field keeps its tag and passes here — see
    /// the note in the fixture itself.
    #[test]
    fn every_variant_is_in_the_shared_tag_list() {
        #[derive(serde::Deserialize)]
        struct Tags {
            client: Vec<String>,
            server: Vec<String>,
        }
        let tags: Tags = serde_json::from_str(include_str!("../../protocol-tags.json"))
            .expect("protocol-tags.json parses");

        // Every tag the fixture names must be one the match above can produce.
        // The other direction — a variant missing from the fixture — is caught
        // by the count, since the match cannot omit one and still compile.
        let mine = KNOWN_CLIENT_TAGS;
        for tag in &tags.client {
            assert!(
                mine.contains(&tag.as_str()),
                "protocol-tags.json names a client tag the server does not have: {tag}"
            );
        }
        assert_eq!(
            tags.client.len(),
            mine.len(),
            "the server has {} client tags and the fixture names {} — a variant was              added without updating protocol-tags.json, and protocol.ts with it",
            mine.len(),
            tags.client.len(),
        );

        let mine = KNOWN_SERVER_TAGS;
        for tag in &tags.server {
            assert!(
                mine.contains(&tag.as_str()),
                "protocol-tags.json names a server tag the server does not have: {tag}"
            );
        }
        assert_eq!(
            tags.server.len(),
            mine.len(),
            "the server has {} server tags and the fixture names {} — a variant was              added without updating protocol-tags.json, and protocol.ts with it",
            mine.len(),
            tags.server.len(),
        );
    }

    /// Kept beside the matches above, and the matches are what make them honest:
    /// a variant added to either enum breaks `client_tag`/`server_tag`, and
    /// whoever fixes that has these two lists in front of them.
    const KNOWN_CLIENT_TAGS: &[&str] = &[
        "add_shape",
        "add_walls",
        "clear_initiative",
        "clear_shapes",
        "clear_staged",
        "clear_walls",
        "create_token",
        "delete_token",
        "hello",
        "move_cursor",
        "move_token",
        "next_turn",
        "ping",
        "previous_turn",
        "promote_staged",
        "remove_from_initiative",
        "remove_shape",
        "remove_wall",
        "reset_fog",
        "roll",
        "say",
        "set_backdrop",
        "set_colour",
        "set_diagonals",
        "set_fog_override",
        "set_initiative",
        "set_map",
        "set_notes",
        "set_show_cursors",
        "set_show_dm_cursor",
        "set_show_names",
        "sketch",
        "toggle_door",
        "undo",
        "update_token",
    ];
    const KNOWN_SERVER_TAGS: &[&str] = &[
        "backdrop_changed",
        "choose_identity",
        "colours_changed",
        "cursor_moved",
        "cursors_changed",
        "diagonals_changed",
        "dm_cursor_changed",
        "error",
        "fog_changed",
        "initiative_changed",
        "map_changed",
        "names_changed",
        "notes_changed",
        "overrides_changed",
        "pinged",
        "presence",
        "restored",
        "said",
        "shapes_changed",
        "sketch",
        "sketch_ended",
        "staged_changed",
        "token_changed",
        "token_moved",
        "token_removed",
        "undo_changed",
        "walls_changed",
        "welcome",
    ];

    /// Proves the two lists above are the tags the matches actually produce,
    /// rather than a third thing that drifted from them.
    #[test]
    fn the_tag_lists_agree_with_the_matches() {
        assert_eq!(client_tag(&ClientMsg::Undo), "undo");
        assert_eq!(
            server_tag(&ServerMsg::UndoChanged { label: None }),
            "undo_changed"
        );
        assert!(KNOWN_CLIENT_TAGS.contains(&"undo"));
        assert!(KNOWN_SERVER_TAGS.contains(&"undo_changed"));
    }
}

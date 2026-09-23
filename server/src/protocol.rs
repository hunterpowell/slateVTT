//! Everything that crosses the wire, plus the state types the room owns.
//!
//! `ServerMsg` is the outbound wire format. The room's internal `Event` type
//! lives in `room.rs` and is a separate type; see `message_for`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::fog::{Cell, FogView, Override, OverrideView};

/// Server-assigned, unique per connection. Not an identity: it dies with the
/// socket. `PlayerId` is what survives a refresh.
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
// and the saved form of that table is sorted so the file doesn't churn on
// every write (the same reason `to_saved` sorts the tokens).
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Owner {
    /// The default, so a token restored from a schema that predates ownership
    /// becomes DM-only, which fails closed. Defaulting to any player would hand
    /// a stranger's token to whoever happened to claim that slot.
    #[default]
    Dm,
    Player(PlayerId),
}

/// Which palette entry each player has chosen, by roster slug. A slot with no
/// entry never chose one, and the client's default for that slot stands.
///
/// A `BTreeMap`, unlike every other table in this project, for two reasons.
/// `PlayerId` is a newtype over `String`, so it is a legal JSON object key
/// (`Owner` isn't, which is why `notes` is saved as a sorted list of pairs).
/// And a `HashMap` iterates in a different order every process, so the file
/// would churn on every write.
///
/// The value is an **index into a palette this crate does not hold.** The six
/// hues live in `client/src/pings.ts` and nowhere else, because a second copy
/// here would be one more thing to keep in step. The server has no opinion
/// about what `3` looks like, only that it names a colour. See `PALETTE`.
pub type Colours = BTreeMap<PlayerId, u8>;

/// How many colours there are to choose between.
///
/// The length of `PLAYER_HUES` in `client/src/pings.ts`, and the only thing this
/// crate knows about that list. It lets `SetColour` be checked against a closed
/// set on the server, the way a token's size is. Why the set is closed rather
/// than free hex is on `ClientMsg::SetColour`.
pub const PALETTE: u8 = 6;

// Invariant 2 wants `#[serde(default)]` on every persisted field. Declaring it
// on the container is equivalent for deserialization and safer: there is no
// per-field attribute for a later field to forget.

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
    /// Alpha is part of the value because how hard the grid reads matters more
    /// than its hue, and because `aa = 00` is how a DM turns the overlay off on
    /// a map that already has a grid printed on it. The client draws a
    /// contrasting halo under it, so it stays legible whatever the DM picks.
    pub grid_color: String,
    /// The playable region of the image. The grid is ruled only here, and the
    /// rest of the image is dimmed.
    ///
    /// `None` means the whole image. That's what a save written before this
    /// field means, and the only thing the server *could* mean by it, since it
    /// never learns the image's dimensions. Only the client, which has the
    /// decoded image, can turn "all of it" into numbers.
    pub play_area: Option<Rect>,
    /// Whether the party's sight is limited on this map.
    ///
    /// Per map, and remembered per URL like the rest of the calibration: a
    /// dungeon wants fog and the meadow outside it doesn't, and the DM
    /// shouldn't have to remember which is which when swapping between them.
    /// Off by default, because a room restored from a save that predates fog
    /// is a room nobody asked to darken, and a switch that defaults to off
    /// can't make that mistake whatever `vision_ft` loads as.
    pub fog: bool,
    /// How far a player-owned token sees, in feet. One radius for the map; a
    /// token's `light_ft` replaces it. Nothing here knows the word
    /// "darkvision".
    ///
    /// Read only when `fog` is on, so its default is a playable number rather
    /// than a defensive one. Both modes below read it, which is why the room
    /// fill is bounded by it as well as by the walls.
    pub vision_ft: f32,
    /// How this map's sight is worked out. Per map like the two above and
    /// remembered per URL with them: the outdoor map keeps line of sight and the
    /// dungeon reveals a room at a time.
    pub lighting: Lighting,
    /// What shape a cell is. Per map and remembered per URL like the rest of the
    /// calibration. See `docs/maps.md`.
    ///
    /// `Square` is the default, so a save written before this field describes
    /// the same board it always did. Nothing downstream of `fog::basis` knows
    /// there is more than one shape.
    pub grid_shape: GridShape,
}

/// What "can the party see this cell" means on a given map.
///
/// Two different questions asked of the same walls: `Dynamic` asks whether a
/// straight line reaches the cell, `Room` asks whether a walk does. See
/// `visible_cells` and `lit_cells` in `fog.rs`, which sit beside each other.
///
/// Per map, unlike `Diagonals`: a dungeon of sealed chambers and the meadow
/// outside it want different answers, and the DM shouldn't have to remember
/// which is which when swapping between them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lighting {
    /// Line of sight: a cell is lit when nothing stands between the viewer's
    /// centre and it. The default, so a save written before this field reads
    /// as it did. Invariant 2 lets the field load; this makes the default the
    /// old behaviour.
    #[default]
    Dynamic,
    /// The room a token is standing in, out to the radius: a cell is lit when a
    /// walk reaches it without crossing masonry or a shut door. An open door is
    /// how light reaches the next room, and a shut one seals this one.
    Room,
}

/// The shape of one cell, and so of the whole lattice.
///
/// An isometric grid is an affine transform of a square one, which is why this
/// is one field and not a second coordinate system. `fog::basis` turns it into
/// the two cell axes and is the only place either variant is read on this side
/// of the wire; `gridBasis` in `client/src/scene.ts` is the client's copy and
/// must agree.
///
/// A descriptor rather than the four numbers of a basis, because a basis has no
/// sensible `Default` ("square" depends on `grid_px`, a sibling field), and
/// because `MIN_GRID_PX` has something to bound only while `grid_px` still
/// means the size of a cell.
///
/// This is flat: a diamond lattice, not a 2.5D renderer. Nothing here has a
/// height, and `Wall` is still a segment in image pixels. See `docs/maps.md`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum GridShape {
    /// An axis-aligned square of side `grid_px`. The default, so a save that
    /// predates the field describes the same board after loading it.
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
            // The safe direction: a map nobody has turned fog on for is a map
            // the table can see all of, which is what every room saved before
            // this field existed was.
            fog: false,
            // Only read once `fog` is on, so this is a sensible torch rather than
            // a guard against the zero that `#[serde(default)]` would otherwise
            // supply. The flag above guards that.
            vision_ft: 60.0,
            // So a save that predates the field describes the same dungeon
            // after loading it.
            lighting: Lighting::Dynamic,
            // The same reason as `lighting`, and a stronger one: this decides
            // where every cell *is*, so anything but `Square` here would move the
            // tokens on a board saved before the field existed.
            grid_shape: GridShape::Square,
        }
    }
}

/// A `MapInfo` with the URL taken off: everything the DM sets by calibrating.
///
/// The room keeps one of these per map URL so that re-picking a map out of the
/// library comes back the way it was left. Persisted, but never sent: it isn't
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
    /// Remembered with the grid. Whether a map is fogged, how far its torches
    /// reach and how sight is worked out on it are facts about that dungeon,
    /// and re-picking it out of the library should bring all three back with
    /// the rest.
    pub fog: bool,
    pub vision_ft: f32,
    pub lighting: Lighting,
    pub grid_shape: GridShape,
}

impl Default for Calibration {
    /// Taken from `MapInfo` rather than restated, so the grid size that must
    /// never be zero can't become zero on this side unnoticed.
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
/// The shelf. `Calibration` above is *what the client sent* (the room builds
/// one as a struct literal out of the `SetMap` fields), and this is what the
/// room has learned about that image since. **Keep them apart:** a
/// recalibration overwrites the calibration and must not reach the tracing.
/// With one type, the obvious way to write that arm files empty walls over
/// half an hour's work. Here the insert can't reach them.
///
/// Server-side only, like the calibration it wraps: nothing here is on
/// `RoomView` and no `ServerMsg` carries it, because the finished `MapInfo` and
/// the board's own `walls` already say everything a client needs.
///
/// `Calibration` is flattened, so the disk shape is a bare calibration with two
/// keys added beside it, as `StagedView` does. A save that has only the
/// calibration loads as a calibrated map with nothing traced on it.
///
/// No `PartialEq`, unlike `Calibration`. `Wall` doesn't derive it, and nothing
/// here compares two shelves.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Prepared {
    #[serde(flatten)]
    pub calibration: Calibration,
    /// Traced over this image and filed under it as the map leaves the board,
    /// so a dungeon walled on a Tuesday is still walled on Saturday. Bounded
    /// where it is traced (`MAX_WALLS`) and never on the wire, so the frame cap
    /// doesn't apply.
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
/// The pair travels together so that "half a hit point total" can't be
/// represented. A bare `current` with no `max` is a number the board can't
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
/// It exists so that "half a position" can't be represented: two bare
/// `Option<f32>` fields could be set one at a time, and a plan with an x and no
/// y isn't a cell anything can land on. `Hp` keeps its pair together, and
/// `Identity` is an enum, for the same reason.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Pos {
    pub x: f32,
    pub y: f32,
}

/// A point in image pixels: the other coordinate space, and the one invariant 1
/// names as its exception.
///
/// A separate type from `Pos` because the two spaces aren't interchangeable
/// and mixing them up is silent. A wall traces a feature painted on the map, so
/// it is anchored to the art; one stored in grid units would slide off the wall
/// it was tracing the moment the DM recalibrated. `Rect` is in this space too,
/// for the same reason.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Px {
    pub x: f32,
    pub y: f32,
}

/// A mark the DM puts on a creature, named for its colour and nothing else.
///
/// What "red" means tonight is between the DM and the table. A variant called
/// `Poisoned` would be the 5e rules knowledge this project refuses, and once
/// one exists something downstream wants to know what it *does*: how long it
/// lasts, what it subtracts, whether it ends on a save. Slate draws a pip and
/// knows nothing.
///
/// A closed set checked by serde, like `ShapeKind`: an unknown marker fails to
/// deserialize, so `check` needs no arm for validity. The server has no
/// opinion about what any of them looks like. The hues live in `MARKER_HUES`
/// on the client, as `PLAYER_HUES` does.
///
/// Six colours and one state. The rule that keeps the set closed is
/// **nothing in Slate knows what a mark means**, not "colours only". `Dead`
/// passes it: it changes nothing a token can do, which is the test to apply to
/// an eighth. See *Markers* in `docs/tokens.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Marker {
    Red,
    Orange,
    Yellow,
    Green,
    Blue,
    Purple,
    /// The only member that isn't a colour.
    ///
    /// It is drawn as an X across the portrait rather than as an arc in the
    /// band, so it reads as a different kind of mark on the board as well as
    /// here. Nothing follows from it: the creature still moves, still holds its
    /// initiative row, still keeps whatever total the DM has on it. A variant
    /// that *did* have an effect (a row skipped, a token undraggable) would make
    /// this a rules engine.
    Dead,
}

impl Marker {
    /// Every marker there is, in the order the client offers them.
    ///
    /// Used instead of a `MAX_MARKERS` beside `MAX_TOKENS` so the closed set and
    /// the bound on a token's list can't drift apart: with duplicates refused,
    /// the number of variants *is* the length cap.
    pub const ALL: [Marker; 7] = [
        Marker::Red,
        Marker::Orange,
        Marker::Yellow,
        Marker::Green,
        Marker::Blue,
        Marker::Purple,
        Marker::Dead,
    ];
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Token {
    pub id: TokenId,
    pub name: String,
    /// Grid units, measured to the token's centre. Never pixels (invariant 1).
    pub x: f32,
    pub y: f32,
    pub owner: Owner,
    /// Site-relative, or empty for a token with no art. Empty is a valid
    /// state: the client draws a named disc, so the sixth goblin of the evening
    /// costs the DM nothing.
    pub img: String,
    /// Width and height in grid cells. One cell unless the DM says otherwise.
    ///
    /// Nothing here knows the words "large" or "huge"; that would be rules
    /// knowledge. It is a count of squares, and the only thing it changes
    /// besides the drawing is where the token settles: see `snap_to_cell`.
    pub size: f32,
    /// What the DM has marked this creature with, in the order they were added.
    ///
    /// **Public, unlike the four fields below it**, because a mark nobody at
    /// the table can see isn't a mark. It needs no filtering of its own because
    /// it can't outlive its token: a creature the table can't see takes its
    /// pips with it, through `unseen_by_table` like everything else about it.
    ///
    /// The only list on a token. It is a *set* in practice: `token_fields`
    /// refuses duplicates, which also bounds its length, since `Marker::ALL` is
    /// a closed set.
    pub markers: Vec<Marker>,
    /// The table can't see this token at all. Not drawn faint: it is absent
    /// from a player's snapshot, its moves aren't relayed to them, and its
    /// initiative row is filtered out of their panel (invariant 4).
    ///
    /// Applies whoever owns it. Hiding a player's own token is a strange thing
    /// to do and not worth a rule to forbid, so the filter is uniform.
    pub hidden: bool,
    /// The DM's note on a creature, and nobody else's business. `None` is the
    /// usual state: most tokens are party members the DM keeps no total for.
    pub hp: Option<Hp>,
    /// How far this token lights the board, in feet, or `None` for a token that
    /// carries no light of its own.
    ///
    /// One field doing two things. On a token a player owns it *replaces*
    /// `MapInfo::vision_ft` (a lantern). On anything else it is what makes the
    /// token a source at all: a brazier, a torch on a wall, a goblin carrying
    /// one. `fog::Source` is where the two become one rule.
    ///
    /// DM-only, like `hp` beside it. What a light does reaches the table as fog,
    /// the same argument the walls make: the geometry is the DM's authoring and
    /// the shadow it casts is what the table plays with. So `None` here means
    /// both "carries no light" and "you are not the DM".
    pub light_ft: Option<f32>,
    /// Where this token lands when the staged map is promoted, in grid units
    /// like `x, y`. `None` is "staying where it is".
    ///
    /// DM-only, and a plan rather than a position: a promote adopts it into
    /// `x, y`, and anything else that discards the staged map discards it too.
    /// Only position and existence fork between the two boards. A rename, a
    /// resize or a re-art applies to one token and therefore to both.
    pub staged_pos: Option<Pos>,
    /// This token doesn't exist on the live board yet: it was built on the map
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
    /// before this field existed would load at zero: drawn with no radius, so
    /// invisible and impossible to grab. `MapInfo::grid_px` avoids the same trap.
    ///
    /// For `hidden` the derived `false` is right: a token saved before the field
    /// existed was one the table could see, and defaulting it to `true` would
    /// make an upgrade empty the board. `staged_only` takes the same answer, and
    /// so does `markers`: a token saved before it existed carried none.
    fn default() -> Self {
        Self {
            id: TokenId::default(),
            name: String::new(),
            x: 0.0,
            y: 0.0,
            owner: Owner::default(),
            img: String::new(),
            size: 1.0,
            markers: Vec::new(),
            hidden: false,
            hp: None,
            light_ft: None,
            staged_pos: None,
            staged_only: false,
        }
    }
}

/// A token as one particular client may see it: the token counterpart to
/// `RoomView`, and the reason `Token` itself never reaches the wire.
///
/// This is per-field redaction, which other filters don't need. A staged map
/// reaches the DM or nobody, whole; hit points are a field on a token the
/// players *do* otherwise see, so their copy has to be a different shape.
///
/// `view_for` names every field that leaves the room, rather than blanking the
/// secret ones, so a secret added to `Token` and forgotten here is absent from
/// the wire instead of sent to everyone. **That's the direction it must fail
/// in:** a field the DM's own client is missing is visible, and one the table
/// can read in devtools is not.
#[derive(Debug, Clone, Serialize)]
pub struct TokenView {
    pub id: TokenId,
    pub name: String,
    pub x: f32,
    pub y: f32,
    pub owner: Owner,
    pub img: String,
    pub size: f32,
    /// The same value for every recipient, alone among the fields below it.
    /// The same reasoning as `FogChanged`: who may set a mark is a permission,
    /// and what it says isn't a secret. A player is never sent a token they
    /// can't see, so there is nothing here to redact.
    pub markers: Vec<Marker>,
    /// Only ever true on the DM's copy. A player isn't sent a hidden token at
    /// all, so for them this is always false without a rule saying so.
    pub hidden: bool,
    /// `None` for a player, always. Also `None` for a DM who keeps no total on
    /// this creature. The client can't tell the two apart, as `staged` being
    /// `None` means both "nothing staged" and "not the DM".
    pub hp: Option<Hp>,
    /// `None` for a player, always, and the table loses nothing by it, since
    /// what a light does reaches them as fog. Also `None` for a DM's token that
    /// carries none; the client can't tell the two apart, as with `hp`.
    pub light_ft: Option<f32>,
    /// `None` for a player, always: a plan for a map they can't see is a fact
    /// about that map. Also `None` for a DM whose token is staying put.
    pub staged_pos: Option<Pos>,
    /// Only ever true on the DM's copy: a player isn't sent a token that
    /// doesn't exist on their board yet, so for them this is always false.
    pub staged_only: bool,
}

impl Token {
    /// The copy this recipient is allowed to hold. Callers decide whether an
    /// unseen token is sent at all; this decides what is in it once it is.
    ///
    /// Adding a field here is a decision that the DM's own client needs it.
    /// `staged_pos` and `staged_only` are here because the DM's board draws a
    /// plan. Leaving them out would have sent them to nobody, which is the
    /// direction this type fails in.
    pub fn view_for(&self, is_dm: bool) -> TokenView {
        TokenView {
            id: self.id.clone(),
            name: self.name.clone(),
            x: self.x,
            y: self.y,
            owner: self.owner.clone(),
            img: self.img.clone(),
            size: self.size,
            markers: self.markers.clone(),
            hidden: self.hidden,
            hp: if is_dm { self.hp } else { None },
            light_ft: if is_dm { self.light_ft } else { None },
            staged_pos: if is_dm { self.staged_pos } else { None },
            staged_only: is_dm && self.staged_only,
        }
    }

    /// Whether the token is withheld from the table for either of its own two
    /// reasons. **Filters call `RoomState::unseen_by_table`, not this**: it adds
    /// line of sight, the third reason, and calling this directly leaks.
    ///
    /// `hidden` is a creature the DM took off the board; `staged_only` is one
    /// that was never on it. Different facts about different maps, and they
    /// compose: a monster built on the next map and hidden there is both, and
    /// stays unseen through the promote that clears `staged_only`. Anything
    /// that filters on one and forgets the other is a leak, so nothing in the
    /// room asks this question of either field directly.
    pub fn unseen(&self) -> bool {
        self.hidden || self.staged_only
    }
}

/// The four things anyone can draw on the board. A closed set, checked by serde
/// rather than by hand: an unknown kind fails to deserialize, the way an
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
    /// field can't invent an area out of it.
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
/// no movement distance in this crate to compute: `feetMoved` is client-only,
/// because a reading is drawn and never enforced. What the room provides is
/// that all six clients agree on the convention, as with `show_names`, and for
/// the same reason it can't live in `localStorage`.
///
/// Not on `MapInfo` beside `fog`, for the reason `show_names` isn't: this is a
/// house rule about counting, and swapping the map isn't a request to change
/// how the table counts.
///
/// It moves the ruler and nothing else. A drawn circle's radius and a token's
/// vision are geometry: `contains_point` and `visible_cells` stay Euclidean,
/// and the disagreement between the two that `docs/drawings.md` describes is
/// intended on both sides of the switch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Diagonals {
    /// Every step costs one cell, orthogonal or not ("5-5-5" at the table). The
    /// default, so a save written before this field existed reads as it did.
    #[default]
    Equal,
    /// The second diagonal of a move costs double, and every other one after
    /// ("5-10-5"). Counted from the start of each reading rather than across a
    /// turn: nothing here holds a creature's movement budget, and the first
    /// diagonal of anything anyone measures costs five.
    Alternating,
}

/// Where a shape's first point is.
///
/// An enum rather than a position beside an `Option<TokenId>`, for the reason
/// `Identity` is one: an anchored shape carrying a position nothing reads is a
/// field that can go stale, and the pair could disagree. Here they can't.
///
/// `Token` is an aura that follows the creature it belongs to. It needs no
/// position updates on the wire at all, because every client already holds
/// the token and derives the rest.
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
/// Unlike `Token` this reaches the wire as itself. There is no `ShapeView`
/// because nothing on it is for one client and not another. Fog gates a shape
/// *whole* (`shape_seen` in `room.rs`), so the filter drops it or sends it,
/// and a view type would have no field to redact.
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
    /// Who drew it, and so who may delete it besides the DM. The same type as a
    /// token's `owner`, but a shape is nobody's to move, so this is named for
    /// what it answers.
    pub by: Owner,
    /// `#rrggbbaa`, like `MapInfo::grid_color` and validated by the same rule.
    /// The client picks from a small palette; the server only checks the shape.
    pub color: String,
}

impl Shape {
    /// The token this shape follows, if it follows one. Every filter asks this
    /// rather than matching on `from` itself, so there is one place that
    /// answers the question.
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
/// "a solid wall that is open" can't be represented.
///
/// Adjacently tagged like `Owner`, so the two variants are `{"kind":"solid"}`
/// and `{"kind":"door","open":true}` rather than two different JSON shapes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "open", rename_all = "snake_case")]
pub enum WallKind {
    /// Masonry. Blocks line of sight.
    Solid,
    /// A way through, and whether it is standing open. Toggled by the DM alone.
    Door(bool),
}

impl Default for WallKind {
    /// A save from a schema that predates doors describes masonry, and masonry
    /// is also the safe way round: a segment that defaulted to an open door
    /// would stop blocking sight without anyone noticing.
    fn default() -> Self {
        Self::Solid
    }
}

/// One traced segment of wall, in image pixels.
///
/// **Not in grid units: this is invariant 1's stated exception.** A wall traces
/// a feature painted on the map, so it belongs to the art rather than to a cell;
/// stored in cells, every wall would slide off the thing it was tracing the
/// moment the DM corrected the grid. Calibrate first, then trace.
///
/// Flat segments rather than the polylines they are drawn as: the run is an
/// authoring convenience, and everything downstream (erasing one bad segment,
/// toggling one door, the raycast in `fog.rs`) asks about segments one at a
/// time.
///
/// There is no `WallView`. Walls don't reach a player at all, whole or
/// redacted, so the filtering is `message_for` dropping the message and
/// `snapshot_for` sending an empty list, as for `staged`.
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
    /// masonry.
    pub fn door(&self) -> Option<bool> {
        match self.kind {
            WallKind::Door(open) => Some(open),
            WallKind::Solid => None,
        }
    }

    /// Whether sight stops here. The only question `fog.rs` asks of a wall, and
    /// the reason `WallKind::default` is `Solid`: a segment restored from a
    /// schema that predates doors has to keep blocking.
    pub fn blocks(&self) -> bool {
        !matches!(self.kind, WallKind::Door(true))
    }
}

/// Where something somebody typed is going.
///
/// **Two destinations for anyone, and never a third.** A player says it to the
/// table or to the DM; the DM says it to the table or to one player. There is
/// no player-to-player variant, and adding one would turn this into a chat
/// system. The non-goal in `.claude/CLAUDE.md` is the specification.
///
/// A separate type from `Owner` because of `Table`: an owner is a person, and
/// this is a person *or* everybody. Reusing `Owner` would mean either a `Table`
/// variant on the type token ownership uses, or a `None` meaning "everyone",
/// and both are worse than one enum that says what it is.
///
/// Adjacently tagged like `Owner`, for the same reason: a newtype variant
/// wrapping a string can't be internally tagged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum ChatTo {
    /// A shout: everybody, filtered by nothing at all. The fog doesn't apply
    /// to words.
    Table,
    /// A whisper to the DM. What a player's second button says, and the only
    /// destination besides the table that a player may name.
    Dm,
    /// A whisper to one player, which only the DM may send.
    Player(PlayerId),
}

/// One thing somebody said, as the room keeps it and as it goes out.
///
/// Never `Deserialize`. The log is session memory, so nothing ever reads
/// one of these back: not off the disk, because it isn't written there, and
/// not off the wire, because a client sends a `Say` and the room decides who
/// said it.
///
/// It carries `to` as well as `by` because a whisper has to *look* like one on
/// the screen of both people party to it, and neither of them can work that out
/// from `by` alone: the DM sees their own whisper to Saelyn and Saelyn's
/// whisper to them side by side in one log.
#[derive(Debug, Clone, Serialize)]
pub struct ChatLine {
    /// Who said it. An `Owner` because that is what the roster resolves to a
    /// name and a colour, as with `Pinged`.
    pub by: Owner,
    pub to: ChatTo,
    /// Trimmed and length-checked on the way in. Text and nothing else: no
    /// formatting, no emotes, no commands.
    pub text: String,
    /// The room threw this rather than somebody typing it.
    ///
    /// All the loaner die adds to the log. It describes the line and guards no
    /// behaviour: the client styles it so a witnessed number reads differently
    /// from a claimed one at a glance, which is also all `to` is used for there.
    ///
    /// It costs nothing because this struct is session memory and `Serialize`
    /// only: no disk, so no migration and no `#[serde(default)]`; not on
    /// `Saved`, so not on the undo ring. See `docs/dice.md`.
    pub rolled: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RosterEntry {
    pub id: PlayerId,
    pub name: String,
}

/// A roster slot as offered to someone choosing an identity. `claimed` is
/// advisory: it stops two people picking Saelyn by accident, not on purpose
/// (a player on both a laptop and a phone is legitimate).
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
    /// the sort is stable: the first creature the DM entered goes first.
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
/// One bundle rather than three fields side by side, because the three arrive,
/// sweep and promote together. `RoomState` holds the live board's three as
/// separate fields and this for the staged one, because the live board is the
/// room's own and this is waiting to replace it.
///
/// **The map is `#[serde(flatten)]`ed, which is what keeps an older save
/// loading.** An older file holds `"staged": {"url": …, "grid_px": …}`, the
/// map's fields at the level flatten reads them from, so the map comes back
/// and the two lists default to empty. Nesting it under a `map` key would
/// deserialize every one of those fields as missing and hand the DM a staged
/// slot holding a blank image.
///
/// The same type on the wire and on disk, as `MapInfo` is: what the DM may
/// hold of the staged slot and what the file must hold of it are the same,
/// because a player holds none of it either way.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct StagedView {
    #[serde(flatten)]
    pub map: MapInfo,
    /// Traced over the staged image, and swept with it. No filtered form, for
    /// the reason the live board's walls have none: walls reach the DM or
    /// nobody, and a staged wall adds nothing a live one didn't.
    pub walls: Vec<Wall>,
    /// Painted over the staged board by hand. Packed like the live board's, and
    /// withheld like them.
    ///
    /// There is no staged *fog* under this; see `docs/fog.md`. What the DM
    /// paints is what the party will be handed when the map is promoted, not a
    /// preview of what they can see now.
    pub overrides: OverrideView,
}

/// A room as one particular client is allowed to see it. Produced only by
/// `RoomState::snapshot_for`; there is no unfiltered `snapshot()`.
#[derive(Debug, Clone, Serialize)]
pub struct RoomView {
    pub map: MapInfo,
    /// The map the DM is preparing with its own walls and overrides, if there is
    /// one, and only if this view belongs to the DM. A player's copy is always
    /// `None`, which is also what "nothing is staged" looks like, so the client
    /// can't tell the two apart. Invariant 4 wants the next dungeon absent from
    /// a player's snapshot, not just undrawn.
    ///
    /// One `None` withholds all three, which is why the bundle exists: there is
    /// no second staged field to forget to filter.
    pub staged: Option<StagedView>,
    /// Already filtered *and* redacted: a token the table can't see (hidden,
    /// out of sight, or built on the next map and not here yet) is absent
    /// rather than flagged, and what survives carries only the fields this
    /// client may hold.
    pub tokens: Vec<TokenView>,
    /// Rows naming a token this client can't see are gone from here, and
    /// `current` with them. A row the players can read but not explain is the
    /// bare id of the thing `hidden` was supposed to conceal.
    pub initiative: Initiative,
    /// Draw order, and already filtered: a shape anchored to a token this
    /// client can't see is absent, because an aura on a hidden monster is that
    /// monster's position drawn in colour.
    ///
    /// Sketches aren't here. One lasts as long as somebody is holding the
    /// mouse down, so a client that joins mid-sweep and misses it has nothing
    /// to reconcile: the line was about to vanish anyway.
    pub shapes: Vec<Shape>,
    /// The traced walls and doors, and **empty for a player, always**. Not
    /// sent and left undrawn: a player who could read these in devtools would
    /// have the dungeon's floor plan, which is what fog hides. Invariant 4, and
    /// withheld the same way as `staged`.
    ///
    /// Empty therefore means both "nothing traced" and "you are not the DM",
    /// and the client can't tell the two apart.
    pub walls: Vec<Wall>,
    /// What the party can see and what they have explored, or `None` on a map
    /// with fog turned off.
    ///
    /// The same value for everyone. Fog is party-shared, so there is one answer
    /// rather than one per client; the DM is sent it so their own board can
    /// show, faintly, what the table is looking at. The walls are what stay
    /// DM-only, and a player infers the geometry from the edges of this.
    ///
    /// Lives in `fog.rs` beside the two functions that pack and unpack it, unlike
    /// every other type here, because the encoding is most of what there is to
    /// explain, and splitting the two would leave a string nothing explains.
    pub fog: Option<FogView>,
    /// The cells the DM has overridden by hand, and **empty for a player,
    /// always**, as `walls` is.
    ///
    /// It groups with `walls` above rather than `fog`: the walls and this are
    /// what the DM authored, and the fog is the result of both. A player reads
    /// the result off `fog` and is never told which parts of it were decided
    /// rather than computed.
    ///
    /// Empty therefore means both "nothing painted" and "you are not the DM",
    /// as with `staged` and `walls`.
    pub overrides: OverrideView,
    /// Whether the board writes each token's name under it.
    ///
    /// The same value for everyone, like `fog` and unlike everything else here
    /// that only the DM may set. Who may flip it is a permission; what it says
    /// isn't a secret. A name the table can already read off their own
    /// initiative panel isn't withheld by leaving it off the board, and the
    /// switch exists so the DM's board and theirs agree about what is written
    /// on it. Room-wide rather than per map: it is a fact about how tokens are
    /// labelled, and swapping the map isn't a request to relabel them.
    pub show_names: bool,
    /// How the movement ruler charges a diagonal.
    ///
    /// The same value for everyone, for the reason `show_names` is. It is a
    /// counting convention the table shares, so the only way this can be wrong
    /// is a client holding a different one from its neighbour.
    pub diagonals: Diagonals,
    /// Whether everybody's pointer is drawn on everybody's board.
    ///
    /// The same value for everyone, for the same reason. It is on the view
    /// because a client reads it to decide whether to *send* (the only one of
    /// these that governs outgoing traffic as well as what is drawn), and a
    /// join that didn't carry it would have every fresh page sending cursors
    /// into a room that has switched them off.
    pub show_cursors: bool,
    /// Whether the DM's own pointer is drawn on the players' boards.
    ///
    /// The narrower half of the switch above, and the same value for everyone
    /// for the same reason: who may flip it is a permission and what it says
    /// isn't a secret. A player never draws it themselves (they are sent no
    /// frame to draw), so this is on the view for the DM's own panel to read
    /// back. Unlike `show_cursors`, it doesn't change what any client *sends*.
    pub show_dm_cursor: bool,
    /// The picture the table is looking at instead of the board, or `None` when
    /// they are looking at the board.
    ///
    /// The same value for everyone: the DM decides what is on the screens and
    /// nobody is being kept from anything. It isn't a map and has no `MapInfo`
    /// (no grid, no walls, no fog, nothing to stand on), which is why the board
    /// underneath survives it.
    pub backdrop: Option<String>,
    /// The music the room is playing, or `None` for silence.
    ///
    /// The same value for everyone, for the same reason as the settings above:
    /// who may put music on is a permission and which track it is isn't a
    /// secret. It is on the view as well as the delta because a reconnect is a
    /// fresh join, and somebody coming back mid-session should hear what the
    /// table is already hearing.
    pub audio: Option<String>,
    /// Who is connected right now, the DM among them.
    ///
    /// The same value for everyone, like the fields above and unlike the ones
    /// below. There is no permission here and nothing to withhold: it exists so
    /// the table can tell whether the DM is still connected.
    ///
    /// `Owner` rather than `RosterSlot`, unlike the identity picker's list,
    /// because a slot can't say "the DM", and the DM is the connection most
    /// worth knowing about. It also means `colourOf` and `nameOf` on the client
    /// resolve these with nothing further on the wire, as with `Pinged`.
    ///
    /// **A set of identities and not a count.** Somebody on a laptop and a phone
    /// is one entry (`RosterSlot::claimed` allows that), so counting sockets
    /// would report seven people at a table of six.
    ///
    /// It is on the view as well as on `ServerMsg::Presence` so a join is filled
    /// in by the same path as every delta (invariant 3), which also makes
    /// `Restored` correct without a line of its own.
    pub here: Vec<Owner>,
    /// Which colour each player picked for themselves.
    ///
    /// Public, unlike the scratchpad below: the only thing a player writes
    /// that everybody else is then sent. Everyone has to draw everyone else's
    /// pings and attribute everyone else's lines, so a colour only its owner
    /// could see would be useless.
    ///
    /// A slot with no entry hasn't chosen, and the client's default for that
    /// slot stands, so a room that predates this field looks as it did.
    pub colours: Colours,
    /// What has been said in this session that this client is party to.
    ///
    /// **Different content per recipient, not the same content filtered.**
    /// Every list above is the room's own with rows dropped; two clients
    /// holding this hold two different conversations, because a whisper is
    /// only in the copies of the two people at either end of it. This is what
    /// per-client `mpsc` senders allow and `tokio::sync::broadcast` wouldn't.
    ///
    /// Oldest first, capped, and never on disk: it is session memory, so a
    /// browser hiccup mid-combat doesn't lose the initiative rolls and next
    /// game night starts empty. Invariant 3 matters more here than anywhere
    /// else in this struct: getting it wrong hands over somebody's words rather
    /// than a position.
    pub chat: Vec<ChatLine>,
    /// What the DM's undo would take back, or `None` when there is nothing to
    /// take back, and **`None` for a player, always**, as with the walls.
    ///
    /// A label rather than a depth because that's all the button needs to say:
    /// with no redo, a press the DM can't predict can't be recovered from, so
    /// the button names what it would undo instead of counting steps. `None`
    /// therefore means both "the ring holds only where you started" and "you
    /// are not the DM", and the client can't tell the two apart.
    ///
    /// The ring itself never leaves the room. A client can't undo twice without
    /// being told what the second press would do, and the `UndoChanged` sent
    /// after the first press tells it.
    pub undo: Option<String>,
    /// This client's own scratchpad, and never anybody else's.
    ///
    /// Per-recipient content like `chat`, and the one field where the DM's
    /// copy is narrower than the room's rather than wider. Every other filter
    /// in this struct withholds from players; `notes_for` asks only whose box
    /// it is, and the DM has one like everybody else.
    ///
    /// Empty means both "you have written nothing" and, for a client that
    /// hasn't claimed a slot, "there is no box to fill". Nothing downstream
    /// cares which.
    pub notes: String,
}

/// Inbound. Not `#[serde(default)]`: a malformed frame from a client should be
/// rejected, not filled in with zeroes.
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
        /// Intent travels on the command rather than as a mode because the
        /// server doesn't know the DM is previewing and must not learn: preview
        /// is client-only state. DM-only, and refused when nothing is staged: a
        /// plan needs a map to be a plan about.
        staged: bool,
    },

    // The token lifecycle. All DM-only, including `owner`: handing a player a
    // token the DM built is how a wild shape reaches the table.
    /// Carries no id: the server assigns it, so two DMs on two tabs can't
    /// propose the same one.
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
        /// light. A brazier is built in one command, like the ambush above.
        light_ft: Option<f32>,
        /// What it is marked with. Usually empty on a create; it is here rather
        /// than left to a follow-up edit so that duplicating a marked creature
        /// is one command, which is the only time it is non-empty.
        markers: Vec<Marker>,
        /// Built on the map the DM is preparing rather than on the board: `x, y`
        /// becomes the token's plan and it doesn't exist for the table, or for
        /// the DM's own live board, until the promote.
        ///
        /// The same flag `SetMap` and `MoveToken` carry, naming the same slot.
        staged: bool,
    },
    /// Every editable field at once, the way `SetMap` carries the whole grid.
    /// Position is absent: `MoveToken` owns that, and an edit made from a panel
    /// must not drag a token out from under whoever is moving it.
    ///
    /// `hidden` and `hp` are editable fields like the rest. Taking damage is
    /// this command with a new `hp`, which is why there is no `SetHp`: it would
    /// carry one field of the several the panel already sends together.
    ///
    /// No `staged` flag, unlike `MoveToken` and `CreateToken`. Every field here
    /// is shared by both boards (nobody wants a goblin with different art on
    /// two maps), so an edit applies immediately and everywhere. Only position
    /// and existence fork.
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
        /// The whole set, not a toggle. This command replaces the token, so a
        /// client sending it has to carry every field through. That makes a
        /// `SetMarkers` unnecessary and a marker toggle an ordinary edit, as the
        /// damage box's is.
        markers: Vec<Marker>,
    },
    DeleteToken {
        id: TokenId,
    },
    /// Whether the board writes each token's name under it. DM-only, and the one
    /// command in this block that is about no particular token.
    ///
    /// Its own command rather than a field on `SetMap`, where `fog` is: this
    /// belongs to the room and not to the image, so sending it with a map
    /// change would fork it between the two slots and reset it every time the
    /// DM loaded a dungeon. It isn't on `UpdateToken` either, because there is
    /// one answer for the board, not one per creature.
    SetShowNames {
        show: bool,
    },
    /// How the movement ruler charges a diagonal. DM-only, and like
    /// `SetShowNames` in every respect: room-wide, about no particular token,
    /// and not a field on `SetMap` because the table's counting outlives the
    /// dungeon.
    SetDiagonals {
        diagonals: Diagonals,
    },

    /// Whether everybody's pointer is drawn on everybody's board. DM-only, and
    /// like `SetShowNames`: room-wide, about no particular token, and not a
    /// field on `SetMap` because how much the table wants on their screens
    /// outlives the dungeon.
    ///
    /// **It switches off the relay, not just the drawing.** Seven pointers
    /// moving over a board that already carries tokens, nameplates, hit point
    /// bars, rulers, trails, shapes and fog is a real cost, and when the table
    /// decides against it the traffic should stop too. A switch that left
    /// `MoveCursor` flowing and only skipped drawing the result would still
    /// cost what it claims to save.
    SetShowCursors {
        show: bool,
    },

    /// Whether the DM's own pointer is drawn on the players' boards. DM-only,
    /// and the narrower half of the switch above it.
    ///
    /// **It stops the relay of one client's pointer, not the drawing and not
    /// the sending.** That is where it differs from `SetShowCursors`: switching
    /// every pointer off saves traffic on the busiest message in the protocol,
    /// but the DM's alone is one client in seven, so a second condition at the
    /// send site would save nothing measurable. The room drops the frame in
    /// `cursor_seen`, which already withholds the DM's pointer over unexplored
    /// ground; this widens that from "the dark" to "everywhere".
    ///
    /// It's for a DM who wants their pointer off the table's screens while the
    /// party is deciding something, without taking the other six pointers away
    /// from each other.
    SetShowDmCursor {
        show: bool,
    },

    /// Put a picture in front of the table, or take it away. DM-only.
    ///
    /// Like `SetShowNames`: room-wide, about no particular token, not a field on
    /// `SetMap`. Here that matters most, because sending it with `SetMap` would
    /// make showing a picture a *map load*, and a map load sweeps the walls,
    /// the drawings and everywhere the party has explored. This command sweeps
    /// none of them.
    ///
    /// One field, not two. `None` is "put it away", and re-showing is two
    /// clicks in the picker. A remembered URL beside a shown/hidden flag would
    /// be a second thing to keep in step, for nothing.
    SetBackdrop {
        /// Where the picture is served, or `None` for the board.
        url: Option<String>,
    },

    /// Put music on for the room, or stop it. DM-only.
    ///
    /// The same as `SetBackdrop` except that it isn't persisted: memory only,
    /// not on `Saved`, and so never on the undo ring. Re-assigning an `<audio>`
    /// source restarts the track, so an undo that set the music back to a
    /// previous pick would restart it mid-scene.
    ///
    /// One field for the reason `SetBackdrop` has one: `None` is "stop", and
    /// putting it back on is two clicks in the picker.
    SetAudio {
        /// Where the track is served, or `None` for silence.
        url: Option<String>,
    },

    /// The map image and its grid, in one command. DM-only.
    ///
    /// Uploading a new map and calibrating the grid on the current one are the
    /// same message: a calibration repeats the URL it already had. Two
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
        /// with the rest of the calibration, so it travels on the one command
        /// that writes a calibration rather than racing a second one.
        grid_shape: GridShape,
        /// Which slot this is about: the board the table is looking at, or the
        /// one the DM is preparing.
        ///
        /// It names the slot and nothing else. A URL alone still decides
        /// between loading a map and recalibrating one; this only says which
        /// slot's URL that comparison runs against, so an empty staged slot is
        /// always a load.
        staged: bool,
    },
    /// The staged map becomes the board, and every plan made on it is applied.
    /// DM-only, and refused when nothing is staged rather than silently doing
    /// nothing.
    ///
    /// A token with no plan keeps its grid coordinates and the DM repositions
    /// it: cells mean nothing across two unrelated images, and pretending
    /// otherwise would move tokens for reasons nobody asked for. A plan is how
    /// the DM says where one should land instead.
    PromoteStaged,
    /// Throw the staged map away, and the plans made on it with it. DM-only.
    ClearStaged,

    // Drawing. Anyone may draw; it's the only part of the room a player can
    // add to.
    /// A shape being swept out right now, relayed to everyone watching and
    /// stored by nobody. `drawing: false` is the release that ends it.
    ///
    /// Works like `MoveToken`'s `dragging`: in-flight frames are throttled
    /// client-side, aren't echoed to the sender, and aren't worth a disk write.
    /// What a release *means* is the client's business: the measuring tool
    /// stops here and the area tools follow with an `AddShape`. The server
    /// treats all four kinds the same and never learns which tool was in hand,
    /// as it never learns the DM is previewing.
    ///
    /// It carries no anchor. A sketch lives for a second or two, during which
    /// nothing it could anchor to is going anywhere, so absolute cells are
    /// enough. Only a kept shape needs an anchor.
    Sketch {
        kind: ShapeKind,
        at: Pos,
        to: Pos,
        color: String,
        drawing: bool,
    },
    /// Keep the shape just swept out. Carries no id: the server assigns it, as
    /// for a token.
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
    /// Compared with `Sketch`, what's missing explains it. There is no
    /// `drawing` flag, because a ping is one frame rather than a stream: the
    /// gesture is a hold, and the hold is over by the time this is sent. There
    /// is no `kind` and no `color`: what it looks like is decided by who sent
    /// it, which every client works out from the roster it already holds. And
    /// there is no anchor, for the reason a sketch has none: a ping lasts
    /// a second or two.
    ///
    /// **It isn't gated on the fog**, which makes it the one thing the table is
    /// shown over ground they have never explored. That's safe because there is
    /// nothing in it to read but a position (a ring over black says somebody is
    /// pointing there, not what is standing there), and the alternative is a
    /// 400ms gesture that silently does nothing. See *Ping* in
    /// `docs/drawings.md`.
    Ping {
        at: Pos,
    },

    /// Where this client's pointer is now, in grid units.
    ///
    /// Shaped like `Ping`, but a ping is a 400ms gesture somebody chose to
    /// make, and this is where a hand happens to be, sent whenever it moves and
    /// stale a moment later. That difference decides everything else about it.
    ///
    /// It carries no sender for `Say`'s reason, no colour for `Ping`'s, and no
    /// `drawing` flag because there is no stream to close: a cursor ends when
    /// it stops moving, and the client that stopped sends nothing at all.
    /// Nothing in the room remembers one arrived.
    ///
    /// **The busiest command in this protocol by an order of magnitude.** Drag
    /// frames exist while a token is moving; these exist whenever anybody's hand
    /// is on the mouse. Throttled to ~30Hz on the client and sent only on
    /// movement, which is still negligible at seven clients, but it's why the
    /// room's switch stops the *relay* and not only the drawing.
    MoveCursor {
        at: Pos,
    },

    /// Say something: to the table, or to one person.
    ///
    /// One command for both, because a whisper and a shout differ only in
    /// where they are going. Two commands would differ by one field and need
    /// two permission checks kept in step, and the destination is what the
    /// check is about: a player may name the table or the DM, and the DM may
    /// name the table or a player. **Nobody may name another player**; that is
    /// the boundary of the feature.
    ///
    /// It carries no sender. The socket already establishes who said it, and
    /// a `by` on the wire is a field a client could lie in.
    Say {
        to: ChatTo,
        text: String,
    },

    /// Throw `count` dice of `sides` faces, and say the result to `to`.
    ///
    /// The loaner die, for whoever came without one. It produces an ordinary
    /// `ChatLine` and the existing `Event::Said`, so there is no `ServerMsg`
    /// for this, no new event, and no new visibility rule: `party_to` already
    /// decides who is party to a line, and a private roll to the DM costs
    /// nothing because `to` is here anyway.
    ///
    /// It carries no sender, as `Say` doesn't, and the room does the throwing:
    /// a number a client rolled for itself is one it could throw again until
    /// it liked the answer.
    ///
    /// `sides` is checked against a closed set and `count` against a cap, the
    /// way `Token::size` is checked against `TOKEN_SIZES`. **No modifier and no
    /// expression, ever**: counts are what a dice bag has, and arithmetic is
    /// where a character sheet starts. See `docs/dice.md`.
    Roll {
        sides: u8,
        count: u8,
        to: ChatTo,
    },

    /// Replace this client's own scratchpad with `text`.
    ///
    /// **It carries no key, and that's what keeps the scratchpad private.** A
    /// key a client could name is a key it could use to name somebody *else's*,
    /// so whose box this is comes from the socket, as `Say`'s sender does, and
    /// there is no argument here for the server to validate.
    ///
    /// The whole box every time rather than an edit or a diff. It is one string
    /// of a few thousand characters that changes when somebody stops typing, so
    /// a patch format would add code for no gain.
    SetNotes {
        text: String,
    },

    /// Pick the colour this client's rings and lines are drawn in.
    ///
    /// It carries no key either: whose colour this is comes from the socket,
    /// as `Say`'s sender and `SetNotes`' box do. A key a client could name is a
    /// key it could use to name somebody else's.
    ///
    /// An index into a closed palette rather than free hex, for a reason on
    /// the board. `pings.ts` records that its six hues avoid the token ring
    /// colours in `render.ts`: gold is ownership, blue is in progress, white is
    /// the turn, violet is hidden, teal is staged-only. A player who could send
    /// `#d4af37` could make their own ring falsely claim they own a creature.
    /// So the set is closed and the bound is `PALETTE`, checked here the way a
    /// token's size is.
    ///
    /// **The DM may not send it.** Their hue sits outside the six because it
    /// marks the one ring at the table that isn't a player's, and a DM who took
    /// a player's colour would lose that. Refused on the server, not just left
    /// out of their client, because a rule only the UI keeps isn't enforced.
    SetColour {
        colour: u8,
    },

    // Walls and doors. All DM-only, and unlike the drawings above, invisible to
    // everyone else: a player isn't told these commands happened at all.
    //
    // **Every one of them names a slot**, like `SetMap`, `MoveToken` and
    // `CreateToken`, for the same reason: preview is client-only and the server
    // must not learn the DM is in it, so the intent travels on the command
    // rather than as a mode. On the two that carry an id the flag is redundant
    // (ids are UUIDs and could be looked up in both lists), but a lookup that
    // searches both can erase a live wall while the DM is looking at the staged
    // board.
    /// One traced run, in image pixels: `points` are its corners in order, and
    /// the segments between them become that many walls.
    ///
    /// The run is how the DM authors, not how the room stores. The whole
    /// polyline goes in one command rather than a segment per click, because a
    /// two-hundred-segment dungeon would otherwise be two hundred round trips.
    /// The server assigns the ids, as for a token or a shape.
    ///
    /// `door` applies to every segment of the run. A door is normally a single
    /// segment across an opening; nothing here enforces that, because "how wide
    /// is a door" is the DM's business.
    AddWalls {
        points: Vec<Px>,
        door: bool,
        staged: bool,
    },
    /// One segment. There is no "erase this run": the run stops existing once
    /// it is stored, which is what lets the DM fix one bad segment of a long
    /// trace without redrawing it.
    RemoveWall {
        id: WallId,
        staged: bool,
    },
    /// Open or shut a door. Refused on masonry, the way a command naming a token
    /// that doesn't exist is refused.
    ///
    /// On the live board this is a play-time action: the party opens a door
    /// mid-fight. On the staged board it is authoring: a door left open is the
    /// door the party finds open when the map is promoted, which is how the DM
    /// says "this one is already ajar" in advance.
    ToggleDoor {
        id: WallId,
        staged: bool,
    },
    /// Every wall on one board. DM-only like the rest, and unlike `ClearShapes`
    /// it reaches into nobody else's work: it is all the DM's.
    ClearWalls {
        staged: bool,
    },

    // The manual fog override. DM-only, like the walls it is stored beside.
    /// Says one thing about a set of cells: force them explored, force them lit,
    /// force them dark, or hand them back to the rays.
    ///
    /// **The cells are the payload, not a seed to flood-fill from.** The DM's
    /// client already holds the walls and has to compute the fill to preview
    /// it; sending the previewed cells makes the preview and the result the
    /// same data, rather than two implementations that have to agree. The DM
    /// may reveal whatever they like, so the server stores what it is told,
    /// having clipped it to the board and counted it.
    ///
    /// A brush and a fill send the same frame; the only difference is which cells
    /// end up in it.
    ///
    /// `staged` names the board, like the wall commands above. Painting the
    /// staged one isn't previewing what the party will see there (there is no
    /// staged fog to preview); it decides in advance what they are handed when
    /// the map is promoted.
    SetFogOverride {
        cells: Vec<Cell>,
        /// `None` hands the cells back to line of sight. Null rather than a
        /// fourth variant, because "no override" is the absence of one, which
        /// the room stores by removing the entry.
        state: Option<Override>,
        staged: bool,
    },
    /// The fog back to the start of the evening: every override cleared *and*
    /// everywhere the party has explored forgotten, then line of sight recomputed
    /// from where the tokens are standing right now.
    ///
    /// Both halves in one command because they are one gesture ("this map
    /// hasn't been seen yet"), and splitting them would offer a reset that
    /// leaves the map lit, which nobody asks for. It is kept apart from
    /// `ClearWalls` because the walls are all the DM's work, and half of this
    /// is the party's.
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
    /// DM-only, and the one command here that names no subsystem: it is about
    /// the room's recent history rather than about any part of it.
    ///
    /// Carries nothing at all, not even how far back to go. The ring lives in
    /// the room and only its top is undoable, so a depth on the wire would be a
    /// number the server had to check against a stack the client can't see.
    /// A client that undoes twice sends this twice, which also means the DM
    /// sees each step's label before pressing.
    Undo,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Sent to a connection that hasn't established an identity. Carries no
    /// room state: invariant 4 means an unidentified client is told nothing
    /// about the world, not just prevented from changing it.
    ///
    /// Re-sent to everyone still choosing whenever a slot is taken or freed, so
    /// a picker left open doesn't go stale.
    ChooseIdentity {
        roster: Vec<RosterSlot>,
    },
    Welcome {
        your_id: ClientId,
        is_dm: bool,
        /// `None` for the DM, who occupies no roster slot.
        player_id: Option<PlayerId>,
        /// Boxed. Serde serialises through the box, so the frame on the wire is
        /// the same.
        ///
        /// Every `ServerMsg` in every client's mailbox is sized at the largest
        /// variant, and there are 256 slots per client. This one is sent once
        /// per connection, so keeping the whole world out of the size of a
        /// token move costs one allocation on join.
        state: Box<RoomView>,
        /// Who the DM can hand a token to.
        ///
        /// Not on `RoomView`, and not `RosterSlot`: this is the cast list, not
        /// who is connected, so there is nothing here to go stale between
        /// deltas. A player is sent it too (the picker offered them the same
        /// names), so it isn't a filtered field.
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
    /// A token that was created or edited. One message for both, because the
    /// client does the same thing with each: take this token as the truth for
    /// this id. A `TokenChanged` for an id the client has never seen is the
    /// creation, and there is no separate `TokenAdded` to keep in step with it.
    ///
    /// A `TokenView`, not a `Token`: this is also the frame a player's copy of a
    /// token is redacted out of.
    TokenChanged {
        token: TokenView,
    },
    /// Deleted, or hidden, which is the same news to a client that isn't
    /// allowed to know the difference. That's why the room's `Event` carries
    /// an id and this carries a token: one `TokenChanged` event becomes this
    /// message for the table and a `TokenChanged` for the DM.
    TokenRemoved {
        id: TokenId,
    },
    /// The whole `MapInfo`, for the same reason `InitiativeChanged` carries the
    /// whole panel: it is a handful of fields and only a DM action changes it.
    MapChanged {
        map: MapInfo,
    },
    /// The board now writes token names under them, or it doesn't.
    ///
    /// Identical for every recipient, like `FogChanged` and unlike
    /// `WallsChanged`. The DM decides it and everyone is told, because the
    /// switch exists so no board is labelled differently from another. Echoed
    /// to the DM who sent it, like `MapChanged`: nothing here is predicted
    /// locally, so this frame is how their own checkbox settles.
    NamesChanged {
        show: bool,
    },
    /// The ruler counts diagonals differently now.
    ///
    /// Like `NamesChanged` and `FogChanged`: identical for every recipient,
    /// echoed to the DM who sent it. A client left holding the old convention
    /// would read a different number off the same move than the person beside
    /// it, which is the failure this message exists to prevent.
    DiagonalsChanged {
        diagonals: Diagonals,
    },

    /// There is a picture in front of the table now, or there isn't.
    ///
    /// Like `NamesChanged`: identical for every recipient, no filter, echoed to
    /// the DM who sent it. **Nothing travels with it.** The board isn't being
    /// changed, only covered, so no map, wall, shape or fog frame accompanies
    /// this one.
    BackdropChanged {
        url: Option<String>,
    },

    /// The room is playing a track now, or it isn't.
    ///
    /// Like `BackdropChanged`: identical for every recipient, no filter, echoed
    /// to the DM who chose it, and nothing travels with it. The volume and
    /// whether it plays at all are up to each browser and never sent here.
    AudioChanged {
        url: Option<String>,
    },

    /// Pointers are drawn on every board now, or they aren't.
    ///
    /// Like the two frames above: identical for every recipient, no filter,
    /// echoed to the DM who flipped it. The difference is that this one changes
    /// what a client *sends*: the room stops relaying cursors, and a client
    /// that kept sending them would pay the whole cost of a feature nobody at
    /// the table can see.
    CursorsChanged {
        show: bool,
    },
    /// The DM's pointer is drawn on the players' boards now, or it isn't.
    ///
    /// Like `CursorsChanged`, but it changes only what the room relays, not
    /// what a client sends, so a player receiving it has nothing to do. It is
    /// sent to everyone anyway, because the DM's table tab reads it back and
    /// the value is nobody's secret.
    DmCursorChanged {
        show: bool,
    },
    /// Somebody joined or left. The whole list, because it is at most seven
    /// names and nothing is predicted locally.
    ///
    /// Like `NamesChanged`: identical for every recipient, no filter, no
    /// permission. Unlike it, no command causes this. It is dispatched from the
    /// two places the socket table changes, which is why it is the one message
    /// in this enum never sent alongside a disk write: who is connected isn't
    /// part of the room.
    ///
    /// Sent whenever a connection is claimed or lost rather than only when the
    /// list differs. A second connection as the same person changes nothing,
    /// and a frame repeating what the client already holds just repaints the
    /// same chips.
    Presence {
        here: Vec<Owner>,
    },
    /// A player picked their colour. The whole table, for `Presence`'s reason.
    ///
    /// Like `Presence` (identical for every recipient, no filter), except that
    /// a *player* caused this one. It's the only frame that carries something a
    /// player wrote to everybody else. That's how a colour differs from a
    /// scratchpad: both are yours to set, and a colour is no use if nobody else
    /// can see it.
    ///
    /// **The sender is echoed**, like `NamesChanged` and unlike `NotesChanged`.
    /// There is no caret to move and nothing was drawn locally, so this frame is
    /// how the chosen swatch settles on the client that chose it.
    ColoursChanged {
        colours: Colours,
    },
    /// The staged board (its map, its walls and its paint), or `None` once
    /// there isn't one. Reaches the DM and nobody else: it exists for one
    /// identity rather than for one action.
    ///
    /// One message covers staging, recalibrating, discarding, and the slot
    /// emptying on a promote, for the same reason `TokenChanged` covers both
    /// creation and editing: two messages would have to be kept in step, and
    /// the client does the same thing with all four (this is the staged slot
    /// now).
    ///
    /// **It carries the whole board, not just the map.** A staged load sweeps
    /// its walls and a staged recalibration drops its paint; both are already
    /// described here, so neither needs a `WallsChanged` or an
    /// `OverridesChanged` of its own, and there is none to forget.
    StagedChanged {
        board: Option<StagedView>,
    },
    /// The whole panel, not a per-entry delta. It is a handful of rows and only
    /// changes on a DM action, so a diff would cost more than it saves.
    ///
    /// Built per recipient: a hidden creature's row isn't in the copy the table
    /// receives, so the DM's panel and the players' differ.
    InitiativeChanged {
        initiative: Initiative,
    },
    /// Somebody else's in-progress sweep. `by` is their connection, which is
    /// what a client keys the drawing on: one sweep per socket, so a DM with
    /// two tabs open can be measuring two things at once and both are drawn.
    ///
    /// Never sent back to the client doing the sweeping: they are already
    /// drawing it from their own pointer, and echoing it would cause the
    /// rubber-banding `TokenMoved` avoids for the same reason.
    Sketch {
        by: ClientId,
        kind: ShapeKind,
        at: Pos,
        to: Pos,
        color: String,
    },
    /// That sweep is over: released, or the client holding it went away.
    ///
    /// The second case is why this exists rather than a client-side timeout:
    /// the room is told when a socket closes, so it can say so. A movement
    /// ruler has to guess, because nothing announces that a drag stopped.
    SketchEnded {
        by: ClientId,
    },
    /// Every shape this client may see. The whole list rather than a per-shape
    /// delta, for the reason `InitiativeChanged` carries the whole panel: it is
    /// a handful of entries that only change when someone draws or erases.
    ///
    /// **Built per recipient**: hiding a monster takes the aura anchored to it
    /// off the table's board and leaves it on the DM's, from this one message.
    ShapesChanged {
        shapes: Vec<Shape>,
    },
    /// Every wall the DM has traced. The whole list rather than a delta, for the
    /// reason `ShapesChanged` carries the whole list, except that this one only
    /// ever has one recipient.
    ///
    /// **It reaches the DM or nobody.** Not an empty list for the players: a
    /// frame they can't use still tells them the DM just did something, and
    /// invariant 4 is about what a client may know. `Event::TokenPlanChanged`
    /// follows the same rule.
    ///
    /// `staged` says which board's list this is, because there are two and the
    /// frame is a replacement rather than a delta. It is the flag the command
    /// carried, sent back. The DM's client doesn't infer which list changed
    /// from which one it is looking at, because a promote can swap the board
    /// while a frame is in flight.
    WallsChanged {
        walls: Vec<Wall>,
        staged: bool,
    },
    /// What the party can see now, and everywhere they have been. `None` once the
    /// map isn't fogged, which is also what a map that never was looks like.
    ///
    /// Identical for every recipient: fog is party-shared, so there is nothing
    /// per-client in it to build. The DM gets it to draw faintly over their own
    /// board.
    ///
    /// Sent on a drop and never on a drag frame. The shadow of a party walking a
    /// corridor is worth a few kilobytes when they arrive somewhere and isn't
    /// worth thirty a second on the way.
    FogChanged {
        fog: Option<FogView>,
    },
    /// Every cell the DM has overridden by hand, packed. The whole rectangle
    /// rather than a delta, for the reason `WallsChanged` carries the whole list.
    ///
    /// **It reaches the DM or nobody**, like `WallsChanged`. What the table is
    /// owed arrives in `FogChanged`, which carries the result of the override
    /// and not the override itself.
    ///
    /// `staged` names the board for the reason `WallsChanged` carries one.
    OverridesChanged {
        overrides: OverrideView,
        staged: bool,
    },

    /// Somebody pinged. Draw a ring there for a second or two.
    ///
    /// `by` is an `Owner` and not a `ClientId`, unlike `Sketch`. A sketch is
    /// keyed by connection because the recipient has to *replace* the previous
    /// frame from that socket and end it on release; a ping replaces nothing and
    /// ends by itself, so the recipient needs to know whose ring to draw, not
    /// which socket sent it. `Owner` is what the roster resolves to a name and
    /// a colour, and it is what a chat line is attributed with.
    ///
    /// Not sent back to the pinger, for `Sketch`'s reason: their ring has been
    /// on their own screen since the hold was 150ms old, and a copy arriving a
    /// round trip later would restart it.
    ///
    /// **Sent to everyone else regardless of the fog.** The only message in this
    /// file with a position in it that no visibility filter touches.
    Pinged {
        by: Owner,
        at: Pos,
    },

    /// Somebody's pointer is here now. Draw it until it stops arriving.
    ///
    /// Carries what `Pinged` does (an `Owner` rather than a `ClientId`, for the
    /// same reason) and isn't echoed to the sender, but unlike `Pinged`,
    /// **this one is filtered.**
    ///
    /// The DM's pointer is withheld from a player when it is over ground the
    /// party hasn't explored. A ping is a chosen gesture, and a ring over black
    /// says only that somebody is pointing there; a cursor is nobody's
    /// decision, and the DM's pointer *lingers where the DM is working*: over
    /// the ambush in the unlit chamber, over the creature the table can't see.
    /// That is the one thing in this frame worth reading, so it is the one
    /// case the filter exists for. A player's cursor is relayed wherever it
    /// goes, and the DM is sent every one of them: they can see the whole board
    /// already.
    CursorMoved {
        by: Owner,
        at: Pos,
    },

    /// Somebody said something you are party to.
    ///
    /// **Sent to the sender as well**, unlike `Pinged` and `Sketch`. Those two
    /// are drawn on the sender's own screen before the frame leaves, so an echo
    /// restarts an animation. A line of text isn't predicted locally at all,
    /// because the log is a *sequence* and the room decides where in it this
    /// lands. A client that appended its own would have two orderings to
    /// reconcile the first time two people typed at once.
    ///
    /// Withheld whole from anyone not party to it (there is no redacted form of
    /// a whisper), so this travels like `WallsChanged` rather than like
    /// `FogChanged`. Unlike `WallsChanged`, the rule isn't about the DM: this
    /// frame can be withheld from one *player* and sent to another.
    Said {
        line: ChatLine,
    },

    /// Your scratchpad now reads this.
    ///
    /// **The DM isn't sent anyone else's.** Every other rule here separates the
    /// DM from the table, and this one has no `is_dm` in it at all. It reaches
    /// the author and nobody else: a scratchpad somebody else's client can open
    /// isn't private.
    ///
    /// Not sent back to the socket that typed it, which is `Sketch`'s and
    /// `Pinged`'s rule rather than `Said`'s: what would arrive is the text
    /// already in the box, a round trip later, and writing it back mid-sentence
    /// moves the caret. It is for the author's other tabs, whose box would
    /// otherwise show text that has since changed.
    NotesChanged {
        text: String,
    },

    /// The room was put back to an earlier state: take this as the truth for
    /// all of it.
    ///
    /// The whole world rather than a diff. An undo restores a snapshot, and the
    /// one thing the room can't describe as a delta is `sweep_board`: a map
    /// load clears the walls, the shapes and the fog together, so its inverse
    /// would be most of a second state model. Re-sending everything costs one
    /// frame on a DM action and needs no extra code.
    ///
    /// A `RoomView` like `Welcome`'s and built by the same `snapshot_for`, so a
    /// restore is filtered as a join is (invariant 3). Boxed for `Welcome`'s
    /// reason: every message in every client's mailbox is sized at the largest
    /// variant.
    ///
    /// **A separate message, not a second `Welcome`**, because `onWelcome` on
    /// the client *builds* the panels, the tools and the board, once, and
    /// assumes one per connection. This one only hands over state. No
    /// `your_id`, no `is_dm`, no roster: identity is settled by the socket and
    /// can't change under it, and an undo can't edit the cast list.
    Restored {
        state: Box<RoomView>,
    },
    /// What the DM's undo would take back now, or `None` for nothing.
    ///
    /// It reaches the DM or nobody, like `WallsChanged`, but for relevance
    /// rather than secrecy: a player has no undo button for this to label.
    /// `RoomView::undo` is the same value on join, and this is how it changes
    /// afterwards.
    ///
    /// Sent alongside every command that adds a step and every undo that takes
    /// one away, as `OverridesChanged` is paired with `FogChanged`: the state
    /// changed, and so did what the next undo would take back.
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

    /// The tag of every variant. The compiler keeps the list complete.
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
            ClientMsg::SetAudio { .. } => "set_audio",
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
            ServerMsg::AudioChanged { .. } => "audio_changed",
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

    /// The two unions are written out by hand twice (here and in
    /// `client/src/protocol.ts`), and nothing generates either from the other.
    /// `protocol-tags.json` is the third copy and the one both are checked
    /// against; `protocol.test.ts` is the client's half of this test.
    ///
    /// Variant-level only. A renamed field keeps its tag and passes here; see
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
        // The other direction (a variant missing from the fixture) is caught
        // by the count, since the match can't omit one and still compile.
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

    /// Kept beside the matches above so they stay in step: a variant added to
    /// either enum breaks `client_tag`/`server_tag`, and whoever fixes that
    /// has these two lists in front of them.
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
        "set_audio",
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
        "audio_changed",
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

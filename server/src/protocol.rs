//! Everything that crosses the wire, plus the state types the room owns.
//!
//! `ServerMsg` is the outbound wire format. The room's internal `Event` type
//! lives in `room.rs` and is deliberately not this type — see `message_for`.

use serde::{Deserialize, Serialize};

/// Server-assigned, unique per connection. Not an identity — it dies with the
/// socket. `PlayerId` is the thing that survives a refresh.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ClientId(pub u64);

/// A roster slot. This *is* the player's identity: claiming "Vex" means your
/// `player_id` is literally `vex`, so a refresh reclaims the same slot and no
/// token is ever orphaned. There is no separate claim table.
#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PlayerId(pub String);

#[derive(Debug, Clone, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct TokenId(pub String);

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

/// Adjacently tagged: `{"kind":"dm"}` / `{"kind":"player","id":"vex"}`.
/// Internal tagging cannot express a newtype variant wrapping a string, and
/// serde's default external tagging would produce two different JSON shapes.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "id", rename_all = "snake_case")]
pub enum Owner {
    /// The default on purpose: a token restored from a schema that predates
    /// ownership becomes DM-only, which fails closed. Defaulting to any player
    /// would hand a stranger's token to whoever happened to claim that slot.
    #[default]
    Dm,
    Player(PlayerId),
}

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
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Token {
    pub id: TokenId,
    pub name: String,
    /// Grid units, measured to the token's centre. Never pixels — invariant 1.
    pub x: f32,
    pub y: f32,
    pub owner: Owner,
    pub img: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RosterEntry {
    pub id: PlayerId,
    pub name: String,
}

/// A roster slot as offered to someone choosing an identity. `claimed` is
/// advisory — it stops two people picking Vex by accident, it does not stop
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

/// A room as one particular client is allowed to see it. Produced only by
/// `RoomState::snapshot_for` — there is no unfiltered `snapshot()`.
#[derive(Debug, Clone, Serialize)]
pub struct RoomView {
    pub map: MapInfo,
    pub tokens: Vec<Token>,
    pub initiative: Initiative,
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
    },

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
        state: RoomView,
    },
    TokenMoved {
        id: TokenId,
        x: f32,
        y: f32,
        dragging: bool,
    },
    /// The whole `MapInfo`, for the same reason `InitiativeChanged` carries the
    /// whole panel: it is four fields and only a deliberate DM action moves it.
    MapChanged {
        map: MapInfo,
    },
    /// The whole panel, not a per-entry delta. It is a handful of rows and only
    /// changes on a deliberate DM action, so a diff would cost more than it saves.
    InitiativeChanged {
        initiative: Initiative,
    },
    Error {
        message: String,
    },
}

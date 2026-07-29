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
    /// The map the DM is preparing, if there is one — and only if this view
    /// belongs to the DM. A player's copy is always `None`, which is also what
    /// "nothing is staged" looks like, so the two are indistinguishable from the
    /// client side. That is the point: invariant 4 wants the next dungeon
    /// genuinely absent from a player's snapshot, not merely undrawn.
    pub staged: Option<MapInfo>,
    /// Already filtered *and* redacted: a token the table cannot see — hidden,
    /// or built on the next map and not here yet — is absent rather than
    /// flagged, and what survives carries only the fields this client may hold.
    pub tokens: Vec<TokenView>,
    /// Rows naming a token this client cannot see are gone from here, and
    /// `current` with them. A row the players can read but not explain is the
    /// bare id of the thing `hidden` was supposed to conceal.
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
    },
    DeleteToken {
        id: TokenId,
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
    /// The staged map, or `None` once there is not one. Reaches the DM and
    /// nobody else — this is the first message that exists for one identity
    /// rather than for one action.
    ///
    /// One message covers staging, recalibrating, discarding, and the slot
    /// emptying on a promote, for the same reason `TokenChanged` covers both
    /// creation and editing: two messages would have to be kept in step, and
    /// the client's answer to all four is the same — this is the staged slot now.
    StagedChanged {
        map: Option<MapInfo>,
    },
    /// The whole panel, not a per-entry delta. It is a handful of rows and only
    /// changes on a deliberate DM action, so a diff would cost more than it saves.
    ///
    /// Built per recipient: a hidden creature's row is not in the copy the table
    /// receives, so the DM's panel and the players' genuinely differ.
    InitiativeChanged {
        initiative: Initiative,
    },
    Error {
        message: String,
    },
}
